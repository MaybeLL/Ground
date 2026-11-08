import {
  definitionViolations, executionViolations, experimentViolations, gradingViolations, revisionViolations, sandboxViolations, taskRunViolations, workViolations,
  type AgentExecution, type Definition, type DefinitionKind, type ExperimentRun, type GradingRecord, type Id, type JsonValue, type Member, type Revision, type Sandbox, type TaskRun, type Work,
} from "../../domain/index.js";
import {
  RequestConflict, StorageFailure,
  type CompletionEvent, type CompletionEventRepository, type DefinitionRepository, type ExecutionRepository, type ExperimentRepository, type GradingRepository, type IntentRecord,
  type IntentRepository, type IntentState, type ReadOptions, type SandboxRepository, type SequenceRepository, type TaskRunRepository, type WorkRepositories, type WorkRepository,
  type WorkUnitOfWork,
} from "../../ports/index.js";
import type { SQLClient } from "../../../sql-client.js";
import type { SQLStore } from "../../../sql-store.js";
import { isDuplicateKeyError, isolateStatement } from "../../../sql-shared.js";
import { AggregateTable, asStorageFailure, canonicalBody, digestText, textOf, type TableSpec } from "./aggregate-table.js";

const owner = (o: { type: string; id: Id }) => ["owner_type = ? AND owner_id = ?", [o.type, o.id]] as const;
const orNull = <T>(value: T | undefined): T | null => value ?? null;

// ---- table specifications -------------------------------------------------

const definitionSpec: TableSpec<Definition> = { table: "work_definitions", kind: "definition", columns: d => ({ kind: d.kind, head_seq: d.head.seq }), violations: definitionViolations };
const workSpec: TableSpec<Work> = { table: "work_works", kind: "work", columns: w => ({ task_definition_id: w.taskDefinitionId, status: w.status, head_run_id: orNull(w.head) }), violations: workViolations };
const taskRunSpec: TableSpec<TaskRun> = {
  table: "work_task_runs", kind: "task run", violations: taskRunViolations,
  columns: r => ({ work_id: orNull(r.workId), refines_id: orNull(r.refines), task_definition_id: r.taskRevision.definitionId, status: r.status, worker_execution_id: r.worker?.kind === "managed" ? r.worker.executionId : null }),
};
const sandboxSpec: TableSpec<Sandbox> = {
  table: "work_sandboxes", kind: "sandbox", violations: sandboxViolations,
  // The instance column holds the runtime resource only while the sandbox lives, so a resource can belong to one live sandbox at a time.
  columns: s => ({ owner_type: s.owner.type, owner_id: s.owner.id, phase: s.phase, live_instance_id: s.phase === "released" || !s.runtime ? null : s.runtime.instanceId }),
};
const executionSpec: TableSpec<AgentExecution> = { table: "work_executions", kind: "agent execution", violations: executionViolations, columns: e => ({ owner_type: e.owner.type, owner_id: e.owner.id, role: e.role, stage: e.stage }) };
const gradingSpec: TableSpec<GradingRecord> = {
  table: "work_gradings", kind: "grading record", violations: gradingViolations,
  columns: g => ({
    purpose: g.purpose, origin_type: g.origin.type, task_run_id: g.origin.type === "gate" ? g.origin.taskRunId : null,
    experiment_run_id: g.origin.type === "member" ? g.origin.experimentRunId : null, case_key: g.origin.type === "member" ? g.origin.caseKey : null,
    repeat_index: g.origin.type === "member" ? g.origin.repeatIndex : null, request_seq: g.requestSeq, evaluator_execution_id: g.evaluator?.kind === "agent" ? g.evaluator.executionId : null, status: g.status,
  }),
};
const intentSpec: TableSpec<IntentRecord> = {
  table: "work_intents", kind: "intent", violations: () => [],
  columns: i => ({ request_id: i.requestId, request_hash: i.requestHash, parent_intent_id: orNull(i.parentIntentId), kind: i.kind, subject_type: i.subject.type, subject_id: i.subject.id, state: i.state }),
};
const experimentSpec = (): TableSpec<ExperimentRun> => ({
  table: "work_experiment_runs", kind: "experiment run", violations: () => [], columns: e => ({ experiment_id: e.experimentId }),
  // Members live in their own table; the body keeps only a count and a digest so that damage to either side is noticed.
  body: e => ({ ...e, members: [], memberCount: e.members.length, membersDigest: digestText(canonicalBody(e.members)) } as unknown as JsonValue),
  restore: body => { const { memberCount: _count, membersDigest: _digest, ...rest } = body; return rest as unknown as ExperimentRun; },
});

// ---- repositories ---------------------------------------------------------

