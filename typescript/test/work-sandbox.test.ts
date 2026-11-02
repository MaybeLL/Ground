import assert from "node:assert/strict";
import { test } from "node:test";
import {
  abandonReservation, acquireLease, applyTransfer, authorizeBridge, completeRelease, completeReservation, markBlocked, markReady, recordExternalUse, requestSandbox, reportStopUnknown,
  reserve, resumePreparation, returnLease, sandboxViolations, type Decision, type OccupantRef, type OwnerRef, type Result, type Sandbox, type SandboxEvent,
} from "../src/work/domain/index.js";
import { accept, clock, random, rejected } from "./work-fixtures.js";

const at = clock();
const owner: OwnerRef = { type: "task_run", id: "run-1" };
const agent = (id = "exec-1"): OccupantRef => ({ type: "agent_execution", id });
const workspace = { ref: "ws-1", origin: "own" as const };
const runtime = { instanceId: "inst-1", environmentRevisionId: "env-rev-1" };

type Step = Result<Decision<Sandbox, SandboxEvent>>;
const apply = (step: Step): Sandbox => { const d = accept(step); assert.deepEqual(sandboxViolations(d.state), []); return d.state; };

const preparing = (o: OwnerRef = owner, retention: "keep" | "release" = "keep") => apply(requestSandbox({ id: "sbx-1", owner: o, retention, at: at() }));
const ready = (o: OwnerRef = owner, retention: "keep" | "release" = "keep", ws = workspace) => apply(markReady(preparing(o, retention), { workspace: ws, runtime, at: at() }));
const op = (() => { let n = 0; return () => `op-${++n}`; })();

test("a sandbox is requested, prepared, and becomes ready with its workspace mounted", () => {
  const requested = preparing();
  assert.equal(requested.phase, "preparing");
  const done = apply(markReady(requested, { workspace, runtime, at: at() }));
  assert.equal(done.phase, "ready");
  assert.equal(done.mounted, true);
  assert.equal(done.runtime?.instanceId, "inst-1");
  rejected(markReady(done, { workspace, at: at() }), "conflict");
  assert.equal(apply(markReady(requested, { workspace, at: at() })).runtime, undefined, "a local-mode sandbox may have only a workspace");
  rejected(markReady(requested, { workspace: { ref: "", origin: "own" }, at: at() }), "invalid");
});

test("leases carry growing fencing tokens and the bridge honours only the current one", () => {
  let sandbox = apply(acquireLease(ready(), { holder: agent("exec-1"), at: at() }));
  assert.equal(sandbox.phase, "in_use");
  assert.equal(sandbox.lease?.token, 1);
  assert.ok(authorizeBridge(sandbox, { holder: agent("exec-1"), token: 1 }).ok);
  rejected(authorizeBridge(sandbox, { holder: agent("exec-1"), token: 2 }), "forbidden");
  rejected(authorizeBridge(sandbox, { holder: agent("exec-2"), token: 1 }), "forbidden");
  rejected(acquireLease(sandbox, { holder: agent("exec-2"), at: at() }), "conflict", /occupied/);
  rejected(returnLease(sandbox, { holder: agent("exec-1"), token: 1, stop: "declared" as "verified", at: at() }), "invalid", /verified/);
  rejected(returnLease(sandbox, { holder: agent("exec-1"), token: 9, stop: "verified", at: at() }), "forbidden");
  sandbox = apply(returnLease(sandbox, { holder: agent("exec-1"), token: 1, stop: "verified", at: at() }));
  assert.equal(sandbox.phase, "ready");
  rejected(authorizeBridge(sandbox, { holder: agent("exec-1"), token: 1 }), "conflict", /not occupied/);
  sandbox = apply(acquireLease(sandbox, { holder: { type: "command_step", gradingRecordId: "grade-1", ordinal: 0 }, at: at() }));
  assert.equal(sandbox.lease?.token, 2, "the next holder gets a higher token");
  rejected(authorizeBridge(sandbox, { holder: agent("exec-1"), token: 1 }), "forbidden");
});

