import { generateKeyPairSync, sign, verify } from "node:crypto";
import { canonicalBytes, sha256, sha256Bytes } from "./canonical-json.js";
import { decodeFile, decodeVerificationReport, validateAttribution, validateVerificationReport, VERIFICATION_REPORT_FORMAT, type Attribution, type VerificationReportInput } from "./domain.js";
import { isGitOID, isSha256, isUUIDv7 } from "./identity.js";
import { validation } from "./errors.js";
import type { BlindVerificationContext } from "./projections.js";

export const VERIFICATION_HANDOFF_FORMAT = "patchledger.verification-handoff/v1" as const;

export interface VerificationHandoff {
  format: typeof VERIFICATION_HANDOFF_FORMAT;
  verifier: Attribution;
  report_digest: string;
  report: VerificationReportInput;
  public_key: string;
  signature: string;
}

export interface VerifiedVerificationHandoff {
  report: VerificationReportInput;
  attribution: Attribution;
  handoff_digest: string;
  key_fingerprint: string;
}

export const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(field, "must be an object");
  return value as Record<string, unknown>;
};

const signingPayload = (handoff: Pick<VerificationHandoff, "format" | "verifier" | "report_digest" | "report">): unknown => ({
  format: handoff.format,
  verifier: handoff.verifier,
  report_digest: handoff.report_digest,
  report: handoff.report,
});

export const verificationTemplateFromBlindContext = (value: unknown, language?: "zh-CN") => {
  const context = record(value, "context") as unknown as BlindVerificationContext;
  if (context.format !== "patchledger.verification-context/v1") throw validation("context.format", "must equal patchledger.verification-context/v1");
  if (context.phase !== "blind") throw validation("context.phase", "verification template requires a blind context");
  if (!isUUIDv7(context.candidate_id)) throw validation("context.candidate_id", "must be a lowercase UUIDv7");
  if (!isGitOID(context.result_tree_oid)) throw validation("context.result_tree_oid", "must be a Git object ID");
  if (!isSha256(context.blind_context_digest)) throw validation("context.blind_context_digest", "must be a lowercase sha256 digest");
  const revision = record(context.issue, "context.issue");
  const assessments: VerificationReportInput["assessments"] = [];
  for (const [targetType, name] of [["goal", "goals"], ["constraint", "constraints"]] as const) {
    const targets = revision[name];
    if (!Array.isArray(targets)) throw validation(`context.issue.${name}`, "must be an array");
    for (const rawTarget of targets) {
      const target = record(rawTarget, `context.issue.${name}`);
      if (!Array.isArray(target.criteria)) throw validation(`context.issue.${name}.criteria`, "must be an array");
      assessments.push({
        target_type: targetType,
        target_id: String(target.id ?? ""),
        criteria: target.criteria.map((rawCriterion) => {
          const criterion = record(rawCriterion, `context.issue_revision.${name}.criteria`);
          return {
            criterion_id: String(criterion.id ?? ""),
            independent: { verdict: "inconclusive" as const, explanation: language === "zh-CN" ? "TODO: 用中文记录盲审阶段的独立判断" : "TODO: record the blind independent assessment", evidence: [] },
            reconciliation: { claim_relation: "not_determined" as const, explanation: language === "zh-CN" ? "TODO: 用中文说明独立判断与作者声明的对照结果" : "TODO: reconcile with the submitter claim after blind assessment" },
            final: { verdict: "inconclusive" as const, explanation: language === "zh-CN" ? "TODO: 用中文记录最终判断及依据" : "TODO: record the final assessment" },
          };
        }),
      });
    }
  }
  const report: VerificationReportInput = {
    format: VERIFICATION_REPORT_FORMAT,
    candidate_id: context.candidate_id,
    result_tree_oid: context.result_tree_oid,
    blind_context_digest: context.blind_context_digest,
    assessments,
  };
  validateVerificationReport(report);
  return {
    result_type: "patchledger.result.verification-template/v1",
    command: "verification.template",
    candidate_id: report.candidate_id,
    blind_context_digest: report.blind_context_digest,
    result_tree_oid: report.result_tree_oid,
    report,
  };
};