class SqlRepository<S extends { readonly id: Id; readonly version: number }> {
  constructor(protected readonly table: AggregateTable<S>) {}
  get(id: Id, options?: ReadOptions) { return this.table.get(id, options); }
  create(state: S) { return this.table.insert(state); }
  save(state: S, expectedVersion: number) { return this.table.update(state, expectedVersion); }
}

class SqlDefinitions extends SqlRepository<Definition> implements DefinitionRepository {
  constructor(table: AggregateTable<Definition>, private readonly client: SQLClient, private readonly writable: boolean) { super(table); }

  list(kind: DefinitionKind) { return this.table.select("kind = ?", [kind], "id"); }

  async addRevision(revision: Revision): Promise<void> {
    if (!this.writable) throw new StorageFailure("read-only", "revisions cannot be added in a read unit");
    const problems = revisionViolations(revision);
    if (problems.length > 0) throw new StorageFailure("invalid", `revision ${revision.id} breaks its invariants: ${problems.join("; ")}`, revision.id);
    const body = canonicalBody(revision);
    try {
      await this.client.run("INSERT INTO work_revisions (id, definition_id, kind, seq, content_digest, record_digest, body_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [revision.id, revision.definitionId, revision.kind, revision.seq, revision.digest, digestText(body), body]);
    } catch (error) { throw asStorageFailure(error, `revision ${revision.id}`); }
  }

  private decode(row: Record<string, unknown>): Revision {
    const subject = textOf(row.id);
    const body = textOf(row.body_json);
    let revision: Revision;
    try { revision = JSON.parse(body) as Revision; } catch { throw new StorageFailure("integrity", `stored revision ${subject} is damaged: its body is not valid JSON`, subject); }
    if (!revision || typeof revision !== "object" || revision.kind !== textOf(row.kind) || canonicalBody(revision) !== body || digestText(body) !== textOf(row.record_digest) || revision.id !== subject || revision.definitionId !== textOf(row.definition_id)
      || revision.seq !== Number(row.seq) || revision.digest !== textOf(row.content_digest) || revisionViolations(revision).length > 0)
      throw new StorageFailure("integrity", `stored revision ${subject} is damaged`, subject);
    return revision;
  }
  private async one(sql: string, params: unknown[]): Promise<Revision | undefined> {
    const row = await this.client.get<Record<string, unknown>>(sql, params);
    return row ? this.decode(row) : undefined;
  }
  getRevision(definitionId: Id, revisionId: Id) { return this.one("SELECT * FROM work_revisions WHERE definition_id = ? AND id = ?", [definitionId, revisionId]); }
  getRevisionBySeq(definitionId: Id, seq: number) { return this.one("SELECT * FROM work_revisions WHERE definition_id = ? AND seq = ?", [definitionId, seq]); }
  latestRevision(definitionId: Id) { return this.one("SELECT * FROM work_revisions WHERE definition_id = ? ORDER BY seq DESC LIMIT 1", [definitionId]); }
}

class SqlWorks extends SqlRepository<Work> implements WorkRepository {
  listByTask(taskDefinitionId: Id) { return this.table.select("task_definition_id = ?", [taskDefinitionId], "id"); }
}
class SqlTaskRuns extends SqlRepository<TaskRun> implements TaskRunRepository {
  listByWork(workId: Id) { return this.table.select("work_id = ?", [workId], "id"); }
  listRefinements(runId: Id) { return this.table.select("refines_id = ?", [runId], "id"); }
  async findByWorkerExecution(executionId: Id) { return (await this.table.select("worker_execution_id = ?", [executionId]))[0]; }
}
class SqlSandboxes extends SqlRepository<Sandbox> implements SandboxRepository {
  listByOwner(o: { type: "task_run" | "grading_record"; id: Id }) { const [where, params] = owner(o); return this.table.select(where, [...params]); }
  async findLiveByInstance(instanceId: Id) { return (await this.table.select("live_instance_id = ?", [instanceId]))[0]; }
}
class SqlExecutions extends SqlRepository<AgentExecution> implements ExecutionRepository {
  listByOwner(o: { type: "task_run" | "grading_record"; id: Id }) { const [where, params] = owner(o); return this.table.select(where, [...params]); }
}
class SqlGradings extends SqlRepository<GradingRecord> implements GradingRepository {
  listForTaskRun(taskRunId: Id) { return this.table.select("task_run_id = ?", [taskRunId], "request_seq"); }
  listForMember(experimentRunId: Id, caseKey: string, repeatIndex: number) { return this.table.select("experiment_run_id = ? AND case_key = ? AND repeat_index = ?", [experimentRunId, caseKey, repeatIndex], "request_seq"); }
  async findByEvaluatorExecution(executionId: Id) { return (await this.table.select("evaluator_execution_id = ?", [executionId]))[0]; }
}

class SqlExperiments implements ExperimentRepository {
  constructor(private readonly table: AggregateTable<ExperimentRun>, private readonly client: SQLClient, private readonly writable: boolean) {}

