import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptExecution, beginExecution, blockArchive, claimRunner, confirmExecutionStopped, executionHostLost, executionViolations, interruptExecution, isExecutionTerminal, prepareExecution, providerEnded,
  recordCommandObservation, recordProtocolStage, recordReceipt, releaseRunner, reportExecutionStopUnknown, requestExecutionCancel, resumeExecution, retryArchive,
  type AgentExecution, type Capabilities, type Decision, type ExecutionEvent, type Result, type RevisionRef,
} from "../src/work/domain/index.js";
import { accept, clock, random, rejected } from "./work-fixtures.js";

const at = clock();
const agentRevision: RevisionRef = { kind: "agent", definitionId: "agent-1", revisionId: "agent-rev-1", seq: 1, digest: `sha256:${"3".repeat(64)}` };
const strong: Capabilities = { resume: false, verifiableStop: true, events: "full" };
const digest = (c: string) => `sha256:${c.repeat(64)}`;

type Step = Result<Decision<AgentExecution, ExecutionEvent, string>>;
const apply = (step: Step): AgentExecution => { const d = accept(step); assert.deepEqual(executionViolations(d.state), []); return d.state; };

const worker = (capabilities: Capabilities = strong) => accept(acceptExecution({ id: "exec-1", owner: { type: "task_run", id: "run-1" }, role: "worker", agentRevision, capabilities, at: at() })).state;
const evaluator = () => accept(acceptExecution({ id: "exec-e", owner: { type: "grading_record", id: "grade-1" }, role: "evaluator", agentRevision, capabilities: strong, at: at() })).state;
function running(capabilities: Capabilities = strong, base = worker(capabilities)): AgentExecution {
  let e = apply(prepareExecution(base, { sandboxId: "sbx-1", at: at() }));
  e = apply(claimRunner(e, { runnerId: "host-1", at: at() }));
  return apply(beginExecution(e, { runnerId: "host-1", sessionRef: "session-1", at: at() }));
}

test("a worker belongs to a task run and an evaluator to a grading record", () => {
  assert.equal(worker().stage, "accepted");
  assert.equal(worker().stop, "idle");
  rejected(acceptExecution({ id: "x", owner: { type: "grading_record", id: "g" }, role: "worker", agentRevision, capabilities: strong, at: at() }), "invalid");
  rejected(acceptExecution({ id: "x", owner: { type: "task_run", id: "r" }, role: "evaluator", agentRevision, capabilities: strong, at: at() }), "invalid");
  rejected(acceptExecution({ id: "x", owner: { type: "task_run", id: "r" }, role: "worker", agentRevision: { ...agentRevision, kind: "grader" }, capabilities: strong, at: at() }), "invalid");
});

test("an execution succeeds only after both receipts are archived and the stop is verified, in any order", () => {
  let e = apply(providerEnded(running(), { outcome: "succeeded", at: at() }));
  assert.equal(e.stage, "archiving", "the provider returning is not the end");
  e = apply(recordReceipt(e, { kind: "output", ref: "blob:out", at: at() }));
  assert.equal(e.stage, "archiving");
  e = apply(recordReceipt(e, { kind: "trajectory", ref: "blob:traj", at: at() }));
  assert.equal(e.stage, "archiving", "still waiting for the stop to be confirmed");
  const done = accept(confirmExecutionStopped(e, { at: at() }));
  assert.equal(done.state.stage, "succeeded");
  assert.ok(done.state.terminalAt);
  assert.equal(done.state.runner, undefined);
  assert.deepEqual(executionViolations(done.state), []);

  // stop first, then receipts
  let other = apply(confirmExecutionStopped(apply(providerEnded(running(), { outcome: "succeeded", at: at() })), { at: at() }));
  assert.equal(other.stage, "archiving");
  other = apply(recordReceipt(other, { kind: "output", ref: "blob:out", at: at() }));
  assert.equal(accept(recordReceipt(other, { kind: "trajectory", ref: "blob:traj", at: at() })).state.stage, "succeeded");
});

