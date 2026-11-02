import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptanceOf, attachGradingSandbox, createGrading, declareExternalEvaluatorStop, evaluatorStopped, faultGrader, gradingViolations, isGradingTerminal, materialsDigest, registerAgentEvaluator, registerExternalEvaluator,
  recordEvaluatorCommand, recordEvaluatorStage, requestGradingCancel, requestStepStop, sameBinding, startCommandStep, stepStopUnknown, stepStopped, submitGrade, validateGrade,
  type CriterionVerdict, type Decision, type GateBinding, type Grade, type GradingEvent, type GradingRecord, type GraderContent, type Result, type RevisionRef,
} from "../src/work/domain/index.js";
import { accept, clock, hash, random, rejected } from "./work-fixtures.js";

const at = clock();
const d = (c: string) => `sha256:${c.repeat(64)}`;
const graderRef = (id = "grader-rev-1"): RevisionRef => ({ kind: "grader", definitionId: "grader-1", revisionId: id, seq: 1, digest: d("4") });
const taskRef: RevisionRef = { kind: "task", definitionId: "task-1", revisionId: "task-rev-1", seq: 1, digest: d("1") };
const binding = (over: Partial<GateBinding> = {}): GateBinding => ({ taskRevision: taskRef, criteriaDigest: d("5"), manifestDigest: d("6"), graderRevision: graderRef(), materialsDigest: d("7"), expectedCriteria: ["c1", "c2"], ...over });
const targets = [{ type: "candidate" as const, id: "cand-1", digest: d("8") }];
const criteriaGrader: GraderContent = { strategy: "agent", scale: { form: "criteria" } };

type Step = Result<Decision<GradingRecord, GradingEvent, string>>;
const apply = (step: Step): GradingRecord => { const x = accept(step); assert.deepEqual(gradingViolations(x.state), []); return x.state; };

let seq = 0;
function gate(over: { id?: string; binding?: GateBinding; grader?: GraderContent; seq?: number } = {}): GradingRecord {
  const b = over.binding ?? binding();
  return accept(createGrading({ id: over.id ?? `gate-${++seq}`, purpose: "gate", origin: { type: "gate", taskRunId: "run-1" }, requestSeq: over.seq ?? ++seq, targets, graderRevision: b.graderRevision, grader: over.grader ?? criteriaGrader, materials: [{ id: "m1", digest: d("9") }], binding: b, at: at() })).state;
}
function measure(grader: GraderContent, origin: Parameters<typeof createGrading>[0]["origin"] = { type: "standalone" }): GradingRecord {
  return accept(createGrading({ id: `measure-${++seq}`, purpose: "measure", origin, requestSeq: ++seq, targets, graderRevision: graderRef(), grader, materials: [], at: at() })).state;
}
const verdict = (id: string, final: CriterionVerdict["final"] = "satisfied", over: Partial<CriterionVerdict> = {}): CriterionVerdict => ({ criterionId: id, independent: final, reconciliation: "corroborated", final, rationale: `because ${id}`, evidence: [], ...over });
const criteriaGrade = (finals: Record<string, CriterionVerdict["final"]> = { c1: "satisfied", c2: "satisfied" }): Grade => ({ form: "criteria", items: Object.entries(finals).map(([id, f]) => verdict(id, f)) });
const completedGate = (finals: Record<string, CriterionVerdict["final"]>, over: Parameters<typeof gate>[0] = {}) => {
  let g = gate(over);
  g = apply(registerAgentEvaluator(g, { executionId: `exec-${seq}`, at: at() }));
  g = apply(evaluatorStopped(g, { at: at() }));
  return apply(submitGrade(g, { grade: criteriaGrade(finals), at: at() }));
};

