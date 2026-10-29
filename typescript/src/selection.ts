import type { Attribution } from "./domain.js";
import type { VerificationSetSummary } from "./review.js";

/** Mutable decision; never part of the immutable Candidate or blind subject. */
export interface SelectionRecord {
  id: string;
  issue_revision_id: string;
  version: number;
  candidate_id?: string;
  updated_at: string;
  attribution: Attribution;
  reason?: string;
  verification_at_selection?: VerificationSetSummary;
}
export interface SelectionView extends Omit<SelectionRecord, "issue_revision_id" | "id" | "updated_at" | "attribution"> {
  id?: string;
  updated_at?: string;
  attribution?: Attribution;
  state: "selected" | "unselected";
  current_verification?: VerificationSetSummary;
  verification_changed: boolean;
  warnings: { code: string; message: string }[];
}
export interface SelectionResult {
  result_type: "patchledger.result.selection/v1";
  command: "selection.show" | "selection.set" | "selection.clear";
  issue: { id: string; version: number };
  selection: SelectionView;
}
export interface SelectionWriteCommand {
  operation_id: string;
  issue_id: string;
  issue_version: number;
  expected_version: number;
  candidate_id?: string;
  attribution: Attribution;
  reason?: string;
}
export interface DeliveryReceipt {
  format: "patchledger.delivery-worktree/v1" | "grounds.delivery-worktree/v2";
  source_commit?: string;
  observed_target_commit?: string;
  delivery_decision_id?: string;
  database_id: string;
  issue: { id: string; version: number };
  selection_id: string;
  selection_version: number;
  candidate_id: string;
  repository_id: string;
  baseline_oid: string;
  patch_digest: string;
  result_tree_oid: string;
}

/** Validate stored snapshots before exposing them as decision-time evidence. */
export const validSelectionSnapshot = (value: unknown): value is VerificationSetSummary => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as VerificationSetSummary;
  if (Object.keys(v).sort().join(",") !== "count,digest,reports_included,source,standing,verdict_counts") return false;
  if (v.source !== "derived_relation" || v.reports_included !== false || typeof v.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(v.digest)) return false;
  if (!Number.isSafeInteger(v.count) || v.count < 0 || !v.verdict_counts || typeof v.verdict_counts !== "object") return false;
  if (Object.keys(v.verdict_counts).sort().join(",") !== "inconclusive,qualified,rejected") return false;
  const { qualified, rejected, inconclusive } = v.verdict_counts;
  if (![qualified, rejected, inconclusive].every(n => Number.isSafeInteger(n) && n >= 0) || qualified + rejected + inconclusive !== v.count) return false;
  const standing = v.count === 0 ? "unverified" : qualified > 0 && rejected > 0 ? "disputed" : qualified > 0 ? "qualified" : rejected > 0 ? "rejected" : "inconclusive";
  return v.standing === standing;
};
