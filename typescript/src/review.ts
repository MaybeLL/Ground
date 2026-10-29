import type {
  Attribution,
  Baseline,
  CandidateArtifact,
  CandidateFile,
  CandidateSubmissionInput,
  ChangeRationaleInput,
  ClaimRecord,
  EvidenceInput,
  Decision,
  VerificationReportInput,
} from "./domain.js";
import type { IssueVersion, RequirementVersion } from "./projections.js";
import { PLAN_NOTICE_TEXT } from "./plan-render.js";
import { matchChangeLine, type ChangeIndex, type ChangeLineStatus, type ChangeUnit } from "./change-index.js";
import { renderMarkdownPreview } from "./markdown-preview.js";
import { summarizeSelfVerification } from "./domain.js";
import type { QualityFinding, QualityReviewReportInput, Verdict, VerificationMode } from "./quality-review.js";

const selfVerificationLines = (criterion: ClaimRecord["criteria"][number]): string[] => {
  const check = criterion.self_verification;
  if (!check) return ["Self-verification [author / 自我验证]: not_recorded（未记录）"];
  const labels = { satisfied: "满足", partially_satisfied: "部分满足", not_satisfied: "未满足", inconclusive: "无法判断", not_verified: "未验证" };
  return [`Self-verification [author / 自我验证]: ${check.status}（${labels[check.status]}）`,
    ...(check.method ? [`Check method: ${check.method}`] : []), `Check explanation: ${check.explanation}`];
};

/** Render author-recorded decision context, not verified effects or new Criteria. */
const decisionDetailLines = (decision: Decision): string[] => {
  const lines: string[] = [];
  if (decision.context !== undefined) lines.push(`Context: ${decision.context}`);
  for (const option of decision.options ?? []) {
    lines.push(`Option ${option.key}${option.key === decision.chosen_option ? " [chosen]" : ""}: ${option.description}`);
    for (const benefit of option.benefits ?? []) lines.push(`  Benefit: ${benefit}`);
    for (const cost of option.costs ?? []) lines.push(`  Cost: ${cost}`);
  }
  for (const item of decision.trade_offs ?? []) lines.push(`Trade-off: gain ${item.gain}; accept ${item.sacrifice}; because ${item.reason}`);
  for (const item of decision.consequences ?? []) lines.push(`Expected consequence [${item.kind}]: ${item.statement}`);
  return lines;
};

export type ReviewSource = "ledger_fact" | "author_claim" | "verifier_finding" | "derived_relation" | "unknown";
export type ReviewSide = "old" | "new";

export interface ReviewLocationRequest {
  path: string;
  side: ReviewSide;
  line?: number;
}

export interface ReviewLocation {
  source: "derived_relation";
  requested_path: string;
  side: ReviewSide;
  line?: number;
  match: "change_unit" | "file" | "none";
  line_status?: ChangeLineStatus;
  file?: CandidateFile;
  change_units: ChangeUnit[];
  rationales: ChangeRationaleInput[];
  rationale_coverage: {
    source: "derived_relation";
    status: "complete" | "not_recorded" | "not_applicable";
    reason?: "candidate_submission_v1_has_no_change_rationales" | "line_is_unchanged_context" | "line_is_outside_changed_ranges" | "line_precision_unavailable";
  };
}

export interface ReviewVerification {
  source: "verifier_finding";
  verification_id: string;
  mode: VerificationMode;
  overall_verdict: string;
  created_at: string;
  attribution: Attribution;
  report: VerificationReportInput;
  /** Present for ultra only: the separately signed code-quality part. */
  quality?: { overall_verdict: Verdict; attribution: Attribution; report: QualityReviewReportInput };
}

export interface VerificationSetSummary {
  source: "derived_relation";
  count: number;
  digest: string;
  standing: string;
  verdict_counts: { qualified: number; rejected: number; inconclusive: number };
  reports_included: false;
}
export interface ReviewSummaryResult {
  result_type: "patchledger.result.review-summary/v1";
  command: "review";
  trace: Omit<ReviewTraceResult["trace"], "format" | "verification_set"> & {
    format: "patchledger.review-summary/v1";
    verification_set: VerificationSetSummary;
  };
}
export interface VerificationPageResult {
  result_type: "patchledger.result.verification-page/v1";
  command: "verification.list";
  candidate_id: string;
  verification_set: VerificationSetSummary;
  verifications: { verification_id: string; candidate_id: string; overall_verdict: string; created_at: string; attribution: Attribution }[];
  next_cursor?: string;
}

const syncLines = (records: import("./devrun-sync-record.js").SyncReview[]): string[] => [
  "", "## Sync decisions (author context, not blind Verification)",
  ...records.flatMap(record => [
    `- ${record.id}: ${record.outcome}; ${record.original_base} → ${record.target}; ${record.finished_at}`,
    ...record.decisions.map(decision => `  - ${decision.path}: ${decision.explanation}`),
  ]),
];

export interface ReviewTraceResult {
  result_type: "patchledger.result.review-trace/v3";
  command: "review";
  trace: {
    comparison_basis?: { left_commit: string; right_commit?: string; right_tree: string; purpose: "candidate_changes"; generator_version: "grounds.canonical-git-diff/v1"; diff_state: "inline" | "not_requested" | "omitted_size" | "binary" };
    lineage?: import("./candidate-history.js").CandidateLineage;
    archive_history?: import("./candidate-archive-service.js").ArchiveOperation[];
    adoption?: import("./integration-service.js").IntegrationRecord[];
    upstream_changes?: import("./comparison.js").UpstreamChanges;
    sync_records?: import("./devrun-sync-record.js").SyncReview[];
    format: "patchledger.review-trace/v3";
    candidate: {
      source: "ledger_fact";
      candidate_id: string;
      dev_run_id: string;
      created_at: string;
      attribution: Attribution;
      standing: string;
      exploration_brief?: string;
      refines_candidate_id?: string;
    };
    repository: {
      source: "ledger_fact";
      id: string;
      canonical_remote_at_submission: string;
    };
    baseline: Baseline & { source: "ledger_fact" };
    contract: {
      source: "ledger_fact";
      requirement: RequirementVersion;
      issue: IssueVersion;
    };
    artifact: {
      git_artifact?: import("./git-artifact-storage.js").GitCommitArtifact;
      source: "ledger_fact";
      source_commit?: string;
      source_parents?: string[];
      base_commit?: string;
      format: string;
      result_tree_oid: string;
      patch_digest: string;
      uncompressed_size: number;
      file_manifest: CandidateFile[];
      patch_state: "inline" | "not_requested" | "omitted_size" | "binary";
      patch?: string;
    };
    change_index: ChangeIndex & { source: "derived_relation" };
    location?: ReviewLocation;
    submission: {
      source: "author_claim";
      format: CandidateSubmissionInput["format"];
      explanation: string;
      claims: ClaimRecord[];
      change_rationales: ChangeRationaleInput[];
    };
    verification_set: {
      source: "derived_relation";
      count: number;
      digest: string;
      standing: string;
      complete: true;
      verifications: ReviewVerification[];
    };
    explanation_coverage: {
      source: "derived_relation";
      status: "complete" | "not_recorded" | "not_applicable";
      total_change_units: number;
      explained_change_units: number;
      unexplained_change_unit_ids: string[];
      reason?: "candidate_submission_v1_has_no_change_rationales" | "candidate_has_no_changes";
    };
  };
}

