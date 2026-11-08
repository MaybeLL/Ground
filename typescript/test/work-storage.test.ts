import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptExecution, completeRelease, createDefinition, createGrading, createTaskRun, deriveRequestId, importTranscript, launchExperimentRun, markReady, publishRevision,
  registerAgentEvaluator, registerExternalWorker, registerManagedWorker, requestCancel, requestExperimentCancel, requestSandbox, reserve, start, startWork, submitGrade, type AgentExecution, type Decision, type Definition, type GradingRecord, type Id, type Result,
  type RevisionRef, type Sandbox, type TaskRun, type Work,
} from "../src/work/domain/index.js";
import { RequestConflict, StorageFailure, type IntentRecord, type WorkRepositories } from "../src/work/ports/index.js";
import { SqlWorkUnitOfWork } from "../src/work/adapters/index.js";
import { workTables } from "../src/work/adapters/sql/schema.js";
import { SCHEMA_VERSION, SQLStore } from "../src/sql-store.js";
import { backends, backendSkip, openLedger } from "./backends.js";
import { clock, hash } from "./work-fixtures.js";

const at = clock();
const d = (c: string) => `sha256:${c.repeat(64)}`;
const ok = <S, E, O>(result: Result<Decision<S, E, O>>): S => { assert.ok(result.ok, result.ok ? "" : result.error.message); return result.value.state; };
const taskRevision: RevisionRef = { kind: "task", definitionId: "task-1", revisionId: "task-rev-1", seq: 1, digest: d("1") };
const graderRevision: RevisionRef = { kind: "grader", definitionId: "grader-1", revisionId: "grader-rev-1", seq: 1, digest: d("2") };
const agentRevision: RevisionRef = { kind: "agent", definitionId: "agent-1", revisionId: "agent-rev-1", seq: 1, digest: d("3") };
const suiteRevision: RevisionRef = { kind: "suite", definitionId: "suite-1", revisionId: "suite-rev-1", seq: 1, digest: d("4") };

const aRun = (id: string, over: Partial<Parameters<typeof createTaskRun>[0]> = {}): TaskRun => ok(createTaskRun({ id, taskRevision, workerMode: "external", retention: "keep", at: at(), ...over }));
const requested = (id: string): Sandbox => ok(requestSandbox({ id, owner: { type: "task_run", id: "run-owner" }, retention: "keep", at: at() }));
const ready = (sandbox: Sandbox, instanceId: string): Sandbox => ok(markReady(sandbox, { workspace: { ref: `ws-${sandbox.id}`, origin: "own" }, runtime: { instanceId, environmentRevisionId: "env-rev-1" }, at: at() }));
const anExecution = (id: string, ownerId = "run-1"): AgentExecution => ok(acceptExecution({ id, owner: { type: "task_run", id: ownerId }, role: "worker", agentRevision, capabilities: { resume: false, verifiableStop: true, events: "full" }, at: at() }));
const aMeasure = (id: string, requestSeq: number, over: { evaluatorExecution?: string; member?: { run: string; caseKey: string; repeat: number } } = {}): GradingRecord =>
  ok(createGrading({ id, purpose: "measure", origin: over.member ? { type: "member", experimentRunId: over.member.run, caseKey: over.member.caseKey, repeatIndex: over.member.repeat, requirementKey: "accuracy" } : { type: "standalone" }, requestSeq,
    targets: [{ type: "artifact", id: "art-1", digest: d("5") }], graderRevision, grader: { strategy: "rule", scale: { form: "numeric", min: 0, max: 5 } }, materials: [], at: at() }));
const aGate = (id: string, requestSeq: number, taskRunId = "run-1"): GradingRecord =>
  ok(createGrading({ id, purpose: "gate", origin: { type: "gate", taskRunId }, requestSeq, targets: [{ type: "candidate", id: "cand-1", digest: d("6") }], graderRevision,
    grader: { strategy: "agent", scale: { form: "criteria" } }, materials: [], binding: { taskRevision, criteriaDigest: d("7"), manifestDigest: d("8"), graderRevision, materialsDigest: d("9"), expectedCriteria: ["c1"] }, at: at() }));
const anIntent = (id: string, requestId: string, over: Partial<IntentRecord> = {}): IntentRecord => ({ id, requestId, requestHash: d("a"), kind: "start-run", subject: { type: "task_run", id: "run-1" }, state: "registered", payload: { n: 1 }, createdAt: at(), updatedAt: at(), version: 1, ...over });

async function failure(promise: Promise<unknown>): Promise<StorageFailure> {
  try { await promise; } catch (error) { assert.ok(error instanceof StorageFailure, `expected a StorageFailure, got ${String(error)}`); return error; }
  assert.fail("expected the operation to be refused");
}

