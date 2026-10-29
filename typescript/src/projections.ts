import { sha256 } from "./canonical-json.js";
import {
  CANDIDATE_ARTIFACT_FORMAT,
  claimRecords,
  type CandidateArtifact,
  type CandidateFile,
  type CandidateSubmissionInput,
  type IssueRevision,
  type RequirementRevision,
} from "./domain.js";

export interface RequirementVersion {
  id: string;
  version: number;
  summary: string;
  context?: string;
  outcomes: RequirementRevision["outcomes"];
  decisions: RequirementRevision["decisions"];
  open_questions?: RequirementRevision["open_questions"];
}

export interface IssueVersion {
  id: string;
  version: number;
  requirement: { id: string; version: number };
  target_branch?: IssueRevision["target_branch"];
  summary: string;
  context?: string;
  /** Present only in the public read model; the blind model never carries it. */
  plan?: string;
  goals: IssueRevision["goals"];
  constraints: IssueRevision["constraints"];
}

export interface BlindSubject {
  format: "patchledger.blind-subject/v1" | "patchledger.blind-subject/v2";
  base_commit?: string;
  candidate_id: string;
  repository_id: string;
  baseline_oid: string;
  result_tree_oid: string;
  patch_digest: string;
  artifact_format: typeof CANDIDATE_ARTIFACT_FORMAT;
  requirement: RequirementVersion;
  issue: IssueVersion;
  file_manifest: HashManifestEntry[];
}

export interface HashManifestEntry {
  path_bytes: string;
  change: string;
  old_path_bytes?: string;
  old_mode?: string;
  new_mode?: string;
}

export interface BlindVerificationContext {
  /** Derived, informational history; not an author assertion or digest input. */
  snapshot_relation?: import("./integration-history.js").SnapshotRelation;
  format: "patchledger.verification-context/v1";
  phase: "blind";
  candidate_id: string;
  result_tree_oid: string;
  blind_context_digest: string;
  repository: {
    id: string;
    canonical_remote_at_submission: string;
  };
  baseline: IssueRevision["baseline"];
  base_commit?: string;
  requirement: RequirementVersion;
  issue: IssueVersion;
  artifact: {
    format: typeof CANDIDATE_ARTIFACT_FORMAT;
    patch_digest: string;
    uncompressed_size: number;
    file_manifest: CandidateFile[];
  };
}

export interface ReconcileVerificationContext {
  format: "patchledger.verification-context/v1";
  phase: "reconcile";
  candidate_id: string;
  result_tree_oid: string;
  blind_context_digest: string;
  submission_explanation: string;
  claims: ReturnType<typeof claimRecords>;
}

export type VerificationContext = BlindVerificationContext | ReconcileVerificationContext;
export type VerificationPhase = VerificationContext["phase"];

export interface CandidateContextSource {
  candidate_id: string;
  base_commit?: string;
  repository_id: string;
  canonical_remote_at_submission: string;
  result_tree_oid: string;
  patch_digest: string;
  blind_context_digest?: string;
  requirement_revision: RequirementRevision;
  issue_revision: IssueRevision;
  artifact: CandidateArtifact;
  submission: CandidateSubmissionInput;
}

export const requirementVersionForContext = (revision: RequirementRevision): RequirementVersion => ({
  id: revision.requirement_id,
  version: revision.revision_number,
  summary: revision.summary,
  ...(revision.context === undefined ? {} : { context: revision.context }),
  outcomes: revision.outcomes,
  decisions: revision.decisions,
  ...(revision.open_questions === undefined ? {} : { open_questions: revision.open_questions }),
});

/**
 * The public read model: `issue show`, `devrun context` and the review
 * contract all read the developer-facing Issue Version, which carries the
 * non-normative `plan` when the revision has one.
 */
export const issueVersionForContext = (revision: IssueRevision, requirement: RequirementRevision): IssueVersion => ({
  id: revision.issue_id,
  version: revision.revision_number,
  requirement: { id: requirement.requirement_id, version: requirement.revision_number },
  ...(revision.target_branch ? { target_branch: revision.target_branch } : {}),
  summary: revision.summary,
  ...(revision.context === undefined ? {} : { context: revision.context }),
  ...(revision.plan === undefined || revision.plan === "" ? {} : { plan: revision.plan }),
  goals: revision.goals,
  constraints: revision.constraints,
});

/**
 * The blind read model for the independent verifier. It deliberately omits
 * `plan`: the verifier judges the sealed goals and constraints, and an
 * author's approach narrative would anchor that judgement. Omitting it also
 * keeps `blindContextDigestFor` byte-identical for revisions without a plan,
 * so no stored digest has to move and no `format` bump is needed (ADR-0048
 * records what reusing a format string across payloads costs).
 */
export const blindIssueVersionForContext = (revision: IssueRevision, requirement: RequirementRevision): IssueVersion => ({
  id: revision.issue_id,
  version: revision.revision_number,
  requirement: { id: requirement.requirement_id, version: requirement.revision_number },
  ...(revision.target_branch ? { target_branch: revision.target_branch } : {}),
  summary: revision.summary,
  ...(revision.context === undefined ? {} : { context: revision.context }),
  goals: revision.goals,
  constraints: revision.constraints,
});

const comparePathBytes = (left: CandidateFile, right: CandidateFile): number =>
  Buffer.compare(Buffer.from(left.path_bytes, "base64"), Buffer.from(right.path_bytes, "base64"));

export const sortedFileManifest = (files: CandidateFile[]): CandidateFile[] =>
  [...files].sort(comparePathBytes);

