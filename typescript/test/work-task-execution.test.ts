import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefinition, publishRevision, type DeliveryItem, type ReceiptCheck } from "../src/work/domain/index.js";
import { TaskExecution, type Outcome } from "../src/work/application/index.js";
import { SqlWorkUnitOfWork } from "../src/work/adapters/index.js";
import type { WorkRepositories } from "../src/work/ports/index.js";
import { backends, backendSkip, openLedger } from "./backends.js";
import { clock, hash, ids } from "./work-fixtures.js";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const items: DeliveryItem[] = [{ type: "candidate", id: "cand-1", receipt: "tag:grounds/cand-1" }];
const taskContent = { kind: "coding", schemaVersion: 1, summary: "Add export", criteria: [{ id: "c1", statement: "exports CSV" }] };

function value<T>(outcome: Outcome<T>): T {
  assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}
function refused<T>(outcome: Outcome<T>, code: string, pattern?: RegExp): void {
  assert.ok(!outcome.ok, "expected the use case to refuse");
  if (!outcome.ok) { assert.equal(outcome.error.code, code, outcome.error.message); if (pattern) assert.match(outcome.error.message, pattern); }
}

for (const backend of backends) {
  const scenario = (name: string, run: (t: Harness) => Promise<void>) => test(`${backend}: task execution ${name}`, { skip: backendSkip(backend) }, async () => {
    const fixture = await openLedger(backend);
    try { await run(await harness(new SqlWorkUnitOfWork(fixture.store))); } finally { await fixture.close(); }
  });

  scenario("one agent delivers, a refinement continues from it, and the work shows the head's state", async t => {
    const started = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "external" }));
    const registered = value(await t.exec.registerExternalWorker({ requestId: "rq-2", runId: started.runId, agent: { id: "claude-code" } }));
    assert.equal((value(await t.exec.getRun(started.runId))).run.status, "running");
    const submitted = value(await t.exec.submit({ requestId: "rq-3", runId: started.runId, sessionId: registered.sessionId, items, declaresStop: true }));
    assert.deepEqual([submitted.status, submitted.outcome, submitted.blocked], ["delivered", "applied", null]);
    const first = value(await t.exec.getWork(started.workId));
    assert.equal(first.work.head, started.runId);
    assert.equal(first.conclusion, "pending", "delivered, no gate yet");

    const next = value(await t.exec.continueWork({ requestId: "rq-4", workId: started.workId, expectedHead: started.runId, workerMode: "external" }));
    assert.equal(next.refines, started.runId);
    const view = value(await t.exec.getWork(started.workId));
    assert.equal(view.work.head, next.runId);
    assert.deepEqual(view.work.runIds, [started.runId, next.runId]);
    assert.equal(view.conclusion, "in-progress");
    assert.deepEqual(view.work.headHistory.map(h => h.reason), ["start", "continue"]);
  });

  scenario("a request is applied once: a replay returns the first answer, other input under the same identity is a conflict", async t => {
    const first = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "external" }));
    const replay = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "external" }));
    assert.deepEqual(replay, first);
    refused(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "none" }), "request-conflict");
    assert.equal((await t.listWorks()).length, 1, "the replay created nothing");
  });

  scenario("a refusal leaves nothing behind and does not use up the request identity", async t => {
    refused(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-unknown", workerMode: "external" }), "not-found");
    refused(await t.exec.startWork({ requestId: "rq-2", taskDefinitionId: "task-empty", workerMode: "external" }), "conflict", /no published revision/);
    assert.equal((await t.listWorks()).length, 0);
    // Publish what was missing; the same identity now succeeds.
    await t.publishTask("task-empty");
    value(await t.exec.startWork({ requestId: "rq-2", taskDefinitionId: "task-empty", workerMode: "external" }));
  });

  scenario("a submission must come from the session issued for the run", async t => {
    const run = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "external" }));
    const session = value(await t.exec.registerExternalWorker({ requestId: "rq-2", runId: run.runId, agent: { id: "a" } }));
    refused(await t.exec.submit({ requestId: "rq-3", runId: run.runId, sessionId: "someone-else", items }), "forbidden");
    refused(await t.exec.submit({ requestId: "rq-4", runId: run.runId, items }), "forbidden");
    assert.equal(value(await t.exec.getRun(run.runId)).run.status, "running");
    value(await t.exec.submit({ requestId: "rq-5", runId: run.runId, sessionId: session.sessionId, items }));
    assert.equal(value(await t.exec.getRun(run.runId)).run.status, "delivered");
  });

  scenario("when nobody works on a round, the caller's own manifest delivers it", async t => {
    const run = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "none" }));
    const done = value(await t.exec.submit({ requestId: "rq-2", runId: run.runId, items }));
    assert.equal(done.status, "delivered");
    assert.equal(value(await t.exec.getRun(run.runId)).run.manifest?.origin, "caller");
  });

  scenario("recovers the original submission after interruption during the first receipt read", async t => {
    const {runId} = value(await t.exec.startWork({requestId:"start", taskDefinitionId:"task-1", workerMode:"external"}));
    const {sessionId} = value(await t.exec.registerExternalWorker({requestId:"register",runId,agent:{id:"writer"}}));
    const input = {requestId:"submit", runId, sessionId, items};
    t.receipts.interrupt = true;
    await assert.rejects(t.exec.submit(input), /interrupted receipt read/);
    const {run} = value(await t.exec.getRun(runId));
    assert.equal(run.pendingManifest?.operationId,input.requestId);
    assert.equal(run.worker?.kind==="external" && run.worker.registration.stop?.reason,"submitted");
    assert.equal(run.blocked,undefined);
    assert.equal(value(await t.exec.reconcileSubmission(runId))?.status,"delivered");
    assert.equal(value(await t.exec.submit(input)).status,"delivered");
  });

  scenario("an archive that cannot be checked holds the round open; one that does not match fails it", async t => {
    const held = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "none" }));
    t.receipts.result = "unavailable";
    const waiting = value(await t.exec.submit({ requestId: "rq-2", runId: held.runId, items }));
    assert.equal(waiting.status, "running");
    assert.equal(waiting.blocked, "receipt-unavailable");
    refused(await t.exec.submit({requestId:"replace-pending",runId:held.runId,items}),"conflict");
    t.receipts.result="accepted";
    const [replayed,reconciled]=await Promise.all([t.exec.submit({requestId:"rq-2",runId:held.runId,items}),t.exec.reconcileSubmission(held.runId)]);
    assert.equal(value(replayed).status,"delivered");
    assert.ok(value(reconciled)===null || value(reconciled)?.status==="delivered");
    assert.equal(value(await t.exec.getRun(held.runId)).run.manifest?.operationId,"rq-2");
    const external=value(await t.exec.startWork({requestId:"external",taskDefinitionId:"task-1",workerMode:"external"}));
    const session=value(await t.exec.registerExternalWorker({requestId:"register-ext",runId:external.runId,agent:{id:"writer"}}));
    const delivery={requestId:"pending-external",runId:external.runId,sessionId:session.sessionId,items};
    t.receipts.result="unavailable";
    assert.equal(value(await t.exec.submit(delivery)).blocked,"receipt-unavailable");
    value(await t.exec.cancel({requestId:"cancel-ext",runId:external.runId}));
    t.receipts.result="accepted";
    assert.equal(value(await t.exec.submit(delivery)).status,"cancelled");
    assert.equal(value(await t.exec.getRun(external.runId)).run.manifest,undefined);
    const bad = value(await t.exec.startWork({ requestId: "rq-3", taskDefinitionId: "task-1", workerMode: "none" }));
    t.receipts.result = "rejected";
    const failed = value(await t.exec.submit({ requestId: "rq-4", runId: bad.runId, items }));
    assert.equal(failed.status, "failed");
    assert.equal(value(await t.exec.getRun(bad.runId)).run.failure?.class, "agent-output");
  });

  scenario("cancelling before the submission wins the race, and the late manifest is only recorded", async t => {
    const run = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "external" }));
    const session = value(await t.exec.registerExternalWorker({ requestId: "rq-2", runId: run.runId, agent: { id: "a" } }));
    const cancelled = value(await t.exec.cancel({ requestId: "rq-3", runId: run.runId, reason: "changed my mind" }));
    assert.equal(cancelled.status, "running", "the agent has not declared it stopped yet");
    const late = value(await t.exec.submit({ requestId: "rq-4", runId: run.runId, sessionId: session.sessionId, items, declaresStop: true }));
    assert.equal(late.status, "cancelled");
    assert.equal(late.outcome, "cancel-wins");
    const stored = value(await t.exec.getRun(run.runId)).run;
    assert.equal(stored.manifest, undefined);
    assert.equal(stored.lateRecords.length, 1);
    assert.equal(stored.cancelIntent?.reason, "changed my mind");
  });

  scenario("a cancelled round ends once the agent declares it stopped", async t => {
    const run = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "external" }));
    const session = value(await t.exec.registerExternalWorker({ requestId: "rq-2", runId: run.runId, agent: { id: "a" } }));
    value(await t.exec.cancel({ requestId: "rq-3", runId: run.runId }));
    refused(await t.exec.declareStop({ requestId: "rq-4", runId: run.runId, reason: "abandoned", sessionId: "impostor" }), "forbidden");
    const stopped = value(await t.exec.declareStop({ requestId: "rq-5", runId: run.runId, reason: "abandoned", sessionId: session.sessionId }));
    assert.equal(stopped.status, "cancelled");
  });

  scenario("only a finished run can be refined, and only from the head the caller saw", async t => {
    const run = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "none" }));
    refused(await t.exec.continueWork({ requestId: "rq-2", workId: run.workId, expectedHead: run.runId, workerMode: "none" }), "conflict", /finished/);
    value(await t.exec.submit({ requestId: "rq-3", runId: run.runId, items }));
    const next = value(await t.exec.continueWork({ requestId: "rq-4", workId: run.workId, expectedHead: run.runId, workerMode: "none" }));
    refused(await t.exec.continueWork({ requestId: "rq-5", workId: run.workId, expectedHead: run.runId, workerMode: "none" }), "conflict", /head is now/);
    assert.equal((await t.listRuns(run.workId)).length, 2, "the refused refinement created no run");
    assert.equal(value(await t.exec.getWork(run.workId)).work.head, next.runId);
  });

  scenario("a branch refines any run without moving the head, and the head can be selected explicitly", async t => {
    const first = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "none" }));
    value(await t.exec.submit({ requestId: "rq-2", runId: first.runId, items }));
    const branch = value(await t.exec.addBranch({ requestId: "rq-3", workId: first.workId, refines: first.runId, workerMode: "none" }));
    assert.equal(value(await t.exec.getWork(first.workId)).work.head, first.runId);
    value(await t.exec.selectHead({ requestId: "rq-4", workId: first.workId, runId: branch.runId, expectedHead: first.runId }));
    assert.equal(value(await t.exec.getWork(first.workId)).work.head, branch.runId);
    refused(await t.exec.selectHead({ requestId: "rq-5", workId: first.workId, runId: "not-in-work" }), "conflict");
    refused(await t.exec.addBranch({ requestId: "rq-6", workId: first.workId, refines: "not-in-work", workerMode: "none" }), "not-found");
    refused(await t.exec.selectHead({ requestId: "rq-7", workId: "nope", runId: branch.runId }), "not-found");
  });

  scenario("a work closes only after its runs ended, and keeps the conclusion its head showed", async t => {
    const run = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "none" }));
    value(await t.exec.submit({ requestId: "rq-2", runId: run.runId, items }));
    const branch = value(await t.exec.addBranch({ requestId: "rq-3", workId: run.workId, refines: run.runId, workerMode: "none" }));
    const waiting = value(await t.exec.closeWork({ requestId: "rq-4", workId: run.workId }));
    assert.deepEqual([waiting.status, waiting.blockedBy], ["closing", [branch.runId]]);
    refused(await t.exec.continueWork({ requestId: "rq-5", workId: run.workId, expectedHead: run.runId, workerMode: "none" }), "conflict", /closing/);
    value(await t.exec.cancel({ requestId: "rq-6", runId: branch.runId }));
    const closed = value(await t.exec.closeWork({ requestId: "rq-7", workId: run.workId }));
    assert.deepEqual([closed.status, closed.conclusion], ["closed", "pending"], "the head was delivered and no gate has judged it");
    const view = value(await t.exec.getWork(run.workId));
    assert.equal(view.work.status, "closed");
    assert.equal(view.conclusion, "pending");
  });

  scenario("transcripts are attached to the registered session", async t => {
    const run = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "external" }));
    const session = value(await t.exec.registerExternalWorker({ requestId: "rq-2", runId: run.runId, agent: { id: "a" } }));
    refused(await t.exec.importTranscript({ requestId: "rq-3", runId: run.runId, sessionId: "other", ref: "blob:1", digest: d("1"), coverage: "full" }), "forbidden");
    value(await t.exec.importTranscript({ requestId: "rq-4", runId: run.runId, sessionId: session.sessionId, ref: "blob:1", digest: d("1"), coverage: "partial" }));
    const stored = value(await t.exec.getRun(run.runId)).run;
    assert.equal(stored.worker?.kind === "external" && stored.worker.registration.transcripts.length, 1);
  });

  scenario("two refinements from the same head race: exactly one wins and the other is told the head moved", async t => {
    const first = value(await t.exec.startWork({ requestId: "rq-1", taskDefinitionId: "task-1", workerMode: "none" }));
    value(await t.exec.submit({ requestId: "rq-2", runId: first.runId, items }));
    const outcomes = await Promise.all([1, 2, 3, 4].map(n => t.exec.continueWork({ requestId: `rq-race-${n}`, workId: first.workId, expectedHead: first.runId, workerMode: "none" })));
    const winners = outcomes.filter(o => o.ok);
    assert.equal(winners.length, 1, outcomes.map(o => (o.ok ? "ok" : o.error.code)).join(","));
    for (const o of outcomes) if (!o.ok) assert.ok(["conflict", "stale"].includes(o.error.code), o.error.message);
    assert.equal((await t.listRuns(first.workId)).length, 2, "one new run, not four");
  });

  scenario("one request identity used concurrently is applied once", async t => {
    const outcomes = await Promise.all([1, 2, 3].map(() => t.exec.startWork({ requestId: "rq-same", taskDefinitionId: "task-1", workerMode: "none" })));
    const results = outcomes.map(o => value(o));
    assert.equal(new Set(results.map(r => r.runId)).size, 1);
    assert.equal((await t.listWorks()).length, 1);
  });
}

