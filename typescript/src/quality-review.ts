import { sha256 } from "./canonical-json.js";
import {
  decodeFile,
  decodeYaml,
  evidenceShape,
  isRecord,
  lengthBetween,
  objectArray,
  validateEvidence,
  type Attribution,
  type CandidateFile,
  type EvidenceInput,
  type Shape,
  type VerificationReportInput,
} from "./domain.js";
import { validation } from "./errors.js";
import { isGitOID, isSha256, isUUIDv7 } from "./identity.js";
import type { BlindVerificationContext, CandidateContextSource } from "./projections.js";
import { checkSignedHandoff, readJSONFile, record, signHandoff, type CheckedSignedHandoff } from "./verification-handoff.js";

/**
 * Code-quality review for ultra Verification.
 *
 * A quality report is the second signed part of an ultra Verification. It is
 * produced by a verifier that is distinct from both the Candidate developer and
 * the contract verifier, first blind and then reconciled against the author's
 * explanation, exactly like the contract part.
 */
export const VERIFICATION_MODES = ["normal", "ultra"] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];
export const QUALITY_REPORT_FORMAT = "patchledger.quality-review-report/v1" as const;
export const QUALITY_HANDOFF_FORMAT = "patchledger.quality-review-handoff/v1" as const;
export const QUALITY_CONTEXT_FORMAT = "patchledger.quality-context/v1" as const;
export const QUALITY_RUBRIC_VERSION = "grounds.quality-rubric/v1" as const;

export interface QualityDimensionDefinition { id: string; name: string; definition: string }

/** The fixed, versioned dimension set. Changing it requires a new rubric version. */
export const QUALITY_DIMENSIONS: readonly QualityDimensionDefinition[] = [
  { id: "conciseness", name: "Conciseness", definition: "The change has no unnecessary complexity, duplication, dead code, or modifications unrelated to the task." },
  { id: "testability", name: "Testability", definition: "New or changed logic can be tested in isolation; dependencies and side effects have clear seams." },
  { id: "abstraction", name: "Abstraction level", definition: "Abstractions match the problem: no over-engineering and no missing necessary abstraction; module boundaries and responsibilities are clear." },
  { id: "readability", name: "Readability and naming", definition: "Names, structure, and necessary comments make the intent readable." },
  { id: "conventions", name: "Repository conventions", definition: "The change follows the repository's existing structure, style, and documented rules (for example AGENTS.md and coding standards)." },
  { id: "test_quality", name: "Test quality", definition: "The change carries focused, deterministic tests that can detect regressions and do not over-depend on implementation details." },
];

export const qualityRubric = (): { version: typeof QUALITY_RUBRIC_VERSION; dimensions: QualityDimensionDefinition[] } => ({
  version: QUALITY_RUBRIC_VERSION,
  dimensions: QUALITY_DIMENSIONS.map((dimension) => ({ ...dimension })),
});

export type Verdict = "qualified" | "rejected" | "inconclusive";
export interface QualityFinding { severity: "blocking" | "non_blocking"; explanation: string; location?: { path: string; line?: number } }
export interface QualityIndependentInput { verdict: Verdict; explanation: string; findings: QualityFinding[]; evidence: EvidenceInput[] }
export interface QualityReconciliationInput { explanation: string }
export interface QualityFinalInput { verdict: Verdict; explanation: string; findings: QualityFinding[] }
export interface QualityDimensionInput { dimension_id: string; independent: QualityIndependentInput; reconciliation: QualityReconciliationInput; final: QualityFinalInput }
export interface QualityReviewReportInput {
  format: string;
  candidate_id: string;
  result_tree_oid: string;
  blind_context_digest: string;
  rubric_version: string;
  dimensions: QualityDimensionInput[];
}

const MAX_FINDINGS = 20;
const findingShape: Shape = { severity: "scalar", explanation: "scalar", location: { path: "scalar", line: "scalar" } };
const qualityShape: Shape = {
  format: "scalar", candidate_id: "scalar", result_tree_oid: "scalar", blind_context_digest: "scalar", rubric_version: "scalar",
  dimensions: objectArray({
    dimension_id: "scalar",
    independent: { verdict: "scalar", explanation: "scalar", findings: objectArray(findingShape), evidence: objectArray(evidenceShape) },
    reconciliation: { explanation: "scalar" },
    final: { verdict: "scalar", explanation: "scalar", findings: objectArray(findingShape) },
  }),
};

const verdicts = new Set<string>(["qualified", "rejected", "inconclusive"]);

