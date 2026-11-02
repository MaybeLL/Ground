import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptanceOf, acceptExecution, acquireLease, addBranch, applyTransfer, beginExecution, claimRunner, completeClose, completeReservation, completeRelease, confirmExecutionStopped, continueWork, createGrading,
  createTaskRun, evaluatorStopped, launchExperimentRun, markReady, prepareExecution, providerEnded, recordExternalUse, recordReceipt, registerAgentEvaluator, registerExternalEvaluator, registerExternalWorker,
  registerManagedWorker, requestClose, requestSandbox, reserve, returnLease, selectHead, startWork, submitGrade, submitManifest, taskRunViolations, sandboxViolations, workConclusion, workerStopped,
  adoptGrading, materialsFingerprint, start, attachSandbox, type AcceptanceConclusion, type GateBinding, type Grade, type GradingRecord, type Id, type RevisionRef, type Sandbox, type TaskRun, type TaskRunStatus,
} from "../src/work/domain/index.js";
import { accept, clock, hash, rejected } from "./work-fixtures.js";

const at = clock();
const d = (c: string) => `sha256:${c.repeat(64)}`;
const taskRevision: RevisionRef = { kind: "task", definitionId: "task-1", revisionId: "task-rev-1", seq: 1, digest: d("1") };
const graderRevision: RevisionRef = { kind: "grader", definitionId: "grader-1", revisionId: "grader-rev-1", seq: 1, digest: d("2") };
const agentRevision: RevisionRef = { kind: "agent", definitionId: "agent-1", revisionId: "agent-rev-1", seq: 1, digest: d("3") };
const items = (id: string) => [{ type: "candidate" as const, id, receipt: `tag:grounds/candidates/${id}` }];
const manifestDigest = (c: string) => d(c);

function gateBinding(manifest: string): GateBinding {
  return { taskRevision, criteriaDigest: d("5"), manifestDigest: manifestDigest(manifest), graderRevision, materialsDigest: d("7"), expectedCriteria: ["c1", "c2"] };
}
let order = 0;
function gateRecord(id: string, taskRunId: Id, manifest: string): GradingRecord {
  return accept(createGrading({ id, purpose: "gate", origin: { type: "gate", taskRunId }, requestSeq: ++order, targets: [{ type: "candidate", id: `cand-${taskRunId}`, digest: d("8") }], graderRevision,
    grader: { strategy: "agent", scale: { form: "criteria" } }, materials: [], binding: gateBinding(manifest), at: at() })).state;
}
const verdicts = (finals: [string, "satisfied" | "unsatisfied"][]): Grade => ({ form: "criteria", items: finals.map(([criterionId, final]) => ({ criterionId, independent: final, reconciliation: "corroborated" as const, final, rationale: `${criterionId} is ${final}`, evidence: [] })) });
function externalGate(id: string, taskRunId: Id, manifest: string, finals: [string, "satisfied" | "unsatisfied"][], sessionId: string): GradingRecord {
  const registered = accept(registerExternalEvaluator(gateRecord(id, taskRunId, manifest), { sessionId, agentId: "claude-code", workerSessionId: `worker-${taskRunId}`, sessionIssuedAt: "2026-06-01T00:00:00.000Z", targetsFrozenAt: "2026-05-01T00:00:00.000Z", at: at() })).state;
  return accept(submitGrade(registered, { grade: verdicts(finals), sessionId, at: at() })).state;
}

