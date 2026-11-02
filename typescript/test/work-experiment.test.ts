import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adoptGrading, completeness, createGrading, deriveRequestId, experimentViolations, faultGrader, gradingNotStarted, integrityOf, isExecutionError, launchExperimentRun, materialsFingerprint,
  mayStartMember, requestExperimentCancel, requestGradingCancel, reproducible, submitGrade, type ExperimentRun, type GradingRecord, type RevisionRef, type SlotIdentity,
} from "../src/work/domain/index.js";
import { accept, clock, hash, rejected } from "./work-fixtures.js";

const at = clock();
const d = (c: string) => `sha256:${c.repeat(64)}`;
const suite: RevisionRef = { kind: "suite", definitionId: "suite-1", revisionId: "suite-rev-1", seq: 1, digest: d("a") };
const agent: RevisionRef = { kind: "agent", definitionId: "agent-1", revisionId: "agent-rev-1", seq: 1, digest: d("b") };
const launch = (over: Partial<Parameters<typeof launchExperimentRun>[0]> = {}): ExperimentRun =>
  accept(launchExperimentRun({ id: "xr-1", experimentId: "exp-1", suite, agent, caseKeys: ["case-a", "case-b"], repeatCount: 3, taskConcurrency: 5, at: at(), ...over }, hash)).state;

test("a launch registers every case-by-repeat member once, each with its own derived task run request", () => {
  const run = launch();
  assert.equal(run.members.length, 6);
  assert.deepEqual(run.members.map(m => m.key), ["case-a#0", "case-a#1", "case-a#2", "case-b#0", "case-b#1", "case-b#2"]);
  assert.deepEqual(experimentViolations(run), []);
  assert.equal(new Set(run.members.map(m => m.taskRunRequestId)).size, 6);
  const again = launch();
  assert.deepEqual(again.members, run.members, "launching the same batch derives the same requests, so a restart cannot create new samples");
  const derived = deriveRequestId("xr-1", "case-a", 1, hash);
  assert.ok(derived.ok && derived.value === run.members[1].taskRunRequestId);
  const other = deriveRequestId("xr-2", "case-a", 1, hash);
  assert.ok(other.ok && other.value !== derived.value);
});

test("a launch refuses malformed plans", () => {
  const base = { id: "xr", experimentId: "e", suite, agent, caseKeys: ["a"], repeatCount: 1, taskConcurrency: 1, at: at() };
  rejected(launchExperimentRun({ ...base, caseKeys: [] }, hash), "invalid");
  rejected(launchExperimentRun({ ...base, caseKeys: ["a", "a"] }, hash), "invalid");
  rejected(launchExperimentRun({ ...base, repeatCount: 0 }, hash), "invalid");
  rejected(launchExperimentRun({ ...base, repeatCount: 1.5 }, hash), "invalid");
  rejected(launchExperimentRun({ ...base, taskConcurrency: 0 }, hash), "invalid");
  rejected(launchExperimentRun({ ...base, suite: agent }, hash), "invalid");
  rejected(launchExperimentRun({ ...base, agent: suite }, hash), "invalid");
});

test("after cancellation nothing new starts for any member", () => {
  const run = launch();
  assert.ok(mayStartMember(run, "case-a#1").ok);
  rejected(mayStartMember(run, "case-z#0"), "conflict", /not part/);
  const cancelled = accept(requestExperimentCancel(run, { at: at() })).state;
  assert.ok(cancelled.cancelIntent);
  rejected(mayStartMember(cancelled, "case-a#1"), "conflict", /cancelled/);
  assert.equal(accept(requestExperimentCancel(cancelled, { at: at() })).state, cancelled);
  assert.deepEqual(cancelled.members, run.members, "members are never changed");
});

test("why a member has no grading follows from its task run and the batch, and infrastructure failures are execution errors", () => {
  const run = launch();
  const member = run.members[0];
  assert.equal(gradingNotStarted(run, member, undefined), "not-scheduled");
  assert.equal(gradingNotStarted(run, member, { status: "running" }), "not-scheduled");
  assert.equal(gradingNotStarted(run, member, { status: "failed" }), "task-failed");
  assert.equal(gradingNotStarted(run, member, { status: "cancelled" }), "task-cancelled");
  assert.equal(gradingNotStarted(run, member, { status: "delivered" }), undefined);
  const cancelled = accept(requestExperimentCancel(run, { at: at() })).state;
  assert.equal(gradingNotStarted(cancelled, member, undefined), "batch-cancelled");
  assert.equal(gradingNotStarted(cancelled, member, { status: "running" }), "batch-cancelled");
  assert.ok(isExecutionError("infrastructure"));
  assert.ok(!isExecutionError("agent-output"));
  assert.ok(!isExecutionError("agent-execution"));
  assert.ok(!isExecutionError(undefined));
});

test("archive integrity distinguishes a moved reference from a lost object", () => {
  assert.equal(integrityOf({ recordedOid: "abc", remoteTarget: "abc", objectAvailable: true }), "intact");
  assert.equal(integrityOf({ recordedOid: "abc", remoteTarget: undefined, objectAvailable: true }), "ref-changed");
  assert.equal(integrityOf({ recordedOid: "abc", remoteTarget: "def", objectAvailable: true }), "ref-changed");
  assert.equal(integrityOf({ recordedOid: "abc", remoteTarget: undefined, objectAvailable: false }), "unavailable");
  assert.ok(reproducible("intact") && reproducible("ref-changed") && !reproducible("unavailable"));
});

