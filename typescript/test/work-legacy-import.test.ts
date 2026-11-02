import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptanceOf, createTaskRun, gradingViolations, importLegacyGate, importLegacyTaskRun, requestCancel, taskRunViolations,
  type GateBinding, type GradingRecord, type RevisionRef, type TaskRun,
} from "../src/work/domain/index.js";
import { accept, rejected } from "./work-fixtures.js";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const taskRevision: RevisionRef = { kind: "task", definitionId: "issue-1", revisionId: "issue-rev-1", seq: 1, digest: d("1") };
const graderRevision: RevisionRef = { kind: "grader", definitionId: "builtin-verification", revisionId: "builtin-verification-rev-1", seq: 1, digest: d("2") };
const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const delivered = { type: "delivered" as const, items: [{ type: "candidate" as const, id: "cand-1", receipt: "legacy:candidate:cand-1" }], digest: d("3"), operationId: "op-1", at: T(10) };

test("a submitted legacy run is taken over as delivered by its caller, with its history intact", () => {
  const { state, events } = accept(importLegacyTaskRun({ id: "run-1", taskRevision, createdAt: T(1), migratedAt: T(100), outcome: delivered }));
  assert.equal(state.status, "delivered");
  assert.equal(state.workerMode, "none");
  assert.equal(state.manifest?.origin, "caller");
  assert.equal(state.manifest?.frozenAt, T(10));
  assert.equal(state.createdAt, T(1));
  assert.equal(state.terminalAt, T(10));
  assert.deepEqual(state.migrated, { source: "dev-run", at: T(100) });
  assert.equal(state.version, 1, "a stored import starts at version 1");
  assert.deepEqual(taskRunViolations(state), []);
  assert.deepEqual(events.map(e => e.type), ["created", "started", "manifest-frozen", "delivered", "migrated"]);
});

test("an abandoned or still-open legacy run is taken over as cancelled and says why", () => {
  for (const reason of ["abandoned", "migration: still open at the cutover"]) {
    const { state, events } = accept(importLegacyTaskRun({ id: "run-2", taskRevision, createdAt: T(1), migratedAt: T(100), outcome: { type: "cancelled", reason, at: T(20) } }));
    assert.equal(state.status, "cancelled");
    assert.equal(state.cancelIntent?.reason, reason);
    assert.equal(state.terminalAt, T(20));
    assert.equal(state.manifest, undefined);
    assert.deepEqual(taskRunViolations(state), []);
    assert.deepEqual(events.map(e => e.type), ["created", "cancel-requested", "cancelled", "migrated"]);
  }
});

test("a legacy refinement is only taken over after the run it refines is finished and in the same work", () => {
  const first = accept(importLegacyTaskRun({ id: "run-1", workId: "work-1", taskRevision, createdAt: T(1), migratedAt: T(100), outcome: delivered })).state;
  const facts = { refines: { id: first.id, status: first.status, taskDefinitionId: first.taskRevision.definitionId, workId: first.workId } };
  const next = accept(importLegacyTaskRun({ id: "run-2", workId: "work-1", refines: "run-1", taskRevision, createdAt: T(30), migratedAt: T(100), outcome: { type: "cancelled", reason: "abandoned", at: T(31) } }, facts)).state;
  assert.equal(next.refines, "run-1");
  rejected(importLegacyTaskRun({ id: "run-3", workId: "work-1", refines: "run-1", taskRevision, createdAt: T(30), migratedAt: T(100), outcome: delivered }), "invalid", /not supplied/);
  rejected(importLegacyTaskRun({ id: "run-3", workId: "work-9", refines: "run-1", taskRevision, createdAt: T(30), migratedAt: T(100), outcome: delivered }, facts), "conflict", /same work/);
  rejected(importLegacyTaskRun({ id: "run-3", taskRevision, createdAt: T(30), migratedAt: T(100), outcome: { ...delivered, items: [] } }), "invalid", /at least one/);
});

test("a cancel reason is optional, bounded, and only recorded by the first request", () => {
  const run: TaskRun = accept(createTaskRun({ id: "run-9", taskRevision, workerMode: "none", retention: "keep", at: T(1) })).state;
  rejected(requestCancel(run, { at: T(2), reason: "" }), "invalid");
  const cancelled = accept(requestCancel(run, { at: T(2), reason: "no longer needed" })).state;
  assert.equal(cancelled.cancelIntent?.reason, "no longer needed");
  assert.equal(accept(requestCancel(cancelled, { at: T(3), reason: "other" })).outcome, "already-terminal");
});