for (const backend of backends) {
  test(`${backend}: retrying interrupted initialization produces one complete ledger`, { skip: backendSkip(backend) }, async () => {
    const fixture = await openLedger(backend, false);
    const store = fixture.store as unknown as { acquireClient(): Promise<import("../src/sql-client.js").SQLClient> };
    const acquire = store.acquireClient.bind(store);
    let interrupted = false;
    store.acquireClient = async () => {
      const client = await acquire();
      return new Proxy(client, { get(target, key) {
        if (key === "exec") return async (sql: string) => {
          if (!interrupted && sql.includes("CREATE TABLE IF NOT EXISTS work_works")) {
            interrupted = true;
            throw new Error("injected initialization failure");
          }
          return target.exec(sql);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    try {
      await assert.rejects(fixture.store.initialize("warn"));
      assert.equal(interrupted, true);
      const target = await fixture.store.classifyTarget();
      if (backend === "mysql") {
        assert.equal(target.state, "initialized");
        if (target.state === "initialized") assert.equal(target.metadata.migration_state, "in_progress");
        await assert.rejects(fixture.store.open(), { code: "MIGRATION_DIRTY" });
      } else assert.equal(target.state, "empty");
      const { metadata } = await fixture.store.initialize("warn");
      if (target.state === "initialized") assert.equal(metadata.database_id, target.metadata.database_id);
      assert.equal((await fixture.store.inspectIntegrity()).report.valid, true);
    } finally { await fixture.close(); }
  });
  if (backend !== "sqlite") test(`${backend}: initialization refuses an unrelated object in a table-free target`, { skip: backendSkip(backend) }, async () => {
    const fixture = await openLedger(backend, false);
    const store = fixture.store as unknown as { acquireClient(): Promise<import("../src/sql-client.js").SQLClient> };
    const client = await store.acquireClient();
    try {
      await client.exec(backend === "postgres" ? "CREATE SEQUENCE accounting_ids" : "CREATE PROCEDURE accounting_ping() SELECT 1");
      assert.equal((await fixture.store.classifyTarget()).state, "unrecognized");
      await assert.rejects(fixture.store.initialize("warn"), { code: "SCHEMA_INCOMPATIBLE" });
    } finally { await client.close(); await fixture.close(); }
  });
  const check = (name: string, run: (store: SQLStore, uow: SqlWorkUnitOfWork) => Promise<void>) => test(`${backend}: work storage ${name}`, { skip: backendSkip(backend) }, async () => {
    const fixture = await openLedger(backend);
    try { await run(fixture.store, new SqlWorkUnitOfWork(fixture.store)); } finally { await fixture.close(); }
  });
  const write = <T>(uow: SqlWorkUnitOfWork, work: (r: WorkRepositories) => Promise<T>) => uow.run("write", work);
  const read = <T>(uow: SqlWorkUnitOfWork, work: (r: WorkRepositories) => Promise<T>) => uow.run("read", work);

  check("initializes only work-model tables and rejects an old ledger without modifying it", async store => {
    const metadata = await store.open();
    assert.equal(metadata.schema_version, SCHEMA_VERSION);
    assert.equal(metadata.protocol_version, 2);
    await store.transaction(false, async client => {
      for (const table of workTables) {
        const row = await client.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${table}`);
        assert.equal(Number(row!.n), 0, table);
      }
      const count = await client.get<{ total: unknown }>(backend === "sqlite" ? "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'" : `SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = ${backend === "mysql" ? "DATABASE()" : "current_schema()"}`);
      assert.equal(Number(count!.total), workTables.length + 1);
    });
    await store.transaction(true, client => client.run("UPDATE schema_metadata SET protocol_version = 1"));
    await assert.rejects(store.open(), { code: "SCHEMA_INCOMPATIBLE" });
    await assert.rejects(store.initialize("warn"), { code: "SCHEMA_INCOMPATIBLE" });
    assert.equal((await store.inspect()).protocol_version, 1);
  });

  check("status detects an indexed field changed outside the work repository", async (store, uow) => {
    await write(uow, r => r.taskRuns.create(aRun("integrity-run")));
    assert.equal((await store.inspectIntegrity()).report.valid, true);
    await store.transaction(true, client => client.run("UPDATE work_task_runs SET status = 'delivered' WHERE id = ?", ["integrity-run"]));
    const { report } = await store.inspectIntegrity();
    assert.equal(report.valid, false);
    assert.match(report.issues[0].reason, /status column differs/);
  });

  check("status diagnoses orphan members, damaged events and invalid sequence state", async (store, uow) => {
    await write(uow, async r => {
      await r.gradings.create(aGate("gate-1", await r.sequences.next("grading-request")));
      await r.events.append({ id: "event-1", parentIntentId: "intent-1", type: "finished", subject: { type: "work", id: "work-1" }, payload: {}, createdAt: at() });
    });
    assert.equal((await store.inspectIntegrity()).report.valid, true);
    await store.transaction(true, async client => {
      await client.run("DELETE FROM work_counters WHERE name = ?", ["grading-request"]);
      await client.run("INSERT INTO work_counters (name, value) VALUES (?, ?)", ["negative", -1]);
      await client.run("UPDATE work_completion_events SET parent_intent_id = ?", ["incorrect"]);
      await client.run("INSERT INTO work_experiment_members (experiment_run_id, member_key, ordinal, case_key, repeat_index, task_run_request_id) VALUES (?, ?, 0, ?, 0, ?)", ["missing", "m", "case", "missing-request"]);
    });
    const { report } = await store.inspectIntegrity();
    assert.equal(report.valid, false);
    assert.deepEqual(report.issues.map(issue => issue.check).sort(), ["experiment_members", "grading_sequence", "work_counters", "work_record"]);
  });

  check("status reports malformed persisted event JSON and SQLite counter values", async (store, uow) => {
    await write(uow, r => r.events.append({ id: "bad-event", parentIntentId: "intent", type: "done", subject: { type: "work", id: "work" }, payload: {}, createdAt: at() }));
    await store.transaction(true, async client => {
      await client.run("UPDATE work_completion_events SET body_json = 'null'");
      if (backend === "sqlite") await client.run("INSERT INTO work_counters (name, value) VALUES ('grading-request', 'broken')");
    });
    const { report } = await store.inspectIntegrity();
    assert.equal(report.valid, false);
    assert.ok(report.issues.some(issue => issue.check === "work_record"));
    if (backend === "sqlite") assert.ok(report.issues.some(issue => issue.check === "work_counters"));
  });

  if (backend === "sqlite") check("status catches a revision left orphaned outside FK enforcement", async (store, uow) => {
    const definition = ok(createDefinition({ id: "def", kind: "task", name: "Task", at: at() }));
    const content = { kind: "coding", schemaVersion: 1, summary: "Task", criteria: [{ id: "c", statement: "works" }] };
    const published = publishRevision(definition, { revisionId: "rev", expectedSeq: 0, content, at: at() }, hash);
    assert.ok(published.ok);
    await write(uow, async r => { await r.definitions.create(definition); await r.definitions.save(published.value.state, definition.version); await r.definitions.addRevision(published.value.outcome); });
    const client = await (store as unknown as { acquireClient(): Promise<import("../src/sql-client.js").SQLClient> }).acquireClient();
    await client.exec("PRAGMA foreign_keys = OFF");
    try { await client.run("DELETE FROM work_definitions WHERE id = 'def'"); }
    finally { await client.exec("PRAGMA foreign_keys = ON"); }
    const { report } = await store.inspectIntegrity();
    assert.equal(report.valid, false);
    assert.ok(report.issues.some(issue => issue.check === "revision_definition"));
  });

  check("definitions keep their head and immutable, numbered revisions", async (_store, uow) => {
    let definition: Definition = ok(createDefinition({ id: "def-1", kind: "task", name: "Export", at: at() }));
    await write(uow, r => r.definitions.create(definition));
    const content = { kind: "coding", schemaVersion: 1, summary: "Add export", criteria: [{ id: "c1", statement: "exports CSV" }] };
    const first = publishRevision(definition, { revisionId: "rev-1", expectedSeq: 0, content, at: at() }, hash);
    assert.ok(first.ok);
    await write(uow, async r => { await r.definitions.save(first.value.state, definition.version); await r.definitions.addRevision(first.value.outcome); });
    definition = first.value.state;
    const second = publishRevision(definition, { revisionId: "rev-2", expectedSeq: 1, content: { ...content, summary: "Add export v2" }, at: at() }, hash);
    assert.ok(second.ok);
    await write(uow, async r => { await r.definitions.save(second.value.state, definition.version); await r.definitions.addRevision(second.value.outcome); });
    const stored = await read(uow, async r => ({ def: await r.definitions.get("def-1"), latest: await r.definitions.latestRevision("def-1"), bySeq: await r.definitions.getRevisionBySeq("def-1", 1), byId: await r.definitions.getRevision("def-1", "rev-2"), none: await r.definitions.getRevision("def-1", "nope") }));
    assert.deepEqual(stored.def, second.value.state);
    assert.deepEqual(stored.latest, second.value.outcome);
    assert.deepEqual(stored.bySeq, first.value.outcome);
    assert.deepEqual(stored.byId, second.value.outcome);
    assert.equal(stored.none, undefined);
    assert.equal((await failure(write(uow, r => r.definitions.addRevision({ ...second.value.outcome, id: "rev-dup" })))).reason, "duplicate", "a revision number is used once");
    const other: Definition = ok(createDefinition({ id: "def-0", kind: "agent", name: "Agent", at: at() }));
    await write(uow, r => r.definitions.create(other));
    assert.deepEqual((await read(uow, r => r.definitions.list("task"))).map(x => x.id), ["def-1"], "only definitions of the asked kind");
    assert.deepEqual((await read(uow, r => r.definitions.list("agent"))).map(x => x.id), ["def-0"]);
    assert.equal((await failure(write(uow, r => r.definitions.addRevision({ ...second.value.outcome, definitionId: "unknown-definition", id: "rev-orphan", seq: 9 })))).reason, "missing", "a revision cannot exist without its definition");
  });

  check("an aggregate round-trips, saves only from the version it read, and refuses duplicates", async (_store, uow) => {
    const run = aRun("run-1");
    await write(uow, r => r.taskRuns.create(run));
    assert.deepEqual(await read(uow, r => r.taskRuns.get("run-1")), run);
    assert.equal((await failure(write(uow, r => r.taskRuns.create(run)))).reason, "duplicate");
    const started = ok(start(run, { at: at() }));
    await write(uow, r => r.taskRuns.save(started, run.version));
    assert.deepEqual(await read(uow, r => r.taskRuns.get("run-1")), started);
    // A second writer still holding the first version loses.
    const cancelled = ok(requestCancel(run, { at: at() }));
    assert.equal((await failure(write(uow, r => r.taskRuns.save(cancelled, run.version)))).reason, "stale");
    assert.equal((await failure(write(uow, r => r.taskRuns.save({ ...started, id: "run-ghost", version: 3 }, 2)))).reason, "missing");
    assert.equal((await failure(write(uow, r => r.taskRuns.save({ ...started, version: 5 }, started.version)))).reason, "invalid", "a save advances exactly one version");
    assert.equal((await failure(write(uow, r => r.taskRuns.create({ ...run, id: "run-v2", version: 2 })))).reason, "invalid");
    assert.equal(await read(uow, r => r.taskRuns.get("nothing")), undefined);
  });

  check("a state that breaks its own invariants is neither stored nor trusted", async (_store, uow) => {
    const broken = { ...aRun("run-bad"), status: "delivered" as const }; // delivered without a manifest
    const refusal = await failure(write(uow, r => r.taskRuns.create(broken)));
    assert.equal(refusal.reason, "invalid");
    assert.match(refusal.message, /manifest/);
    assert.equal(await read(uow, r => r.taskRuns.get("run-bad")), undefined);
  });

  check("damage to a stored aggregate is detected when it is read", async (store, uow) => {
    await write(uow, async r => { await r.taskRuns.create(aRun("run-1")); await r.works.create(ok(startWork({ id: "work-1", taskDefinitionId: "task-1", firstRunId: "run-1", at: at() }))); });
    // Edit the body without updating the digest.
    await store.transaction(true, client => client.run("UPDATE work_task_runs SET body_json = REPLACE(body_json, 'pending', 'running') WHERE id = 'run-1'"));
    const damaged = await failure(read(uow, r => r.taskRuns.get("run-1")));
    assert.equal(damaged.reason, "integrity");
    assert.match(damaged.message, /digest/);
    // A column that disagrees with the body.
    await store.transaction(true, client => client.run("UPDATE work_works SET version = 7 WHERE id = 'work-1'"));
    assert.equal((await failure(read(uow, r => r.works.get("work-1")))).reason, "integrity");
  });

  check("task runs are found by work, by refinement and by their managed worker, and a worker belongs to one run", async (_store, uow) => {
    const first = aRun("run-1", { workId: "work-1", workerMode: "managed" });
    const refinement = ok(createTaskRun({ id: "run-2", taskRevision, workId: "work-1", refines: "run-1", workerMode: "managed", retention: "keep", at: at() }, { refines: { id: "run-1", status: "delivered", taskDefinitionId: "task-1", workId: "work-1" } }));
    await write(uow, r => r.taskRuns.create(first));
    await write(uow, r => r.taskRuns.create(refinement));
    await write(uow, r => r.taskRuns.create(aRun("run-3", { workId: "work-2" })));
    const started = ok(start(first, { at: at() }));
    const workers = ok(registerManagedWorker(started, { executionId: "exec-1", at: at() }));
    await write(uow, async r => { await r.taskRuns.save(started, first.version); await r.taskRuns.save(workers, started.version); });
    const found = await read(uow, async r => ({ byWork: await r.taskRuns.listByWork("work-1"), refinements: await r.taskRuns.listRefinements("run-1"), byWorker: await r.taskRuns.findByWorkerExecution("exec-1"), none: await r.taskRuns.findByWorkerExecution("exec-x") }));
    assert.deepEqual(found.byWork.map(x => x.id), ["run-1", "run-2"]);
    assert.deepEqual(found.refinements.map(x => x.id), ["run-2"]);
    assert.equal(found.byWorker?.id, "run-1");
    assert.equal(found.none, undefined);
    const otherStarted = ok(start(refinement, { at: at() }));
    const other = ok(registerManagedWorker(otherStarted, { executionId: "exec-1", at: at() }));
    await write(uow, r => r.taskRuns.save(otherStarted, refinement.version));
    assert.equal((await failure(write(uow, r => r.taskRuns.save(other, otherStarted.version)))).reason, "duplicate", "one execution cannot be the worker of two runs");
  });

  check("a runtime resource belongs to one live sandbox at a time", async (_store, uow) => {
    const a = requested("sbx-a"), b = requested("sbx-b");
    await write(uow, async r => { await r.sandboxes.create(a); await r.sandboxes.create(b); });
    const aReady = ready(a, "inst-1");
    await write(uow, r => r.sandboxes.save(aReady, a.version));
    assert.equal((await failure(write(uow, r => r.sandboxes.save(ready(b, "inst-1"), b.version)))).reason, "duplicate", "a second sandbox cannot take the same resource");
    assert.equal((await read(uow, r => r.sandboxes.findLiveByInstance("inst-1")))?.id, "sbx-a");
    assert.equal((await read(uow, r => r.sandboxes.get("sbx-b")))?.phase, "preparing", "the refused save changed nothing");
    // Once the first is released, the resource can be bound again.
    const releasing = ok(reserve(aReady, { by: { type: "task_run", id: "run-owner" }, operationId: "rel-1", kind: "release", at: at() }));
    const released = ok(completeRelease(releasing, { operationId: "rel-1", workspace: "retained", at: at() }));
    await write(uow, async r => { await r.sandboxes.save(releasing, aReady.version); await r.sandboxes.save(released, releasing.version); });
    assert.equal(await read(uow, r => r.sandboxes.findLiveByInstance("inst-1")), undefined);
    await write(uow, r => r.sandboxes.save(ready(b, "inst-1"), b.version));
    assert.equal((await read(uow, r => r.sandboxes.findLiveByInstance("inst-1")))?.id, "sbx-b");
    assert.deepEqual((await read(uow, r => r.sandboxes.listByOwner({ type: "task_run", id: "run-owner" }))).map(x => x.id), ["sbx-a", "sbx-b"]);
  });

  check("gradings are ordered by a ledger counter and found by run, by member and by evaluator", async (_store, uow) => {
    const first = await write(uow, async r => { const seq = await r.sequences.next("grading-request"); const g = aGate("gate-1", seq); await r.gradings.create(g); return { seq, g }; });
    const second = await write(uow, async r => { const seq = await r.sequences.next("grading-request"); const g = aGate("gate-2", seq); await r.gradings.create(g); return { seq, g }; });
    assert.ok(second.seq > first.seq, "later requests have larger numbers");
    await write(uow, async r => { await r.gradings.create(aMeasure("m-1", await r.sequences.next("grading-request"), { member: { run: "xr-1", caseKey: "case-a", repeat: 0 } })); await r.gradings.create(aMeasure("m-2", await r.sequences.next("grading-request"), { member: { run: "xr-1", caseKey: "case-a", repeat: 1 } })); });
    const found = await read(uow, async r => ({ gates: await r.gradings.listForTaskRun("run-1"), member: await r.gradings.listForMember("xr-1", "case-a", 1), none: await r.gradings.listForTaskRun("run-x") }));
    assert.deepEqual(found.gates.map(g => g.id), ["gate-1", "gate-2"], "oldest request first");
    assert.deepEqual(found.member.map(g => g.id), ["m-2"]);
    assert.deepEqual(found.none, []);
    assert.equal((await failure(write(uow, r => r.gradings.create(aMeasure("m-dup-seq", first.seq))))).reason, "duplicate", "a request number is used once");
    const gate3 = aGate("gate-3", 900), gate4 = aGate("gate-4", 901);
    await write(uow, async r => { await r.gradings.create(gate3); await r.gradings.create(gate4); });
    await write(uow, r => r.gradings.save(ok(registerAgentEvaluator(gate3, { executionId: "exec-9", at: at() })), gate3.version));
    assert.equal((await read(uow, r => r.gradings.findByEvaluatorExecution("exec-9")))?.id, "gate-3");
    assert.equal((await failure(write(uow, r => r.gradings.save(ok(registerAgentEvaluator(gate4, { executionId: "exec-9", at: at() })), gate4.version)))).reason, "duplicate", "one execution evaluates one grading");
    const measure3 = aMeasure("m-3", 902);
    await write(uow, r => r.gradings.create(measure3));
    await write(uow, r => r.gradings.save(ok(submitGrade(measure3, { grade: { form: "numeric", value: 3 }, at: at() })), measure3.version));
    assert.deepEqual((await read(uow, r => r.gradings.get("m-3")))?.grade, { form: "numeric", value: 3 });
  });

  check("an experiment run keeps its members apart from its body and never lets them change", async (_store, uow) => {
    const run = ok(launchExperimentRun({ id: "xr-1", experimentId: "exp-1", suite: suiteRevision, agent: agentRevision, caseKeys: ["case-a", "case-b"], repeatCount: 3, taskConcurrency: 2, at: at() }, hash));
    await write(uow, r => r.experiments.create(run));
    const loaded = await read(uow, r => r.experiments.get("xr-1"));
    assert.deepEqual(loaded, run);
    assert.deepEqual(loaded?.members.map(m => m.key), run.members.map(m => m.key), "members keep their launch order");
    assert.equal((await read(uow, r => r.experiments.findMemberByRequest(run.members[4].taskRunRequestId)))?.key, "case-b#1");
    assert.equal(await read(uow, r => r.experiments.findMemberByRequest("tr-nothing")), undefined);
    const cancelled = ok(requestExperimentCancel(run, { at: at() }));
    await write(uow, r => r.experiments.save(cancelled, run.version));
    assert.deepEqual(await read(uow, r => r.experiments.get("xr-1")), cancelled);
    assert.equal((await failure(write(uow, r => r.experiments.save({ ...cancelled, version: 3, members: cancelled.members.slice(1) }, cancelled.version)))).reason, "invalid");
    const other = ok(launchExperimentRun({ id: "xr-2", experimentId: "exp-1", suite: suiteRevision, agent: agentRevision, caseKeys: ["case-a"], repeatCount: 1, taskConcurrency: 1, at: at() }, hash));
    const stolen = { ...other, members: [{ ...other.members[0], taskRunRequestId: run.members[0].taskRunRequestId }] };
    assert.equal((await failure(write(uow, r => r.experiments.create(stolen)))).reason, "duplicate", "a task run belongs to one member");
    assert.equal(await read(uow, r => r.experiments.get("xr-2")), undefined, "a refused launch leaves nothing behind");
    assert.ok(deriveRequestId("xr-1", "case-a", 0, hash).ok);
  });

  check("intents are registered once per request identity, and the same identity with other input conflicts", async (_store, uow) => {
    const first = await write(uow, r => r.intents.register(anIntent("int-1", "req-1")));
    assert.equal(first.created, true);
    const again = await write(uow, r => r.intents.register(anIntent("int-other", "req-1")));
    assert.equal(again.created, false);
    assert.equal(again.intent.id, "int-1", "the replay returns the intent registered first");
    await assert.rejects(write(uow, r => r.intents.register(anIntent("int-3", "req-1", { requestHash: d("b") }))), RequestConflict);
    assert.equal((await failure(write(uow, r => r.intents.register(anIntent("int-1", "req-2"))))).reason, "duplicate", "a clashing identity is not a replay");
    const done = { ...first.intent, state: "completed" as const, result: { ok: true }, version: 2, updatedAt: at() };
    await write(uow, r => r.intents.save(done, 1));
    await write(uow, r => r.intents.register(anIntent("int-4", "req-4", { parentIntentId: "int-1" })));
    const listed = await read(uow, async r => ({ pending: await r.intents.listByState("registered", 10), completed: await r.intents.listByState("completed", 10), children: await r.intents.listChildren("int-1"), byRequest: await r.intents.findByRequest("req-1"), limited: await r.intents.listByState("registered", 0) }));
    assert.deepEqual(listed.pending.map(i => i.id), ["int-4"]);
    assert.deepEqual(listed.completed.map(i => i.id), ["int-1"]);
    assert.deepEqual(listed.children.map(i => i.id), ["int-4"]);
    assert.equal(listed.byRequest?.state, "completed");
    assert.deepEqual(listed.limited, []);
  });

  check("completion events are appended once, delivered oldest first, and delivered once", async (_store, uow) => {
    const event = (id: string) => ({ id, parentIntentId: "int-1", type: "execution-finished", subject: { type: "agent_execution", id: "exec-1" }, payload: { id }, createdAt: "2026-01-01T00:00:00.000Z" });
    assert.equal((await write(uow, r => r.events.append(event("ev-1")))).created, true);
    assert.equal((await write(uow, r => r.events.append(event("ev-1")))).created, false, "appending the same event again changes nothing");
    await write(uow, async r => { await r.events.append(event("ev-2")); await r.events.append(event("ev-3")); });
    assert.equal((await failure(write(uow, r => r.events.append({ ...event("ev-1"), payload: { id: "changed" } })))).reason, "duplicate");
    assert.deepEqual((await read(uow, r => r.events.listUndelivered(10))).map(e => e.id), ["ev-1", "ev-2", "ev-3"]);
    assert.deepEqual((await read(uow, r => r.events.listUndelivered(2))).map(e => e.id), ["ev-1", "ev-2"]);
    await write(uow, r => r.events.markDelivered("ev-1", "2026-01-01T00:00:00.000Z"));
    await write(uow, r => r.events.markDelivered("ev-1", "2026-02-02T00:00:00.000Z"));
    assert.deepEqual((await read(uow, r => r.events.listUndelivered(10))).map(e => e.id), ["ev-2", "ev-3"]);
    assert.equal((await failure(write(uow, r => r.events.markDelivered("ev-none", at())))).reason, "missing");
  });

  check("everything in a unit commits together or not at all", async (_store, uow) => {
    await assert.rejects(write(uow, async r => {
      await r.taskRuns.create(aRun("run-rolled-back"));
      await r.events.append({ id: "ev-rolled-back", parentIntentId: "int-1", type: "t", subject: { type: "x", id: "y" }, payload: null, createdAt: at() });
      await r.sequences.next("grading-request");
      throw new Error("boom");
    }), /boom/);
    assert.equal(await read(uow, r => r.taskRuns.get("run-rolled-back")), undefined);
    assert.deepEqual(await read(uow, r => r.events.listUndelivered(10)), []);
    // A refused save in the middle undoes the writes before it, as the work-and-run acceptance needs.
    await write(uow, r => r.taskRuns.create(aRun("run-1")));
    const work: Work = ok(startWork({ id: "work-1", taskDefinitionId: "task-1", firstRunId: "run-2", at: at() }));
    await failure(write(uow, async r => { await r.works.create(work); await r.taskRuns.create(aRun("run-1")); }));
    assert.equal(await read(uow, r => r.works.get("work-1")), undefined);
  });

  check("a read unit refuses every write", async (_store, uow) => {
    for (const attempt of [
      (r: WorkRepositories) => r.taskRuns.create(aRun("run-ro")),
      (r: WorkRepositories) => r.definitions.addRevision({ id: "r", definitionId: "d", kind: "task", seq: 1, digest: d("a"), content: {}, publishedAt: at() }),
      (r: WorkRepositories) => r.events.append({ id: "e", parentIntentId: "i", type: "t", subject: { type: "x", id: "y" }, payload: null, createdAt: at() }),
      (r: WorkRepositories) => r.sequences.next("grading-request"),
      (r: WorkRepositories) => r.events.markDelivered("e", at()),
    ]) assert.equal((await failure(read(uow, attempt))).reason, "read-only");
    assert.equal(await read(uow, r => r.taskRuns.get("run-ro")), undefined);
  });

  check("concurrent writers never lose an update: each save either lands or is told it is stale", async (_store, uow) => {
    const created = aRun("run-1");
    const started = ok(start(created, { at: at() }));
    const registered = ok(registerExternalWorker(started, { sessionId: "sess-1", agent: { id: "agent" }, at: at() }));
    await write(uow, async r => { await r.taskRuns.create(created); await r.taskRuns.save(started, 1); await r.taskRuns.save(registered, 2); });
    const importing = (n: number) => write(uow, async r => {
      const run = (await r.taskRuns.get("run-1"))!;
      const next = ok(importTranscript(run, { sessionId: "sess-1", ref: `blob:${n}`, digest: d(String(n)), coverage: "partial", at: at() }));
      await r.taskRuns.save(next, run.version);
    }).then(() => "saved", error => (error instanceof StorageFailure ? error.reason : Promise.reject(error)));
    const outcomes = await Promise.all([1, 2, 3, 4].map(importing));
    const final = await read(uow, r => r.taskRuns.get("run-1"));
    const transcripts = final?.worker?.kind === "external" ? final.worker.registration.transcripts.length : -1;
    assert.equal(transcripts, outcomes.filter(o => o === "saved").length, `outcomes ${outcomes.join(",")}`);
    assert.ok(outcomes.every(o => o === "saved" || o === "stale"), outcomes.join(","));
    assert.ok(transcripts >= 1);
  });

  check("an id in the model may be any bounded string", async (_store, uow) => {
    const id = "x".repeat(128);
    await write(uow, r => r.taskRuns.create(aRun(id)));
    assert.equal((await read(uow, r => r.taskRuns.get(id)))?.id, id);
    await write(uow, r => r.taskRuns.create(aRun("Run-Case", {})));
    assert.equal((await read(uow, r => r.taskRuns.get("run-case"))), undefined, "identifiers compare exactly, case included");
  });
}

for (const backend of backends) test(`${backend}: raw transcript imports freeze chunks and bind only the registered session`,{skip:backendSkip(backend)},async()=>{
  const fixture=await openLedger(backend);
  try {
    const {composeWork}=await import("../src/work/composition.js");
    const {createHash}=await import("node:crypto");
    const app=composeWork(fixture.store);
    const task=await app.tasks.createTask({requestId:"task",summary:"Read evidence",criteria:[{statement:"auditable"}]});
    assert.ok(task.ok);
    const start=await app.exec.startRun({requestId:"run",taskDefinitionId:task.value.taskId,workerMode:"external"});
    assert.ok(start.ok);
    const runId=start.value.runId;
    const registration=await app.exec.registerExternalWorker({requestId:"worker",runId,agent:{id:"writer"}});
    assert.ok(registration.ok);
    const bytes=Buffer.from("trace\n".repeat(15000));
    const digest="sha256:"+createHash("sha256").update(bytes).digest("hex");
    const input={requestId:"raw",runId,sessionId:registration.value.sessionId,digest,coverage:"full" as const};
    let captures=0,disposals=0;
    const capture=async()=>{
      captures++;
      return {source:{digest,byteLength:bytes.length,async *open(){yield bytes;}},async dispose(){disposals++;}};
    };
    assert.equal((await app.traces.importRaw({...input,sessionId:"wrong"},capture)).ok,false);
    const first=await app.traces.importRaw(input,capture);
    assert.ok(first.ok);
    assert.deepEqual(await app.traces.importRaw(input,capture),first);
    assert.deepEqual([captures,disposals],[1,1]);
    const last=await app.traces.read(runId,digest,"raw",1);
    assert.ok(last.ok);
    assert.deepEqual(Buffer.from(last.value.data),bytes.subarray(65536));
    assert.equal((await fixture.store.inspectIntegrity()).report.valid,true);
  } finally {await fixture.close();}
});

for (const backend of backends) test(`${backend}: upgrade a populated work ledger and atomically store verifiable binary evidence`, {skip:backendSkip(backend)}, async () => {
  const fixture = await openLedger(backend);
  const {store} = fixture;
  const units = new SqlWorkUnitOfWork(store);
  try {
    const identity = (await store.open()).database_id;
    await units.run("write",r=>r.taskRuns.create(aRun("retain-me")));
    await store.transaction(true,async c=>{
      // DDL is committed independently on MySQL; this fixture owns its whole database.
      await c.exec("DROP TABLE work_evidence_chunks"); await c.exec("DROP TABLE work_evidence");
      await c.run("UPDATE schema_metadata SET schema_version = 1");
    });
    await assert.rejects(store.upgrade("wrong-id"),{code:"DATABASE_ID_MISMATCH"});
    assert.equal((await store.inspect()).schema_version,1);
    await assert.rejects(store.open(),{code:"SCHEMA_INCOMPATIBLE"});
    const rawStore = store as unknown as { acquireClient(): Promise<import("../src/sql-client.js").SQLClient> };
    const client = await rawStore.acquireClient();
    try {
      await client.exec("CREATE TABLE work_evidence_chunks (dummy INTEGER)");
      await assert.rejects(store.upgrade(identity),{code:"SCHEMA_INCOMPATIBLE"});
      assert.equal((await store.inspect()).migration_state,"clean");
      await client.exec("DROP TABLE work_evidence_chunks");
      if (backend === "mysql") {
        await client.run("UPDATE schema_metadata SET migration_state='in_progress'");
        const {evidenceSchemaStatements} = await import("../src/work/adapters/sql/schema.js");
        for (const ddl of evidenceSchemaStatements(client.dialect)) await client.exec(ddl + client.dialect.tableSuffix);
        await client.exec("ALTER TABLE work_evidence_chunks ADD UNIQUE KEY stray_ordinal (ordinal)");
        await assert.rejects(store.upgrade(identity),{code:"SCHEMA_INCOMPATIBLE"});
        await client.exec("ALTER TABLE work_evidence_chunks DROP KEY stray_ordinal");
        await client.exec("CREATE TRIGGER reject_evidence BEFORE INSERT ON work_evidence_chunks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture'");
        await assert.rejects(store.upgrade(identity),{code:"SCHEMA_INCOMPATIBLE"});
        // The restricted recovery account can inspect and update ledger data
        // but its TRIGGERS view hides the administrator's existing trigger.
        if (process.env.GROUNDS_TEST_MYSQL_DISPOSABLE_SERVER === "1") {
          const {randomBytes} = await import("node:crypto");
          const username = "trace_test_" + randomBytes(5).toString("hex"), password = randomBytes(16).toString("hex");
          const database = String((await client.get("SELECT DATABASE() AS db"))!.db);
          await client.exec(`CREATE USER '${username}'@'%' IDENTIFIED BY '${password}'`);
          try {
            await client.exec(`GRANT SELECT, UPDATE, CREATE ON \`${database}\`.* TO '${username}'@'%'`);
            const limited = SQLStore.mysql({host:process.env.GROUNDS_TEST_MYSQL_HOST!,port:Number(process.env.GROUNDS_TEST_MYSQL_PORT),database,username,password,caFile:process.env.GROUNDS_TEST_MYSQL_CA_FILE});
            try { await assert.rejects(limited.upgrade(identity),/cannot verify triggers/); } finally { await limited.close(); }
          } finally { await client.exec(`DROP USER '${username}'@'%'`); }
        }
        await client.exec("DROP TRIGGER reject_evidence");
      }
    } finally { if (backend !== "sqlite") await client.close(); }
    assert.equal((await store.upgrade(identity)).schema_version,SCHEMA_VERSION);
    assert.equal((await store.upgrade(identity)).database_id,identity);
    assert.equal((await units.run("read",r=>r.taskRuns.get("retain-me")))!.id,"retain-me");
    const bytes = Buffer.alloc(65536*2+137);
    for (let i=0;i<bytes.length;i++) bytes[i]=i%256;
    const {createHash} = await import("node:crypto");
    const digest = "sha256:"+createHash("sha256").update(bytes).digest("hex");
    const source = {digest,byteLength:bytes.length,open:async function*() { yield bytes.subarray(0,17); yield bytes.subarray(17); }};
    await assert.rejects(units.run("write",r=>r.evidence.put({...source,byteLength:bytes.length+1})),/changed during capture/);
    assert.equal(await units.run("read",r=>r.evidence.describe(digest)),undefined);
    const ref = await units.run("write",r=>r.evidence.put(source));
    assert.equal(ref.chunkCount,3);
    assert.deepEqual(await units.run("write",r=>r.evidence.put(source)),ref);
    assert.deepEqual(Buffer.from((await units.run("read",r=>r.evidence.chunk(digest,1)))!),bytes.subarray(65536,131072));
    assert.equal((await store.inspectIntegrity()).report.valid,true);
    await store.transaction(true,c=>c.run("UPDATE work_evidence_chunks SET bytes = ? WHERE digest = ? AND ordinal = 1",[Buffer.from("replaced"),digest]));
    assert.equal((await store.inspectIntegrity()).report.valid,false);
  } finally {await fixture.close();}
});
