import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachSandbox, block, concludeRound, createTaskRun, declareExternalStop, failInfrastructure, importTranscript, isTerminal, registerExternalWorker, registerManagedWorker,
  requestCancel, start, submitManifest, taskRunViolations, unblock, workerStopUnknown, workerStopped,
  type Decision, type Id, type ManifestSubmission, type RevisionRef, type TaskRun, type TaskRunEvent, type WorkerMode, type Result,
} from "../src/work/domain/index.js";
import { accept, clock, random, rejected } from "./work-fixtures.js";

const at = clock();
const taskRevision: RevisionRef = { kind: "task", definitionId: "task-1", revisionId: "task-rev-1", seq: 1, digest: `sha256:${"1".repeat(64)}` };
const digest = `sha256:${"2".repeat(64)}`;
const items = [{ type: "candidate" as const, id: "cand-1", receipt: "tag:grounds/candidates/cand-1" }];

type Step = Result<Decision<TaskRun, TaskRunEvent, string>>;
const apply = (step: Step): TaskRun => { const d = accept(step); assert.deepEqual(taskRunViolations(d.state), [], "invariants hold after every decision"); return d.state; };

function newRun(mode: WorkerMode = "managed", extra: Partial<Parameters<typeof createTaskRun>[0]> = {}): TaskRun {
  return accept(createTaskRun({ id: "run-1", taskRevision, workerMode: mode, retention: "keep", at: at(), ...extra })).state;
}
function running(mode: WorkerMode = "managed"): TaskRun {
  return apply(start(newRun(mode), { at: at() }));
}
function withManagedWorker(): TaskRun {
  return apply(registerManagedWorker(running("managed"), { executionId: "exec-1", at: at() }));
}
function withExternalWorker(): TaskRun {
  return apply(registerExternalWorker(running("external"), { sessionId: "sess-1", agent: { id: "claude-code" }, at: at() }));
}
const submission = (over: Partial<ManifestSubmission> = {}): ManifestSubmission => ({ origin: "tool", operationId: "op-1", check: "accepted", at: at(), items, trajectoryReceipt: "blob:trajectory-1", digest, ...over });
const externalSubmission = (over: Partial<ManifestSubmission> = {}): ManifestSubmission => ({ origin: "external", operationId: "op-1", check: "accepted", at: at(), items, digest, sessionId: "sess-1", declaresStop: true, ...over });

test("a run is created pending and refining needs a finished run of the same task and work", () => {
  const run = newRun();
  assert.equal(run.status, "pending");
  assert.equal(run.version, 1);
  const finished = { id: "run-0", status: "delivered" as const, taskDefinitionId: "task-1", workId: "work-1" };
  const refinement = accept(createTaskRun({ id: "run-2", taskRevision, workId: "work-1", refines: "run-0", workerMode: "external", retention: "keep", at: at() }, { refines: finished })).state;
  assert.equal(refinement.refines, "run-0");
  const refine = (facts: Parameters<typeof createTaskRun>[1], workId = "work-1") => createTaskRun({ id: "run-2", taskRevision, workId, refines: "run-0", workerMode: "external", retention: "keep", at: at() }, facts);
  rejected(refine({ refines: { ...finished, status: "running" } }), "conflict", /finished/);
  rejected(refine({ refines: { ...finished, status: "pending" } }), "conflict", /finished/);
  rejected(refine({ refines: { ...finished, taskDefinitionId: "task-2" } }), "conflict", /same task/);
  rejected(refine({ refines: { ...finished, workId: "work-2" } }), "conflict", /same work/);
  rejected(refine(undefined), "invalid");
  accept(refine({ refines: { ...finished, status: "failed" } }));
  accept(refine({ refines: { ...finished, status: "cancelled" } }));
  rejected(createTaskRun({ id: "", taskRevision, workerMode: "managed", retention: "keep", at: at() }), "invalid");
  rejected(createTaskRun({ id: "r", taskRevision: { ...taskRevision, kind: "agent" }, workerMode: "managed", retention: "keep", at: at() }), "invalid");
});