test("an unknown stop keeps the sandbox occupied until it is verified", () => {
  let sandbox = apply(acquireLease(ready(), { holder: agent(), at: at() }));
  sandbox = apply(reportStopUnknown(sandbox, { holder: agent(), token: 1, at: at() }));
  assert.equal(sandbox.stopUnknown, true);
  for (const kind of ["pause", "release", "transfer"] as const)
    rejected(reserve(sandbox, { by: owner, operationId: op(), kind, receiver: "run-2", ownerTerminal: true, at: at() }), "conflict", /occupied or its stop is unknown/);
  sandbox = apply(returnLease(sandbox, { holder: agent(), token: 1, stop: "verified", at: at() }));
  assert.equal(sandbox.stopUnknown, false);
  accept(reserve(sandbox, { by: owner, operationId: op(), kind: "pause", at: at() }));
});

test("pause and resume are reserved, then completed", () => {
  const paused = apply(completeReservation(apply(reserve(ready(), { by: owner, operationId: "p1", kind: "pause", at: at() })), { operationId: "p1", at: at() }));
  assert.equal(paused.phase, "paused");
  assert.equal(paused.reservation, undefined);
  rejected(reserve(paused, { by: owner, operationId: op(), kind: "pause", at: at() }), "conflict", /ready/);
  rejected(acquireLease(paused, { holder: agent(), at: at() }), "conflict", /paused/);
  const resumed = apply(completeReservation(apply(reserve(paused, { by: owner, operationId: "r1", kind: "resume", at: at() })), { operationId: "r1", at: at() }));
  assert.equal(resumed.phase, "ready");
  rejected(reserve(resumed, { by: owner, operationId: op(), kind: "resume", at: at() }), "conflict", /paused/);
});

test("a reserved operation closes occupancy and excludes every competing operation", () => {
  const pausing = apply(reserve(ready(), { by: owner, operationId: "p1", kind: "pause", at: at() }));
  rejected(acquireLease(pausing, { holder: agent(), at: at() }), "conflict", /reserved/);
  rejected(reserve(pausing, { by: owner, operationId: "r1", kind: "release", at: at() }), "conflict", /pause is already reserved/);
  rejected(reserve(pausing, { by: owner, operationId: "t1", kind: "transfer", receiver: "run-2", ownerTerminal: true, at: at() }), "conflict", /already reserved/);
  rejected(reserve(pausing, { by: owner, operationId: "p2", kind: "pause", at: at() }), "conflict", /already reserved/);
  assert.equal(accept(reserve(pausing, { by: owner, operationId: "p1", kind: "pause", at: at() })).state, pausing, "repeating the same operation changes nothing");
  rejected(completeReservation(pausing, { operationId: "other", at: at() }), "conflict", /no such operation/);
  rejected(reserve(ready(), { by: { type: "task_run", id: "intruder" }, operationId: op(), kind: "pause", at: at() }), "forbidden");
});

test("release closes the entrance at once and finishes by recording what became of the workspace", () => {
  const releasing = apply(reserve(ready(), { by: owner, operationId: "rel", kind: "release", at: at() }));
  assert.equal(releasing.phase, "releasing");
  rejected(acquireLease(releasing, { holder: agent(), at: at() }), "conflict");
  rejected(abandonReservation(releasing, { operationId: "rel", at: at() }), "conflict", /finished, not abandoned/);
  rejected(completeRelease(releasing, { operationId: "rel", workspace: "returned", at: at() }), "conflict", /only a borrowed/);
  rejected(completeRelease(releasing, { operationId: "other", workspace: "retained", at: at() }), "conflict", /no such release/);
  const released = apply(completeRelease(releasing, { operationId: "rel", workspace: "retained", at: at() }));
  assert.equal(released.phase, "released");
  assert.equal(released.mounted, false);
  assert.equal(released.workspaceDisposition, "retained");
  assert.equal(accept(completeRelease(released, { operationId: "rel", workspace: "retained", at: at() })).state, released, "completing twice is harmless");
  rejected(reserve(released, { by: owner, operationId: op(), kind: "pause", at: at() }), "conflict", /released/);
});