test("a gate is created against a delivered run with its full binding; a measure has neither", () => {
  const g = gate();
  assert.equal(g.status, "running");
  assert.equal(g.evaluator, undefined, "an agent grader waits for its evaluator");
  const base = { id: "g", requestSeq: 1, targets, graderRevision: graderRef(), materials: [], at: at() };
  rejected(createGrading({ ...base, purpose: "gate", origin: { type: "standalone" }, grader: criteriaGrader, binding: binding() }), "invalid", /delivered task run/);
  rejected(createGrading({ ...base, purpose: "gate", origin: { type: "gate", taskRunId: "r" }, grader: criteriaGrader }), "invalid", /binding/);
  rejected(createGrading({ ...base, purpose: "gate", origin: { type: "gate", taskRunId: "r" }, grader: { strategy: "agent", scale: { form: "numeric", min: 0, max: 5 } }, binding: binding() }), "invalid", /criterion by criterion/);
  rejected(createGrading({ ...base, purpose: "gate", origin: { type: "gate", taskRunId: "r" }, grader: criteriaGrader, binding: binding({ graderRevision: graderRef("other") }) }), "invalid", /different grader/);
  rejected(createGrading({ ...base, purpose: "gate", origin: { type: "gate", taskRunId: "r" }, grader: criteriaGrader, binding: binding({ expectedCriteria: [] }) }), "invalid");
  rejected(createGrading({ ...base, purpose: "measure", origin: { type: "gate", taskRunId: "r" }, grader: criteriaGrader }), "invalid", /not run for a task run/);
  rejected(createGrading({ ...base, purpose: "measure", origin: { type: "standalone" }, grader: criteriaGrader, binding: binding() }), "invalid", /only a gate/);
  rejected(createGrading({ ...base, purpose: "measure", origin: { type: "member", experimentRunId: "x", caseKey: "", repeatIndex: 0, requirementKey: "r" }, grader: criteriaGrader }), "invalid", /member origin/);
  rejected(createGrading({ ...base, targets: [targets[0], targets[0]], purpose: "measure", origin: { type: "standalone" }, grader: criteriaGrader }), "invalid");
  assert.deepEqual(measure({ strategy: "rule", scale: { form: "category", categories: ["pass"] } }).evaluator, { kind: "rule" });
  assert.deepEqual(measure({ strategy: "test", scale: { form: "category", categories: ["pass"] }, environmentRevisionId: "env-1" }).evaluator, { kind: "test" });
});

test("a grade must fit the scale its grader declares", () => {
  const numeric = { form: "numeric" as const, min: 0, max: 5 };
  assert.ok(validateGrade({ form: "numeric", value: 5 }, numeric).ok);
  rejected(validateGrade({ form: "numeric", value: 5.1 }, numeric), "invalid", /outside/);
  rejected(validateGrade({ form: "numeric", value: Number.NaN }, numeric), "invalid");
  rejected(validateGrade({ form: "category", category: "pass" }, numeric), "invalid", /numeric scale/);
  const categories = { form: "category" as const, categories: ["pass", "fail"] };
  assert.ok(validateGrade({ form: "category", category: "fail" }, categories).ok);
  rejected(validateGrade({ form: "category", category: "partial" }, categories), "invalid", /not one the grader declares/);
  assert.ok(validateGrade({ form: "indeterminate", reason: "reference material was lost" }, numeric).ok, "an indeterminate result is legitimate on any scale");
  rejected(validateGrade({ form: "indeterminate", reason: "" }, numeric), "invalid", /says why/);
  const criteria = { form: "criteria" as const };
  assert.ok(validateGrade(criteriaGrade(), criteria).ok, "a measure may judge any criteria");
  rejected(validateGrade(criteriaGrade({ c1: "satisfied", c2: "satisfied" }), criteria, binding({ expectedCriteria: ["c1", "c2", "c3"] })), "invalid", /exactly/);
  rejected(validateGrade(criteriaGrade({ c1: "satisfied", c2: "satisfied", c9: "satisfied" }), criteria, binding()), "invalid", /exactly/);
  rejected(validateGrade({ form: "criteria", items: [verdict("c1"), verdict("c1")] }, criteria), "invalid", /once/);
  rejected(validateGrade({ form: "criteria", items: [verdict("c1", "satisfied", { rationale: "" })] }, criteria), "invalid", /rationale/);
  rejected(validateGrade({ form: "criteria", items: [verdict("c1", "unsatisfied", { reusedFrom: "gate-0" })] }, criteria), "invalid", /taken over/);
});