const decodedUTF8Path = (encoded: string): string | undefined => {
  const bytes = Buffer.from(encoded, "base64");
  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : undefined;
};

const pathForSide = (file: CandidateFile, side: ReviewSide): string | undefined => {
  if (side === "old" && file.old_path_bytes !== undefined) return decodedUTF8Path(file.old_path_bytes);
  return decodedUTF8Path(file.path_bytes);
};

export const locateReviewPath = (artifact: CandidateArtifact, changeIndex: ChangeIndex, submission: CandidateSubmissionInput, request: ReviewLocationRequest): ReviewLocation => {
  const file = artifact.files.find((entry) => {
    const sidePath = pathForSide(entry, request.side);
    if (sidePath === request.path) return true;
    // display_path describes the new path. It is still useful for non-UTF-8
    // paths, but must not make a renamed file's new name match an old-side
    // request.
    return !(request.side === "old" && entry.old_path_bytes !== undefined) && entry.display_path === request.path;
  });
  const fileUnits = file ? changeIndex.change_units.filter((unit) => unit.path_bytes === file.path_bytes) : [];
  const lineMatch = file && request.line !== undefined
    ? matchChangeLine(artifact, fileUnits, request.line, request.side)
    : undefined;
  const selectedUnits = request.line === undefined
    ? fileUnits
    : lineMatch?.change_units ?? [];
  const selectedIDs = new Set(selectedUnits.map((unit) => unit.change_unit_id));
  const rationales = submission.format === "patchledger.candidate-submission/v2"
    ? submission.change_rationales.filter((rationale) => rationale.change_refs.some((unitID) => selectedIDs.has(unitID)))
    : [];
  const unavailableReason = lineMatch?.status === "context"
    ? "line_is_unchanged_context" as const
    : lineMatch?.status === "outside_hunks"
      ? "line_is_outside_changed_ranges" as const
      : lineMatch?.status === "unavailable"
        ? "line_precision_unavailable" as const
        : undefined;
  const rationaleCoverage: ReviewLocation["rationale_coverage"] = !file || !selectedUnits.length
    ? { source: "derived_relation", status: "not_applicable", ...(unavailableReason ? { reason: unavailableReason } : {}) }
    : submission.format === "patchledger.candidate-submission/v1"
      ? { source: "derived_relation", status: "not_recorded", reason: "candidate_submission_v1_has_no_change_rationales" }
      : { source: "derived_relation", status: "complete" };
  return {
    source: "derived_relation",
    requested_path: request.path,
    side: request.side,
    ...(request.line === undefined ? {} : { line: request.line }),
    ...(lineMatch ? { line_status: lineMatch.status } : {}),
    match: selectedUnits.length ? "change_unit" : file ? "file" : "none",
    ...(file ? { file } : {}),
    change_units: selectedUnits,
    rationales,
    rationale_coverage: rationaleCoverage,
  };
};

const actor = (attribution: Attribution): string => attribution.kind === "human"
  ? `${attribution.git_name} <${attribution.git_email}>`
  : `${attribution.display_name} (${attribution.agent_id})`;

const indentedLines = (value: string, prefix = "    "): string[] => value.split(/\r?\n/).map((line) => `${prefix}${line}`);

const candidateArchiveLines = (trace: ReviewTraceResult["trace"] | ReviewSummaryResult["trace"]): string[] => {
  const git = trace.artifact.git_artifact, basis = trace.comparison_basis;
  return [
    ...(basis ? [`Fixed comparison: ${basis.left_commit} → ${basis.right_commit ?? `tree ${basis.right_tree}`}; purpose ${basis.purpose}; generator ${basis.generator_version}; diff ${basis.diff_state}`] : []),
    ...(git ? [`Historical archive: ${git.receipt.status} at ${git.receipt.observed_at}; ${git.binding.archive_ref}`, "Current remote availability: unknown (use candidate archive-status --refresh explicitly); archive success is separate from verification and adoption."] : []),
    ...(trace.lineage ? [`Lineage: initial B ${trace.lineage.initial_base_commit ?? "unknown"}; predecessor ${trace.lineage.refines_candidate_id ?? "none recorded"}; successors ${trace.lineage.successor_candidate_ids.join(", ") || "none"}${trace.lineage.successors_omitted ? " (incomplete)" : ""}`] : []),
    ...(trace.archive_history ?? []).map(operation => `Archive operation ${operation.operation_id}: ${operation.purpose}/${operation.phase} at ${operation.updated_at}${operation.reason ? `; ${operation.reason}` : ""}`),
    ...(trace.adoption ?? []).flatMap(record => {
      const landing = record.landing, predecessor = landing?.target_predecessor;
      return [
        `Adoption ${record.id} at ${record.created_at}: source C ${landing?.adoption?.source_commit ?? "unknown"}; landed L ${landing?.adoption?.landed_commit ?? landing?.actual_landing?.oid ?? "unknown"}; ${landing?.decision.outcome ?? "unknown"}`,
        `Actual target predecessor P: ${predecessor?.state === "confirmed" ? predecessor.commit?.oid ?? "unknown" : "unknown"}; evidence ${predecessor?.state ?? "unknown"}; source ${predecessor?.source ?? "unknown"}${predecessor?.reason ? `; ${predecessor.reason}` : ""}`,
        `Git first parent of L: ${landing?.actual_landing?.parents[0] ?? "unknown"}; fast-forward target predecessor P may differ. Adoption, predecessor evidence and archival are separate; absent historical P is not inferred.`,
      ];
    }),
  ];
};

