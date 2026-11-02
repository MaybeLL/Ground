import { advance, conflict, digestOf, firstInvalid, invalid, isDigest, isId, isNonNegativeInteger, isText, isTimestamp, ok, reject, unique, type Decision, type Digest, type Hasher, type Id, type Result, type Timestamp, type Versioned } from "./kernel.js";
import { isRevisionRef, type GraderContent, type RevisionRef, type Scale } from "./definitions.js";
import type { AcceptanceConclusion } from "./work.js";
import { protocolStages, type CommandObservation, type ProtocolRecord, type ProtocolStage } from "./agent-execution.js";

export type Purpose = "gate" | "measure";
export type TargetRef = { readonly type: "candidate" | "artifact" | "trajectory"; readonly id: Id; readonly digest: Digest };
export type GradingOrigin =
  | { readonly type: "standalone" }
  | { readonly type: "gate"; readonly taskRunId: Id }
  | { readonly type: "member"; readonly experimentRunId: Id; readonly caseKey: string; readonly repeatIndex: number; readonly requirementKey: string };

/** Everything that fixes what a gate verdict is a verdict about. Equal bindings are the only thing a verdict may be reused across. */
export interface GateBinding {
  readonly taskRevision: RevisionRef;
  readonly criteriaDigest: Digest;
  readonly manifestDigest: Digest;
  readonly graderRevision: RevisionRef;
  readonly materialsDigest: Digest;
  readonly expectedCriteria: readonly Id[];
}
export const sameBinding = (a: GateBinding, b: GateBinding): boolean => a.taskRevision.revisionId === b.taskRevision.revisionId && a.criteriaDigest === b.criteriaDigest && a.manifestDigest === b.manifestDigest
  && a.graderRevision.revisionId === b.graderRevision.revisionId && a.materialsDigest === b.materialsDigest && a.expectedCriteria.length === b.expectedCriteria.length && a.expectedCriteria.every(id => b.expectedCriteria.includes(id));
/** What a verdict is about, ignoring who judged and with which materials: the unit an acceptance conclusion is read over. */
const sameSubject = (a: GateBinding, b: GateBinding): boolean => a.taskRevision.revisionId === b.taskRevision.revisionId && a.criteriaDigest === b.criteriaDigest && a.manifestDigest === b.manifestDigest;

export type Verdict = "satisfied" | "unsatisfied" | "indeterminate";
export interface CriterionVerdict {
  readonly criterionId: Id;
  readonly independent: Verdict;
  readonly reconciliation: "corroborated" | "contradicted" | "not_determined";
  readonly final: Verdict;
  readonly rationale: string;
  readonly evidence: readonly string[];
  /** Taken over from an earlier record with the identical binding instead of re-checked. */
  readonly reusedFrom?: Id;
}
export type Grade =
  | { readonly form: "numeric"; readonly value: number }
  | { readonly form: "category"; readonly category: string }
  | { readonly form: "criteria"; readonly items: readonly CriterionVerdict[] }
  /** A legitimate result: the material needed to judge could not be had. Not a grader fault. */
  | { readonly form: "indeterminate"; readonly reason: string };

export type Evaluator =
  | { readonly kind: "rule" }
  | { readonly kind: "test" }
  | { readonly kind: "agent"; readonly executionId: Id }
  | {
    readonly kind: "external";
    /** Issued by Grounds at registration. Absent only on a migrated registration whose session identity the previous ledger did not keep. */
    readonly sessionId?: Id;
    readonly agentId?: string;
    readonly stopDeclared?: Timestamp;
    /** Taken over from the previous model: the independence guarantee of a fresh session issued after the freeze was never established by this one. */
    readonly migrated?: true;
    readonly protocol?: readonly ProtocolRecord[];
    readonly commandObservations?: readonly CommandObservation[];
  };

export type StepState = "running" | "stop_requested" | "stop_unknown" | "stopped_result" | "stopped_no_result";
export interface CommandStep { readonly ordinal: number; readonly specDigest: Digest; readonly state: StepState; readonly exitCode?: number; readonly startedAt: Timestamp; readonly stoppedAt?: Timestamp }

export type GradingStatus = "running" | "completed" | "grader_fault" | "cancelled";
export interface GradingLate { readonly kind: "grade" | "fault" | "step"; readonly at: Timestamp; readonly detail: string }