const hashManifestEntry = (file: CandidateFile): HashManifestEntry => ({
  path_bytes: file.path_bytes,
  change: file.change,
  ...(file.old_path_bytes === undefined ? {} : { old_path_bytes: file.old_path_bytes }),
  ...(file.old_mode === undefined ? {} : { old_mode: file.old_mode }),
  ...(file.new_mode === undefined ? {} : { new_mode: file.new_mode }),
});

export const blindSubjectFor = (source: CandidateContextSource): BlindSubject => ({
  format: source.base_commit ? "patchledger.blind-subject/v2" : "patchledger.blind-subject/v1",
  ...(source.base_commit ? { base_commit: source.base_commit } : {}),
  candidate_id: source.candidate_id,
  repository_id: source.repository_id,
  baseline_oid: source.issue_revision.baseline.git_oid,
  result_tree_oid: source.result_tree_oid,
  patch_digest: source.patch_digest,
  artifact_format: CANDIDATE_ARTIFACT_FORMAT,
  requirement: requirementVersionForContext(source.requirement_revision),
  issue: blindIssueVersionForContext(source.issue_revision, source.requirement_revision),
  file_manifest: sortedFileManifest(source.artifact.files).map(hashManifestEntry),
});

export const blindContextDigestFor = (source: CandidateContextSource): string =>
  sha256(blindSubjectFor(source));

// `patchledger.blind-subject/v1` shipped two payload revisions under the same
// format string. Candidates written before 2026-09-07 hash `requirement_revision`
// and a context-shaped `issue_revision`; the current payload hashes the public
// Requirement/Issue versions instead. Existing digests are immutable ledger
// facts, so the superseded payload stays available for verification only; new
// Candidates always use `blindContextDigestFor`. See ADR-0048.
export interface HistoricalIssueRevision {
  id: string;
  issue_id: string;
  requirement_revision_id: string;
  revision_number: number;
  predecessor_revision_id?: string;
  summary: string;
  context?: string;
  goals: IssueRevision["goals"];
  constraints: IssueRevision["constraints"];
}

export interface HistoricalBlindSubject {
  format: "patchledger.blind-subject/v1";
  candidate_id: string;
  repository_id: string;
  baseline_oid: string;
  result_tree_oid: string;
  patch_digest: string;
  artifact_format: typeof CANDIDATE_ARTIFACT_FORMAT;
  requirement_revision: RequirementRevision;
  issue_revision: HistoricalIssueRevision;
  file_manifest: HashManifestEntry[];
}

const historicalIssueRevisionForContext = (revision: IssueRevision): HistoricalIssueRevision => ({
  id: revision.id,
  issue_id: revision.issue_id,
  requirement_revision_id: revision.requirement_revision_id,
  revision_number: revision.revision_number,
  ...(revision.predecessor_revision_id === undefined ? {} : { predecessor_revision_id: revision.predecessor_revision_id }),
  summary: revision.summary,
  ...(revision.context === undefined ? {} : { context: revision.context }),
  goals: revision.goals,
  constraints: revision.constraints,
});

export const historicalBlindSubjectFor = (source: CandidateContextSource): HistoricalBlindSubject => ({
  format: "patchledger.blind-subject/v1",
  candidate_id: source.candidate_id,
  repository_id: source.repository_id,
  baseline_oid: source.issue_revision.baseline.git_oid,
  result_tree_oid: source.result_tree_oid,
  patch_digest: source.patch_digest,
  artifact_format: CANDIDATE_ARTIFACT_FORMAT,
  requirement_revision: source.requirement_revision,
  issue_revision: historicalIssueRevisionForContext(source.issue_revision),
  file_manifest: sortedFileManifest(source.artifact.files).map(hashManifestEntry),
});

export const historicalBlindContextDigestFor = (source: CandidateContextSource): string =>
  sha256(historicalBlindSubjectFor(source));

/** Read-side check: accepts the current payload or the superseded one. */
export const blindContextDigestMatches = (stored: string, source: CandidateContextSource): boolean =>
  stored === blindContextDigestFor(source) || (source.base_commit === undefined && stored === historicalBlindContextDigestFor(source));

export const blindVerificationContextFor = (
  source: CandidateContextSource & { blind_context_digest: string },
): BlindVerificationContext => ({
  format: "patchledger.verification-context/v1",
  phase: "blind",
  candidate_id: source.candidate_id,
  result_tree_oid: source.result_tree_oid,
  blind_context_digest: source.blind_context_digest,
  repository: {
    id: source.repository_id,
    canonical_remote_at_submission: source.canonical_remote_at_submission,
  },
  baseline: source.issue_revision.baseline,
  ...(source.base_commit ? { base_commit: source.base_commit } : {}),
  requirement: requirementVersionForContext(source.requirement_revision),
  issue: blindIssueVersionForContext(source.issue_revision, source.requirement_revision),
  artifact: {
    format: CANDIDATE_ARTIFACT_FORMAT,
    patch_digest: source.patch_digest,
    uncompressed_size: source.artifact.uncompressed_size,
    file_manifest: sortedFileManifest(source.artifact.files),
  },
});

export const reconcileVerificationContextFor = (
  source: CandidateContextSource & { blind_context_digest: string },
): ReconcileVerificationContext => ({
  format: "patchledger.verification-context/v1",
  phase: "reconcile",
  candidate_id: source.candidate_id,
  result_tree_oid: source.result_tree_oid,
  blind_context_digest: source.blind_context_digest,
  submission_explanation: source.submission.explanation,
  claims: claimRecords(source.submission.claims),
});