export const renderReviewTrace = (result: ReviewTraceResult): string => {
  const { trace } = result;
  const lines = [
    `Candidate ${trace.candidate.candidate_id} — ${trace.candidate.standing}`,
    `Repository: ${trace.repository.canonical_remote_at_submission}`,
    `Baseline: ${trace.baseline.git_oid}`,
    ...(trace.artifact.base_commit ? [`Candidate base: ${trace.artifact.base_commit}`] : []),
    ...candidateArchiveLines(trace),
    ...(trace.upstream_changes ? upstreamLines(trace.upstream_changes) : []),
    ...(trace.sync_records ? syncLines(trace.sync_records) : []),
    `Submitted by: ${actor(trace.candidate.attribution)} at ${trace.candidate.created_at}`,
  ];

  if (trace.location) {
    lines.push("", `Location: ${trace.location.requested_path}${trace.location.line === undefined ? "" : `:${trace.location.line}`} (${trace.location.side} side)`);
    lines.push(trace.location.match !== "none"
      ? `Matched changed file: ${trace.location.file!.display_path} [${trace.location.file!.change}]`
      : "Matched changed file: none");
    if (trace.location.line_status) {
      const status = trace.location.line_status === "context"
        ? "unchanged context inside a changed hunk"
        : trace.location.line_status === "outside_hunks"
          ? "outside all changed hunks"
          : trace.location.line_status === "unavailable"
            ? "line precision unavailable for this file-level change"
            : trace.location.line_status;
      lines.push(`Line status [derived relation]: ${status}`);
    }
    if (trace.location.change_units.length) {
      lines.push(`Matched Change Units: ${trace.location.change_units.length}`);
      for (const unit of trace.location.change_units) {
        const range = trace.location.side === "old" ? unit.old_range : unit.new_range;
        lines.push(`  - ${unit.kind} ${unit.change_unit_id}${range ? ` (lines ${range.start}-${range.start + Math.max(range.lines - 1, 0)})` : ""}`);
      }
    }
    if (!trace.location.rationales.length) {
      lines.push(trace.location.rationale_coverage.status === "not_recorded"
        ? "Change rationale: not recorded by CandidateSubmission v1"
        : "Change rationale: not applicable at this location");
    }
    for (const rationale of trace.location.rationales) {
      lines.push(`Change rationale [author claim, ${rationale.relation}]:`, ...indentedLines(rationale.rationale));
      lines.push(`  Criteria: ${rationale.target_refs.map((target) => target.id).join(", ")}`);
      for (const alternative of rationale.alternatives) lines.push(`  Rejected alternative: ${alternative.approach} — ${alternative.rejected_because}`);
      for (const risk of rationale.risks) lines.push(`  Risk: ${risk}`);
    }
  }

  lines.push("", "Author's stated purpose [author claim]:", ...indentedLines(trace.submission.explanation));
  if (trace.candidate.exploration_brief) lines.push("", "Exploration brief:", ...indentedLines(trace.candidate.exploration_brief));

  lines.push("", `Historical contract [ledger fact]: Requirement ${trace.contract.requirement.id} v${trace.contract.requirement.version}`);
  lines.push(...indentedLines(trace.contract.requirement.summary));
  lines.push("  Outcomes:", ...trace.contract.requirement.outcomes.map((item, index) => `    - outcome-${index + 1}: ${item}`));
  if (trace.contract.requirement.decisions.length) {
    lines.push("  Decisions:");
    for (const [index, decision] of trace.contract.requirement.decisions.entries()) {
      lines.push(`    - decision-${index + 1}: ${decision.statement}${decision.rationale ? ` — ${decision.rationale}` : ""}`, ...decisionDetailLines(decision).flatMap((line) => line.split("\n").map((part) => `      ${part}`)));
    }
  }

  lines.push("", `Issue ${trace.contract.issue.id} v${trace.contract.issue.version}: ${trace.contract.issue.summary}`);
  // Plan is non-normative; it is exported under the same notice the review page
  // shows, and before Goals so the reading order matches the HTML.
  const plan = (trace.contract.issue as { plan?: string }).plan;
  if (plan) lines.push(`  方案说明（非约束）: ${PLAN_NOTICE_TEXT}`, ...plan.split("\n").map((line) => `    ${line}`));
  lines.push("  Goals:");
  for (const goal of trace.contract.issue.goals) {
    lines.push(`    - ${goal.statement} (${goal.id})`);
    for (const link of goal.traces_to ?? []) {
      const intent = link.type === "outcome" ? trace.contract.requirement.outcomes[link.ordinal - 1] : trace.contract.requirement.decisions[link.ordinal - 1]?.statement;
      lines.push(`      ↳ ${link.type}-${link.ordinal}: ${intent} [derived relation]`);
    }
    for (const criterion of goal.criteria) lines.push(`      · ${criterion.statement} (${criterion.id})`);
  }
  if (trace.contract.issue.constraints.length) {
    lines.push("  Constraints:");
    for (const constraint of trace.contract.issue.constraints) {
      lines.push(`    - ${constraint.statement} (${constraint.id})`);
      for (const link of constraint.traces_to ?? []) {
        const intent = link.type === "outcome" ? trace.contract.requirement.outcomes[link.ordinal - 1] : trace.contract.requirement.decisions[link.ordinal - 1]?.statement;
        lines.push(`      ↳ ${link.type}-${link.ordinal}: ${intent} [derived relation]`);
      }
      for (const criterion of constraint.criteria) lines.push(`      · ${criterion.statement} (${criterion.id})`);
    }
  }

  lines.push("", `Claims [author claim]: ${trace.submission.claims.length}`);
  for (const claim of trace.submission.claims) {
    lines.push(`  - ${claim.target_type} ${claim.target_id}: ${claim.explanation}`);
    lines.push(`    Self-verification counts [author]: ${JSON.stringify(summarizeSelfVerification(claim.criteria))}`);
    for (const criterion of claim.criteria) {
      lines.push(`    · ${criterion.criterion_id}: ${criterion.explanation} (${criterion.evidence.length} evidence item${criterion.evidence.length === 1 ? "" : "s"})`);
      lines.push(...selfVerificationLines(criterion).map((line) => `      ${line}`));
    }
  }

  lines.push("", `Verification [complete set, ${trace.verification_set.digest}]: ${trace.verification_set.count}`);
  if (!trace.verification_set.verifications.length) lines.push("  No verifier findings recorded.");
  for (const verification of trace.verification_set.verifications) {
    lines.push(`  - ${verification.overall_verdict} by ${actor(verification.attribution)} at ${verification.created_at} (${verification.verification_id})`);
    for (const assessment of verification.report.assessments) {
      for (const criterion of assessment.criteria) {
        lines.push(`    · ${assessment.target_type} ${assessment.target_id} / ${criterion.criterion_id}: ${criterion.final.verdict} — ${criterion.final.explanation}`);
      }
    }
  }

  lines.push("", "Provenance: contracts/artifact are ledger facts; purpose and rationales are author claims; Change Units and coverage are derived relations; verification is verifier finding.");
  const coverage = trace.explanation_coverage;
  lines.push(`Coverage: ${coverage.explained_change_units}/${coverage.total_change_units} Change Units explained (${coverage.status}).`);
  if (coverage.unexplained_change_unit_ids.length) lines.push(`Unexplained Change Units: ${coverage.unexplained_change_unit_ids.join(", ")}`);
  if (trace.artifact.patch_state === "inline") lines.push("", "Unified diff:", trace.artifact.patch!);
  else if (trace.artifact.patch_state !== "not_requested") lines.push("", `Unified diff: ${trace.artifact.patch_state}`);
  return lines.join("\n");
};

