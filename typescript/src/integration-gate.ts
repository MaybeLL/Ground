
/** Internal decision model. Collecting and persisting observations belongs to the caller. */
export interface ArtifactIdentity {
  candidate_id: string;
  source_commit?: string;
  base_commit: string;
  result_tree_oid: string;
}
export interface SelectionIdentity { id: string; version: number; candidate_id: string }
export interface CommitIdentity { oid: string; parents: string[]; tree_oid: string }
export type TargetRelation = "equal" | "advanced" | "rewritten" | "unknown";
export type Check = "pass" | "fail" | "unknown";
export interface GateInput {
  artifact: ArtifactIdentity;
  expected_selection: SelectionIdentity;
  current_selection: SelectionIdentity | null | undefined;
  expected_source: string;
  source: CommitIdentity | undefined;
  source_contains_base?: boolean;
  target: { oid: string; relation: TargetRelation } | undefined;
  /** Both source and target must come from this explicit refresh, not cached refs. */
  refreshed: boolean;
}
export interface GateDecision {
  consistency: "ready" | "expired" | "inconsistent" | "unknown";
  checks: { target: Check; source: Check; selection: Check };
}

export interface DegradedMergeBinding {
  candidate_id: string;
  selection: SelectionIdentity;
  source_commit: string;
  target_commit: string;
}

/** An authorization can waive only a forward-advanced target, never another failure. */
export type LandingSource = "target_is_source" | "merge_result" | "user";
export interface LandingDecision {
  identity: "trusted" | "unknown";
  shape: "single_parent" | "merge" | "root" | "unknown";
  parent_matches: boolean | null;
  tree_matches: boolean | null;
  outcome: "exact_artifact" | "same_content_different_history" | "same_content_different_base" | "different_artifact" | "merge_landing" | "adoption_unknown";
  source_matches?: boolean;
  code_consistency?: "candidate_tree" | "different_tree" | "unknown";
  delivery_link_commit?: string;
  first_parent_landing?: CommitIdentity;
}