// ---- adoption of re-evaluations ------------------------------------------

const slot: SlotIdentity = { experimentRunId: "xr-1", caseKey: "case-a", repeatIndex: 0, requirementKey: "accuracy", graderRevisionId: "grader-rev-1", targets: [`artifact:art-1:${d("c")}`], materialsDigest: d("0") };
const materials = [{ id: "ref-1", digest: d("e") }];
const fingerprint = materialsFingerprint(materials);
let seq = 0;
function measureRecord(over: { requirementKey?: string; graderRevisionId?: string; targetId?: string; materials?: typeof materials; repeatIndex?: number } = {}): GradingRecord {
  return accept(createGrading({
    id: `m-${++seq}`, purpose: "measure", origin: { type: "member", experimentRunId: "xr-1", caseKey: "case-a", repeatIndex: over.repeatIndex ?? 0, requirementKey: over.requirementKey ?? "accuracy" },
    requestSeq: ++seq, targets: [{ type: "artifact", id: over.targetId ?? "art-1", digest: d("c") }],
    graderRevision: { kind: "grader", definitionId: "grader-1", revisionId: over.graderRevisionId ?? "grader-rev-1", seq: 1, digest: d("4") },
    grader: { strategy: "rule", scale: { form: "numeric", min: 0, max: 5 } }, materials: over.materials ?? materials, at: at(),
  })).state;
}
const scored = (g: GradingRecord, value: number): GradingRecord => accept(submitGrade(g, { grade: { form: "numeric", value }, at: at() })).state;
const faulted = (g: GradingRecord): GradingRecord => accept(faultGrader(g, { detail: "judge unreachable", at: at() })).state;

test("a re-evaluation under identical conditions replaces the adopted result and keeps the history", () => {
  const first = scored(measureRecord(), 4);
  const second = scored(measureRecord(), 2);
  const adoption = adoptGrading([first, second], slot, fingerprint);
  assert.equal(adoption.adopted, second.id);
  assert.equal(adoption.attempts, 2);
  assert.equal(adoption.latestFault, undefined);
  assert.equal(adoptGrading([second, first], slot, fingerprint).adopted, second.id, "the order of the list does not matter, the request order does");
});

test("a failed re-evaluation is disclosed beside the result it did not replace", () => {
  const first = scored(measureRecord(), 4);
  const broken = faulted(measureRecord());
  const adoption = adoptGrading([first, broken], slot, fingerprint);
  assert.equal(adoption.adopted, first.id);
  assert.equal(adoption.latestFault?.id, broken.id);
  const recovered = scored(measureRecord(), 5);
  const later = adoptGrading([first, broken, recovered], slot, fingerprint);
  assert.equal(later.adopted, recovered.id);
  assert.equal(later.latestFault, undefined, "a fault older than the adopted record is no longer news");
  const lonely = adoptGrading([broken], slot, fingerprint);
  assert.equal(lonely.adopted, undefined);
  assert.equal(lonely.latestFault?.id, broken.id);
});

test("a legitimate indeterminate result replaces an older score", () => {
  const first = scored(measureRecord(), 5);
  const indeterminate = accept(submitGrade(measureRecord(), { grade: { form: "indeterminate", reason: "reference unreadable" }, at: at() })).state;
  assert.equal(adoptGrading([first, indeterminate], slot, fingerprint).adopted, indeterminate.id);
});

test("records under different conditions are not one re-evaluation sequence", () => {
  const base = scored(measureRecord(), 4);
  const otherGrader = scored(measureRecord({ graderRevisionId: "grader-rev-2" }), 1);
  const otherTarget = scored(measureRecord({ targetId: "art-2" }), 1);
  const otherMaterials = scored(measureRecord({ materials: [{ id: "ref-1", digest: d("f") }] }), 1);
  const otherRequirement = scored(measureRecord({ requirementKey: "style" }), 1);
  const otherRepeat = scored(measureRecord({ repeatIndex: 1 }), 1);
  const cancelled = accept(requestGradingCancel(measureRecord(), { at: at() })).state;
  const adoption = adoptGrading([base, otherGrader, otherTarget, otherMaterials, otherRequirement, otherRepeat, cancelled], slot, fingerprint);
  assert.equal(adoption.adopted, base.id);
  assert.equal(adoption.attempts, 2, "the cancelled attempt belongs to the sequence but is neither adopted nor a fault");
});

test("a sample's gradings are complete only when every required slot has an adopted record", () => {
  const accuracy = scored(measureRecord(), 4);
  const style = faulted(measureRecord({ requirementKey: "style" }));
  const slots = [
    { slot, materialsFingerprint: fingerprint },
    { slot: { ...slot, requirementKey: "style" }, materialsFingerprint: fingerprint },
    { slot: { ...slot, requirementKey: "tone" }, materialsFingerprint: fingerprint },
  ];
  const result = completeness([accuracy, style], slots);
  assert.deepEqual(result.states, { accuracy: "adopted", style: "error", tone: "missing" });
  assert.equal(result.complete, false);
  const full = completeness([accuracy, scored(measureRecord({ requirementKey: "style" }), 3), scored(measureRecord({ requirementKey: "tone" }), 2)], slots);
  assert.equal(full.complete, true);
});