test("development with the user's own agent: reject, refine from the frozen delivery, accept, move the head, close", () => {
  // Round one: an external agent delivers.
  const first = accept(createTaskRun({ id: "run-1", taskRevision, workId: "work-1", workerMode: "external", retention: "keep", at: at() })).state;
  let work = accept(startWork({ id: "work-1", taskDefinitionId: "task-1", firstRunId: "run-1", at: at() })).state;
  let sandbox1: Sandbox = accept(markReady(accept(requestSandbox({ id: "sbx-1", owner: { type: "task_run", id: "run-1" }, retention: "keep", at: at() })).state, { workspace: { ref: "ws-1", origin: "own" }, at: at() })).state;
  let run1: TaskRun = accept(registerExternalWorker(accept(attachSandbox(accept(start(first, { at: at() })).state, { sandboxId: "sbx-1" })).state, { sessionId: "worker-run-1", agent: { id: "claude-code" }, at: at() })).state;
  sandbox1 = accept(recordExternalUse(sandbox1, { at: at() })).state;
  run1 = accept(submitManifest(run1, { origin: "external", operationId: "op-1", check: "accepted", at: at(), items: items("cand-run-1"), digest: manifestDigest("a"), sessionId: "worker-run-1", declaresStop: true })).state;
  assert.equal(run1.status, "delivered");

  // The independent gate finds criterion two unmet.
  const gate1 = externalGate("gate-1", "run-1", "a", [["c1", "satisfied"], ["c2", "unsatisfied"]], "eval-1");
  const subject1 = { taskRevisionId: "task-rev-1", criteriaDigest: d("5"), manifestDigest: manifestDigest("a") };
  const acceptance1 = acceptanceOf([gate1], subject1).conclusion;
  assert.equal(acceptance1, "rejected");
  assert.equal(workConclusion(work, run1.status, acceptance1), "rejected");

  // Refining: a new run, and the first worktree is NOT handed over because an external agent worked in it.
  const second = accept(createTaskRun({ id: "run-2", taskRevision, workId: "work-1", refines: "run-1", workerMode: "external", retention: "keep", at: at() }, { refines: { id: "run-1", status: run1.status, taskDefinitionId: "task-1", workId: "work-1" } })).state;
  work = accept(continueWork(work, { newRunId: "run-2", expectedHead: "run-1", at: at() })).state;
  rejected(reserve(sandbox1, { by: { type: "task_run", id: "run-1" }, operationId: "t1", kind: "transfer", receiver: "run-2", ownerTerminal: true, at: at() }), "conflict", /external agent/);
  let run2 = accept(registerExternalWorker(accept(attachSandbox(accept(start(second, { at: at() })).state, { sandboxId: "sbx-2" })).state, { sessionId: "worker-run-2", agent: { id: "claude-code" }, at: at() })).state;
  run2 = accept(submitManifest(run2, { origin: "external", operationId: "op-2", check: "accepted", at: at(), items: items("cand-run-2"), digest: manifestDigest("b"), sessionId: "worker-run-2", declaresStop: true })).state;

  const gate2 = externalGate("gate-2", "run-2", "b", [["c1", "satisfied"], ["c2", "satisfied"]], "eval-2");
  const subject2 = { ...subject1, manifestDigest: manifestDigest("b") };
  const acceptance2 = acceptanceOf([gate1, gate2], subject2).conclusion;
  assert.equal(acceptance2, "accepted");
  const acceptances: Record<string, AcceptanceConclusion> = { "run-1": acceptance1, "run-2": acceptance2 };
  const statuses = new Map<Id, TaskRunStatus>([["run-1", run1.status], ["run-2", run2.status]]);
  assert.equal(workConclusion(work, statuses.get(work.head!), acceptances[work.head!]), "accepted");
  work = accept(selectHead(work, { runId: "run-1", at: at() })).state;
  assert.equal(workConclusion(work, statuses.get(work.head!), acceptances[work.head!]), "rejected", "moving the head back changes what the work shows, and nothing else");
  work = accept(selectHead(work, { runId: "run-2", at: at() })).state;

  // Closing: nothing is active, so it finishes and records what it saw.
  const closing = accept(requestClose(work, { at: at() }, statuses));
  assert.deepEqual(closing.outcome.blockedBy, []);
  const closed = accept(completeClose(closing.state, { at: at(), conclusion: workConclusion(work, statuses.get("run-2"), acceptance2), releasesReserved: true }, statuses)).state;
  assert.equal(closed.closedFact?.conclusion, "accepted");
  for (const run of [run1, run2]) assert.deepEqual(taskRunViolations(run), []);
  assert.deepEqual(sandboxViolations(sandbox1), []);
});

