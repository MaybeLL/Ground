import { timestampOrderKey } from "./sql-shared.js";
import { encodeVerificationCursor } from "./verification-cursor.js";
import { validateModeSelection } from "./development-mode.js";
import { completionView, completionProgress, completionText, validateCompletionInput, type CompletionInput, type CompletionRecord, type CompletionView, type CompletionResult, type CompletionWriteCommand } from './completion.js';
import { candidateHistoryProjection, type CandidateHistoryProjection } from "./candidate-history.js";
import { GIT_CANDIDATE_ARTIFACT_FORMAT, validateGitArtifactCandidateBinding, type GitCommitArtifact } from "./git-artifact-storage.js";
import { validateDevelopment, validateSourceIdentity } from "./development-branch.js";
import { startDevRunInTransaction, abandonDevRunInTransaction, validateContextSize as contextSize } from './devrun-lifecycle.js';
import { validateDeliveryProof, validateDeliveryLink } from "./delivery-link.js";
import type { SelectionRecord, SelectionView, SelectionResult, SelectionWriteCommand } from "./selection.js";
import { createHash } from "node:crypto";
import { canonicalBytes, sha256, sha256Bytes } from "./canonical-json.js";
import {
  CANDIDATE_ARTIFACT_FORMAT,
  claimRecords,
  manifestDigest,
  type Attribution,
  type Baseline,
  type TargetBranch,
  type Candidate,
  type CandidateArtifact,
  type CandidateFile,
  type CandidateSubmissionInput,
  type CandidateSubmissionV2Input,
  type ClaimInput,
  type Decision,
  type DevRun,
  type IssueInput,
  type IssueRevision,
  type QuickstartInput,
  type RequirementInput,
  type RequirementRevision,
  type Verification,
  type VerificationReportInput,
  validateAttribution,
  validateBaseline,
  validateCandidateSubmission,
  validateIssueIntentLinks,
  validateIssueInput,
  validateOptionalLongText,
  validateQuickstartInput,
  validateRequirementInput,
  validateVerificationReport,
} from "./domain.js";
import { isGitOID, isSha256, isUUIDv7, newUUIDv7 } from "./identity.js";
import { DomainError, idempotencyConflict, notFound, predecessorConflict, repositoryAmbiguous, repositoryIssueLimit, repositoryNotResolved, stateConflict, validation, versionConflict } from "./errors.js";
import type {
  ArtifactBlob,
  CandidateListFilter,
  CandidateListItem,
  DevRunListFilter,
  IssueListFilter,
  VerificationListFilter,
  CandidateRecord,
  DevRunListItem,
  IntegrityReport,
  IssueListItem,
  LedgerEvent,
  Metadata,
  OperationReplay,
  ReadTx,
  RepositoryRecord,
  RequirementAggregateFacts,
  RequirementListItem,
  Resource,
  RevisionRecord,
  Store,
  Tx,
  VerificationRecord,
  VerificationSummaryItem,
} from "./store-types.js";

import { repositoryMatchKey, validateCanonicalRemote } from "./git.js";
import {
  blindContextDigestFor,
  blindContextDigestMatches,
  blindVerificationContextFor,
  issueVersionForContext,
  reconcileVerificationContextFor,
  requirementVersionForContext,
  type CandidateContextSource,
  type IssueVersion,
  type RequirementVersion,
  type VerificationContext,
  type VerificationPhase,
} from "./projections.js";
import {
  enforceComparisonSize,
  inlinePatch,
  inlineTreeDiff,
  patchIsBinary,
  type CandidateComparisonResult,
  type ComparisonCandidate,
  type PairwiseCandidateDiff,
  type TextPreview,
} from "./comparison.js";
import { verificationTemplateFromBlindContext } from "./verification-handoff.js";
import { canonicalQualityReport, combinedVerdict, parseVerificationRole, qualityBlindContextFrom, qualityOverallVerdict, qualityReconcileContextFrom, qualityTemplateFromBlindContext, validateQualityLocations, validateQualityReviewReport, type QualityBlindContext, type QualityReconcileContext, type QualityReviewReportInput, type Verdict, type VerificationMode } from "./quality-review.js";
import { isSyncRecord, syncReview, syncData, syncTerminal } from "./devrun-sync-record.js";
import { locateReviewPath, type ReviewLocationRequest, type ReviewTraceResult, type ReviewSummaryResult, type VerificationPageResult, type VerificationSetSummary } from "./review.js";
import { isPagedRequest, readListPage, withPagingHint, type ListPageInfo, type ListPageRequest } from "./list-page.js";
import { indexCandidateChanges, inspectChangeRationaleBindings, type ChangeIndex } from "./change-index.js";
import { contentDigestFor, enforcePublishGate, enforceStartGate, issueWriteBinding, publishAuthoringBinding, saveAdmission, savePreparation, type PreflightCoordinator, type PreflightMatch, type PublishGateInput } from "./preflight.js";
import { assertDevRunAdmitted } from "./preflight-admission.js";
import { devRunPreflightView } from "./preflight-view.js";

type CheckedPublication = { input: PublishGateInput; match: PreflightMatch };
const publicationPreflightFacts = (checks: CheckedPublication[], target: TargetBranch | undefined, definition: string): Record<string, string> => {
  const checked = checks.find(item => item.input.target?.remote === target?.remote && item.input.target?.ref === target?.ref);
  if (!checked || !target) return {};
  return { preflight_observation_id: checked.match.observation_id, preflight_assessment_id: checked.match.assessment_id,
    preflight_target_commit: checked.match.target_commit, preflight_definition_commit: definition,
    preflight_target_remote: target.remote, preflight_target_ref: target.ref,
    ...(checked.match.checked_at ? { preflight_checked_at: checked.match.checked_at } : {}),
    ...(checked.input.content_digest ? { preflight_content_digest: checked.input.content_digest } : {}),
    ...(checked.input.reviewed_version ? { preflight_reviewed_version: checked.input.reviewed_version } : {}) };
};
export type { CandidateComparisonResult, ComparisonCandidate, PairwiseCandidateDiff, TextPreview } from "./comparison.js";
export type { ReviewLocationRequest, ReviewTraceResult } from "./review.js";

export interface Warning { code: string; message: string }
export interface SuccessEnvelope { format: "patchledger.cli/v1"; ok: true; operation_id?: string; data: unknown; warnings: Warning[] }

export interface RequirementWriteResult { result_type: string; command: string; requirement_id: string; requirement_revision_id: string; revision_number: number }
export interface RepositoryWriteResult { result_type: string; command: string; repository_id: string; version: number; canonical_remote: string }
export interface IssueWriteResult { result_type: string; command: string; requirement_id: string; requirement_revision_id: string; issue_id: string; issue_revision_id: string; revision_number: number; baseline: Baseline }
export interface QuickstartResult { result_type: string; command: string; repository_id: string; repository_version: number; repository_action: "registered" | "resolved"; canonical_remote: string; requirement_id: string; requirement_revision_id: string; requirement_revision_number: number; issue_id: string; issue_revision_id: string; issue_revision_number: number; baseline: Baseline; next_action: "start_devrun" }
export interface ResourceListResult { result_type: string; command: string; resources: Resource[]; query?: Record<string, string | boolean | number>; page?: ListPageInfo; next_cursor?: string }
export interface IssueListOptions { repository_id?: string; status?: string; has_open_dev_run?: boolean; sort?: string }
export interface DevRunListOptions { issue_version?: number; repository_id?: string; state?: string }
export interface CandidateListOptions { repository_id?: string; standing?: string; selected?: boolean }
export interface VerificationListOptions { verdict?: string }
export type VerificationRole = "contract" | "quality";
export interface RepositoryReference { id: string; canonical_remote: string }
export interface CurrentIssueRevisionReference { id: string; revision_number: number; predecessor_revision_id?: string; requirement_revision_id: string; summary: string }
export interface IssueBoard { status: string; next_action: "start_devrun" | "resume_devrun" | "review_candidates" | "prepare_delivery" | null; completion: CompletionView; selection: SelectionView; open_dev_run_count: number; candidate_count: number }
export interface RequirementIssueSummary { issue_id: string; repository: RepositoryReference; baseline: Baseline; current_issue_revision: CurrentIssueRevisionReference; bound_to_selected_revision: boolean; board: IssueBoard }
export interface RequirementAggregates { repository_count: number; issue_count: number; open_dev_run_count: number; candidate_count: number; bound_to_selected_revision_issue_count: number; other_requirement_revision_issue_count: number; completion_status: "completed" | "incomplete" | "no_issues"; completed_issue_count: number; candidate_standing_counts: Record<string, number> }
export interface InternalRequirementDetailResult { result_type: string; command: string; requirement_revision: RequirementRevision; issues: RequirementIssueSummary[]; issues_omitted: boolean; issues_next_cursor?: string; aggregates: RequirementAggregates }
export interface RequirementDetailResult { result_type: string; command: string; requirement: RequirementVersion; issues: { issue: { id: string; version: number; summary: string; requirement: { id: string; version: number } }; repository: RepositoryReference; baseline: Baseline; bound_to_selected_version: boolean; board: IssueBoard }[]; issues_omitted: boolean; issues_next_cursor?: string; aggregates: { repository_count: number; issue_count: number; open_dev_run_count: number; candidate_count: number; bound_to_selected_version_issue_count: number; other_requirement_version_issue_count: number; completion_status: "completed" | "incomplete" | "no_issues"; completed_issue_count: number; candidate_standing_counts: Record<string, number> } }
export interface RepositoryDetailResult { result_type: string; command: string; repository_id: string; version: number; canonical_remote: string; aliases: { remote: string; state: string }[] }
export interface IssueDetailResult { result_type: string; command: string; requirement: RequirementVersion; repository: RepositoryReference; baseline: Baseline; issue: IssueVersion; board: IssueBoard }
export interface InternalIssueDetailResult { result_type: string; command: string; requirement_revision: RequirementRevision; repository: RepositoryReference; baseline: Baseline; issue_revision: IssueRevision; board: IssueBoard }

export interface DevRunContextRun { execution_mode?: DevRun["execution_mode"]; initial_base_commit?: string; artifact_restoration?: DevRun["artifact_restoration"]; development?: import("./development-branch.js").DevelopmentIdentity; id: string; version: number; state: string; exploration_brief?: string }
export interface DevRunContext { preflight?: import("./preflight-types.js").DevRunPreflight; format: string; generated_at: string; dev_run: DevRunContextRun; repository: RepositoryReference; baseline: Baseline; base_commit?: string; snapshot_relation?: import("./integration-history.js").SnapshotRelation; requirement: RequirementVersion; issue: IssueVersion; refinement?: RefinementContext }
export interface RefinementContext { parent_candidate_id: string; parent_result_tree_oid: string; parent_claims: ReturnType<typeof claimRecords>; standing_at_start: string; frozen_verifications: VerificationSummary[]; criterion_standings: { target_type: string; target_id: string; criteria: { criterion_id: string; standing: string }[] }[]; included_verification_reports: { verification_id: string; report: VerificationReportInput; mode: VerificationMode; quality?: { overall_verdict: Verdict; attribution: Attribution; report: QualityReviewReportInput } }[] }
export interface DevRunContextResult { result_type: string; command: string; context: DevRunContext }
export interface DevRunMutationResult { result_type: string; command: string; dev_run_id: string; version: number; state: string }
export interface DevRunDetailResult { execution_mode?: DevRun["execution_mode"]; initial_base_commit?: string; artifact_restoration?: DevRun["artifact_restoration"]; development?: import("./development-branch.js").DevelopmentIdentity; result_type: string; command: string; dev_run_id: string; issue: { id: string; version: number }; version: number; state: string; exploration_brief?: string; refines_candidate_id?: string; abandon_reason?: string; created_at: string; attribution: Attribution }

export interface CandidateSubmitResult { git_artifact?: GitCommitArtifact; source?: import("./development-branch.js").SourceIdentity; result_type: string; command: string; candidate_id: string; dev_run_id: string; issue: { id: string; version: number }; result_tree_oid: string; patch_digest: string; created_at: string }
export interface CandidateTemplateResult { result_type: "patchledger.result.candidate-template/v1"; command: "candidate.template"; dev_run_id: string; change_index?: ChangeIndex; submission: CandidateSubmissionInput }
export interface VerificationSubmitResult { result_type: string; command: string; verification_id: string; candidate_id: string; mode: VerificationMode; overall_verdict: string; standing: string; created_at: string }
export interface VerificationSummary { verification_id: string; overall_verdict: string; created_at: string; attribution: Attribution; mode: VerificationMode; quality_verdict?: Verdict; quality_attribution?: Attribution }
export interface LedgerReconcileFacts {
  pending_sync?: { id: string; phase: string };
  dev_run: { id: string; version: number; state: "open" | "submitted" | "abandoned" };
  issue: { id: string; version: number };
  baseline_oid: string;
  candidate?: { candidate_id: string; result_tree_oid: string; is_selected: boolean };
  selection: { state: "selected" | "unselected"; version: number };
}
export interface CandidateArtifactDescriptor { git_artifact?: GitCommitArtifact; repository_id?: string; source?: import("./development-branch.js").SourceIdentity; candidate_id: string; base_commit: string; base_commit_source: "candidate" | "issue_version_baseline"; patch_digest: string; artifact_format: string; patch_size?: number; result_tree_oid: string }
export interface ReplaySubject {
  candidate_id: string;
  issue: { id: string; version: number };
  repository_id: string;
  registered_remotes: string[];
  base_commit: string;
  patch_digest: string;
  result_tree_oid: string;
  patch: { state: "present"; bytes: Buffer } | { state: "unavailable" } | { state: "missing" } | { state: "corrupt"; reason: string };
}
export interface CandidateDetailResult { result_type: string; command: string; candidate: Partial<CandidateHistoryProjection> & { git_artifact?: GitCommitArtifact; source?: import("./development-branch.js").SourceIdentity; candidate_id: string; dev_run_id: string; issue: { id: string; version: number }; exploration_brief?: string; refines_candidate_id?: string; submission_explanation: string; attribution: Attribution; created_at: string; result_tree_oid: string; patch_digest: string; artifact_format: string; standing: string; is_selected: boolean; file_count: number; manifest_digest: string; file_manifest: CandidateFile[]; file_manifest_omitted: boolean; manifest_next_cursor?: string; claims: ReturnType<typeof claimRecords>; verification_count: number; verification_digest: string; verifications: VerificationSummary[]; verifications_omitted: boolean; verifications_next_cursor?: string } }
export interface VerificationContextResult { result_type: string; command: string; context: VerificationContext | QualityBlindContext | QualityReconcileContext }
export interface VerificationDetailResult { result_type: string; command: string; verification_id: string; candidate_id: string; mode: VerificationMode; overall_verdict: string; created_at: string; attribution: Attribution; report: VerificationReportInput; quality?: { overall_verdict: Verdict; attribution: Attribution; report: QualityReviewReportInput } }
export interface LedgerEventView extends Omit<LedgerEvent, "subject_type" | "facts"> { subject_type: "requirement" | "repository" | "issue" | "dev_run" | "candidate" | "verification" | "delivery_link" | "selection" | "issue_completion" | "eval_grader" | "eval_suite" | "eval_snapshot" | "eval_experiment" | "eval_run" | "eval_execution" | "eval_result" | "eval_notice" | "eval_qa" | "eval_artifact" | "eval_environment" | "eval_envcheck" | "eval_preparation" | "eval_instance"; facts: LedgerEvent["facts"] }
export interface LedgerResult { result_type: string; command: string; events: LedgerEventView[]; next_cursor?: string }
export interface CreateRequirementCommand { operation_id: string; input: RequirementInput; attribution: Attribution }
export interface ReviseRequirementCommand { operation_id: string; requirement_id: string; expected_predecessor_id: string; input: RequirementInput; attribution: Attribution }
export interface RegisterRepositoryCommand { operation_id: string; canonical_remote: string; attribution: Attribution }
export interface MoveRepositoryCommand { operation_id: string; repository_id: string; expected_version: number; canonical_remote: string; attribution: Attribution }
export interface RepositoryAliasCommand { operation_id: string; repository_id: string; expected_version: number; remote: string; attribution: Attribution }
export interface CreateIssueCommand { operation_id: string; requirement_id: string; requirement_revision_id: string; requirement_revision_explicit: boolean; repository_id: string; baseline: Baseline; input: IssueInput; attribution: Attribution }
export interface QuickstartCreateCommand { operation_id: string; canonical_remote: string; baseline: Baseline; input: QuickstartInput; attribution: Attribution }
export interface ReviseIssueCommand { operation_id: string; issue_id: string; expected_predecessor_id: string; requirement_revision_id: string; requirement_revision_explicit: boolean; baseline: Baseline; input: IssueInput; attribution: Attribution }
export interface StartDevRunCommand { execution_mode?: DevRun["execution_mode"]; prepare_only?: boolean; artifact_restoration?: DevRun["artifact_restoration"]; development?: import("./development-branch.js").DevelopmentIdentity; base_commit?: string; operation_id: string; dev_run_id?: string; issue_id: string; issue_revision_id: string; issue_revision_explicit: boolean; repository_remote_snapshot: string; exploration_brief?: string; refines_candidate_id?: string; attribution: Attribution }
export interface AbandonDevRunCommand { operation_id: string; dev_run_id: string; expected_version: number; reason?: string; attribution: Attribution }
export interface SubmitCandidateCommand { candidate_id?: string; git_artifact?: GitCommitArtifact; source?: import("./development-branch.js").SourceIdentity; operation_id: string; dev_run_id: string; expected_version: number; submission: CandidateSubmissionInput; artifact: CandidateArtifact; attribution: Attribution }
export interface CandidateReplayRequest { dev_run_id: string; expected_version: number; submission: CandidateSubmissionInput; attribution: Attribution }
export interface SubmitVerificationCommand { operation_id: string; report: VerificationReportInput; attribution: Attribution; /** Present only for ultra mode: the separately signed quality part. */ quality?: { report: QualityReviewReportInput; attribution: Attribution } }

export interface PairwiseOptions { include_patch_ids?: string[]; pairwise_pairs?: [string, string][] }
export interface ReviewCandidateOptions { include_patch?: boolean; location?: ReviewLocationRequest }
export interface ComparisonTreeDiff { patch: Buffer; files: number; insertions: number; deletions: number; binary: boolean; too_large: boolean }
export type TreeDiffProvider = (leftTree: string, rightTree: string) => Promise<ComparisonTreeDiff>;
export interface CandidateMaterialization { git_artifact?: GitCommitArtifact; source?: import("./development-branch.js").SourceIdentity; candidate_id: string; issue_revision_id: string; repository_id: string; canonical_remote: string; baseline: Baseline; result_tree_oid: string; patch_digest: string; patch: Buffer }

export interface AuthoringRequirementChange { requirement_id?: string; expected_revision_id?: string; require_current?: boolean; input?: RequirementInput }
export interface AuthoringIssueChange { issue_id?: string; expected_revision_id?: string; requirement_revision_id?: string; baseline: Baseline; input: IssueInput }
export interface PublishAuthoringCommand { operation_id: string; canonical_remote: string; requirement: AuthoringRequirementChange; issues: AuthoringIssueChange[]; attribution: Attribution; allow_second_issue_per_repository?: boolean; repository_issue_override_reason?: string; /** The externally reviewed Workspace version a JSON publication binds to. */ reviewed_version?: string }

/** One Requirement may hold only one Issue per Repository.  The ledger enforces
 * the invariant on every publish, so overlapping Issues never reach concurrent
 * DevRuns that would have to be merged by hand outside the ledger. */
export interface IssueRepositoryRuleInput { requirement_id: string; existing: string[]; existing_more: boolean; created_issue_count: number; allow_second_issue_per_repository: boolean; override_reason: string }
const issueRepositoryRule = (input: IssueRepositoryRuleInput): Warning[] => {
  const listed = input.existing.join(", ") + (input.existing_more ? ", …" : "");
  const alternative = "Keep one Issue per Requirement and Repository (express additional features as Goals/Constraints of that Issue), or publish the extra work under a separate Requirement.";
  if (input.created_issue_count > 0 && input.existing.length + input.created_issue_count > 1) {
    const detail = input.existing.length
      ? `Requirement ${input.requirement_id} already has Issue ${listed} on this Repository`
      : `this publication creates ${input.created_issue_count} Issues for one Requirement and one Repository`;
    if (!input.allow_second_issue_per_repository) throw repositoryIssueLimit(input.requirement_id, `${detail}. ${alternative} Pass --allow-second-issue-per-repository with --override-reason to accept it explicitly.`);
    if (!input.override_reason.trim()) throw validation("override-reason", "is required to publish a second Issue for one Requirement on the same Repository");
    return [{ code: "SECOND_ISSUE_PER_REPOSITORY_OVERRIDE", message: `${detail}; accepted by explicit override: ${input.override_reason.trim()}` }];
  }
  if (input.created_issue_count === 0 && input.existing.length > 1) return [{ code: "SECOND_ISSUE_PER_REPOSITORY_EXISTING", message: `Requirement ${input.requirement_id} already has Issue ${listed} on this Repository. ${alternative}` }];
  return [];
};
export interface PublishedAuthoringResource { action: "created" | "revised" | "unchanged"; id: string; revision_id: string; version: number; requirement_revision_id?: string; baseline?: Baseline }
export interface PublishAuthoringResult { result_type: string; command: string; repository_id: string; repository_action: "registered" | "resolved"; requirement: PublishedAuthoringResource; issues: PublishedAuthoringResource[] }

/** Repository ids whose active remotes (canonical or alias) share a transport-
 * agnostic match key with any of `remotes`.  Computed inside the caller's
 * transaction so the scan and any following write stay serialized. */
const matchRepositoriesByKey = async (tx: Tx, remotes: readonly string[]): Promise<string[]> => {
  const wanted = new Set<string>();
  for (const remote of remotes) { const key = repositoryMatchKey(remote); if (key !== undefined) wanted.add(key); }
  if (!wanted.size) return [];
  const found = new Set<string>();
  for (const binding of await tx.listActiveRepositoryRemoteBindings()) {
    const key = repositoryMatchKey(binding.remote);
    if (key !== undefined && wanted.has(key)) found.add(binding.repository_id);
  }
  return [...found];
};
/** Ambiguity by key must not leak a URL, and must name the way out. */
const ambiguousByKeyReason = "multiple registered repositories match this clone by host and path; pass --repository to choose one, or point --remote at a remote whose canonical address exactly equals a registered canonical remote or active alias, so the exact match takes precedence";

/** Resolve one Repository for `canonical`: exact canonical/alias match first,
 * then a unique match key.  A key shared by several Repositories is ambiguous
 * and must not be silently picked. */