/** Sign a fixed report with a one-shot Ed25519 key. Shared by every signed
 * verifier handoff format so contract and quality parts use one mechanism. */
export const signHandoff = <F extends string, R>(format: F, report: R, verifier: Attribution): { format: F; verifier: Attribution; report_digest: string; report: R; public_key: string; signature: string } => {
  validateAttribution(verifier);
  const reportDigest = sha256(report);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = publicKey.export({ type: "spki", format: "der" });
  const unsigned = { format, verifier, report_digest: reportDigest, report };
  return {
    ...unsigned,
    public_key: publicKeyBytes.toString("base64url"),
    signature: sign(null, canonicalBytes(unsigned), privateKey).toString("base64url"),
  };
};

export interface CheckedSignedHandoff<R> { report: R; attribution: Attribution; handoff_digest: string; key_fingerprint: string }

/** Verify format, digest and signature of a signed handoff; the caller
 * supplies the report validator for its own report format. */
export const checkSignedHandoff = <R>(value: unknown, format: string, validateReport: (report: R) => void): CheckedSignedHandoff<R> => {
  const source = record(value, "handoff");
  if (source.format !== format) throw validation("handoff.format", `must equal ${format}`);
  const report = source.report as R;
  validateReport(report);
  const attribution = source.verifier as Attribution;
  validateAttribution(attribution);
  if (source.report_digest !== sha256(report)) throw validation("handoff.report_digest", "does not match the embedded report");
  if (typeof source.public_key !== "string" || typeof source.signature !== "string") throw validation("handoff", "must contain public_key and signature");
  let publicKeyBytes: Buffer;
  let signature: Buffer;
  try {
    publicKeyBytes = Buffer.from(source.public_key, "base64url");
    signature = Buffer.from(source.signature, "base64url");
  } catch { throw validation("handoff", "contains invalid base64url signing data"); }
  const unsigned = { format, verifier: attribution, report_digest: source.report_digest, report };
  let valid = false;
  try { valid = verify(null, canonicalBytes(unsigned), { key: publicKeyBytes, format: "der", type: "spki" }, signature); } catch { valid = false; }
  if (!valid) throw validation("handoff.signature", "is invalid; the handoff may have changed after the verifier fixed it");
  const handoff = { ...unsigned, public_key: source.public_key, signature: source.signature };
  return { report, attribution, handoff_digest: sha256(handoff), key_fingerprint: sha256Bytes(publicKeyBytes) };
};

export const createVerificationHandoff = (report: VerificationReportInput, verifier: Attribution): VerificationHandoff => {
  validateVerificationReport(report);
  return signHandoff(VERIFICATION_HANDOFF_FORMAT, report, verifier);
};

export const verifyVerificationHandoff = (value: unknown): VerifiedVerificationHandoff =>
  checkSignedHandoff<VerificationReportInput>(value, VERIFICATION_HANDOFF_FORMAT, validateVerificationReport);

export const readJSONFile = (path: string, field: string): unknown => {
  try { return JSON.parse(decodeFile(path).toString("utf8")); } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw validation(field, error instanceof Error ? error.message : String(error));
  }
};

export const decodeVerificationHandoffFile = (path: string): VerifiedVerificationHandoff =>
  verifyVerificationHandoff(readJSONFile(path, "handoff"));

export const decodeBlindContextFile = (path: string): unknown => readJSONFile(path, "context");

const byText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** Digest of the contract report's independent (blind) parts only. The coordinator fixes it before the reconcile phase;
 * handoff then rejects a report whose blind part changed. The quality report has its own in quality-review.ts. */
export const independentDigestOfContract = (report: VerificationReportInput): string =>
  sha256([...report.assessments].sort((a, b) => byText(`${a.target_type}:${a.target_id}`, `${b.target_type}:${b.target_id}`)).flatMap((target) =>
    [...target.criteria].sort((a, b) => byText(a.criterion_id, b.criterion_id)).map((criterion) => ({ target_type: target.target_type, target_id: target.target_id, criterion_id: criterion.criterion_id, independent: criterion.independent }))));