test("development with a managed agent: the kept sandbox is paused, handed to the refining run, and fenced", () => {
  // Round one, managed: the execution holds a lease, finishes, archives, and the run delivers.
  let run1 = accept(createTaskRun({ id: "run-1", taskRevision, workId: "work-1", workerMode: "managed", retention: "keep", at: at() })).state;
  run1 = accept(start(run1, { at: at() })).state;
  let sandbox: Sandbox = accept(markReady(accept(requestSandbox({ id: "sbx-1", owner: { type: "task_run", id: "run-1" }, retention: "keep", at: at() })).state, { workspace: { ref: "ws-1", origin: "own" }, runtime: { instanceId: "inst-1", environmentRevisionId: "env-rev-1" }, at: at() })).state;
  let execution = accept(acceptExecution({ id: "exec-1", owner: { type: "task_run", id: "run-1" }, role: "worker", agentRevision, capabilities: { resume: false, verifiableStop: true, events: "full" }, at: at() })).state;
  run1 = accept(registerManagedWorker(accept(attachSandbox(run1, { sandboxId: "sbx-1" })).state, { executionId: "exec-1", at: at() })).state;
  sandbox = accept(acquireLease(sandbox, { holder: { type: "agent_execution", id: "exec-1" }, at: at() })).state;
  execution = accept(beginExecution(accept(claimRunner(accept(prepareExecution(execution, { sandboxId: "sbx-1", at: at() })).state, { runnerId: "host-1", at: at() })).state, { runnerId: "host-1", at: at() })).state;
  execution = accept(providerEnded(execution, { outcome: "succeeded", at: at() })).state;
  execution = accept(recordReceipt(accept(recordReceipt(execution, { kind: "output", ref: "blob:out", at: at() })).state, { kind: "trajectory", ref: "blob:traj", at: at() })).state;
  execution = accept(confirmExecutionStopped(execution, { at: at() })).state;
  assert.equal(execution.stage, "succeeded");
  sandbox = accept(returnLease(sandbox, { holder: { type: "agent_execution", id: "exec-1" }, token: 1, stop: "verified", at: at() })).state;
  run1 = accept(workerStopped(run1, { outcome: "succeeded", at: at() })).state;
  run1 = accept(submitManifest(run1, { origin: "tool", operationId: "op-1", check: "accepted", at: at(), items: items("cand-1"), trajectoryReceipt: "blob:traj", digest: manifestDigest("a") })).state;
  assert.equal(run1.status, "delivered");

  // Kept for refinement: paused, then handed to the next run in three steps.
  sandbox = accept(completeReservation(accept(reserve(sandbox, { by: { type: "task_run", id: "run-1" }, operationId: "pause-1", kind: "pause", at: at() })).state, { operationId: "pause-1", at: at() })).state;
  assert.equal(sandbox.phase, "paused");
  sandbox = accept(reserve(sandbox, { by: { type: "task_run", id: "run-1" }, operationId: "xfer-1", kind: "transfer", receiver: "run-2", ownerTerminal: run1.status === "delivered", at: at() })).state;
  sandbox = accept(applyTransfer(sandbox, { operationId: "xfer-1", retention: "keep", at: at() })).state;
  sandbox = accept(completeReservation(sandbox, { operationId: "xfer-1", at: at() })).state;
  assert.equal(sandbox.owner.id, "run-2");
  assert.equal(sandbox.phase, "ready");

  // The new run's execution is fenced with a newer token; the old holder's token is dead.
  const next = accept(acquireLease(sandbox, { holder: { type: "agent_execution", id: "exec-2" }, at: at() })).state;
  assert.equal(next.lease?.token, 2);
  rejected(reserve(next, { by: { type: "task_run", id: "run-1" }, operationId: "late", kind: "release", at: at() }), "forbidden");
  const releasing = accept(reserve(accept(returnLease(next, { holder: { type: "agent_execution", id: "exec-2" }, token: 2, stop: "verified", at: at() })).state, { by: { type: "task_run", id: "run-2" }, operationId: "rel-1", kind: "release", at: at() })).state;
  const released = accept(completeRelease(releasing, { operationId: "rel-1", workspace: "retained", at: at() })).state;
  assert.equal(released.phase, "released");
  assert.deepEqual(sandboxViolations(released), []);
});

test("an evaluation sample: a batch member becomes a run outside any work, then is graded and its grading adopted", () => {
  const suite: RevisionRef = { kind: "suite", definitionId: "suite-1", revisionId: "suite-rev-1", seq: 1, digest: d("a") };
  const batch = accept(launchExperimentRun({ id: "xr-1", experimentId: "exp-1", suite, agent: agentRevision, caseKeys: ["case-a"], repeatCount: 2, taskConcurrency: 2, at: at() }, hash)).state;
  const member = batch.members[1];
  let run = accept(createTaskRun({ id: member.taskRunRequestId, taskRevision, workerMode: "managed", retention: "release", at: at() })).state;
  assert.equal(run.workId, undefined, "a sample belongs to no work");
  run = accept(registerManagedWorker(accept(start(run, { at: at() })).state, { executionId: "exec-1", at: at() })).state;
  run = accept(workerStopped(run, { outcome: "succeeded", at: at() })).state;
  run = accept(submitManifest(run, { origin: "contract", operationId: "op-1", check: "accepted", at: at(), items: [{ type: "artifact", id: "art-1", receipt: "blob:art-1" }], trajectoryReceipt: "blob:traj", digest: d("a") })).state;
  assert.equal(run.status, "delivered");

  const materials = [{ id: "ref", digest: d("e") }];
  const measure = (id: string) => accept(createGrading({ id, purpose: "measure", origin: { type: "member", experimentRunId: "xr-1", caseKey: member.caseKey, repeatIndex: member.repeatIndex, requirementKey: "accuracy" }, requestSeq: ++order,
    targets: [{ type: "artifact", id: "art-1", digest: d("c") }], graderRevision, grader: { strategy: "agent", scale: { form: "numeric", min: 0, max: 5 } }, materials, at: at() })).state;
  const judged = (id: string, value: number): GradingRecord => {
    const registered = accept(registerAgentEvaluator(measure(id), { executionId: `judge-${id}`, at: at() })).state;
    return accept(submitGrade(accept(evaluatorStopped(registered, { at: at() })).state, { grade: { form: "numeric", value }, at: at() })).state;
  };
  const first = judged("m-1", 4), regrade = judged("m-2", 2);
  const slot = { experimentRunId: "xr-1", caseKey: member.caseKey, repeatIndex: member.repeatIndex, requirementKey: "accuracy", graderRevisionId: "grader-rev-1", targets: ["artifact:art-1:" + d("c")], materialsDigest: d("0") };
  const adoption = adoptGrading([first, regrade], slot, materialsFingerprint(materials));
  assert.equal(adoption.adopted, "m-2", "the regrade is what the batch result reads; the first stays in the history");
  assert.equal(adoption.attempts, 2);
});
