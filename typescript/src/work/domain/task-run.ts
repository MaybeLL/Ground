import { advance, conflict, firstInvalid, invalid, isDigest, isId, isText, isTimestamp, ok, reject, unique, type Decision, type Digest, type Id, type Result, type Timestamp, type Versioned } from "./kernel.js";
import { isRevisionRef, type ResolvedEnvironment, type RevisionRef } from "./definitions.js";

export type TaskRunStatus = "pending" | "running" | "delivered" | "failed" | "cancelled";
export type FailureClass = "agent-output" | "agent-execution" | "infrastructure";
export type Retention = "release" | "keep";
/** Who does the work of this round: a managed AgentExecution, the user's own agent, or nobody (a person supplies the manifest). */
export type WorkerMode = "managed" | "external" | "none";
export type ManifestOrigin = "tool" | "contract" | "external" | "caller";
export type ReceiptCheck = "accepted" | "rejected" | "unavailable";
export type BlockReason = "receipt-unavailable" | "archive-blocked" | "stop-unknown" | "awaiting-external-stop";

export interface DeliveryItem { readonly type: "candidate" | "artifact"; readonly id: Id; readonly receipt: string }
export interface Manifest {
  readonly origin: ManifestOrigin;
  readonly items: readonly DeliveryItem[];
  readonly trajectoryReceipt?: string;
  readonly digest: Digest;
  readonly operationId: Id;
  readonly frozenAt: Timestamp;
}

export type TraceBlob = {digest: Digest; byteLength: number; chunkCount: number};
export type FrozenTrace = { format: "grounds.provider-trace/v1"; provider: "claude-code" | "codex"; raw: TraceBlob; events: TraceBlob; records: number; convertedRecords: number; eventCount: number; omissions: { invalidUtf8:number; invalidJson:number; oversized:number; unknownRecords:number; unknownParts:number; unserializableParts:number } };
export interface TranscriptImport { readonly trace?: FrozenTrace; readonly ref: string; readonly digest: Digest; readonly coverage: "full" | "partial" | "unknown"; readonly importedAt: Timestamp }
export interface ExternalRegistration {
  /** Issued by Grounds at registration; every submission must present it. */
  readonly sessionId: Id;
  readonly agent: { readonly id: string; readonly name?: string; readonly model?: string };
  readonly registeredAt: Timestamp;
  /** A declaration, never a verified fact. */
  readonly stop?: { readonly declaredAt: Timestamp; readonly reason: "submitted" | "abandoned" | "human" };
  readonly transcripts: readonly TranscriptImport[];
}
export type Worker =
  | { readonly kind: "managed"; readonly executionId: Id; readonly stop: "active" | "unknown" | "verified"; readonly outcome?: "succeeded" | "failed" }
  | { readonly kind: "external"; readonly registration: ExternalRegistration };

/** A receipt that reached a run which could no longer act on it. Kept as history only. */
export interface LateRecord { readonly kind: "manifest" | "worker-stop" | "failure"; readonly at: Timestamp; readonly detail: string }

export interface TaskRun extends Versioned {
  readonly id: Id;
  readonly taskRevision: RevisionRef;
  readonly workId?: Id;
  readonly refines?: Id;
  readonly workerMode: WorkerMode;
  readonly retention: Retention;
  readonly status: TaskRunStatus;
  readonly environment?: ResolvedEnvironment;
  readonly sandboxId?: Id;
  readonly worker?: Worker;
  readonly manifest?: Manifest;
  readonly pendingManifest?: { readonly operationId: Id; readonly origin: ManifestOrigin };
  readonly cancelIntent?: { readonly at: Timestamp; readonly reason?: string };
  readonly blocked?: { readonly reason: BlockReason; readonly at: Timestamp };
  readonly failure?: { readonly class: FailureClass; readonly detail: string; readonly at: Timestamp };
  readonly lateRecords: readonly LateRecord[];
  readonly createdAt: Timestamp;
  readonly terminalAt?: Timestamp;
}