  private async members(experimentRunId: Id): Promise<Member[]> {
    const rows = await this.client.all<Record<string, unknown>>("SELECT * FROM work_experiment_members WHERE experiment_run_id = ? ORDER BY ordinal", [experimentRunId]);
    return rows.map(row => ({ key: textOf(row.member_key), caseKey: textOf(row.case_key), repeatIndex: Number(row.repeat_index), taskRunRequestId: textOf(row.task_run_request_id) }));
  }

  async get(id: Id, options?: ReadOptions): Promise<ExperimentRun | undefined> {
    const stored = await this.table.get(id, options);
    if (!stored) return undefined;
    const members = await this.members(id);
    const body = JSON.parse((await this.client.get<Record<string, unknown>>("SELECT body_json FROM work_experiment_runs WHERE id = ?", [id]))!.body_json as string) as { memberCount: number; membersDigest: string };
    if (members.length !== body.memberCount || digestText(canonicalBody(members)) !== body.membersDigest) throw new StorageFailure("integrity", `the members of experiment run ${id} were altered`, id);
    const run = { ...stored, members } as ExperimentRun;
    const problems = experimentViolations(run);
    if (problems.length > 0) throw new StorageFailure("integrity", `stored experiment run ${id} is damaged: ${problems.join("; ")}`, id);
    return run;
  }

  async create(state: ExperimentRun): Promise<void> {
    const problems = experimentViolations(state);
    if (problems.length > 0) throw new StorageFailure("invalid", `experiment run ${state.id} breaks its invariants: ${problems.join("; ")}`, state.id);
    await this.table.insert(state);
    for (const [ordinal, member] of state.members.entries()) {
      try {
        await this.client.run("INSERT INTO work_experiment_members (experiment_run_id, member_key, ordinal, case_key, repeat_index, task_run_request_id) VALUES (?, ?, ?, ?, ?, ?)",
          [state.id, member.key, ordinal, member.caseKey, member.repeatIndex, member.taskRunRequestId]);
      } catch (error) { throw asStorageFailure(error, `member ${member.key} of experiment run ${state.id}`); }
    }
  }

  async save(state: ExperimentRun, expectedVersion: number): Promise<void> {
    const problems = experimentViolations(state);
    if (problems.length > 0) throw new StorageFailure("invalid", `experiment run ${state.id} breaks its invariants: ${problems.join("; ")}`, state.id);
    const stored = await this.members(state.id);
    if (digestText(canonicalBody(stored)) !== digestText(canonicalBody(state.members))) throw new StorageFailure("invalid", `the members of experiment run ${state.id} are fixed at launch`, state.id);
    await this.table.update(state, expectedVersion);
  }

  async findMemberByRequest(taskRunRequestId: Id) {
    const row = await this.client.get<Record<string, unknown>>("SELECT experiment_run_id, member_key FROM work_experiment_members WHERE task_run_request_id = ?", [taskRunRequestId]);
    return row ? { experimentRunId: textOf(row.experiment_run_id), key: textOf(row.member_key) } : undefined;
  }
}

class SqlIntents extends SqlRepository<IntentRecord> implements IntentRepository {
  constructor(table: AggregateTable<IntentRecord>, private readonly client: SQLClient) { super(table); }

  async findByRequest(requestId: string) { return (await this.table.select("request_id = ?", [requestId]))[0]; }
  listByState(state: IntentState, limit: number) { return this.table.select("state = ?", [state], "id", limit); }
  listChildren(parentIntentId: Id) { return this.table.select("parent_intent_id = ?", [parentIntentId], "id"); }

  async register(intent: IntentRecord): Promise<{ intent: IntentRecord; created: boolean }> {
    try {
      await isolateStatement(this.client, () => this.table.insert(intent));
      return { intent, created: true };
    } catch (error) {
      if (!(error instanceof StorageFailure) || error.reason !== "duplicate") throw error;
      const existing = await this.findByRequest(intent.requestId);
      if (!existing) throw error; // the identity clashed, not the request
      if (existing.requestHash !== intent.requestHash) throw new RequestConflict(intent.requestId);
      return { intent: existing, created: false };
    }
  }
}

export function decodeCompletionEvent(row: Record<string, unknown>): CompletionEvent {
  const subject = textOf(row.id);
  const body = textOf(row.body_json);
  let event: CompletionEvent;
  try { event = JSON.parse(body) as CompletionEvent; } catch { throw new StorageFailure("integrity", `stored completion event ${subject} is damaged: its body is not valid JSON`, subject); }
  if (!event || typeof event !== "object" || event.parentIntentId !== textOf(row.parent_intent_id) || event.type !== textOf(row.event_type) || event.createdAt !== textOf(row.created_at)
    || canonicalBody(event) !== body || digestText(body) !== textOf(row.record_digest) || event.id !== subject) throw new StorageFailure("integrity", `stored completion event ${subject} is damaged`, subject);
  return row.delivered_at === null || row.delivered_at === undefined ? event : { ...event, deliveredAt: textOf(row.delivered_at) };
}

class SqlEvents implements CompletionEventRepository {
  constructor(private readonly client: SQLClient, private readonly writable: boolean) {}