const resolveRepositoryByKeyOrExact = async (tx: Tx, canonical: string): Promise<RepositoryRecord> => {
  try { return await tx.findRepositoryByRemote(canonical); }
  catch (error) { if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") throw error; }
  const matched = await matchRepositoriesByKey(tx, [canonical]);
  if (!matched.length) throw notFound("repository", canonical);
  if (matched.length > 1) throw repositoryAmbiguous(ambiguousByKeyReason);
  return tx.getRepository(matched[0]!);
};

const command = {
  workspacePublish: "workspace.publish", quickstartCreate: "quickstart.create", requirementCreate: "requirement.create", requirementRevise: "requirement.revise", repositoryRegister: "repository.register", repositoryMove: "repository.move", repositoryAliasAdd: "repository.alias-add", repositoryAliasRetire: "repository.alias-retire", issueCreate: "issue.create", issueRevise: "issue.revise", devrunStart: "devrun.start", candidateSubmit: "candidate.submit", verificationSubmit: "verification.submit",
};

const ensureID = (field: string, value: string): void => { if (!isUUIDv7(value)) throw validation(field, "must be a lowercase UUIDv7"); };
const opID = (value: string): string => { if (!value) return newUUIDv7(); ensureID("operation_id", value); return value; };
const withoutUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).map(([key, item]) => [key, withoutUndefined(item)]));
  return value;
};
const operationHash = (name: string, payload: unknown, attribution: Attribution, resolved: unknown, concurrency: unknown): string => {
  const normalizedPayload = withoutUndefined(payload && typeof payload === "object" && !Array.isArray(payload)
    ? Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([key]) => key !== "operation_id"))
    : payload);
  return sha256(withoutUndefined({ command: name, payload: normalizedPayload, attribution, resolved_inputs: resolved, concurrency }));
};
const event = (id: string, type: string, op: string, subjectType: string, subjectId: string, repositoryId: string | undefined, version: number | undefined, occurredAt: string, attribution: Attribution, facts: Record<string, string>): LedgerEvent => ({ event_id: id, event_type: type, event_version: 1, operation_id: op, subject_type: subjectType, subject_id: subjectId, ...(repositoryId ? { repository_id: repositoryId } : {}), ...(version === undefined ? {} : { subject_version: version }), occurred_at: occurredAt, attribution, facts: Object.entries(facts).sort(([left], [right]) => compareText(left, right)).map(([name, value]) => ({ name, value })) });
/** What the ledger needs to record a removed worktree; the local receipt satisfies it structurally. */
export interface DevRunWorktreeRemoval { operation_id: string; event_id: string; dev_run_id: string; worktree_path: string; discard_changes: boolean; entry_count: number; attribution: Attribution }
export interface DevRunWorktreeDeletionSummary { dev_run_id: string; worktree_path: string; discard_changes: boolean; entry_count: number; occurred_at: string }
interface DevRunWorktreeRemovalResult { result_type: "patchledger.result.devrun-worktree-removal/v1"; command: "devrun.cleanup"; deletion_summary: DevRunWorktreeDeletionSummary }
const envelopeData = <T>(value: T, op: string, warnings: Warning[] = []): SuccessEnvelope => ({ format: "patchledger.cli/v1", ok: true, operation_id: op, data: value, warnings });
const decodeReplay = <T>(replay: OperationReplay): { data: T; warnings: Warning[] } => {
  const invalid = (reason: string): never => {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored operation result is invalid", false, { reason });
  };
  const resultData = (value: unknown): T => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("result data must be an object");
    const record = value as Record<string, unknown>;
    if (typeof record.result_type !== "string" || record.result_type.length < 1 || record.result_type.length > 256 || typeof record.command !== "string" || record.command.length < 1 || record.command.length > 256) return invalid("result data must contain bounded result_type and command strings");
    if (record.command !== replay.command) return invalid("result command does not match the idempotency record");
    return value as T;
  };
  const warnings = (value: unknown): Warning[] => {
    if (!Array.isArray(value) || value.length > 100) return invalid("warnings must be an array of at most 100 entries");
    for (const warning of value) {
      if (!warning || typeof warning !== "object" || Array.isArray(warning)) return invalid("warning must be an object");
      const record = warning as Record<string, unknown>;
      if (Object.keys(record).some((key) => key !== "code" && key !== "message") || typeof record.code !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(record.code) || typeof record.message !== "string" || record.message.length < 1 || record.message.length > 4096) return invalid("warning fields are invalid");
    }
    return value as Warning[];
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(replay.result_json) as unknown;
  } catch {
    // Completed idempotency rows are immutable.  A truncated or malformed
    // result is database corruption, not a caller error; keep it on the
    // stable integrity-error path.
    return invalid("result_json is not valid JSON");
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { format?: unknown }).format === "patchledger.cli/v1") {
    const envelope = parsed as { format?: unknown; ok?: unknown; operation_id?: unknown; data?: unknown; warnings?: unknown };
    if (envelope.ok !== true || !Object.prototype.hasOwnProperty.call(envelope, "data") || !Object.prototype.hasOwnProperty.call(envelope, "warnings")) return invalid("success envelope is incomplete");
    if (envelope.operation_id !== undefined && !isUUIDv7(envelope.operation_id)) return invalid("success envelope operation_id is invalid");
    return { data: resultData(envelope.data), warnings: warnings(envelope.warnings) };
  }
  // Early local databases stored the command result directly.  Keep those
  // records readable while all new writes persist the complete CLI envelope.
  return { data: resultData(parsed), warnings: [] };
};
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const canonicalSubmission = (submission: CandidateSubmissionInput): CandidateSubmissionInput => {
  const claims = [...submission.claims].sort((a, b) => compareText(`${a.target_type}:${a.target_id}`, `${b.target_type}:${b.target_id}`)).map((claim) => ({ ...claim, criteria: [...claim.criteria].sort((a, b) => compareText(a.criterion_id, b.criterion_id)) }));
  if (submission.format === "patchledger.candidate-submission/v1") return { ...submission, claims };
  const changeRationales = submission.change_rationales.map((rationale) => ({
    ...rationale,
    change_refs: [...rationale.change_refs].sort(compareText),
    target_refs: [...rationale.target_refs].sort((left, right) => compareText(left.id, right.id)),
  })).sort((left, right) => compareText(sha256(left), sha256(right)));
  return { ...submission, claims, change_rationales: changeRationales };
};
const canonicalVerificationReport = (report: VerificationReportInput): VerificationReportInput => ({ ...report, assessments: [...report.assessments].sort((a, b) => compareText(`${a.target_type}:${a.target_id}`, `${b.target_type}:${b.target_id}`)).map((assessment) => ({ ...assessment, criteria: [...assessment.criteria].sort((a, b) => compareText(a.criterion_id, b.criterion_id)) })) });
const hashRequirementInput = (input: RequirementInput): Record<string, unknown> => ({ ...input, decisions: input.decisions === undefined ? null : input.decisions, open_questions: input.open_questions === undefined ? null : input.open_questions });
const hashIssueInput = (input: IssueInput): Record<string, unknown> => ({ ...input, constraints: input.constraints === undefined ? null : input.constraints });
const requireIssueReadyRequirement = (revision: RequirementRevision): void => { if ((revision.open_questions ?? []).some((question) => question.blocking)) throw validation("requirement.open_questions", "the Requirement Version bound by an Issue contains a blocking Open Question"); };
// The IssueRevision JSON projection deliberately hides the aggregate-only
// RequirementID and Baseline fields. Those values are included separately in
// resolved_inputs, so operation hashes use the same public projection on retry.
const hashableIssueRevision = (revision: IssueRevision): Record<string, unknown> => ({ id: revision.id, issue_id: revision.issue_id, requirement_revision_id: revision.requirement_revision_id, revision_number: revision.revision_number, ...(revision.predecessor_revision_id ? { predecessor_revision_id: revision.predecessor_revision_id } : {}), ...(revision.target_branch ? { target_branch: revision.target_branch } : {}), summary: revision.summary, ...(revision.context ? { context: revision.context } : {}), ...(revision.plan ? { plan: revision.plan } : {}), goals: revision.goals, constraints: revision.constraints });
const standing = (total: number, qualified: number, rejected: number): string => total === 0 ? "unverified" : qualified > 0 && rejected > 0 ? "disputed" : qualified > 0 ? "qualified" : rejected > 0 ? "rejected" : "inconclusive";
const deriveIssueBoard = (selectionState: string, candidates: number, open: number, completed = false): { status: string; next_action: IssueBoard["next_action"] } =>
  completed ? { status: "completed", next_action: null } : selectionState === "selected" ? { status: "candidate_selected", next_action: "prepare_delivery" } : candidates > 0 ? { status: "candidates_available", next_action: "review_candidates" } : open > 0 ? { status: "exploring", next_action: "resume_devrun" } : { status: "ready", next_action: "start_devrun" };
const oneOf = <T extends string>(field: string, value: string | undefined, allowed: readonly T[]): T | undefined => {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw validation(field, `must be one of: ${allowed.join(", ")}`);
  return value as T;
};
const validateIssueListOptions = (options: IssueListOptions): IssueListFilter => {
  if (options.repository_id !== undefined) ensureID("repository_id", options.repository_id);
  if (options.has_open_dev_run !== undefined && typeof options.has_open_dev_run !== "boolean") throw validation("has_open_dev_run", "must be true or false");
  const status = oneOf("status", options.status, ["ready", "exploring", "candidates_available", "candidate_selected", "completed", "incomplete"] as const);
  const sort = oneOf("sort", options.sort, ["id", "activity"] as const);
  return { ...(options.repository_id ? { repository_id: options.repository_id } : {}), ...(status ? { status } : {}), ...(options.has_open_dev_run === undefined ? {} : { has_open_dev_run: options.has_open_dev_run }), ...(sort ? { sort } : {}) };
};
const validateDevRunListOptions = (issueId: string, options: DevRunListOptions): DevRunListFilter => {
  if (options.repository_id !== undefined) ensureID("repository_id", options.repository_id);
  if (options.issue_version !== undefined) {
    if (!issueId) throw validation("issue_version", "requires an Issue");
    if (!Number.isSafeInteger(options.issue_version) || options.issue_version < 1) throw validation("issue_version", "must be a positive integer");
  }
  const state = oneOf("state", options.state, ["open", "submitted", "abandoned"] as const);
  return { ...(options.repository_id ? { repository_id: options.repository_id } : {}), ...(options.issue_version === undefined ? {} : { issue_version: options.issue_version }), ...(state ? { state } : {}) };
};
const validateCandidateListOptions = (options: CandidateListOptions): CandidateListFilter => {
  if (options.repository_id !== undefined) ensureID("repository_id", options.repository_id);
  if (options.selected !== undefined && typeof options.selected !== "boolean") throw validation("selected", "must be true or false");
  const standingFilter = oneOf("standing", options.standing, ["unverified", "inconclusive", "qualified", "rejected", "disputed"] as const);
  return { ...(options.repository_id ? { repository_id: options.repository_id } : {}), ...(standingFilter ? { standing: standingFilter } : {}), ...(options.selected === undefined ? {} : { selected: options.selected }) };
};
const validateVerificationListOptions = (options: VerificationListOptions): VerificationListFilter => {
  const verdict = oneOf("verdict", options.verdict, ["qualified", "rejected", "inconclusive"] as const);
  return verdict ? { verdict } : {};
};
const textPreview = (value: string): TextPreview => { const digest = sha256Bytes(Buffer.from(value)); const runes = [...value]; return { digest, preview: runes.slice(0, 2048).join(""), truncated: runes.length > 2048 }; };
const resultSize = <T>(name: string, value: T): T => {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw new DomainError("ARTIFACT_TOO_LARGE", `${name} cannot be serialized`, false, { reason: `serialized ${name} exceeds 8 MiB` }); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 8 * 1024 * 1024) throw new DomainError("ARTIFACT_TOO_LARGE", `${name} exceeds 8 MiB`, false, { reason: `serialized ${name} exceeds 8 MiB` });
  return value;
};
const comparisonClaims = (claims: ClaimInput[], criterionStandings: Map<string, string>): unknown[] => {
  const result: unknown[] = [];
  for (const claim of claims) {
    const criteria: unknown[] = [];
    for (const criterion of claim.criteria) {
      criteria.push({
        criterion_id: criterion.criterion_id,
        explanation: textPreview(criterion.explanation),
        ...(criterion.self_verification ? { self_verification: { status: criterion.self_verification.status, explanation: textPreview(criterion.self_verification.explanation), ...(criterion.self_verification.method ? { method: textPreview(criterion.self_verification.method) } : {}) } } : {}),
        evidence_count: criterion.evidence.length,
        verification_standing: criterionStandings.get(`${claim.target_type}:${claim.target_id}:${criterion.criterion_id}`) ?? "unverified",
      });
    }
    result.push({ target_type: claim.target_type, target_id: claim.target_id, explanation: textPreview(claim.explanation), criteria });
  }
  return result;
};
const publicLedgerEvent = (value: LedgerEvent): LedgerEventView => {
  const facts = value.facts.filter((fact) => !fact.name.includes("revision_id"));
  if (value.subject_type === "requirement_revision") {
    const requirement = value.facts.find((fact) => fact.name === "requirement_id")?.value;
    if (!requirement) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Requirement ledger event lacks its stable identity", false, { resource_id: value.event_id });
    return { ...value, subject_type: "requirement", subject_id: requirement, facts };
  }
  if (value.subject_type === "issue_completion") {
    const issue = value.facts.find(f => f.name === "issue_id")?.value;
    if (!issue) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "completion event lacks Issue identity");
    return { ...value, subject_type: "issue_completion", subject_id: issue, facts };
  }
  if (value.subject_type === "issue_revision") {
    const issue = value.facts.find((fact) => fact.name === "issue_id")?.value;
    if (!issue) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Issue ledger event lacks its stable identity", false, { resource_id: value.event_id });
    return { ...value, subject_type: "issue", subject_id: issue, facts };
  }
  return { ...value, subject_type: value.subject_type as LedgerEventView["subject_type"], facts };
};