export type TaskRunEvent =
  | { readonly type: "created"; readonly runId: Id; readonly refines?: Id; readonly at: Timestamp }
  | { readonly type: "started"; readonly runId: Id; readonly at: Timestamp }
  | { readonly type: "sandbox-attached"; readonly runId: Id; readonly sandboxId: Id }
  | { readonly type: "worker-registered"; readonly runId: Id; readonly worker: "managed" | "external"; readonly at: Timestamp }
  | { readonly type: "worker-stopped"; readonly runId: Id; readonly verified: boolean; readonly at: Timestamp }
  | { readonly type: "transcript-imported"; readonly runId: Id; readonly digest: Digest; readonly at: Timestamp }
  | { readonly type: "manifest-frozen"; readonly runId: Id; readonly digest: Digest; readonly origin: ManifestOrigin; readonly at: Timestamp }
  | { readonly type: "manifest-unavailable"; readonly runId: Id; readonly operationId: Id; readonly at: Timestamp }
  | { readonly type: "delivered"; readonly runId: Id; readonly at: Timestamp }
  | { readonly type: "failed"; readonly runId: Id; readonly class: FailureClass; readonly at: Timestamp }
  | { readonly type: "cancel-requested"; readonly runId: Id; readonly at: Timestamp }
  | { readonly type: "cancelled"; readonly runId: Id; readonly at: Timestamp }
  | { readonly type: "blocked"; readonly runId: Id; readonly reason: BlockReason; readonly at: Timestamp }
  | { readonly type: "unblocked"; readonly runId: Id; readonly at: Timestamp }
  | { readonly type: "late-record"; readonly runId: Id; readonly kind: LateRecord["kind"]; readonly at: Timestamp };

type Outcome = "applied" | "late" | "cancel-wins" | "already-terminal" | "already-requested";
type Step = Result<Decision<TaskRun, TaskRunEvent, Outcome>>;

export const isTerminal = (run: TaskRun): boolean => run.status === "delivered" || run.status === "failed" || run.status === "cancelled";

/** True when nothing of this round can still be running: no worker, a verified stop, or a stop declaration. */
export function quiescent(run: TaskRun): boolean {
  const worker = run.worker;
  if (!worker) return true; // nothing was registered, so nothing of this round can be running
  return worker.kind === "managed" ? worker.stop === "verified" : worker.registration.stop !== undefined;
}

/** Facts about the run being refined, read by the caller in the same transaction. */
export interface RefinesFacts { readonly id: Id; readonly status: TaskRunStatus; readonly taskDefinitionId: Id; readonly workId?: Id }

export function createTaskRun(
  command: { id: Id; taskRevision: RevisionRef; environment?: ResolvedEnvironment; workId?: Id; refines?: Id; workerMode: WorkerMode; retention: Retention; at: Timestamp },
  facts?: { refines?: RefinesFacts },
): Result<Decision<TaskRun, TaskRunEvent>> {
  const bad = firstInvalid([
    ["id", isId(command.id)], ["taskRevision", isRevisionRef(command.taskRevision, "task")],
    ["environment", command.environment === undefined || (isRevisionRef(command.environment.revision, "environment") && ["latest","specified","inherited"].includes(command.environment.source))],
    ["workId", command.workId === undefined || isId(command.workId)], ["refines", command.refines === undefined || isId(command.refines)],
    ["workerMode", ["managed", "external", "none"].includes(command.workerMode)], ["retention", command.retention === "release" || command.retention === "keep"],
    ["at", isTimestamp(command.at)],
  ]);
  if (bad) return bad;
  if (command.refines !== undefined) {
    const target = facts?.refines;
    if (!target || target.id !== command.refines) return invalid("the run to refine was not supplied");
    if (!["delivered", "failed", "cancelled"].includes(target.status)) return conflict("only a finished run can be refined");
    if (target.taskDefinitionId !== command.taskRevision.definitionId) return conflict("a refinement must belong to the same task");
    if (target.workId !== command.workId) return conflict("a refinement must belong to the same work");
  }
  const state: TaskRun = {
    id: command.id, version: 1, taskRevision: command.taskRevision, ...(command.environment ? { environment: command.environment } : {}), ...(command.workId ? { workId: command.workId } : {}),
    ...(command.refines ? { refines: command.refines } : {}), workerMode: command.workerMode, retention: command.retention,
    status: "pending", lateRecords: [], createdAt: command.at,
  };
  return ok({ state, events: [{ type: "created", runId: state.id, ...(state.refines ? { refines: state.refines } : {}), at: command.at }], outcome: undefined });
}