  async append(event: CompletionEvent): Promise<{ created: boolean }> {
    if (!this.writable) throw new StorageFailure("read-only", "completion events cannot be appended in a read unit");
    const { deliveredAt: _unused, ...fact } = event;
    const body = canonicalBody(fact);
    try {
      await isolateStatement(this.client, () => this.client.run("INSERT INTO work_completion_events (id, parent_intent_id, event_type, created_at, delivered_at, record_digest, body_json) VALUES (?, ?, ?, ?, NULL, ?, ?)",
        [event.id, event.parentIntentId, event.type, event.createdAt, digestText(body), body]));
      return { created: true };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await this.client.get<Record<string, unknown>>("SELECT record_digest FROM work_completion_events WHERE id = ?", [event.id]);
      if (existing && textOf(existing.record_digest) !== digestText(body)) throw new StorageFailure("duplicate", `completion event ${event.id} already exists with different content`, event.id);
      return { created: false };
    }
  }

  async listUndelivered(limit: number): Promise<CompletionEvent[]> {
    const rows = await this.client.all<Record<string, unknown>>(`SELECT * FROM work_completion_events WHERE delivered_at IS NULL ORDER BY seq LIMIT ${Math.max(0, Math.floor(limit))}`);
    return rows.map(decodeCompletionEvent);
  }

  async markDelivered(id: Id, at: string): Promise<void> {
    if (!this.writable) throw new StorageFailure("read-only", "completion events cannot be delivered in a read unit");
    const { changes } = await this.client.run("UPDATE work_completion_events SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", [at, id]);
    if (changes === 1) return;
    if (!(await this.client.get("SELECT id FROM work_completion_events WHERE id = ?", [id]))) throw new StorageFailure("missing", `completion event ${id} does not exist`, id);
  }
}

class SqlSequences implements SequenceRepository {
  constructor(private readonly client: SQLClient, private readonly writable: boolean) {}
  async next(name: string): Promise<number> {
    if (!this.writable) throw new StorageFailure("read-only", "sequences cannot advance in a read unit");
    const bump = () => this.client.run("UPDATE work_counters SET value = value + 1 WHERE name = ?", [name]);
    if ((await bump()).changes === 0) {
      try { await isolateStatement(this.client, () => this.client.run("INSERT INTO work_counters (name, value) VALUES (?, 0)", [name])); }
      catch (error) { if (!isDuplicateKeyError(error)) throw error; }
      await bump();
    }
    // The update above holds the row until the transaction ends, so this reads our own number.
    const row = await this.client.get<{ value: unknown }>("SELECT value FROM work_counters WHERE name = ?", [name]);
    return Number(row!.value);
  }
}

export function repositoriesOver(client: SQLClient, writable: boolean): WorkRepositories {
  return {
    definitions: new SqlDefinitions(new AggregateTable(client, definitionSpec, writable), client, writable),
    works: new SqlWorks(new AggregateTable(client, workSpec, writable)),
    taskRuns: new SqlTaskRuns(new AggregateTable(client, taskRunSpec, writable)),
    sandboxes: new SqlSandboxes(new AggregateTable(client, sandboxSpec, writable)),
    executions: new SqlExecutions(new AggregateTable(client, executionSpec, writable)),
    gradings: new SqlGradings(new AggregateTable(client, gradingSpec, writable)),
    experiments: new SqlExperiments(new AggregateTable(client, experimentSpec(), writable), client, writable),
    intents: new SqlIntents(new AggregateTable(client, intentSpec, writable), client),
    events: new SqlEvents(client, writable),
    sequences: new SqlSequences(client, writable),
  };
}

/** The work model's unit of work over the ledger's SQL store: one transaction, retried by the store on transient failures. */
export class SqlWorkUnitOfWork implements WorkUnitOfWork {
  constructor(private readonly store: SQLStore) {}
  run<T>(mode: "read" | "write", work: (repositories: WorkRepositories) => Promise<T>): Promise<T> {
    return this.store.transaction(mode === "write", client => work(repositoriesOver(client, mode === "write")));
  }
}