test("a managed round: start, register, stop, then a frozen manifest delivers the run", () => {
  let run = withManagedWorker();
  run = apply(attachSandbox(run, { sandboxId: "sbx-1" }));
  assert.equal(run.sandboxId, "sbx-1");
  rejected(attachSandbox(run, { sandboxId: "sbx-2" }), "conflict");
  rejected(submitManifest(run, submission()), "conflict", /stop is not verified/);
  run = apply(workerStopped(run, { outcome: "succeeded", at: at() }));
  const done = accept(submitManifest(run, submission()));
  assert.equal(done.state.status, "delivered");
  assert.equal(done.state.manifest?.digest, digest);
  assert.ok(done.state.terminalAt);
  assert.deepEqual(done.events.map(e => e.type), ["manifest-frozen", "delivered"]);
  assert.deepEqual(taskRunViolations(done.state), []);
});

test("a valid delivery wins even when the producing execution failed", () => {
  const run = apply(workerStopped(withManagedWorker(), { outcome: "failed", at: at() }));
  const done = accept(submitManifest(run, submission()));
  assert.equal(done.state.status, "delivered");
  assert.equal(done.state.worker?.kind === "managed" && done.state.worker.outcome, "failed");
});

test("failure classes follow one exclusive order", () => {
  const rejectedWithFailedWorker = accept(submitManifest(apply(workerStopped(withManagedWorker(), { outcome: "failed", at: at() })), submission({ check: "rejected", items: undefined })));
  assert.equal(rejectedWithFailedWorker.state.failure?.class, "agent-output", "a rejected manifest is agent-output whatever the worker did");
  const noManifestFailed = accept(concludeRound(apply(workerStopped(withManagedWorker(), { outcome: "failed", at: at() })), { at: at() }));
  assert.equal(noManifestFailed.state.failure?.class, "agent-execution");
  const noManifestFine = accept(concludeRound(apply(workerStopped(withManagedWorker(), { outcome: "succeeded", at: at() })), { at: at() }));
  assert.equal(noManifestFine.state.failure?.class, "agent-output");
  const infra = accept(failInfrastructure(running("managed"), { detail: "container image could not be pulled", at: at() }));
  assert.equal(infra.state.failure?.class, "infrastructure");
  for (const d of [rejectedWithFailedWorker, noManifestFailed, noManifestFine, infra]) { assert.equal(d.state.status, "failed"); assert.deepEqual(taskRunViolations(d.state), []); }
});

test("an unavailable receipt blocks the round, which then completes on retry", () => {
  const stopped = apply(workerStopped(withManagedWorker(), { outcome: "succeeded", at: at() }));
  const waiting = accept(submitManifest(stopped, submission({ check: "unavailable", items: undefined })));
  assert.equal(waiting.state.status, "running");
  assert.equal(waiting.state.blocked?.reason, "receipt-unavailable");
  assert.equal(waiting.state.pendingManifest?.operationId, "op-1");
  rejected(concludeRound(waiting.state, { at: at() }), "conflict", /waiting for its receipts/);
  const done = accept(submitManifest(waiting.state, submission()));
  assert.equal(done.state.status, "delivered");
  assert.equal(done.state.blocked, undefined);
  assert.equal(done.state.pendingManifest, undefined);
});

test("cancelling a pending run cancels it at once; cancelling a finished run changes nothing", () => {
  const pending = accept(requestCancel(newRun(), { at: at() }));
  assert.equal(pending.state.status, "cancelled");
  assert.deepEqual(pending.events.map(e => e.type), ["cancel-requested", "cancelled"]);
  const again = accept(requestCancel(pending.state, { at: at() }));
  assert.equal(again.outcome, "already-terminal");
  assert.equal(again.state, pending.state);
  const delivered = accept(submitManifest(apply(workerStopped(withManagedWorker(), { outcome: "succeeded", at: at() })), submission())).state;
  assert.equal(accept(requestCancel(delivered, { at: at() })).outcome, "already-terminal");
  assert.equal(accept(requestCancel(delivered, { at: at() })).state.status, "delivered");
});