test("a rule grading completes with a valid grade and never changes afterwards", () => {
  const g = measure({ strategy: "rule", scale: { form: "numeric", min: 0, max: 5 } });
  rejected(submitGrade(g, { grade: { form: "numeric", value: 9 }, at: at() }), "invalid");
  const done = apply(submitGrade(g, { grade: { form: "numeric", value: 4 }, at: at() }));
  assert.equal(done.status, "completed");
  const again = accept(submitGrade(done, { grade: { form: "numeric", value: 1 }, at: at() }));
  assert.equal(again.outcome, "late");
  assert.deepEqual(again.state.grade, { form: "numeric", value: 4 });
  assert.equal(again.state.lateRecords.length, 1);
  assert.equal(accept(faultGrader(done, { detail: "x", at: at() })).outcome, "late");
});

test("an agent evaluator must be registered and confirmed stopped before its grade counts", () => {
  const g = gate();
  rejected(submitGrade(g, { grade: criteriaGrade(), at: at() }), "conflict", /register the evaluator/);
  const registered = apply(registerAgentEvaluator(g, { executionId: "exec-1", at: at() }));
  rejected(registerAgentEvaluator(registered, { executionId: "exec-2", at: at() }), "conflict", /already registered/);
  rejected(submitGrade(registered, { grade: criteriaGrade(), at: at() }), "conflict", /stop is not verified/);
  const stopped = apply(evaluatorStopped(registered, { at: at() }));
  assert.equal(apply(submitGrade(stopped, { grade: criteriaGrade(), at: at() })).status, "completed");
  rejected(registerAgentEvaluator(measure({ strategy: "rule", scale: { form: "criteria" } }), { executionId: "e", at: at() }), "conflict", /does not use an agent/);
  rejected(attachGradingSandbox(apply(attachGradingSandbox(g, { sandboxId: "sbx-1" })), { sandboxId: "sbx-2" }), "conflict");
});

test("an external evaluator is a different session issued after the delivery was frozen, and its submission declares its stop", () => {
  const g = gate();
  const base = { sessionId: "eval-session", agentId: "claude-code", workerSessionId: "work-session", sessionIssuedAt: "2026-02-01T00:00:10.000Z", targetsFrozenAt: "2026-02-01T00:00:00.000Z", at: at() };
  rejected(registerExternalEvaluator(g, { ...base, sessionId: "work-session" }), "conflict", /different session/);
  rejected(registerExternalEvaluator(g, { ...base, sessionIssuedAt: "2026-01-31T23:59:59.000Z" }), "conflict", /predates/);
  const registered = apply(registerExternalEvaluator(g, base));
  rejected(submitGrade(registered, { grade: criteriaGrade(), sessionId: "intruder", at: at() }), "forbidden");
  rejected(submitGrade(registered, { grade: criteriaGrade(), at: at() }), "forbidden");
  const done = apply(submitGrade(registered, { grade: criteriaGrade(), sessionId: "eval-session", at: at() }));
  assert.equal(done.status, "completed");
  assert.ok(done.evaluator?.kind === "external" && done.evaluator.stopDeclared);
});

