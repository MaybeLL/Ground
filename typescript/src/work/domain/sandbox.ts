import { advance, conflict, firstInvalid, invalid, isId, isNonNegativeInteger, isText, isTimestamp, ok, reject, type Decision, type Id, type Result, type Timestamp, type Versioned } from "./kernel.js";
import type { Retention } from "./task-run.js";

export type OwnerRef = { readonly type: "task_run" | "grading_record"; readonly id: Id };
/** Whoever uses a sandbox must be able to report that it stopped; both kinds do. */
export type OccupantRef =
  | { readonly type: "agent_execution"; readonly id: Id }
  | { readonly type: "command_step"; readonly gradingRecordId: Id; readonly ordinal: number };
export type SandboxPhase = "preparing" | "blocked" | "ready" | "in_use" | "paused" | "releasing" | "released";
export type ReservationKind = "pause" | "resume" | "release" | "transfer";
export type WorkspaceDisposition = "retained" | "removed" | "returned";

export interface Lease { readonly holder: OccupantRef; readonly token: number; readonly since: Timestamp }
export interface Reservation { readonly operationId: Id; readonly kind: ReservationKind; readonly receiver?: Id; readonly ownerChanged: boolean; readonly at: Timestamp }
export interface TransferRecord { readonly from: Id; readonly to: Id; readonly at: Timestamp }

export interface Sandbox extends Versioned {
  readonly id: Id;
  readonly owner: OwnerRef;
  readonly retention: Retention;
  readonly location?: { readonly hostId: string; readonly daemonId: string };
  readonly phase: SandboxPhase;
  readonly workspace?: { readonly ref: Id; readonly origin: "own" | "borrowed" };
  /** The running resource (formerly a separate environment instance); one sandbox owns at most one. */
  readonly runtime?: { readonly instanceId: Id; readonly environmentRevisionId: Id };
  readonly mounted: boolean;
  readonly lease?: Lease;
  /** Highest fencing token ever issued; tokens only grow. */
  readonly lastToken: number;
  readonly stopUnknown: boolean;
  /** The user's own agent worked in this worktree; its stop can only be declared, so the worktree is never handed on. */
  readonly externalWorkerUsed: boolean;
  readonly blockedReason?: string;
  readonly reservation?: Reservation;
  readonly transfers: readonly TransferRecord[];
  readonly workspaceDisposition?: WorkspaceDisposition;
  readonly createdAt: Timestamp;
  readonly releasedAt?: Timestamp;
}

export type SandboxEvent =
  | { readonly type: "requested"; readonly sandboxId: Id; readonly owner: OwnerRef; readonly at: Timestamp }
  | { readonly type: "ready"; readonly sandboxId: Id; readonly at: Timestamp }
  | { readonly type: "blocked"; readonly sandboxId: Id; readonly reason: string; readonly at: Timestamp }
  | { readonly type: "preparation-resumed"; readonly sandboxId: Id; readonly at: Timestamp }
  | { readonly type: "lease-acquired"; readonly sandboxId: Id; readonly token: number; readonly at: Timestamp }
  | { readonly type: "lease-returned"; readonly sandboxId: Id; readonly token: number; readonly at: Timestamp }
  | { readonly type: "stop-unknown"; readonly sandboxId: Id; readonly at: Timestamp }
  | { readonly type: "external-use-recorded"; readonly sandboxId: Id; readonly at: Timestamp }
  | { readonly type: "reserved"; readonly sandboxId: Id; readonly kind: ReservationKind; readonly operationId: Id; readonly at: Timestamp }
  | { readonly type: "ownership-transferred"; readonly sandboxId: Id; readonly from: Id; readonly to: Id; readonly at: Timestamp }
  | { readonly type: "reservation-completed"; readonly sandboxId: Id; readonly kind: ReservationKind; readonly phase: SandboxPhase; readonly at: Timestamp }
  | { readonly type: "reservation-abandoned"; readonly sandboxId: Id; readonly operationId: Id; readonly at: Timestamp }
  | { readonly type: "released"; readonly sandboxId: Id; readonly at: Timestamp };