const diffStats = (files: CandidateFile[], patch: Buffer): { files: number; insertions: number; deletions: number } => {
  let insertions = 0;
  let deletions = 0;
  if (patch.length > 0) {
    for (const line of patch.toString("utf8").split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  return { files: files.length, insertions, deletions };
};

const fallbackUnifiedDiff = (leftID: string, rightID: string, left: Buffer, right: Buffer): Buffer => {
  if (left.equals(right)) return Buffer.alloc(0);
  if (left.length + right.length + 128 > 1024 * 1024) return Buffer.alloc(0);
  const lines = (value: Buffer): string[] => value.length === 0 ? [] : value.toString("utf8").split(/(?<=\n)/);
  const output = [`--- candidate/${leftID}\n`, `+++ candidate/${rightID}\n`];
  for (const line of lines(left)) output.push(`-${line}${line.endsWith("\n") ? "" : "\n"}`);
  for (const line of lines(right)) output.push(`+${line}${line.endsWith("\n") ? "" : "\n"}`);
  return Buffer.from(output.join(""), "utf8");
};

const fallbackPairwiseStats = (left: CandidateFile[], right: CandidateFile[], leftPatch: Buffer, rightPatch: Buffer): { files: number; insertions: number; deletions: number } => {
  const leftFiles = new Map(left.map((file) => [file.path_bytes, file]));
  const rightFiles = new Map(right.map((file) => [file.path_bytes, file]));
  let files = 0;
  for (const [path, file] of leftFiles) {
    const other = rightFiles.get(path);
    if (!other || file.change !== other.change || file.old_path_bytes !== other.old_path_bytes || file.old_mode !== other.old_mode || file.new_mode !== other.new_mode) files += 1;
  }
  for (const path of rightFiles.keys()) if (!leftFiles.has(path)) files += 1;
  const leftStats = diffStats(left, leftPatch);
  const rightStats = diffStats(right, rightPatch);
  return { files, insertions: rightStats.insertions, deletions: leftStats.deletions };
};

export class Module {
  /** Test seam: lowers the per-page byte budget (defaults to the public 8 MiB). */
  pageByteLimit?: number;
  constructor(private readonly store: Store, private readonly newId: () => string = newUUIDv7, private readonly treeDiffProvider?: TreeDiffProvider,
    private readonly historyRelationProvider?: (snapshot: string, base: string) => import("./integration-history.js").SnapshotRelation,
    private readonly preflightCoordinator?: PreflightCoordinator) {}

  private async checkPublications(inputs: PublishGateInput[], operationID: string): Promise<{ input: PublishGateInput; match: PreflightMatch }[]> {
    if (!inputs.length || await this.store.read(tx => tx.getOperation(operationID))) return [];
    if (!this.preflightCoordinator) throw stateConflict("preflight", operationID, "target publication requires a configured fresh-target coordinator");
    let checked: { input: PublishGateInput; match: PreflightMatch }[] = [];
    for (const input of inputs) checked = [...checked, { input, match: await this.preflightCoordinator.publish(input) }];
    return checked;
  }

  private async authoringGates(input: PublishAuthoringCommand): Promise<PublishGateInput[]> {
    const targets = await this.store.read(async tx => Promise.all(input.issues.map(async item =>
      item.input.target_branch ?? (item.issue_id ? (item.expected_revision_id ? await tx.getIssueRevision(item.issue_id, item.expected_revision_id) : await tx.getCurrentIssueRevision(item.issue_id)).target_branch : undefined))));
    const unique = targets.filter((target, index): target is TargetBranch => !!target && targets.findIndex(other => other?.remote === target.remote && other?.ref === target.ref) === index);
    const digest = contentDigestFor(publishAuthoringBinding({ ...input, issues: input.issues.map(issue => ({ ...issue, target_branch: issue.input.target_branch })) }));
    return unique.map(target => ({ canonical_remote: input.canonical_remote, reviewed_version: input.reviewed_version,
      content_digest: digest, target, what: "publish", operation_id: input.operation_id }));
  }

  private async upstreamChanges(left: string, right: string, includeDiff = true): Promise<import("./comparison.js").UpstreamChanges> {
    const base = { source: "derived_relation" as const, role: "base_changes_not_candidate_changes" as const, left_base_commit: left, right_base_commit: right };
    if (!this.treeDiffProvider) return { ...base, status: "unavailable" };
    try {
      const diff = await this.treeDiffProvider(left, right);
      const { left_candidate_id: _left, right_candidate_id: _right, equivalent: _same, ...projection } = inlineTreeDiff("", "", false, diff.patch, { files: diff.files, insertions: diff.insertions, deletions: diff.deletions }, diff.binary, sha256({ left_base_commit: left, right_base_commit: right }), diff.too_large);
      if (!includeDiff && projection.diff_state === "inline") { projection.diff_state = "not_requested"; delete projection.unified_diff; }
      return { ...base, status: "available", diff: projection };
    } catch { return { ...base, status: "unavailable" }; }
  }

  private addSnapshotRelation(context: { baseline: Baseline; base_commit?: string; snapshot_relation?: import("./integration-history.js").SnapshotRelation }): void {
    if (!context.base_commit) return;
    try { context.snapshot_relation = this.historyRelationProvider?.(context.baseline.git_oid, context.base_commit) ?? { kind: "unknown" }; }
    catch { context.snapshot_relation = { kind: "unknown" }; }
  }

  async historyCandidate(candidateId: string) {
    ensureID("candidate_id", candidateId);
    return this.store.read(async tx => {
      const record = await tx.getCandidate(candidateId);
      const issue = await tx.getIssueRevisionById(record.candidate.issue_revision_id);
      return { record, issue, repository_id: (await tx.getIssue(issue.issue_id)).repository_id, requirement_version: (await tx.getRequirementRevision(issue.requirement_id, issue.requirement_revision_id)).revision_number };
    });
  }

  async deliveryLinks(repositoryId: string) {
    ensureID("repository_id", repositoryId);
    return this.store.read(tx => tx.listDeliveryLinks(repositoryId, 1001));
  }

  async historySnapshot(repositoryId: string, path: string) {
    ensureID("repository_id", repositoryId);
    return this.store.read(async tx => ({ candidate_ids: await tx.historyCandidateIds(repositoryId, path, 1001), links: await tx.listDeliveryLinks(repositoryId, 1001) }));
  }

  async showDeliveryLink(id: string, version?: number): Promise<import("./delivery-link.js").DeliveryLinkResult> {
    ensureID("link_id", id);
    if (version !== undefined) this.validateSelectionVersion("version", version);
    return this.store.read(async tx => ({ result_type: "patchledger.result.delivery-link/v1", command: "delivery-link.show", link: await tx.getDeliveryLink(id, version) }));
  }

  async withdrawDeliveryLink(input: { link_id: string; operation_id: string; expected_version: number; reason: string; attribution: Attribution }): Promise<import("./delivery-link.js").DeliveryLinkResult> {
    ensureID("link_id", input.link_id); validateAttribution(input.attribution);
    this.validateSelectionVersion("expected_version", input.expected_version, 0);
    validateOptionalLongText("reason", input.reason);
    if (!input.reason.trim() || input.reason.length > 4096) throw validation("reason", "requires 1 to 4096 characters");
    const op = opID(input.operation_id), name = "delivery-link.withdraw";
    const hash = operationHash(name, input, input.attribution, {}, { expected_version: input.expected_version });
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: op, command: name, request_hash: hash });
      if (replay) return decodeReplay<import("./delivery-link.js").DeliveryLinkResult>(replay).data;
      const observed = await tx.getDeliveryLink(input.link_id);
      await tx.lockCandidateVerifications(observed.candidate_id);
      const before = await tx.getDeliveryLink(input.link_id);
      if (before.version !== input.expected_version) throw versionConflict("delivery_link", before.id, input.expected_version, before.version);
      if (before.state === "withdrawn") throw stateConflict("delivery_link", before.id, "already withdrawn");
      const link: import("./delivery-link.js").DeliveryLink = { ...before, state: "withdrawn", version: before.version + 1, reason: input.reason, updated_at: await tx.now(), attribution: input.attribution };
      await tx.saveDeliveryLink(link, input.expected_version);
      await tx.appendLedgerEvent(event(this.newId(), name, op, "delivery_link", link.id, link.repository_id, link.version, link.updated_at, input.attribution, { reason: input.reason }));
      const result: import("./delivery-link.js").DeliveryLinkResult = { result_type: "patchledger.result.delivery-link/v1", command: name, link };
      await tx.completeOperation(op, JSON.stringify(envelopeData(result, op)));
      return result;
    });
  }

  async completedDeliveryLinkOperation(input: { operation_id: string; repository_id: string; candidate_id?: string; commit_oid: string; expected_version: number; attribution: Attribution }): Promise<import("./delivery-link.js").DeliveryLinkResult | undefined> {
    ensureID("operation_id", input.operation_id); ensureID("repository_id", input.repository_id);
    if (input.candidate_id !== undefined) ensureID("candidate_id", input.candidate_id);
    validateAttribution(input.attribution);
    this.validateSelectionVersion("expected_version", input.expected_version, 0);
    const name = "delivery-link.record";
    return this.store.read(async tx => {
      const replay = await tx.getOperation(input.operation_id);
      if (!replay) return undefined;
      if (replay.command !== name) throw idempotencyConflict(replay.command, replay.request_hash, replay.request_hash);
      const result = decodeReplay<import("./delivery-link.js").DeliveryLinkResult>(replay).data;
      try {
        validateDeliveryLink(result.link);
        if (result.result_type !== "patchledger.result.delivery-link/v1" || result.link.state !== "recorded") throw new Error("invalid recording result");
      } catch { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Stored delivery result is invalid"); }
      // Reconstruct the original request from its immutable proof, replacing
      // only caller-supplied fields. No live receipt, artifact or Git lookup.
      const { id, version, state, updated_at, attribution, reason, ...frozenProof } = result.link;
      const request = { expected_version: input.expected_version, attribution: input.attribution, proof: { ...frozenProof, candidate_id: input.candidate_id ?? frozenProof.candidate_id, repository_id: input.repository_id, commit_oid: input.commit_oid } };
      const hash = operationHash(name, request, input.attribution, {}, { expected_version: input.expected_version });
      if (hash !== replay.request_hash) throw idempotencyConflict(name, hash, replay.request_hash);
      return result;
    });
  }

  async recordDeliveryLink(input: { operation_id: string; expected_version: number; attribution: Attribution; proof: import("./delivery-link.js").DeliveryProof }): Promise<import("./delivery-link.js").DeliveryLinkResult> {
    validateDeliveryProof(input.proof);
    ensureID("candidate_id", input.proof.candidate_id); ensureID("repository_id", input.proof.repository_id);
    validateAttribution(input.attribution);
    this.validateSelectionVersion("expected_version", input.expected_version, 0);
    if (!input.proof.units.length) throw validation("proof", "requires matched changes");
    const op = opID(input.operation_id); const name = "delivery-link.record";
    const hash = operationHash(name, input, input.attribution, {}, { expected_version: input.expected_version });
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: op, command: name, request_hash: hash });
      if (replay) return decodeReplay<import("./delivery-link.js").DeliveryLinkResult>(replay).data;
      await tx.lockCandidateVerifications(input.proof.candidate_id);
      const candidate = await tx.getCandidate(input.proof.candidate_id);
      const units = indexCandidateChanges(candidate.artifact).change_units;
      for (const mapped of input.proof.units) {
        const unit = units.find(u => u.change_unit_id === mapped.change_unit_id);
        if (!unit || unit.kind !== "hunk" || !unit.new_range || Buffer.from(unit.path_bytes, "base64").toString("utf8") !== mapped.path || unit.new_range.start !== mapped.candidate_start || unit.new_range.lines !== mapped.lines) throw validation("proof.units", "must reference complete Candidate Change Units");
      }
      const issue = await tx.getIssueRevisionById(candidate.candidate.issue_revision_id);
      if ((await tx.getIssue(issue.issue_id)).repository_id !== input.proof.repository_id || candidate.candidate.patch_digest !== input.proof.patch_digest) throw validation("proof", "Candidate binding mismatch");
      const before = await tx.findDeliveryLink(input.proof.candidate_id, input.proof.commit_oid);
      if ((before?.version ?? 0) !== input.expected_version) throw versionConflict("delivery_link", before?.id ?? input.proof.candidate_id, input.expected_version, before?.version ?? 0);
      const link: import("./delivery-link.js").DeliveryLink = { ...input.proof, id: before?.id ?? this.newId(), version: input.expected_version + 1, state: "recorded", updated_at: await tx.now(), attribution: input.attribution };
      await tx.saveDeliveryLink(link, input.expected_version);
      await tx.appendLedgerEvent(event(this.newId(), name, op, "delivery_link", link.id, link.repository_id, link.version, link.updated_at, input.attribution, { candidate_id: link.candidate_id, commit_oid: link.commit_oid }));
      const result: import("./delivery-link.js").DeliveryLinkResult = { result_type: "patchledger.result.delivery-link/v1", command: name, link };
      await tx.completeOperation(op, JSON.stringify(envelopeData(result, op)));
      return result;
    });
  }

  async completedAuthoringOperation(operationID: string): Promise<{ result: PublishAuthoringResult; warnings: Warning[] } | undefined> {
    ensureID("operation_id", operationID); const replay = await this.store.read((tx) => tx.getOperation(operationID));
    if (!replay) return undefined; if (replay.command !== command.workspacePublish) throw validation("operation_id", "does not belong to a Workspace publication");
    const decoded = decodeReplay<PublishAuthoringResult>(replay); return { result: decoded.data, warnings: decoded.warnings };
  }

  /** Atomic publication seam used by file-oriented authoring Workspaces. */
  async publishAuthoring(input: PublishAuthoringCommand): Promise<{ result: PublishAuthoringResult; warnings: Warning[] }> {
    input = structuredClone(input);
    validateCanonicalRemote(input.canonical_remote); validateAttribution(input.attribution);
    if (!input.requirement.requirement_id && !input.requirement.input) throw validation("requirement", "a new Workspace must publish Requirement content");
    if (input.requirement.requirement_id) ensureID("requirement_id", input.requirement.requirement_id);
    if (input.requirement.expected_revision_id) ensureID("expected_revision_id", input.requirement.expected_revision_id);
    if (input.requirement.input) validateRequirementInput(input.requirement.input);
    if (input.repository_issue_override_reason !== undefined) validateOptionalLongText("repository_issue_override_reason", input.repository_issue_override_reason);
    if (!Array.isArray(input.issues) || input.issues.length > 100) throw validation("issues", "must contain at most 100 changed Issues");
    const seenIssues = new Set<string>();
    input.issues.forEach((issue, index) => {
      if (issue.issue_id) { ensureID(`issues[${index}].issue_id`, issue.issue_id); if (seenIssues.has(issue.issue_id)) throw validation("issues", "contains a duplicate Issue"); seenIssues.add(issue.issue_id); }
      if (issue.expected_revision_id) ensureID(`issues[${index}].expected_revision_id`, issue.expected_revision_id);
      if (issue.requirement_revision_id) ensureID(`issues[${index}].requirement_revision_id`, issue.requirement_revision_id);
      validateBaseline(issue.baseline); validateIssueInput(issue.input);
    });
    const op = opID(input.operation_id);
    const requirementID = input.requirement.requirement_id || this.newId();
    const requirementRevisionID = input.requirement.input ? this.newId() : input.requirement.expected_revision_id || "";
    const allocatedIssues = input.issues.map((item) => ({ item, issueID: item.issue_id || this.newId(), revisionID: this.newId() }));
    const hash = operationHash(command.workspacePublish, {
      canonical_remote: input.canonical_remote,
      requirement: { ...input.requirement, input: input.requirement.input ? hashRequirementInput(input.requirement.input) : undefined },
      issues: input.issues.map((issue) => ({ ...issue, input: hashIssueInput(issue.input) })),
      ...(input.reviewed_version ? { reviewed_version: input.reviewed_version } : {}),
      ...(input.allow_second_issue_per_repository ? { allow_second_issue_per_repository: true } : {}),
      ...(input.repository_issue_override_reason?.trim() ? { repository_issue_override_reason: input.repository_issue_override_reason.trim() } : {}),
    }, input.attribution, {}, { requirement_revision_id: input.requirement.expected_revision_id, issue_revision_ids: input.issues.map((issue) => issue.expected_revision_id ?? null) });
    let result!: PublishAuthoringResult; let warnings: Warning[] = [];
    const preflightChecks = await this.checkPublications(await this.authoringGates(input), op);
    await this.store.write(async (tx) => {
      const replay = await tx.reserveOperation({ id: op, command: command.workspacePublish, request_hash: hash });
      if (replay) { ({ data: result, warnings } = decodeReplay<PublishAuthoringResult>(replay)); return; }
      const now = await tx.now();
      const ensured = await tx.ensureRepository({ id: this.newId(), canonical_remote: input.canonical_remote, version: 1, created_at: now, attribution: input.attribution });
      if (ensured.created) await tx.appendLedgerEvent(event(this.newId(), "repository.registered", op, "repository", ensured.repository.id, ensured.repository.id, ensured.repository.version, now, input.attribution, { canonical_remote: ensured.repository.canonical_remote }));
      for (const checked of preflightChecks) {
        await enforcePublishGate(tx, { ...checked.input, repository_id: ensured.repository.id }, checked.match);
      }

      let requirementRevision: RequirementRevision;
      let requirementAction: PublishedAuthoringResource["action"];
      if (!input.requirement.requirement_id) {
        const content = input.requirement.input!;
        requirementRevision = { id: requirementRevisionID, requirement_id: requirementID, revision_number: 1, summary: content.summary, outcomes: content.outcomes, decisions: content.decisions ?? [], ...(content.open_questions?.length ? { open_questions: content.open_questions } : {}), ...(content.context === undefined ? {} : { context: content.context }) };
        await tx.createRequirement({ id: requirementID, created_at: now, attribution: input.attribution }, { revision: requirementRevision, created_at: now, attribution: input.attribution });
        await tx.appendLedgerEvent(event(this.newId(), "requirement.created", op, "requirement_revision", requirementRevision.id, undefined, 1, now, input.attribution, { requirement_id: requirementID }));
        requirementAction = "created";
      } else {
        await tx.lockRequirement(requirementID);
        const current = await tx.getCurrentRequirementRevision(requirementID);
        if (input.requirement.input) {
          if (!input.requirement.expected_revision_id) throw validation("workspace", "existing Requirement is missing its source Version");
          if (current.id !== input.requirement.expected_revision_id) { const expected = await tx.getRequirementRevision(requirementID, input.requirement.expected_revision_id); throw versionConflict("requirement", requirementID, expected.revision_number, current.revision_number); }
          const content = input.requirement.input;
          requirementRevision = { id: requirementRevisionID, requirement_id: requirementID, revision_number: current.revision_number + 1, predecessor_revision_id: current.id, summary: content.summary, outcomes: content.outcomes, decisions: content.decisions ?? [], ...(content.open_questions?.length ? { open_questions: content.open_questions } : {}), ...(content.context === undefined ? {} : { context: content.context }) };
          await tx.appendRequirementRevision({ revision: requirementRevision, created_at: now, attribution: input.attribution });
          await tx.appendLedgerEvent(event(this.newId(), "requirement.revised", op, "requirement_revision", requirementRevision.id, undefined, requirementRevision.revision_number, now, input.attribution, { requirement_id: requirementID, predecessor_revision_id: current.id }));
          requirementAction = "revised";
        } else { if (!input.requirement.expected_revision_id) throw validation("workspace", "existing Requirement is missing its source Version"); if ((input.requirement.require_current ?? true) && current.id !== input.requirement.expected_revision_id) { const expected = await tx.getRequirementRevision(requirementID, input.requirement.expected_revision_id); throw versionConflict("requirement", requirementID, expected.revision_number, current.revision_number); } requirementRevision = await tx.getRequirementRevision(requirementID, input.requirement.expected_revision_id); requirementAction = "unchanged"; }
      }

      // The Requirement lock above covers its whole Issue set, so counting here
      // is the authoritative check.  Issue writes below cannot introduce a
      // second Issue on this Repository for the same Requirement.
      const issuesOnRepository = input.requirement.requirement_id ? await tx.listIssuesPage(requirementID, "", 20, { repository_id: ensured.repository.id }) : { rows: [], more: false };
      warnings.push(...issueRepositoryRule({
        requirement_id: requirementID,
        existing: issuesOnRepository.rows.map((item) => item.id),
        existing_more: issuesOnRepository.more,
        created_issue_count: allocatedIssues.filter(({ item }) => !item.issue_id).length,
        allow_second_issue_per_repository: input.allow_second_issue_per_repository === true,
        override_reason: input.repository_issue_override_reason ?? "",
      }));

      const publishedIssues: PublishedAuthoringResource[] = [];
      for (const { item, issueID, revisionID } of allocatedIssues) {
        const bindingID = input.requirement.input ? requirementRevision.id : (item.requirement_revision_id || requirementRevision.id);
        const boundRequirement = bindingID === requirementRevision.id ? requirementRevision : await tx.getRequirementRevision(requirementID, bindingID);
        if ((boundRequirement.open_questions ?? []).some((question) => question.blocking)) throw validation("requirement.open_questions", "the Requirement Version bound by an Issue contains a blocking Open Question");
        let revision: IssueRevision;
        let action: "created" | "revised";
        if (!item.issue_id) {
          revision = makeIssueRevision(this.newId, issueID, requirementID, bindingID, revisionID, 1, undefined, item.baseline, item.input, boundRequirement);
          preflightIndependentDevRunContext(revision, boundRequirement, ensured.repository.id, now);
          await tx.createIssue({ id: issueID, requirement_id: requirementID, repository_id: ensured.repository.id, created_at: now, attribution: input.attribution }, { revision, created_at: now, attribution: input.attribution });
          action = "created";
        } else {
          const issue = await tx.getIssue(issueID);
          if (issue.requirement_id !== requirementID || issue.repository_id !== ensured.repository.id) throw validation("issues", "an Issue does not belong to this Requirement and Repository");
          const current = await tx.getCurrentIssueRevision(issueID);
          if (!item.expected_revision_id) throw validation("workspace", "existing Issue is missing its source Version");
          if (current.id !== item.expected_revision_id) { const expected = await tx.getIssueRevision(issueID, item.expected_revision_id); throw versionConflict("issue", issueID, expected.revision_number, current.revision_number); }
          revision = makeIssueRevision(this.newId, issueID, requirementID, bindingID, revisionID, current.revision_number + 1, current.id, item.baseline, item.input, boundRequirement);
          preflightIndependentDevRunContext(revision, boundRequirement, ensured.repository.id, now);
          await tx.appendIssueRevision({ revision, created_at: now, attribution: input.attribution });
          action = "revised";
        }
        const publicationTarget = revision.target_branch ?? (revision.predecessor_revision_id ? (await tx.getIssueRevision(issueID, revision.predecessor_revision_id)).target_branch : undefined);
        await tx.appendLedgerEvent(event(this.newId(), action === "created" ? "issue.created" : "issue.revised", op, "issue_revision", revision.id, ensured.repository.id, revision.revision_number, now, input.attribution, { issue_id: issueID, requirement_id: requirementID, requirement_revision_id: bindingID, ...(revision.predecessor_revision_id ? { predecessor_revision_id: revision.predecessor_revision_id } : {}), ...publicationPreflightFacts(preflightChecks, publicationTarget, revision.baseline.git_oid) }));
        if (item.baseline.reachability === "unconfirmed") warnings.push(baselineWarning(item.baseline));
        publishedIssues.push({ action, id: issueID, revision_id: revision.id, version: revision.revision_number, requirement_revision_id: bindingID, baseline: revision.baseline });
      }
      result = { result_type: "patchledger.result.workspace-publish/v1", command: command.workspacePublish, repository_id: ensured.repository.id, repository_action: ensured.created ? "registered" : "resolved", requirement: { action: requirementAction, id: requirementID, revision_id: requirementRevision.id, version: requirementRevision.revision_number }, issues: publishedIssues };
      await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, warnings)));
    });
    return { result, warnings };
  }

  /** Read-only projection of the publish-time Issue/Repository rule so
   * `workspace publish --dry-run` reports the same blocking condition without
   * writing a pending publication.  The transactional check in
   * publishAuthoring stays authoritative under concurrency. */
  async preflightIssueRepositoryRule(input: { requirement_id?: string; canonical_remote: string; created_issue_count: number; allow_second_issue_per_repository: boolean; override_reason: string }): Promise<Warning[]> {
    validateCanonicalRemote(input.canonical_remote);
    return this.store.read(async (tx) => {
      let existing: string[] = []; let more = false;
      if (input.requirement_id) {
        try {
          const repository = await resolveRepositoryByKeyOrExact(tx, input.canonical_remote);
          const page = await tx.listIssuesPage(input.requirement_id, "", 20, { repository_id: repository.id });
          existing = page.rows.map((item) => item.id); more = page.more;
        } catch (error) { if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") throw error; }
      }
      return issueRepositoryRule({ requirement_id: input.requirement_id ?? "", existing, existing_more: more, created_issue_count: input.created_issue_count, allow_second_issue_per_repository: input.allow_second_issue_per_repository, override_reason: input.override_reason });
    });
  }

  async createRequirement(input: CreateRequirementCommand): Promise<{ result: RequirementWriteResult; warnings: Warning[] }> {
    validateRequirementInput(input.input); validateAttribution(input.attribution); const op = opID(input.operation_id); const requirementId = this.newId(); const revisionId = this.newId();
    const hash = operationHash(command.requirementCreate, hashRequirementInput(input.input), input.attribution, {}, {}); let result!: RequirementWriteResult; let warnings: Warning[] = [];
    await this.store.write(async (tx) => { const replay = await tx.reserveOperation({ id: op, command: command.requirementCreate, request_hash: hash }); if (replay) { ({ data: result, warnings } = decodeReplay<RequirementWriteResult>(replay)); return; } const now = await tx.now(); const revision: RequirementRevision = { id: revisionId, requirement_id: requirementId, revision_number: 1, summary: input.input.summary, outcomes: input.input.outcomes, decisions: input.input.decisions ?? [], ...(input.input.open_questions?.length ? { open_questions: input.input.open_questions } : {}), ...(input.input.context === undefined ? {} : { context: input.input.context }) }; await tx.createRequirement({ id: requirementId, created_at: now, attribution: input.attribution }, { revision, created_at: now, attribution: input.attribution }); await tx.appendLedgerEvent(event(this.newId(), "requirement.created", op, "requirement_revision", revisionId, undefined, 1, now, input.attribution, { requirement_id: requirementId })); result = { result_type: "patchledger.result.requirement-write/v1", command: command.requirementCreate, requirement_id: requirementId, requirement_revision_id: revisionId, revision_number: 1 }; await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, []))); }); return { result, warnings };
  }

  async reviseRequirement(input: ReviseRequirementCommand): Promise<{ result: RequirementWriteResult; warnings: Warning[] }> {
    ensureID("requirement_id", input.requirement_id); ensureID("expected_predecessor_id", input.expected_predecessor_id); validateRequirementInput(input.input); validateAttribution(input.attribution); const op = opID(input.operation_id); const revisionId = this.newId();
    const predecessor = await this.store.read((tx) => tx.getRequirementRevision(input.requirement_id, input.expected_predecessor_id));
    const hash = operationHash(command.requirementRevise, { requirement_id: input.requirement_id, expected_predecessor_id: input.expected_predecessor_id, input: hashRequirementInput(input.input) }, input.attribution, { requirement: { id: input.requirement_id }, predecessor_revision: predecessor }, { expected_predecessor_id: input.expected_predecessor_id }); let result!: RequirementWriteResult; let warnings: Warning[] = [];
    await this.store.write(async (tx) => { const replay = await tx.reserveOperation({ id: op, command: command.requirementRevise, request_hash: hash }); if (replay) { ({ data: result, warnings } = decodeReplay<RequirementWriteResult>(replay)); return; } await tx.lockRequirement(input.requirement_id); const current = await tx.getCurrentRequirementRevision(input.requirement_id); if (current.id !== input.expected_predecessor_id) throw predecessorConflict("requirement", input.requirement_id, input.expected_predecessor_id, current.id); const now = await tx.now(); const revision: RequirementRevision = { id: revisionId, requirement_id: input.requirement_id, revision_number: current.revision_number + 1, predecessor_revision_id: current.id, summary: input.input.summary, outcomes: input.input.outcomes, decisions: input.input.decisions ?? [], ...(input.input.open_questions?.length ? { open_questions: input.input.open_questions } : {}), ...(input.input.context === undefined ? {} : { context: input.input.context }) }; await tx.appendRequirementRevision({ revision, created_at: now, attribution: input.attribution }); await tx.appendLedgerEvent(event(this.newId(), "requirement.revised", op, "requirement_revision", revisionId, undefined, revision.revision_number, now, input.attribution, { requirement_id: input.requirement_id, predecessor_revision_id: current.id })); result = { result_type: "patchledger.result.requirement-write/v1", command: command.requirementRevise, requirement_id: input.requirement_id, requirement_revision_id: revisionId, revision_number: revision.revision_number }; await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, []))); }); return { result, warnings };
  }

  async listRequirements(page?: ListPageRequest): Promise<ResourceListResult> {
    const toResource = (item: import("./store-types.js").RequirementListItem): Resource => ({ resource_type: "requirement", resource_id: item.id, label: item.summary, version: item.revision_number, progress: { completion_status: completionProgress(item.bound_count, item.completed_count), completed_issue_count: item.completed_count, bound_to_selected_version_issue_count: item.bound_count, issue_count: item.issue_count, ready_issue_count: item.ready_issue_count, open_dev_run_count: item.open_dev_run_count, candidate_count: item.candidate_count } });
    if (isPagedRequest(page)) return resultSize("Requirement list", await readListPage(this.store, { resource: "requirement", command: "requirement.list", filters: {}, sort: "id:asc", request: page, byteLimit: this.pageByteLimit, load: async (tx, after, limit) => { const result = await tx.listRequirementsPage(typeof after === "string" ? after : "", limit); return { more: result.more, entries: result.rows.map((item) => ({ resource: toResource(item), after: item.id })) }; } }));
    return withPagingHint("requirement", async () => { const resources = await this.store.read(async (tx) => (await tx.listRequirements()).map(toResource)); return resultSize("Requirement list", { result_type: "patchledger.result.resource-list/v1", command: "requirement.list", resources }); });
  }

  async currentRequirementRevision(requirementId: string): Promise<RequirementRevision> { ensureID("requirement_id", requirementId); return this.store.read((tx) => tx.getCurrentRequirementRevision(requirementId)); }

  async currentIssueRevision(issueId: string): Promise<IssueRevision> { ensureID("issue_id", issueId); return this.store.read((tx) => tx.getCurrentIssueRevision(issueId)); }

  async contractRequirement(id: string, version?: number, revisionID?: string): Promise<RequirementRevision> {
    ensureID("requirement_id", id);
    if (version !== undefined) this.validateSelectionVersion("version", version);
    if (revisionID) ensureID("revision_id", revisionID);
    if (!version && !revisionID) throw validation("requirement", "an exact version is required");
    return this.store.read(tx => revisionID ? tx.getRequirementRevision(id, revisionID) : tx.getRequirementRevisionByNumber(id, version!));
  }

  async contractIssue(id: string, version: number) {
    ensureID("issue_id", id); this.validateSelectionVersion("version", version);
    return this.store.read(async tx => {
      const issue = await tx.getIssue(id); const revision = await tx.getIssueRevisionByNumber(id, version);
      const requirement = await tx.getRequirementRevision(issue.requirement_id, revision.requirement_revision_id);
      const repository = await tx.getRepository(issue.repository_id);
      return { revision, requirement, repository: { id: repository.id, canonical_remote: repository.canonical_remote } };
    });
  }

  async loadRequirement(requirementId: string, revisionId = "", cursor = ""): Promise<InternalRequirementDetailResult> {
    ensureID("requirement_id", requirementId); if (revisionId) ensureID("revision_id", revisionId);
    const result = await this.store.read(async (tx) => { const revision = revisionId ? await tx.getRequirementRevision(requirementId, revisionId) : await tx.getCurrentRequirementRevision(requirementId); const after = decodeRequirementCursor(cursor, requirementId, revision.id); const page = await tx.listIssuesPage(requirementId, after, 1000); const issues: RequirementIssueSummary[] = []; for (const item of page.rows) { const repository = await tx.getRepository(item.repository_id); const runCount = await tx.openDevRunCount(item.issue_revision_id); const candidateCount = await tx.candidateCount(item.issue_revision_id); const selection = await this.selectionView(tx, item.issue_revision_id); const completion = completionView(await tx.getCompletion(item.issue_revision_id)); const { status, next_action: nextAction } = deriveIssueBoard(selection.state, candidateCount, runCount, completion.state === "completed"); issues.push({ issue_id: item.id, repository: { id: repository.id, canonical_remote: repository.canonical_remote }, baseline: item.baseline, current_issue_revision: { id: item.issue_revision_id, revision_number: item.revision_number, requirement_revision_id: item.requirement_revision_id, summary: item.summary }, bound_to_selected_revision: item.requirement_revision_id === revision.id, board: { status, next_action: nextAction, completion, selection, open_dev_run_count: runCount, candidate_count: candidateCount } }); } const facts = await tx.requirementAggregateFacts(requirementId, revision.id); const counts: Record<string, number> = { unverified: 0, inconclusive: 0, qualified: 0, rejected: 0, disputed: 0 }; for (const candidate of facts.candidate_standings) counts[standing(candidate.total, candidate.qualified, candidate.rejected)] += 1; return { result_type: "patchledger.result.requirement-detail/v1", command: "requirement.show", requirement_revision: revision, issues, issues_omitted: page.more, ...(page.more && issues.length ? { issues_next_cursor: encodeRequirementCursor(requirementId, revision.id, issues[issues.length - 1].issue_id) } : {}), aggregates: { repository_count: facts.repository_count, issue_count: facts.issue_count, open_dev_run_count: facts.open_dev_run_count, candidate_count: facts.candidate_count, bound_to_selected_revision_issue_count: facts.bound_count, other_requirement_revision_issue_count: facts.issue_count - facts.bound_count, completion_status: completionProgress(facts.bound_count, facts.completed_count), completed_issue_count: facts.completed_count, candidate_standing_counts: counts } }; });
    return resultSize("Requirement detail", result);
  }

  async showRequirement(requirementId: string, revisionId = "", cursor = ""): Promise<RequirementDetailResult> {
    const detail = await this.loadRequirement(requirementId, revisionId, cursor);
    const issues = await Promise.all(detail.issues.map(async (entry) => {
      const bound = await this.store.read((tx) => tx.getRequirementRevision(requirementId, entry.current_issue_revision.requirement_revision_id));
      return { issue: { id: entry.issue_id, version: entry.current_issue_revision.revision_number, summary: entry.current_issue_revision.summary, requirement: { id: requirementId, version: bound.revision_number } }, repository: entry.repository, baseline: entry.baseline, bound_to_selected_version: entry.bound_to_selected_revision, board: entry.board };
    }));
    return { result_type: detail.result_type, command: detail.command, requirement: requirementVersionForContext(detail.requirement_revision), issues, issues_omitted: detail.issues_omitted, ...(detail.issues_next_cursor ? { issues_next_cursor: detail.issues_next_cursor } : {}), aggregates: { repository_count: detail.aggregates.repository_count, issue_count: detail.aggregates.issue_count, open_dev_run_count: detail.aggregates.open_dev_run_count, candidate_count: detail.aggregates.candidate_count, bound_to_selected_version_issue_count: detail.aggregates.bound_to_selected_revision_issue_count, other_requirement_version_issue_count: detail.aggregates.other_requirement_revision_issue_count, completion_status: detail.aggregates.completion_status, completed_issue_count: detail.aggregates.completed_issue_count, candidate_standing_counts: detail.aggregates.candidate_standing_counts } };
  }

  async registerRepository(input: RegisterRepositoryCommand): Promise<{ result: RepositoryWriteResult; warnings: Warning[] }> {
    validateCanonicalRemote(input.canonical_remote); validateAttribution(input.attribution); const op = opID(input.operation_id); input = { ...input, operation_id: op }; const repositoryId = this.newId(); const hash = operationHash(command.repositoryRegister, { canonical_remote: input.canonical_remote }, input.attribution, {}, {}); let result!: RepositoryWriteResult; let warnings: Warning[] = [];
    await this.store.write(async (tx) => { const replay = await tx.reserveOperation({ id: op, command: command.repositoryRegister, request_hash: hash }); if (replay) { ({ data: result, warnings } = decodeReplay<RepositoryWriteResult>(replay)); return; } const now = await tx.now(); const ensured = await tx.ensureRepository({ id: repositoryId, canonical_remote: input.canonical_remote, version: 1, created_at: now, attribution: input.attribution }); if (ensured.created) await tx.appendLedgerEvent(event(this.newId(), "repository.registered", op, "repository", ensured.repository.id, ensured.repository.id, ensured.repository.version, now, input.attribution, { canonical_remote: ensured.repository.canonical_remote })); result = { result_type: "patchledger.result.repository/v1", command: command.repositoryRegister, repository_id: ensured.repository.id, version: ensured.repository.version, canonical_remote: ensured.repository.canonical_remote }; await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, []))); }); return { result, warnings };
  }

  async quickstartCreate(input: QuickstartCreateCommand): Promise<{ result: QuickstartResult; warnings: Warning[] }> {
    validateCanonicalRemote(input.canonical_remote); validateBaseline(input.baseline); validateQuickstartInput(input.input); validateAttribution(input.attribution);
    const op = opID(input.operation_id);
    const repositoryId = this.newId(); const requirementId = this.newId(); const requirementRevisionId = this.newId(); const issueId = this.newId(); const issueRevisionId = this.newId();
    const hash = operationHash(command.quickstartCreate, { canonical_remote: input.canonical_remote, baseline: input.baseline, requirement: hashRequirementInput(input.input.requirement), issue: hashIssueInput(input.input.issue) }, input.attribution, { canonical_remote: input.canonical_remote, baseline: input.baseline }, {});
    let result!: QuickstartResult; let warnings: Warning[] = [];
    await this.store.write(async (tx) => {
      const replay = await tx.reserveOperation({ id: op, command: command.quickstartCreate, request_hash: hash });
      if (replay) { ({ data: result, warnings } = decodeReplay<QuickstartResult>(replay)); return; }
      const now = await tx.now();
      const ensured = await tx.ensureRepository({ id: repositoryId, canonical_remote: input.canonical_remote, version: 1, created_at: now, attribution: input.attribution });
      if (ensured.created) await tx.appendLedgerEvent(event(this.newId(), "repository.registered", op, "repository", ensured.repository.id, ensured.repository.id, ensured.repository.version, now, input.attribution, { canonical_remote: ensured.repository.canonical_remote }));
      const requirementRevision: RequirementRevision = { id: requirementRevisionId, requirement_id: requirementId, revision_number: 1, summary: input.input.requirement.summary, outcomes: input.input.requirement.outcomes, decisions: input.input.requirement.decisions ?? [], ...(input.input.requirement.open_questions?.length ? { open_questions: input.input.requirement.open_questions } : {}), ...(input.input.requirement.context === undefined ? {} : { context: input.input.requirement.context }) };
      requireIssueReadyRequirement(requirementRevision);
      await tx.createRequirement({ id: requirementId, created_at: now, attribution: input.attribution }, { revision: requirementRevision, created_at: now, attribution: input.attribution });
      await tx.appendLedgerEvent(event(this.newId(), "requirement.created", op, "requirement_revision", requirementRevisionId, undefined, 1, now, input.attribution, { requirement_id: requirementId }));
      const issueRevision = makeIssueRevision(this.newId, issueId, requirementId, requirementRevisionId, issueRevisionId, 1, undefined, input.baseline, input.input.issue, requirementRevision);
      preflightIndependentDevRunContext(issueRevision, requirementRevision, ensured.repository.id, now);
      await tx.createIssue({ id: issueId, requirement_id: requirementId, repository_id: ensured.repository.id, created_at: now, attribution: input.attribution }, { revision: issueRevision, created_at: now, attribution: input.attribution });
      await tx.appendLedgerEvent(event(this.newId(), "issue.created", op, "issue_revision", issueRevisionId, ensured.repository.id, 1, now, input.attribution, { issue_id: issueId, requirement_id: requirementId, requirement_revision_id: requirementRevisionId }));
      if (input.baseline.reachability === "unconfirmed") warnings.push(baselineWarning(input.baseline));
      result = { result_type: "patchledger.result.quickstart/v1", command: command.quickstartCreate, repository_id: ensured.repository.id, repository_version: ensured.repository.version, repository_action: ensured.created ? "registered" : "resolved", canonical_remote: ensured.repository.canonical_remote, requirement_id: requirementId, requirement_revision_id: requirementRevisionId, requirement_revision_number: 1, issue_id: issueId, issue_revision_id: issueRevisionId, issue_revision_number: 1, baseline: input.baseline, next_action: "start_devrun" };
      await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, warnings)));
    });
    return { result, warnings };
  }

  async resolveRepository(remotes: string[]): Promise<RepositoryRecord> { if (!remotes.length) throw repositoryNotResolved("the current clone has no supported Git remotes"); remotes.forEach((remote) => validateCanonicalRemote(remote)); return this.store.read(async (tx) => { const exact: RepositoryRecord[] = []; const seen = new Set<string>(); for (const remote of remotes) { if (seen.has(remote)) continue; seen.add(remote); try { const repository = await tx.findRepositoryByRemote(remote); if (!exact.some((item) => item.id === repository.id)) exact.push(repository); } catch (error) { if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") throw error; } } if (exact.length) { if (exact.length > 1) throw repositoryAmbiguous("multiple registered repositories match this clone"); return exact[0]; } const matched = await matchRepositoriesByKey(tx, remotes); if (!matched.length) throw repositoryNotResolved("none of this clone's normalized remotes are registered"); if (matched.length > 1) throw repositoryAmbiguous(ambiguousByKeyReason); return tx.getRepository(matched[0]); }); }

  async listRepositories(page?: ListPageRequest): Promise<ResourceListResult> {
    const toResource = (item: { id: string; canonical_remote: string; version: number }): Resource => ({ resource_type: "repository", resource_id: item.id, label: item.canonical_remote, version: item.version });
    if (isPagedRequest(page)) return resultSize("Repository list", await readListPage(this.store, { resource: "repository", command: "repository.list", filters: {}, sort: "id:asc", request: page, byteLimit: this.pageByteLimit, load: async (tx, after, limit) => { const result = await tx.listRepositoriesPage(typeof after === "string" ? after : "", limit); return { more: result.more, entries: result.rows.map((item) => ({ resource: toResource(item), after: item.id })) }; } }));
    return withPagingHint("repository", async () => { const resources = await this.store.read(async (tx) => (await tx.listRepositories()).map(toResource)); return resultSize("Repository list", { result_type: "patchledger.result.resource-list/v1", command: "repository.list", resources }); });
  }
  async showRepository(repositoryId: string): Promise<RepositoryDetailResult> { ensureID("repository_id", repositoryId); const result = await this.store.read(async (tx) => { const repository = await tx.getRepository(repositoryId); return { result_type: "patchledger.result.repository-detail/v1", command: "repository.show", repository_id: repository.id, version: repository.version, canonical_remote: repository.canonical_remote, aliases: await tx.listRepositoryRemotes(repositoryId) }; }); return resultSize("Repository detail", result); }
  async activeRepositoryRemotes(repositoryId: string): Promise<string[]> { ensureID("repository_id", repositoryId); return this.store.read(async (tx) => (await tx.listRepositoryRemotes(repositoryId)).filter((item) => item.state === "active").map((item) => item.remote)); }

  /** Whether the given canonical remotes denote `repositoryId`.  Used by
   * workspace open/issue checks so a clone bound over a different transport is
   * still recognized, comparing Repository identity rather than URL spelling. */
  async remotesBelongToRepository(repositoryId: string, remotes: readonly string[]): Promise<boolean> {
    const matched = await this.store.read((tx) => matchRepositoriesByKey(tx, remotes));
    if (matched.includes(repositoryId)) return true;
    const active = await this.activeRepositoryRemotes(repositoryId);
    return remotes.some((remote) => active.includes(remote));
  }

  /** All active remotes (canonical + aliases) of the Repository `canonical`
   * denotes, by exact match then match key.  Target-branch validation compares a
   * local remote against every one of these, so an alias on another host and a
   * different transport both stay valid.  Falls back to the single value when it
   * resolves to nothing (validation then reports the existing error). */
  async repositoryRemotesForResolution(canonical: string): Promise<string[]> {
    validateCanonicalRemote(canonical);
    return this.store.read(async (tx) => {
      try { const exact = await tx.findRepositoryByRemote(canonical); return (await tx.listRepositoryRemotes(exact.id)).filter((item) => item.state === "active").map((item) => item.remote); }
      catch (error) { if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") throw error; }
      const matched = await matchRepositoriesByKey(tx, [canonical]);
      if (matched.length !== 1) return [canonical];
      return (await tx.listRepositoryRemotes(matched[0]!)).filter((item) => item.state === "active").map((item) => item.remote);
    });
  }

  private async repositoryMutation(name: string, eventType: string, operationID: string, repositoryId: string, expectedVersion: number, remote: string, attribution: Attribution, mutate: (tx: Tx) => Promise<RepositoryRecord>): Promise<RepositoryWriteResult> { validateAttribution(attribution); ensureID("repository_id", repositoryId); if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw validation("expected_version", "must be at least 1"); validateCanonicalRemote(remote); const op = opID(operationID); const hash = operationHash(name, { repository_id: repositoryId, expected_version: expectedVersion, remote }, attribution, { repository: { id: repositoryId } }, { expected_version: expectedVersion }); let result!: RepositoryWriteResult; await this.store.write(async (tx) => { const replay = await tx.reserveOperation({ id: op, command: name, request_hash: hash }); if (replay) { result = decodeReplay<RepositoryWriteResult>(replay).data; return; } const repository = await mutate(tx); const now = await tx.now(); const facts: Record<string, string> = eventType === "repository.moved" ? { canonical_remote: repository.canonical_remote } : { remote }; await tx.appendLedgerEvent(event(this.newId(), eventType, op, "repository", repository.id, repository.id, repository.version, now, attribution, facts)); result = { result_type: "patchledger.result.repository/v1", command: name, repository_id: repository.id, version: repository.version, canonical_remote: repository.canonical_remote }; await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, []))); }); return result; }
  async moveRepository(input: MoveRepositoryCommand): Promise<RepositoryWriteResult> { const remote = input.canonical_remote; validateCanonicalRemote(remote); return this.repositoryMutation(command.repositoryMove, "repository.moved", input.operation_id, input.repository_id, input.expected_version, remote, input.attribution, (tx) => tx.moveRepository(input.repository_id, remote, input.expected_version)); }
  async addRepositoryAlias(input: RepositoryAliasCommand): Promise<RepositoryWriteResult> { const remote = input.remote; validateCanonicalRemote(remote); return this.repositoryMutation(command.repositoryAliasAdd, "repository.alias_added", input.operation_id, input.repository_id, input.expected_version, remote, input.attribution, (tx) => tx.addRepositoryAlias(input.repository_id, remote, input.expected_version)); }
  async retireRepositoryAlias(input: RepositoryAliasCommand): Promise<RepositoryWriteResult> { const remote = input.remote; validateCanonicalRemote(remote); return this.repositoryMutation(command.repositoryAliasRetire, "repository.alias_retired", input.operation_id, input.repository_id, input.expected_version, remote, input.attribution, (tx) => tx.retireRepositoryAlias(input.repository_id, remote, input.expected_version)); }

  async createIssue(input: CreateIssueCommand): Promise<{ result: IssueWriteResult; warnings: Warning[] }> {
    input = structuredClone(input);
    ensureID("requirement_id", input.requirement_id); ensureID("repository_id", input.repository_id); const op = opID(input.operation_id); input = { ...input, operation_id: op };
    if (input.requirement_revision_explicit) ensureID("requirement_revision_id", input.requirement_revision_id);
    else if (input.requirement_revision_id) ensureID("requirement_revision_id", input.requirement_revision_id);
    validateIssueInput(input.input); validateBaseline(input.baseline); validateAttribution(input.attribution);
    const prepared = await this.store.read(async (tx) => {
      const current = !input.requirement_revision_id ? await tx.getCurrentRequirementRevision(input.requirement_id) : undefined;
      const requirementRevisionID = input.requirement_revision_id || current?.id;
      if (!requirementRevisionID) throw validation("requirement_revision_id", "could not resolve the current RequirementRevision");
      return { requirementRevisionID, requirementRevision: await tx.getRequirementRevision(input.requirement_id, requirementRevisionID), repository: await tx.getRepository(input.repository_id) };
    });
    const issueID = this.newId(); const revisionID = this.newId();
    const hash = operationHash(command.issueCreate, { requirement_id: input.requirement_id, requirement_revision_id: prepared.requirementRevisionID, requirement_revision_explicit: input.requirement_revision_explicit, repository_id: input.repository_id, baseline: input.baseline, input: hashIssueInput(input.input) }, input.attribution, { requirement_revision: prepared.requirementRevision, repository: { id: prepared.repository.id }, baseline: input.baseline }, { requirement_revision_explicit: input.requirement_revision_explicit });
    let result!: IssueWriteResult; let warnings: Warning[] = [];
    const gates = input.input.target_branch ? [{ repository_id: input.repository_id, operation_id: op,
      content_digest: contentDigestFor(issueWriteBinding({ requirement_revision_id: prepared.requirementRevisionID,
        baseline_oid: input.baseline.git_oid, target_branch: input.input.target_branch, issue_input: input.input })),
      target: input.input.target_branch, what: "publish" }] : [];
    const checks = await this.checkPublications(gates, op);
    await this.store.write(async (tx) => {
      const replay = await tx.reserveOperation({ id: op, command: command.issueCreate, request_hash: hash });
      if (replay) { ({ data: result, warnings } = decodeReplay<IssueWriteResult>(replay)); return; }
      for (const checked of checks) await enforcePublishGate(tx, checked.input, checked.match);
      await tx.lockRequirement(input.requirement_id);
      const currentRequirement = await tx.getCurrentRequirementRevision(input.requirement_id);
      const requirementRevisionID = prepared.requirementRevisionID;
      const requirementRevision = await tx.getRequirementRevision(input.requirement_id, requirementRevisionID);
      requireIssueReadyRequirement(requirementRevision);
      if (!input.requirement_revision_explicit && currentRequirement.id !== requirementRevisionID) throw predecessorConflict("requirement", input.requirement_id, requirementRevisionID, currentRequirement.id);
      if (input.requirement_revision_explicit && requirementRevision.id !== currentRequirement.id) warnings.push(historicalRequirementWarning(requirementRevision.id, currentRequirement.id));
      await tx.getRepository(input.repository_id);
      const issueRevision = makeIssueRevision(this.newId, issueID, input.requirement_id, requirementRevisionID, revisionID, 1, undefined, input.baseline, input.input, requirementRevision);
      const now = await tx.now();
      preflightIndependentDevRunContext(issueRevision, requirementRevision, input.repository_id, now);
      await tx.createIssue({ id: issueID, requirement_id: input.requirement_id, repository_id: input.repository_id, created_at: now, attribution: input.attribution }, { revision: issueRevision, created_at: now, attribution: input.attribution });
      await tx.appendLedgerEvent(event(this.newId(), "issue.created", op, "issue_revision", revisionID, input.repository_id, 1, now, input.attribution, { issue_id: issueID, requirement_id: input.requirement_id, requirement_revision_id: requirementRevisionID, ...publicationPreflightFacts(checks, input.input.target_branch, input.baseline.git_oid) }));
      result = { result_type: "patchledger.result.issue-write/v1", command: command.issueCreate, requirement_id: input.requirement_id, requirement_revision_id: requirementRevisionID, issue_id: issueID, issue_revision_id: revisionID, revision_number: 1, baseline: input.baseline };
      if (input.baseline.reachability === "unconfirmed") warnings.push(baselineWarning(input.baseline));
      await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, warnings)));
    });
    return { result, warnings };
  }

  async reviseIssue(input: ReviseIssueCommand): Promise<{ result: IssueWriteResult; warnings: Warning[] }> {
    input = structuredClone(input);
    ensureID("issue_id", input.issue_id); ensureID("expected_predecessor_id", input.expected_predecessor_id); const op = opID(input.operation_id); input = { ...input, operation_id: op };
    if (input.requirement_revision_explicit) ensureID("requirement_revision_id", input.requirement_revision_id);
    else if (input.requirement_revision_id) ensureID("requirement_revision_id", input.requirement_revision_id);
    validateIssueInput(input.input); validateBaseline(input.baseline); validateAttribution(input.attribution);
    const prepared = await this.store.read(async (tx) => {
      const issue = await tx.getIssue(input.issue_id);
      const predecessor = await tx.getIssueRevision(input.issue_id, input.expected_predecessor_id);
      const requirementRevisionID = input.requirement_revision_explicit ? input.requirement_revision_id : predecessor.requirement_revision_id;
      return { issue, predecessor, requirementRevision: await tx.getRequirementRevision(issue.requirement_id, requirementRevisionID), repository: await tx.getRepository(issue.repository_id) };
    });
    const revisionID = this.newId();
    const payload: Record<string, unknown> = { issue_id: input.issue_id, expected_predecessor_id: input.expected_predecessor_id, requirement_revision_explicit: input.requirement_revision_explicit, baseline: input.baseline, input: hashIssueInput(input.input) };
    if (input.requirement_revision_id) payload.requirement_revision_id = input.requirement_revision_id;
    const hash = operationHash(command.issueRevise, payload, input.attribution, { requirement_revision: prepared.requirementRevision, repository: { id: prepared.repository.id }, baseline: input.baseline }, { expected_predecessor_id: input.expected_predecessor_id, requirement_revision_explicit: input.requirement_revision_explicit });
    let result!: IssueWriteResult; let warnings: Warning[] = [];
    const target = input.input.target_branch ?? prepared.predecessor.target_branch;
    const gates = target ? [{ repository_id: prepared.issue.repository_id, operation_id: op,
      content_digest: contentDigestFor(issueWriteBinding({ requirement_revision_id: prepared.requirementRevision.id,
        predecessor_requirement_revision_id: prepared.predecessor.requirement_revision_id, issue_id: input.issue_id,
        expected_predecessor_id: input.expected_predecessor_id, baseline_oid: input.baseline.git_oid, target_branch: target, issue_input: input.input })),
      target, what: "publish" }] : [];
    const checks = await this.checkPublications(gates, op);
    await this.store.write(async (tx) => {
      const replay = await tx.reserveOperation({ id: op, command: command.issueRevise, request_hash: hash });
      if (replay) { ({ data: result, warnings } = decodeReplay<IssueWriteResult>(replay)); return; }
      for (const checked of checks) await enforcePublishGate(tx, checked.input, checked.match);
      const issue = await tx.getIssue(input.issue_id); await tx.lockRequirement(issue.requirement_id); const current = await tx.getCurrentIssueRevision(input.issue_id);
      if (current.id !== input.expected_predecessor_id) throw predecessorConflict("issue", input.issue_id, input.expected_predecessor_id, current.id);
      const currentRequirement = await tx.getCurrentRequirementRevision(issue.requirement_id);
      const requirementRevisionID = input.requirement_revision_explicit ? input.requirement_revision_id : current.requirement_revision_id;
      const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, requirementRevisionID);
      requireIssueReadyRequirement(requirementRevision);
      if (!input.requirement_revision_explicit && currentRequirement.id !== current.requirement_revision_id) warnings.push(requirementRevisionAvailableWarning(current.requirement_revision_id, currentRequirement.id));
      if (input.requirement_revision_explicit && requirementRevision.id !== currentRequirement.id) warnings.push(historicalRequirementWarning(requirementRevision.id, currentRequirement.id));
      const revision = makeIssueRevision(this.newId, input.issue_id, issue.requirement_id, requirementRevisionID, revisionID, current.revision_number + 1, current.id, input.baseline, input.input, requirementRevision);
      const now = await tx.now();
      preflightIndependentDevRunContext(revision, requirementRevision, issue.repository_id, now);
      await tx.appendIssueRevision({ revision, created_at: now, attribution: input.attribution });
      await tx.appendLedgerEvent(event(this.newId(), "issue.revised", op, "issue_revision", revision.id, issue.repository_id, revision.revision_number, now, input.attribution, { issue_id: input.issue_id, requirement_id: issue.requirement_id, predecessor_revision_id: current.id, requirement_revision_id: requirementRevision.id, ...publicationPreflightFacts(checks, target, revision.baseline.git_oid) }));
      result = { result_type: "patchledger.result.issue-write/v1", command: command.issueRevise, requirement_id: issue.requirement_id, requirement_revision_id: requirementRevisionID, issue_id: input.issue_id, issue_revision_id: revision.id, revision_number: revision.revision_number, baseline: input.baseline };
      if (input.baseline.reachability === "unconfirmed") warnings.push(baselineWarning(input.baseline));
      await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, warnings)));
    });
    return { result, warnings };
  }

  async listIssues(requirementId = "", options: IssueListOptions = {}, page?: ListPageRequest): Promise<ResourceListResult> {
    if (requirementId) ensureID("requirement_id", requirementId);
    const filter = validateIssueListOptions(options);
    const sort = filter.sort ?? "id";
    const query = { sort, ...(requirementId ? { requirement_id: requirementId } : {}), ...(filter.repository_id ? { repository_id: filter.repository_id } : {}), ...(filter.status ? { status: filter.status } : {}), ...(filter.has_open_dev_run === undefined ? {} : { has_open_dev_run: filter.has_open_dev_run }) };
    const toResources = async (tx: ReadTx, items: IssueListItem[]): Promise<Resource[]> => {
      const result: Resource[] = [];
      for (const item of items) {
        // The board mirrors `issue show`: counts come from the ledger and the
        // Selection is read through the same validated record.
        const record = await tx.getSelection(item.issue_revision_id);
        const selectionState = record?.candidate_id ? "selected" : "unselected";
        if ((selectionState === "selected") !== item.selected) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Issue list Selection does not match the stored Selection", false, { resource_type: "issue", resource_id: item.id });
        const completion = completionView(await tx.getCompletion(item.issue_revision_id));
        const board = deriveIssueBoard(selectionState, item.candidate_count, item.open_dev_run_count, completion.state === "completed");
        if (filter.status && (filter.status === "incomplete" ? board.status === "completed" : board.status !== filter.status)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Issue list status filter does not match the derived board", false, { resource_type: "issue", resource_id: item.id });
        result.push({ resource_type: "issue", resource_id: item.id, label: item.summary, version: item.revision_number, requirement: { id: item.requirement_id, version: item.requirement_version }, repository: { id: item.repository_id, canonical_remote: item.canonical_remote }, board: { ...board, completion, open_dev_run_count: item.open_dev_run_count, candidate_count: item.candidate_count, selection: { state: selectionState, version: record?.version ?? 0, ...(record?.candidate_id ? { candidate_id: record.candidate_id } : {}) } }, last_activity: item.last_activity ?? null });
      }
      return result;
    };
    if (isPagedRequest(page)) {
      const bound = { requirement_id: requirementId || null, repository_id: filter.repository_id ?? null, status: filter.status ?? null, has_open_dev_run: filter.has_open_dev_run ?? null, sort };
      return resultSize("Issue list", await readListPage(this.store, { resource: "issue", command: "issue.list", filters: bound, query, sort: sort === "activity" ? "activity:desc,id:asc" : "id:asc", request: page, byteLimit: this.pageByteLimit, load: async (tx, after, limit) => {
        if (filter.repository_id) await tx.getRepository(filter.repository_id);
        const result = await tx.listIssuesPage(requirementId, after ?? "", limit, filter);
        await tx.attachIssueActivity(result.rows);
        const resources = await toResources(tx, result.rows);
        return { more: result.more, entries: result.rows.map((item, index) => ({ resource: resources[index], after: sort === "activity" ? { key: item.order_key ?? "", id: item.id } : item.id })) };
      } }));
    }
    return withPagingHint("issue", async () => {
      const resources = await this.store.read(async (tx) => {
        if (filter.repository_id) await tx.getRepository(filter.repository_id);
        return toResources(tx, await tx.listIssues(requirementId, filter));
      });
      return resultSize("Issue list", { result_type: "patchledger.result.resource-list/v1", command: "issue.list", resources, query });
    });
  }

  async loadIssue(issueId: string, revisionId = ""): Promise<InternalIssueDetailResult> {
    ensureID("issue_id", issueId);
    if (revisionId) ensureID("revision_id", revisionId);
    const result = await this.store.read(async (tx) => {
      const issue = await tx.getIssue(issueId); const issueRevision = revisionId ? await tx.getIssueRevision(issueId, revisionId) : await tx.getCurrentIssueRevision(issueId); const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id); const repository = await tx.getRepository(issue.repository_id);
      const open = await tx.openDevRunCount(issueRevision.id); const candidates = await tx.candidateCount(issueRevision.id); const selection = await this.selectionView(tx, issueRevision.id); const completion = completionView(await tx.getCompletion(issueRevision.id)); const { status, next_action: nextAction } = deriveIssueBoard(selection.state, candidates, open, completion.state === "completed");
      return { result_type: "patchledger.result.issue-detail/v1", command: "issue.show", requirement_revision: requirementRevision, repository: { id: repository.id, canonical_remote: repository.canonical_remote }, baseline: issueRevision.baseline, issue_revision: issueRevision, board: { status, next_action: nextAction, completion, selection, open_dev_run_count: open, candidate_count: candidates } };
    });
    return resultSize("Issue detail", result);
  }

  async showIssue(issueId: string, revisionId = ""): Promise<IssueDetailResult> {
    const detail = await this.loadIssue(issueId, revisionId);
    return { result_type: detail.result_type, command: detail.command, requirement: requirementVersionForContext(detail.requirement_revision), repository: detail.repository, baseline: detail.baseline, issue: issueVersionForContext(detail.issue_revision, detail.requirement_revision), board: detail.board };
  }

  async showIssueVersion(issueId: string, version: number): Promise<IssueDetailResult> {
    ensureID("issue_id", issueId);
    this.validateSelectionVersion("issue_version", version);
    const revision = await this.store.read(tx => tx.getIssueRevisionByNumber(issueId, version));
    return this.showIssue(issueId, revision.id);
  }

  async startDevRun(input: StartDevRunCommand): Promise<{ result: DevRunContextResult; warnings: Warning[] }> {
    input = structuredClone(input);
    if (input.execution_mode !== undefined) validateModeSelection(input.execution_mode);
    if (input.prepare_only !== undefined && typeof input.prepare_only !== "boolean") throw validation("prepare_only", "must be boolean");
    ensureID("issue_id", input.issue_id); ensureID("issue_revision_id", input.issue_revision_id); const op = opID(input.operation_id); input = { ...input, operation_id: op }; validateAttribution(input.attribution);
    if (input.dev_run_id !== undefined) ensureID("dev_run_id", input.dev_run_id);
    validateCanonicalRemote(input.repository_remote_snapshot);
    if (input.development) validateDevelopment(input.development);
    if (input.artifact_restoration) throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "Base-plus-patch restoration is unsupported; use a fixed Git Candidate source");
    validateOptionalLongText("exploration_brief", input.exploration_brief);
    const resolved = await this.store.read(async (tx) => {
      const issue = await tx.getIssue(input.issue_id);
      const issueRevision = await tx.getIssueRevision(input.issue_id, input.issue_revision_id);
      return { issue, issueRevision, requirementRevision: await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id), repository: await tx.getRepository(issue.repository_id) };
    });
    if (input.base_commit !== undefined && !isGitOID(input.base_commit)) throw validation("base_commit", "must be a qualified Git commit OID");
    if (input.base_commit !== undefined && !resolved.issueRevision.target_branch) throw validation("base_commit", "requires an Issue target branch");
    const payload: Record<string, unknown> = { ...(input.execution_mode ? { execution_mode: input.execution_mode } : {}), ...(input.prepare_only ? { prepare_only: true } : {}), ...(input.artifact_restoration ? { artifact_restoration: input.artifact_restoration } : {}), ...(input.development ? { development: input.development } : {}), ...(input.base_commit ? { base_commit: input.base_commit } : {}), issue_id: input.issue_id, issue_revision_id: input.issue_revision_id, issue_revision_explicit: input.issue_revision_explicit, repository_remote_snapshot: input.repository_remote_snapshot };
    if (input.exploration_brief !== undefined) payload.exploration_brief = input.exploration_brief;
    if (input.refines_candidate_id !== undefined) {
      ensureID("refines_candidate_id", input.refines_candidate_id);
      payload.refines_candidate_id = input.refines_candidate_id;
    }
    const hash = operationHash(command.devrunStart, payload, input.attribution, { requirement_revision: resolved.requirementRevision, issue_revision: hashableIssueRevision(resolved.issueRevision), repository: { id: resolved.repository.id }, baseline: resolved.issueRevision.baseline, repository_remote_snapshot: input.repository_remote_snapshot }, { issue_revision_id: input.issue_revision_id, issue_revision_explicit: input.issue_revision_explicit });
    const runID = input.dev_run_id ?? this.newId(); let result!: DevRunContextResult; let warnings: Warning[] = [];
    const gateInput = { issue_revision_id: resolved.issueRevision.id, repository_id: resolved.repository.id,
      expected_commit: input.base_commit ?? resolved.issueRevision.baseline.git_oid, what: "start", operation_id: op };
    let checked: PreflightMatch | undefined;
    if (resolved.issueRevision.target_branch && !input.prepare_only && !await this.store.read(tx => tx.getOperation(op))) {
      if (input.refines_candidate_id) throw stateConflict("preflight", runID, "restore and synchronize the parent with devrun prepare, then admit the actual inputs");
      if (!this.preflightCoordinator) throw stateConflict("preflight", runID, "target start requires a configured fresh-target coordinator");
      checked = await this.preflightCoordinator.start(gateInput);
    }
    await this.store.write(async (tx) => {
      const replay = await tx.reserveOperation({ id: op, command: command.devrunStart, request_hash: hash }); if (replay) { ({ data: result, warnings } = decodeReplay<DevRunContextResult>(replay)); return; }
      const issue = await tx.getIssue(input.issue_id); const current = await tx.getCurrentIssueRevision(input.issue_id); const issueRevisionID = input.issue_revision_id; const issueRevision = await tx.getIssueRevision(input.issue_id, issueRevisionID); if (!input.issue_revision_explicit && issueRevisionID !== current.id) throw versionConflict("issue", input.issue_id, issueRevision.revision_number, current.revision_number); if (input.issue_revision_explicit && issueRevisionID !== current.id) warnings.push({ code: "HISTORICAL_ISSUE_VERSION", message: `the DevRun is bound to historical Issue Version ${issueRevision.revision_number}; current is ${current.revision_number}` });
      const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id); const repository = await tx.getRepository(issue.repository_id); if (repository.canonical_remote !== input.repository_remote_snapshot) throw validation("repository_remote_snapshot", "does not match the Issue Repository");
      let baseCommit = issueRevision.target_branch ? input.base_commit ?? issueRevision.baseline.git_oid : undefined;
      let refinement: RefinementContext | undefined;
      if (input.refines_candidate_id !== undefined) {
        const parent = await tx.getCandidate(input.refines_candidate_id);
        validateCandidateBindings(parent, issue, issueRevision, requirementRevision);
        if (parent.candidate.issue_revision_id !== issueRevision.id) throw validation("refines_candidate_id", "parent Candidate must belong to the same IssueRevision");
        await tx.lockCandidateVerifications(parent.candidate.id);
        refinement = await this.refinementContext(tx as ReadTx, parent);
        if (issueRevision.target_branch) {
          const parentBase = parent.candidate.base_commit ?? issueRevision.baseline.git_oid;
          if (input.base_commit && input.base_commit !== parentBase) throw validation("base_commit", "refinement must start at the parent Candidate base");
          baseCommit = parentBase;
        }
      }
      if (issueRevision.target_branch && !input.prepare_only) {
        if (!checked) throw stateConflict("preflight", runID, "fresh target check is missing");
        await enforceStartGate(tx, { ...gateInput, expected_commit: baseCommit! }, checked);
      }
      const context = await startDevRunInTransaction(tx, {
        id: runID, ...(input.execution_mode ? { execution_mode: input.execution_mode } : {}), ...(input.artifact_restoration ? { artifact_restoration: input.artifact_restoration } : {}), ...(input.development ? { development: input.development } : {}), ...(baseCommit ? { base_commit: baseCommit } : {}), issue_revision: issueRevision, requirement_revision: requirementRevision,
        repository_id: repository.id, repository_remote_snapshot: input.repository_remote_snapshot || repository.canonical_remote,
        operation_id: op, attribution: input.attribution,
        ...(input.exploration_brief === undefined ? {} : { exploration_brief: input.exploration_brief }),
        ...(input.refines_candidate_id === undefined ? {} : { refines_candidate_id: input.refines_candidate_id }),
        ...(refinement ? { refinement } : {}),
      }, this.newId);
      if (issueRevision.target_branch) {
        if (input.prepare_only) await savePreparation(tx, op, runID, input.attribution);
        else await saveAdmission(tx, op, runID, checked!, input.attribution);
      }
      this.addSnapshotRelation(context);
      const preflight = await devRunPreflightView(tx, runID);
      const visibleContext = preflight ? { ...context, preflight } : context;
      contextSize(visibleContext);
      result = { result_type: "patchledger.result.devrun-context/v1", command: command.devrunStart, context: visibleContext }; await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, warnings)));
    }); return { result, warnings };
  }

  // Emit the skeleton of a CandidateSubmission for an open DevRun so a
  // developer can fill in explanations/evidence instead of reconstructing
  // every goal/constraint/criterion ID by hand.
  async assertDevelopmentAdmission(devRunId: string): Promise<void> {
    ensureID("dev_run_id", devRunId);
    await this.store.read(tx => assertDevRunAdmitted(tx, devRunId));
  }

  async candidateSubmissionTemplate(devRunId: string, artifact?: CandidateArtifact, language?: "zh-CN"): Promise<CandidateTemplateResult> {
    ensureID("dev_run_id", devRunId);
    const context = await this.store.read(async (tx) => {
      await assertDevRunAdmitted(tx, devRunId);
      return this.buildDevRunContext(tx, devRunId, true, []);
    });
    const issueRevision = context.context.issue;
    const claims: ClaimInput[] = [];
    for (const goal of issueRevision.goals) {
      claims.push({ target_type: "goal", target_id: goal.id, explanation: "", criteria: goal.criteria.map((criterion) => ({ criterion_id: criterion.id, explanation: "", evidence: [] })) });
    }
    for (const constraint of issueRevision.constraints) {
      claims.push({ target_type: "constraint", target_id: constraint.id, explanation: "", criteria: constraint.criteria.map((criterion) => ({ criterion_id: criterion.id, explanation: "", evidence: [] })) });
    }
    if (artifact) {
      validateCandidateArtifact(artifact);
      const changeIndex = indexCandidateChanges(artifact);
      const draftClaims = claims.map((claim) => ({
        ...claim,
        explanation: language === "zh-CN" ? "TODO: 用中文说明候选如何满足此目标或约束" : "TODO: explain how this Candidate satisfies the target",
        criteria: claim.criteria.map((criterion) => ({ ...criterion, explanation: language === "zh-CN" ? "TODO: 用中文说明如何实现此标准" : "TODO: explain how this Criterion is implemented", self_verification: { status: "not_verified" as const, explanation: language === "zh-CN" ? "TODO: 用中文记录检查结果；未检查则说明原因" : "TODO: record checks or explain why this Criterion was not verified" } })),
      }));
      const submission: CandidateSubmissionV2Input = {
        format: "patchledger.candidate-submission/v2",
        explanation: language === "zh-CN" ? "TODO: 用中文概述候选实现与重要取舍" : "TODO: summarize the Candidate and important tradeoffs",
        claims: draftClaims,
        change_index: { format: changeIndex.format, patch_digest: changeIndex.patch_digest, units_digest: changeIndex.units_digest },
        change_rationales: changeIndex.change_units.map((unit) => ({
          change_refs: [unit.change_unit_id],
          relation: "implements",
          target_refs: [],
          rationale: language === "zh-CN"
            ? `TODO: 用中文说明 ${unit.display_path}${unit.kind === "hunk" && unit.new_range ? ` 第 ${unit.new_range.start}–${unit.new_range.start + Math.max(unit.new_range.lines - 1, 0)} 行` : " 的文件级变更"}为何存在`
            : `TODO: explain why ${unit.display_path}${unit.kind === "hunk" && unit.new_range ? ` lines ${unit.new_range.start}-${unit.new_range.start + Math.max(unit.new_range.lines - 1, 0)}` : " (file-level change)"} exists`,
          alternatives: [],
          risks: [],
        })),
      };
      return resultSize("Candidate template", {
        result_type: "patchledger.result.candidate-template/v1",
        command: "candidate.template",
        dev_run_id: devRunId,
        change_index: changeIndex,
        submission,
      });
    }
    return resultSize("Candidate template", {
      result_type: "patchledger.result.candidate-template/v1",
      command: "candidate.template",
      dev_run_id: devRunId,
      submission: {
        format: "patchledger.candidate-submission/v1",
        explanation: "",
        claims,
      },
    });
  }

  // Emit the skeleton of a VerificationReport for a Candidate's blind phase.
  // Every goal/constraint/criterion appears once with empty verdict stages so
  // the verifier only fills in findings.
  async verificationReportTemplate(candidateId: string, language?: "zh-CN", role: VerificationRole = "contract"): Promise<{ result_type: string; command: string; candidate_id: string; blind_context_digest: string; result_tree_oid: string; report: VerificationReportInput | QualityReviewReportInput }> {
    ensureID("candidate_id", candidateId);
    const context = await this.verificationContext(candidateId, "blind", role);
    if (context.context.phase !== "blind") throw new Error("verification template requires the blind context");
    return role === "quality" ? qualityTemplateFromBlindContext(context.context, language) : verificationTemplateFromBlindContext(context.context, language);
  }

  async devRunContext(devRunId: string, allowSubmitted = false, includeVerificationIds: string[] = []): Promise<DevRunContextResult> {
    ensureID("dev_run_id", devRunId);
    if (includeVerificationIds.length > 2) throw validation("include_verification", "must contain at most two Verification IDs");
    includeVerificationIds.forEach((id) => ensureID("include_verification", id));
    if (new Set(includeVerificationIds).size !== includeVerificationIds.length) throw validation("include_verification", "must not contain duplicate Verification IDs");
    return this.store.read(async (tx) => this.buildDevRunContext(tx, devRunId, allowSubmitted, includeVerificationIds));
  }

  async candidateSubmitContext(devRunId: string): Promise<DevRunContextResult> {
    ensureID("dev_run_id", devRunId);
    return this.store.read(async (tx) => this.buildDevRunContext(tx, devRunId, true, []));
  }

  async abandonDevRun(input: AbandonDevRunCommand): Promise<DevRunMutationResult> {
    ensureID("dev_run_id", input.dev_run_id); const op = opID(input.operation_id); input = { ...input, operation_id: op }; if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) throw validation("expected_version", "must be at least 1"); validateOptionalLongText("reason", input.reason); validateAttribution(input.attribution); let result!: DevRunMutationResult;
    const payload: Record<string, unknown> = { dev_run_id: input.dev_run_id, expected_version: input.expected_version };
    if (input.reason !== undefined) payload.reason = input.reason;
    const hash = operationHash("devrun.abandon", payload, input.attribution, { dev_run_id: input.dev_run_id }, { expected_version: input.expected_version });
    await this.store.write(async (tx) => { const replay = await tx.reserveOperation({ id: op, command: "devrun.abandon", request_hash: hash }); if (replay) { result = decodeReplay<DevRunMutationResult>(replay).data; return; } const { run } = await abandonDevRunInTransaction(tx, input, this.newId); result = { result_type: "patchledger.result.devrun-mutation/v1", command: "devrun.abandon", dev_run_id: run.id, version: run.version, state: run.state }; await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, []))); }); return result;
  }

  /**
   * Appends the audit event for a removed managed worktree. The receipt's own
   * operation and event identities make the write idempotent: a replay or a
   * later compensating cleanup returns the stored summary and adds nothing.
   */
  async recordDevRunWorktreeRemoval(receipt: DevRunWorktreeRemoval): Promise<DevRunWorktreeDeletionSummary> {
    ensureID("dev_run_id", receipt.dev_run_id); const op = opID(receipt.operation_id); ensureID("event_id", receipt.event_id); validateAttribution(receipt.attribution);
    const name = "devrun.cleanup";
    const payload = { dev_run_id: receipt.dev_run_id, worktree_path: receipt.worktree_path, discard_changes: receipt.discard_changes, entry_count: receipt.entry_count };
    const hash = operationHash(name, payload, receipt.attribution, { dev_run_id: receipt.dev_run_id }, {});
    return this.store.write(async (tx) => {
      const replay = await tx.reserveOperation({ id: op, command: name, request_hash: hash });
      if (replay) return decodeReplay<DevRunWorktreeRemovalResult>(replay).data.deletion_summary;
      const run = await tx.getDevRun(receipt.dev_run_id);
      const repositoryId = (await tx.getIssue((await tx.getIssueRevisionById(run.issue_revision_id)).issue_id)).repository_id;
      const occurredAt = await tx.now();
      await tx.appendLedgerEvent(event(receipt.event_id, "devrun.worktree_removed", op, "dev_run", run.id, repositoryId, run.version, occurredAt, receipt.attribution, { dev_run_id: receipt.dev_run_id, worktree_path: receipt.worktree_path, discard_changes: String(receipt.discard_changes), entry_count: String(receipt.entry_count) }));
      const result: DevRunWorktreeRemovalResult = { result_type: "patchledger.result.devrun-worktree-removal/v1", command: name, deletion_summary: { ...payload, occurred_at: occurredAt } };
      await tx.completeOperation(op, JSON.stringify(envelopeData(result, op)));
      return result.deletion_summary;
    });
  }

  /** Read-only lookup so an identical operation id returns the original summary even after the local receipt is closed. */
  async completedDevRunWorktreeRemoval(operationId: string, devRunId: string): Promise<DevRunWorktreeDeletionSummary | undefined> {
    ensureID("operation_id", operationId); ensureID("dev_run_id", devRunId);
    return this.store.read(async (tx) => {
      const replay = await tx.getOperation(operationId);
      if (!replay) return undefined;
      // This is a read-only lookup, so it has no request hash of its own. Like
      // replayCandidateSubmit and completedDeliveryLinkOperation, it reports the
      // stored hash on both sides rather than an empty string, which the error
      // contract rejects: request_hash and existing_request_hash are sha256.
      if (replay.command !== "devrun.cleanup") throw idempotencyConflict(replay.command, replay.request_hash, replay.request_hash);
      const summary = decodeReplay<DevRunWorktreeRemovalResult>(replay).data.deletion_summary;
      if (summary.dev_run_id !== devRunId) throw idempotencyConflict(replay.command, replay.request_hash, replay.request_hash);
      return summary;
    });
  }

  async listDevRuns(issueId = "", options: DevRunListOptions = {}, page?: ListPageRequest): Promise<ResourceListResult> {
    if (issueId) ensureID("issue_id", issueId);
    const filter = validateDevRunListOptions(issueId, options);
    const query = { ...(issueId ? { issue_id: issueId } : {}), ...(filter.issue_version === undefined ? {} : { issue_version: filter.issue_version }), ...(filter.repository_id ? { repository_id: filter.repository_id } : {}), ...(filter.state ? { state: filter.state } : {}) };
    const toResource = (item: DevRunListItem): Resource => ({ resource_type: "dev_run", resource_id: item.id, label: item.state, version: item.version, state: item.state, issue: { id: item.issue_id, version: item.issue_version }, repository: { id: item.repository_id, canonical_remote: item.canonical_remote } });
    if (isPagedRequest(page)) {
      const bound = { issue_id: issueId || null, issue_version: filter.issue_version ?? null, repository_id: filter.repository_id ?? null, state: filter.state ?? null };
      return resultSize("DevRun list", await readListPage(this.store, { resource: "dev_run", command: "devrun.list", filters: bound, query, sort: "id:asc", request: page, byteLimit: this.pageByteLimit, load: async (tx, after, limit) => {
        if (filter.repository_id) await tx.getRepository(filter.repository_id);
        const result = await tx.listDevRunsPage(issueId, filter, typeof after === "string" ? after : "", limit);
        return { more: result.more, entries: result.rows.map((item) => ({ resource: toResource(item), after: item.id })) };
      } }));
    }
    return withPagingHint("devrun", async () => {
      const resources = await this.store.read(async (tx) => { if (filter.repository_id) await tx.getRepository(filter.repository_id); return (await tx.listDevRuns(issueId, filter)).map(toResource); });
      return resultSize("DevRun list", { result_type: "patchledger.result.resource-list/v1", command: "devrun.list", resources, query });
    });
  }

  async showDevRun(devRunId: string): Promise<DevRunDetailResult> { ensureID("dev_run_id", devRunId); const result = await this.store.read(async (tx) => { const run = await tx.getDevRun(devRunId); const revision = await tx.getIssueRevisionById(run.issue_revision_id); return { result_type: "patchledger.result.devrun-detail/v1", command: "devrun.show", ...(run.execution_mode ? { execution_mode: run.execution_mode } : {}), ...(run.initial_base_commit ? { initial_base_commit: run.initial_base_commit } : {}), ...(run.artifact_restoration ? { artifact_restoration: run.artifact_restoration } : {}), ...(run.development ? { development: run.development } : {}), dev_run_id: run.id, issue: { id: revision.issue_id, version: revision.revision_number }, version: run.version, state: run.state, ...(run.exploration_brief ? { exploration_brief: run.exploration_brief } : {}), ...(run.refines_candidate_id ? { refines_candidate_id: run.refines_candidate_id } : {}), ...(run.abandon_reason ? { abandon_reason: run.abandon_reason } : {}), created_at: run.created_at, attribution: run.attribution }; }); return resultSize("DevRun detail", result); }

  async submittedResultTree(devRunId: string): Promise<string | undefined> {
    ensureID("dev_run_id", devRunId);
    return this.store.read(async (tx) => (await tx.getCandidateByDevRun(devRunId))?.candidate.result_tree_oid);
  }

  /** Ledger-side facts for the read-only DevRun reconciliation view. Reads only. */
  async reconcileLedger(devRunId: string): Promise<LedgerReconcileFacts> {
    ensureID("dev_run_id", devRunId);
    return this.store.read(async (tx) => {
      const run = await tx.getDevRun(devRunId);
      const revision = await tx.getIssueRevisionById(run.issue_revision_id);
      const ref = await tx.findCandidateArtifactRef({ dev_run_id: devRunId });
      const selection = await tx.getSelection(revision.id);
      const pendingSync = run.base_commit ? (await tx.listRuntimeRecords("runtime_operation", devRunId)).find(row => isSyncRecord(row) && !syncTerminal(syncData(row))) : undefined;
      return {
        dev_run: { id: run.id, version: run.version, state: run.state },
        issue: { id: revision.issue_id, version: revision.revision_number },
        baseline_oid: run.base_commit ?? revision.baseline.git_oid,
        ...(pendingSync ? { pending_sync: { id: pendingSync.id, phase: syncData(pendingSync).phase } } : {}),
        ...(ref ? { candidate: { candidate_id: ref.candidate_id, result_tree_oid: ref.result_tree_oid, is_selected: selection?.candidate_id === ref.candidate_id } } : {}),
        selection: { state: selection?.candidate_id ? "selected" as const : "unselected" as const, version: selection?.version ?? 0 },
      };
    });
  }

  /** Canonical-artifact descriptor of one Candidate; never returns patch bytes. */
  async candidateArtifactDescriptor(candidateId: string): Promise<CandidateArtifactDescriptor> {
    ensureID("candidate_id", candidateId);
    return this.store.read(async (tx) => {
      const ref = await tx.findCandidateArtifactRef({ candidate_id: candidateId });
      if (!ref) throw notFound("candidate", candidateId);
      const revision = await tx.getIssueRevisionById(ref.issue_revision_id);
      return {
        candidate_id: ref.candidate_id, ...(ref.git_artifact ? { git_artifact: ref.git_artifact } : {}), ...(ref.source ? { source: ref.source, repository_id: (await tx.getIssue(revision.issue_id)).repository_id } : {}),
        base_commit: ref.base_commit ?? revision.baseline.git_oid,
        base_commit_source: ref.base_commit ? "candidate" as const : "issue_version_baseline" as const,
        patch_digest: ref.patch_digest,
        artifact_format: ref.artifact_format,
        ...(ref.patch_size === undefined ? {} : { patch_size: ref.patch_size }),
        result_tree_oid: ref.result_tree_oid,
      };
    });
  }

  /** Everything `candidate replay-check` needs from the ledger; damaged artifacts are reported, not thrown. */
  async replaySubject(selector: { candidate_id: string } | { issue_id: string; issue_version: number }): Promise<ReplaySubject> {
    if ("candidate_id" in selector) ensureID("candidate_id", selector.candidate_id); else { ensureID("issue_id", selector.issue_id); this.validateSelectionVersion("issue_version", selector.issue_version); }
    return this.store.read(async (tx) => {
      let candidateId: string;
      if ("candidate_id" in selector) candidateId = selector.candidate_id;
      else {
        const revision = await tx.getIssueRevisionByNumber(selector.issue_id, selector.issue_version);
        const selected = (await tx.getSelection(revision.id))?.candidate_id;
        if (!selected) throw stateConflict("issue", selector.issue_id, "the Issue Version has no selected Candidate");
        candidateId = selected;
      }
      const ref = await tx.findCandidateArtifactRef({ candidate_id: candidateId });
      if (!ref) throw notFound("candidate", candidateId);
      const revision = await tx.getIssueRevisionById(ref.issue_revision_id);
      const issue = await tx.getIssue(revision.issue_id);
      const repository = await tx.getRepository(issue.repository_id);
      const remotes = (await tx.listRepositoryRemotes(repository.id)).filter((item) => item.state === "active").map((item) => item.remote);
      let patch: ReplaySubject["patch"];
      try { patch = { state: "present", bytes: (await tx.getCandidate(ref.candidate_id)).artifact.patch }; }
      catch (error) {
        if (error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR" && error.details.reason === "local_objects_incomplete") patch = { state: "unavailable" };
        else if (error instanceof DomainError && error.code === "NOT_FOUND") patch = { state: "missing" };
        else if (error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR") patch = { state: "corrupt", reason: error.message };
        else throw error;
      }
      return {
        candidate_id: ref.candidate_id,
        issue: { id: revision.issue_id, version: revision.revision_number },
        repository_id: repository.id,
        registered_remotes: remotes,
        base_commit: ref.base_commit ?? revision.baseline.git_oid,
        patch_digest: ref.patch_digest,
        result_tree_oid: ref.result_tree_oid,
        patch,
      };
    });
  }

  async recordDeliveryException(input: { operation_id: string; issue_id: string; issue_version: number; selection_id: string; selection_version: number; candidate_id: string; source_commit: string; target_commit: string; reason: string; attribution: Attribution }, onlyIfRecorded = false): Promise<string | undefined> {
    ensureID("operation_id", input.operation_id); validateAttribution(input.attribution);
    if (!input.reason.trim() || input.reason.length > 4096 || !isGitOID(input.source_commit) || !isGitOID(input.target_commit)) throw validation("delivery_exception", "explicit bounded reason and fixed source/target commits required");
    return this.store.write(async tx => {
      // A prior SQL receipt is historical evidence, not enduring preparation eligibility.
      // Lock the operation before aggregate locks, including the no-new-decision path.
      const existing = onlyIfRecorded ? await tx.getOperation(input.operation_id, true) : undefined;
      const replay = !onlyIfRecorded || existing
        ? await tx.reserveOperation({ id: input.operation_id, command: "selection.delivery-exception", request_hash: sha256(input) }) : undefined;
      const revision = await tx.getIssueRevisionByNumber(input.issue_id, input.issue_version);
      await tx.lockIssueSelection(revision.id); await tx.lockCandidateVerifications(input.candidate_id);
      const selection = await tx.getSelection(revision.id), record = await tx.getCandidate(input.candidate_id);
      if (selection?.id !== input.selection_id || selection.version !== input.selection_version || selection.candidate_id !== input.candidate_id || record.candidate.issue_revision_id !== revision.id || record.candidate.source?.commit !== input.source_commit) throw stateConflict("selection", input.selection_id, "Selection or fixed source changed before delivery decision");
      const standing = await tx.candidateStanding(input.candidate_id);
      if (!["unverified", "qualified"].includes(standing)) throw stateConflict("candidate", input.candidate_id, "the complete rejected/disputed/inconclusive Verification set cannot be waived as unverified");
      if (replay) return JSON.parse(replay.result_json).data.decision_id;
      if (onlyIfRecorded) {
        if (standing !== "qualified" || input.target_commit !== (record.candidate.base_commit ?? revision.baseline.git_oid)) throw stateConflict("candidate", input.candidate_id, "preparation facts changed; refresh and request an explicit new delivery decision");
        return undefined;
      }
      const issue = await tx.getIssue(input.issue_id), now = await tx.now();
      await tx.appendLedgerEvent(event(this.newId(), "selection.delivery_exception", input.operation_id, "selection", input.selection_id, issue.repository_id, input.selection_version, now, input.attribution,
        { candidate_id: input.candidate_id, source_commit: input.source_commit, target_commit: input.target_commit, disclosure: "landed_code_is_unverified", reason: input.reason }));
      await tx.completeOperation(input.operation_id, JSON.stringify(envelopeData({ result_type: "grounds.result.delivery-exception/v1", command: "selection.delivery-exception", decision_id: input.operation_id }, input.operation_id, []))); return input.operation_id;
    });
  }

  async developmentHeadStanding(devRunID: string, head: string): Promise<{ standing: string; candidate_id?: string; verification?: VerificationSetSummary }> {
    return this.store.read(async tx => {
      const candidate = await tx.getCandidateByDevRun(devRunID);
      if (!candidate?.candidate.source || candidate.candidate.source.commit !== head) return { standing: "unverified" };
      return { candidate_id: candidate.candidate.id, standing: await tx.candidateStanding(candidate.candidate.id), verification: await verificationSetSummary(tx, candidate.candidate.id) };
    });
  }

  async recordDevelopmentContinuation(input: { operation_id: string; dev_run_id: string; expected_version: number; expected_head: string; policy: "parallel" | "paused"; attribution: Attribution }): Promise<{ result_type: string; command: string; dev_run_id: string; expected_head: string; policy: string }> {
    ensureID("operation_id", input.operation_id); ensureID("dev_run_id", input.dev_run_id); validateAttribution(input.attribution);
    if (!isGitOID(input.expected_head) || !["parallel", "paused"].includes(input.policy)) throw validation("continuation", "explicit policy and qualified HEAD required");
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: input.operation_id, command: "devrun.continue", request_hash: sha256(input) });
      await tx.lockDevRun(input.dev_run_id);
      const run = await tx.getDevRun(input.dev_run_id);
      if (!run.development || run.state !== "submitted" || run.version !== input.expected_version) throw stateConflict("dev_run", run.id, "continuation policy requires the current submitted managed branch round");
      // The receipt remains historical; only the current event may govern local policy.
      await tx.getDevelopmentContinuation(run.id);
      if (replay) return JSON.parse(replay.result_json).data;
      const revision = await tx.getIssueRevisionById(run.issue_revision_id), issue = await tx.getIssue(revision.issue_id);
      await tx.appendLedgerEvent(event(this.newId(), "devrun.continuation", input.operation_id, "dev_run", run.id, issue.repository_id, run.version, await tx.now(), input.attribution, { policy: input.policy, expected_head: input.expected_head }));
      const result = { result_type: "grounds.result.development-continuation/v1", command: "devrun.continue", dev_run_id: run.id, expected_head: input.expected_head, policy: input.policy };
      await tx.completeOperation(input.operation_id, JSON.stringify(envelopeData(result, input.operation_id, []))); return result;
    });
  }

  async submitCandidate(input: SubmitCandidateCommand): Promise<CandidateSubmitResult> {
    if (!input.git_artifact || !input.source) throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "New Candidates require a fixed Git source and confirmed Git archive; patch-only submission is unsupported");
    ensureID("dev_run_id", input.dev_run_id); const op = opID(input.operation_id); input = { ...input, operation_id: op }; if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) throw validation("expected_version", "must be at least 1"); validateAttribution(input.attribution); validateCandidateSubmission(input.submission); validateCandidateArtifact(input.artifact);
    const resolved = await this.store.read(async (tx) => {
      const run = await tx.getDevRun(input.dev_run_id);
      const issueRevision = await tx.getIssueRevisionById(run.issue_revision_id);
      const issue = await tx.getIssue(issueRevision.issue_id);
      return { issueRevision, issue, base_commit: run.base_commit, requirementRevision: await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id), repository: await tx.getRepository(issue.repository_id) };
    });
    if (input.source) validateSourceIdentity(input.source);
    const candidateID = input.candidate_id ?? this.newId();
    ensureID("candidate_id", candidateID);
    const manifestDigestValue = manifestDigest(input.artifact.files);
    const hash = operationHash(command.candidateSubmit, { dev_run_id: input.dev_run_id, expected_version: input.expected_version, submission: canonicalSubmission(input.submission), patch_digest: input.artifact.patch_digest, result_tree_oid: input.artifact.result_tree_oid, ...(input.source ? { source: input.source } : {}), ...(input.git_artifact ? { git_artifact: { format: input.git_artifact.format, generator_version: input.git_artifact.generator_version, binding: input.git_artifact.binding } } : {}) }, input.attribution, { requirement_revision: resolved.requirementRevision, issue_revision: hashableIssueRevision(resolved.issueRevision), repository: { id: resolved.repository.id }, baseline: resolved.issueRevision.baseline, ...(resolved.base_commit ? { base_commit: resolved.base_commit } : {}), dev_run_id: input.dev_run_id, artifact: { patch_digest: input.artifact.patch_digest, result_tree_oid: input.artifact.result_tree_oid, manifest_digest: manifestDigestValue, uncompressed_size: input.artifact.uncompressed_size } }, { expected_version: input.expected_version }); let result!: CandidateSubmitResult;
    await this.store.write(async (tx) => {
      const replay = await tx.reserveOperation({ id: op, command: command.candidateSubmit, request_hash: hash }); if (replay) { result = decodeReplay<CandidateSubmitResult>(replay).data; return; }
      await tx.lockDevRun(input.dev_run_id);
      await assertDevRunAdmitted(tx, input.dev_run_id);
      const run = await tx.getDevRun(input.dev_run_id);
      if (!input.source || (input.source && (!isGitOID(input.source.commit) || !Array.isArray(input.source.parents) || input.source.parents.some(p => !isGitOID(p))))) throw validation("source", "managed branch Candidate requires a fixed source commit and parents; legacy flows cannot invent source facts");
      if (run.version !== input.expected_version) throw versionConflict("dev_run", run.id, input.expected_version, run.version); if (run.state !== "open") throw stateConflict("dev_run", run.id, "only an open DevRun can submit a Candidate");
      const issueRevision = await tx.getIssueRevisionById(run.issue_revision_id); const issue = await tx.getIssue(issueRevision.issue_id); const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id); const repository = await tx.getRepository(issue.repository_id);
      validateCandidateCoverage(input.submission, issueRevision);
      validateCandidateRationaleCoverage(input.submission, issueRevision, input.artifact);
      const now = await tx.now();
      const source: CandidateContextSource = {
        candidate_id: candidateID,
        ...(run.base_commit ? { base_commit: run.base_commit } : {}),
        repository_id: repository.id,
        canonical_remote_at_submission: run.repository_remote_snapshot,
        result_tree_oid: input.artifact.result_tree_oid,
        patch_digest: input.artifact.patch_digest,
        requirement_revision: requirementRevision,
        issue_revision: issueRevision,
        artifact: input.artifact,
        // Preserve the submitted order in the immutable Candidate. The
        // canonical form is used only for idempotency comparisons/hashes.
        submission: input.submission,
      };
      const blindDigest = blindContextDigestFor(source);
      const verificationSource = { ...source, blind_context_digest: blindDigest };
      contextSize(blindVerificationContextFor(verificationSource));
      contextSize(reconcileVerificationContextFor(verificationSource));
      contextSize(qualityBlindContextFrom(blindVerificationContextFor(verificationSource)));
      contextSize(qualityReconcileContextFrom(verificationSource));
      const candidate: Candidate = { id: candidateID, ...(input.source ? { source: input.source } : {}), ...(run.base_commit ? { base_commit: run.base_commit } : {}), dev_run_id: run.id, issue_revision_id: run.issue_revision_id, repository_remote_snapshot: run.repository_remote_snapshot, submission: source.submission, patch_digest: input.artifact.patch_digest, result_tree_oid: input.artifact.result_tree_oid, artifact_format: GIT_CANDIDATE_ARTIFACT_FORMAT, ...(input.git_artifact ? { git_artifact: input.git_artifact } : {}), blind_context_digest: blindDigest, created_at: now, attribution: input.attribution };
      if (input.git_artifact) validateGitArtifactCandidateBinding(input.git_artifact, candidate);
      await tx.createCandidate({ candidate, artifact: input.artifact, exploration_brief: run.exploration_brief, refines_candidate_id: run.refines_candidate_id }); await tx.submitDevRun(run.id, input.expected_version);
      await tx.appendLedgerEvent(event(this.newId(), "candidate.submitted", op, "candidate", candidate.id, issue.repository_id, undefined, now, input.attribution, { dev_run_id: run.id, issue_revision_id: run.issue_revision_id, patch_digest: candidate.patch_digest, result_tree_oid: candidate.result_tree_oid, ...(input.source ? { development_source: JSON.stringify({ format: "grounds.candidate-source/v1", ...input.source, result_tree_oid: candidate.result_tree_oid, patch_digest: candidate.patch_digest, dev_run_id: run.id }) } : {}) }));
      result = { result_type: "patchledger.result.candidate-submit/v1", command: command.candidateSubmit, candidate_id: candidate.id, ...(input.source ? { source: input.source } : {}), ...(input.git_artifact ? { git_artifact: input.git_artifact } : {}), dev_run_id: run.id, issue: { id: issueRevision.issue_id, version: issueRevision.revision_number }, result_tree_oid: candidate.result_tree_oid, patch_digest: candidate.patch_digest, created_at: now }; await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, [])));
    }); return result;
  }

  async replayCandidateSubmit(operationId: string, request?: CandidateReplayRequest): Promise<{ result: CandidateSubmitResult; found: boolean }> {
    // Unlike a normal write, this helper is only a lookup for an explicitly
    // supplied operation ID.  An empty value must be rejected rather than
    // silently generating a new ID and returning `found: false`; otherwise a
    // caller cannot distinguish a malformed retry from a legitimate miss.
    ensureID("operation_id", operationId);
    return this.store.read(async (tx) => {
      const replay = await tx.getOperation(operationId);
      if (!replay) return { result: {} as CandidateSubmitResult, found: false };
      if (replay.command !== command.candidateSubmit) throw idempotencyConflict(replay.command, replay.request_hash, replay.request_hash);
      const result = decodeReplay<CandidateSubmitResult>(replay).data;
      await tx.findCandidateArtifactRef({ candidate_id: result.candidate_id });
      if (request) {
        validateCandidateSubmission(request.submission);
        validateAttribution(request.attribution);
        if (!Number.isSafeInteger(request.expected_version) || request.expected_version < 1) throw validation("expected_version", "must be at least 1");
        ensureID("dev_run_id", request.dev_run_id);
        const record = await tx.getCandidate(result.candidate_id);
        const run = await tx.getDevRun(record.candidate.dev_run_id);
        const sameSubmission = canonicalBytes(canonicalSubmission(request.submission)).equals(canonicalBytes(canonicalSubmission(record.candidate.submission)));
        const sameActor = canonicalBytes(request.attribution).equals(canonicalBytes(record.candidate.attribution));
        if (request.dev_run_id !== record.candidate.dev_run_id || request.expected_version + 1 !== run.version || run.state !== "submitted" || !sameSubmission || !sameActor) {
          const issueRevision = await tx.getIssueRevisionById(record.candidate.issue_revision_id);
          const issue = await tx.getIssue(issueRevision.issue_id);
          const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id);
          const repository = await tx.getRepository(issue.repository_id);
          const expectedHash = operationHash(
            command.candidateSubmit,
            {
              dev_run_id: request.dev_run_id,
              expected_version: request.expected_version,
              submission: canonicalSubmission(request.submission),
              patch_digest: record.candidate.patch_digest,
              result_tree_oid: record.candidate.result_tree_oid,
            },
            request.attribution,
            {
              requirement_revision: requirementRevision,
              issue_revision: hashableIssueRevision(issueRevision),
              repository: { id: repository.id },
              baseline: issueRevision.baseline,
              ...(record.candidate.base_commit ? { base_commit: record.candidate.base_commit } : {}),
              dev_run_id: request.dev_run_id,
              artifact: {
                patch_digest: record.candidate.patch_digest,
                result_tree_oid: record.candidate.result_tree_oid,
                manifest_digest: manifestDigest(record.artifact.files),
                uncompressed_size: record.artifact.uncompressed_size,
              },
            },
            { expected_version: request.expected_version },
          );
          throw idempotencyConflict(command.candidateSubmit, expectedHash, replay.request_hash);
        }
      }
      return { result, found: true };
    });
  }

  private async candidateMaterialization(tx: ReadTx, candidateId: string): Promise<CandidateMaterialization> {
    const record = await tx.getCandidate(candidateId);
    const issueRevision = await tx.getIssueRevisionById(record.candidate.issue_revision_id);
    const issue = await tx.getIssue(issueRevision.issue_id);
    const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id);
    validateCandidateBindings(record, issue, issueRevision, requirementRevision);
    const repo = await tx.getRepository(issue.repository_id);
    return { ...(record.candidate.git_artifact ? { git_artifact: record.candidate.git_artifact } : {}), ...(record.candidate.source ? { source: record.candidate.source } : {}), candidate_id: candidateId, issue_revision_id: record.candidate.issue_revision_id, repository_id: repo.id, canonical_remote: repo.canonical_remote, baseline: record.candidate.base_commit ? { git_oid: record.candidate.base_commit, reachability: "remote_tracking_reachable" } : issueRevision.baseline, result_tree_oid: record.candidate.result_tree_oid, patch_digest: record.candidate.patch_digest, patch: record.artifact.patch };
  }

  async loadCandidateMaterialization(candidateId: string): Promise<CandidateMaterialization> {
    ensureID("candidate_id", candidateId);
    return this.store.read(tx => this.candidateMaterialization(tx, candidateId));
  }

  private async selectionView(tx: Tx, issueRevisionId: string): Promise<SelectionView> {
    const record = await tx.getSelection(issueRevisionId);
    if (!record) return { state: "unselected", version: 0, verification_changed: false, warnings: [] };
    const { issue_revision_id: _, ...value } = record;
    if (record.candidate_id) await tx.findCandidateArtifactRef({ candidate_id: record.candidate_id });
    const current = record.candidate_id ? await verificationSetSummary(tx, record.candidate_id) : undefined;
    const changed = !!current && current.digest !== record.verification_at_selection?.digest;
    const warnings: Warning[] = [];
    if (changed) warnings.push({ code: "SELECTION_VERIFICATION_CHANGED", message: "Verification records have changed since this selection was recorded; review the new findings." });
    if (current && current.standing !== "qualified") warnings.push({ code: "SELECTION_VERIFICATION_RISK", message: `Selected Candidate standing is ${current.standing}; selection does not establish verification or adoption.` });
    return { ...value, state: record.candidate_id ? "selected" : "unselected", ...(current ? { current_verification: current } : {}), verification_changed: changed, warnings };
  }

  private validateSelectionVersion(field: string, version: number, minimum = 1): void {
    if (!Number.isSafeInteger(version) || version < minimum || version > 2147483646) throw validation(field, `must be an integer between ${minimum} and 2147483646`);
  }

  async showSelection(issueId: string, issueVersion?: number): Promise<SelectionResult> {
    ensureID("issue_id", issueId);
    if (issueVersion !== undefined) this.validateSelectionVersion("issue_version", issueVersion);
    return this.store.read(async tx => {
      const revision = issueVersion === undefined ? await tx.getCurrentIssueRevision(issueId) : await tx.getIssueRevisionByNumber(issueId, issueVersion);
      return { result_type: "patchledger.result.selection/v1", command: "selection.show", issue: { id: issueId, version: revision.revision_number }, selection: await this.selectionView(tx, revision.id) };
    });
  }

  async showCompletion(issueId: string, issueVersion: number): Promise<CompletionResult> {
    ensureID('issue_id', issueId); this.validateSelectionVersion('issue_version', issueVersion);
    return resultSize('Completion detail', await this.store.read(async tx => {
      const revision = await tx.getIssueRevisionByNumber(issueId, issueVersion);
      const history = await tx.completionHistory(revision.id);
      return { ...await this.completionResult(tx, issueId, issueVersion, 'completion.show', history.at(-1)), history };
    }));
  }

  private async completionResult(tx: Tx, issueId: string, issueVersion: number, command: CompletionResult['command'], record?: CompletionRecord): Promise<CompletionResult> {
    const verification = record?.completion.candidate_id ? await verificationSetSummary(tx, record.completion.candidate_id) : undefined;
    return { result_type: 'grounds.result.issue-completion/v1', command, issue: { id: issueId, version: issueVersion }, completion: completionView(record),
      ...(verification ? { current_verification: verification } : {}),
      warnings: record ? [{ code: 'COMPLETION_EXTERNAL_FACTS_ASSERTED', message: 'External delivery facts are asserted by the recorder; Grounds has not checked references or performed delivery.' },
        ...(verification && verification.standing !== 'qualified' ? [{ code: 'COMPLETION_VERIFICATION_RISK', message: `Completed delivery does not change Candidate verification: ${verification.standing}.` }] : [])] : [] };
  }

  async recordCompletion(input: CompletionWriteCommand & { completion: CompletionInput }): Promise<CompletionResult> {
    validateCompletionInput(input.completion);
    return this.writeCompletion(input, input.completion);
  }

  async reopenCompletion(input: CompletionWriteCommand & { reason: string }): Promise<CompletionResult> {
    completionText(input.reason, 'reason');
    return this.writeCompletion(input, undefined, input.reason);
  }

  private async writeCompletion(input: CompletionWriteCommand, completion?: CompletionInput, reason?: string): Promise<CompletionResult> {
    ensureID('issue_id', input.issue_id); this.validateSelectionVersion('issue_version', input.issue_version);
    this.validateSelectionVersion('expected_version', input.expected_version, 0); validateAttribution(input.attribution);
    const op = opID(input.operation_id), name = completion ? 'completion.record' : 'completion.reopen';
    const hash = operationHash(name, { ...input, ...(completion ? { completion } : { reason }) }, input.attribution, {}, { expected_version: input.expected_version });
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: op, command: name, request_hash: hash });
      if (replay) return decodeReplay<CompletionResult>(replay).data;
      const revision = await tx.getIssueRevisionByNumber(input.issue_id, input.issue_version);
      await tx.lockIssueSelection(revision.id);
      const previous = await tx.getCompletion(revision.id);
      if ((previous?.version ?? 0) !== input.expected_version) throw versionConflict('completion', input.issue_id, input.expected_version, previous?.version ?? 0);
      if (completion ? previous?.state === 'completed' : previous?.state !== 'completed') throw stateConflict('completion', input.issue_id, completion ? 'reopen the completed record before correcting it' : 'there is no completed record to reopen');
      const issue = await tx.getIssue(input.issue_id);
      const now = new Date(await tx.now()).toISOString();
      if (completion) {
        if (completion.repository_id !== issue.repository_id) throw validation('repository_id', 'must match the Issue Repository');
        if (revision.target_branch && completion.target_branch !== revision.target_branch.ref) throw validation('target_branch', 'must match the Issue target branch');
        if (Date.parse(completion.completed_at) > Date.parse(now)) throw validation('completed_at', 'completion cannot be in the future');
        if (completion.candidate_id) {
          const candidate = await tx.getCandidate(completion.candidate_id);
          if (candidate.candidate.issue_revision_id !== revision.id) throw validation('candidate_id', 'must belong to the exact Issue Version');
        }
      }
      const record: CompletionRecord = { version: input.expected_version + 1, state: completion ? 'completed' : 'reopened', recorded_at: now, attribution: input.attribution, evidence_status: 'asserted_not_checked', completion: completion ?? previous!.completion, ...(reason ? { reason } : {}) };
      await tx.appendCompletion(revision.id, record, input.expected_version);
      await tx.appendLedgerEvent(event(this.newId(), completion ? 'completion.recorded' : 'completion.reopened', op, 'issue_completion', revision.id, issue.repository_id, record.version, now, input.attribution, { issue_id: input.issue_id, issue_version: String(input.issue_version), record_digest: sha256(record) }));
      const result = await this.completionResult(tx, input.issue_id, input.issue_version, name, record);
      await tx.completeOperation(op, JSON.stringify(envelopeData(result, op)));
      return result;
    });
  }

  async setSelection(input: SelectionWriteCommand & { candidate_id: string }): Promise<SelectionResult> {
    ensureID("candidate_id", input.candidate_id);
    return this.writeSelection(input, false);
  }

  async clearSelection(input: SelectionWriteCommand): Promise<SelectionResult> {
    if (input.candidate_id !== undefined) throw validation("candidate_id", "is not accepted when clearing a selection");
    return this.writeSelection(input, true);
  }

  private async writeSelection(input: SelectionWriteCommand, clear: boolean): Promise<SelectionResult> {
    ensureID("issue_id", input.issue_id);
    this.validateSelectionVersion("issue_version", input.issue_version);
    this.validateSelectionVersion("expected_version", input.expected_version, 0);
    validateAttribution(input.attribution);
    validateOptionalLongText("reason", input.reason);
    if (input.reason !== undefined && [...input.reason].length > 4096) throw validation("reason", "must not exceed 4096 characters");
    const op = opID(input.operation_id);
    const name = clear ? "selection.clear" : "selection.set";
    // Only explicit, stable request inputs enter the hash. Later Verifications
    // or a changed current Selection must not invalidate operation replay.
    const hash = operationHash(name, input, input.attribution, {}, { expected_version: input.expected_version });
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: op, command: name, request_hash: hash });
      if (replay) return decodeReplay<SelectionResult>(replay).data;
      const revision = await tx.getIssueRevisionByNumber(input.issue_id, input.issue_version);
      await tx.lockIssueSelection(revision.id);
      const before = await tx.getSelection(revision.id);
      if ((before?.version ?? 0) !== input.expected_version) throw versionConflict("selection", before?.id ?? input.issue_id, input.expected_version, before?.version ?? 0);
      if (clear && !before?.candidate_id) throw stateConflict("selection", before?.id ?? input.issue_id, "there is no current selection to clear");
      const issue = await tx.getIssue(input.issue_id);
      let snapshot: VerificationSetSummary | undefined;
      if (!clear) {
        const candidate = await tx.getCandidate(input.candidate_id!);
        if (candidate.candidate.issue_revision_id !== revision.id) throw validation("candidate_id", "must belong to the requested Issue Version");
        await tx.lockCandidateVerifications(input.candidate_id!);
        snapshot = await verificationSetSummary(tx, input.candidate_id!);
        if (snapshot.standing !== "qualified" && !input.reason?.trim()) throw validation("reason", `is required to select a ${snapshot.standing} Candidate`);
      }
      const record: SelectionRecord = {
        id: before?.id ?? this.newId(), issue_revision_id: revision.id, version: input.expected_version + 1,
        updated_at: await tx.now(), attribution: input.attribution,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(!clear ? { candidate_id: input.candidate_id!, verification_at_selection: snapshot! } : {}),
      };
      await tx.saveSelection(record, input.expected_version);
      await tx.appendLedgerEvent(event(this.newId(), clear ? "selection.cleared" : "selection.set", op, "selection", record.id, issue.repository_id, record.version, record.updated_at, input.attribution, {
        issue_id: input.issue_id, issue_version: String(input.issue_version), previous_version: String(input.expected_version), version: String(record.version),
        ...(before?.candidate_id ? { previous_candidate_id: before.candidate_id } : {}),
        ...(record.candidate_id ? { candidate_id: record.candidate_id } : {}),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(snapshot ? { verification_at_selection: JSON.stringify(snapshot) } : {}),
      }));
      const result: SelectionResult = { result_type: "patchledger.result.selection/v1", command: name, issue: { id: input.issue_id, version: input.issue_version }, selection: await this.selectionView(tx, revision.id) };
      await tx.completeOperation(op, JSON.stringify(envelopeData(result, op)));
      return result;
    });
  }

  async loadSelectionMaterialization(issueId: string, issueVersion: number, expectedVersion: number): Promise<{ selection: SelectionResult; materialization: CandidateMaterialization }> {
    ensureID("issue_id", issueId);
    this.validateSelectionVersion("issue_version", issueVersion);
    this.validateSelectionVersion("expected_version", expectedVersion, 0);
    return this.store.read(async tx => {
      const revision = await tx.getIssueRevisionByNumber(issueId, issueVersion);
      const selection = await this.selectionView(tx, revision.id);
      if (selection.version !== expectedVersion) throw versionConflict("selection", selection.id ?? issueId, expectedVersion, selection.version);
      if (!selection.candidate_id) throw stateConflict("selection", selection.id ?? issueId, "select a Candidate before preparing delivery");
      return { selection: { result_type: "patchledger.result.selection/v1", command: "selection.show", issue: { id: issueId, version: issueVersion }, selection }, materialization: await this.candidateMaterialization(tx, selection.candidate_id) };
    });
  }

  async showCandidate(candidateId: string, manifestCursor = "", verificationCursor = ""): Promise<CandidateDetailResult> {
    ensureID("candidate_id", candidateId);
    const manifestAfter = decodeManifestCursor(manifestCursor);
    const result = await this.store.read(async (tx) => {
      const record = await tx.getCandidate(candidateId);
      const issueRevision = await tx.getIssueRevisionById(record.candidate.issue_revision_id);
      const issue = await tx.getIssue(issueRevision.issue_id);
      const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id);
      validateCandidateBindings(record, issue, issueRevision, requirementRevision);
      const files = record.artifact.files;
      const manifestStart = manifestAfter ? files.findIndex((file) => Buffer.compare(Buffer.from(file.path_bytes, "base64"), manifestAfter) > 0) : 0;
      const start = manifestStart < 0 ? files.length : manifestStart;
      const shownFiles = files.slice(start, start + 2000);
      const verificationPage = await tx.listVerificationSummariesPage(record.candidate.id, verificationCursor, 256);
      const verificationCount = await tx.verificationCount(record.candidate.id);
      const verificationDigest = await verificationSetDigestPaged(tx, record.candidate.id);
      const shownVerifications = verificationPage.rows;
      const manifestOmitted = start + shownFiles.length < files.length;
      const verificationOmitted = verificationPage.more;
      return { result_type: "patchledger.result.candidate-detail/v1", command: "candidate.show", candidate: { ...await candidateHistoryProjection(tx, record), ...(record.candidate.git_artifact ? { git_artifact: record.candidate.git_artifact } : {}), ...(record.candidate.source ? { source: record.candidate.source } : {}), candidate_id: record.candidate.id, dev_run_id: record.candidate.dev_run_id, issue: { id: issueRevision.issue_id, version: issueRevision.revision_number }, ...(record.exploration_brief ? { exploration_brief: record.exploration_brief } : {}), ...(record.refines_candidate_id ? { refines_candidate_id: record.refines_candidate_id } : {}), submission_explanation: record.candidate.submission.explanation, attribution: record.candidate.attribution, created_at: record.candidate.created_at, result_tree_oid: record.candidate.result_tree_oid, patch_digest: record.candidate.patch_digest, artifact_format: record.candidate.artifact_format, standing: await tx.candidateStanding(candidateId), is_selected: (await tx.getSelection(issueRevision.id))?.candidate_id === candidateId, file_count: files.length, manifest_digest: manifestDigest(files), file_manifest: shownFiles, file_manifest_omitted: manifestOmitted, ...(manifestOmitted && shownFiles.length ? { manifest_next_cursor: encodeManifestCursor(shownFiles[shownFiles.length - 1].path_bytes) } : {}), claims: claimRecords(record.candidate.submission.claims), verification_count: verificationCount, verification_digest: verificationDigest, verifications: shownVerifications.map(toVerificationSummary), verifications_omitted: verificationOmitted, ...(verificationOmitted && shownVerifications.length ? { verifications_next_cursor: encodeVerificationCursor(shownVerifications[shownVerifications.length - 1]) } : {}) } } as CandidateDetailResult;
    });
    return resultSize("Candidate detail", result);
  }

  async candidateLineage(candidateId: string) {
    ensureID("candidate_id", candidateId);
    return this.store.read(async tx => {
      const ref = await tx.findCandidateArtifactRef({candidate_id: candidateId});
      if (!ref) throw new DomainError("NOT_FOUND", "Candidate not found");
      const run = await tx.getDevRun(ref.dev_run_id);
      return {result_type: "grounds.result.candidate-lineage/v1" as const, command: "candidate.lineage" as const,
        lineage: (await candidateHistoryProjection(tx, {candidate: {id: ref.candidate_id, issue_revision_id: ref.issue_revision_id, dev_run_id: ref.dev_run_id}, refines_candidate_id: run.refines_candidate_id})).lineage};
    });
  }

  async reviewCandidate(candidateId: string, options: ReviewCandidateOptions = {}): Promise<ReviewTraceResult> {
    return resultSize("Review trace", (await this.buildReview(candidateId, options, true)).result);
  }

  async reviewSummary(candidateId: string, options: ReviewCandidateOptions = {}): Promise<ReviewSummaryResult> {
    const { result, summary } = await this.buildReview(candidateId, options, false);
    return resultSize("Review summary", { result_type: "patchledger.result.review-summary/v1", command: "review", trace: { ...result.trace, format: "patchledger.review-summary/v1", verification_set: summary } });
  }

  async verificationPage(candidateId: string, cursor = ""): Promise<VerificationPageResult> {
    ensureID("candidate_id", candidateId);
    let binding: { version: number; candidate_id: string; digest: string; after: string } | undefined;
    if (cursor) {
      try {
        if (cursor.length > 4096) throw new Error();
        binding = JSON.parse(decodeBase64URL(cursor).toString("utf8"));
        if (!binding || Object.keys(binding).sort().join(",") !== "after,candidate_id,digest,version" || binding.version !== 1 || binding.candidate_id !== candidateId || !isSha256(binding.digest) || typeof binding.after !== "string" || !binding.after) throw new Error();
      } catch { throw validation("cursor", "must be a Verification page cursor bound to this Candidate"); }
    }
    return this.store.read(async (tx) => {
      const summary = await verificationSetSummary(tx, candidateId);
      if (binding && binding.digest !== summary.digest) throw new DomainError("VERIFICATION_SET_CHANGED", "Verification set changed; restart pagination", true, { resource_id: candidateId });
      const page = await tx.readVerificationDirectoryPage(candidateId, binding?.after ?? "", 256);
      const rows = [...page.rows];
      const make = (): VerificationPageResult => ({ result_type: "patchledger.result.verification-page/v1", command: "verification.list", candidate_id: candidateId, verification_set: summary,
        verifications: rows.map((row) => ({ ...toVerificationSummary(row), candidate_id: candidateId })),
        ...((page.more || rows.length < page.rows.length) && rows.length ? { next_cursor: Buffer.from(JSON.stringify({ version: 1, candidate_id: candidateId, digest: summary.digest, after: encodeVerificationCursor(rows[rows.length - 1]) })).toString("base64url") } : {}) });
      let result = make();
      while (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024 && rows.length > 1) { rows.pop(); result = make(); }
      return resultSize("Verification page", result);
    });
  }

  private async buildReview(candidateId: string, options: ReviewCandidateOptions, includeReports: boolean): Promise<{ result: ReviewTraceResult; summary: VerificationSetSummary }> {
    ensureID("candidate_id", candidateId);
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw validation("options", "must be an object");
    if (options.include_patch !== undefined && typeof options.include_patch !== "boolean") throw validation("include_patch", "must be boolean");
    const locationRequest = options.location;
    if (locationRequest !== undefined) {
      if (locationRequest === null || typeof locationRequest !== "object" || Array.isArray(locationRequest)) throw validation("location", "must be an object");
      if (typeof locationRequest.path !== "string" || !locationRequest.path || [...locationRequest.path].length > 4096 || locationRequest.path.includes("\0")) throw validation("location.path", "must be a non-empty path of at most 4096 characters");
      if (locationRequest.side !== "old" && locationRequest.side !== "new") throw validation("location.side", "must be old or new");
      if (locationRequest.line !== undefined && (typeof locationRequest.line !== "number" || !Number.isSafeInteger(locationRequest.line) || locationRequest.line < 1)) throw validation("location.line", "must be a positive safe integer");
    }
    const result = await this.store.read(async (tx) => {
      const record = await tx.getCandidate(candidateId);
      const issueRevision = await tx.getIssueRevisionById(record.candidate.issue_revision_id);
      const issue = await tx.getIssue(issueRevision.issue_id);
      const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id);
      validateCandidateBindings(record, issue, issueRevision, requirementRevision);
      let upstream: import("./comparison.js").UpstreamChanges | undefined;
      if (record.refines_candidate_id) {
        const parent = await tx.getCandidate(record.refines_candidate_id);
        if (parent.candidate.issue_revision_id !== issueRevision.id) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "refinement parent belongs to another Issue Version");
        const left = parent.candidate.base_commit ?? issueRevision.baseline.git_oid;
        const right = record.candidate.base_commit ?? issueRevision.baseline.git_oid;
        if (left !== right) upstream = await this.upstreamChanges(left, right, options.include_patch === true);
      }
      const rationaleInspection = inspectChangeRationaleBindings(record.candidate.submission, issueRevision, record.artifact);
      const repository = await tx.getRepository(issue.repository_id);
      const summary = await verificationSetSummary(tx, candidateId);
      const standingValue = includeReports ? await tx.candidateStanding(candidateId) : summary.standing;
      const verificationDigest = summary.digest;
      const verifications: ReviewTraceResult["trace"]["verification_set"]["verifications"] = [];
      let cursor = "";
      while (includeReports) {
        const page = await tx.listVerificationSummariesPage(candidateId, cursor, 256);
        for (const summary of page.rows) {
          const loaded = await tx.getVerification(summary.id);
          if (loaded.verification.candidate_id !== candidateId || loaded.verification.overall_verdict !== summary.overall_verdict) {
            throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Verification summary is inconsistent", false, { resource_id: summary.id, reason: "Verification detail does not match its Candidate summary" });
          }
          verifications.push({ source: "verifier_finding", verification_id: loaded.verification.id, mode: loaded.quality ? "ultra" : "normal", overall_verdict: loaded.verification.overall_verdict, created_at: loaded.verification.created_at, attribution: loaded.verification.attribution, report: loaded.report, ...(loaded.quality ? { quality: toQualityDetail(loaded.quality) } : {}) });
        }
        if (!page.more) break;
        if (!page.rows.length) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "verification page omitted without a cursor");
        cursor = encodeVerificationCursor(page.rows[page.rows.length - 1]);
      }
      const verificationCount = summary.count;
      if (includeReports && verificationCount !== verifications.length) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Verification set is inconsistent", false, { resource_id: candidateId, reason: "Verification count does not match the complete paged set" });
      const patchProjection = inlinePatch(record.artifact.patch, options.include_patch === true);
      const syncRecords = record.candidate.base_commit ? (await tx.listRuntimeRecords("runtime_operation", record.candidate.dev_run_id)).filter(isSyncRecord).map(syncReview) : [];
      const result = {
        result_type: "patchledger.result.review-trace/v3",
        command: "review",
        trace: {
          format: "patchledger.review-trace/v3",
          ...await candidateHistoryProjection(tx, record),
          comparison_basis: { left_commit: record.candidate.base_commit ?? issueRevision.baseline.git_oid, ...(record.candidate.source ? { right_commit: record.candidate.source.commit } : {}), right_tree: record.candidate.result_tree_oid, purpose: "candidate_changes" as const, generator_version: "grounds.canonical-git-diff/v1" as const, diff_state: patchProjection.patch_state },
          candidate: {
            source: "ledger_fact",
            candidate_id: record.candidate.id,
            dev_run_id: record.candidate.dev_run_id,
            created_at: record.candidate.created_at,
            attribution: record.candidate.attribution,
            standing: standingValue,
            ...(record.exploration_brief ? { exploration_brief: record.exploration_brief } : {}),
            ...(record.refines_candidate_id ? { refines_candidate_id: record.refines_candidate_id } : {}),
          },
          repository: { source: "ledger_fact", id: repository.id, canonical_remote_at_submission: record.candidate.repository_remote_snapshot },
          baseline: { source: "ledger_fact", ...issueRevision.baseline },
          contract: { source: "ledger_fact", requirement: requirementVersionForContext(requirementRevision), issue: issueVersionForContext(issueRevision, requirementRevision) },
          artifact: {
            ...(record.candidate.git_artifact ? { git_artifact: record.candidate.git_artifact } : {}),
            source: "ledger_fact",
            ...(record.candidate.source ? { source_commit: record.candidate.source.commit, source_parents: record.candidate.source.parents } : {}),
            ...(record.candidate.base_commit ? { base_commit: record.candidate.base_commit } : {}),
            format: record.candidate.artifact_format,
            result_tree_oid: record.candidate.result_tree_oid,
            patch_digest: record.candidate.patch_digest,
            uncompressed_size: record.artifact.uncompressed_size,
            file_manifest: record.artifact.files,
            ...patchProjection,
          },
          ...(upstream ? { upstream_changes: upstream } : {}),
          ...(syncRecords.length ? { sync_records: syncRecords } : {}),
          change_index: { source: "derived_relation", ...rationaleInspection.change_index },
          ...(locationRequest ? { location: locateReviewPath(record.artifact, rationaleInspection.change_index, record.candidate.submission, locationRequest) } : {}),
          submission: {
            source: "author_claim",
            format: record.candidate.submission.format,
            explanation: record.candidate.submission.explanation,
            claims: claimRecords(record.candidate.submission.claims),
            change_rationales: record.candidate.submission.format === "patchledger.candidate-submission/v2" ? record.candidate.submission.change_rationales : [],
          },
          verification_set: { source: "derived_relation", count: verificationCount, digest: verificationDigest, standing: standingValue, complete: true, verifications },
          explanation_coverage: {
            source: "derived_relation",
            status: rationaleInspection.change_index.change_units.length === 0 ? "not_applicable" : record.candidate.submission.format === "patchledger.candidate-submission/v1" ? "not_recorded" : "complete",
            total_change_units: rationaleInspection.change_index.change_units.length,
            explained_change_units: rationaleInspection.explained_change_unit_ids.length,
            unexplained_change_unit_ids: rationaleInspection.unexplained_change_unit_ids,
            ...(rationaleInspection.change_index.change_units.length === 0
              ? { reason: "candidate_has_no_changes" as const }
              : record.candidate.submission.format === "patchledger.candidate-submission/v1"
                ? { reason: "candidate_submission_v1_has_no_change_rationales" as const }
                : {}),
          },
        },
      } satisfies ReviewTraceResult;
      return { result, summary };
    });
    return result;
  }

  private candidateResources = async (tx: ReadTx, items: CandidateListItem[], filter: CandidateListFilter): Promise<Resource[]> => {
      const selected = new Map<string, string | undefined>();
      for (const item of items) if (!selected.has(item.issue_revision_id)) selected.set(item.issue_revision_id, (await tx.getSelection(item.issue_revision_id))?.candidate_id);
      return items.map((item): Resource => {
        const preview = [...item.submission_explanation].slice(0, 96).join("");
        const isSelected = selected.get(item.issue_revision_id) === item.id;
        if (filter.selected !== undefined && filter.selected !== isSelected) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate list selection filter does not match the stored Selection", false, { resource_type: "candidate", resource_id: item.id });
        return { resource_type: "candidate", resource_id: item.id, created_at: item.created_at, label: `${item.refines_candidate_id ? "Refinement" : "Candidate"}: ${preview}${preview.length < item.submission_explanation.length ? "…" : ""}`, state: standing(item.verification_total, item.qualified_verifications, item.rejected_verifications), is_selected: isSelected, issue: { id: item.issue_id, version: item.issue_version }, repository: { id: item.repository_id, canonical_remote: item.canonical_remote } };
      });
  };

  private candidatePage(bound: Record<string, string | number | boolean | null>, query: Record<string, string | number | boolean>, filter: CandidateListFilter, page: ListPageRequest, revisionOf: (tx: ReadTx) => Promise<string>): Promise<ResourceListResult> {
    return readListPage(this.store, { resource: "candidate", command: "candidate.list", filters: bound, query, sort: "created_at:asc,id:asc", request: page, byteLimit: this.pageByteLimit, load: async (tx, after, limit) => {
      if (filter.repository_id) await tx.getRepository(filter.repository_id);
      const result = await tx.listCandidatesPage(await revisionOf(tx), filter, after !== undefined && typeof after === "object" ? after : undefined, limit);
      const resources = await this.candidateResources(tx, result.rows, filter);
      return { more: result.more, entries: result.rows.map((item, index) => ({ resource: resources[index], after: { key: item.order_key ?? "", id: item.id } })) };
    } });
  }

  async listCandidates(issueRevisionId = "", options: CandidateListOptions = {}, page?: ListPageRequest): Promise<ResourceListResult> {
    if (issueRevisionId) ensureID("issue_revision_id", issueRevisionId);
    const filter = validateCandidateListOptions(options);
    const query = { ...(filter.repository_id ? { repository_id: filter.repository_id } : {}), ...(filter.standing ? { standing: filter.standing } : {}), ...(filter.selected === undefined ? {} : { selected: filter.selected }) };
    if (isPagedRequest(page)) return resultSize("Candidate list", await this.candidatePage({ issue_revision_id: issueRevisionId || null, repository_id: filter.repository_id ?? null, standing: filter.standing ?? null, selected: filter.selected ?? null }, query, filter, page, async () => issueRevisionId));
    return withPagingHint("candidate", async () => {
      const resources = await this.store.read(async tx => { if (filter.repository_id) await tx.getRepository(filter.repository_id); return this.candidateResources(tx, await tx.listCandidates(issueRevisionId, filter), filter); });
      return resultSize("Candidate list", { result_type: "patchledger.result.resource-list/v1", command: "candidate.list", resources, query });
    });
  }

  async listCandidatesForIssue(issueId: string, version?: number, options: CandidateListOptions = {}, page?: ListPageRequest): Promise<ResourceListResult> {
    ensureID("issue_id", issueId);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw validation("issue_version", "must be a positive integer");
    const resolve = async (tx: ReadTx): Promise<string> => (version === undefined ? await tx.getCurrentIssueRevision(issueId) : await tx.getIssueRevisionByNumber(issueId, version)).id;
    if (isPagedRequest(page)) {
      const filter = validateCandidateListOptions(options);
      const query = { issue_id: issueId, ...(version === undefined ? {} : { issue_version: version }), ...(filter.repository_id ? { repository_id: filter.repository_id } : {}), ...(filter.standing ? { standing: filter.standing } : {}), ...(filter.selected === undefined ? {} : { selected: filter.selected }) };
      return resultSize("Candidate list", await this.candidatePage({ issue_id: issueId, issue_version: version ?? null, repository_id: filter.repository_id ?? null, standing: filter.standing ?? null, selected: filter.selected ?? null }, query, filter, page, resolve));
    }
    const revision = await this.store.read(async tx => version === undefined ? tx.getCurrentIssueRevision(issueId) : tx.getIssueRevisionByNumber(issueId, version));
    const result = await this.listCandidates(revision.id, options);
    return { ...result, query: { issue_id: issueId, issue_version: revision.revision_number, ...result.query } };
  }

  async compareCandidateSummary(candidateIds: string[]): Promise<import("./comparison.js").CandidateComparisonSummaryResult> {
    return this.buildComparison(candidateIds, {}, true) as Promise<import("./comparison.js").CandidateComparisonSummaryResult>;
  }

  async compareCandidates(candidateIds: string[], options: PairwiseOptions = {}): Promise<CandidateComparisonResult> {
    return this.buildComparison(candidateIds, options, false) as Promise<CandidateComparisonResult>;
  }

  private async buildComparison(candidateIds: string[], options: PairwiseOptions, summary: boolean): Promise<CandidateComparisonResult | import("./comparison.js").CandidateComparisonSummaryResult> {
    if (!Array.isArray(candidateIds) || candidateIds.length < 2 || candidateIds.length > 16) throw validation("candidate_ids", "must contain between 2 and 16 candidates");
    candidateIds.forEach((id) => ensureID("candidate_id", id));
    if (new Set(candidateIds).size !== candidateIds.length) throw validation("candidate_ids", "must not contain duplicates");
    if (!isRecordValue(options)) throw validation("options", "must be an object");
    if (options.include_patch_ids !== undefined && !Array.isArray(options.include_patch_ids)) throw validation("include_patch_ids", "must be an array");
    const includePatchIds = new Set(options.include_patch_ids ?? []);
    for (const id of includePatchIds) ensureID("include_patch_ids", id);
    for (const id of includePatchIds) if (!candidateIds.includes(id)) throw validation("include_patch_ids", "must only contain compared Candidate IDs");
    const requestedPairs = options.pairwise_pairs ?? [];
    if (!Array.isArray(requestedPairs)) throw validation("pairwise_pairs", "must be an array");
    if (requestedPairs.length > 8) throw validation("pairwise_pairs", "must contain at most 8 pairs");
    requestedPairs.forEach((pair, index) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw validation(`pairwise_pairs[${index}]`, "must contain exactly two Candidate IDs");
      ensureID(`pairwise_pairs[${index}][0]`, pair[0]);
      ensureID(`pairwise_pairs[${index}][1]`, pair[1]);
    });

    const loaded = await this.store.read(async (tx) => {
      const records = await Promise.all(candidateIds.map((id) => tx.getCandidate(id)));
      const issueRevisionID = records[0].candidate.issue_revision_id;
      if (records.some((record) => record.candidate.issue_revision_id !== issueRevisionID)) throw validation("candidate_ids", "all Candidates must belong to one IssueRevision");
      const issueRevision = await tx.getIssueRevisionById(issueRevisionID);
      const issue = await tx.getIssue(issueRevision.issue_id);
      const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id);
      for (const record of records) validateCandidateBindings(record, issue, issueRevision, requirementRevision);
      const sorted = [...records].sort((left, right) => compareText(timestampOrderKey(left.candidate.created_at), timestampOrderKey(right.candidate.created_at)) || (left.ledger_event_seq ?? Number.MAX_SAFE_INTEGER) - (right.ledger_event_seq ?? Number.MAX_SAFE_INTEGER) || compareText(left.candidate.id, right.candidate.id));
      const candidates: { value: ComparisonCandidate; resultTree: string }[] = [];
      const patches = new Map<string, Buffer>();
      for (const record of sorted) {
        const verificationFacts = await comparisonVerificationFacts(tx, record.candidate.id);
        const patch = summary ? Buffer.alloc(0) : record.artifact.patch;
        patches.set(record.candidate.id, patch);
        const patchProjection = inlinePatch(patch, includePatchIds.has(record.candidate.id));
        candidates.push({
          resultTree: record.candidate.result_tree_oid,
          value: {
            base_commit: record.candidate.base_commit ?? issueRevision.baseline.git_oid,
            candidate_id: record.candidate.id,
            dev_run_id: record.candidate.dev_run_id,
            ...(record.exploration_brief ? { exploration_brief: record.exploration_brief } : {}),
            ...(record.refines_candidate_id ? { refines_candidate_id: record.refines_candidate_id } : {}),
            submission_explanation: textPreview(record.candidate.submission.explanation),
            attribution: record.candidate.attribution,
            created_at: record.candidate.created_at,
            standing: verificationFacts.set.standing,
            is_selected: (await tx.getSelection(issueRevisionID))?.candidate_id === record.candidate.id,
            result_tree_oid: record.candidate.result_tree_oid,
            equivalence_group: record.candidate.result_tree_oid,
            patch_digest: record.candidate.patch_digest,
            ...patchProjection,
            diff_from_baseline: summary ? { files: record.artifact.files.length, insertions: 0, deletions: 0 } : diffStats(record.artifact.files, patch),
            manifest_digest: manifestDigest(record.artifact.files),
            changed_files_count: record.artifact.files.length,
            changed_files: record.artifact.files.slice(0, 2000),
            changed_files_omitted: record.artifact.files.length > 2000,
            claims: comparisonClaims(record.candidate.submission.claims, verificationFacts.criterionStandings),
            verification_count: verificationFacts.set.count,
            verification_digest: verificationFacts.set.digest,
            verification_summaries: verificationFacts.summaries.map(toVerificationSummary),
            verification_summaries_omitted: verificationFacts.set.count > verificationFacts.summaries.length,
          },
        });
      }
      return { records, issueRevision, candidates, patches };
    });

    if (summary) {
      return resultSize("Candidate comparison summary", {
        result_type: "patchledger.result.candidate-comparison-summary/v1" as const,
        command: "candidate.compare" as const,
        issue: { id: loaded.issueRevision.issue_id, version: loaded.issueRevision.revision_number },
        baseline_oid: loaded.issueRevision.baseline.git_oid,
        candidates: loaded.candidates.map(({ value: { patch_state, patch, diff_from_baseline, ...candidate } }) => candidate),
      });
    }

    if (this.treeDiffProvider) {
      for (const candidate of loaded.candidates) {
        const diff = await this.treeDiffProvider(candidate.value.base_commit, candidate.resultTree);
        candidate.value.diff_from_baseline = { files: diff.files, insertions: diff.insertions, deletions: diff.deletions };
      }
    }

    const pairwise: PairwiseCandidateDiff[] = [];
    for (const [leftId, rightId] of requestedPairs) {
      const left = loaded.records.find((record) => record.candidate.id === leftId);
      const right = loaded.records.find((record) => record.candidate.id === rightId);
      if (!left || !right || leftId === rightId) throw validation("pairwise_pairs", "pair members must be distinct compared Candidate IDs");
      const equivalent = left.candidate.result_tree_oid === right.candidate.result_tree_oid;
      const leftPatch = loaded.patches.get(leftId) ?? Buffer.alloc(0);
      const rightPatch = loaded.patches.get(rightId) ?? Buffer.alloc(0);
      const fallbackStats = fallbackPairwiseStats(left.artifact.files, right.artifact.files, leftPatch, rightPatch);
      const diff = equivalent
        ? { patch: Buffer.alloc(0), files: 0, insertions: 0, deletions: 0, binary: false, too_large: false }
        : this.treeDiffProvider
          ? await this.treeDiffProvider(left.candidate.result_tree_oid, right.candidate.result_tree_oid)
          : { patch: fallbackUnifiedDiff(leftId, rightId, leftPatch, rightPatch), files: fallbackStats.files, insertions: fallbackStats.insertions, deletions: fallbackStats.deletions, binary: patchIsBinary(leftPatch) || patchIsBinary(rightPatch), too_large: leftPatch.length + rightPatch.length + 128 > 1024 * 1024 };
      const pairwiseDigest = sha256({ left_patch_digest: left.candidate.patch_digest, right_patch_digest: right.candidate.patch_digest, left_result_tree_oid: left.candidate.result_tree_oid, right_result_tree_oid: right.candidate.result_tree_oid });
      const pair = inlineTreeDiff(leftId, rightId, equivalent, diff.patch, { files: diff.files, insertions: diff.insertions, deletions: diff.deletions }, diff.binary, pairwiseDigest, diff.too_large);
      const leftBase = left.candidate.base_commit ?? loaded.issueRevision.baseline.git_oid;
      const rightBase = right.candidate.base_commit ?? loaded.issueRevision.baseline.git_oid;
      if (leftBase !== rightBase) pair.upstream_changes = await this.upstreamChanges(leftBase, rightBase);
      pairwise.push(pair);
    }

    return enforceComparisonSize({
      result_type: "patchledger.result.candidate-comparison/v1",
      command: "candidate.compare",
      issue: { id: loaded.issueRevision.issue_id, version: loaded.issueRevision.revision_number },
      baseline_oid: loaded.issueRevision.baseline.git_oid,
      candidates: loaded.candidates.map((candidate) => candidate.value),
      pairwise_diffs: pairwise,
    });
  }

  async submitVerification(input: SubmitVerificationCommand): Promise<VerificationSubmitResult> {
    const op = opID(input.operation_id); input = { ...input, operation_id: op }; validateAttribution(input.attribution); validateVerificationReport(input.report);
    if (input.quality) {
      validateAttribution(input.quality.attribution);
      validateQualityReviewReport(input.quality.report);
      if (input.quality.report.candidate_id !== input.report.candidate_id || input.quality.report.result_tree_oid !== input.report.result_tree_oid || input.quality.report.blind_context_digest !== input.report.blind_context_digest) {
        throw validation("quality", "the contract and quality parts must be bound to the same Candidate, result tree, and blind context digest");
      }
    }
    // The blind protocol's value depends on the verifier being distinct from
    // the Candidate developer.  An Agent that submitted the Candidate cannot
    // independently verify it: reject the submission instead of trusting the
    // caller to police their own identity.  Ultra adds a third role, so the
    // contract verifier and the quality reviewer must also differ.
    const developer = await this.store.read(async (tx) => (await tx.getCandidate(input.report.candidate_id)).candidate.attribution);
    const sameAgent = (left: Attribution, right: Attribution): boolean => left.kind === "agent" && right.kind === "agent" && left.agent_id === right.agent_id;
    if (sameAgent(input.attribution, developer)) {
      throw validation("attribution", `verifier agent ${input.attribution.agent_id} also authored the Candidate; blind verification requires a distinct verifier`);
    }
    if (input.quality) {
      if (sameAgent(input.quality.attribution, developer)) throw validation("quality.attribution", "the quality reviewer also authored the Candidate; ultra verification requires a distinct quality reviewer");
      if (sameAgent(input.quality.attribution, input.attribution)) throw validation("quality.attribution", "the quality reviewer is also the contract verifier; ultra verification requires two distinct verifiers");
    }
    const resolved = await this.store.read(async (tx) => {
      const candidate = await tx.getCandidate(input.report.candidate_id);
      const issueRevision = await tx.getIssueRevisionById(candidate.candidate.issue_revision_id);
      const issue = await tx.getIssue(issueRevision.issue_id);
      return { candidate, issueRevision, issue, requirementRevision: await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id), repository: await tx.getRepository(issue.repository_id) };
    });
    const verificationID = this.newId();
    const hash = operationHash(command.verificationSubmit, input.quality ? { ...canonicalVerificationReport(input.report), mode: "ultra", quality: { attribution: input.quality.attribution, report: canonicalQualityReport(input.quality.report) } } : canonicalVerificationReport(input.report), input.attribution, { requirement_revision: resolved.requirementRevision, issue_revision: hashableIssueRevision(resolved.issueRevision), repository: { id: resolved.repository.id }, baseline: resolved.issueRevision.baseline, candidate: { id: resolved.candidate.candidate.id, result_tree_oid: resolved.candidate.candidate.result_tree_oid, patch_digest: resolved.candidate.candidate.patch_digest, blind_context_digest: resolved.candidate.candidate.blind_context_digest } }, { candidate_id: input.report.candidate_id }); let result!: VerificationSubmitResult;
    await this.store.write(async (tx) => {
      const replay = await tx.reserveOperation({ id: op, command: command.verificationSubmit, request_hash: hash });
      if (replay) { result = decodeReplay<VerificationSubmitResult>(replay).data; return; }
      const candidate = await tx.getCandidate(input.report.candidate_id);
      await tx.lockCandidateVerifications(candidate.candidate.id);
      if (candidate.candidate.result_tree_oid !== input.report.result_tree_oid) throw validation("result_tree_oid", "does not match the Candidate");
      if (candidate.candidate.blind_context_digest !== input.report.blind_context_digest) throw validation("blind_context_digest", "does not match the Candidate");
      const issueRevision = await tx.getIssueRevisionById(candidate.candidate.issue_revision_id);
      const issue = await tx.getIssue(issueRevision.issue_id);
      const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id);
      const repository = await tx.getRepository(issue.repository_id);
      validateCandidateBindings(candidate, issue, issueRevision, requirementRevision);
      validateVerificationCoverage(input.report, issueRevision);
      if (input.quality) validateQualityLocations(input.quality.report, candidate.artifact.files);
      const source: CandidateContextSource = {
        ...(candidate.candidate.base_commit ? { base_commit: candidate.candidate.base_commit } : {}),
        candidate_id: candidate.candidate.id,
        repository_id: repository.id,
        canonical_remote_at_submission: candidate.candidate.repository_remote_snapshot,
        result_tree_oid: candidate.candidate.result_tree_oid,
        patch_digest: candidate.candidate.patch_digest,
        requirement_revision: requirementRevision,
        issue_revision: issueRevision,
        artifact: candidate.artifact,
        submission: candidate.candidate.submission,
      };
      if (!blindContextDigestMatches(candidate.candidate.blind_context_digest, source)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Candidate blind context digest does not match its immutable facts", false, { resource_id: candidate.candidate.id, reason: "Candidate context digest mismatch" });
      const verdict = combinedVerdict(input.report, input.quality?.report);
      const now = await tx.now();
      const verification: Verification = {
        id: verificationID,
        candidate_id: candidate.candidate.id,
        result_tree_oid: input.report.result_tree_oid,
        blind_context_digest: input.report.blind_context_digest,
        overall_verdict: verdict,
        created_at: now,
        attribution: input.attribution,
      };
      await tx.createVerification({ verification, report: input.report, ...(input.quality ? { quality: { report: canonicalQualityReport(input.quality.report), attribution: input.quality.attribution } } : {}) });
      const qualityFacts: Record<string, string> = input.quality
        ? { mode: "ultra", quality_overall_verdict: qualityOverallVerdict(input.quality.report), quality_verifier: JSON.stringify(input.quality.attribution) }
        : {};
      await tx.appendLedgerEvent(event(this.newId(), "verification.submitted", op, "verification", verification.id, issue.repository_id, undefined, now, input.attribution, {
        candidate_id: verification.candidate_id,
        result_tree_oid: verification.result_tree_oid,
        blind_context_digest: verification.blind_context_digest,
        overall_verdict: verdict,
        ...qualityFacts,
      }));
      result = {
        result_type: "patchledger.result.verification-submit/v1",
        command: command.verificationSubmit,
        verification_id: verificationID,
        candidate_id: candidate.candidate.id,
        mode: input.quality ? "ultra" : "normal",
        overall_verdict: verdict,
        standing: await tx.candidateStanding(candidate.candidate.id),
        created_at: now,
      };
      await tx.completeOperation(op, JSON.stringify(envelopeData(result, op, [])));
    });
    return result;
  }

  async verificationContext(candidateId: string, phase: VerificationPhase = "blind", role: VerificationRole = "contract"): Promise<VerificationContextResult> {
    ensureID("candidate_id", candidateId);
    if (phase !== "blind" && phase !== "reconcile") throw validation("phase", "must be blind or reconcile");
    parseVerificationRole(role);
    return this.store.read(async (tx) => {
      const record = await tx.getCandidate(candidateId);
      const issueRevision = await tx.getIssueRevisionById(record.candidate.issue_revision_id);
      const issue = await tx.getIssue(issueRevision.issue_id);
      const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id);
      validateCandidateBindings(record, issue, issueRevision, requirementRevision);
      const source: CandidateContextSource & { blind_context_digest: string } = {
        candidate_id: candidateId,
        ...(record.candidate.base_commit ? { base_commit: record.candidate.base_commit } : {}),
        repository_id: issue.repository_id,
        canonical_remote_at_submission: record.candidate.repository_remote_snapshot,
        result_tree_oid: record.candidate.result_tree_oid,
        patch_digest: record.candidate.patch_digest,
        blind_context_digest: record.candidate.blind_context_digest,
        requirement_revision: requirementRevision,
        issue_revision: issueRevision,
        artifact: record.artifact,
        submission: record.candidate.submission,
      };
      if (!blindContextDigestMatches(record.candidate.blind_context_digest, source)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Candidate blind context digest does not match its immutable facts", false, { resource_id: candidateId, reason: "Candidate context digest mismatch" });
      // A VerificationReport must echo the stored digest, which may come from the superseded payload revision.
      const anchored = { ...source, blind_context_digest: record.candidate.blind_context_digest };
      // The quality reviewer sees the same sealed contract and Artifact in the blind phase and only the author's
      // explanation and Change Rationales in the reconcile phase; never Claims, self-verification or verifier results.
      const context = role === "quality"
        ? (phase === "blind" ? qualityBlindContextFrom(blindVerificationContextFor(anchored)) : qualityReconcileContextFrom(anchored))
        : phase === "blind" ? blindVerificationContextFor(anchored) : reconcileVerificationContextFor(anchored);
      if (context.phase === "blind") this.addSnapshotRelation(context);
      contextSize(context);
      return { result_type: "patchledger.result.verification-context/v1", command: "verification.context", context };
    });
  }

  async showVerification(verificationId: string): Promise<VerificationDetailResult> { ensureID("verification_id", verificationId); const result = await this.store.read(async (tx) => { const record = await tx.getVerification(verificationId); return { result_type: "patchledger.result.verification-detail/v1", command: "verification.show", verification_id: record.verification.id, candidate_id: record.verification.candidate_id, overall_verdict: record.verification.overall_verdict, mode: record.quality ? "ultra" as const : "normal" as const, created_at: record.verification.created_at, attribution: record.verification.attribution, report: record.report, ...(record.quality ? { quality: toQualityDetail(record.quality) } : {}) }; }); return resultSize("Verification detail", result); }
  async listVerifications(candidateId = "", options: VerificationListOptions = {}, page?: ListPageRequest): Promise<ResourceListResult> {
    if (candidateId) ensureID("candidate_id", candidateId);
    const filter = validateVerificationListOptions(options);
    const query = { ...(candidateId ? { candidate_id: candidateId } : {}), ...(filter.verdict ? { verdict: filter.verdict } : {}) };
    const toResource = (item: VerificationSummaryItem): Resource => ({ resource_type: "verification", resource_id: item.id, label: `Verification ${item.id}`, state: item.overall_verdict, overall_verdict: item.overall_verdict, mode: item.mode, ...(item.quality ? { quality_verdict: item.quality.verdict, quality_attribution: item.quality.attribution } : {}), created_at: item.created_at, candidate_id: item.candidate_id, ...(item.issue_id && item.issue_version ? { issue: { id: item.issue_id, version: item.issue_version } } : {}) });
    if (isPagedRequest(page)) return resultSize("Verification list", await readListPage(this.store, { resource: "verification", command: "verification.list", filters: { candidate_id: candidateId || null, verdict: filter.verdict ?? null }, query, sort: "created_at:asc,id:asc", request: page, byteLimit: this.pageByteLimit, load: async (tx, after, limit) => { const result = await tx.listVerificationsPage(candidateId, filter, after !== undefined && typeof after === "object" ? after : undefined, limit); return { more: result.more, entries: result.rows.map((item) => ({ resource: toResource(item), after: { key: item.order_key, id: item.id } })) }; } }));
    return withPagingHint("verification", async () => { const resources = await this.store.read(async (tx) => (await tx.listVerifications(candidateId, filter)).map(toResource)); return resultSize("Verification list", { result_type: "patchledger.result.resource-list/v1", command: "verification.list", resources, query }); });
  }

  async listLedger(afterCursor: string | number = "", repositoryId = "", subjectType = "", subjectId = "", limit = 0): Promise<LedgerResult> {
    const afterSeq = typeof afterCursor === "number" ? afterCursor : decodeLedgerCursor(afterCursor);
    if (typeof afterCursor === "number" && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) throw validation("after", "must be a non-negative integer cursor");
    const pageLimit = limit === 0 ? 1000 : limit;
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 1000) throw validation("limit", "must be between 1 and 1000");
    if (repositoryId) ensureID("repository_id", repositoryId); if (subjectId) ensureID("subject_id", subjectId);
    if (subjectType && !["requirement", "repository", "issue", "dev_run", "candidate", "verification", "delivery_link", "selection", "issue_completion", "eval_grader", "eval_suite", "eval_snapshot", "eval_experiment", "eval_run", "eval_execution", "eval_result", "eval_notice", "eval_qa", "eval_artifact", "eval_environment", "eval_envcheck", "eval_preparation", "eval_instance"].includes(subjectType)) throw validation("subject_type", "is not a supported public LedgerEvent subject type");
    const projectedFilter = subjectType === "requirement" || subjectType === "issue" || subjectType === "issue_completion" || (!subjectType && !!subjectId);
    if (!projectedFilter) {
      const page = await this.store.read((tx) => tx.listLedgerEventsPage(afterSeq, repositoryId, subjectType, subjectId, pageLimit));
      return resultSize("Ledger list", { result_type: "patchledger.result.ledger/v1", command: "ledger.list", events: page.rows.map(publicLedgerEvent), ...(page.more && page.rows.length ? { next_cursor: Buffer.from(String(page.rows[page.rows.length - 1].event_seq ?? 0), "utf8").toString("base64url") } : {}) });
    }
    const events: LedgerEventView[] = [];
    let cursor = afterSeq; let more = true; let stopped = false;
    while (more && events.length < pageLimit) {
      const page = await this.store.read((tx) => tx.listLedgerEventsPage(cursor, repositoryId, "", "", 1000));
      more = page.more;
      for (const row of page.rows) {
        cursor = row.event_seq ?? cursor;
        const projected = publicLedgerEvent(row);
        if ((!subjectType || projected.subject_type === subjectType) && (!subjectId || projected.subject_id === subjectId)) events.push(projected);
        if (events.length === pageLimit) { stopped = more || row !== page.rows[page.rows.length - 1]; break; }
      }
      if (!page.rows.length) more = false;
    }
    return resultSize("Ledger list", { result_type: "patchledger.result.ledger/v1", command: "ledger.list", events, ...((stopped || more) && cursor ? { next_cursor: Buffer.from(String(cursor), "utf8").toString("base64url") } : {}) });
  }
  async showLedger(eventId: string): Promise<LedgerResult> { ensureID("event_id", eventId); const eventRecord = await this.store.read((tx) => tx.getLedgerEvent(eventId)); return resultSize("Ledger event", { result_type: "patchledger.result.ledger/v1", command: "ledger.show", events: [publicLedgerEvent(eventRecord)] }); }

  private async buildDevRunContext(tx: ReadTx, devRunId: string, allowSubmitted: boolean, includeVerificationIds: string[]): Promise<DevRunContextResult> {
    const run = await tx.getDevRun(devRunId);
    if (run.state !== "open" && !((allowSubmitted || run.development) && run.state === "submitted")) throw stateConflict("dev_run", devRunId, "context is available only for an open DevRun");
    const issueRevision = await tx.getIssueRevisionById(run.issue_revision_id);
    const issue = await tx.getIssue(issueRevision.issue_id);
    const requirementRevision = await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id);
    if (!run.refines_candidate_id && includeVerificationIds.length > 0) throw validation("include_verification", "is only valid for a refinement DevRun");
    const preflight = await devRunPreflightView(tx, devRunId);
    const context = {
      ...(preflight ? { preflight } : {}),
      format: "patchledger.devrun-context/v1",
      generated_at: await tx.now(),
      dev_run: { ...(run.execution_mode ? { execution_mode: run.execution_mode } : {}), ...(run.initial_base_commit ? { initial_base_commit: run.initial_base_commit } : {}), ...(run.artifact_restoration ? { artifact_restoration: run.artifact_restoration } : {}), ...(run.development ? { development: run.development } : {}), id: run.id, version: run.version, state: run.state, ...(run.exploration_brief ? { exploration_brief: run.exploration_brief } : {}) },
      repository: { id: issue.repository_id, canonical_remote: run.repository_remote_snapshot },
      ...(run.base_commit ? { base_commit: run.base_commit } : {}),
      baseline: issueRevision.baseline,
      requirement: requirementVersionForContext(requirementRevision),
      issue: issueVersionForContext(issueRevision, requirementRevision),
      ...(run.refines_candidate_id ? {
        refinement: await (async () => {
          const parent = await tx.getCandidate(run.refines_candidate_id!);
          // A refinement freezes facts from the parent Candidate.  Validate the
          // complete aggregate binding before reading its verifications so a
          // tampered cross-Issue/Requirement reference cannot leak into the
          // DevRun context.
          validateCandidateBindings(parent, issue, issueRevision, requirementRevision);
          if (parent.candidate.issue_revision_id !== issueRevision.id) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "DevRun refinement parent is bound to another IssueRevision", false, { resource_id: run.id, reason: "refinement parent IssueRevision mismatch" });
          return this.refinementContext(tx, parent, await tx.listDevRunRefinementVerifications(run.id), includeVerificationIds);
        })(),
      } : {}),
    } as DevRunContext;
    this.addSnapshotRelation(context);
    contextSize(context);
    return { result_type: "patchledger.result.devrun-context/v1", command: "devrun.context", context };
  }

  private async refinementContext(tx: ReadTx, parent: CandidateRecord, frozenIds?: string[], includedIds: string[] = []): Promise<RefinementContext> {
    let summaries: VerificationSummaryItem[];
    if (frozenIds === undefined) {
      const page = await tx.listVerificationSummariesPage(parent.candidate.id, "", 256);
      if (page.more) throw new DomainError("ARTIFACT_TOO_LARGE", "refinement cannot freeze more than 256 Verifications");
      summaries = page.rows;
    } else {
      summaries = await Promise.all(frozenIds.map((id) => tx.getVerificationSummary(id)));
    }
    if (summaries.length > 256) throw new DomainError("ARTIFACT_TOO_LARGE", "refinement cannot freeze more than 256 Verifications");
    const summaryIDs = new Set<string>();
    const verdicts = new Set(["qualified", "rejected", "inconclusive"]);
    for (const summary of summaries) {
      if (summaryIDs.has(summary.id)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "refinement snapshot contains a duplicate Verification", false, { resource_id: parent.candidate.id, reason: "frozen Verification IDs are not unique" });
      summaryIDs.add(summary.id);
      if (summary.candidate_id !== parent.candidate.id) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "refinement snapshot references another Candidate", false, { resource_id: parent.candidate.id, reason: "frozen Verification Candidate mismatch" });
      if (!verdicts.has(summary.overall_verdict)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "refinement snapshot contains an invalid Verification verdict", false, { resource_id: summary.id, reason: "overall_verdict is not a supported value" });
    }
    const frozen = new Set(summaries.map((summary) => summary.id));
    for (const id of includedIds) if (!frozen.has(id)) throw validation("include_verification", "Verification must belong to the frozen refinement set");
    const reports = await Promise.all([...includedIds].sort(compareText).map(async (id) => {
      const verification = await tx.getVerification(id);
      const summary = summaries.find((item) => item.id === id);
      if (verification.verification.candidate_id !== parent.candidate.id || !summary || verification.verification.overall_verdict !== summary.overall_verdict) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "frozen Verification record does not match its summary", false, { resource_id: id, reason: "Verification Candidate or verdict mismatch" });
      return { verification_id: id, report: verification.report, mode: verification.quality ? "ultra" as const : "normal" as const, ...(verification.quality ? { quality: toQualityDetail(verification.quality) } : {}) };
    }));
    const standings = await tx.listCriterionStandings(parent.candidate.id, summaries.map((summary) => summary.id));
    const issueRevision = await tx.getIssueRevisionById(parent.candidate.issue_revision_id);
    const grouped: RefinementContext["criterion_standings"] = [];
    for (const target of [...issueRevision.goals.map((goal) => ({ target_type: "goal", target_id: goal.id, criteria: goal.criteria })), ...issueRevision.constraints.map((constraint) => ({ target_type: "constraint", target_id: constraint.id, criteria: constraint.criteria }))]) {
      grouped.push({ target_type: target.target_type, target_id: target.target_id, criteria: target.criteria.map((criterion) => ({ criterion_id: criterion.id, standing: standings[`${target.target_type}:${target.target_id}:${criterion.id}`] ?? "unverified" })) });
    }
    const qualified = summaries.filter((summary) => summary.overall_verdict === "qualified").length;
    const rejected = summaries.filter((summary) => summary.overall_verdict === "rejected").length;
    return {
      parent_candidate_id: parent.candidate.id,
      parent_result_tree_oid: parent.candidate.result_tree_oid,
      parent_claims: claimRecords(parent.candidate.submission.claims),
      standing_at_start: standing(summaries.length, qualified, rejected),
      frozen_verifications: summaries.map(toVerificationSummary),
      criterion_standings: grouped,
      included_verification_reports: reports,
    };
  }
}

