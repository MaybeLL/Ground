import type { AgentExecution, Definition, DefinitionKind, ExperimentRun, GradingRecord, Id, JsonValue, Revision, Sandbox, TaskRun, Timestamp, Versioned, Work } from "../domain/index.js";

// ---- errors ---------------------------------------------------------------

/** Storage refused an operation for a reason the caller can act on. */
export type StorageFailureReason =
  | "stale"      // the aggregate changed since it was read: reload and decide again
  | "duplicate"  // a uniqueness rule (identity, request, one live sandbox per instance, ...) already holds for someone else
  | "missing"    // the aggregate does not exist
  | "invalid"    // the state to store breaks the aggregate's own invariants
  | "integrity"  // what is stored is damaged or was altered outside the system
  | "read-only"; // a write was attempted in a read unit
export class StorageFailure extends Error {
  constructor(readonly reason: StorageFailureReason, message: string, readonly subject?: string) {
    super(message);
    this.name = "StorageFailure";
  }
}
/** The same request identity arrived with different input. */
export class RequestConflict extends Error {
  constructor(readonly requestId: string) {
    super(`request ${requestId} was already used with different input`);
    this.name = "RequestConflict";
  }
}

// ---- repositories ---------------------------------------------------------

export interface ReadOptions { /** Take a row lock so the following write cannot lose to a concurrent one. */ readonly lock?: boolean }

/** Optimistic, versioned storage of one aggregate. A save succeeds only for the version the caller read. */
export interface AggregateRepository<S extends Versioned & { readonly id: Id }> {
  get(id: Id, options?: ReadOptions): Promise<S | undefined>;
  /** Insert a new aggregate; its version must be 1. */
  create(state: S): Promise<void>;
  /** Replace the stored state, which must still be at `expectedVersion`. */
  save(state: S, expectedVersion: number): Promise<void>;
}

export interface DefinitionRepository extends AggregateRepository<Definition> {
  /** Every definition of a kind, in identity order. */
  list(kind: DefinitionKind): Promise<Definition[]>;
  /** Revisions are immutable: they are added, never changed. */
  addRevision(revision: Revision): Promise<void>;
  getRevision(definitionId: Id, revisionId: Id): Promise<Revision | undefined>;
  getRevisionBySeq(definitionId: Id, seq: number): Promise<Revision | undefined>;
  latestRevision(definitionId: Id): Promise<Revision | undefined>;
}
export interface WorkRepository extends AggregateRepository<Work> {
  listByTask(taskDefinitionId: Id): Promise<Work[]>;
}
export interface TaskRunRepository extends AggregateRepository<TaskRun> {
  listByWork(workId: Id): Promise<TaskRun[]>;
  listRefinements(runId: Id): Promise<TaskRun[]>;
  findByWorkerExecution(executionId: Id): Promise<TaskRun | undefined>;
}
export interface SandboxRepository extends AggregateRepository<Sandbox> {
  listByOwner(owner: { type: "task_run" | "grading_record"; id: Id }): Promise<Sandbox[]>;
  /** The one live sandbox holding this runtime resource, if any. */
  findLiveByInstance(instanceId: Id): Promise<Sandbox | undefined>;
}
export interface ExecutionRepository extends AggregateRepository<AgentExecution> {
  listByOwner(owner: { type: "task_run" | "grading_record"; id: Id }): Promise<AgentExecution[]>;
}
export interface GradingRepository extends AggregateRepository<GradingRecord> {
  listForTaskRun(taskRunId: Id): Promise<GradingRecord[]>;
  listForMember(experimentRunId: Id, caseKey: string, repeatIndex: number): Promise<GradingRecord[]>;
  findByEvaluatorExecution(executionId: Id): Promise<GradingRecord | undefined>;
}
export interface ExperimentRepository extends AggregateRepository<ExperimentRun> {
  /** The batch member whose task run was requested under this identity. */
  findMemberByRequest(taskRunRequestId: Id): Promise<{ experimentRunId: Id; key: string } | undefined>;
}

/** A step the system decided to take, recorded before it is taken so that a crash leaves something to reconcile. */
export type IntentState = "registered" | "completed" | "failed";
export interface IntentRecord extends Versioned {
  readonly id: Id;
  /** The caller-chosen identity of the request; the same identity with different input is a conflict. */
  readonly requestId: string;
  readonly requestHash: string;
  readonly parentIntentId?: Id;
  readonly kind: string;
  readonly subject: { readonly type: string; readonly id: Id };
  readonly state: IntentState;
  readonly payload: JsonValue;
  readonly result?: JsonValue;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}
export interface IntentRepository extends AggregateRepository<IntentRecord> {
  /** Register the intent, or return the one already registered under the same request identity and input. */
  register(intent: IntentRecord): Promise<{ intent: IntentRecord; created: boolean }>;
  findByRequest(requestId: string): Promise<IntentRecord | undefined>;
  listByState(state: IntentState, limit: number): Promise<IntentRecord[]>;
  listChildren(parentIntentId: Id): Promise<IntentRecord[]>;
}

/** Written in the same transaction that finishes a child, so a parent is never left waiting on a lost notification. */
export interface CompletionEvent {
  readonly id: Id;
  readonly parentIntentId: Id;
  readonly type: string;
  readonly subject: { readonly type: string; readonly id: Id };
  readonly payload: JsonValue;
  readonly createdAt: Timestamp;
  readonly deliveredAt?: Timestamp;
}
export interface CompletionEventRepository {
  /** Appending the same event identity again changes nothing. */
  append(event: CompletionEvent): Promise<{ created: boolean }>;
  /** Oldest first. */
  listUndelivered(limit: number): Promise<CompletionEvent[]>;
  /** Idempotent: delivering twice keeps the first delivery time. */
  markDelivered(id: Id, at: Timestamp): Promise<void>;
}

/** A counter that only grows, used for the order in which gradings were requested. */
export interface SequenceRepository { next(name: string): Promise<number> }

export interface WorkRepositories {
  readonly definitions: DefinitionRepository;
  readonly works: WorkRepository;
  readonly taskRuns: TaskRunRepository;
  readonly sandboxes: SandboxRepository;
  readonly executions: ExecutionRepository;
  readonly gradings: GradingRepository;
  readonly experiments: ExperimentRepository;
  readonly intents: IntentRepository;
  readonly events: CompletionEventRepository;
  readonly sequences: SequenceRepository;
}

/** Everything inside `run` commits together or not at all. A read unit rejects writes. */
export interface WorkUnitOfWork {
  run<T>(mode: "read" | "write", work: (repositories: WorkRepositories) => Promise<T>): Promise<T>;
}
