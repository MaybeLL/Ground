import assert from "node:assert/strict";
import { test } from "node:test";
import { addBranch, completeClose, continueWork, migrateWork, requestClose, selectHead, startWork, workConclusion, workViolations, type Id, type TaskRunStatus, type Work } from "../src/work/domain/index.js";
import { accept, clock, random, rejected } from "./work-fixtures.js";

const at = clock();
const started = (): Work => accept(startWork({ id: "work-1", taskDefinitionId: "task-1", firstRunId: "run-1", at: at() })).state;
const runs = (entries: Record<string, TaskRunStatus>): ReadonlyMap<Id, TaskRunStatus> => new Map(Object.entries(entries));
const check = (work: Work) => { assert.deepEqual(workViolations(work), []); return work; };

test("a work starts on its first run, which is the head", () => {
  const work = check(started());
  assert.equal(work.head, "run-1");
  assert.deepEqual(work.runIds, ["run-1"]);
  assert.deepEqual(work.headHistory.map(c => c.reason), ["start"]);
});

test("continuing refines the expected head and moves the head; a stale expectation loses", () => {
  const work = started();
  const moved = accept(continueWork(work, { newRunId: "run-2", expectedHead: "run-1", at: at() }));
  assert.equal(moved.state.head, "run-2");
  assert.deepEqual(moved.state.runIds, ["run-1", "run-2"]);
  assert.deepEqual(moved.events.map(e => e.type), ["run-added", "head-moved"]);
  check(moved.state);
  // Two callers saw run-1 as head; the second one finds it already moved.
  rejected(continueWork(moved.state, { newRunId: "run-3", expectedHead: "run-1", at: at() }), "conflict", /head is now run-2/);
  rejected(continueWork(moved.state, { newRunId: "run-2", expectedHead: "run-2", at: at() }), "conflict", /already belongs/);
});

test("a branch adds a run without moving the head", () => {
  const branched = accept(addBranch(started(), { newRunId: "run-b", at: at() })).state;
  assert.equal(branched.head, "run-1");
  assert.deepEqual(branched.runIds, ["run-1", "run-b"]);
  assert.equal(branched.headHistory.length, 1);
  rejected(addBranch(branched, { newRunId: "run-b", at: at() }), "conflict");
});

test("the head moves only by an explicit selection among this work's runs", () => {
  const work = accept(addBranch(started(), { newRunId: "run-b", at: at() })).state;
  const selected = accept(selectHead(work, { runId: "run-b", at: at() })).state;
  assert.equal(selected.head, "run-b");
  assert.equal(selected.headHistory[selected.headHistory.length - 1].reason, "select");
  assert.equal(accept(selectHead(selected, { runId: "run-b", at: at() })).state, selected, "selecting the current head changes nothing");
  rejected(selectHead(work, { runId: "elsewhere", at: at() }), "conflict", /does not belong/);
  rejected(selectHead(work, { runId: "run-b", expectedHead: "run-9", at: at() }), "conflict");
  check(selected);
});

test("a migrated work may lack a head until one is chosen, and is never given one by inference", () => {
  const ambiguous = accept(migrateWork({ id: "work-m", taskDefinitionId: "task-1", runIds: ["a", "b"], at: at() })).state;
  assert.equal(ambiguous.head, undefined);
  assert.deepEqual(workViolations(ambiguous), []);
  rejected(continueWork(ambiguous, { newRunId: "c", expectedHead: "a", at: at() }), "conflict", /no head yet/);
  const chosen = accept(selectHead(ambiguous, { runId: "b", at: at() })).state;
  assert.equal(chosen.head, "b");
  const single = accept(migrateWork({ id: "work-m2", taskDefinitionId: "task-1", runIds: ["a"], defaultHead: "a", at: at() })).state;
  assert.equal(single.headHistory[0].reason, "migration-default");
  rejected(migrateWork({ id: "w", taskDefinitionId: "t", runIds: ["a"], defaultHead: "z", at: at() }), "invalid");
  rejected(migrateWork({ id: "w", taskDefinitionId: "t", runIds: ["a", "a"], at: at() }), "invalid");
  assert.ok(workViolations({ ...started(), head: undefined, headHistory: [] }).length > 0, "a work that was not migrated must have a head");
});

