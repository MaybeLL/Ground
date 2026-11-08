import assert from "node:assert/strict";
import { test } from "node:test";
import { digestOf, materialsDigest, type DeliveryItem, type Grade } from "../src/work/domain/index.js";
import { BUILTIN_VERIFICATION_GRADER, ensureVerificationGrader } from "../src/work/application/index.js";
import { SqlWorkUnitOfWork } from "../src/work/adapters/index.js";
import { backends, backendSkip, openLedger } from "./backends.js";
import { application, refused, value, type Application } from "./work-application-harness.js";
import { hash } from "./work-fixtures.js";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const items: DeliveryItem[] = [{ type: "candidate", id: "cand-1", receipt: "tag:grounds/cand-1" }];
const grade = (c1: "satisfied" | "unsatisfied" | "indeterminate", c2: "satisfied" | "unsatisfied" | "indeterminate" = "satisfied"): Grade => ({ form: "criteria", items: [
  { criterionId: "c1", independent: c1, reconciliation: "corroborated", final: c1, rationale: "checked", evidence: ["go test: exit 0"] },
  { criterionId: "c2", independent: c2, reconciliation: "corroborated", final: c2, rationale: "checked", evidence: [] },
] });

/** A delivered run of the caller's own agent. */
async function delivered(app: Application, n = 1) {
  const started = value(await app.exec.startWork({ requestId: `s-${n}`, taskDefinitionId: "task-1", workerMode: "external" }));
  const worker = value(await app.exec.registerExternalWorker({ requestId: `w-${n}`, runId: started.runId, agent: { id: "worker-agent" } }));
  value(await app.exec.submit({ requestId: `sub-${n}`, runId: started.runId, sessionId: worker.sessionId, items, declaresStop: true }));
  return { ...started, workerSession: worker.sessionId };
}
/** An evaluator that blinds, freezes and hands in a verdict. */
async function evaluate(app: Application, runId: string, n: number, verdict: Grade) {
  const gate = value(await app.grading.requestGate({ requestId: `g-${n}`, taskRunId: runId }));
  const evaluator = value(await app.grading.registerExternalEvaluator({ requestId: `e-${n}`, gradingId: gate.gradingId, agent: { id: "reviewer" } }));
  value(await app.grading.recordStage({ requestId: `b-${n}`, gradingId: gate.gradingId, sessionId: evaluator.sessionId, stage: "blind" }));
  value(await app.grading.recordStage({ requestId: `f-${n}`, gradingId: gate.gradingId, sessionId: evaluator.sessionId, stage: "freeze", blindDigest: d("a") }));
  const done = value(await app.grading.submitGrade({ requestId: `v-${n}`, gradingId: gate.gradingId, sessionId: evaluator.sessionId, grade: verdict }));
  return { gate, evaluator, done };
}