test("test grader commands run one at a time, and a lost exit result is a grader fault", () => {
  const grader: GraderContent = { strategy: "test", scale: { form: "category", categories: ["pass", "fail"] }, environmentRevisionId: "env-1" };
  let g = measure(grader);
  rejected(submitGrade(g, { grade: { form: "category", category: "pass" }, at: at() }), "conflict", /at least one command/);
  rejected(startCommandStep(g, { ordinal: 1, specDigest: d("a"), at: at() }), "conflict", /next command step is 0/);
  g = apply(startCommandStep(g, { ordinal: 0, specDigest: d("a"), at: at() }));
  rejected(startCommandStep(g, { ordinal: 1, specDigest: d("b"), at: at() }), "conflict", /previous command/);
  rejected(submitGrade(g, { grade: { form: "category", category: "pass" }, at: at() }), "conflict", /stopped with a result/);
  g = apply(requestStepStop(g, { ordinal: 0, at: at() }));
  g = apply(stepStopUnknown(g, { ordinal: 0, at: at() }));
  rejected(startCommandStep(g, { ordinal: 1, specDigest: d("b"), at: at() }), "conflict");
  g = apply(stepStopped(g, { ordinal: 0, exitCode: 0, at: at() }));
  rejected(stepStopped(g, { ordinal: 0, exitCode: 0, at: at() }), "conflict", /already stopped/);
  g = apply(startCommandStep(g, { ordinal: 1, specDigest: d("b"), at: at() }));
  const faulted = accept(stepStopped(g, { ordinal: 1, at: at() }));
  assert.equal(faulted.state.status, "grader_fault");
  assert.match(faulted.state.fault ?? "", /without a trustworthy exit result/);
  assert.equal(faulted.state.grade, undefined, "a fault never produces a score");
  assert.deepEqual(gradingViolations(faulted.state), []);
  const passing = apply(stepStopped(apply(startCommandStep(measure(grader), { ordinal: 0, specDigest: d("a"), at: at() })), { ordinal: 0, exitCode: 1, at: at() }));
  assert.equal(apply(submitGrade(passing, { grade: { form: "category", category: "fail" }, at: at() })).status, "completed", "a failing test is a result, not a fault");
  rejected(startCommandStep(measure({ strategy: "rule", scale: { form: "criteria" } }), { ordinal: 0, specDigest: d("a"), at: at() }), "conflict", /only a test grader/);
});

test("cancellation requested before an unknown exit result wins; one committed first keeps its fault", () => {
  const grader: GraderContent = { strategy: "test", scale: { form: "category", categories: ["pass"] }, environmentRevisionId: "env-1" };
  const running = apply(startCommandStep(measure(grader), { ordinal: 0, specDigest: d("a"), at: at() }));
  const cancelling = apply(requestGradingCancel(running, { at: at() }));
  assert.equal(cancelling.status, "running", "the command is still running");
  rejected(startCommandStep(cancelling, { ordinal: 1, specDigest: d("b"), at: at() }), "conflict", /cancellation/);
  const lost = accept(stepStopped(cancelling, { ordinal: 0, at: at() }));
  assert.equal(lost.state.status, "cancelled", "an unknown result after the intent is only a diagnostic");
  assert.equal(lost.outcome, "cancel-wins");
  assert.equal(lost.state.fault, undefined);
  assert.equal(lost.state.grade, undefined);
  const faulted = accept(stepStopped(running, { ordinal: 0, at: at() })).state;
  assert.equal(faulted.status, "grader_fault");
  assert.equal(accept(requestGradingCancel(faulted, { at: at() })).outcome, "already-terminal");
  assert.equal(accept(requestGradingCancel(faulted, { at: at() })).state.status, "grader_fault");
});

test("cancelling waits for whatever was started, and a grade arriving afterwards is only history", () => {
  const rule = accept(requestGradingCancel(measure({ strategy: "rule", scale: { form: "criteria" } }), { at: at() }));
  assert.equal(rule.state.status, "cancelled");
  const agentGate = apply(registerAgentEvaluator(gate(), { executionId: "exec-1", at: at() }));
  const cancelling = apply(requestGradingCancel(agentGate, { at: at() }));
  assert.equal(cancelling.status, "running");
  rejected(registerAgentEvaluator(apply(requestGradingCancel(gate(), { at: at() })), { executionId: "e", at: at() }), "conflict", /already cancelled/);
  const late = accept(submitGrade(cancelling, { grade: criteriaGrade(), at: at() }));
  assert.equal(late.outcome, "cancel-wins");
  assert.equal(late.state.grade, undefined);
  assert.equal(late.state.lateRecords.length, 1);
  assert.equal(late.state.status, "running", "the evaluator has not been confirmed stopped yet");
  const done = accept(evaluatorStopped(late.state, { at: at() }));
  assert.equal(done.state.status, "cancelled");
  const external = apply(registerExternalEvaluator(gate(), { sessionId: "s", agentId: "a", sessionIssuedAt: "2026-03-01T00:00:00.000Z", targetsFrozenAt: "2026-02-01T00:00:00.000Z", at: at() }));
  const waiting = apply(requestGradingCancel(external, { at: at() }));
  assert.equal(waiting.status, "running");
  assert.equal(accept(declareExternalEvaluatorStop(waiting, { at: at() })).state.status, "cancelled");
  rejected(declareExternalEvaluatorStop(waiting, { sessionId: "other", at: at() }), "forbidden");
});