const validateFindings = (field: string, findings: QualityFinding[]): boolean => {
  if (!Array.isArray(findings)) throw validation(field, "is required; use an empty array when there are no findings");
  if (findings.length > MAX_FINDINGS) throw validation(field, `must contain at most ${MAX_FINDINGS} entries`);
  let blocking = false;
  findings.forEach((finding, index) => {
    const prefix = `${field}[${index}]`;
    if (!isRecord(finding)) throw validation(prefix, "must be an object");
    if (Object.keys(finding).some((key) => key !== "severity" && key !== "explanation" && key !== "location")) throw validation(prefix, "contains an unknown field");
    if (finding.severity !== "blocking" && finding.severity !== "non_blocking") throw validation(`${prefix}.severity`, "must be blocking or non_blocking");
    lengthBetween(`${prefix}.explanation`, finding.explanation, 1, 8192);
    if (finding.location !== undefined) {
      const location = finding.location;
      if (!isRecord(location) || Object.keys(location).some((key) => key !== "path" && key !== "line")) throw validation(`${prefix}.location`, "must contain only path and optional line");
      lengthBetween(`${prefix}.location.path`, location.path, 1, 4096);
      if (location.line !== undefined && (!Number.isInteger(location.line) || location.line < 1 || location.line > 2_147_483_647)) throw validation(`${prefix}.location.line`, "must be a positive 32-bit integer");
    }
    if (finding.severity === "blocking") {
      if (finding.location === undefined) throw validation(`${prefix}.location`, "is required for a blocking finding so it points at Candidate code");
      blocking = true;
    }
  });
  return blocking;
};

/** A stage with a blocking finding must be rejected, and only such a stage may be rejected. */
const checkVerdictAgainstFindings = (field: string, verdict: Verdict, hasBlocking: boolean): void => {
  if (hasBlocking && verdict !== "rejected") throw validation(`${field}.verdict`, "must be rejected when the stage has a blocking finding");
  if (!hasBlocking && verdict === "rejected") throw validation(`${field}.verdict`, "cannot be rejected without a blocking finding; record the blocking finding with its code location");
};

export const validateQualityReviewReport = (value: QualityReviewReportInput): void => {
  if (!isRecord(value)) throw validation("file", "must be an object");
  if (value.format !== QUALITY_REPORT_FORMAT) throw validation("format", `must equal ${QUALITY_REPORT_FORMAT}`);
  if (!isUUIDv7(value.candidate_id)) throw validation("candidate_id", "must be a lowercase UUIDv7");
  if (!isGitOID(value.result_tree_oid)) throw validation("result_tree_oid", "must be an algorithm-prefixed SHA-1 or SHA-256 Git object ID");
  if (!isSha256(value.blind_context_digest)) throw validation("blind_context_digest", "must be a lowercase sha256 digest");
  if (value.rubric_version !== QUALITY_RUBRIC_VERSION) throw validation("rubric_version", `must equal ${QUALITY_RUBRIC_VERSION}`);
  if (!Array.isArray(value.dimensions)) throw validation("dimensions", "must be an array");
  const expected = new Set(QUALITY_DIMENSIONS.map((dimension) => dimension.id));
  const seen = new Set<string>();
  let evidenceBytes = 0;
  value.dimensions.forEach((dimension, index) => {
    const prefix = `dimensions[${index}]`;
    if (!isRecord(dimension)) throw validation(prefix, "must be an object");
    if (typeof dimension.dimension_id !== "string" || !expected.has(dimension.dimension_id)) throw validation(`${prefix}.dimension_id`, `must be one of ${[...expected].join(", ")}`);
    if (seen.has(dimension.dimension_id)) throw validation(`${prefix}.dimension_id`, `dimension ${dimension.dimension_id} must not be duplicated`);
    seen.add(dimension.dimension_id);
    if (!isRecord(dimension.independent)) throw validation(`${prefix}.independent`, "must be an object");
    if (!isRecord(dimension.reconciliation)) throw validation(`${prefix}.reconciliation`, "must be an object");
    if (!isRecord(dimension.final)) throw validation(`${prefix}.final`, "must be an object");
    if (!verdicts.has(dimension.independent.verdict)) throw validation(`${prefix}.independent.verdict`, "must be qualified, rejected, or inconclusive");
    lengthBetween(`${prefix}.independent.explanation`, dimension.independent.explanation, 1, 65536);
    checkVerdictAgainstFindings(`${prefix}.independent`, dimension.independent.verdict, validateFindings(`${prefix}.independent.findings`, dimension.independent.findings));
    evidenceBytes += validateEvidence(`${prefix}.independent.evidence`, dimension.independent.evidence);
    lengthBetween(`${prefix}.reconciliation.explanation`, dimension.reconciliation.explanation, 1, 65536);
    if (!verdicts.has(dimension.final.verdict)) throw validation(`${prefix}.final.verdict`, "must be qualified, rejected, or inconclusive");
    lengthBetween(`${prefix}.final.explanation`, dimension.final.explanation, 1, 65536);
    checkVerdictAgainstFindings(`${prefix}.final`, dimension.final.verdict, validateFindings(`${prefix}.final.findings`, dimension.final.findings));
  });
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw validation("dimensions", `must cover every dimension of ${QUALITY_RUBRIC_VERSION}; missing ${missing.join(", ")}`);
  if (evidenceBytes > 1024 * 1024) throw validation("dimensions", "all evidence output must not exceed 1 MiB");
};