const terminalRefusal = (run: TaskRun, what: string) => conflict(`the run is already ${run.status}; ${what}`);

function recordLate(run: TaskRun, kind: LateRecord["kind"], at: Timestamp, detail: string): Step {
  return advance(run, { lateRecords: [...run.lateRecords, { kind, at, detail }] }, [{ type: "late-record", runId: run.id, kind, at } as TaskRunEvent], "late" as Outcome);
}

/** Move to cancelled once cancellation was requested and nothing of the round can still be running. */
function settleCancel(run: TaskRun, base: Partial<TaskRun>, events: TaskRunEvent[], at: Timestamp, outcome: Outcome): Step {
  const candidate = { ...run, ...base } as TaskRun;
  if (candidate.cancelIntent && !isTerminal(candidate)) {
    if (quiescent(candidate)) {
      return advance(run, { ...base, status: "cancelled", terminalAt: at, blocked: undefined, pendingManifest: undefined }, [...events, { type: "cancelled", runId: run.id, at }], outcome);
    }
    if (!candidate.blocked && candidate.worker?.kind === "external")
      return advance(run, { ...base, blocked: { reason: "awaiting-external-stop", at } }, [...events, { type: "blocked", runId: run.id, reason: "awaiting-external-stop", at }], outcome);
  }
  return advance(run, base, events, outcome);
}

export function start(run: TaskRun, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is missing or malformed");
  if (isTerminal(run)) return terminalRefusal(run, "it cannot start");
  if (run.cancelIntent) return conflict("cancellation was requested; no new work may start");
  if (run.status !== "pending") return conflict("the run has already started");
  return advance(run, { status: "running" }, [{ type: "started", runId: run.id, at: command.at }], "applied");
}

export function attachSandbox(run: TaskRun, command: { sandboxId: Id }): Step {
  if (!isId(command.sandboxId)) return invalid("sandboxId is missing or malformed");
  if (isTerminal(run)) return terminalRefusal(run, "no sandbox can be attached");
  if (run.sandboxId !== undefined) return run.sandboxId === command.sandboxId ? advance(run, {}, [], "applied") : conflict("a different sandbox is already attached");
  return advance(run, { sandboxId: command.sandboxId }, [{ type: "sandbox-attached", runId: run.id, sandboxId: command.sandboxId }], "applied");
}

function registrable(run: TaskRun, mode: "managed" | "external"): Result<void> {
  if (isTerminal(run)) return terminalRefusal(run, "no worker can be registered");
  if (run.cancelIntent) return conflict("cancellation was requested; no new work may start");
  if (run.status !== "running") return conflict("the run has not started");
  if (run.workerMode !== mode) return conflict(`this round is configured for ${run.workerMode} work`);
  if (run.worker) return conflict("a round has at most one worker");
  return ok(undefined);
}