test("cancelling a running managed round waits for a verified stop and refuses a late delivery", () => {
  const cancelling = accept(requestCancel(withManagedWorker(), { at: at() }));
  assert.equal(cancelling.state.status, "running", "intent recorded, nothing confirmed stopped yet");
  assert.ok(cancelling.state.cancelIntent);
  assert.equal(accept(requestCancel(cancelling.state, { at: at() })).outcome, "already-requested");
  rejected(start(cancelling.state, { at: at() }), "conflict");
  rejected(registerManagedWorker(cancelling.state, { executionId: "exec-2", at: at() }), "conflict");
  const stopped = accept(workerStopped(cancelling.state, { outcome: "succeeded", at: at() }));
  assert.equal(stopped.state.status, "cancelled");
  assert.deepEqual(taskRunViolations(stopped.state), []);

  const afterIntent = accept(submitManifest(cancelling.state, submission({ check: "accepted" })));
  assert.equal(afterIntent.state.status, "running", "the manifest is not frozen once cancellation was requested");
  assert.equal(afterIntent.state.manifest, undefined);
  assert.equal(afterIntent.outcome, "cancel-wins");
  assert.equal(afterIntent.state.lateRecords.length, 1);
});

test("a delivery that was committed first wins over a later cancellation", () => {
  const stopped = apply(workerStopped(withManagedWorker(), { outcome: "succeeded", at: at() }));
  const delivered = accept(submitManifest(stopped, submission())).state;
  const late = accept(requestCancel(delivered, { at: at() }));
  assert.equal(late.state.status, "delivered");
  const lateStop = accept(workerStopped(delivered, { outcome: "succeeded", at: at() }));
  assert.equal(lateStop.outcome, "late");
  assert.equal(lateStop.state.status, "delivered");
  assert.equal(lateStop.state.lateRecords.length, 1);
  const lateManifest = accept(submitManifest(delivered, submission({ operationId: "op-2" })));
  assert.equal(lateManifest.outcome, "late");
  assert.equal(lateManifest.state.manifest?.operationId, "op-1", "the frozen manifest is never replaced");
});

test("an unknown stop blocks the round until it is verified", () => {
  const unknown = accept(workerStopUnknown(withManagedWorker(), { at: at() })).state;
  assert.equal(unknown.blocked?.reason, "stop-unknown");
  rejected(unblock(unknown, { at: at() }), "conflict", /still unknown/);
  rejected(failInfrastructure(unknown, { detail: "host lost", at: at() }), "conflict", /stop must be confirmed/);
  rejected(submitManifest(unknown, submission()), "conflict", /not verified/);
  const verified = accept(workerStopped(unknown, { outcome: "failed", at: at() })).state;
  assert.equal(verified.blocked, undefined);
  assert.equal(accept(concludeRound(verified, { at: at() })).state.failure?.class, "agent-execution");
  const cancelling = accept(requestCancel(unknown, { at: at() })).state;
  assert.equal(cancelling.status, "running");
  assert.equal(accept(workerStopped(cancelling, { outcome: "failed", at: at() })).state.status, "cancelled");
});

test("a round has at most one worker and only of its configured kind", () => {
  rejected(registerManagedWorker(newRun(), { executionId: "e", at: at() }), "conflict", /not started/);
  const managed = withManagedWorker();
  rejected(registerManagedWorker(managed, { executionId: "exec-2", at: at() }), "conflict", /at most one/);
  rejected(registerExternalWorker(running("managed"), { sessionId: "s", agent: { id: "a" }, at: at() }), "conflict", /managed/);
  rejected(registerManagedWorker(running("external"), { executionId: "e", at: at() }), "conflict", /external/);
  rejected(submitManifest(running("none"), submission({ origin: "tool" })), "conflict", /cannot take/);
  rejected(submitManifest(managed, externalSubmission()), "conflict", /cannot take/);
  rejected(submitManifest(apply(workerStopped(managed, { outcome: "succeeded", at: at() })), submission({ trajectoryReceipt: undefined })), "invalid", /trajectory/);
  rejected(submitManifest(running("managed"), submission()), "conflict", /not registered/);
});