for (const backend of backends) {
  const scenario = (name: string, run: (app: Application) => Promise<void>) => test(`${backend}: gates ${name}`, { skip: backendSkip(backend) }, async () => {
    const fixture = await openLedger(backend);
    try { await run(await application(new SqlWorkUnitOfWork(fixture.store))); } finally { await fixture.close(); }
  });

  scenario("a rejected delivery is refined and the refinement is accepted: the work follows its head", async app => {
    const first = await delivered(app, 1);
    const rejected = await evaluate(app, first.runId, 1, grade("satisfied", "unsatisfied"));
    assert.equal(rejected.done.status, "completed");
    assert.equal(value(await app.exec.getRun(first.runId)).acceptance, "rejected");
    assert.equal(value(await app.exec.getWork(first.workId)).conclusion, "rejected");

    const second = value(await app.exec.continueWork({ requestId: "c-1", workId: first.workId, expectedHead: first.runId, workerMode: "external" }));
    assert.equal(value(await app.exec.getWork(first.workId)).conclusion, "in-progress");
    const worker = value(await app.exec.registerExternalWorker({ requestId: "w-2", runId: second.runId, agent: { id: "worker-agent" } }));
    value(await app.exec.submit({ requestId: "sub-2", runId: second.runId, sessionId: worker.sessionId, items: [{ type: "candidate", id: "cand-2", receipt: "tag:grounds/cand-2" }], declaresStop: true }));
    assert.equal(value(await app.exec.getWork(first.workId)).conclusion, "pending");
    await evaluate(app, second.runId, 2, grade("satisfied"));
    assert.equal(value(await app.exec.getRun(second.runId)).acceptance, "accepted");
    assert.equal(value(await app.exec.getWork(first.workId)).conclusion, "accepted");
    assert.equal(value(await app.exec.getRun(first.runId)).acceptance, "rejected", "the earlier delivery keeps its own verdict");
    const closed = value(await app.exec.closeWork({ requestId: "close-1", workId: first.workId }));
    assert.deepEqual([closed.status, closed.conclusion], ["closed", "accepted"]);
  });

  scenario("a gate is bound to the exact delivery and task, and is numbered by the ledger", async app => {
    const run = await delivered(app);
    const first = value(await app.grading.requestGate({ requestId: "g-1", taskRunId: run.runId, materials: [{ id: "ctx", digest: d("c") }] }));
    const second = value(await app.grading.requestGate({ requestId: "g-2", taskRunId: run.runId }));
    assert.ok(second.requestSeq > first.requestSeq);
    assert.deepEqual(first.criteria.map(c => c.id), ["c1", "c2"]);
    const stored = value(await app.grading.getGrading(first.gradingId));
    const stateRun = value(await app.exec.getRun(run.runId)).run;
    assert.equal(stored.binding?.manifestDigest, stateRun.manifest?.digest);
    assert.deepEqual(stored.binding?.expectedCriteria, ["c1", "c2"]);
    assert.equal(stored.graderRevision.revisionId, BUILTIN_VERIFICATION_GRADER.revisionId);
    assert.equal(stored.materials.length, 1);
    assert.equal(value(await app.grading.getGrading(second.gradingId)).graderRevision.revisionId, stored.graderRevision.revisionId, "the built-in grader is created once");
    assert.deepEqual(value(await app.grading.listGates(run.runId)).map(g => g.id), [first.gradingId, second.gradingId]);
  });

  scenario("concurrent requests for the same binding share one active gate", async app => {
    const {runId}=await delivered(app);
    const requests=["left","right"].map(requestId=>({requestId,taskRunId:runId}));
    const [left,right]=await Promise.all(requests.map(async input=>value(await app.grading.requestGate(input))));
    assert.deepEqual(left,right);
    assert.equal(value(await app.grading.listGates(runId)).length,1);
    value(await app.grading.cancel({requestId:"cancel",gradingId:left!.gradingId}));
    const fresh=value(await app.grading.requestGate({requestId:"after",taskRunId:runId}));
    assert.ok(fresh.requestSeq>left!.requestSeq);
    for (const input of requests) assert.deepEqual(value(await app.grading.requestGate(input)),left);
  });

  scenario("Unicode material IDs have stable bindings across order and older ledger digests",async app=>{
    const {runId}=await delivered(app);
    const materials=[{id:"é",digest:d("a")},{id:"e\u0301",digest:d("b")}];
    const reversed=[...materials].reverse();
    const legacy=digestOf(materials,hash),current=materialsDigest(materials,hash);
    assert.ok(legacy.ok && current.ok);
    assert.notEqual(legacy.value,current.value);
    assert.deepEqual(materialsDigest(reversed,hash),current);
    const original=value(await app.grading.requestGate({requestId:"original",taskRunId:runId,materials}));
    await app.units.run("write",async r=>{
      const saved=await r.gradings.get(original.gradingId,{lock:true});
      assert.ok(saved?.binding);
      await r.gradings.save({...saved,version:saved.version+1,binding:{...saved.binding,materialsDigest:legacy.value}},saved.version);
    });
    const ask=(requestId:string)=>app.grading.requestGate({requestId,taskRunId:runId,materials:reversed});
    assert.deepEqual(value(await ask("other")),original);
    const submit=async(gradingId:string,verdict:Grade)=>{
      const {sessionId}=value(await app.grading.registerExternalEvaluator({requestId:"register-"+gradingId,gradingId,agent:{id:"judge"}}));
      const args={gradingId,sessionId};
      value(await app.grading.recordStage({...args,requestId:"blind-"+gradingId,stage:"blind"}));
      value(await app.grading.recordStage({...args,requestId:"freeze-"+gradingId,stage:"freeze",blindDigest:d("f")}));
      return value(await app.grading.submitGrade({...args,requestId:"grade-"+gradingId,grade:verdict}));
    };
    await submit(original.gradingId,grade("satisfied"));
    const abandoned=value(await ask("abandoned"));
    value(await app.grading.cancel({requestId:"end",gradingId:abandoned.gradingId}));
    const fresh=value(await ask("retry"));
    assert.notEqual(fresh.gradingId,original.gradingId);
    assert.equal(value(await app.grading.getGrading(fresh.gradingId)).binding?.materialsDigest,current.value);
    const verdict=grade("satisfied");
    assert.ok(verdict.form==="criteria");
    assert.equal((await submit(fresh.gradingId,{...verdict,items:verdict.items.map(item=>({...item,reusedFrom:original.gradingId}))})).status,"completed");
  });

  scenario("only a delivered run can be accepted", async app => {
    const pending = value(await app.exec.startWork({ requestId: "s-1", taskDefinitionId: "task-1", workerMode: "external" }));
    refused(await app.grading.requestGate({ requestId: "g-1", taskRunId: pending.runId }), "conflict", /only a delivered run/);
    refused(await app.grading.requestGate({ requestId: "g-2", taskRunId: "no-such-run" }), "not-found");
    refused(await app.grading.registerExternalEvaluator({ requestId: "e-1", gradingId: "no-such-grading", agent: { id: "r" } }), "not-found");
  });

  scenario("the verdict needs the blind result frozen first, and the frozen result cannot be rewritten", async app => {
    const run = await delivered(app);
    const gate = value(await app.grading.requestGate({ requestId: "g-1", taskRunId: run.runId }));
    const evaluator = value(await app.grading.registerExternalEvaluator({ requestId: "e-1", gradingId: gate.gradingId, agent: { id: "reviewer" } }));
    const session = evaluator.sessionId;
    refused(await app.grading.submitGrade({ requestId: "v-0", gradingId: gate.gradingId, sessionId: session, grade: grade("satisfied") }), "conflict", /freeze the blind assessment/);
    refused(await app.grading.recordStage({ requestId: "f-0", gradingId: gate.gradingId, sessionId: session, stage: "freeze", blindDigest: d("a") }), "conflict", /does not follow/);
    value(await app.grading.recordStage({ requestId: "b-1", gradingId: gate.gradingId, sessionId: session, stage: "blind" }));
    value(await app.grading.recordStage({ requestId: "f-1", gradingId: gate.gradingId, sessionId: session, stage: "freeze", blindDigest: d("a") }));
    refused(await app.grading.recordStage({ requestId: "r-1", gradingId: gate.gradingId, sessionId: session, stage: "reconcile", blindDigest: d("b") }), "conflict", /cannot change/);
    assert.equal(value(await app.grading.getGrading(gate.gradingId)).status, "running");
  });

  scenario("only the evaluator's own session may speak for the grading, and it is not the worker's session", async app => {
    const run = await delivered(app);
    const gate = value(await app.grading.requestGate({ requestId: "g-1", taskRunId: run.runId }));
    const evaluator = value(await app.grading.registerExternalEvaluator({ requestId: "e-1", gradingId: gate.gradingId, agent: { id: "reviewer" } }));
    assert.notEqual(evaluator.sessionId, run.workerSession, "the evaluator is a fresh session");
    refused(await app.grading.registerExternalEvaluator({ requestId: "e-2", gradingId: gate.gradingId, agent: { id: "second" } }), "conflict", /already registered/);
    for (const sessionId of [run.workerSession, "impostor"]) {
      refused(await app.grading.recordStage({ requestId: `x-${sessionId}`, gradingId: gate.gradingId, sessionId, stage: "blind" }), "forbidden");
      refused(await app.grading.submitGrade({ requestId: `y-${sessionId}`, gradingId: gate.gradingId, sessionId, grade: grade("satisfied") }), "forbidden");
    }
  });

  scenario("a verdict must judge exactly the task's criteria", async app => {
    const run = await delivered(app);
    const gate = value(await app.grading.requestGate({ requestId: "g-1", taskRunId: run.runId }));
    const evaluator = value(await app.grading.registerExternalEvaluator({ requestId: "e-1", gradingId: gate.gradingId, agent: { id: "reviewer" } }));
    for (const stage of ["blind", "freeze"] as const) value(await app.grading.recordStage({ requestId: `s-${stage}`, gradingId: gate.gradingId, sessionId: evaluator.sessionId, stage, ...(stage === "freeze" ? { blindDigest: d("a") } : {}) }));
    const partial: Grade = { form: "criteria", items: [(grade("satisfied") as Extract<Grade, { form: "criteria" }>).items[0]] };
    refused(await app.grading.submitGrade({ requestId: "v-1", gradingId: gate.gradingId, sessionId: evaluator.sessionId, grade: partial }), "invalid", /exactly the expected criteria/);
    refused(await app.grading.submitGrade({ requestId: "v-2", gradingId: gate.gradingId, sessionId: evaluator.sessionId, grade: { form: "numeric", value: 3 } }), "invalid");
    value(await app.grading.submitGrade({ requestId: "v-3", gradingId: gate.gradingId, sessionId: evaluator.sessionId, grade: grade("satisfied") }));
  });

  scenario("when gates disagree the latest request counts, and a replayed request changes nothing", async app => {
    const run = await delivered(app);
    await evaluate(app, run.runId, 1, grade("satisfied"));
    assert.equal(value(await app.exec.getRun(run.runId)).acceptance, "accepted");
    await evaluate(app, run.runId, 2, grade("unsatisfied"));
    assert.equal(value(await app.exec.getRun(run.runId)).acceptance, "rejected");
    const again = value(await app.grading.requestGate({ requestId: "g-2", taskRunId: run.runId }));
    assert.equal(value(await app.grading.listGates(run.runId)).length, 2, "the replay did not add a third gate");
    assert.equal(again.requestSeq, value(await app.grading.listGates(run.runId))[1].requestSeq);
  });

  scenario("an indeterminate criterion is a result, not a failure", async app => {
    const run = await delivered(app);
    const { done } = await evaluate(app, run.runId, 1, grade("satisfied", "indeterminate"));
    assert.equal(done.status, "completed");
    assert.equal(value(await app.exec.getRun(run.runId)).acceptance, "rejected", "a criterion that could not be established does not pass");
  });

  scenario("cancelling a grading waits for the evaluator to declare it stopped, and a late verdict is only recorded", async app => {
    const run = await delivered(app);
    const gate = value(await app.grading.requestGate({ requestId: "g-1", taskRunId: run.runId }));
    const evaluator = value(await app.grading.registerExternalEvaluator({ requestId: "e-1", gradingId: gate.gradingId, agent: { id: "reviewer" } }));
    assert.equal(value(await app.grading.cancel({ requestId: "x-1", gradingId: gate.gradingId })).status, "running");
    const stopped = value(await app.grading.declareEvaluatorStop({ requestId: "x-2", gradingId: gate.gradingId, sessionId: evaluator.sessionId }));
    assert.equal(stopped.status, "cancelled");
    const late = value(await app.grading.submitGrade({ requestId: "v-1", gradingId: gate.gradingId, sessionId: evaluator.sessionId, grade: grade("satisfied") }));
    assert.equal(late.status, "cancelled");
    assert.equal(value(await app.exec.getRun(run.runId)).acceptance, "pending", "a cancelled gate decides nothing");
  });

  scenario("two evaluators racing for one grading: exactly one is registered", async app => {
    const run = await delivered(app);
    const gate = value(await app.grading.requestGate({ requestId: "g-1", taskRunId: run.runId }));
    const outcomes = await Promise.all([1, 2, 3, 4].map(n => app.grading.registerExternalEvaluator({ requestId: `e-${n}`, gradingId: gate.gradingId, agent: { id: `reviewer-${n}` } })));
    assert.equal(outcomes.filter(o => o.ok).length, 1, outcomes.map(o => (o.ok ? "ok" : o.error.code)).join(","));
  });

  scenario("the built-in grader is created once, and asking for it again changes nothing", async app => {
    const run = await delivered(app);
    const gate = value(await app.grading.requestGate({ requestId: "g-1", taskRunId: run.runId }));
    const before = value(await app.grading.getGrading(gate.gradingId)).graderRevision;
    await app.units.run("write", async r => {
      const again = await ensureVerificationGrader(r, hash, "2026-02-01T00:00:00.000Z");
      assert.ok(again.ok && again.value.revisionId === before.revisionId && again.value.digest === before.digest);
    });
  });

}