export const decodeQualityReviewReport = (data: Buffer): QualityReviewReportInput => decodeYaml(data, qualityShape, validateQualityReviewReport);
export const decodeQualityReviewReportFile = (path: string): QualityReviewReportInput => decodeQualityReviewReport(decodeFile(path));

const rank = (verdict: Verdict): number => verdict === "rejected" ? 2 : verdict === "inconclusive" ? 1 : 0;
/** Most conservative verdict wins: rejected > inconclusive > qualified. */
export const conservativeVerdict = (...values: Verdict[]): Verdict => values.reduce((worst, next) => rank(next) > rank(worst) ? next : worst, "qualified" as Verdict);

export const qualityOverallVerdict = (report: Pick<QualityReviewReportInput, "dimensions">): Verdict => conservativeVerdict(...report.dimensions.map((dimension) => dimension.final.verdict));

export const contractOverallVerdict = (report: VerificationReportInput): Verdict =>
  conservativeVerdict(...report.assessments.flatMap((target) => target.criteria.map((criterion) => criterion.final.verdict)));

/** Combined verdict of one Verification: contract part alone for normal mode, the more conservative part for ultra.
 * `quality` is required on purpose: a caller that forgets the quality part would silently compute the normal verdict, so normal mode is spelled `undefined`. */
export const combinedVerdict = (report: VerificationReportInput, quality: Pick<QualityReviewReportInput, "dimensions"> | undefined): Verdict =>
  quality ? conservativeVerdict(contractOverallVerdict(report), qualityOverallVerdict(quality)) : contractOverallVerdict(report);

const orderedDimensions = (report: QualityReviewReportInput): QualityDimensionInput[] =>
  [...report.dimensions].sort((a, b) => QUALITY_DIMENSIONS.findIndex((d) => d.id === a.dimension_id) - QUALITY_DIMENSIONS.findIndex((d) => d.id === b.dimension_id));

/** Dimensions in rubric order; used for storage and for hash-stable comparisons. */
export const canonicalQualityReport = (report: QualityReviewReportInput): QualityReviewReportInput => ({ ...report, dimensions: orderedDimensions(report) });

/** Digest of the independent (blind) parts only. The coordinator fixes it before the reconcile phase; handoff then rejects a report whose blind part changed. */
export const independentDigestOfQuality = (report: QualityReviewReportInput): string =>
  sha256(orderedDimensions(report).map((dimension) => ({ dimension_id: dimension.dimension_id, independent: dimension.independent })));

/** Blocking findings must point at code the Candidate changed; reviewing untouched Baseline code is out of scope. */
export const validateQualityLocations = (report: QualityReviewReportInput, files: CandidateFile[]): void => {
  const paths = new Set(files.flatMap((file) => [file.display_path, ...(file.old_path_bytes === undefined ? [] : [Buffer.from(file.old_path_bytes, "base64").toString("utf8")])]));
  report.dimensions.forEach((dimension, index) => (["independent", "final"] as const).forEach((stage) => dimension[stage].findings.forEach((finding, findingIndex) => {
    if (finding.severity === "blocking" && finding.location && !paths.has(finding.location.path)) {
      throw validation(`quality.dimensions[${index}].${stage}.findings[${findingIndex}].location.path`, "a blocking finding must point at a path changed by the Candidate");
    }
  })));
};

/** Context handed to the quality reviewer. Blind: contract, Artifact and rubric only; reconcile: author explanation and Change Rationales only. */
export interface QualityBlindContext extends Omit<BlindVerificationContext, "format"> {
  format: typeof QUALITY_CONTEXT_FORMAT;
  rubric: ReturnType<typeof qualityRubric>;
}

export const qualityBlindContextFrom = (blind: BlindVerificationContext): QualityBlindContext => {
  const { format: _format, ...rest } = blind;
  return { format: QUALITY_CONTEXT_FORMAT, ...rest, rubric: qualityRubric() };
};