export interface GradingRecord extends Versioned {
  readonly id: Id;
  readonly purpose: Purpose;
  readonly origin: GradingOrigin;
  /** Assigned by the ledger; later requests have larger numbers. The adoption rule reads it. */
  readonly requestSeq: number;
  readonly targets: readonly TargetRef[];
  readonly graderRevision: RevisionRef;
  readonly strategy: GraderContent["strategy"];
  readonly scale: Scale;
  readonly environmentRevisionId?: Id;
  readonly materials: readonly { readonly id: Id; readonly digest: Digest }[];
  readonly binding?: GateBinding;
  readonly evaluator?: Evaluator;
  readonly commandSteps: readonly CommandStep[];
  readonly sandboxId?: Id;
  /** A managed evaluator's execution was confirmed stopped. */
  readonly evaluatorStopped?: boolean;
  readonly status: GradingStatus;
  readonly cancelIntent?: { readonly at: Timestamp };
  readonly grade?: Grade;
  readonly fault?: string;
  readonly lateRecords: readonly GradingLate[];
  readonly createdAt: Timestamp;
  readonly terminalAt?: Timestamp;
}

export type GradingEvent =
  | { readonly type: "created"; readonly gradingId: Id; readonly purpose: Purpose; readonly at: Timestamp }
  | { readonly type: "evaluator-registered"; readonly gradingId: Id; readonly kind: Evaluator["kind"]; readonly at: Timestamp }
  | { readonly type: "sandbox-attached"; readonly gradingId: Id; readonly sandboxId: Id }
  | { readonly type: "protocol-stage"; readonly gradingId: Id; readonly stage: ProtocolStage; readonly at: Timestamp }
  | { readonly type: "evaluator-stopped"; readonly gradingId: Id; readonly verified: boolean; readonly at: Timestamp }
  | { readonly type: "command-step"; readonly gradingId: Id; readonly ordinal: number; readonly state: StepState; readonly at: Timestamp }
  | { readonly type: "completed"; readonly gradingId: Id; readonly at: Timestamp }
  | { readonly type: "grader-fault"; readonly gradingId: Id; readonly at: Timestamp }
  | { readonly type: "cancel-requested"; readonly gradingId: Id; readonly at: Timestamp }
  | { readonly type: "cancelled"; readonly gradingId: Id; readonly at: Timestamp }
  | { readonly type: "late-record"; readonly gradingId: Id; readonly kind: GradingLate["kind"]; readonly at: Timestamp };

type Outcome = "applied" | "late" | "cancel-wins" | "already-terminal";
type Step = Result<Decision<GradingRecord, GradingEvent, Outcome>>;
export const isGradingTerminal = (g: GradingRecord): boolean => g.status !== "running";

const isTarget = (t: unknown): t is TargetRef => !!t && typeof t === "object" && ["candidate", "artifact", "trajectory"].includes((t as TargetRef).type) && isId((t as TargetRef).id) && isDigest((t as TargetRef).digest);
const isBinding = (b: unknown): b is GateBinding => {
  const x = b as GateBinding;
  return !!x && typeof x === "object" && isRevisionRef(x.taskRevision, "task") && isRevisionRef(x.graderRevision, "grader") && isDigest(x.criteriaDigest) && isDigest(x.manifestDigest) && isDigest(x.materialsDigest)
    && Array.isArray(x.expectedCriteria) && x.expectedCriteria.length > 0 && x.expectedCriteria.every(isId) && unique(x.expectedCriteria);
};