const markdownText = (value: string): string => value
  .replace(/\r?\n/g, " ")
  .replace(/\\/g, "\\\\")
  .replace(/([`*_[\]<>|])/g, "\\$1");

const markdownCode = (value: string): string => {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const padding = value.startsWith(" ") || value.endsWith(" ") || value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
};

const markdownQuote = (value: string): string[] => value
  .split(/\r?\n/)
  .map((line) => `> ${markdownText(line)}`);

const markdownEvidence = (evidence: EvidenceInput & { digest?: string }): string[] => {
  const digest = evidence.digest ? `; evidence \`${evidence.digest}\`` : "";
  if (evidence.type === "command") return [
    `command ${markdownCode(evidence.command)} exited ${evidence.exit_code}${digest}`,
    ...(evidence.output === undefined ? [] : ["Output:", ...markdownQuote(evidence.output)]),
  ];
  if (evidence.type === "observation") return [`observation: ${markdownText(evidence.statement)} — ${markdownText(actor(evidence.attribution))}${digest}`];
  if (evidence.type === "external_reference") return [`external reference: ${markdownText(evidence.title ?? evidence.url)}; URL ${markdownCode(evidence.url)}; content \`${evidence.content_digest}\`${digest}`];
  return [
    `artifact ${markdownText(evidence.name)} (${markdownText(evidence.media_type)})${digest}`,
    "Content (base64):",
    ...markdownQuote(evidence.content_base64),
  ];
};

const appendMarkdownEvidence = (lines: string[], evidence: EvidenceInput & { digest?: string }, label: string): void => {
  const rendered = markdownEvidence(evidence);
  lines.push(`  - ${label}: ${rendered[0]}`);
  for (const detail of rendered.slice(1)) lines.push(`    ${detail}`);
};

const markdownDetails = (summary: string, body: string[]): string[] => [
  "<details>",
  `<summary>${markdownText(summary)}</summary>`,
  "",
  ...body,
  "",
  "</details>",
];

const upstreamLines = (changes: import("./comparison.js").UpstreamChanges): string[] => [
  "", "### Upstream base changes (not Candidate changes)",
  `\`${changes.left_base_commit}\` → \`${changes.right_base_commit}\``,
  changes.status === "unavailable" ? "History unavailable; do not interpret missing data as zero upstream changes."
    : `${changes.diff!.stats.files} files, +${changes.diff!.stats.insertions}/-${changes.diff!.stats.deletions}; diff: ${changes.diff!.diff_state}.`,
  ...(changes.diff?.diff_state === "inline" && changes.diff.unified_diff !== undefined ? markdownFence(changes.diff.unified_diff, "diff") : []),
];

const markdownFence = (value: string, language: string): string[] => {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${language}`, value, fence];
};

/** Render a portable, read-only review summary suitable for a Markdown file or PR body. */
export const renderReviewVerification = (trace: ReviewTraceResult["trace"] | ReviewSummaryResult["trace"], verification: ReviewVerification): string => {
  const criterionByID = new Map([...trace.contract.issue.goals, ...trace.contract.issue.constraints].flatMap(target => target.criteria.map(criterion => [criterion.id, { criterion }] as const)));
  const verificationLines: string[] = [];
    verificationLines.push(
      "",
      `### ${markdownText(verification.overall_verdict)} — ${markdownText(actor(verification.attribution))}`,
      "",
      `- Verification: \`${verification.verification_id}\``,
      `- Mode: ${verification.mode}`,
      `- Created at: ${markdownText(verification.created_at)}`,
      `- Report format: \`${verification.report.format}\``,
      `- Candidate: \`${verification.report.candidate_id}\``,
      `- Result tree: \`${verification.report.result_tree_oid}\``,
      `- Blind-context digest: \`${verification.report.blind_context_digest}\``,
    );
    for (const assessment of verification.report.assessments) {
      for (const criterion of assessment.criteria) {
        const resolved = criterionByID.get(criterion.criterion_id);
        verificationLines.push(
          `- ${assessment.target_type} \`${assessment.target_id}\` / ${markdownText(resolved?.criterion.statement ?? criterion.criterion_id)} (\`${criterion.criterion_id}\`): **${criterion.final.verdict}** — ${markdownText(criterion.final.explanation)}`,
          `  - Independent assessment: **${criterion.independent.verdict}** — ${markdownText(criterion.independent.explanation)}`,
        );
        if (!criterion.independent.evidence.length) verificationLines.push("  - Independent Evidence: none recorded");
        else for (const evidence of criterion.independent.evidence) appendMarkdownEvidence(verificationLines, evidence, "Independent Evidence");
        verificationLines.push(`  - Reconciliation: ${criterion.reconciliation.claim_relation} — ${markdownText(criterion.reconciliation.explanation)}`);
      }
    }
    if (verification.quality) {
      const renderFinding = (finding: QualityFinding): string => `${finding.severity}${finding.location ? ` at \`${finding.location.path}${finding.location.line === undefined ? "" : `:${finding.location.line}`}\`` : ""}: ${markdownText(finding.explanation)}`;
      verificationLines.push("", `#### Code quality review — ${markdownText(verification.quality.overall_verdict)} — ${markdownText(actor(verification.quality.attribution))}`, `- Rubric: \`${verification.quality.report.rubric_version}\``);
      for (const dimension of verification.quality.report.dimensions) {
        verificationLines.push(
          `- \`${dimension.dimension_id}\`: **${dimension.final.verdict}** — ${markdownText(dimension.final.explanation)}`,
          `  - Independent assessment: **${dimension.independent.verdict}** — ${markdownText(dimension.independent.explanation)}`,
          ...dimension.independent.findings.map((finding) => `  - Independent finding — ${renderFinding(finding)}`),
        );
        if (!dimension.independent.evidence.length) verificationLines.push("  - Independent Evidence: none recorded");
        else for (const evidence of dimension.independent.evidence) appendMarkdownEvidence(verificationLines, evidence, "Independent Evidence");
        verificationLines.push(`  - Reconciliation: ${markdownText(dimension.reconciliation.explanation)}`, ...dimension.final.findings.map((finding) => `  - Final finding — ${renderFinding(finding)}`));
      }
    }
  return verificationLines.join("\n");
};