test("a borrowed workspace is returned and never removed", () => {
  const borrowed = ready(owner, "release", { ref: "ws-b", origin: "borrowed" });
  const releasing = apply(reserve(borrowed, { by: owner, operationId: "rel", kind: "release", at: at() }));
  rejected(completeRelease(releasing, { operationId: "rel", workspace: "removed", at: at() }), "conflict", /borrowed/);
  rejected(completeRelease(releasing, { operationId: "rel", workspace: "retained", at: at() }), "conflict", /borrowed/);
  assert.equal(apply(completeRelease(releasing, { operationId: "rel", workspace: "returned", at: at() })).workspaceDisposition, "returned");
});

test("an occupied sandbox cannot be released, and a blocked one can", () => {
  rejected(reserve(apply(acquireLease(ready(), { holder: agent(), at: at() })), { by: owner, operationId: "rel", kind: "release", at: at() }), "conflict");
  const blocked = apply(markBlocked(preparing(), { reason: "image pull failed", workspace, at: at() }));
  assert.equal(blocked.workspace?.ref, "ws-1", "the already prepared workspace is kept");
  const releasing = apply(reserve(blocked, { by: owner, operationId: "rel", kind: "release", at: at() }));
  assert.equal(apply(completeRelease(releasing, { operationId: "rel", workspace: "retained", at: at() })).phase, "released");
});

test("only the owner resumes a blocked preparation", () => {
  const blocked = apply(markBlocked(preparing(), { reason: "network", at: at() }));
  rejected(resumePreparation(blocked, { by: { type: "task_run", id: "other" }, at: at() }), "forbidden");
  const again = apply(resumePreparation(blocked, { by: owner, at: at() }));
  assert.equal(again.phase, "preparing");
  assert.equal(again.blockedReason, undefined);
  rejected(resumePreparation(again, { by: owner, at: at() }), "conflict");
  rejected(markBlocked(ready(), { reason: "x", at: at() }), "conflict");
});

test("a transfer hands a kept sandbox to the refining run in three steps", () => {
  const paused = apply(completeReservation(apply(reserve(ready(), { by: owner, operationId: "p1", kind: "pause", at: at() })), { operationId: "p1", at: at() }));
  const reserved = apply(reserve(paused, { by: owner, operationId: "t1", kind: "transfer", receiver: "run-2", ownerTerminal: true, at: at() }));
  assert.equal(reserved.owner.id, "run-1", "reserving does not change the owner");
  rejected(completeReservation(reserved, { operationId: "t1", at: at() }), "conflict", /owner has not been changed/);
  const moved = apply(applyTransfer(reserved, { operationId: "t1", retention: "keep", at: at() }));
  assert.equal(moved.owner.id, "run-2");
  assert.equal(moved.transfers.length, 1);
  assert.equal(accept(applyTransfer(moved, { operationId: "t1", retention: "keep", at: at() })).state, moved, "repeating after a crash changes nothing");
  rejected(abandonReservation(moved, { operationId: "t1", at: at() }), "conflict", /owner already changed/);
  const done = apply(completeReservation(moved, { operationId: "t1", at: at() }));
  assert.equal(done.phase, "ready", "a paused sandbox is resumed for the new owner");
  assert.equal(done.reservation, undefined);
  rejected(reserve(done, { by: owner, operationId: op(), kind: "pause", at: at() }), "forbidden", undefined);
  accept(reserve(done, { by: { type: "task_run", id: "run-2" }, operationId: op(), kind: "pause", at: at() }));
});