export function createGrading(command: {
  id: Id; purpose: Purpose; origin: GradingOrigin; requestSeq: number; targets: readonly TargetRef[]; graderRevision: RevisionRef; grader: GraderContent;
  materials: readonly { id: Id; digest: Digest }[]; binding?: GateBinding; at: Timestamp;
}): Result<Decision<GradingRecord, GradingEvent>> {
  const bad = firstInvalid([["id", isId(command.id)], ["purpose", command.purpose === "gate" || command.purpose === "measure"], ["requestSeq", isNonNegativeInteger(command.requestSeq)],
    ["targets", command.targets.length > 0 && command.targets.every(isTarget) && unique(command.targets, t => `${t.type}:${t.id}`)], ["graderRevision", isRevisionRef(command.graderRevision, "grader")],
    ["materials", command.materials.every(m => isId(m.id) && isDigest(m.digest))], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const origin = command.origin;
  if (command.purpose === "gate") {
    if (origin.type !== "gate" || !isId(origin.taskRunId)) return invalid("a gate is run against a delivered task run");
    if (!isBinding(command.binding)) return invalid("a gate needs its full binding");
    if (command.grader.scale.form !== "criteria") return invalid("a gate grader grades criterion by criterion");
    if (command.binding.graderRevision.revisionId !== command.graderRevision.revisionId) return invalid("the binding names a different grader revision");
  } else {
    if (origin.type === "gate") return invalid("a measure is not run for a task run's acceptance");
    if (command.binding !== undefined) return invalid("only a gate has a binding");
    if (origin.type === "member" && !(isId(origin.experimentRunId) && isText(origin.caseKey, 256) && isNonNegativeInteger(origin.repeatIndex) && isText(origin.requirementKey, 256))) return invalid("a member origin names its run, case, repeat and requirement");
  }
  const state: GradingRecord = {
    id: command.id, purpose: command.purpose, origin, requestSeq: command.requestSeq, targets: command.targets, graderRevision: command.graderRevision, strategy: command.grader.strategy, scale: command.grader.scale,
    ...(command.grader.environmentRevisionId ? { environmentRevisionId: command.grader.environmentRevisionId } : {}), materials: command.materials, ...(command.binding ? { binding: command.binding } : {}),
    ...(command.grader.strategy === "rule" ? { evaluator: { kind: "rule" as const } } : command.grader.strategy === "test" ? { evaluator: { kind: "test" as const } } : {}),
    commandSteps: [], status: "running", lateRecords: [], createdAt: command.at, version: 1,
  };
  return ok({ state, events: [{ type: "created", gradingId: state.id, purpose: state.purpose, at: command.at }], outcome: undefined });
}

const terminalRefusal = (g: GradingRecord) => conflict(`the grading is already ${g.status}`);
function late(g: GradingRecord, kind: GradingLate["kind"], at: Timestamp, detail: string): Step {
  return advance(g, { lateRecords: [...g.lateRecords, { kind, at, detail }] }, [{ type: "late-record", gradingId: g.id, kind, at } as GradingEvent], "late");
}

/** True when nothing this grading started can still be running. */
export function gradingQuiescent(g: GradingRecord): boolean {
  if (g.commandSteps.some(s => s.state !== "stopped_result" && s.state !== "stopped_no_result")) return false;
  if (g.evaluator?.kind === "agent") return g.evaluatorStopped === true;
  if (g.evaluator?.kind === "external") return g.evaluator.stopDeclared !== undefined;
  return true;
}

function settleCancel(g: GradingRecord, base: Partial<GradingRecord>, events: GradingEvent[], at: Timestamp, outcome: Outcome): Step {
  const c = { ...g, ...base } as GradingRecord;
  if (c.cancelIntent && gradingQuiescent(c)) return advance(g, { ...base, status: "cancelled", terminalAt: at }, [...events, { type: "cancelled", gradingId: g.id, at }], outcome);
  return advance(g, base, events, outcome);
}

export function registerAgentEvaluator(g: GradingRecord, command: { executionId: Id; at: Timestamp }): Step {
  if (!isId(command.executionId) || !isTimestamp(command.at)) return invalid("executionId and at are required");
  if (isGradingTerminal(g)) return terminalRefusal(g);
  if (g.strategy !== "agent") return conflict("this grader does not use an agent");
  if (g.cancelIntent) return conflict("cancellation was requested; no evaluator may start");
  if (g.evaluator) return conflict("an evaluator is already registered");
  return advance(g, { evaluator: { kind: "agent", executionId: command.executionId } }, [{ type: "evaluator-registered", gradingId: g.id, kind: "agent", at: command.at }], "applied");
}

/** The evaluator's own agent is stopped (verified by the execution aggregate). */
export function evaluatorStopped(g: GradingRecord, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (isGradingTerminal(g)) return late(g, "step", command.at, "evaluator stop reported after the grading finished");
  if (g.evaluator?.kind !== "agent") return conflict("the grading has no managed evaluator");
  if (g.evaluatorStopped) return advance(g, {}, [], "applied");
  return settleCancel(g, { evaluatorStopped: true }, [{ type: "evaluator-stopped", gradingId: g.id, verified: true, at: command.at }], command.at, "applied");
}

/**
 * An external evaluator is a fresh session issued after the delivery was
 * frozen and different from the worker's. The trust model is a protocol
 * constraint on sessions, not an authentication of who the agent is.
 */
export function registerExternalEvaluator(g: GradingRecord, command: { sessionId: Id; agentId: string; workerSessionId?: Id; sessionIssuedAt: Timestamp; targetsFrozenAt: Timestamp; at: Timestamp }): Step {
  const bad = firstInvalid([["sessionId", isId(command.sessionId)], ["agentId", isText(command.agentId, 256)], ["sessionIssuedAt", isTimestamp(command.sessionIssuedAt)],
    ["targetsFrozenAt", isTimestamp(command.targetsFrozenAt)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (isGradingTerminal(g)) return terminalRefusal(g);
  if (g.strategy !== "agent") return conflict("this grader does not use an agent");
  if (g.cancelIntent) return conflict("cancellation was requested; no evaluator may start");
  if (g.evaluator) return conflict("an evaluator is already registered");
  if (command.workerSessionId !== undefined && command.workerSessionId === command.sessionId) return conflict("the evaluator must be a different session from the worker");
  if (Date.parse(command.sessionIssuedAt) < Date.parse(command.targetsFrozenAt)) return conflict("the evaluator session predates the frozen delivery");
  return advance(g, { evaluator: { kind: "external", sessionId: command.sessionId, agentId: command.agentId } }, [{ type: "evaluator-registered", gradingId: g.id, kind: "external", at: command.at }], "applied");
}

export function declareExternalEvaluatorStop(g: GradingRecord, command: { sessionId?: Id; at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (isGradingTerminal(g)) return late(g, "step", command.at, "evaluator stop declared after the grading finished");
  if (g.evaluator?.kind !== "external") return conflict("the grading has no external evaluator");
  if (command.sessionId !== undefined && command.sessionId !== g.evaluator.sessionId) return reject("forbidden", "the session identity does not match the evaluator");
  if (g.evaluator.stopDeclared) return advance(g, {}, [], "applied");
  return settleCancel(g, { evaluator: { ...g.evaluator, stopDeclared: command.at } }, [{ type: "evaluator-stopped", gradingId: g.id, verified: false, at: command.at }], command.at, "applied");
}

function externalEvaluatorOf(g: GradingRecord, sessionId: Id | undefined): { ok: true; evaluator: Extract<Evaluator, { kind: "external" }> } | { ok: false; error: { code: "conflict" | "forbidden"; message: string } } {
  const evaluator = g.evaluator;
  if (evaluator?.kind !== "external") return { ok: false, error: { code: "conflict", message: "the grading has no external evaluator" } };
  if (evaluator.migrated) return { ok: false, error: { code: "conflict", message: "a migrated registration keeps the facts it was taken over with" } };
  if (sessionId !== evaluator.sessionId) return { ok: false, error: { code: "forbidden", message: "the session identity does not match the evaluator" } };
  return { ok: true, evaluator };
}

/** Blind, freeze, reconcile, hand off, submit: in order, append-only, and the blind result never changes after the freeze. */
export function recordEvaluatorStage(g: GradingRecord, command: { sessionId: Id; stage: ProtocolStage; blindDigest?: Digest; at: Timestamp }): Step {
  const bad = firstInvalid([["stage", protocolStages.includes(command.stage)], ["blindDigest", command.blindDigest === undefined || isDigest(command.blindDigest)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const owner = externalEvaluatorOf(g, command.sessionId);
  if (!owner.ok) return reject(owner.error.code, owner.error.message);
  if (isGradingTerminal(g)) return late(g, "step", command.at, `protocol stage ${command.stage} after the grading was ${g.status}`);
  const protocol = owner.evaluator.protocol ?? [];
  const last = protocol[protocol.length - 1];
  if (last && last.stage === command.stage) return conflict(`the ${command.stage} stage was already recorded`);
  if (protocolStages.indexOf(command.stage) !== (last ? protocolStages.indexOf(last.stage) + 1 : 0)) return conflict(`the ${command.stage} stage does not follow ${last?.stage ?? "the start"}`);
  const frozen = protocol.find(r => r.stage === "freeze")?.blindDigest;
  if (command.stage === "freeze" && !command.blindDigest) return invalid("the freeze records the digest of the blind result");
  if (command.stage !== "freeze" && command.blindDigest !== undefined && command.blindDigest !== frozen) return conflict("the blind result was frozen and cannot change");
  const record: ProtocolRecord = { stage: command.stage, at: command.at, ...(command.stage === "freeze" ? { blindDigest: command.blindDigest } : {}) };
  return advance(g, { evaluator: { ...owner.evaluator, protocol: [...protocol, record] } }, [{ type: "protocol-stage", gradingId: g.id, stage: command.stage, at: command.at }], "applied");
}

/** A command the evaluator ran through a supported entry; kept append-only beside the stages. */
export function recordEvaluatorCommand(g: GradingRecord, command: { sessionId: Id; observation: CommandObservation }): Step {
  const o = command.observation;
  const bad = firstInvalid([["stage", protocolStages.includes(o.stage)], ["entry", isText(o.entry, 256)], ["argvDigest", isDigest(o.argvDigest)], ["state", ["succeeded", "failed", "unknown"].includes(o.state)], ["at", isTimestamp(o.at)]]);
  if (bad) return bad;
  const owner = externalEvaluatorOf(g, command.sessionId);
  if (!owner.ok) return reject(owner.error.code, owner.error.message);
  if (isGradingTerminal(g)) return late(g, "step", o.at, `command observed after the grading was ${g.status}`);
  return advance(g, { evaluator: { ...owner.evaluator, commandObservations: [...(owner.evaluator.commandObservations ?? []), o] } }, [{ type: "protocol-stage", gradingId: g.id, stage: o.stage, at: o.at }], "applied");
}

export function attachGradingSandbox(g: GradingRecord, command: { sandboxId: Id }): Step {
  if (!isId(command.sandboxId)) return invalid("sandboxId is required");
  if (isGradingTerminal(g)) return terminalRefusal(g);
  if (g.sandboxId !== undefined) return g.sandboxId === command.sandboxId ? advance(g, {}, [], "applied") : conflict("a different sandbox is already attached");
  return advance(g, { sandboxId: command.sandboxId }, [{ type: "sandbox-attached", gradingId: g.id, sandboxId: command.sandboxId }], "applied");
}

// ---- command steps (test graders) ----------------------------------------

export function startCommandStep(g: GradingRecord, command: { ordinal: number; specDigest: Digest; at: Timestamp }): Step {
  const bad = firstInvalid([["ordinal", isNonNegativeInteger(command.ordinal)], ["specDigest", isDigest(command.specDigest)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (isGradingTerminal(g)) return terminalRefusal(g);
  if (g.strategy !== "test") return conflict("only a test grader runs commands");
  if (g.cancelIntent) return conflict("cancellation was requested; no command may start");
  if (command.ordinal !== g.commandSteps.length) return conflict(`the next command step is ${g.commandSteps.length}`);
  const previous = g.commandSteps[g.commandSteps.length - 1];
  if (previous && previous.state !== "stopped_result") return conflict("the previous command has not stopped with a result");
  const step: CommandStep = { ordinal: command.ordinal, specDigest: command.specDigest, state: "running", startedAt: command.at };
  return advance(g, { commandSteps: [...g.commandSteps, step] }, [{ type: "command-step", gradingId: g.id, ordinal: step.ordinal, state: "running", at: command.at }], "applied");
}

function changeStep(g: GradingRecord, ordinal: number, change: Partial<CommandStep>): GradingRecord["commandSteps"] | undefined {
  const step = g.commandSteps[ordinal];
  if (!step) return undefined;
  return g.commandSteps.map(s => s.ordinal === ordinal ? { ...s, ...change } : s);
}

export function requestStepStop(g: GradingRecord, command: { ordinal: number; at: Timestamp }): Step {
  if (!isNonNegativeInteger(command.ordinal) || !isTimestamp(command.at)) return invalid("ordinal and at are required");
  if (isGradingTerminal(g)) return terminalRefusal(g);
  const step = g.commandSteps[command.ordinal];
  if (!step) return conflict("no such command step");
  if (step.state !== "running") return advance(g, {}, [], "applied");
  return advance(g, { commandSteps: changeStep(g, command.ordinal, { state: "stop_requested" })! }, [{ type: "command-step", gradingId: g.id, ordinal: command.ordinal, state: "stop_requested", at: command.at }], "applied");
}

export function stepStopUnknown(g: GradingRecord, command: { ordinal: number; at: Timestamp }): Step {
  if (!isNonNegativeInteger(command.ordinal) || !isTimestamp(command.at)) return invalid("ordinal and at are required");
  if (isGradingTerminal(g)) return late(g, "step", command.at, `command step ${command.ordinal} stop is unknown`);
  const step = g.commandSteps[command.ordinal];
  if (!step) return conflict("no such command step");
  if (step.state === "stopped_result" || step.state === "stopped_no_result") return conflict("the command already stopped");
  if (step.state === "stop_unknown") return advance(g, {}, [], "applied");
  return advance(g, { commandSteps: changeStep(g, command.ordinal, { state: "stop_unknown" })! }, [{ type: "command-step", gradingId: g.id, ordinal: command.ordinal, state: "stop_unknown", at: command.at }], "applied");
}

/**
 * A command was confirmed stopped. An exit code means a result; none means the
 * result is unknown, which makes the grading a grader fault unless cancellation
 * was requested first, in which case cancellation wins and the unknown is only kept as a diagnostic.
 */
export function stepStopped(g: GradingRecord, command: { ordinal: number; exitCode?: number; at: Timestamp }): Step {
  const bad = firstInvalid([["ordinal", isNonNegativeInteger(command.ordinal)], ["exitCode", command.exitCode === undefined || Number.isSafeInteger(command.exitCode)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (isGradingTerminal(g)) return late(g, "step", command.at, `command step ${command.ordinal} stopped after the grading finished`);
  const step = g.commandSteps[command.ordinal];
  if (!step) return conflict("no such command step");
  if (step.state === "stopped_result" || step.state === "stopped_no_result") return conflict("the command already stopped");
  const state: StepState = command.exitCode === undefined ? "stopped_no_result" : "stopped_result";
  const commandSteps = changeStep(g, command.ordinal, { state, stoppedAt: command.at, ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}) })!;
  const event: GradingEvent = { type: "command-step", gradingId: g.id, ordinal: command.ordinal, state, at: command.at };
  if (g.cancelIntent) return settleCancel(g, { commandSteps }, [event], command.at, "cancel-wins");
  if (state === "stopped_no_result") return advance(g, { commandSteps, status: "grader_fault", fault: `command step ${command.ordinal} stopped without a trustworthy exit result`, terminalAt: command.at }, [event, { type: "grader-fault", gradingId: g.id, at: command.at }], "applied");
  return advance(g, { commandSteps }, [event], "applied");
}

// ---- grades ---------------------------------------------------------------

/** What the grade must satisfy: the grader's declared scale and, for a gate, full coverage of the expected criteria. */
export function validateGrade(grade: Grade, scale: Scale, binding?: GateBinding): Result<void> {
  if (grade.form === "indeterminate") return isText(grade.reason, 1024) ? ok(undefined) : invalid("an indeterminate result says why");
  if (grade.form !== scale.form) return invalid(`the grader declares a ${scale.form} scale, not ${grade.form}`);
  if (grade.form === "numeric" && scale.form === "numeric") return Number.isFinite(grade.value) && grade.value >= scale.min && grade.value <= scale.max ? ok(undefined) : invalid(`the value is outside ${scale.min}..${scale.max}`);
  if (grade.form === "category" && scale.form === "category") return scale.categories.includes(grade.category) ? ok(undefined) : invalid("the category is not one the grader declares");
  if (grade.form === "criteria") {
    const verdicts: Verdict[] = ["satisfied", "unsatisfied", "indeterminate"];
    const relations = ["corroborated", "contradicted", "not_determined"];
    for (const item of grade.items) {
      if (!isId(item.criterionId) || !verdicts.includes(item.independent) || !verdicts.includes(item.final) || !relations.includes(item.reconciliation)) return invalid("every criterion verdict has an id, three verdicts and a reconciliation");
      if (!isText(item.rationale, 4096)) return invalid(`criterion ${item.criterionId} needs a rationale`);
      if (item.reusedFrom !== undefined && (!isId(item.reusedFrom) || item.final !== "satisfied")) return invalid("only a satisfied verdict can be taken over from an earlier record");
    }
    if (!unique(grade.items, i => i.criterionId)) return invalid("a criterion is judged once");
    if (binding) {
      const judged = new Set(grade.items.map(i => i.criterionId));
      if (judged.size !== binding.expectedCriteria.length || !binding.expectedCriteria.every(id => judged.has(id))) return invalid("a gate judges exactly the expected criteria");
    }
  }
  return ok(undefined);
}

/** Verify that every taken-over verdict comes from a completed gate with the identical binding that found it satisfied. */
function reuseIsSound(grade: Grade, binding: GateBinding | undefined, prior: readonly GradingRecord[]): Result<void> {
  if (grade.form !== "criteria" || !binding) return ok(undefined);
  for (const item of grade.items) {
    if (item.reusedFrom === undefined) continue;
    const source = prior.find(r => r.id === item.reusedFrom);
    if (!source || source.purpose !== "gate" || source.status !== "completed" || !source.binding || !sameBinding(source.binding, binding)) return conflict(`criterion ${item.criterionId} cannot be taken over: the earlier record's binding differs`);
    const earlier = source.grade?.form === "criteria" ? source.grade.items.find(i => i.criterionId === item.criterionId) : undefined;
    if (!earlier || earlier.final !== "satisfied") return conflict(`criterion ${item.criterionId} was not satisfied in the earlier record`);
  }
  return ok(undefined);
}

export function submitGrade(g: GradingRecord, command: { grade: Grade; sessionId?: Id; at: Timestamp }, context: { priorGates?: readonly GradingRecord[] } = {}): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (isGradingTerminal(g)) return late(g, "grade", command.at, `grade submitted after the grading was ${g.status}`);
  if (g.evaluator?.kind === "external" && command.sessionId !== g.evaluator.sessionId) return reject("forbidden", "the session identity does not match the evaluator");
  if (g.strategy === "agent" && !g.evaluator) return conflict("register the evaluator first");
  let base: Partial<GradingRecord> = {};
  const declared: GradingEvent[] = [];
  if (g.evaluator?.kind === "external" && !g.evaluator.stopDeclared) {
    base = { evaluator: { ...g.evaluator, stopDeclared: command.at } };
    declared.push({ type: "evaluator-stopped", gradingId: g.id, verified: false, at: command.at });
  }
  if (g.cancelIntent) {
    const record: GradingLate = { kind: "grade", at: command.at, detail: "grade submitted after cancellation was requested" };
    return settleCancel(g, { ...base, lateRecords: [...g.lateRecords, record] }, [...declared, { type: "late-record", gradingId: g.id, kind: "grade", at: command.at }], command.at, "cancel-wins");
  }
  const valid = validateGrade(command.grade, g.scale, g.binding);
  if (!valid.ok) return valid;
  const sound = reuseIsSound(command.grade, g.binding, context.priorGates ?? []);
  if (!sound.ok) return sound;
  if (g.strategy === "test") {
    if (g.commandSteps.length === 0) return conflict("a test grader runs at least one command");
    if (g.commandSteps.some(s => s.state !== "stopped_result")) return conflict("every command must have stopped with a result");
  }
  if (g.evaluator?.kind === "agent" && !g.evaluatorStopped) return conflict("the evaluator's stop is not verified");
  return advance(g, { ...base, status: "completed", grade: command.grade, terminalAt: command.at }, [...declared, { type: "completed", gradingId: g.id, at: command.at }], "applied");
}

/**
 * A gate of the previous model, taken over in its final state: an external
 * evaluator that is marked as migrated, with the protocol facts the old
 * ledger kept and no invented trajectory. When the old ledger did not keep
 * the session, none is made up and the independence guarantee stays unknown.
 */
export function importLegacyGate(command: {
  id: Id; requestSeq: number; taskRunId: Id; target: TargetRef; graderRevision: RevisionRef; binding: GateBinding; materials: readonly { id: Id; digest: Digest }[];
  evaluator: { sessionId?: Id; agentId?: string; protocol: readonly ProtocolRecord[]; commandObservations: readonly CommandObservation[] };
  grade: Grade; createdAt: Timestamp; completedAt: Timestamp;
}): Result<Decision<GradingRecord, GradingEvent>> {
  const bad = firstInvalid([["completedAt", isTimestamp(command.completedAt)], ["sessionId", command.evaluator.sessionId === undefined || isId(command.evaluator.sessionId)],
    ["agentId", command.evaluator.agentId === undefined || isText(command.evaluator.agentId, 256)],
    ["protocol", command.evaluator.protocol.every(r => protocolStages.includes(r.stage) && isTimestamp(r.at) && (r.blindDigest === undefined || isDigest(r.blindDigest)))],
    ["commandObservations", command.evaluator.commandObservations.every(o => protocolStages.includes(o.stage) && isText(o.entry, 256) && isDigest(o.argvDigest) && isTimestamp(o.at))]]);
  if (bad) return bad;
  if (command.grade.form !== "criteria") return invalid("a legacy gate carries criterion verdicts");
  const created = createGrading({ id: command.id, purpose: "gate", origin: { type: "gate", taskRunId: command.taskRunId }, requestSeq: command.requestSeq, targets: [command.target], graderRevision: command.graderRevision,
    grader: { strategy: "agent", scale: { form: "criteria" } }, materials: command.materials, binding: command.binding, at: command.createdAt });
  if (!created.ok) return created;
  const valid = validateGrade(command.grade, { form: "criteria" }, command.binding);
  if (!valid.ok) return valid;
  const evaluator: Evaluator = { kind: "external", ...(command.evaluator.sessionId ? { sessionId: command.evaluator.sessionId } : {}), ...(command.evaluator.agentId ? { agentId: command.evaluator.agentId } : {}),
    stopDeclared: command.completedAt, migrated: true, protocol: command.evaluator.protocol, commandObservations: command.evaluator.commandObservations };
  const state: GradingRecord = { ...created.value.state, evaluator, status: "completed", grade: command.grade, terminalAt: command.completedAt };
  const problems = gradingViolations(state);
  if (problems.length > 0) return invalid(`the imported gate is inconsistent: ${problems.join("; ")}`);
  return ok({ state, events: [...created.value.events, { type: "evaluator-registered", gradingId: state.id, kind: "external", at: command.createdAt }, { type: "completed", gradingId: state.id, at: command.completedAt }], outcome: undefined });
}

/** The grader itself broke (not the thing being graded): never a score, never a quality verdict. */
export function faultGrader(g: GradingRecord, command: { detail: string; at: Timestamp }): Step {
  if (!isText(command.detail, 1024) || !isTimestamp(command.at)) return invalid("detail and at are required");
  if (isGradingTerminal(g)) return late(g, "fault", command.at, command.detail);
  if (g.cancelIntent) return settleCancel(g, {}, [], command.at, "cancel-wins");
  return advance(g, { status: "grader_fault", fault: command.detail, terminalAt: command.at }, [{ type: "grader-fault", gradingId: g.id, at: command.at }], "applied");
}

export function requestGradingCancel(g: GradingRecord, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (isGradingTerminal(g)) return advance(g, {}, [], "already-terminal");
  if (g.cancelIntent) return advance(g, {}, [], "applied");
  return settleCancel(g, { cancelIntent: { at: command.at } }, [{ type: "cancel-requested", gradingId: g.id, at: command.at }], command.at, "applied");
}

// ---- acceptance -----------------------------------------------------------

export interface Acceptance {
  readonly conclusion: AcceptanceConclusion;
  /** The record the conclusion is read from. */
  readonly adopted?: Id;
  /** An earlier complete record on the same subject reached a different conclusion; shown, not blocking. */
  readonly disputed: boolean;
}
const conclusionOf = (g: GradingRecord): "accepted" | "rejected" => g.grade?.form === "criteria" && g.grade.items.every(i => i.final === "satisfied") ? "accepted" : "rejected";
const isCompleteGate = (g: GradingRecord): boolean => g.purpose === "gate" && g.status === "completed" && g.grade?.form === "criteria" && g.binding !== undefined
  && g.grade.items.length === g.binding.expectedCriteria.length && g.binding.expectedCriteria.every(id => (g.grade as { items: readonly CriterionVerdict[] }).items.some(i => i.criterionId === id));

/** The acceptance of one delivered run: the latest complete gate on that exact subject, whatever grader or materials produced it. */
export function acceptanceOf(records: readonly GradingRecord[], subject: { taskRevisionId: Id; criteriaDigest: Digest; manifestDigest: Digest }): Acceptance {
  const reference = { taskRevision: { revisionId: subject.taskRevisionId }, criteriaDigest: subject.criteriaDigest, manifestDigest: subject.manifestDigest } as GateBinding;
  const matching = records.filter(r => isCompleteGate(r) && sameSubject(r.binding!, reference)).sort((a, b) => a.requestSeq - b.requestSeq);
  const latest = matching[matching.length - 1];
  if (!latest) return { conclusion: "pending", disputed: false };
  const conclusion = conclusionOf(latest);
  return { conclusion, adopted: latest.id, disputed: matching.some(r => conclusionOf(r) !== conclusion) };
}

/** Digest of everything that makes up the materials a grading used, for binding. */
export function materialsDigest(materials: readonly { id: Id; digest: Digest }[], hash: Hasher): Result<Digest> {
  return digestOf([...materials].sort((a, b) => a.id.localeCompare(b.id)).map(m => ({ id: m.id, digest: m.digest })), hash);
}

export function gradingViolations(g: GradingRecord): string[] {
  const problems: string[] = [];
  const terminal = isGradingTerminal(g);
  if (terminal !== (g.terminalAt !== undefined)) problems.push("terminalAt is set exactly when the grading is finished");
  if ((g.status === "completed") !== (g.grade !== undefined)) problems.push("a grade exists exactly when the grading completed");
  if ((g.status === "grader_fault") !== (g.fault !== undefined)) problems.push("a fault is recorded exactly when the grader failed");
  if (g.status === "cancelled" && !g.cancelIntent) problems.push("a cancelled grading was asked to cancel");
  if (g.status === "cancelled" && !gradingQuiescent(g)) problems.push("a cancelled grading has nothing running");
  if (g.status === "completed" && g.grade) {
    const valid = validateGrade(g.grade, g.scale, g.binding);
    if (!valid.ok) problems.push(`the grade is valid for its scale: ${valid.error.message}`);
    if (g.strategy === "test" && !g.commandSteps.every(s => s.state === "stopped_result")) problems.push("a completed test grading has every command stopped with a result");
  }
  if (g.purpose === "gate" && (!g.binding || g.scale.form !== "criteria")) problems.push("a gate has a binding and a criteria scale");
  if (g.purpose === "measure" && g.binding) problems.push("a measure has no binding");
  if (g.evaluator?.kind === "external" && !g.evaluator.migrated && (g.evaluator.sessionId === undefined || g.evaluator.agentId === undefined)) problems.push("an external evaluator that was not migrated has a session and an agent identity");
  if (g.commandSteps.some((s, i) => s.ordinal !== i)) problems.push("command steps are numbered in sequence");
  if (g.commandSteps.filter(s => s.state === "running" || s.state === "stop_requested" || s.state === "stop_unknown").length > 1) problems.push("one command runs at a time");
  if (g.strategy !== "test" && g.commandSteps.length > 0) problems.push("only a test grader has command steps");
  return problems;
}