test("a fault is never a score, and a legitimate indeterminate result is not a fault", () => {
  const g = measure({ strategy: "rule", scale: { form: "numeric", min: 0, max: 5 } });
  const faulted = apply(faultGrader(g, { detail: "grader crashed", at: at() }));
  assert.equal(faulted.status, "grader_fault");
  assert.equal(faulted.grade, undefined);
  const indeterminate = apply(submitGrade(g, { grade: { form: "indeterminate", reason: "the reference answer could not be read" }, at: at() }));
  assert.equal(indeterminate.status, "completed");
  assert.equal(indeterminate.grade?.form, "indeterminate");
});

test("a verdict may be taken over only from a completed gate with the identical binding that found it satisfied", () => {
  const first = completedGate({ c1: "satisfied", c2: "unsatisfied" }, { id: "gate-first", seq: 1 });
  let g = gate({ id: "gate-second", seq: 2 });
  g = apply(registerAgentEvaluator(g, { executionId: "exec-x", at: at() }));
  g = apply(evaluatorStopped(g, { at: at() }));
  const taking = (id: string, from = "gate-first"): Grade => ({ form: "criteria", items: [verdict(id, "satisfied", { reusedFrom: from }), verdict(id === "c1" ? "c2" : "c1", "satisfied")] });
  assert.equal(apply(submitGrade(g, { grade: taking("c1"), at: at() }, { priorGates: [first] })).status, "completed");
  rejected(submitGrade(g, { grade: taking("c2"), at: at() }, { priorGates: [first] }), "conflict", /was not satisfied/);
  rejected(submitGrade(g, { grade: taking("c1", "gate-unknown"), at: at() }, { priorGates: [first] }), "conflict", /binding differs/);
  const other = completedGate({ c1: "satisfied", c2: "satisfied" }, { id: "gate-other", seq: 3, binding: binding({ materialsDigest: d("b") }) });
  rejected(submitGrade(g, { grade: taking("c1", "gate-other"), at: at() }, { priorGates: [other] }), "conflict", /binding differs/);
  assert.ok(sameBinding(binding(), binding({ expectedCriteria: ["c2", "c1"] })), "the order of criteria does not matter");
  assert.ok(!sameBinding(binding(), binding({ manifestDigest: d("c") })));
});