test("a transfer from a blocked sandbox continues its preparation for the new owner", () => {
  const blocked = apply(markBlocked(preparing(), { reason: "network", workspace, at: at() }));
  const reserved = apply(reserve(blocked, { by: owner, operationId: "t1", kind: "transfer", receiver: "run-2", ownerTerminal: true, at: at() }));
  const done = apply(completeReservation(apply(applyTransfer(reserved, { operationId: "t1", retention: "release", at: at() })), { operationId: "t1", at: at() }));
  assert.equal(done.phase, "preparing");
  assert.equal(done.retention, "release", "the receiving run's retention applies from now on");
});

test("a transfer is refused unless every condition holds", () => {
  const base = { by: owner, operationId: "t1", kind: "transfer" as const, receiver: "run-2", ownerTerminal: true, at: at() };
  rejected(reserve(ready(), { ...base, ownerTerminal: false }), "conflict", /not finished/);
  rejected(reserve(ready(owner, "release"), base), "conflict", /not kept/);
  rejected(reserve(ready(), { ...base, receiver: "run-1" }), "invalid");
  rejected(reserve(ready(), { ...base, receiver: undefined }), "invalid");
  rejected(reserve(ready({ type: "grading_record", id: "grade-1" }), { ...base, by: { type: "grading_record", id: "grade-1" } }), "conflict", /task sandbox/);
  const external = apply(recordExternalUse(ready(), { at: at() }));
  rejected(reserve(external, base), "conflict", /external agent/);
  accept(reserve(external, { ...base, kind: "release" }));
  accept(reserve(ready(), base));
});

test("an abandoned pause or transfer leaves the sandbox as it was", () => {
  const reserved = apply(reserve(ready(), { by: owner, operationId: "t1", kind: "transfer", receiver: "run-2", ownerTerminal: true, at: at() }));
  const abandoned = apply(abandonReservation(reserved, { operationId: "t1", at: at() }));
  assert.equal(abandoned.reservation, undefined);
  assert.equal(abandoned.owner.id, "run-1");
  assert.equal(accept(abandonReservation(abandoned, { operationId: "t1", at: at() })).state, abandoned);
});

test("random operations keep every sandbox invariant", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
    let sandbox = preparing(owner, pick(["keep", "release"] as const));
    let issued = 0;
    for (let step = 0; step < 25; step++) {
      const current = sandbox;
      const holder = pick([agent("e1"), agent("e2")]);
      const by = pick([owner, owner, { type: "task_run" as const, id: "run-2" }]);
      const operationId = pick(["o1", "o2", "o3"]);
      const commands: Array<() => Step> = [
        () => markReady(current, { workspace: pick([workspace, { ref: "ws-b", origin: "borrowed" as const }]), at: at() }),
        () => markBlocked(current, { reason: "x", at: at() }),
        () => resumePreparation(current, { by, at: at() }),
        () => acquireLease(current, { holder, at: at() }),
        () => returnLease(current, { holder, token: pick([current.lease?.token ?? 0, 99]), stop: "verified", at: at() }),
        () => reportStopUnknown(current, { holder, token: current.lease?.token ?? 0, at: at() }),
        () => recordExternalUse(current, { at: at() }),
        () => reserve(current, { by, operationId, kind: pick(["pause", "resume", "release", "transfer"] as const), receiver: "run-2", ownerTerminal: next() > 0.3, at: at() }),
        () => applyTransfer(current, { operationId, retention: pick(["keep", "release"] as const), at: at() }),
        () => completeReservation(current, { operationId, at: at() }),
        () => abandonReservation(current, { operationId, at: at() }),
        () => completeRelease(current, { operationId, workspace: pick(["retained", "removed", "returned"] as const), at: at() }),
      ];
      const result = pick(commands)();
      if (!result.ok) continue;
      sandbox = result.value.state;
      assert.deepEqual(sandboxViolations(sandbox), [], `seed ${seed}`);
      assert.ok(sandbox.lastToken >= issued, `seed ${seed}: tokens never go back`);
      issued = sandbox.lastToken;
      if (current.phase === "released") assert.equal(sandbox.phase, "released", `seed ${seed}: released is final`);
    }
  }
});