export interface QualityReconcileContext {
  format: typeof QUALITY_CONTEXT_FORMAT;
  phase: "reconcile";
  candidate_id: string;
  result_tree_oid: string;
  blind_context_digest: string;
  submission_explanation: string;
  /** "recorded" for submission v2; "not_recorded" for v1 Candidates that carry no Change Rationales. */
  change_rationales_status: "recorded" | "not_recorded";
  change_rationales: Extract<CandidateContextSource["submission"], { format: "patchledger.candidate-submission/v2" }>["change_rationales"];
}

/** Reconcile context: author explanation and Change Rationales; never the Claims, self-verification or any verifier result. */
export const qualityReconcileContextFrom = (source: CandidateContextSource & { blind_context_digest: string }): QualityReconcileContext => ({
  format: QUALITY_CONTEXT_FORMAT,
  phase: "reconcile",
  candidate_id: source.candidate_id,
  result_tree_oid: source.result_tree_oid,
  blind_context_digest: source.blind_context_digest,
  submission_explanation: source.submission.explanation,
  change_rationales_status: source.submission.format === "patchledger.candidate-submission/v2" ? "recorded" : "not_recorded",
  change_rationales: source.submission.format === "patchledger.candidate-submission/v2" ? source.submission.change_rationales : [],
});

export const qualityTemplateFromBlindContext = (value: unknown, language?: "zh-CN") => {
  const context = record(value, "context") as unknown as QualityBlindContext;
  if (context.format !== QUALITY_CONTEXT_FORMAT) throw validation("context.format", `must equal ${QUALITY_CONTEXT_FORMAT}`);
  if (context.phase !== "blind") throw validation("context.phase", "quality template requires a blind context");
  if (!isUUIDv7(context.candidate_id)) throw validation("context.candidate_id", "must be a lowercase UUIDv7");
  if (!isGitOID(context.result_tree_oid)) throw validation("context.result_tree_oid", "must be a Git object ID");
  if (!isSha256(context.blind_context_digest)) throw validation("context.blind_context_digest", "must be a lowercase sha256 digest");
  const rubric = record(context.rubric, "context.rubric");
  if (rubric.version !== QUALITY_RUBRIC_VERSION) throw validation("context.rubric.version", `must equal ${QUALITY_RUBRIC_VERSION}`);
  const zh = language === "zh-CN";
  const report: QualityReviewReportInput = {
    format: QUALITY_REPORT_FORMAT,
    candidate_id: context.candidate_id,
    result_tree_oid: context.result_tree_oid,
    blind_context_digest: context.blind_context_digest,
    rubric_version: QUALITY_RUBRIC_VERSION,
    dimensions: QUALITY_DIMENSIONS.map((dimension) => ({
      dimension_id: dimension.id,
      independent: { verdict: "inconclusive" as const, explanation: zh ? "TODO: 用中文记录盲评阶段对该维度的独立判断" : "TODO: record the blind independent assessment of this dimension", findings: [], evidence: [] },
      reconciliation: { explanation: zh ? "TODO: 用中文说明作者说明与 Change Rationale 对判断的影响" : "TODO: explain how the author explanation and Change Rationales affected the judgement" },
      final: { verdict: "inconclusive" as const, explanation: zh ? "TODO: 用中文记录最终判断及依据" : "TODO: record the final assessment", findings: [] },
    })),
  };
  validateQualityReviewReport(report);
  return {
    result_type: "patchledger.result.quality-template/v1",
    command: "verification.template",
    candidate_id: report.candidate_id,
    blind_context_digest: report.blind_context_digest,
    result_tree_oid: report.result_tree_oid,
    report,
  };
};

export interface QualityHandoff { format: typeof QUALITY_HANDOFF_FORMAT; verifier: Attribution; report_digest: string; report: QualityReviewReportInput; public_key: string; signature: string }
export type VerifiedQualityHandoff = CheckedSignedHandoff<QualityReviewReportInput>;

export const createQualityHandoff = (report: QualityReviewReportInput, verifier: Attribution): QualityHandoff => {
  validateQualityReviewReport(report);
  return signHandoff(QUALITY_HANDOFF_FORMAT, report, verifier);
};
export const verifyQualityHandoff = (value: unknown): VerifiedQualityHandoff => checkSignedHandoff<QualityReviewReportInput>(value, QUALITY_HANDOFF_FORMAT, validateQualityReviewReport);
export const decodeQualityHandoffFile = (path: string): VerifiedQualityHandoff => verifyQualityHandoff(readJSONFile(path, "handoff"));

/** The one place that accepts a Verification role from outside (CLI flag or direct Module call). */
export const parseVerificationRole = (value: string): "contract" | "quality" => {
  if (value !== "contract" && value !== "quality") throw validation("role", "must be contract or quality");
  return value;
};