const binding: GateBinding = { taskRevision, criteriaDigest: d("4"), manifestDigest: d("3"), graderRevision, materialsDigest: d("5"), expectedCriteria: ["crit-1", "crit-2"] };
const grade = { form: "criteria" as const, items: [
  { criterionId: "crit-1", independent: "satisfied" as const, reconciliation: "corroborated" as const, final: "satisfied" as const, rationale: "checked", evidence: ["go test: exit 0"] },
  { criterionId: "crit-2", independent: "unsatisfied" as const, reconciliation: "contradicted" as const, final: "unsatisfied" as const, rationale: "missing", evidence: [] },
] };
const gate = (over: { sessionId?: string; agentId?: string; protocol?: GradingRecord["evaluator"] } = {}) => importLegacyGate({
  id: "ver-1", requestSeq: 1, taskRunId: "run-1", target: { type: "candidate", id: "cand-1", digest: d("6") }, graderRevision, binding, materials: [{ id: "ver-1", digest: d("7") }],
  evaluator: { ...(over.sessionId ? { sessionId: over.sessionId } : {}), ...(over.agentId ? { agentId: over.agentId } : {}),
    protocol: [{ stage: "blind", at: T(40) }, { stage: "freeze", at: T(41), blindDigest: d("8") }, { stage: "submit", at: T(45) }],
    commandObservations: [{ stage: "blind", entry: "candidate-context", argvDigest: d("9"), state: "succeeded", exitCode: 0, at: T(40) }] },
  grade, createdAt: T(39), completedAt: T(46),
});

test("a legacy verification is taken over as a completed gate with a migrated external evaluator and its protocol facts", () => {
  const { state, events } = accept(gate({ sessionId: "review-session-1", agentId: "reviewer" }));
  assert.equal(state.purpose, "gate");
  assert.equal(state.status, "completed");
  assert.equal(state.terminalAt, T(46));
  assert.deepEqual(state.origin, { type: "gate", taskRunId: "run-1" });
  assert.equal(state.evaluator?.kind, "external");
  if (state.evaluator?.kind === "external") {
    assert.equal(state.evaluator.migrated, true);
    assert.equal(state.evaluator.sessionId, "review-session-1");
    assert.deepEqual(state.evaluator.protocol?.map(r => r.stage), ["blind", "freeze", "submit"]);
    assert.equal(state.evaluator.protocol?.[1].blindDigest, d("8"));
    assert.equal(state.evaluator.commandObservations?.length, 1);
  }
  assert.deepEqual(gradingViolations(state), []);
  assert.deepEqual(events.map(e => e.type), ["created", "evaluator-registered", "completed"]);
});

test("a legacy verification without a kept session is not given an invented one", () => {
  const { state } = accept(gate());
  assert.equal(state.evaluator?.kind === "external" && state.evaluator.sessionId, undefined);
  assert.equal(state.evaluator?.kind === "external" && state.evaluator.migrated, true);
  assert.deepEqual(gradingViolations(state), []);
  // The same record without the marker would be refused: an identity-less evaluator is only legitimate when migrated.
  const unmarked = { ...state, evaluator: { kind: "external" as const } } as GradingRecord;
  assert.match(gradingViolations(unmarked).join(";"), /session and an agent identity/);
});

test("an imported gate still counts for acceptance exactly like a native one", () => {
  const imported = accept(gate({ sessionId: "s", agentId: "a" })).state;
  const acceptance = acceptanceOf([imported], { taskRevisionId: taskRevision.revisionId, criteriaDigest: binding.criteriaDigest, manifestDigest: binding.manifestDigest });
  assert.equal(acceptance.adopted, "ver-1");
  assert.equal(acceptance.conclusion, "rejected", "one criterion is unsatisfied");
});

test("an imported gate must judge exactly the criteria it was bound to", () => {
  const partial = { form: "criteria" as const, items: [grade.items[0]] };
  rejected(importLegacyGate({ id: "ver-2", requestSeq: 2, taskRunId: "run-1", target: { type: "candidate", id: "cand-1", digest: d("6") }, graderRevision, binding, materials: [],
    evaluator: { protocol: [], commandObservations: [] }, grade: partial, createdAt: T(1), completedAt: T(2) }), "invalid", /exactly the expected criteria/);
  rejected(importLegacyGate({ id: "ver-2", requestSeq: 2, taskRunId: "run-1", target: { type: "candidate", id: "cand-1", digest: d("6") }, graderRevision, binding, materials: [],
    evaluator: { protocol: [{ stage: "blind", at: "not a time" }], commandObservations: [] }, grade, createdAt: T(1), completedAt: T(2) }), "invalid", /protocol/);
});
