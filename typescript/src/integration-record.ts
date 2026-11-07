import type { Attribution, TargetBranch } from "./domain.js";
import type { DegradedMergeBinding, GateInput, GateDecision, LandingDecision, LandingSource } from "./integration-gate.js";
import type { LandingTargetPredecessor } from "./integration-history.js";
import type { BranchObservation } from "./integration-observation.js";
import type { VerificationSetSummary } from "./review.js";

export interface AdoptionBinding {
  format: "grounds.adoption-binding/v1";
  repository_id: string; candidate_id: string; source_commit: string; landed_commit: string;
  target: TargetBranch; method: "ff" | "merge" | "squash";
  /** Actual target ref value before the claimed update, bound to the same adoption source. */
  target_predecessor?: string;
  source: { kind: "user_confirmation" | "merged_mr"; reference: string };
}
export interface GateRequest { candidate_id: string; selection_id: string; selection_version: number; source: TargetBranch; source_commit: string; refresh: boolean }
export interface IntegrationVerification {
  candidate_id: string;
  selection: { id?: string; version: number; candidate_id?: string };
  current_verification: VerificationSetSummary;
  at_selection?: VerificationSetSummary;
  verification_changed: boolean | null;
}
export interface GateObservation {
  request: GateRequest;
  input: GateInput;
  decision: GateDecision;
  target_observation: BranchObservation;
  source_observation: BranchObservation;
  verification: IntegrationVerification;
}
export interface IntegrationRecord {
  id: string;
  kind: "gate" | "authorization" | "consumption" | "landing";
  candidate_id: string;
  created_at: string;
  attribution: Attribution;
  gate?: GateObservation;
  based_on?: string;
  binding?: DegradedMergeBinding;
  reason?: string;
  disclosure?: "landed_code_is_unverified";
  landing?: { target_predecessor?: LandingTargetPredecessor; actual_landing?: import("./integration-gate.js").CommitIdentity; adoption?: AdoptionBinding; history_sensitive_verification?: "requires_landing_context" | "candidate_context" | "unknown"; provenance?: LandingSource; supplied_commit?: string; delivery_link_eligibility: "eligible" | "no_supported_text_changes" | "not_exact_artifact"; target_observation: BranchObservation; decision: LandingDecision; verification: IntegrationVerification };
}