type Step = Result<Decision<Sandbox, SandboxEvent>>;

const sameOwner = (a: OwnerRef, b: OwnerRef) => a.type === b.type && a.id === b.id;
const sameOccupant = (a: OccupantRef, b: OccupantRef) => a.type === b.type && (a.type === "agent_execution" ? a.id === (b as typeof a).id : a.gradingRecordId === (b as typeof a & { type: "command_step" }).gradingRecordId && a.ordinal === (b as typeof a & { type: "command_step" }).ordinal);
const isOwner = (value: unknown): value is OwnerRef => !!value && typeof value === "object" && ["task_run", "grading_record"].includes((value as OwnerRef).type) && isId((value as OwnerRef).id);
const isOccupant = (value: unknown): value is OccupantRef => {
  const o = value as OccupantRef;
  return !!o && typeof o === "object" && (o.type === "agent_execution" ? isId(o.id) : o.type === "command_step" && isId(o.gradingRecordId) && isNonNegativeInteger(o.ordinal));
};
const gone = (s: Sandbox) => s.phase === "releasing" || s.phase === "released";

export function requestSandbox(command: { location?: Sandbox["location"]; id: Id; owner: OwnerRef; retention: Retention; at: Timestamp }): Result<Decision<Sandbox, SandboxEvent>> {
  const bad = firstInvalid([["id", isId(command.id)], ["owner", isOwner(command.owner)], ["retention", command.retention === "release" || command.retention === "keep"], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const state: Sandbox = { ...(command.location ? {location:command.location} : {}), id: command.id, owner: command.owner, retention: command.retention, phase: "preparing", mounted: false, lastToken: 0, stopUnknown: false, externalWorkerUsed: false, transfers: [], createdAt: command.at, version: 1 };
  return ok({ state, events: [{ type: "requested", sandboxId: state.id, owner: state.owner, at: command.at }], outcome: undefined });
}

export function markReady(sandbox: Sandbox, command: { workspace: { ref: Id; origin: "own" | "borrowed" }; runtime?: { instanceId: Id; environmentRevisionId: Id }; at: Timestamp }): Step {
  const bad = firstInvalid([["workspace", isId(command.workspace?.ref) && ["own", "borrowed"].includes(command.workspace.origin)],
    ["runtime", command.runtime === undefined || (isId(command.runtime.instanceId) && isId(command.runtime.environmentRevisionId))], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (sandbox.phase !== "preparing") return conflict(`a ${sandbox.phase} sandbox cannot become ready`);
  return advance(sandbox, { phase: "ready", workspace: command.workspace, ...(command.runtime ? { runtime: command.runtime } : {}), mounted: true, blockedReason: undefined },
    [{ type: "ready", sandboxId: sandbox.id, at: command.at }], undefined);
}

/** Preparation failed; whatever already exists, in particular the workspace, is kept. */
export function markBlocked(sandbox: Sandbox, command: { reason: string; runtime?: Sandbox["runtime"]; workspace?: { ref: Id; origin: "own" | "borrowed" }; at: Timestamp }): Step {
  const bad = firstInvalid([["reason", isText(command.reason, 1024)], ["workspace", command.workspace === undefined || (isId(command.workspace.ref) && ["own", "borrowed"].includes(command.workspace.origin))], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (sandbox.phase !== "preparing") return conflict(`a ${sandbox.phase} sandbox cannot be blocked`);
  return advance(sandbox, { phase: "blocked", blockedReason: command.reason, ...(command.runtime ? {runtime:command.runtime} : {}), ...(command.workspace ? { workspace: command.workspace } : {}) },
    [{ type: "blocked", sandboxId: sandbox.id, reason: command.reason, at: command.at }], undefined);
}

export function resumePreparation(sandbox: Sandbox, command: { by: OwnerRef; at: Timestamp }): Step {
  if (!isOwner(command.by) || !isTimestamp(command.at)) return invalid("by and at are required");
  if (!sameOwner(command.by, sandbox.owner)) return reject("forbidden", "only the owner's use case may resume preparation");
  if (sandbox.phase !== "blocked") return conflict("only a blocked sandbox resumes preparation");
  if (sandbox.reservation) return conflict("a lifecycle operation is reserved");
  return advance(sandbox, { phase: "preparing", blockedReason: undefined }, [{ type: "preparation-resumed", sandboxId: sandbox.id, at: command.at }], undefined);
}

export function acquireLease(sandbox: Sandbox, command: { holder: OccupantRef; at: Timestamp }): Step {
  if (!isOccupant(command.holder) || !isTimestamp(command.at)) return invalid("holder and at are required");
  if (sandbox.phase !== "ready") return conflict(`a ${sandbox.phase} sandbox cannot be occupied`);
  if (sandbox.reservation) return conflict("a lifecycle operation is reserved; occupancy is closed");
  if (sandbox.lease || sandbox.stopUnknown) return conflict("the sandbox is occupied");
  const token = sandbox.lastToken + 1;
  return advance(sandbox, { phase: "in_use", lease: { holder: command.holder, token, since: command.at }, lastToken: token },
    [{ type: "lease-acquired", sandboxId: sandbox.id, token, at: command.at }], undefined);
}

/** The bridge honours only the token of the lease currently held; an older holder's token is dead. */
export function authorizeBridge(sandbox: Sandbox, command: { holder: OccupantRef; token: number }): Result<void> {
  if (!sandbox.lease || sandbox.phase !== "in_use") return conflict("the sandbox is not occupied");
  if (!isOccupant(command.holder) || !sameOccupant(sandbox.lease.holder, command.holder) || sandbox.lease.token !== command.token) return reject("forbidden", "the fencing token is not the current lease's");
  return ok(undefined);
}

export function reportStopUnknown(sandbox: Sandbox, command: { holder: OccupantRef; token: number; at: Timestamp }): Step {
  const allowed = authorizeBridge(sandbox, command);
  if (!allowed.ok) return allowed;
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (sandbox.stopUnknown) return advance(sandbox, {}, [], undefined);
  return advance(sandbox, { stopUnknown: true }, [{ type: "stop-unknown", sandboxId: sandbox.id, at: command.at }], undefined);
}

/** Give the lease back; only a stop that was verified (not merely declared) allows it. */
export function returnLease(sandbox: Sandbox, command: { holder: OccupantRef; token: number; stop: "verified"; at: Timestamp }): Step {
  const allowed = authorizeBridge(sandbox, command);
  if (!allowed.ok) return allowed;
  if (command.stop !== "verified") return invalid("only a verified stop returns the lease");
  if (!isTimestamp(command.at)) return invalid("at is required");
  return advance(sandbox, { phase: "ready", lease: undefined, stopUnknown: false }, [{ type: "lease-returned", sandboxId: sandbox.id, token: command.token, at: command.at }], undefined);
}

export function recordExternalUse(sandbox: Sandbox, command: { at: Timestamp }): Step {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (gone(sandbox)) return conflict(`a ${sandbox.phase} sandbox cannot be used`);
  if (sandbox.externalWorkerUsed) return advance(sandbox, {}, [], undefined);
  return advance(sandbox, { externalWorkerUsed: true }, [{ type: "external-use-recorded", sandboxId: sandbox.id, at: command.at }], undefined);
}

export interface ReserveCommand { by: OwnerRef; operationId: Id; kind: ReservationKind; at: Timestamp; receiver?: Id; ownerTerminal?: boolean }

/**
 * Every lifecycle operation that performs I/O is first reserved here, so that
 * a transfer, a release and an expiry sweep cannot interleave: whoever
 * reserves first wins and the others are told why they lost.
 */
export function reserve(sandbox: Sandbox, command: ReserveCommand): Step {
  const bad = firstInvalid([["by", isOwner(command.by)], ["operationId", isId(command.operationId)], ["kind", ["pause", "resume", "release", "transfer"].includes(command.kind)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (!sameOwner(command.by, sandbox.owner)) return reject("forbidden", "only the use case responsible for the owner may operate the sandbox");
  if (gone(sandbox)) return conflict(`the sandbox is ${sandbox.phase}`);
  const existing = sandbox.reservation;
  if (existing) return existing.operationId === command.operationId && existing.kind === command.kind ? advance(sandbox, {}, [], undefined) : conflict(`a ${existing.kind} is already reserved`);
  if (sandbox.lease || sandbox.stopUnknown) return conflict("the sandbox is occupied or its stop is unknown");
  const reservation: Reservation = { operationId: command.operationId, kind: command.kind, ownerChanged: false, at: command.at, ...(command.receiver ? { receiver: command.receiver } : {}) };
  const event: SandboxEvent = { type: "reserved", sandboxId: sandbox.id, kind: command.kind, operationId: command.operationId, at: command.at };
  switch (command.kind) {
    case "pause":
      if (sandbox.phase !== "ready") return conflict("only a ready sandbox can be paused");
      return advance(sandbox, { reservation }, [event], undefined);
    case "resume":
      if (sandbox.phase !== "paused") return conflict("only a paused sandbox can be resumed");
      return advance(sandbox, { reservation }, [event], undefined);
    case "release":
      if (!["ready", "paused", "blocked"].includes(sandbox.phase)) return conflict(`a ${sandbox.phase} sandbox cannot be released`);
      return advance(sandbox, { reservation, phase: "releasing" }, [event], undefined);
    case "transfer":
      if (sandbox.owner.type !== "task_run") return conflict("only a task sandbox can be handed to a refinement");
      if (!isId(command.receiver) || command.receiver === sandbox.owner.id) return invalid("a different receiving run is required");
      if (command.ownerTerminal !== true) return conflict("the owner run has not finished");
      if (sandbox.retention !== "keep") return conflict("the sandbox was not kept for refinement");
      if (sandbox.externalWorkerUsed) return conflict("an external agent worked here and its stop cannot be verified; start from the frozen candidate instead");
      if (!["ready", "paused", "blocked"].includes(sandbox.phase)) return conflict(`a ${sandbox.phase} sandbox cannot be handed over`);
      return advance(sandbox, { reservation }, [event], undefined);
  }
}

/** Step two of a transfer: the irreversible change of owner. */
export function applyTransfer(sandbox: Sandbox, command: { operationId: Id; retention: Retention; at: Timestamp }): Step {
  if (!isId(command.operationId) || !isTimestamp(command.at) || (command.retention !== "keep" && command.retention !== "release")) return invalid("operationId, retention and at are required");
  const r = sandbox.reservation;
  if (!r || r.kind !== "transfer" || r.operationId !== command.operationId) return conflict("no such transfer is reserved");
  if (r.ownerChanged) return advance(sandbox, {}, [], undefined);
  const receiver = r.receiver as Id;
  return advance(sandbox, { owner: { type: "task_run", id: receiver }, retention: command.retention, reservation: { ...r, ownerChanged: true }, transfers: [...sandbox.transfers, { from: sandbox.owner.id, to: receiver, at: command.at }] },
    [{ type: "ownership-transferred", sandboxId: sandbox.id, from: sandbox.owner.id, to: receiver, at: command.at }], undefined);
}

/** Finish a pause, resume or transfer; a release finishes with completeRelease. */
export function completeReservation(sandbox: Sandbox, command: { operationId: Id; at: Timestamp }): Step {
  if (!isId(command.operationId) || !isTimestamp(command.at)) return invalid("operationId and at are required");
  const r = sandbox.reservation;
  if (!r || r.operationId !== command.operationId) return conflict("no such operation is reserved");
  let phase: SandboxPhase;
  switch (r.kind) {
    case "pause": phase = "paused"; break;
    case "resume": phase = "ready"; break;
    case "transfer":
      if (!r.ownerChanged) return conflict("the owner has not been changed yet");
      phase = sandbox.phase === "paused" ? "ready" : sandbox.phase === "blocked" ? "preparing" : sandbox.phase;
      break;
    default: return conflict("a release finishes with completeRelease");
  }
  return advance(sandbox, { phase, reservation: undefined, ...(phase === "preparing" ? {} : { blockedReason: undefined }) },
    [{ type: "reservation-completed", sandboxId: sandbox.id, kind: r.kind, phase, at: command.at }], undefined);
}

/** Drop a reservation whose I/O never changed anything. A started release or a transfer past its owner change cannot be dropped. */
export function abandonReservation(sandbox: Sandbox, command: { operationId: Id; at: Timestamp }): Step {
  if (!isId(command.operationId) || !isTimestamp(command.at)) return invalid("operationId and at are required");
  const r = sandbox.reservation;
  if (!r || r.operationId !== command.operationId) return advance(sandbox, {}, [], undefined);
  if (r.kind === "release") return conflict("a started release is finished, not abandoned");
  if (r.kind === "transfer" && r.ownerChanged) return conflict("the owner already changed; complete the transfer");
  return advance(sandbox, { reservation: undefined }, [{ type: "reservation-abandoned", sandboxId: sandbox.id, operationId: command.operationId, at: command.at }], undefined);
}

export function completeRelease(sandbox: Sandbox, command: { operationId: Id; workspace: WorkspaceDisposition; at: Timestamp }): Step {
  const bad = firstInvalid([["operationId", isId(command.operationId)], ["workspace", ["retained", "removed", "returned"].includes(command.workspace)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (sandbox.phase === "released") return advance(sandbox, {}, [], undefined);
  const r = sandbox.reservation;
  if (sandbox.phase !== "releasing" || !r || r.kind !== "release" || r.operationId !== command.operationId) return conflict("no such release is in progress");
  if (sandbox.workspace?.origin === "borrowed" && command.workspace !== "returned") return conflict("a borrowed workspace is only returned, never removed or kept");
  if (sandbox.workspace?.origin === "own" && command.workspace === "returned") return conflict("only a borrowed workspace is returned");
  return advance(sandbox, { phase: "released", reservation: undefined, mounted: false, workspaceDisposition: command.workspace, releasedAt: command.at },
    [{ type: "released", sandboxId: sandbox.id, at: command.at }], undefined);
}

export function sandboxViolations(s: Sandbox): string[] {
  const problems: string[] = [];
  if ((s.phase === "in_use") !== (s.lease !== undefined)) problems.push("a lease is held exactly while the sandbox is in use");
  if (s.stopUnknown && !s.lease) problems.push("an unknown stop belongs to a held lease");
  if (s.lease && s.reservation) problems.push("a leased sandbox has no reserved lifecycle operation");
  if (s.lease && s.lease.token > s.lastToken) problems.push("fencing tokens only grow");
  if (["ready", "in_use", "paused"].includes(s.phase) && !s.workspace) problems.push("a usable sandbox has its workspace");
  if (s.phase === "released" && s.workspaceDisposition === undefined) problems.push("a released sandbox records what became of its workspace");
  if (s.workspace?.origin === "borrowed" && s.workspaceDisposition !== undefined && s.workspaceDisposition !== "returned") problems.push("a borrowed workspace is only returned");
  if (s.reservation?.kind === "release" && s.phase !== "releasing") problems.push("a release reservation puts the sandbox in releasing");
  if (s.reservation?.kind === "transfer" && s.reservation.ownerChanged && s.owner.id !== s.reservation.receiver) problems.push("a changed owner is the receiver");
  if (s.phase === "released" && (s.lease || s.reservation)) problems.push("a released sandbox has no lease or reservation");
  if (s.phase === "blocked" && !s.blockedReason) problems.push("a blocked sandbox says why");
  return problems;
}