test("a failed provider ends the execution once its stop is verified, keeping whatever was archived", () => {
  const ended = apply(providerEnded(running(), { outcome: "failed", at: at() }));
  assert.equal(ended.stage, "archiving");
  const recorded = apply(recordReceipt(ended, { kind: "trajectory", ref: "blob:traj", at: at() }));
  const failed = accept(confirmExecutionStopped(recorded, { at: at() }));
  assert.equal(failed.state.stage, "failed");
  assert.equal(failed.state.receipts.trajectory, "blob:traj");
});

test("a blocked archive retries only the archive, never the model", () => {
  let e = apply(confirmExecutionStopped(apply(providerEnded(running(), { outcome: "succeeded", at: at() })), { at: at() }));
  e = apply(recordReceipt(e, { kind: "output", ref: "blob:out", at: at() }));
  const blocked = apply(blockArchive(e, { reason: "object store unreachable", at: at() }));
  assert.equal(blocked.stage, "archive_blocked");
  rejected(beginExecution(blocked, { runnerId: "host-1", at: at() }), "conflict");
  rejected(providerEnded(blocked, { outcome: "failed", at: at() }), "conflict", /already recorded/);
  assert.equal(accept(providerEnded(blocked, { outcome: "succeeded", at: at() })).state, blocked);
  const retried = apply(retryArchive(blocked, { at: at() }));
  assert.equal(retried.stage, "archiving");
  const done = accept(recordReceipt(retried, { kind: "trajectory", ref: "blob:traj", at: at() }));
  assert.equal(done.state.stage, "succeeded");
  const viaReceipt = accept(recordReceipt(blocked, { kind: "trajectory", ref: "blob:traj", at: at() }));
  assert.equal(viaReceipt.state.stage, "succeeded", "a receipt arriving while blocked unblocks and completes");
  rejected(blockArchive(running(), { reason: "x", at: at() }), "conflict");
  rejected(recordReceipt(worker(), { kind: "output", ref: "r", at: at() }), "conflict", /nothing can be archived/);
});

test("a receipt is recorded once; a different one for the same kind is a conflict", () => {
  const e = apply(recordReceipt(apply(providerEnded(running(), { outcome: "succeeded", at: at() })), { kind: "output", ref: "blob:out", at: at() }));
  assert.equal(accept(recordReceipt(e, { kind: "output", ref: "blob:out", at: at() })).state, e);
  rejected(recordReceipt(e, { kind: "output", ref: "blob:other", at: at() }), "conflict", /already recorded/);
});

test("exactly one runner drives an execution; epochs grow", () => {
  let e = apply(prepareExecution(worker(), { sandboxId: "sbx-1", at: at() }));
  rejected(claimRunner(worker(), { runnerId: "host-1", at: at() }), "conflict", /prepare/);
  e = apply(claimRunner(e, { runnerId: "host-1", at: at() }));
  assert.equal(e.runner?.epoch, 1);
  assert.equal(accept(claimRunner(e, { runnerId: "host-1", at: at() })).state, e);
  rejected(claimRunner(e, { runnerId: "host-2", at: at() }), "conflict", /another runner/);
  rejected(beginExecution(e, { runnerId: "host-2", at: at() }), "conflict", /holding/);
  e = apply(releaseRunner(e, { runnerId: "host-1", at: at() }));
  e = apply(claimRunner(e, { runnerId: "host-2", at: at() }));
  assert.equal(e.runner?.epoch, 2);
  assert.equal(accept(releaseRunner(e, { runnerId: "host-1", at: at() })).state, e, "releasing someone else's claim does nothing");
});

