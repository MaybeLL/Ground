import type { Attribution, TargetBranch } from "./domain.js";
import type { BranchObservation } from "./integration-observation.js";
import type { PreflightRunInputs } from "./preflight-inputs.js";

export const OBSERVATION_FORMAT = "grounds.preflight-observation/v1";
export const ASSESSMENT_FORMAT = "grounds.preflight-assessment/v1";
export type PreflightPhase = "definition" | "publish" | "start";
export type PreflightAssessment = "applicable" | "revision_required" | "unknown";
export interface PreflightActor { operation_id: string; attribution: Attribution }
export interface PreflightObservationBinds extends Partial<PreflightRunInputs> {
  repository_id?: string;
  canonical_remote: string;
  issue_id?: string;
  issue_version?: number;
  issue_revision_id?: string;
  scope_digest?: string;
  content_digest?: string;
}
export interface PreflightObservationData {
  format: typeof OBSERVATION_FORMAT;
  phase: PreflightPhase;
  observed_at: string;
  target: TargetBranch;
  tracking_ref: string;
  observation: Omit<BranchObservation, "branch">;
  definition_reference?: { commit_oid: string };
  binds: PreflightObservationBinds;
  attribution: Attribution;
}
export interface PreflightAssessmentData {
  format: typeof ASSESSMENT_FORMAT;
  observation_id: string;
  assessment: PreflightAssessment;
  author: Attribution;
  rationale: string;
  affected: { target_type: string; target_id: string; criterion_id?: string; note: string }[];
  assessed_at: string;
  assessment_seq?: number;
  binds: PreflightObservationBinds;
  target_commit?: string;
}
export interface ObserveInput extends PreflightActor {
  phase: PreflightPhase;
  refresh: boolean;
  repository_id?: string;
  canonical_remote?: string;
  issue_id?: string;
  issue_revision_id?: string;
  dev_run_id?: string;
  definition_commit?: string;
  target?: TargetBranch;
  scope_digest?: string;
  content_digest?: string;
}
export interface AssessInput extends PreflightActor {
  observation_id: string;
  file: { assessment: string; author?: Attribution; rationale: string; affected?: unknown[] };
}
export interface AdmitInput extends PreflightActor {
  dev_run_id: string;
  assessment_id: string;
  refresh: boolean;
  expected_version?: number;
  expected_head?: string;
}
export interface PublishGateInput {
  repository_id?: string;
  canonical_remote?: string;
  reviewed_version?: string;
  content_digest?: string;
  target?: TargetBranch;
  what: string;
  operation_id?: string;
}
export interface StartGateInput {
  issue_revision_id: string;
  repository_id: string;
  expected_commit: string;
  what: string;
  operation_id?: string;
}
export interface PreflightMatch { observation_id: string; assessment_id: string; target_commit: string; checked_at?: string }
export interface PreflightCoordinator {
  publish(input: PublishGateInput): Promise<PreflightMatch>;
  start(input: StartGateInput): Promise<PreflightMatch>;
}
export interface PreflightAdmissionData {
  format: "grounds.preflight-admission/v1";
  dev_run_id: string;
  issue_revision_id?: string;
  observation_id: string;
  assessment_id: string;
  assessment: PreflightAssessment;
  target_commit: string;
  base_commit: string;
  definition_commit?: string;
  transition_seq?: number;
  input_binding?: PreflightRunInputs;
  admitted_at: string;
  attribution: Attribution;
}
export interface PreflightPreparationData {
  format: "grounds.preflight-preparation/v1";
  dev_run_id: string;
  transition_seq?: number;
  prepared_at: string;
  attribution: Attribution;
}
export interface DevRunPreflight {
  state: "missing" | "preparing" | "admitted";
  code: string;
  summary: string;
  blocking: { code: string; detail?: string; affected?: unknown }[];
  required_inputs: { repository_id: string; issue_id: string; issue_version: number; target: TargetBranch; base_commit: string; observed_commit?: string };
  next_commands: string[];
  observation?: { observation_id: string; target_commit: string; observed_at: string };
  assessment?: { assessment_id: string; assessment: PreflightAssessment; author: Attribution; rationale: string; assessed_at: string };
  assessment_hint?: string;
  admission?: { admitted_at: string; target_commit: string; base_commit: string };
}