test("an external submission needs the issued session, declares the stop and delivers", () => {
  const run = withExternalWorker();
  rejected(submitManifest(run, externalSubmission({ sessionId: "someone-else" })), "forbidden");
  rejected(submitManifest(run, externalSubmission({ sessionId: undefined })), "forbidden");
  rejected(submitManifest(run, externalSubmission({ declaresStop: false })), "invalid");
  const done = accept(submitManifest(run, externalSubmission()));
  assert.equal(done.state.status, "delivered");
  assert.equal(done.state.worker?.kind === "external" && done.state.worker.registration.stop?.reason, "submitted");
  assert.deepEqual(done.events.map(e => e.type), ["worker-stopped", "manifest-frozen", "delivered"]);
  assert.deepEqual(taskRunViolations(done.state), []);
});

test("an external agent can abandon the round, a rejected manifest fails it, and an unavailable one waits", () => {
  const abandoned = accept(declareExternalStop(withExternalWorker(), { reason: "abandoned", sessionId: "sess-1", at: at() }));
  assert.equal(abandoned.state.status, "failed");
  assert.equal(abandoned.state.failure?.class, "agent-execution");
  rejected(declareExternalStop(withExternalWorker(), { reason: "abandoned", sessionId: "intruder", at: at() }), "forbidden");
  const refused = accept(submitManifest(withExternalWorker(), externalSubmission({ check: "rejected", items: undefined })));
  assert.equal(refused.state.failure?.class, "agent-output");
  assert.ok(refused.state.worker?.kind === "external" && refused.state.worker.registration.stop, "the stop declaration is recorded either way");
  const waiting = accept(submitManifest(withExternalWorker(), externalSubmission({ check: "unavailable", items: undefined }))).state;
  assert.equal(waiting.status, "running");
  assert.equal(waiting.blocked?.reason, "receipt-unavailable");
  assert.ok(waiting.worker?.kind === "external" && waiting.worker.registration.stop, "the agent already stopped, so nothing waits on it");
  assert.equal(accept(submitManifest(waiting, externalSubmission())).state.status, "delivered");
});

test("cancelling an external round waits for a stop declaration; a submission after the intent only stops it", () => {
  const cancelling = accept(requestCancel(withExternalWorker(), { at: at() })).state;
  assert.equal(cancelling.status, "running");
  assert.equal(cancelling.blocked?.reason, "awaiting-external-stop");
  const declared = accept(declareExternalStop(cancelling, { reason: "human", at: at() })).state;
  assert.equal(declared.status, "cancelled");
  assert.equal(declared.blocked, undefined);

  const lateSubmission = accept(submitManifest(cancelling, externalSubmission()));
  assert.equal(lateSubmission.state.status, "cancelled", "the stop declaration lets cancellation complete");
  assert.equal(lateSubmission.state.manifest, undefined, "the manifest is never frozen after the intent");
  assert.equal(lateSubmission.state.lateRecords.length, 1);
  assert.deepEqual(taskRunViolations(lateSubmission.state), []);
});

test("transcripts are imported for the registered session only, once, and may arrive after delivery", () => {
  const delivered = accept(submitManifest(withExternalWorker(), externalSubmission())).state;
  const imported = accept(importTranscript(delivered, { sessionId: "sess-1", ref: "blob:t1", digest, coverage: "partial", at: at() }));
  assert.equal(imported.state.status, "delivered");
  assert.ok(imported.state.worker?.kind === "external" && imported.state.worker.registration.transcripts.length === 1);
  const repeated = accept(importTranscript(imported.state, { sessionId: "sess-1", ref: "blob:t1", digest, coverage: "partial", at: at() }));
  assert.equal(repeated.state, imported.state, "importing the same digest again changes nothing");
  rejected(importTranscript(delivered, { sessionId: "other", ref: "blob:t1", digest, coverage: "full", at: at() }), "forbidden");
  rejected(importTranscript(withManagedWorker(), { sessionId: "s", ref: "r", digest, coverage: "full", at: at() }), "conflict", /external/);
  rejected(importTranscript(delivered, { sessionId: "sess-1", ref: "blob:t2", digest: "nope", coverage: "full", at: at() }), "invalid");
});