const reviewMarkdownParts = (result: ReviewTraceResult | ReviewSummaryResult): { before: string; reports: string; after: string } => {
  const { trace } = result;
  const targets = [...trace.contract.issue.goals.map((target) => ({ ...target, type: "goal" as const })), ...trace.contract.issue.constraints.map((target) => ({ ...target, type: "constraint" as const }))];
  const targetByID = new Map(targets.map((target) => [target.id, target]));
  const criterionByID = new Map(targets.flatMap((target) => target.criteria.map((criterion) => [criterion.id, { criterion, target }] as const)));
  const unitByID = new Map(trace.change_index.change_units.map((unit) => [unit.change_unit_id, unit]));
  const intentLabel = (target: typeof targets[number]): string[] => (target.traces_to ?? []).map((link) => {
    const statement = link.type === "outcome"
      ? trace.contract.requirement.outcomes[link.ordinal - 1]
      : trace.contract.requirement.decisions[link.ordinal - 1]?.statement;
    return `${link.type}-${link.ordinal}: ${markdownText(statement ?? "unknown")}`;
  });
  const unitLabel = (unit: ChangeUnit, side: ReviewSide = "new"): string => {
    if (unit.kind === "file") return `${markdownCode(unit.display_path)} (file-level ${markdownText(unit.change)})`;
    const range = side === "old" ? unit.old_range : unit.new_range;
    const path = side === "old" && unit.old_path_bytes !== undefined
      ? decodedUTF8Path(unit.old_path_bytes) ?? unit.display_path
      : unit.display_path;
    const location = !range || range.lines === 0
      ? path
      : `${path}:${range.start}-${range.start + range.lines - 1}`;
    return `${markdownCode(location)} (hunk)`;
  };
  const scopedUnits = trace.location ? trace.location.change_units : trace.change_index.change_units;
  const scopedRationales = trace.location ? trace.location.rationales : trace.submission.change_rationales;
  const scopedSide = trace.location?.side;
  const relevantTargetIDs = new Set(scopedRationales.flatMap((rationale) => rationale.target_refs.map((target) => criterionByID.get(target.id)?.target.id).filter((id): id is string => Boolean(id))));
  const relevantTargets = targets.filter((target) => relevantTargetIDs.has(target.id));
  const risks = [...new Set(scopedRationales.flatMap((rationale) => rationale.risks))];
  const reports = "verifications" in trace.verification_set ? trace.verification_set.verifications : [];
  const counts = "verdict_counts" in trace.verification_set ? trace.verification_set.verdict_counts : undefined;
  const verdictCounts = new Map<string, number>();
  for (const verification of reports) verdictCounts.set(verification.overall_verdict, (verdictCounts.get(verification.overall_verdict) ?? 0) + 1);
  if (counts) { verdictCounts.clear(); for (const [verdict, count] of Object.entries(counts)) if (count) verdictCounts.set(verdict, count); }
  const verificationSummary = trace.verification_set.count === 0
    ? "none recorded"
    : [...verdictCounts.entries()].map(([verdict, count]) => `${count} ${verdict}`).join(", ");
  const coverage = trace.explanation_coverage;

  const issuePlan = (trace.contract.issue as { plan?: string }).plan;
  const lines = [
    `# Grounds Review — ${markdownText(trace.contract.issue.summary)}`,
    "",
    "## Review at a glance",
    "",
    "| Signal | Result | Source |",
    "| --- | --- | --- |",
    `| Purpose | ${markdownText(trace.submission.explanation)} | author claim |`,
    `| Standing | **${markdownText(trace.candidate.standing)}** | derived relation |`,
    `| Verification | ${markdownText(verificationSummary)}; complete-set standing **${markdownText(trace.verification_set.standing)}** | verifier findings + derived relation |`,
    `| Scope | ${trace.artifact.file_manifest.length} changed file${trace.artifact.file_manifest.length === 1 ? "" : "s"}; ${trace.change_index.change_units.length} Change Unit${trace.change_index.change_units.length === 1 ? "" : "s"} | ledger fact + derived relation |`,
    `| Changed areas | ${trace.artifact.file_manifest.map((file) => markdownCode(file.display_path).replace(/\|/g, "\\|")).join(", ")} | ledger fact |`,
    `| Rationale coverage | ${coverage.explained_change_units}/${coverage.total_change_units} (**${coverage.status}**) | derived relation |`,
  ];
  if (risks.length) lines.push(`| Recorded risks | ${risks.map(markdownText).join(" ")} | author claim |`);
  const archiveLines = candidateArchiveLines(trace);
  if (archiveLines.length) lines.push("", "## Fixed code and archive history", "", ...archiveLines.map(line => `- ${markdownText(line)}`));

  if (trace.location) {
    lines.push("", "## Requested location", "");
    lines.push(`- Location: ${markdownCode(`${trace.location.requested_path}${trace.location.line === undefined ? "" : `:${trace.location.line}`}`)} (${trace.location.side} side)`);
    lines.push(`- Match: ${trace.location.match} *(derived relation)*`);
    if (trace.location.line_status) {
      const status = trace.location.line_status === "context"
        ? "context — this line is unchanged inside a changed hunk"
        : trace.location.line_status === "outside_hunks"
          ? "outside_hunks — this line is outside every changed hunk"
          : trace.location.line_status === "unavailable"
            ? "unavailable — line precision is unavailable for this file-level change"
            : trace.location.line_status;
      lines.push(`- Line status: **${status}** *(derived relation)*`);
    }
    if (trace.location.rationale_coverage.reason) lines.push(`- Rationale applicability: ${markdownText(trace.location.rationale_coverage.reason)} *(derived relation)*`);
  }

  lines.push("", "## Intent connected to these changes", "");
  if (!relevantTargets.length) {
    lines.push("No author rationale links this scope to a Criterion, so its upstream intent is **unknown**.");
  } else for (const target of relevantTargets) {
    lines.push(`- **${target.type === "goal" ? "Goal" : "Constraint"}** *(ledger fact)*: ${markdownText(target.statement)}`);
    const relevantCriteria = target.criteria.filter((criterion) => scopedRationales.some((rationale) => rationale.target_refs.some((ref) => ref.id === criterion.id)));
    for (const criterion of relevantCriteria) lines.push(`  - Criterion *(ledger fact)*: ${markdownText(criterion.statement)}`);
    const intents = intentLabel(target);
    if (!intents.length) lines.push("  - Upstream intent: **no recorded Intent Link**");
    else for (const intent of intents) lines.push(`  - Upstream intent *(ledger fact joined by derived relation)*: ${intent}`);
  }

  lines.push("", "## Changes and why", "");
  if (!scopedUnits.length) lines.push("No exact Change Unit is attached to this scope.");
  if (!scopedRationales.length) {
    const status = trace.location?.rationale_coverage.status ?? trace.explanation_coverage.status;
    lines.push(`No author Change Rationale is recorded for this scope (**${status}**).`);
    for (const unit of scopedUnits) lines.push(`- ${unitLabel(unit, scopedSide)}`);
  }
  const rationaleDetailLines: string[] = [];
  for (const [index, rationale] of scopedRationales.entries()) {
    const resolvedUnits = rationale.change_refs.map((changeID) => unitByID.get(changeID));
    const changes = resolvedUnits.map((unit) => unit ? unitLabel(unit, scopedSide) : "unknown Change Unit").join(", ");
    const criteria = rationale.target_refs.map((targetRef) => criterionByID.get(targetRef.id)?.criterion.statement ?? "unknown Criterion").join("; ");
    lines.push(`- ${changes} — ${markdownText(rationale.rationale)} *(${rationale.relation}; author claim)*`);
    if (criteria) lines.push(`  - Serves: ${markdownText(criteria)}`);
    if (rationale.risks.length) lines.push(`  - Risks: ${rationale.risks.map(markdownText).join(" ")}`);

    rationaleDetailLines.push(`### ${index + 1}. ${rationale.relation}`, "", ...markdownQuote(rationale.rationale), "");
    for (const changeID of rationale.change_refs) {
      const unit = unitByID.get(changeID);
      rationaleDetailLines.push(`- Change: ${unit ? unitLabel(unit, scopedSide) : "unknown Change Unit"} — \`${changeID}\``);
    }
    for (const targetRef of rationale.target_refs) {
      const resolved = criterionByID.get(targetRef.id);
      rationaleDetailLines.push(`- Criterion: ${resolved ? markdownText(resolved.criterion.statement) : "unknown"} — \`${targetRef.id}\``);
      if (resolved) for (const intent of intentLabel(resolved.target)) rationaleDetailLines.push(`  - Upstream intent: ${intent} *(derived relation)*`);
    }
    for (const alternative of rationale.alternatives) rationaleDetailLines.push(`- Rejected alternative: ${markdownText(alternative.approach)} — ${markdownText(alternative.rejected_because)}`);
    for (const risk of rationale.risks) rationaleDetailLines.push(`- Recorded risk: ${markdownText(risk)}`);
    if (index < scopedRationales.length - 1) rationaleDetailLines.push("");
  }

  const warnings: string[] = [];
  if (coverage.status !== "complete") warnings.push(`Change Rationale coverage is ${coverage.status}.`);
  if (coverage.unexplained_change_unit_ids.length) warnings.push(`${coverage.unexplained_change_unit_ids.length} Change Unit(s) have no recorded rationale.`);
  if (trace.verification_set.count === 0) warnings.push("No independent Verification is recorded.");
  if (["disputed", "rejected", "inconclusive"].includes(trace.verification_set.standing)) warnings.push(`Verification standing is ${trace.verification_set.standing}; inspect the complete findings before relying on this Candidate.`);
  if (relevantTargets.some((target) => !(target.traces_to ?? []).length)) warnings.push("At least one change-linked Goal or Constraint has no recorded Intent Link.");
  if (trace.location?.line_status === "context") warnings.push("The requested line itself did not change; surrounding-hunk rationale is intentionally not attached to it.");
  if (warnings.length) lines.push("", "## Review warnings", "", ...warnings.map((warning) => `- ${markdownText(warning)}`));

  const contractLines = [
    `Requirement \`${trace.contract.requirement.id}\` v${trace.contract.requirement.version}: ${markdownText(trace.contract.requirement.summary)}`,
    ...(trace.contract.requirement.context === undefined ? [] : ["", "### Requirement context", "", ...markdownQuote(trace.contract.requirement.context)]),
    "",
    ...trace.contract.requirement.outcomes.map((outcome, index) => `- **Outcome ${index + 1}:** ${markdownText(outcome)}`),
  ];
  for (const [index, decision] of trace.contract.requirement.decisions.entries()) {
    contractLines.push(`- **Decision ${index + 1}:** ${markdownText(decision.statement)}${decision.rationale ? ` — ${markdownText(decision.rationale)}` : ""}`);
    for (const line of decisionDetailLines(decision)) contractLines.push(`  - ${markdownText(line)}`);
  }
  for (const [index, question] of (trace.contract.requirement.open_questions ?? []).entries()) {
    contractLines.push(`- **Open question ${index + 1} (${question.blocking ? "blocking" : "non-blocking"}):** ${markdownText(question.question)}`);
    if (question.assumption) contractLines.push(`  - Assumption: ${markdownText(question.assumption)}`);
  }
  contractLines.push("", `Issue \`${trace.contract.issue.id}\` v${trace.contract.issue.version}: ${markdownText(trace.contract.issue.summary)}`);
  if (trace.contract.issue.context !== undefined) contractLines.push("", "### Issue context", "", ...markdownQuote(trace.contract.issue.context));
  for (const target of targets) {
    contractLines.push("", `- **${target.type === "goal" ? "Goal" : "Constraint"}:** ${markdownText(target.statement)}`);
    if ("rationale" in target && target.rationale) contractLines.push(`  - Constraint rationale: ${markdownText(target.rationale)}`);
    for (const intent of intentLabel(target)) contractLines.push(`  - Intent Link: ${intent} *(derived relation)*`);
    if (!(target.traces_to ?? []).length) contractLines.push("  - Intent Link: none recorded");
    for (const criterion of target.criteria) contractLines.push(`  - Criterion: ${markdownText(criterion.statement)} (\`${criterion.id}\`)`);
    for (const guidance of target.guidance) contractLines.push(`  - Guidance: ${markdownText(guidance)}`);
  }

  const claimLines: string[] = [];
  for (const claim of trace.submission.claims) {
    const target = targetByID.get(claim.target_id);
    claimLines.push(`### ${claim.target_type === "goal" ? "Goal" : "Constraint"}: ${markdownText(target?.statement ?? claim.target_id)}`, "", ...markdownQuote(claim.explanation));
    claimLines.push(`Self-verification counts [author]: ${markdownCode(JSON.stringify(summarizeSelfVerification(claim.criteria)))}`);
    for (const criterion of claim.criteria) {
      const resolved = criterionByID.get(criterion.criterion_id);
      claimLines.push("", `- **Criterion:** ${markdownText(resolved?.criterion.statement ?? criterion.criterion_id)} (\`${criterion.criterion_id}\`)`, `  - Author explanation: ${markdownText(criterion.explanation)}`);
      for (const line of selfVerificationLines(criterion)) claimLines.push(`  - ${markdownText(line)}`);
      if (!criterion.evidence.length) claimLines.push("  - Evidence: none recorded");
      else for (const evidence of criterion.evidence) appendMarkdownEvidence(claimLines, evidence, "Evidence");
    }
  }

  const verificationLines = [`Complete set: **${trace.verification_set.count}**; standing: **${markdownText(trace.verification_set.standing)}**; digest: \`${trace.verification_set.digest}\`.`];
  if (!trace.verification_set.count) verificationLines.push("", "No independent Verification is recorded.");
  for (const verification of reports) verificationLines.push(renderReviewVerification(trace, verification));

  const provenanceLines = [
    `- Candidate: \`${trace.candidate.candidate_id}\``,
    `- DevRun: \`${trace.candidate.dev_run_id}\``,
    `- Submitted by: ${markdownText(actor(trace.candidate.attribution))} at ${markdownText(trace.candidate.created_at)}`,
    `- Repository: \`${trace.repository.id}\` — ${markdownText(trace.repository.canonical_remote_at_submission)}`,
    `- Baseline: \`${trace.baseline.git_oid}\` (${trace.baseline.reachability})`,
    ...(trace.artifact.base_commit ? [`- Candidate base: \`${trace.artifact.base_commit}\``] : []),
    ...(trace.baseline.warning ? [`- Baseline warning: ${markdownText(trace.baseline.warning)}`] : []),
    ...(trace.baseline.override_reason ? [`- Baseline override reason: ${markdownText(trace.baseline.override_reason)}`] : []),
    `- Artifact format: \`${trace.artifact.format}\``,
    `- Result tree: \`${trace.artifact.result_tree_oid}\``,
    `- Patch digest: \`${trace.artifact.patch_digest}\``,
    `- Artifact size: ${trace.artifact.uncompressed_size} bytes`,
    `- CandidateSubmission format: \`${trace.submission.format}\``,
    `- Change Index format: \`${trace.change_index.format}\``,
    `- Change Index patch digest: \`${trace.change_index.patch_digest}\``,
    `- Change Index units digest: \`${trace.change_index.units_digest}\``,
    `- Verification-set digest: \`${trace.verification_set.digest}\``,
    `- Change Rationale coverage: ${coverage.explained_change_units}/${coverage.total_change_units} Change Units (**${coverage.status}**)`,
  ];
  if (trace.candidate.exploration_brief) provenanceLines.push(`- Exploration brief: ${markdownText(trace.candidate.exploration_brief)}`);
  if (trace.candidate.refines_candidate_id) provenanceLines.push(`- Refines Candidate: \`${trace.candidate.refines_candidate_id}\``);
  if (coverage.unexplained_change_unit_ids.length) provenanceLines.push(`- Unexplained Change Units: ${coverage.unexplained_change_unit_ids.map((id) => `\`${id}\``).join(", ")}`);
  provenanceLines.push("", "Contract and Artifact fields are ledger facts. Purpose, claims, evidence, alternatives, and risks are author claims. Location, Intent Link joins, coverage, and standing are derived relations. Verification conclusions are verifier findings.");

  // Keep the original, lossless overview in details. Previews are built from
  // whole Markdown blocks, never by cutting a rendered document or code span.
  if (trace.upstream_changes) lines.push(...upstreamLines(trace.upstream_changes));
  if (trace.sync_records) lines.push(...syncLines(trace.sync_records));
  const fullOverview = [...lines];
  const excerpt = (value: string): string => {
    const characters = [...value.replace(/\r?\n/g, " ")];
    return markdownText(characters.slice(0, 240).join(""))
      + (characters.length > 240 ? " … *(原文节选，完整内容见详情)*" : "");
  };
  const previewCode = (value: string): string => [...value].length <= 240 && !/[\r\n]/.test(value)
    ? markdownCode(value) : excerpt(value) + " *(path preview)*";
  lines.length = 0;
  lines.push(`# Grounds Review — ${excerpt(trace.contract.issue.summary)}`, "");
  if (trace.location) {
    const location = trace.location;
    lines.push(`- Location: ${previewCode(`${location.requested_path}${location.line === undefined ? "" : `:${location.line}`}`)} (${location.side} side)`);
    if (location.line_status) lines.push(`- Line status: **${location.line_status}${location.line_status === "context" ? " — this line is unchanged inside a changed hunk" : ""}** *(derived relation)*`);
    lines.push(`- Match: ${location.match} *(derived relation)*`, "");
  }
  lines.push("## Review at a glance", "", "| Signal | Result | Source |", "| --- | --- | --- |",
    `| Purpose | ${excerpt(trace.submission.explanation)} | author claim |`,
    `| Standing | **${trace.candidate.standing}** | derived relation |`,
    `| Verification | ${verificationSummary}; complete-set standing **${trace.verification_set.standing}** | verifier findings + derived relation |`,
    `| Scope | ${trace.artifact.file_manifest.length} changed files; ${trace.change_index.change_units.length} Change Units | ledger fact + derived relation |`,
    `| Rationale coverage | ${coverage.explained_change_units}/${coverage.total_change_units} (**${coverage.status}**) | derived relation |`,
    `| Recorded risks | ${risks.length ? `${risks.length} recorded; see details` : "none recorded (not proof of no risk)"} | author claim |`);
  if (warnings.length) lines.push("", "## Review warnings", "", ...warnings.map((warning) => `- ${markdownText(warning)}`));
  if (trace.location && !scopedUnits.length) lines.push("- No exact Change Unit is attached to this scope; line-specific rationale and upstream intent are **unknown**.");
  const pathBlocks = trace.artifact.file_manifest.slice(0, 3).map((file) =>
    [`| Changed areas | ${previewCode(file.display_path).replace(/\|/g, "\\|")} | ledger fact |`]);
  const intentBlocks = relevantTargets.slice(0, 2).map((target) => {
    const links = (target.traces_to ?? []).map((link) => `${link.type}-${link.ordinal}: ${link.type === "outcome" ? trace.contract.requirement.outcomes[link.ordinal - 1] : trace.contract.requirement.decisions[link.ordinal - 1]?.statement}`).join("; ");
    return [`- ${target.type}: ${excerpt(target.statement)} *(ledger fact)*`, `  - Upstream intent *(via this ${target.type}; derived relation)*: ${links ? excerpt(links) : "no recorded Intent Link"}`];
  });
  const rationaleBlocks = scopedRationales.slice(0, 3).map((rationale) => {
    const unit = unitByID.get(rationale.change_refs[0]);
    const label = unit && !/[\r\n]/.test(unit.display_path) && [...unit.display_path].length <= 240 && (!unit.old_path_bytes || Buffer.from(unit.old_path_bytes, "base64").length <= 240)
      ? unitLabel(unit, scopedSide) : "Change Unit (full path in details)";
    const criterion = criterionByID.get(rationale.target_refs[0]?.id)?.criterion.statement;
    return [`- ${label} — ${excerpt(rationale.rationale)} *(${rationale.relation}; author claim)*`,
      ...(criterion ? [`  - Serves: ${excerpt(criterion)}`] : []),
      ...(rationale.risks.length ? [`  - Risks: ${excerpt(rationale.risks[0])}`] : []),
      `  - Full record: ${rationale.change_refs.length} Change Units, ${rationale.target_refs.length} Criteria, ${rationale.risks.length} risks.`];
  });
  const preview = renderMarkdownPreview(lines, [
    { header: ["", "| Area | Path | Source |", "| --- | --- | --- |"], blocks: pathBlocks, total: trace.artifact.file_manifest.length, label: "paths" },
    { header: ["", "## Intent connected to these changes", "", ...(relevantTargets.length ? [] : ["Upstream intent is **unknown** for this scope."])], blocks: intentBlocks, total: relevantTargets.length, label: "intent groups" },
    { header: ["", "## Changes and why", "", ...(scopedRationales.length ? [] : [`No author Change Rationale is recorded for this scope (**${trace.location?.rationale_coverage.status ?? coverage.status}**).`])], blocks: rationaleBlocks, total: scopedRationales.length, label: "rationale records" },
  ]);
  lines.length = 0;
  lines.push(...preview);
  const appendDetails = (title: string, body: string[]): void => {
    lines.push("");
    for (const line of markdownDetails(title, body)) lines.push(line);
  };
  appendDetails("Full review overview and locations", fullOverview);
  appendDetails("Full Change Rationale records", rationaleDetailLines.length ? rationaleDetailLines : ["No author Change Rationale is recorded for this scope."]);
  appendDetails("Full historical contract", contractLines);
  appendDetails("Author claims and evidence", claimLines.length ? claimLines : ["No author claims are recorded."]);
  // Plan is non-normative and belongs with the contract, under the same notice
  // the review page and the plain-text output show.
  if (issuePlan) {
    lines.push("", "## 方案说明（非约束）", "", `> ${markdownText(PLAN_NOTICE_TEXT)}`, "", ...issuePlan.split("\n").map((line) => `${line}`));
  }
  const before = lines.join("\n") + "\n\n<details>\n<summary>Complete independent verification</summary>\n\n";
  lines.length = 0;
  appendDetails("Provenance and immutable references", provenanceLines);
  if (trace.artifact.patch_state !== "not_requested") {
    const diffLines = trace.artifact.patch_state === "inline"
      ? markdownFence(trace.artifact.patch!, "diff")
      : [`Unified diff is **${trace.artifact.patch_state}**.`];
    appendDetails("Unified diff", diffLines);
  }
  return { before, reports: verificationLines.join("\n"), after: "\n\n</details>\n" + lines.join("\n") };
};

export const renderReviewMarkdown = (result: ReviewTraceResult): string => {
  const parts = reviewMarkdownParts(result);
  return parts.before + parts.reports + parts.after;
};

export const renderReviewSummaryMarkdownParts = (result: ReviewSummaryResult): { before: string; after: string } => {
  const parts = reviewMarkdownParts(result);
  return { before: parts.before + parts.reports, after: parts.after };
};

export const renderReviewSummary = (result: ReviewSummaryResult): string => {
  const trace = result.trace;
  return [`Candidate ${trace.candidate.candidate_id}`, `Issue ${trace.contract.issue.id} v${trace.contract.issue.version}: ${trace.contract.issue.summary}`, `Purpose [author claim]: ${trace.submission.explanation}`, `Standing: ${trace.verification_set.standing}`, `Verification summary: ${trace.verification_set.count}; ${JSON.stringify(trace.verification_set.verdict_counts)}`, `Set digest: ${trace.verification_set.digest}`, "Report bodies are not included; use verification list --paged and verification show.", ...(trace.location ? [`Location: ${trace.location.requested_path}; ${trace.location.line_status ?? trace.location.match}`] : [])].join("\n");
};