export function registerManagedWorker(run: TaskRun, command: { executionId: Id; at: Timestamp }): Step {
  const bad = firstInvalid([["executionId", isId(command.executionId)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const allowed = registrable(run, "managed");
  if (!allowed.ok) return allowed;
  return advance(run, { worker: { kind: "managed", executionId: command.executionId, stop: "active" } }, [{ type: "worker-registered", runId: run.id, worker: "managed", at: command.at }], "applied");
}

export function registerExternalWorker(run: TaskRun, command: { sessionId: Id; agent: { id: string; name?: string; model?: string }; at: Timestamp }): Step {
  const bad = firstInvalid([["sessionId", isId(command.sessionId)], ["agent.id", isText(command.agent?.id, 256)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const allowed = registrable(run, "external");
  if (!allowed.ok) return allowed;
  const registration: ExternalRegistration = { sessionId: command.sessionId, agent: command.agent, registeredAt: command.at, transcripts: [] };
  return advance(run, { worker: { kind: "external", registration } }, [{ type: "worker-registered", runId: run.id, worker: "external", at: command.at }], "applied");
}

/** A transcript may be imported at any time, even after delivery; it never changes a finished round. */
export function importTranscript(run: TaskRun, command: { sessionId: Id; ref: string; digest: Digest; coverage: TranscriptImport["coverage"]; trace?: FrozenTrace; at: Timestamp }): Step {
  const bad = firstInvalid([["ref", isText(command.ref, 1024)], ["digest", isDigest(command.digest)], ["coverage", ["full", "partial", "unknown"].includes(command.coverage)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (run.worker?.kind !== "external") return conflict("only an external worker has an imported transcript");
  if (run.worker.registration.sessionId !== command.sessionId) return reject("forbidden", "the session identity does not match this registration");
  if (command.trace && (command.trace.raw.digest !== command.digest || command.trace.format !== "grounds.provider-trace/v1" ||
      !isDigest(command.trace.events.digest) || !["claude-code","codex"].includes(command.trace.provider))) return invalid("transcript descriptor does not match its raw source");
  const matches = run.worker.registration.transcripts.filter(t => t.digest === command.digest);
  const existing = matches.find(t => t.trace) ?? matches[0];
  if (existing?.trace && command.trace && (existing.trace.events.digest !== command.trace.events.digest || existing.trace.provider !== command.trace.provider)) return conflict("these bytes already have a different frozen interpretation");
  if (existing && (!command.trace || existing.trace)) return advance(run, {}, [], "applied");
  const record: TranscriptImport = { ref: command.ref, digest: command.digest, coverage: command.coverage, ...(command.trace ? {trace:command.trace} : {}), importedAt: command.at };
  const registration = { ...run.worker.registration, transcripts: [...run.worker.registration.transcripts, record] };
  return advance(run, { worker: { kind: "external", registration } }, [{ type: "transcript-imported", runId: run.id, digest: command.digest, at: command.at }], "applied");
}

/** A verified stop of the managed worker, with how its execution ended. */
export function workerStopped(run: TaskRun, command: { outcome: "succeeded" | "failed"; at: Timestamp }): Step {
  const bad = firstInvalid([["outcome", command.outcome === "succeeded" || command.outcome === "failed"], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (isTerminal(run)) return recordLate(run, "worker-stop", command.at, `managed worker stopped (${command.outcome})`);
  if (run.worker?.kind !== "managed") return conflict("the run has no managed worker");
  if (run.worker.stop === "verified") return run.worker.outcome === command.outcome ? advance(run, {}, [], "applied") : conflict("the worker's stop was already recorded with a different outcome");
  const base: Partial<TaskRun> = { worker: { ...run.worker, stop: "verified", outcome: command.outcome }, ...(run.blocked?.reason === "stop-unknown" ? { blocked: undefined } : {}) };
  return settleCancel(run, base, [{ type: "worker-stopped", runId: run.id, verified: true, at: command.at }], command.at, "applied");
}

/** The stop of the managed worker could not be confirmed (for example after a host crash). */
export function workerStopUnknown(run: TaskRun, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is missing or malformed");
  if (isTerminal(run)) return terminalRefusal(run, "the stop state no longer matters");
  if (run.worker?.kind !== "managed") return conflict("the run has no managed worker");
  if (run.worker.stop === "verified") return conflict("the worker's stop is already verified");
  if (run.worker.stop === "unknown") return advance(run, {}, [], "applied");
  return advance(run, { worker: { ...run.worker, stop: "unknown" }, blocked: { reason: "stop-unknown", at: command.at } },
    [{ type: "blocked", runId: run.id, reason: "stop-unknown", at: command.at }], "applied");
}

/** A declared stop of the external worker made by a person (for example to let cancellation complete). */
export function declareExternalStop(run: TaskRun, command: { at: Timestamp; reason: "human" | "abandoned"; sessionId?: Id }): Step {
  const bad = firstInvalid([["reason", command.reason === "human" || command.reason === "abandoned"], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (isTerminal(run)) return terminalRefusal(run, "the stop no longer matters");
  if (run.worker?.kind !== "external") return conflict("the run has no external worker");
  if (command.reason === "abandoned" && command.sessionId !== run.worker.registration.sessionId) return reject("forbidden", "only the registered session can abandon the round");
  if (run.worker.registration.stop) return advance(run, {}, [], "applied");
  const registration: ExternalRegistration = { ...run.worker.registration, stop: { declaredAt: command.at, reason: command.reason } };
  const stopped: TaskRunEvent = { type: "worker-stopped", runId: run.id, verified: false, at: command.at };
  const base: Partial<TaskRun> = { worker: { kind: "external", registration }, ...(run.blocked?.reason === "awaiting-external-stop" ? { blocked: undefined } : {}) };
  if (run.cancelIntent) return settleCancel(run, base, [stopped], command.at, "applied");
  if (command.reason === "abandoned") {
    return advance(run, { ...base, status: "failed", terminalAt: command.at, blocked: undefined, pendingManifest: undefined, failure: { class: "agent-execution", detail: "the external agent abandoned the round", at: command.at } },
      [stopped, { type: "failed", runId: run.id, class: "agent-execution", at: command.at }], "applied");
  }
  return advance(run, base, [stopped], "applied");
}

export function block(run: TaskRun, command: { reason: BlockReason; at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is missing or malformed");
  if (isTerminal(run)) return terminalRefusal(run, "it cannot be blocked");
  if (run.status !== "running") return conflict("only a running round can be blocked");
  if (run.blocked?.reason === command.reason) return advance(run, {}, [], "applied");
  return advance(run, { blocked: { reason: command.reason, at: command.at } }, [{ type: "blocked", runId: run.id, reason: command.reason, at: command.at }], "applied");
}

export function unblock(run: TaskRun, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is missing or malformed");
  if (isTerminal(run)) return terminalRefusal(run, "there is nothing to unblock");
  if (!run.blocked) return advance(run, {}, [], "applied");
  if (run.blocked.reason === "stop-unknown") return conflict("the stop is still unknown; verify it before unblocking");
  return advance(run, { blocked: undefined }, [{ type: "unblocked", runId: run.id, at: command.at }], "applied");
}

function failNow(run: TaskRun, cls: FailureClass, detail: string, at: Timestamp, extra: TaskRunEvent[] = [], base: Partial<TaskRun> = {}): Step {
  return advance(run, { ...base, status: "failed", terminalAt: at, blocked: undefined, pendingManifest: undefined, failure: { class: cls, detail, at } }, [...extra, { type: "failed", runId: run.id, class: cls, at }], "applied");
}

export interface ManifestSubmission {
  origin: ManifestOrigin;
  operationId: Id;
  check: ReceiptCheck;
  at: Timestamp;
  items?: readonly DeliveryItem[];
  trajectoryReceipt?: string;
  digest?: Digest;
  /** The external session presenting the submission. */
  sessionId?: Id;
  /** An external submission declares the worker stopped. */
  declaresStop?: boolean;
}

const originFor: Record<WorkerMode, readonly ManifestOrigin[]> = { managed: ["tool", "contract"], external: ["external"], none: ["caller"] };

/**
 * The linearization point of a round: the receiving check has already been
 * evaluated outside; this decides, in one step, whether the manifest is
 * frozen, the round fails, the round waits, or cancellation wins.
 */
export function submitManifest(run: TaskRun, command: ManifestSubmission): Step {
  const bad = firstInvalid([["operationId", isId(command.operationId)], ["origin", ["tool", "contract", "external", "caller"].includes(command.origin)],
    ["check", ["accepted", "rejected", "unavailable"].includes(command.check)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (isTerminal(run)) return recordLate(run, "manifest", command.at, `${command.origin} manifest after ${run.status}`);
  if (run.status !== "running") return conflict("the round has not started");
  if (!originFor[run.workerMode].includes(command.origin)) return conflict(`a ${run.workerMode} round cannot take a ${command.origin} manifest`);
  if (run.manifest) return conflict("a round has one manifest");

  let worker = run.worker;
  const events: TaskRunEvent[] = [];
  if (run.workerMode === "external") {
    if (worker?.kind !== "external") return conflict("the external worker is not registered");
    if (command.sessionId !== worker.registration.sessionId) return reject("forbidden", "the session identity does not match this registration");
    if (command.declaresStop === false) return invalid("an external submission declares the stop");
    if (!worker.registration.stop) {
      worker = { kind: "external", registration: { ...worker.registration, stop: { declaredAt: command.at, reason: "submitted" } } };
      events.push({ type: "worker-stopped", runId: run.id, verified: false, at: command.at });
    }
  }
  const base: Partial<TaskRun> = worker ? { worker } : {};
  if (run.cancelIntent) {
    const late: LateRecord = { kind: "manifest", at: command.at, detail: `${command.origin} manifest submitted after cancellation was requested` };
    return settleCancel(run, { ...base, lateRecords: [...run.lateRecords, late] }, [...events, { type: "late-record", runId: run.id, kind: "manifest", at: command.at }], command.at, "cancel-wins");
  }
  if (command.check === "unavailable") {
    const wasBlocked = run.blocked?.reason === "receipt-unavailable";
    return advance(run, { ...base, pendingManifest: { operationId: command.operationId, origin: command.origin }, blocked: { reason: "receipt-unavailable", at: wasBlocked ? run.blocked!.at : command.at } },
      [...events, { type: "manifest-unavailable", runId: run.id, operationId: command.operationId, at: command.at }], "applied");
  }
  if (run.workerMode === "managed" && worker?.kind !== "managed") return conflict("the managed worker is not registered");
  if (worker?.kind === "managed" && worker.stop !== "verified") return conflict("the managed worker's stop is not verified");
  if (command.check === "rejected") return failNow(run, "agent-output", "the delivery was rejected by the receiving check", command.at, events, base);

  const items = command.items ?? [];
  if (items.length === 0) return invalid("a manifest lists at least one delivery");
  if (!items.every(item => (item.type === "candidate" || item.type === "artifact") && isId(item.id) && isText(item.receipt, 1024))) return invalid("every delivery needs a type, an id and an archive receipt");
  if (!unique(items, item => `${item.type}:${item.id}`)) return invalid("deliveries must be unique");
  if (worker?.kind === "managed" && !isText(command.trajectoryReceipt, 1024)) return invalid("a managed round needs its trajectory archived");
  if (!isDigest(command.digest)) return invalid("digest is missing or malformed");
  const manifest: Manifest = { origin: command.origin, items, ...(command.trajectoryReceipt ? { trajectoryReceipt: command.trajectoryReceipt } : {}), digest: command.digest, operationId: command.operationId, frozenAt: command.at };
  return advance(run, { ...base, status: "delivered", manifest, terminalAt: command.at, blocked: undefined, pendingManifest: undefined },
    [...events, { type: "manifest-frozen", runId: run.id, digest: manifest.digest, origin: manifest.origin, at: command.at }, { type: "delivered", runId: run.id, at: command.at }], "applied");
}

/** The managed worker ended without a manifest: classify the failure. */
export function concludeRound(run: TaskRun, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is missing or malformed");
  if (isTerminal(run)) return recordLate(run, "failure", command.at, "round concluded after the run finished");
  if (run.status !== "running") return conflict("the round has not started");
  if (run.workerMode !== "managed" || run.worker?.kind !== "managed") return conflict("only a managed round is concluded this way");
  if (run.worker.stop !== "verified") return conflict("the worker's stop is not verified");
  if (run.cancelIntent) return settleCancel(run, {}, [], command.at, "cancel-wins");
  if (run.pendingManifest) return conflict("a manifest is waiting for its receipts");
  if (run.manifest) return conflict("the round already has a manifest");
  return failNow(run, run.worker.outcome === "failed" ? "agent-execution" : "agent-output", run.worker.outcome === "failed" ? "the worker failed and delivered nothing" : "the worker ended without a delivery", command.at);
}

/** Preparation or the host failed in a way that ends the round for good. */
export function failInfrastructure(run: TaskRun, command: { detail: string; at: Timestamp }): Step {
  const bad = firstInvalid([["detail", isText(command.detail, 1024)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (isTerminal(run)) return recordLate(run, "failure", command.at, command.detail);
  if (run.cancelIntent) return settleCancel(run, {}, [], command.at, "cancel-wins");
  if (!quiescent(run)) return conflict("the worker's stop must be confirmed before the round can fail");
  return failNow(run, "infrastructure", command.detail, command.at);
}

export function requestCancel(run: TaskRun, command: { at: Timestamp; reason?: string }): Step {
  if (!isTimestamp(command.at)) return invalid("at is missing or malformed");
  if (command.reason !== undefined && !isText(command.reason, 1024)) return invalid("reason is malformed");
  if (isTerminal(run)) return advance(run, {}, [], "already-terminal");
  if (run.cancelIntent) return advance(run, {}, [], "already-requested");
  return settleCancel(run, { cancelIntent: { at: command.at, ...(command.reason !== undefined ? { reason: command.reason } : {}) } }, [{ type: "cancel-requested", runId: run.id, at: command.at }], command.at, "applied");
}

/** Invariants every stored TaskRun must satisfy; empty when it is consistent. */
export function taskRunViolations(run: TaskRun): string[] {
  const problems: string[] = [];
  const terminal = isTerminal(run);
  if (terminal !== (run.terminalAt !== undefined)) problems.push("terminalAt is set exactly when the run is finished");
  if ((run.status === "delivered") !== (run.manifest !== undefined)) problems.push("a manifest is frozen exactly when the run is delivered");
  if ((run.status === "failed") !== (run.failure !== undefined)) problems.push("a failure class is recorded exactly when the run failed");
  if (run.status === "delivered") {
    if (run.cancelIntent) problems.push("a run with a cancel intent cannot be delivered");
    if (!quiescent(run)) problems.push("a delivered run has no running worker");
    if (run.manifest && !run.manifest.items.every(item => item.receipt)) problems.push("every delivery has an archive receipt");
    if (run.worker?.kind === "managed" && !run.manifest?.trajectoryReceipt) problems.push("a managed delivery has its trajectory archived");
  }
  if (run.status === "cancelled" && (!run.cancelIntent || !quiescent(run))) problems.push("a cancelled run was asked to cancel and has nothing running");
  if (terminal && (run.blocked || run.pendingManifest)) problems.push("a finished run is neither blocked nor waiting for receipts");
  if (run.status === "pending" && (run.worker || run.manifest)) problems.push("a run that has not started has no worker or manifest");
  if (run.worker && run.worker.kind !== run.workerMode) problems.push("the worker matches the configured mode");
  if (run.manifest && !originFor[run.workerMode].includes(run.manifest.origin)) problems.push("the manifest origin matches the mode");
  return problems;
}