test("a caller-supplied manifest delivers a round that has no worker", () => {
  const done = accept(submitManifest(running("none"), { origin: "caller", operationId: "op-9", check: "accepted", at: at(), items, digest }));
  assert.equal(done.state.status, "delivered");
  assert.equal(done.state.worker, undefined);
});

test("manifest content is checked before it is frozen", () => {
  const stopped = apply(workerStopped(withManagedWorker(), { outcome: "succeeded", at: at() }));
  rejected(submitManifest(stopped, submission({ items: [] })), "invalid", /at least one/);
  rejected(submitManifest(stopped, submission({ items: [items[0], items[0]] })), "invalid", /unique/);
  rejected(submitManifest(stopped, submission({ items: [{ type: "candidate", id: "c", receipt: "" }] })), "invalid", /receipt/);
  rejected(submitManifest(stopped, submission({ digest: "bad" })), "invalid", /digest/);
  rejected(submitManifest(newRun(), submission()), "conflict", /not started/);
});

test("decisions advance the version once per change and leave no-ops untouched", () => {
  const run = newRun();
  const started = accept(start(run, { at: at() }));
  assert.equal(started.state.version, run.version + 1);
  const cancelling = accept(requestCancel(accept(registerManagedWorker(started.state, { executionId: "exec-1", at: at() })).state, { at: at() })).state;
  const noOp = accept(requestCancel(cancelling, { at: at() }));
  assert.equal(noOp.outcome, "already-requested");
  assert.deepEqual(noOp.events, []);
});

test("random command sequences never break an invariant or reopen a finished run", () => {
  const modes: WorkerMode[] = ["managed", "external", "none"];
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
    const mode = pick(modes);
    let run = accept(createTaskRun({ id: "run-x", taskRevision, workerMode: mode, retention: "keep", at: at() })).state;
    let finishedAs: string | undefined;
    for (let step = 0; step < 14; step++) {
      const sessionId = pick(["sess-1", "sess-1", "intruder"]);
      const commands: Array<() => Step> = [
        () => start(run, { at: at() }),
        () => registerManagedWorker(run, { executionId: "exec-1", at: at() }),
        () => registerExternalWorker(run, { sessionId: "sess-1", agent: { id: "agent" }, at: at() }),
        () => workerStopped(run, { outcome: pick(["succeeded", "failed"] as const), at: at() }),
        () => workerStopUnknown(run, { at: at() }),
        () => declareExternalStop(run, { reason: pick(["human", "abandoned"] as const), sessionId, at: at() }),
        () => submitManifest(run, mode === "external" ? externalSubmission({ check: pick(["accepted", "accepted", "rejected", "unavailable"] as const), sessionId }) : mode === "none" ? { origin: "caller", operationId: "op", check: pick(["accepted", "rejected", "unavailable"] as const), at: at(), items, digest } : submission({ check: pick(["accepted", "accepted", "rejected", "unavailable"] as const) })),
        () => concludeRound(run, { at: at() }),
        () => failInfrastructure(run, { detail: "boom", at: at() }),
        () => requestCancel(run, { at: at() }),
        () => block(run, { reason: "archive-blocked", at: at() }),
        () => unblock(run, { at: at() }),
        () => attachSandbox(run, { sandboxId: "sbx-1" }),
      ];
      const result = pick(commands)();
      if (!result.ok) continue;
      assert.ok(result.value.state.version >= run.version);
      run = result.value.state;
      assert.deepEqual(taskRunViolations(run), [], `seed ${seed}`);
      if (finishedAs) assert.equal(run.status, finishedAs, `seed ${seed}: a finished run stays ${finishedAs}`);
      else if (isTerminal(run)) finishedAs = run.status;
    }
  }
});

test("ids used in these tests are plain strings", () => { const id: Id = "x"; assert.equal(typeof id, "string"); });
