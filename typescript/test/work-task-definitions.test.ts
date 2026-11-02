import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskDefinitions, TaskExecution } from "../src/work/application/index.js";
import { SqlWorkUnitOfWork } from "../src/work/adapters/index.js";
import { backends, backendSkip, openLedger } from "./backends.js";
import { refused, value } from "./work-application-harness.js";
import { clock, hash, ids } from "./work-fixtures.js";

for (const backend of backends) {
  const scenario = (name: string, run: (tasks: TaskDefinitions, exec: TaskExecution) => Promise<void>) => test(`${backend}: tasks ${name}`, { skip: backendSkip(backend) }, async () => {
    const fixture = await openLedger(backend);
    try {
      const units = new SqlWorkUnitOfWork(fixture.store);
      const shared = { units, clock: { now: clock() }, ids: { next: ids("id") }, hash };
      await run(new TaskDefinitions(shared), new TaskExecution({ ...shared, receipts: { check: async () => "accepted" } }));
    } finally { await fixture.close(); }
  });

  scenario("a task is created with its first revision, and criteria get identities", async tasks => {
    const created = value(await tasks.createTask({ requestId: "t-1", summary: "Add export", criteria: [{ statement: "exports CSV" }, { statement: "keeps headers" }], context: "see the spec", repository: { remote: "ssh://git@example.test/team/repo", baseline: "main" } }));
    assert.equal(created.seq, 1);
    assert.equal(created.criteria.length, 2);
    assert.equal(new Set(created.criteria.map(c => c.id)).size, 2);
    const view = value(await tasks.getTask(created.taskId));
    assert.equal(view.revision?.id, created.revisionId);
    const content = view.revision!.content as { kind: string; summary: string; context: string; repository: { baseline: string }; criteria: { id: string }[] };
    assert.deepEqual([content.kind, content.summary, content.context, content.repository.baseline], ["coding", "Add export", "see the spec", "main"]);
    assert.deepEqual(content.criteria.map(c => c.id), created.criteria.map(c => c.id));
    assert.deepEqual(value(await tasks.listTasks()).map(t => t.taskId), [created.taskId]);
  });

  scenario("a revision keeps the identity of criteria it keeps, adds new ones, and a stale or unchanged revision is refused", async tasks => {
    const first = value(await tasks.createTask({ requestId: "t-1", summary: "Add export", criteria: [{ statement: "exports CSV" }, { statement: "keeps headers" }] }));
    const [csv, headers] = first.criteria;
    const second = value(await tasks.reviseTask({ requestId: "t-2", taskId: first.taskId, expectedSeq: 1, summary: "Add export", criteria: [{ id: csv.id, statement: "exports CSV with a BOM" }, { statement: "streams large files" }] }));
    assert.equal(second.seq, 2);
    assert.equal(second.criteria[0].id, csv.id, "the reworded criterion is the same criterion");
    assert.ok(!second.criteria.some(c => c.id === headers.id), "the dropped criterion is gone from the new revision");
    assert.notEqual(second.criteria[1].id, headers.id);
    assert.equal(value(await tasks.getTask(first.taskId, 1)).revision?.id, first.revisionId, "the first revision is still there, unchanged");
    assert.equal(value(await tasks.getTask(first.taskId)).revision?.id, second.revisionId);
    refused(await tasks.reviseTask({ requestId: "t-3", taskId: first.taskId, expectedSeq: 1, summary: "x", criteria: [{ statement: "y" }] }), "conflict", /revision 2, not 1/);
    refused(await tasks.reviseTask({ requestId: "t-4", taskId: first.taskId, expectedSeq: 2, summary: "Add export", criteria: second.criteria }), "conflict", /unchanged/);
    refused(await tasks.reviseTask({ requestId: "t-5", taskId: first.taskId, expectedSeq: 2, summary: "Add export", criteria: [{ id: headers.id, statement: "back again" }] }), "invalid", /not in the previous revision/);
    refused(await tasks.reviseTask({ requestId: "t-6", taskId: "nope", expectedSeq: 1, summary: "x", criteria: [{ statement: "y" }] }), "not-found");
  });

  scenario("a task needs a summary and at least one criterion", async tasks => {
    refused(await tasks.createTask({ requestId: "t-1", summary: "No criteria", criteria: [] }), "invalid", /at least one criterion/);
    refused(await tasks.createTask({ requestId: "t-2", summary: "", criteria: [{ statement: "x" }] }), "invalid");
    refused(await tasks.createTask({ requestId: "t-3", summary: "Blank criterion", criteria: [{ statement: "" }] }), "invalid");
    assert.deepEqual(value(await tasks.listTasks()), [], "refusals created nothing");
  });

  scenario("a request is applied once", async tasks => {
    const input = { requestId: "t-1", summary: "Add export", criteria: [{ statement: "exports CSV" }] };
    const first = value(await tasks.createTask(input));
    assert.deepEqual(value(await tasks.createTask(input)), first);
    refused(await tasks.createTask({ ...input, summary: "Something else" }), "request-conflict");
    assert.equal(value(await tasks.listTasks()).length, 1);
  });

  scenario("work stays tied to the revision it started on, and a refinement starts from the latest", async (tasks, exec) => {
    const first = value(await tasks.createTask({ requestId: "t-1", summary: "Add export", criteria: [{ statement: "exports CSV" }] }));
    const started = value(await exec.startWork({ requestId: "w-1", taskDefinitionId: first.taskId, workerMode: "none" }));
    assert.equal(started.taskRevisionId, first.revisionId);
    value(await exec.submit({ requestId: "s-1", runId: started.runId, items: [{ type: "candidate", id: "d", receipt: "r" }] }));
    const second = value(await tasks.reviseTask({ requestId: "t-2", taskId: first.taskId, expectedSeq: 1, summary: "Add export", criteria: [{ id: first.criteria[0].id, statement: "exports CSV, escaping quotes" }] }));
    assert.equal(value(await exec.getRun(started.runId)).run.taskRevision.revisionId, first.revisionId, "the delivered run still points at the wording it was done against");
    const next = value(await exec.continueWork({ requestId: "c-1", workId: started.workId, expectedHead: started.runId, workerMode: "none" }));
    assert.equal(next.taskRevisionId, second.revisionId);
    value(await exec.submit({ requestId: "s-2", runId: next.runId, items: [{ type: "candidate", id: "d2", receipt: "r2" }] }));
    const pinned = value(await exec.continueWork({ requestId: "c-2", workId: started.workId, expectedHead: next.runId, workerMode: "none", taskRevisionId: first.revisionId }));
    assert.equal(pinned.taskRevisionId, first.revisionId, "a caller may keep the older wording explicitly");
  });
}