test("acceptance reads the latest complete gate on the exact subject, whoever judged and with what materials", () => {
  const subject = { taskRevisionId: "task-rev-1", criteriaDigest: d("5"), manifestDigest: d("6") };
  assert.deepEqual(acceptanceOf([], subject), { conclusion: "pending", disputed: false });
  const rejectedFirst = completedGate({ c1: "satisfied", c2: "unsatisfied" }, { id: "g1", seq: 1 });
  assert.equal(acceptanceOf([rejectedFirst], subject).conclusion, "rejected");
  const acceptedLater = completedGate({ c1: "satisfied", c2: "satisfied" }, { id: "g2", seq: 2, binding: binding({ graderRevision: graderRef("grader-rev-2"), materialsDigest: d("d") }) });
  const result = acceptanceOf([acceptedLater, rejectedFirst], subject);
  assert.equal(result.conclusion, "accepted", "the later gate counts even though another grader and other materials produced it");
  assert.equal(result.adopted, "g2");
  assert.equal(result.disputed, true, "the earlier opposite conclusion is shown, not hidden");
  const rejectedAfter = completedGate({ c1: "unsatisfied", c2: "satisfied" }, { id: "g3", seq: 3 });
  assert.equal(acceptanceOf([rejectedFirst, acceptedLater, rejectedAfter], subject).conclusion, "rejected");
  const indeterminate = completedGate({ c1: "satisfied", c2: "indeterminate" }, { id: "g4", seq: 4 });
  assert.equal(acceptanceOf([acceptedLater, indeterminate], subject).conclusion, "rejected", "an indeterminate criterion is not a pass");
  const otherSubject = completedGate({ c1: "unsatisfied", c2: "unsatisfied" }, { id: "g5", seq: 9, binding: binding({ manifestDigest: d("e") }) });
  assert.equal(acceptanceOf([acceptedLater, otherSubject], subject).conclusion, "accepted", "a gate on another delivery is irrelevant");
  const unfinished = apply(registerAgentEvaluator(gate({ id: "g6", seq: 10 }), { executionId: "e", at: at() }));
  const faultedGate = apply(faultGrader(gate({ id: "g7", seq: 11 }), { detail: "x", at: at() }));
  const cancelledGate = accept(requestGradingCancel(gate({ id: "g8", seq: 12 }), { at: at() })).state;
  assert.equal(acceptanceOf([acceptedLater, unfinished, faultedGate, cancelledGate], subject).conclusion, "accepted", "running, faulted and cancelled records are not verdicts");
  assert.equal(acceptanceOf([acceptedLater, measure({ strategy: "rule", scale: { form: "criteria" } })], subject).adopted, "g2");
});

test("materials are digested independently of their order", () => {
  const a = materialsDigest([{ id: "x", digest: d("1") }, { id: "y", digest: d("2") }], hash);
  const b = materialsDigest([{ id: "y", digest: d("2") }, { id: "x", digest: d("1") }], hash);
  assert.ok(a.ok && b.ok && a.value === b.value);
  assert.ok(materialsDigest([{ id: "x", digest: d("3") }], hash).ok);
});

test("random operations keep every grading invariant and never leave a final status", () => {
  const graders: GraderContent[] = [
    { strategy: "rule", scale: { form: "numeric", min: 0, max: 5 } },
    { strategy: "test", scale: { form: "category", categories: ["pass", "fail"] }, environmentRevisionId: "env-1" },
    { strategy: "agent", scale: { form: "criteria" } },
  ];
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
    const grader = pick(graders);
    let g = grader.scale.form === "criteria" && next() > 0.5 ? gate() : measure(grader);
    let finalStatus: string | undefined;
    for (let step = 0; step < 25; step++) {
      const ordinal = pick([0, 0, 1, 2]);
      const grade: Grade = pick([{ form: "numeric", value: pick([1, 9]) }, { form: "category", category: pick(["pass", "fail", "meh"]) }, criteriaGrade(), criteriaGrade({ c1: "satisfied" }), { form: "indeterminate", reason: "none" }] as Grade[]);
      const commands: Array<() => Step> = [
        () => registerAgentEvaluator(g, { executionId: "exec-1", at: at() }),
        () => evaluatorStopped(g, { at: at() }),
        () => registerExternalEvaluator(g, { sessionId: "s1", agentId: "a", sessionIssuedAt: "2026-03-01T00:00:00.000Z", targetsFrozenAt: "2026-02-01T00:00:00.000Z", at: at() }),
        () => declareExternalEvaluatorStop(g, { at: at() }),
        () => startCommandStep(g, { ordinal, specDigest: d("a"), at: at() }),
        () => requestStepStop(g, { ordinal, at: at() }),
        () => stepStopUnknown(g, { ordinal, at: at() }),
        () => stepStopped(g, { ordinal, exitCode: pick([0, 1, undefined as unknown as number]), at: at() }),
        () => submitGrade(g, { grade, sessionId: pick(["s1", "other"]), at: at() }),
        () => faultGrader(g, { detail: "boom", at: at() }),
        () => requestGradingCancel(g, { at: at() }),
      ];
      const result = pick(commands)();
      if (!result.ok) continue;
      g = result.value.state;
      assert.deepEqual(gradingViolations(g), [], `seed ${seed}`);
      if (finalStatus) assert.equal(g.status, finalStatus, `seed ${seed}: a finished grading stays ${finalStatus}`);
      else if (isGradingTerminal(g)) finalStatus = g.status;
    }
  }
});