interface Harness {
  readonly exec: TaskExecution;
  readonly receipts: { result: ReceiptCheck; interrupt?: boolean };
  publishTask(id: string): Promise<void>;
  listWorks(): Promise<unknown[]>;
  listRuns(workId: string): Promise<unknown[]>;
}

async function harness(units: SqlWorkUnitOfWork): Promise<Harness> {
  const receipts = { interrupt:false, result: "accepted" as ReceiptCheck };
  const exec = new TaskExecution({ units, clock: { now: clock() }, ids: { next: ids("id") }, receipts: { check: async () => { if (receipts.interrupt) { receipts.interrupt=false; throw new Error("interrupted receipt read"); } return receipts.result; } }, hash });
  const createTask = (id: string, published: boolean) => units.run("write", async (r: WorkRepositories) => {
    const created = createDefinition({ id, kind: "task", name: id, at: "2026-01-01T00:00:00.000Z" });
    assert.ok(created.ok);
    await r.definitions.create(created.value.state);
    if (published) await publishFirstRevision(r, id);
  });
  async function publishFirstRevision(r: WorkRepositories, id: string): Promise<void> {
    const definition = (await r.definitions.get(id))!;
    const published = publishRevision(definition, { revisionId: `${id}-rev-1`, expectedSeq: 0, content: taskContent, at: "2026-01-01T00:00:01.000Z" }, hash);
    assert.ok(published.ok);
    await r.definitions.save(published.value.state, definition.version);
    await r.definitions.addRevision(published.value.outcome);
  }
  await createTask("task-1", true);
  await createTask("task-empty", false);
  return {
    exec, receipts,
    publishTask: id => units.run("write", r => publishFirstRevision(r, id)),
    listWorks: () => units.run("read", async r => [...(await r.works.listByTask("task-1")), ...(await r.works.listByTask("task-empty"))]),
    listRuns: workId => units.run("read", r => r.taskRuns.listByWork(workId)),
  };
}