test("after a host loss a resumable provider continues the same execution once its stop is verified", () => {
  const resumable: Capabilities = { resume: true, verifiableStop: true, events: "partial" };
  let e = apply(executionHostLost(running(resumable), { at: at() }));
  assert.equal(e.runner, undefined);
  assert.equal(e.stop, "unknown");
  rejected(resumeExecution(e, { runnerId: "host-2", at: at() }), "conflict", /confirmed stopped/);
  rejected(interruptExecution(e, { at: at() }), "conflict", /can resume/);
  e = apply(confirmExecutionStopped(e, { at: at() }));
  const resumed = apply(resumeExecution(e, { runnerId: "host-2", at: at() }));
  assert.equal(resumed.id, "exec-1", "the identity is kept");
  assert.equal(resumed.stage, "running");
  assert.equal(resumed.stop, "active");
  assert.equal(resumed.runner?.epoch, 2);
  rejected(resumeExecution(resumed, { runnerId: "host-3", at: at() }), "conflict", /another runner/);
});

test("a provider that cannot resume ends interrupted after the lost process is confirmed stopped", () => {
  let e = apply(executionHostLost(running(), { at: at() }));
  rejected(resumeExecution(e, { runnerId: "host-2", at: at() }), "unsupported", /cannot resume/);
  rejected(interruptExecution(e, { at: at() }), "conflict", /confirmed stopped/);
  e = apply(confirmExecutionStopped(e, { at: at() }));
  const done = accept(interruptExecution(e, { at: at() }));
  assert.equal(done.state.stage, "interrupted");
  assert.equal(accept(interruptExecution(done.state, { at: at() })).outcome, "already-terminal");
  rejected(interruptExecution(running(), { at: at() }), "conflict", /runner still drives/);
});

test("a stop can be verified only by a provider that can verify it, and an unknown stop is reported, not assumed", () => {
  rejected(confirmExecutionStopped(running({ resume: false, verifiableStop: false, events: "none" }), { at: at() }), "unsupported");
  rejected(confirmExecutionStopped(worker(), { at: at() }), "conflict", /never started/);
  const unknown = apply(reportExecutionStopUnknown(running(), { at: at() }));
  assert.equal(unknown.stop, "unknown");
  rejected(reportExecutionStopUnknown(worker(), { at: at() }), "conflict");
});

test("cancelling waits for a verified stop unless nothing ever ran", () => {
  const idle = accept(requestExecutionCancel(worker(), { at: at() }));
  assert.equal(idle.state.stage, "cancelled");
  const cancelling = apply(requestExecutionCancel(running(), { at: at() }));
  assert.equal(cancelling.stage, "running");
  assert.equal(cancelling.stop, "requested");
  assert.equal(accept(providerEnded(cancelling, { outcome: "succeeded", at: at() })).state.stage, "archiving", "a provider that returns anyway is still being stopped");
  const done = accept(confirmExecutionStopped(cancelling, { at: at() }));
  assert.equal(done.state.stage, "cancelled");
  assert.deepEqual(executionViolations(done.state), []);
  assert.equal(accept(requestExecutionCancel(done.state, { at: at() })).outcome, "already-terminal");
  rejected(prepareExecution(apply(requestExecutionCancel(worker(), { at: at() })), { sandboxId: "s", at: at() }), "conflict");
});

test("a finished execution never changes; later arrivals are kept as history", () => {
  const done = accept(confirmExecutionStopped(apply(recordReceipt(apply(recordReceipt(apply(providerEnded(running(), { outcome: "succeeded", at: at() })), { kind: "output", ref: "o", at: at() })), { kind: "trajectory", ref: "t", at: at() })), { at: at() })).state;
  assert.equal(done.stage, "succeeded");
  const lateReceipt = accept(recordReceipt(done, { kind: "delivery-claim", ref: "claim", at: at() }));
  assert.equal(lateReceipt.outcome, "late");
  assert.equal(lateReceipt.state.stage, "succeeded");
  assert.equal(lateReceipt.state.receipts.deliveryClaim, undefined);
  assert.equal(lateReceipt.state.lateRecords.length, 1);
  assert.equal(accept(providerEnded(done, { outcome: "failed", at: at() })).outcome, "late");
  assert.equal(accept(confirmExecutionStopped(done, { at: at() })).outcome, "late");
});