// ---- external evaluator protocol ------------------------------------------

function withExternalEvaluator(sessionId = "session-e"): GradingRecord {
  return apply(registerExternalEvaluator(gate(), { sessionId, agentId: "reviewer", sessionIssuedAt: "2026-01-02T00:00:00.000Z", targetsFrozenAt: "2026-01-01T00:00:00.000Z", at: at() }) as Step);
}
const stageAt = (g: GradingRecord, stage: Parameters<typeof recordEvaluatorStage>[1]["stage"], over: { sessionId?: string; blindDigest?: string } = {}) =>
  recordEvaluatorStage(g, { sessionId: over.sessionId ?? "session-e", stage, ...(over.blindDigest ? { blindDigest: over.blindDigest } : {}), at: at() }) as Step;

test("an external evaluator follows blind, freeze, reconcile, handoff, submit in order, and the frozen blind result never changes", () => {
  let g = withExternalEvaluator();
  rejected(stageAt(g, "freeze", { blindDigest: d("a") }), "conflict", /does not follow/);
  g = apply(stageAt(g, "blind"));
  rejected(stageAt(g, "blind"), "conflict", /already recorded/);
  rejected(stageAt(g, "freeze"), "invalid", /digest of the blind result/);
  g = apply(stageAt(g, "freeze", { blindDigest: d("a") }));
  rejected(stageAt(g, "reconcile", { blindDigest: d("b") }), "conflict", /cannot change/);
  g = apply(stageAt(g, "reconcile", { blindDigest: d("a") }));
  g = apply(stageAt(g, "handoff"));
  g = apply(stageAt(g, "submit"));
  const evaluator = g.evaluator?.kind === "external" ? g.evaluator : undefined;
  assert.deepEqual(evaluator?.protocol?.map(r => r.stage), ["blind", "freeze", "reconcile", "handoff", "submit"]);
  assert.equal(evaluator?.protocol?.[1].blindDigest, d("a"));
});

test("only the registered session records protocol facts, and only for a grading that has an external evaluator", () => {
  const g = withExternalEvaluator();
  rejected(stageAt(g, "blind", { sessionId: "someone-else" }), "forbidden");
  rejected(recordEvaluatorCommand(g, { sessionId: "someone-else", observation: { stage: "blind", entry: "x", argvDigest: d("1"), state: "succeeded", at: at() } }), "forbidden");
  const plain = gate();
  rejected(stageAt(plain, "blind"), "conflict", /no external evaluator/);
});

test("observed commands are appended beside the stages; after the grading finished they are only recorded as late", () => {
  let g = withExternalEvaluator();
  g = apply(recordEvaluatorCommand(g, { sessionId: "session-e", observation: { stage: "blind", entry: "candidate-context", argvDigest: d("1"), state: "succeeded", exitCode: 0, at: at() } }) as Step);
  g = apply(recordEvaluatorCommand(g, { sessionId: "session-e", observation: { stage: "blind", entry: "run-tests", argvDigest: d("2"), state: "failed", exitCode: 1, at: at() } }) as Step);
  assert.deepEqual(g.evaluator?.kind === "external" && g.evaluator.commandObservations?.map(o => o.entry), ["candidate-context", "run-tests"]);
  rejected(recordEvaluatorCommand(g, { sessionId: "session-e", observation: { stage: "nonsense" as never, entry: "x", argvDigest: d("1"), state: "succeeded", at: at() } }), "invalid");
  const done = apply(submitGrade(g, { grade: criteriaGrade(), sessionId: "session-e", at: at() }) as Step);
  const afterwards = accept(stageAt(done, "blind") as Step);
  assert.equal(afterwards.outcome, "late");
  assert.equal(afterwards.state.lateRecords.length, 1);
  assert.deepEqual(afterwards.state.evaluator?.kind === "external" ? afterwards.state.evaluator.protocol ?? [] : undefined, [], "a late fact does not enter the protocol");
});
