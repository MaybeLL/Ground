import type { EvalKind, EvalRecord } from "./evaluation.js";
import type { SelectionRecord } from "./selection.js";
import type {
  Attribution,
  Baseline,
  Candidate,
  CandidateArtifact,
  CandidateFile,
  ClaimRecord,
  Decision,
  DevRun,
  Goal,
  IssueRevision,
  RequirementRevision,
  Verification,
  VerificationReportInput,
} from "./domain.js";
import type { QualityReviewReportInput, VerificationMode, Verdict } from "./quality-review.js";

export interface Metadata {
  database_id: string;
  schema_version: number;
  protocol_version: number;
  minimum_cli_version: string;
  remote_normalization_version: number;
  baseline_reachability_policy: "warn" | "require_override";
  migration_state: "clean" | "dirty" | "in_progress";
}

export interface IntegrityIssue {
  check: string;
  resource_type?: string;
  resource_id?: string;
  reason: string;
}

export interface IntegrityReport {
  valid: boolean;
  issues: IntegrityIssue[];
}

export interface Operation {
  id: string;
  command: string;
  request_hash: string;
}

export interface OperationReplay {
  command: string;
  request_hash: string;
  result_json: string;
}

export interface RequirementRecord {
  id: string;
  created_at: string;
  attribution: Attribution;
}

export interface RevisionRecord {
  revision: RequirementRevision;
  created_at: string;
  attribution: Attribution;
}

export interface RepositoryRecord {
  id: string;
  canonical_remote: string;
  version: number;
  created_at: string;
  attribution: Attribution;
}

export interface RepositoryRemoteRecord {
  remote: string;
  state: "active" | "retired";
}

export interface RepositoryRemoteBinding {
  repository_id: string;
  remote: string;
}

export interface IssueRecord {
  id: string;
  requirement_id: string;
  repository_id: string;
  created_at: string;
  attribution: Attribution;
}

export interface IssueRevisionRecord {
  revision: IssueRevision;
  created_at: string;
  attribution: Attribution;
}

export interface DevRunRecord {
  dev_run: DevRun;
}

export interface ArtifactBlob {
  patch_digest: string;
  codec: "zlib";
  uncompressed_size: number;
  compressed_size: number;
  chunks: Buffer[];
}

export interface CandidateArtifactRef {
  git_artifact?: import("./git-artifact-storage.js").GitCommitArtifact;
  source?: import("./development-branch.js").SourceIdentity;
  base_commit?: string;
  candidate_id: string;
  dev_run_id: string;
  issue_revision_id: string;
  patch_digest: string;
  result_tree_oid: string;
  artifact_format: string;
  /** Recorded size of the stored patch; absent when no artifact row exists. */
  patch_size?: number;
}

export interface CandidateRecord {
  candidate: Candidate;
  artifact: CandidateArtifact;
  exploration_brief?: string;
  refines_candidate_id?: string;
  ledger_event_seq?: number;
}

/** Keyset position for ordered lists: fixed-width sort key plus ID. */
export interface ListPageKey { key: string; id: string }

export interface CandidateListItem {
  order_key?: string;
  id: string;
  issue_revision_id: string;
  issue_id: string;
  issue_version: number;
  repository_id: string;
  canonical_remote: string;
  created_at: string;
  submission_explanation: string;
  refines_candidate_id?: string;
  verification_total: number;
  qualified_verifications: number;
  rejected_verifications: number;
}

/** Second signed part of an ultra Verification; absent for normal mode. */
export interface QualityReviewRecord {
  report: QualityReviewReportInput;
  attribution: Attribution;
}

export interface VerificationRecord {
  verification: Verification;
  report: VerificationReportInput;
  quality?: QualityReviewRecord;
}

export interface VerificationSummaryItem {
  id: string;
  candidate_id: string;
  overall_verdict: string;
  created_at: string;
  attribution: Attribution;
  /** normal when no quality part is stored; ultra otherwise. */
  mode: VerificationMode;
  /** Present for ultra only: overall verdict and reviewer of the quality part. */
  quality?: { verdict: Verdict; attribution: Attribution };
  /** Parent Issue identity; populated by the global list projection only. */
  issue_id?: string;
  issue_version?: number;
}

export interface LedgerEvent {
  event_seq?: number;
  event_id: string;
  event_type: string;
  event_version: number;
  operation_id: string;
  repository_id?: string;
  subject_type: string;
  subject_id: string;
  subject_version?: number;
  occurred_at: string;
  attribution: Attribution;
  facts: { name: string; value: string }[];
}

export interface RequirementListItem {
  bound_count: number;
  completed_count: number;
  id: string;
  summary: string;
  revision_number: number;
  /** Ledger-provable progress over every Issue that belongs to the Requirement. */
  issue_count: number;
  ready_issue_count: number;
  open_dev_run_count: number;
  candidate_count: number;
}

