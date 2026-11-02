import { advance, conflict, firstInvalid, invalid, isDigest, isId, isText, isTimestamp, ok, reject, type Decision, type Digest, type Id, type Result, type Timestamp, type Versioned } from "./kernel.js";
import { isRevisionRef, type RevisionRef } from "./definitions.js";

/** What a provider declares it can do; the application checks this before relying on a capability. */
export interface Capabilities { readonly resume: boolean; readonly verifiableStop: boolean; readonly events: "full" | "partial" | "none" }

export type ExecutionStage = "accepted" | "preparing" | "running" | "archiving" | "archive_blocked" | "succeeded" | "failed" | "interrupted" | "cancelled";
/** idle: never started; active: a process may be running; requested: stop asked for, unconfirmed; verified: confirmed stopped; unknown: cannot tell. */
export type StopState = "idle" | "active" | "requested" | "verified" | "unknown";
export type ExecutionOwner = { readonly type: "task_run" | "grading_record"; readonly id: Id };
export type ReceiptKind = "output" | "trajectory" | "delivery-claim";

export const protocolStages = ["blind", "freeze", "reconcile", "handoff", "submit"] as const;
export type ProtocolStage = (typeof protocolStages)[number];
export interface ProtocolRecord { readonly stage: ProtocolStage; readonly at: Timestamp; readonly blindDigest?: Digest }
/** A command the evaluator ran through a supported entry; kept append-only beside the protocol stages. */
export interface CommandObservation { readonly stage: ProtocolStage; readonly entry: string; readonly argvDigest: Digest; readonly state: "succeeded" | "failed" | "unknown"; readonly exitCode?: number; readonly at: Timestamp }
export interface ExecutionLate { readonly kind: "receipt" | "stop" | "outcome"; readonly at: Timestamp; readonly detail: string }

export interface AgentExecution extends Versioned {
  readonly id: Id;
  readonly owner: ExecutionOwner;
  readonly role: "worker" | "evaluator";
  readonly agentRevision: RevisionRef;
  readonly capabilities: Capabilities;
  readonly stage: ExecutionStage;
  readonly stop: StopState;
  readonly sandboxId?: Id;
  /** The one process allowed to drive this execution at a time. */
  readonly runner?: { readonly id: Id; readonly epoch: number };
  readonly lastEpoch: number;
  readonly sessionRef?: string;
  readonly providerOutcome?: "succeeded" | "failed";
  readonly receipts: { readonly output?: string; readonly trajectory?: string; readonly deliveryClaim?: string };
  readonly archiveBlockedReason?: string;
  readonly cancelIntent?: { readonly at: Timestamp };
  readonly protocol: readonly ProtocolRecord[];
  readonly commandObservations: readonly CommandObservation[];
  readonly lateRecords: readonly ExecutionLate[];
  readonly createdAt: Timestamp;
  readonly terminalAt?: Timestamp;
}

export type ExecutionEvent =
  | { readonly type: "accepted"; readonly executionId: Id; readonly at: Timestamp }
  | { readonly type: "stage"; readonly executionId: Id; readonly stage: ExecutionStage; readonly at: Timestamp }
  | { readonly type: "runner-claimed"; readonly executionId: Id; readonly runnerId: Id; readonly epoch: number; readonly at: Timestamp }
  | { readonly type: "runner-released"; readonly executionId: Id; readonly at: Timestamp }
  | { readonly type: "receipt-recorded"; readonly executionId: Id; readonly kind: ReceiptKind; readonly at: Timestamp }
  | { readonly type: "stop"; readonly executionId: Id; readonly state: StopState; readonly at: Timestamp }
  | { readonly type: "cancel-requested"; readonly executionId: Id; readonly at: Timestamp }
  | { readonly type: "protocol-stage"; readonly executionId: Id; readonly stage: ProtocolStage; readonly at: Timestamp }
  | { readonly type: "late-record"; readonly executionId: Id; readonly kind: ExecutionLate["kind"]; readonly at: Timestamp };

type Step = Result<Decision<AgentExecution, ExecutionEvent, "applied" | "late" | "already-terminal">>;
const terminalStages: readonly ExecutionStage[] = ["succeeded", "failed", "interrupted", "cancelled"];
export const isExecutionTerminal = (e: AgentExecution): boolean => terminalStages.includes(e.stage);
const isOwner = (o: unknown): o is ExecutionOwner => !!o && typeof o === "object" && ["task_run", "grading_record"].includes((o as ExecutionOwner).type) && isId((o as ExecutionOwner).id);

