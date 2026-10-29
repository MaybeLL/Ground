import { validation } from "./errors.js";

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

const sameSelection = (a: SelectionIdentity, b: SelectionIdentity): boolean =>
  a.id === b.id && a.version === b.version && a.candidate_id === b.candidate_id;

/** No Verification inputs: matching an artifact must never imply it was verified. */
export function evaluateIntegrationGate(input: GateInput): GateDecision {
  const { artifact, target, source, current_selection: current, expected_selection: expected } = input;
  const checks: GateDecision["checks"] = {
    target: !target || target.relation === "unknown" ? "unknown"
      : target.oid === artifact.base_commit && target.relation === "equal" ? "pass" : "fail",
    source: !source ? "unknown" : source.oid !== input.expected_source || source.tree_oid !== artifact.result_tree_oid ? "fail"
      : artifact.source_commit ? source.oid !== artifact.source_commit ? "fail" : input.source_contains_base === undefined ? "unknown" : input.source_contains_base ? "pass" : "fail"
      : source.parents.length === 1 && source.parents[0] === artifact.base_commit ? "pass" : "fail",
    selection: current === undefined ? "unknown" : current !== null && sameSelection(current, expected)
      && current.candidate_id === artifact.candidate_id ? "pass" : "fail",
  };
  // Offline observations never authorize a merge, even if all cached values match.
  if (!input.refreshed) return { consistency: "unknown", checks };
  // An independently known failure cannot be hidden by a missing observation.
  if (checks.source === "fail" || checks.selection === "fail"
    || (checks.target === "fail" && (target?.relation !== "advanced" || target.oid === artifact.base_commit))) {
    return { consistency: "inconsistent", checks };
  }
  if (Object.values(checks).includes("unknown")) return { consistency: "unknown", checks };
  return { consistency: checks.target === "pass" ? "ready" : "expired", checks };
}

export interface DegradedMergeBinding {
  candidate_id: string;
  selection: SelectionIdentity;
  source_commit: string;
  target_commit: string;
}

/** An authorization can waive only a forward-advanced target, never another failure. */
export function bindDegradedMerge(input: GateInput): DegradedMergeBinding {
  if ((evaluateIntegrationGate(input).consistency !== "expired" && !(input.artifact.source_commit && evaluateIntegrationGate(input).consistency === "ready")) || !input.target) {
    throw validation("degraded_merge", "only a refreshed ready or solely forward-expired gate can be authorized");
  }
  return {
    candidate_id: input.artifact.candidate_id,
    selection: { ...input.expected_selection },
    source_commit: input.expected_source,
    target_commit: input.target.oid,
  };
}

/** Recheck immediately before the separately authorized merge; it is not an atomic remote gate. */
export function degradedMergeBindingMatches(binding: DegradedMergeBinding, input: GateInput): boolean {
  if ((evaluateIntegrationGate(input).consistency !== "expired" && !(input.artifact.source_commit && evaluateIntegrationGate(input).consistency === "ready")) || !input.target) return false;
  return binding.candidate_id === input.artifact.candidate_id
    && sameSelection(binding.selection, input.expected_selection)
    && binding.source_commit === input.expected_source && binding.target_commit === input.target.oid;
}

export type LandingSource = "target_is_source" | "merge_result" | "user";
export interface LandingInput {
  artifact: ArtifactIdentity;
  expected_source: string;
  target_commit: string;
  /** Absent provenance means no adoption claim, regardless of parent/tree equality. */
  provenance?: LandingSource;
  landed?: CommitIdentity;
  on_first_parent: boolean;
  /** When the supplied commit is only a merge side parent, report its actual first-parent entry. */
  first_parent_landing?: CommitIdentity;
  adoption_bound?: boolean;
  has_supported_text_changes: boolean;
}
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

export function evaluateLanding(input: LandingInput): LandingDecision {
  const landed = input.landed;
  const trusted = !!landed && !!input.provenance && input.on_first_parent && (!input.artifact.source_commit || input.adoption_bound === true)
    && (input.provenance !== "target_is_source" || (landed.oid === input.target_commit && landed.oid === input.expected_source));
  const decision: LandingDecision = {
    identity: trusted ? "trusted" : "unknown",
    shape: !landed ? "unknown" : landed.parents.length === 1 ? "single_parent" : landed.parents.length > 1 ? "merge" : "root",
    parent_matches: landed ? landed.parents.length === 1 && landed.parents[0] === input.artifact.base_commit : null,
    tree_matches: landed ? landed.tree_oid === input.artifact.result_tree_oid : null,
    outcome: "adoption_unknown",
    ...(!input.on_first_parent && input.first_parent_landing ? { first_parent_landing: input.first_parent_landing } : {}),
  };
  if (input.artifact.source_commit) {
    decision.source_matches = !!landed && landed.oid === input.artifact.source_commit;
    decision.code_consistency = !landed ? "unknown" : decision.tree_matches ? "candidate_tree" : "different_tree";
    if (!trusted || !landed) return decision;
    decision.outcome = !decision.tree_matches ? "different_artifact" : decision.source_matches ? "exact_artifact" : "same_content_different_history";
    // Adoption and text-hunk mapping are distinct. Only the legacy mapping
    // shape can produce a DeliveryLink, even when a multi-commit FF is adopted.
    if (decision.outcome === "exact_artifact" && decision.parent_matches && input.has_supported_text_changes) decision.delivery_link_commit = landed.oid;
    return decision;
  }
  if (!trusted || !landed) return decision;
  if (decision.shape === "merge") decision.outcome = "merge_landing";
  else if (!decision.tree_matches) decision.outcome = "different_artifact";
  else if (!decision.parent_matches) decision.outcome = "same_content_different_base";
  else {
    decision.outcome = "exact_artifact";
    if (input.has_supported_text_changes) decision.delivery_link_commit = landed.oid;
  }
  return decision;
}