test("closing closes the entrances first and finishes only when every run ended", () => {
  const work = accept(addBranch(started(), { newRunId: "run-b", at: at() })).state;
  const requested = accept(requestClose(work, { at: at() }, runs({ "run-1": "delivered", "run-b": "running" })));
  assert.equal(requested.state.status, "closing");
  assert.deepEqual(requested.outcome.blockedBy, ["run-b"]);
  rejected(continueWork(requested.state, { newRunId: "run-c", expectedHead: "run-1", at: at() }), "conflict", /closing/);
  rejected(addBranch(requested.state, { newRunId: "run-c", at: at() }), "conflict", /closing/);
  rejected(selectHead(requested.state, { runId: "run-b", at: at() }), "conflict", /closing/);
  rejected(completeClose(requested.state, { at: at(), conclusion: "accepted", releasesReserved: true }, runs({ "run-1": "delivered", "run-b": "running" })), "conflict", /still active/);
  const again = accept(requestClose(requested.state, { at: at() }, runs({ "run-1": "delivered", "run-b": "cancelled" })));
  assert.deepEqual(again.outcome.blockedBy, []);
  assert.equal(again.state, requested.state, "asking again changes nothing");
  rejected(completeClose(requested.state, { at: at(), conclusion: "accepted", releasesReserved: false }, runs({ "run-1": "delivered", "run-b": "cancelled" })), "conflict", /reserved/);
  const closed = accept(completeClose(requested.state, { at: at(), conclusion: "accepted", releasesReserved: true }, runs({ "run-1": "delivered", "run-b": "cancelled" }))).state;
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.closedFact && { head: closed.closedFact.head, conclusion: closed.closedFact.conclusion }, { head: "run-1", conclusion: "accepted" });
  check(closed);
  assert.equal(accept(requestClose(closed, { at: at() }, runs({}))).state, closed);
  assert.equal(accept(completeClose(closed, { at: at(), conclusion: "rejected", releasesReserved: true }, runs({}))).state, closed, "the closing fact is never rewritten");
  rejected(completeClose(work, { at: at(), conclusion: "accepted", releasesReserved: true }, runs({})), "conflict", /request the close/);
});

test("the conclusion is derived from the head run and covers every state", () => {
  const work = started();
  assert.equal(workConclusion({ head: undefined }, undefined, undefined), "head-unselected");
  assert.equal(workConclusion(work, "pending", undefined), "in-progress");
  assert.equal(workConclusion(work, "running", "accepted"), "in-progress");
  assert.equal(workConclusion(work, "failed", undefined), "failed");
  assert.equal(workConclusion(work, "cancelled", undefined), "cancelled");
  assert.equal(workConclusion(work, "delivered", undefined), "pending");
  assert.equal(workConclusion(work, "delivered", "rejected"), "rejected");
  assert.equal(workConclusion(work, "delivered", "accepted"), "accepted");
});

test("moving the head back to an accepted run changes the conclusion without touching any run", () => {
  let work = accept(continueWork(started(), { newRunId: "run-2", expectedHead: "run-1", at: at() })).state;
  const acceptance: Record<string, "accepted" | "rejected"> = { "run-1": "accepted", "run-2": "rejected" };
  assert.equal(workConclusion(work, "delivered", acceptance[work.head!]), "rejected");
  work = accept(selectHead(work, { runId: "run-1", at: at() })).state;
  assert.equal(workConclusion(work, "delivered", acceptance[work.head!]), "accepted");
});

test("random operations keep the head inside the work and never reopen a closed work", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
    let work = started();
    const status = new Map<Id, TaskRunStatus>([["run-1", "running"]]);
    let counter = 1;
    for (let step = 0; step < 20; step++) {
      const runId = `run-${++counter}`;
      const ids = [...status.keys()];
      const results = [
        () => continueWork(work, { newRunId: runId, expectedHead: pick([work.head ?? "none", pick(ids)]), at: at() }),
        () => addBranch(work, { newRunId: runId, at: at() }),
        () => selectHead(work, { runId: pick([...ids, "stranger"]), at: at() }),
        () => requestClose(work, { at: at() }, status),
        () => completeClose(work, { at: at(), conclusion: "pending", releasesReserved: next() > 0.2 }, status),
      ];
      const result = pick(results)();
      if (!result.ok) continue;
      const wasClosed = work.status === "closed";
      work = result.value.state;
      for (const event of result.value.events) if (event.type === "run-added") status.set(event.runId, "running");
      if (next() < 0.4) for (const id of ids) if (next() < 0.5) status.set(id, pick(["delivered", "failed", "cancelled"] as const));
      assert.deepEqual(workViolations(work), [], `seed ${seed}`);
      if (wasClosed) assert.equal(work.status, "closed", `seed ${seed}: closed stays closed`);
    }
  }
});

test("a migrated work may take a selected run as its head, which must be one of its runs", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const { state } = accept(migrateWork({ id: "w", taskDefinitionId: "t", runIds: ["a", "b"], defaultHead: "b", selected: { runId: "a", at }, at: "2026-02-01T00:00:00.000Z" }));
  assert.equal(state.head, "a");
  assert.deepEqual(state.headHistory, [{ runId: "a", reason: "migration-selection", at }]);
  assert.deepEqual(workViolations(state), []);
  rejected(migrateWork({ id: "w", taskDefinitionId: "t", runIds: ["a"], selected: { runId: "zzz", at }, at }), "invalid", /selected/);
});