export type IssueBoardStatus = "completed" | "incomplete" | "ready" | "exploring" | "candidates_available" | "candidate_selected";
export interface IssueListFilter {
  repository_id?: string;
  status?: IssueBoardStatus;
  has_open_dev_run?: boolean;
  sort?: "id" | "activity";
}
export interface DevRunListFilter { issue_version?: number; repository_id?: string; state?: "open" | "submitted" | "abandoned" }
export interface CandidateListFilter { repository_id?: string; standing?: string; selected?: boolean }
export interface VerificationListFilter { verdict?: "qualified" | "rejected" | "inconclusive" }

export interface IssueListItem {
  /** Fixed-width activity key; only set when the list is ordered by activity. */
  order_key?: string;
  last_activity?: { occurred_at: string; kind: string; issue_version: number };
  id: string;
  issue_revision_id: string;
  summary: string;
  revision_number: number;
  requirement_id: string;
  requirement_revision_id: string;
  requirement_version: number;
  repository_id: string;
  canonical_remote: string;
  baseline: Baseline;
  open_dev_run_count: number;
  candidate_count: number;
  selected: boolean;
}

export interface RequirementAggregateFacts {
  completed_count: number;
  repository_count: number;
  issue_count: number;
  bound_count: number;
  open_dev_run_count: number;
  candidate_count: number;
  candidate_standings: CandidateVerificationCounts[];
}

export interface CandidateVerificationCounts {
  candidate_id: string;
  total: number;
  qualified: number;
  rejected: number;
}

export interface DevRunListItem {
  id: string;
  issue_revision_id: string;
  issue_id: string;
  issue_version: number;
  repository_id: string;
  canonical_remote: string;
  version: number;
  state: string;
  brief?: string;
}

export interface ResourceBoard {
  status: string;
  next_action: string | null;
  completion: import("./completion.js").CompletionView;
  open_dev_run_count: number;
  candidate_count: number;
  selection: { state: string; version: number; candidate_id?: string };
}

export interface EvalListFilter { parent_id?: string; fields?: { path: string; value: string }[] }

export interface Resource {
  created_at?: string;
  last_activity?: { occurred_at: string; kind: string; issue_version: number } | null;
  is_selected?: boolean;
  resource_type: string;
  resource_id: string;
  label: string;
  version?: number;
  state?: string;
  requirement?: { id: string; version: number };
  repository?: { id: string; canonical_remote: string };
  issue?: { id: string; version: number };
  candidate_id?: string;
  overall_verdict?: string;
  /** verification list only: normal or ultra, plus the quality part's verdict and reviewer for ultra. */
  mode?: VerificationMode;
  quality_verdict?: Verdict;
  quality_attribution?: Attribution;
  board?: ResourceBoard;
  progress?: { completion_status: "completed" | "incomplete" | "no_issues"; completed_issue_count: number; bound_to_selected_version_issue_count: number; issue_count: number; ready_issue_count: number; open_dev_run_count: number; candidate_count: number };
}