const makeIssueRevision = (newId: () => string, issueID: string, requirementID: string, requirementRevisionID: string, revisionID: string, revisionNumber: number, predecessorRevisionID: string | undefined, baseline: Baseline, input: IssueInput, requirement: RequirementRevision): IssueRevision => {
  validateIssueIntentLinks(input, requirement);
  return { id: revisionID, issue_id: issueID, requirement_id: requirementID, requirement_revision_id: requirementRevisionID, revision_number: revisionNumber, ...(predecessorRevisionID ? { predecessor_revision_id: predecessorRevisionID } : {}), baseline, ...(input.target_branch ? { target_branch: { ...input.target_branch } } : {}), summary: input.summary, ...(input.context === undefined ? {} : { context: input.context }), ...(input.plan === undefined ? {} : { plan: input.plan }), goals: input.goals.map((goal) => ({ id: newId(), statement: goal.statement, criteria: goal.criteria.map((statement) => ({ id: newId(), statement })), guidance: goal.guidance ?? [], ...(goal.traces_to ? { traces_to: goal.traces_to } : {}) })), constraints: (input.constraints ?? []).map((constraint) => ({ id: newId(), statement: constraint.statement, ...(constraint.rationale === undefined ? {} : { rationale: constraint.rationale }), criteria: constraint.criteria.map((statement) => ({ id: newId(), statement })), guidance: constraint.guidance ?? [], ...(constraint.traces_to ? { traces_to: constraint.traces_to } : {}) })) };
};
const makeTargetKey = (targetType: string, targetID: string): string => `${targetType}:${targetID}`;
const isRecordValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validateCandidateArtifact = (artifact: CandidateArtifact): void => {
  if (!isRecordValue(artifact)) throw validation("artifact", "must be an object");
  if (!Buffer.isBuffer(artifact.patch)) throw validation("patch", "must be a byte buffer");
  if (!isSha256(artifact.patch_digest)) throw validation("patch_digest", "must be a lowercase sha256 digest");
  if (!isGitOID(artifact.result_tree_oid)) throw validation("result_tree_oid", "must be a qualified Git object ID");
  if (artifact.patch.length > 32 * 1024 * 1024) throw new DomainError("ARTIFACT_TOO_LARGE", "Candidate patch exceeds 32 MiB");
  if (sha256Bytes(artifact.patch) !== artifact.patch_digest) throw validation("patch_digest", "does not match the submitted artifact");
  if (!Number.isSafeInteger(artifact.uncompressed_size) || artifact.uncompressed_size < 0) throw validation("uncompressed_size", "must be a non-negative safe integer");
  if (artifact.uncompressed_size !== artifact.patch.length) throw validation("uncompressed_size", "must equal patch byte length");
  if (!Array.isArray(artifact.files)) throw validation("files", "must be an array");
  if (artifact.files.length > 100_000) throw new DomainError("ARTIFACT_TOO_LARGE", "Candidate manifest exceeds 100,000 files");
  const paths = new Set<string>();
  let previousPath: Buffer | undefined;
  for (const [index, file] of artifact.files.entries()) {
    const field = `files[${index}]`;
    if (!isRecordValue(file)) throw validation(field, "must be an object");
    const path = decodeBase64Path(file.path_bytes, `${field}.path_bytes`);
    if (path.length > 1024) throw validation(`${field}.path_bytes`, "decoded Git path must not exceed 1,024 bytes");
    if (previousPath && Buffer.compare(previousPath, path) >= 0) throw validation(`${field}.path_bytes`, "must be strictly sorted by raw path bytes");
    previousPath = path;
    const pathKey = path.toString("hex");
    if (paths.has(pathKey)) throw validation(`${field}.path_bytes`, "must be unique within the manifest");
    paths.add(pathKey);
    if (typeof file.display_path !== "string" || [...file.display_path].length < 1 || [...file.display_path].length > 4096) throw validation(`${field}.display_path`, "must contain between 1 and 4096 characters");
    if (typeof file.change !== "string" || !["added", "modified", "deleted", "renamed", "copied", "type_changed"].includes(file.change)) throw validation(`${field}.change`, "is not a supported Git change kind");
    if (file.old_path_bytes !== undefined) {
      const oldPath = decodeBase64Path(file.old_path_bytes, `${field}.old_path_bytes`);
      if (oldPath.length > 1024) throw validation(`${field}.old_path_bytes`, "decoded Git path must not exceed 1,024 bytes");
    }
    if ((file.change === "renamed" || file.change === "copied") && file.old_path_bytes === undefined) throw validation(`${field}.old_path_bytes`, "is required for renamed or copied files");
    if (file.old_mode !== undefined && (typeof file.old_mode !== "string" || !/^[0-7]{6}$/.test(file.old_mode))) throw validation(`${field}.old_mode`, "must be a six-digit Git mode");
    if (file.new_mode !== undefined && (typeof file.new_mode !== "string" || !/^[0-7]{6}$/.test(file.new_mode))) throw validation(`${field}.new_mode`, "must be a six-digit Git mode");
    if (file.change === "deleted" && file.old_mode === undefined) throw validation(`${field}.old_mode`, "is required for deleted files");
    if (file.change !== "deleted" && file.new_mode === undefined) throw validation(`${field}.new_mode`, "is required for non-deleted files");
  }
};
const decodeBase64Path = (value: string, field: string): Buffer => {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw validation(field, "must be canonical base64");
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64") !== value || decoded.includes(0)) throw validation(field, "must encode a non-empty Git path without NUL");
  return decoded;
};
const validateCandidateCoverage = (submission: CandidateSubmissionInput, issueRevision: IssueRevision): void => { const expected = new Map<string, Set<string>>(); for (const target of [...issueRevision.goals.map((goal) => ({ type: "goal", ...goal })), ...issueRevision.constraints.map((constraint) => ({ type: "constraint", ...constraint }))]) expected.set(makeTargetKey(target.type, target.id), new Set(target.criteria.map((criterion) => criterion.id))); const seen = new Set<string>(); for (const claim of submission.claims) { const key = makeTargetKey(claim.target_type, claim.target_id); const criteria = expected.get(key); if (!criteria) throw validation("claims", `unknown target ${key}`); if (seen.has(key)) throw validation("claims", `duplicate target ${key}`); seen.add(key); const actual = new Set(claim.criteria.map((criterion) => criterion.criterion_id)); if (actual.size !== criteria.size || [...criteria].some((id) => !actual.has(id))) throw validation("claims", `criteria coverage is incomplete for ${key}`); } if (seen.size !== expected.size) throw validation("claims", "claims must cover every goal and constraint exactly once"); };
const validateCandidateRationaleCoverage = (submission: CandidateSubmissionInput, issueRevision: IssueRevision, artifact: CandidateArtifact): void => {
  const inspection = inspectChangeRationaleBindings(submission, issueRevision, artifact);
  if (inspection.problems.length) throw validation("change_rationales", inspection.problems.join("; "));
};
const validateVerificationCoverage = (report: VerificationReportInput, issueRevision: IssueRevision): void => { const expected = new Set<string>(); for (const target of [...issueRevision.goals.map((goal) => ({ target_type: "goal", target_id: goal.id, criteria: goal.criteria })), ...issueRevision.constraints.map((constraint) => ({ target_type: "constraint", target_id: constraint.id, criteria: constraint.criteria }))]) for (const criterion of target.criteria) expected.add(`${target.target_type}:${target.target_id}:${criterion.id}`); const actual = new Set<string>(); for (const target of report.assessments) for (const criterion of target.criteria) { const key = `${target.target_type}:${target.target_id}:${criterion.criterion_id}`; if (!expected.has(key)) throw validation("assessments", `unknown criterion ${key}`); if (actual.has(key)) throw validation("assessments", `duplicate criterion ${key}`); actual.add(key); } if (actual.size !== expected.size) throw validation("assessments", "assessments must cover every IssueRevision criterion exactly once"); };
const preflightIndependentDevRunContext = (issueRevision: IssueRevision, requirementRevision: RequirementRevision, repositoryId: string, generatedAt: string): void => contextSize({
  format: "patchledger.devrun-context/v1",
  generated_at: generatedAt,
  dev_run: { id: issueRevision.id, version: 1, state: "open" },
  repository: { id: repositoryId, canonical_remote: "x".repeat(4096) },
  baseline: issueRevision.baseline,
  requirement: requirementVersionForContext(requirementRevision),
  issue: issueVersionForContext(issueRevision, requirementRevision),
});
const historicalRequirementWarning = (boundID: string, currentID: string): Warning => ({ code: "HISTORICAL_REQUIREMENT_REVISION", message: `the IssueRevision is bound to historical RequirementRevision ${boundID}; current is ${currentID}` });
const requirementRevisionAvailableWarning = (boundID: string, currentID: string): Warning => ({ code: "REQUIREMENT_REVISION_AVAILABLE", message: `the IssueRevision inherited RequirementRevision ${boundID}; newer current revision is ${currentID}` });
const baselineWarning = (baseline: Baseline): Warning => ({ code: "BASELINE_UNCONFIRMED", message: baseline.warning ?? "baseline is not reachable from a matching remote-tracking ref" });
const validateCandidateBindings = (candidate: CandidateRecord, issue: { id: string; requirement_id: string }, issueRevision: IssueRevision, requirementRevision: RequirementRevision): void => {
  if (candidate.candidate.issue_revision_id !== issueRevision.id || issueRevision.issue_id !== issue.id || issueRevision.requirement_id !== issue.requirement_id || requirementRevision.id !== issueRevision.requirement_revision_id || requirementRevision.requirement_id !== issue.requirement_id) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Candidate contract bindings are inconsistent", false, { resource_id: candidate.candidate.id, reason: "Candidate, IssueRevision, and RequirementRevision references do not agree" });
  }
  try {
    validateCandidateSubmission(candidate.candidate.submission);
    validateCandidateCoverage(candidate.candidate.submission, issueRevision);
    validateCandidateRationaleCoverage(candidate.candidate.submission, issueRevision, candidate.artifact);
  } catch (error) {
    const reason = error instanceof DomainError ? String(error.details.reason ?? error.message) : error instanceof Error ? error.message : String(error);
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Candidate coverage is inconsistent", false, { resource_id: candidate.candidate.id, reason });
  }
};
const toVerificationSummary = (summary: VerificationSummaryItem): VerificationSummary => ({ verification_id: summary.id, overall_verdict: summary.overall_verdict, created_at: summary.created_at, attribution: summary.attribution, mode: summary.mode, ...(summary.quality ? { quality_verdict: summary.quality.verdict, quality_attribution: summary.quality.attribution } : {}) });
const toQualityDetail = (quality: NonNullable<VerificationRecord["quality"]>): NonNullable<VerificationDetailResult["quality"]> => ({ overall_verdict: qualityOverallVerdict(quality.report), attribution: quality.attribution, report: quality.report });
/** The facts that identify a Verification inside a set digest; a stored Verification and a list item both satisfy it, and `mode`/quality details are deliberately not part of it. */
const verificationSummaryDigest = (summaries: Array<Pick<VerificationSummaryItem, "id" | "candidate_id" | "overall_verdict" | "created_at" | "attribution">>): string => sha256(summaries.map((summary) => ({ id: summary.id, candidate_id: summary.candidate_id, overall_verdict: summary.overall_verdict, created_at: summary.created_at, attribution: summary.attribution })));
const canonicalTimestamp = (value: string): string => value.replace(/\.([0-9]+)Z$/, (_match, fraction: string) => {
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `.${trimmed}Z` : "Z";
});
export const verificationSetSummary = async (tx: Tx, candidateId: string, visit?: (item: VerificationSummaryItem) => Promise<void>): Promise<VerificationSetSummary> => {
  const verdict_counts = { qualified: 0, rejected: 0, inconclusive: 0 };
  let count = 0;
  const hash = createHash("sha256");
  hash.update("[");
  let first = true;
  let cursor = "";
  for (;;) {
    const page = await tx.readVerificationDirectoryPage(candidateId, cursor, 256);
    for (const item of page.rows) {
      await visit?.(item);
      count++;
      verdict_counts[item.overall_verdict as keyof typeof verdict_counts]++;
      if (!first) hash.update(",");
      first = false;
      hash.update(canonicalBytes({ id: item.id, candidate_id: item.candidate_id, overall_verdict: item.overall_verdict, created_at: canonicalTimestamp(item.created_at), attribution: item.attribution }));
    }
    if (!page.more) break;
    if (!page.rows.length) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "verification page omitted without a cursor");
    cursor = encodeVerificationCursor(page.rows[page.rows.length - 1]);
  }
  hash.update("]");
  return { source: "derived_relation", count, digest: `sha256:${hash.digest("hex")}`, standing: standing(count, verdict_counts.qualified, verdict_counts.rejected), verdict_counts, reports_included: false };
};
// Keep only the first summary page and small counters, not all report bodies.
// Each report still passes the adapter's complete integrity/coverage validation.
const comparisonVerificationFacts = async (tx: ReadTx, candidateId: string) => {
  const summaries: VerificationSummaryItem[] = [];
  const counts = new Map<string, { total: number; qualified: number; rejected: number }>();
  const set = await verificationSetSummary(tx, candidateId, async item => {
    const record = await tx.getVerification(item.id);
    if (verificationSummaryDigest([record.verification]) !== verificationSummaryDigest([item])) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Verification summary projection is invalid", false, { resource_type: "verification", resource_id: item.id });
    }
    if (summaries.length < 256) summaries.push(item);
    for (const target of record.report.assessments) for (const criterion of target.criteria) {
      const key = `${target.target_type}:${target.target_id}:${criterion.criterion_id}`;
      const value = counts.get(key) ?? { total: 0, qualified: 0, rejected: 0 };
      value.total++;
      if (criterion.final.verdict === "qualified") value.qualified++;
      if (criterion.final.verdict === "rejected") value.rejected++;
      counts.set(key, value);
    }
  });
  return { set, summaries, criterionStandings: new Map([...counts].map(([key, value]) => [key, standing(value.total, value.qualified, value.rejected)])) };
};
const verificationSetDigestPaged = async (tx: ReadTx, candidateId: string): Promise<string> => (await verificationSetSummary(tx, candidateId)).digest;
const encodeRequirementCursor = (requirementId: string, revisionId: string, issueId: string): string => Buffer.from(JSON.stringify({ requirement_id: requirementId, requirement_revision_id: revisionId, last_issue_id: issueId }), "utf8").toString("base64url");
const decodeBase64URL = (cursor: string): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length % 4 === 1) throw new Error("invalid base64url");
  const decoded = Buffer.from(cursor, "base64url");
  if (!decoded.length || decoded.toString("base64url") !== cursor.replace(/=+$/, "")) throw new Error("invalid base64url");
  return decoded;
};
const decodeRequirementCursor = (cursor: string, requirementId: string, revisionId: string): string => {
  if (!cursor) return "";
  let parsed: unknown;
  try { parsed = JSON.parse(decodeBase64URL(cursor).toString("utf8")) as unknown; } catch { throw validation("issues_cursor", "must be an opaque cursor"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw validation("issues_cursor", "must be an opaque cursor");
  const value = parsed as { requirement_id?: unknown; requirement_revision_id?: unknown; last_issue_id?: unknown; issue_id?: unknown };
  const issueID = value.last_issue_id ?? value.issue_id;
  if (value.requirement_id !== requirementId || value.requirement_revision_id !== revisionId || typeof issueID !== "string" || !isUUIDv7(issueID)) throw validation("issues_cursor", "cursor is bound to another Requirement or revision");
  return issueID;
};
const encodeManifestCursor = (pathBytes: string): string => Buffer.from(pathBytes, "base64").toString("base64url");
const decodeManifestCursor = (cursor: string): Buffer | undefined => {
  if (!cursor) return undefined;
  try {
    const decoded = decodeBase64URL(cursor);
    if (!decoded.length || decoded.includes(0)) throw new Error("invalid raw path cursor");
    return decoded;
  } catch { throw validation("manifest_cursor", "must be an opaque Candidate manifest page cursor"); }
};
const decodeLedgerCursor = (cursor: string): number => {
  if (!cursor) return 0;
  let value: string;
  try { value = decodeBase64URL(cursor).toString("utf8"); } catch { throw validation("after", "must be an opaque Ledger page cursor"); }
  if (!/^\d+$/.test(value)) throw validation("after", "must be an opaque Ledger page cursor");
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw validation("after", "must be an opaque Ledger page cursor");
  return sequence;
};