test("an evaluator follows blind, freeze, reconcile, hand-off, submit; the blind result cannot change once frozen", () => {
  let e = running(strong, evaluator());
  rejected(recordProtocolStage(e, { stage: "reconcile", at: at() }), "conflict", /does not follow/);
  rejected(recordProtocolStage(e, { stage: "freeze", blindDigest: digest("a"), at: at() }), "conflict", /does not follow/);
  e = apply(recordProtocolStage(e, { stage: "blind", at: at() }));
  rejected(recordProtocolStage(e, { stage: "blind", at: at() }), "conflict", /already recorded/);
  rejected(recordProtocolStage(e, { stage: "freeze", at: at() }), "invalid", /digest/);
  e = apply(recordProtocolStage(e, { stage: "freeze", blindDigest: digest("a"), at: at() }));
  rejected(recordProtocolStage(e, { stage: "reconcile", blindDigest: digest("b"), at: at() }), "conflict", /cannot change/);
  e = apply(recordProtocolStage(e, { stage: "reconcile", blindDigest: digest("a"), at: at() }));
  e = apply(recordProtocolStage(e, { stage: "handoff", at: at() }));
  e = apply(recordProtocolStage(e, { stage: "submit", at: at() }));
  assert.deepEqual(e.protocol.map(r => r.stage), ["blind", "freeze", "reconcile", "handoff", "submit"]);
  rejected(recordProtocolStage(running(), { stage: "blind", at: at() }), "conflict", /only an evaluator/);
});

test("observed commands are appended and belong to evaluators", () => {
  const e = apply(recordCommandObservation(running(strong, evaluator()), { stage: "blind", entry: "grounds verification run", argvDigest: digest("c"), state: "succeeded", exitCode: 0, at: at() }));
  assert.equal(e.commandObservations.length, 1);
  rejected(recordCommandObservation(running(), { stage: "blind", entry: "x", argvDigest: digest("c"), state: "failed", at: at() }), "conflict", /only an evaluator/);
  rejected(recordCommandObservation(e, { stage: "blind", entry: "x", argvDigest: "bad", state: "failed", at: at() }), "invalid");
});

test("random sequences keep every execution invariant and never leave a terminal stage", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
    const capabilities: Capabilities = pick([strong, { resume: true, verifiableStop: true, events: "partial" as const }, { resume: false, verifiableStop: false, events: "none" as const }]);
    let e = pick([worker(capabilities), accept(acceptExecution({ id: "exec-e", owner: { type: "grading_record", id: "g" }, role: "evaluator", agentRevision, capabilities, at: at() })).state]);
    let finished: string | undefined;
    for (let step = 0; step < 25; step++) {
      const runnerId = pick(["host-1", "host-2"]);
      const commands: Array<() => Step> = [
        () => prepareExecution(e, { sandboxId: "sbx-1", at: at() }),
        () => claimRunner(e, { runnerId, at: at() }),
        () => releaseRunner(e, { runnerId, at: at() }),
        () => beginExecution(e, { runnerId, at: at() }),
        () => providerEnded(e, { outcome: pick(["succeeded", "failed"] as const), at: at() }),
        () => recordReceipt(e, { kind: pick(["output", "trajectory", "delivery-claim"] as const), ref: pick(["r1", "r1", "r2"]), at: at() }),
        () => blockArchive(e, { reason: "x", at: at() }),
        () => retryArchive(e, { at: at() }),
        () => confirmExecutionStopped(e, { at: at() }),
        () => reportExecutionStopUnknown(e, { at: at() }),
        () => executionHostLost(e, { at: at() }),
        () => resumeExecution(e, { runnerId, at: at() }),
        () => interruptExecution(e, { at: at() }),
        () => requestExecutionCancel(e, { at: at() }),
        () => recordProtocolStage(e, { stage: pick([...["blind", "freeze", "reconcile", "handoff", "submit"] as const]), blindDigest: digest("a"), at: at() }),
      ];
      const result = pick(commands)();
      if (!result.ok) continue;
      e = result.value.state;
      assert.deepEqual(executionViolations(e), [], `seed ${seed}`);
      if (finished) assert.equal(e.stage, finished, `seed ${seed}`);
      else if (isExecutionTerminal(e)) finished = e.stage;
    }
  }
});