export interface Tx {
  /** Append the first proved archive binding, or return its immutable artifact
   * when a freshly checked retry names the same format/generator/binding. */
  putCandidateGitArtifact(candidateId: string, artifact: import("./git-artifact-storage.js").GitCommitArtifact): Promise<import("./git-artifact-storage.js").GitCommitArtifact>;
  getDevelopmentContinuation(devRunId: string): Promise<{ operation_id: string; event_seq: number; policy: "parallel" | "paused"; expected_head: string } | undefined>;
  getRuntimeRecord(kind: string, id: string): Promise<import("./runtime-record.js").RuntimeRecord | undefined>;
  lockRuntimeRecord(kind: string, id: string): Promise<void>;
  listRuntimeRecords(kind: string, parentId?: string): Promise<import("./runtime-record.js").RuntimeRecord[]>;
  saveRuntimeRecord(record: import("./runtime-record.js").RuntimeRecord, expectedVersion: number): Promise<void>;
  historyCandidateIds(repositoryId: string, path: string, limit: number): Promise<string[]>;
  getDeliveryLink(id: string, version?: number): Promise<import("./delivery-link.js").DeliveryLink>;
  findDeliveryLink(candidateId: string, commit: string): Promise<import("./delivery-link.js").DeliveryLink | undefined>;
  listDeliveryLinks(repositoryId: string, limit: number): Promise<import("./delivery-link.js").DeliveryLink[]>;
  saveDeliveryLink(record: import("./delivery-link.js").DeliveryLink, expectedVersion: number): Promise<void>;
  putEvalBlob(bytes: Buffer): Promise<string>;
  getEvalBlob(digest: string): Promise<Buffer>;
  getEvalRecord<K extends EvalKind>(kind: K, id: string, version?: number): Promise<EvalRecord<K>>;
  listEvalRecords<K extends EvalKind>(kind: K, parentId?: string, fields?: EvalListFilter["fields"]): Promise<EvalRecord<K>[]>;
  listEvalRecordsPage<K extends EvalKind>(kind: K, filter: EvalListFilter, afterId: string, limit: number): Promise<{ rows: EvalRecord<K>[]; more: boolean }>;
  evalRunCounts(experimentIds: string[]): Promise<Record<string, { open: number; closed: number }>>;
  ledgerHighWater(): Promise<number>;
  saveEvalRecord<K extends EvalKind>(record: EvalRecord<K>, expectedVersion: number): Promise<void>;
  getRequirementRevisionByNumber(requirementId: string, version: number): Promise<RequirementRevision>;
  getIssueRevisionByNumber(issueId: string, version: number): Promise<IssueRevision>;
  lockIssueSelection(issueRevisionId: string): Promise<void>;
  getCompletion(issueRevisionId: string): Promise<import('./completion.js').CompletionRecord | undefined>;
  completionHistory(issueRevisionId: string): Promise<import('./completion.js').CompletionRecord[]>;
  appendCompletion(issueRevisionId: string, record: import('./completion.js').CompletionRecord, expectedVersion: number): Promise<void>;
  getSelection(issueRevisionId: string): Promise<SelectionRecord | undefined>;
  saveSelection(record: SelectionRecord, expectedVersion: number): Promise<void>;
  now(): Promise<string>;
  getOperation(operationId: string, lock?: boolean): Promise<OperationReplay | undefined>;
  reserveOperation(operation: Operation): Promise<OperationReplay | undefined>;
  completeOperation(operationId: string, resultJson: string): Promise<void>;
  lockRequirement(requirementId: string): Promise<void>;
  createRequirement(requirement: RequirementRecord, revision: RevisionRecord): Promise<void>;
  getCurrentRequirementRevision(requirementId: string): Promise<RequirementRevision>;
  appendRequirementRevision(revision: RevisionRecord): Promise<void>;
  getRequirementRevision(requirementId: string, revisionId: string): Promise<RequirementRevision>;
  createRepository(repository: RepositoryRecord): Promise<void>;
  ensureRepository(repository: RepositoryRecord): Promise<{ repository: RepositoryRecord; created: boolean }>;
  findRepositoryByRemote(remote: string): Promise<RepositoryRecord>;
  /** Every active (canonical + alias) remote with its Repository id, in one
   * read, so callers can compare by `repositoryMatchKey` inside a single
   * transaction without a per-remote query. */
  listActiveRepositoryRemoteBindings(): Promise<RepositoryRemoteBinding[]>;
  getRepository(repositoryId: string): Promise<RepositoryRecord>;
  moveRepository(repositoryId: string, remote: string, expectedVersion: number): Promise<RepositoryRecord>;
  addRepositoryAlias(repositoryId: string, remote: string, expectedVersion: number): Promise<RepositoryRecord>;
  retireRepositoryAlias(repositoryId: string, remote: string, expectedVersion: number): Promise<RepositoryRecord>;
  listRepositoryRemotes(repositoryId: string): Promise<RepositoryRemoteRecord[]>;
  createIssue(issue: IssueRecord, revision: IssueRevisionRecord): Promise<void>;
  /** Current Issues of one Requirement in one Repository (read-only), used to
   * hold the one-Issue-per-Requirement-and-Repository invariant inside the
   * publish transaction. */
  listIssuesPage(requirementId: string, after: string | ListPageKey, limit: number, filter?: IssueListFilter): Promise<{ rows: IssueListItem[]; more: boolean }>;
  getIssue(issueId: string): Promise<IssueRecord>;
  getCurrentIssueRevision(issueId: string): Promise<IssueRevision>;
  getIssueRevision(issueId: string, revisionId: string): Promise<IssueRevision>;
  getIssueRevisionById(revisionId: string): Promise<IssueRevision>;
  appendIssueRevision(revision: IssueRevisionRecord): Promise<void>;
  createDevRun(record: DevRunRecord): Promise<void>;
  createDevRunRefinementVerifications(devRunId: string, verificationIds: string[]): Promise<void>;
  lockCandidateVerifications(candidateId: string): Promise<void>;
  getDevRun(devRunId: string): Promise<DevRun>;
  /** Transactional write-side fence shared by sync and workspace ownership changes. */
  lockDevRun(devRunId: string): Promise<void>;
  assertDevRunNotSyncing(devRunId: string): Promise<void>;
  reserveDevRunSync(record: import("./runtime-record.js").RuntimeRecord, expectedRunVersion: number): Promise<DevRun>;
  finishDevRunSync(syncId: string, expectedSyncVersion: number, receiptDigest: string, decisions: { path: string; explanation: string }[], outcome: "completed" | "abandoned", attribution?: Attribution): Promise<DevRun>;
  abandonDevRun(devRunId: string, expectedVersion: number, reason?: string): Promise<DevRun>;
  putArtifact(artifact: ArtifactBlob): Promise<void>;
  createCandidate(record: CandidateRecord): Promise<void>;
  submitDevRun(devRunId: string, expectedVersion: number): Promise<DevRun>;
  createVerification(record: VerificationRecord): Promise<void>;
  getCandidate(candidateId: string): Promise<CandidateRecord>;
  getCandidateByDevRun(devRunId: string): Promise<CandidateRecord | undefined>;
  /** Candidate identity and artifact references without loading or validating the patch, so damaged artifacts stay diagnosable. */
  findCandidateArtifactRef(by: { candidate_id: string } | { dev_run_id: string }): Promise<CandidateArtifactRef | undefined>;
  candidateStanding(candidateId: string): Promise<string>;
  listCriterionStandings(candidateId: string, verificationIds: string[]): Promise<Record<string, string>>;
  listVerificationSummariesPage(candidateId: string, after: string, limit: number): Promise<{ rows: VerificationSummaryItem[]; more: boolean }>;
  readVerificationDirectoryPage(candidateId: string, after: string, limit: number): Promise<{ rows: VerificationSummaryItem[]; more: boolean }>;
  getVerification(verificationId: string): Promise<VerificationRecord>;
  getLedgerEvent(eventId: string): Promise<LedgerEvent>;
  appendLedgerEvent(event: LedgerEvent): Promise<void>;
}

