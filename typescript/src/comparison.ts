import { canonicalBytes, sha256Bytes } from "./canonical-json.js";
import type { Attribution, CandidateFile } from "./domain.js";
import { DomainError } from "./errors.js";

export const MAX_INLINE_DIFF_BYTES = 1024 * 1024;
export const MAX_COMPARISON_BYTES = 8 * 1024 * 1024;

export interface DiffStats { files: number; insertions: number; deletions: number }
export interface ComparisonVerificationSummary { verification_id: string; overall_verdict: string; created_at: string; attribution: Attribution }
export interface TextPreview { digest: string; preview: string; truncated: boolean }

export interface ComparisonCandidate {
  base_commit: string;
  candidate_id: string;
  dev_run_id: string;
  exploration_brief?: string;
  refines_candidate_id?: string;
  submission_explanation: TextPreview;
  attribution: Attribution;
  created_at: string;
  standing: string;
  is_selected: boolean;
  result_tree_oid: string;
  equivalence_group: string;
  patch_digest: string;
  patch_state: "inline" | "not_requested" | "omitted_size" | "binary";
  patch?: string;
  diff_from_baseline: DiffStats;
  manifest_digest: string;
  changed_files_count: number;
  changed_files: CandidateFile[];
  changed_files_omitted: boolean;
  claims: unknown[];
  verification_count: number;
  verification_digest: string;
  verification_summaries: ComparisonVerificationSummary[];
  verification_summaries_omitted: boolean;
}

export interface UpstreamChanges {
  source: "derived_relation";
  role: "base_changes_not_candidate_changes";
  left_base_commit: string;
  right_base_commit: string;
  status: "available" | "unavailable";
  diff?: { diff_digest: string; stats: DiffStats; diff_state: "inline" | "not_requested" | "omitted_size" | "binary"; unified_diff?: string };
}

export interface PairwiseCandidateDiff {
  /** Present when the result-tree comparison also contains different upstream bases. */
  upstream_changes?: UpstreamChanges;
  left_candidate_id: string;
  right_candidate_id: string;
  equivalent: boolean;
  diff_digest: string;
  stats: DiffStats;
  diff_state: "inline" | "not_requested" | "omitted_size" | "binary";
  unified_diff?: string;
}

export interface CandidateComparisonResult {
  result_type: string;
  command: string;
  issue: { id: string; version: number };
  baseline_oid: string;
  candidates: ComparisonCandidate[];
  pairwise_diffs: PairwiseCandidateDiff[];
}

export interface CandidateComparisonSummaryResult {
  result_type: "patchledger.result.candidate-comparison-summary/v1";
  command: "candidate.compare";
  issue: { id: string; version: number };
  baseline_oid: string;
  candidates: Omit<ComparisonCandidate, "patch_state" | "patch" | "diff_from_baseline">[];
}

const validUTF8 = (patch: Buffer): boolean =>
  // Buffer's UTF-8 decoder replaces malformed sequences with U+FFFD.  A
  // round-trip keeps that character when it was genuinely present in a text
  // patch, while malformed bytes fail the equality check.
  Buffer.from(patch.toString("utf8"), "utf8").equals(patch);

export const patchIsBinary = (patch: Buffer): boolean =>
  patch.includes(Buffer.from("GIT binary patch\n")) ||
  patch.includes(Buffer.from("Binary files ")) ||
  !validUTF8(patch);

export const inlinePatch = (patch: Buffer, requested: boolean): Pick<ComparisonCandidate, "patch_state" | "patch"> => {
  if (!requested) return { patch_state: "not_requested" };
  if (patchIsBinary(patch)) return { patch_state: "binary" };
  if (patch.length > MAX_INLINE_DIFF_BYTES) return { patch_state: "omitted_size" };
  return { patch_state: "inline", patch: patch.toString("utf8") };
};

export const inlineTreeDiff = (
  leftCandidateId: string,
  rightCandidateId: string,
  equivalent: boolean,
  patch: Buffer,
  stats: DiffStats,
  binary: boolean,
  digest?: string,
  tooLarge = false,
): PairwiseCandidateDiff => {
  const base = {
    left_candidate_id: leftCandidateId,
    right_candidate_id: rightCandidateId,
    equivalent,
    diff_digest: digest ?? sha256Bytes(patch),
    stats,
  };
  if (binary || patchIsBinary(patch)) return { ...base, diff_state: "binary" };
  if (tooLarge || patch.length > MAX_INLINE_DIFF_BYTES) return { ...base, diff_state: "omitted_size" };
  return { ...base, diff_state: "inline", unified_diff: patch.toString("utf8") };
};

export const enforceComparisonSize = (result: CandidateComparisonResult): CandidateComparisonResult => {
  const bounded: CandidateComparisonResult = {
    ...result,
    candidates: result.candidates.map((candidate) => ({ ...candidate })),
    pairwise_diffs: result.pairwise_diffs.map((diff) => ({ ...diff,
      ...(diff.upstream_changes ? { upstream_changes: { ...diff.upstream_changes, ...(diff.upstream_changes.diff ? { diff: { ...diff.upstream_changes.diff } } : {}) } } : {}),
    })),
  };
  if (canonicalBytes(bounded).length <= MAX_COMPARISON_BYTES) return bounded;

  // Preserve deterministic prefixes. Later requested payloads are omitted
  // first, and their full digest remains available to the caller.
  for (let index = bounded.pairwise_diffs.length - 1; index >= 0; index -= 1) {
    const diff = bounded.pairwise_diffs[index];
    if (diff.upstream_changes?.diff?.diff_state === "inline") {
      diff.upstream_changes.diff.diff_state = "omitted_size";
      delete diff.upstream_changes.diff.unified_diff;
      if (canonicalBytes(bounded).length <= MAX_COMPARISON_BYTES) return bounded;
    }
    if (diff.diff_state !== "inline") continue;
    bounded.pairwise_diffs[index] = { ...diff, diff_state: "omitted_size", unified_diff: undefined };
    delete bounded.pairwise_diffs[index].unified_diff;
    if (canonicalBytes(bounded).length <= MAX_COMPARISON_BYTES) return bounded;
  }
  for (let index = bounded.candidates.length - 1; index >= 0; index -= 1) {
    const candidate = bounded.candidates[index];
    if (candidate.patch_state !== "inline") continue;
    bounded.candidates[index] = { ...candidate, patch_state: "omitted_size", patch: undefined };
    delete bounded.candidates[index].patch;
    if (canonicalBytes(bounded).length <= MAX_COMPARISON_BYTES) return bounded;
  }
  throw new DomainError("ARTIFACT_TOO_LARGE", "Candidate comparison metadata exceeds 8 MiB", false, { reason: "bounded comparison cannot fit the versioned query contract" });
};