export function acceptExecution(command: { id: Id; owner: ExecutionOwner; role: "worker" | "evaluator"; agentRevision: RevisionRef; capabilities: Capabilities; at: Timestamp }): Result<Decision<AgentExecution, ExecutionEvent>> {
  const bad = firstInvalid([["id", isId(command.id)], ["owner", isOwner(command.owner)], ["role", command.role === "worker" || command.role === "evaluator"],
    ["agentRevision", isRevisionRef(command.agentRevision, "agent")], ["capabilities", typeof command.capabilities?.resume === "boolean" && typeof command.capabilities.verifiableStop === "boolean" && ["full", "partial", "none"].includes(command.capabilities.events)],
    ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (command.role === "worker" && command.owner.type !== "task_run") return invalid("a worker belongs to a task run");
  if (command.role === "evaluator" && command.owner.type !== "grading_record") return invalid("an evaluator belongs to a grading record");
  const state: AgentExecution = { id: command.id, owner: command.owner, role: command.role, agentRevision: command.agentRevision, capabilities: command.capabilities, stage: "accepted", stop: "idle", lastEpoch: 0,
    receipts: {}, protocol: [], commandObservations: [], lateRecords: [], createdAt: command.at, version: 1 };
  return ok({ state, events: [{ type: "accepted", executionId: state.id, at: command.at }], outcome: undefined });
}

function late(e: AgentExecution, kind: ExecutionLate["kind"], at: Timestamp, detail: string): Step {
  return advance(e, { lateRecords: [...e.lateRecords, { kind, at, detail }] }, [{ type: "late-record", executionId: e.id, kind, at } as ExecutionEvent], "late");
}
const stageEvent = (e: AgentExecution, stage: ExecutionStage, at: Timestamp): ExecutionEvent => ({ type: "stage", executionId: e.id, stage, at });

/** Settle into a terminal stage if the stop is verified and the conditions for one are met; otherwise just apply `base`. */
function settle(e: AgentExecution, base: Partial<AgentExecution>, events: ExecutionEvent[], at: Timestamp): Step {
  const c = { ...e, ...base } as AgentExecution;
  const terminal = (stage: ExecutionStage, extra: Partial<AgentExecution> = {}): Step =>
    advance(e, { ...base, ...extra, stage, terminalAt: at, runner: undefined, archiveBlockedReason: undefined }, [...events, stageEvent(e, stage, at)], "applied");
  if (c.cancelIntent && c.stop === "verified") return terminal("cancelled");
  if (c.cancelIntent && c.stop === "idle") return terminal("cancelled");
  if (c.stage === "archiving" && c.stop === "verified" && !c.cancelIntent) {
    if (c.providerOutcome === "failed") return terminal("failed");
    if (c.providerOutcome === "succeeded" && c.receipts.output && c.receipts.trajectory) return terminal("succeeded");
  }
  return advance(e, base, events, "applied");
}

export function prepareExecution(e: AgentExecution, command: { sandboxId: Id; at: Timestamp }): Step {
  const bad = firstInvalid([["sandboxId", isId(command.sandboxId)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (isExecutionTerminal(e)) return conflict(`the execution is ${e.stage}`);
  if (e.cancelIntent) return conflict("cancellation was requested; nothing new may start");
  if (e.stage !== "accepted") return conflict("the execution has already been prepared");
  return advance(e, { stage: "preparing", sandboxId: command.sandboxId }, [stageEvent(e, "preparing", command.at)], "applied");
}

/** Exactly one runner drives an execution at a time; a second claimant is refused until the first is released. */
export function claimRunner(e: AgentExecution, command: { runnerId: Id; at: Timestamp }): Step {
  const bad = firstInvalid([["runnerId", isId(command.runnerId)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (isExecutionTerminal(e)) return conflict(`the execution is ${e.stage}`);
  if (e.stage === "accepted") return conflict("prepare the execution first");
  if (e.runner) return e.runner.id === command.runnerId ? advance(e, {}, [], "applied") : conflict("another runner drives this execution");
  const epoch = e.lastEpoch + 1;
  return advance(e, { runner: { id: command.runnerId, epoch }, lastEpoch: epoch }, [{ type: "runner-claimed", executionId: e.id, runnerId: command.runnerId, epoch, at: command.at }], "applied");
}

export function releaseRunner(e: AgentExecution, command: { runnerId: Id; at: Timestamp }): Step {
  if (!isId(command.runnerId) || !isTimestamp(command.at)) return invalid("runnerId and at are required");
  if (!e.runner || e.runner.id !== command.runnerId) return advance(e, {}, [], "applied");
  return advance(e, { runner: undefined }, [{ type: "runner-released", executionId: e.id, at: command.at }], "applied");
}

export function beginExecution(e: AgentExecution, command: { runnerId: Id; sessionRef?: string; at: Timestamp }): Step {
  if (!isTimestamp(command.at) || !isId(command.runnerId)) return invalid("runnerId and at are required");
  if (isExecutionTerminal(e)) return conflict(`the execution is ${e.stage}`);
  if (e.cancelIntent) return conflict("cancellation was requested; nothing new may start");
  if (e.stage !== "preparing") return conflict("only a prepared execution begins");
  if (e.runner?.id !== command.runnerId) return conflict("only the runner holding the execution can begin it");
  return advance(e, { stage: "running", stop: "active", ...(command.sessionRef ? { sessionRef: command.sessionRef } : {}) }, [stageEvent(e, "running", command.at)], "applied");
}

/** The provider returned. That says how the run ended, not that its output is archived or its process confirmed stopped. */
export function providerEnded(e: AgentExecution, command: { outcome: "succeeded" | "failed"; at: Timestamp }): Step {
  if (!isTimestamp(command.at) || (command.outcome !== "succeeded" && command.outcome !== "failed")) return invalid("outcome and at are required");
  if (isExecutionTerminal(e)) return late(e, "outcome", command.at, `provider ended (${command.outcome}) after ${e.stage}`);
  if (e.stage === "archiving" || e.stage === "archive_blocked") return e.providerOutcome === command.outcome ? advance(e, {}, [], "applied") : conflict("the provider's outcome was already recorded");
  if (e.stage !== "running") return conflict("the execution is not running");
  return settle(e, { stage: "archiving", providerOutcome: command.outcome }, [stageEvent(e, "archiving", command.at)], command.at);
}

export function recordReceipt(e: AgentExecution, command: { kind: ReceiptKind; ref: string; at: Timestamp }): Step {
  const bad = firstInvalid([["kind", ["output", "trajectory", "delivery-claim"].includes(command.kind)], ["ref", isText(command.ref, 1024)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (isExecutionTerminal(e)) return late(e, "receipt", command.at, `${command.kind} receipt after ${e.stage}`);
  if (!["running", "archiving", "archive_blocked"].includes(e.stage)) return conflict("nothing can be archived yet");
  const key = command.kind === "output" ? "output" : command.kind === "trajectory" ? "trajectory" : "deliveryClaim";
  if (e.receipts[key] === command.ref) return advance(e, {}, [], "applied");
  if (e.receipts[key] !== undefined) return conflict(`a ${command.kind} receipt was already recorded`);
  const unblocked: Partial<AgentExecution> = e.stage === "archive_blocked" ? { stage: "archiving", archiveBlockedReason: undefined } : {};
  return settle(e, { ...unblocked, receipts: { ...e.receipts, [key]: command.ref } }, [{ type: "receipt-recorded", executionId: e.id, kind: command.kind, at: command.at }], command.at);
}

/** Archiving failed for now. The original output is kept; only the archive is retried, never the model. */
export function blockArchive(e: AgentExecution, command: { reason: string; at: Timestamp }): Step {
  if (!isText(command.reason, 1024) || !isTimestamp(command.at)) return invalid("reason and at are required");
  if (isExecutionTerminal(e)) return conflict(`the execution is ${e.stage}`);
  if (e.stage !== "archiving") return conflict("only an execution that is archiving can be blocked");
  return advance(e, { stage: "archive_blocked", archiveBlockedReason: command.reason }, [stageEvent(e, "archive_blocked", command.at)], "applied");
}

export function retryArchive(e: AgentExecution, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (e.stage !== "archive_blocked") return isExecutionTerminal(e) ? conflict(`the execution is ${e.stage}`) : advance(e, {}, [], "applied");
  return advance(e, { stage: "archiving", archiveBlockedReason: undefined }, [stageEvent(e, "archiving", command.at)], "applied");
}

/** The process was confirmed stopped. Only a provider that can verify a stop may say so. */
export function confirmExecutionStopped(e: AgentExecution, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (isExecutionTerminal(e)) return late(e, "stop", command.at, `stop confirmed after ${e.stage}`);
  if (!e.capabilities.verifiableStop) return reject("unsupported", "this provider cannot verify that a process stopped");
  if (e.stop === "verified") return advance(e, {}, [], "applied");
  if (e.stop === "idle") return conflict("the execution never started");
  return settle(e, { stop: "verified" }, [{ type: "stop", executionId: e.id, state: "verified", at: command.at }], command.at);
}

export function reportExecutionStopUnknown(e: AgentExecution, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (isExecutionTerminal(e)) return conflict(`the execution is ${e.stage}`);
  if (e.stop === "verified" || e.stop === "idle") return conflict("there is nothing running whose stop could be unknown");
  if (e.stop === "unknown") return advance(e, {}, [], "applied");
  return advance(e, { stop: "unknown" }, [{ type: "stop", executionId: e.id, state: "unknown", at: command.at }], "applied");
}

/** The host driving the execution was lost: nobody drives it any more and its stop cannot be assumed. */
export function executionHostLost(e: AgentExecution, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (isExecutionTerminal(e)) return conflict(`the execution is ${e.stage}`);
  const base: Partial<AgentExecution> = { runner: undefined, ...(e.stop === "active" || e.stop === "requested" ? { stop: "unknown" as StopState } : {}) };
  const events: ExecutionEvent[] = [];
  if (e.runner) events.push({ type: "runner-released", executionId: e.id, at: command.at });
  if (base.stop) events.push({ type: "stop", executionId: e.id, state: "unknown", at: command.at });
  return advance(e, base, events, "applied");
}

/** Continue the same execution; only a provider that declared it can resume, and only after its stop was verified. */
export function resumeExecution(e: AgentExecution, command: { runnerId: Id; at: Timestamp }): Step {
  if (!isId(command.runnerId) || !isTimestamp(command.at)) return invalid("runnerId and at are required");
  if (isExecutionTerminal(e)) return conflict(`the execution is ${e.stage}`);
  if (!e.capabilities.resume) return reject("unsupported", "this provider cannot resume a session; start a new execution instead");
  if (e.cancelIntent) return conflict("cancellation was requested");
  if (e.runner) return conflict("another runner drives this execution");
  if (e.stop !== "verified") return conflict("the previous process must be confirmed stopped before resuming");
  if (e.stage !== "running") return conflict("only a running execution can be resumed");
  const epoch = e.lastEpoch + 1;
  return advance(e, { runner: { id: command.runnerId, epoch }, lastEpoch: epoch, stop: "active" }, [{ type: "runner-claimed", executionId: e.id, runnerId: command.runnerId, epoch, at: command.at }], "applied");
}

/** A provider that cannot resume ends here once the lost process is confirmed stopped. */
export function interruptExecution(e: AgentExecution, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (isExecutionTerminal(e)) return advance(e, {}, [], "already-terminal");
  if (e.capabilities.resume) return conflict("this provider can resume; resume instead of interrupting");
  if (e.runner) return conflict("a runner still drives this execution");
  if (!["preparing", "running"].includes(e.stage)) return conflict("only a preparing or running execution is interrupted");
  if (e.stop !== "verified") return conflict("the process must be confirmed stopped first");
  return advance(e, { stage: "interrupted", terminalAt: command.at }, [stageEvent(e, "interrupted", command.at)], "applied");
}

export function requestExecutionCancel(e: AgentExecution, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (isExecutionTerminal(e)) return advance(e, {}, [], "already-terminal");
  if (e.cancelIntent) return advance(e, {}, [], "applied");
  const stopping: Partial<AgentExecution> = e.stop === "active" ? { stop: "requested" } : {};
  const events: ExecutionEvent[] = [{ type: "cancel-requested", executionId: e.id, at: command.at }, ...(e.stop === "active" ? [{ type: "stop" as const, executionId: e.id, state: "requested" as const, at: command.at }] : [])];
  return settle(e, { cancelIntent: { at: command.at }, ...stopping }, events, command.at);
}

// ---- evaluator protocol ---------------------------------------------------

/** Blind, freeze, reconcile, hand off, submit: in order, append-only, and the blind result never changes after the freeze. */
export function recordProtocolStage(e: AgentExecution, command: { stage: ProtocolStage; blindDigest?: Digest; at: Timestamp }): Step {
  const bad = firstInvalid([["stage", protocolStages.includes(command.stage)], ["blindDigest", command.blindDigest === undefined || isDigest(command.blindDigest)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (e.role !== "evaluator") return conflict("only an evaluator follows the protocol");
  if (isExecutionTerminal(e)) return late(e, "outcome", command.at, `protocol stage ${command.stage} after ${e.stage}`);
  const last = e.protocol[e.protocol.length - 1];
  const index = protocolStages.indexOf(command.stage);
  if (last && last.stage === command.stage) return conflict(`the ${command.stage} stage was already recorded`);
  if (index !== (last ? protocolStages.indexOf(last.stage) + 1 : 0)) return conflict(`the ${command.stage} stage does not follow ${last?.stage ?? "the start"}`);
  const frozen = e.protocol.find(r => r.stage === "freeze")?.blindDigest;
  if (command.stage === "freeze" && !command.blindDigest) return invalid("the freeze records the digest of the blind result");
  if (command.stage !== "freeze" && command.blindDigest !== undefined && command.blindDigest !== frozen) return conflict("the blind result was frozen and cannot change");
  const record: ProtocolRecord = { stage: command.stage, at: command.at, ...(command.stage === "freeze" ? { blindDigest: command.blindDigest } : {}) };
  return advance(e, { protocol: [...e.protocol, record] }, [{ type: "protocol-stage", executionId: e.id, stage: command.stage, at: command.at }], "applied");
}

export function recordCommandObservation(e: AgentExecution, observation: CommandObservation): Step {
  const bad = firstInvalid([["stage", protocolStages.includes(observation.stage)], ["entry", isText(observation.entry, 256)], ["argvDigest", isDigest(observation.argvDigest)],
    ["state", ["succeeded", "failed", "unknown"].includes(observation.state)], ["at", isTimestamp(observation.at)]]);
  if (bad) return bad;
  if (e.role !== "evaluator") return conflict("only an evaluator records observed commands");
  return advance(e, { commandObservations: [...e.commandObservations, observation] }, [{ type: "protocol-stage", executionId: e.id, stage: observation.stage, at: observation.at }], "applied");
}

export function executionViolations(e: AgentExecution): string[] {
  const problems: string[] = [];
  const terminal = isExecutionTerminal(e);
  if (terminal !== (e.terminalAt !== undefined)) problems.push("terminalAt is set exactly when the execution is finished");
  if (terminal && e.runner) problems.push("a finished execution has no runner");
  if (e.stage === "succeeded" && !(e.receipts.output && e.receipts.trajectory && e.stop === "verified" && e.providerOutcome === "succeeded")) problems.push("success needs a verified stop and both receipts");
  if (e.stage === "failed" && (e.stop !== "verified" || e.providerOutcome !== "failed")) problems.push("failure of the provider is recorded and its stop verified");
  if (e.stage === "interrupted" && (e.stop !== "verified" || e.capabilities.resume)) problems.push("only a non-resumable provider is interrupted, after a verified stop");
  if (e.stage === "cancelled" && (!e.cancelIntent || (e.stop !== "verified" && e.stop !== "idle"))) problems.push("cancellation completes after a stop was verified");
  if (e.stage === "accepted" && (e.stop !== "idle" || e.runner)) problems.push("an execution that has not started has nothing running");
  if (e.stage === "running" && e.stop === "idle") problems.push("a running execution has a process");
  if ((e.stage === "archive_blocked") !== (e.archiveBlockedReason !== undefined)) problems.push("a blocked archive says why");
  if (e.role === "worker" && (e.protocol.length > 0 || e.commandObservations.length > 0)) problems.push("only an evaluator has protocol records");
  const frozen = e.protocol.filter(r => r.stage === "freeze");
  if (frozen.length > 1 || e.protocol.some((r, i) => protocolStages.indexOf(r.stage) !== i)) problems.push("protocol stages are in order and the freeze happens once");
  return problems;
}