export interface ReadTx extends Tx {
  getOperation(operationId: string, lock?: boolean): Promise<OperationReplay | undefined>;
  listRequirements(): Promise<RequirementListItem[]>;
  listRequirementsPage(afterId: string, limit: number): Promise<{ rows: RequirementListItem[]; more: boolean }>;
  listRepositories(): Promise<RepositoryRecord[]>;
  listRepositoriesPage(afterId: string, limit: number): Promise<{ rows: RepositoryRecord[]; more: boolean }>;
  attachIssueActivity(items: IssueListItem[]): Promise<void>;
  listIssues(requirementId: string, filter?: IssueListFilter): Promise<IssueListItem[]>;
  requirementAggregateFacts(requirementId: string, selectedRevisionId: string): Promise<RequirementAggregateFacts>;
  listDevRuns(issueId: string, filter?: DevRunListFilter): Promise<DevRunListItem[]>;
  listDevRunsPage(issueId: string, filter: DevRunListFilter, afterId: string, limit: number): Promise<{ rows: DevRunListItem[]; more: boolean }>;
  openDevRunCount(issueRevisionId: string): Promise<number>;
  candidateCount(issueRevisionId: string): Promise<number>;
  readArtifact(patchDigest: string): Promise<Buffer>;
  listDevRunRefinementVerifications(devRunId: string): Promise<string[]>;
  listCandidateLineage(issueRevisionId: string): Promise<Array<{ id: string; refines_candidate_id?: string }>>;
  listCandidates(issueRevisionId: string, filter?: CandidateListFilter): Promise<CandidateListItem[]>;
  listCandidatesPage(issueRevisionId: string, filter: CandidateListFilter, after: ListPageKey | undefined, limit: number): Promise<{ rows: CandidateListItem[]; more: boolean }>;
  verificationCount(candidateId: string): Promise<number>;
  getVerificationSummary(verificationId: string): Promise<VerificationSummaryItem>;
  listVerificationSummaries(candidateId: string): Promise<VerificationSummaryItem[]>;
  listVerifications(candidateId: string, filter?: VerificationListFilter): Promise<VerificationSummaryItem[]>;
  listVerificationsPage(candidateId: string, filter: VerificationListFilter, after: ListPageKey | undefined, limit: number): Promise<{ rows: (VerificationSummaryItem & { order_key: string })[]; more: boolean }>;
  criterionStanding(candidateId: string, targetType: string, targetId: string, criterionId: string): Promise<string>;
  listLedgerEventsPage(afterSeq: number, repositoryId: string, subjectType: string, subjectId: string, limit: number): Promise<{ rows: LedgerEvent[]; more: boolean }>;
}

export interface Store {
  setGitArtifactResolver?(resolver: import("./git-artifact-storage.js").GitArtifactResolver): void;
  initialize(policy: "warn" | "require_override"): Promise<{ metadata: Metadata; action: "initialized" | "attached" }>;
  open(): Promise<Metadata>;
  inspect(): Promise<Metadata>;
  inspectIntegrity(): Promise<{ metadata: Metadata; report: IntegrityReport }>;
  migrate(): Promise<Metadata>;
  write<T>(callback: (tx: Tx) => Promise<T>): Promise<T>;
  read<T>(callback: (tx: ReadTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
