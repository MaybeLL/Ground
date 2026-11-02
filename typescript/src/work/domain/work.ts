import { advance, conflict, firstInvalid, invalid, isId, isTimestamp, ok, unique, type Decision, type Id, type Result, type Timestamp, type Versioned } from "./kernel.js";
import type { TaskRunStatus } from "./task-run.js";

/** How a delivered run stands against its acceptance criteria; derived from gate records, never stored on the run. */
export type AcceptanceConclusion = "pending" | "accepted" | "rejected";
/** What the work as a whole currently shows; derived from the head, never stored. */
export type WorkConclusion = "in-progress" | "failed" | "cancelled" | AcceptanceConclusion | "head-unselected";

export type HeadReason = "start" | "continue" | "select" | "migration-default";
export interface HeadChange { readonly runId: Id; readonly reason: HeadReason; readonly at: Timestamp }
export type WorkStatus = "active" | "closing" | "closed";

export interface Work extends Versioned {
  readonly id: Id;
  /** One task may have any number of works; they share neither head nor mutable sandbox. */
  readonly taskDefinitionId: Id;
  readonly status: WorkStatus;
  /** The run the work currently stands on. Only a migrated work may lack one. */
  readonly head?: Id;
  readonly migrated: boolean;
  readonly headHistory: readonly HeadChange[];
  readonly runIds: readonly Id[];
  readonly closedFact?: { readonly head?: Id; readonly conclusion: WorkConclusion; readonly at: Timestamp };
  readonly createdAt: Timestamp;
}

export type WorkEvent =
  | { readonly type: "work-started"; readonly workId: Id; readonly runId: Id; readonly at: Timestamp }
  | { readonly type: "run-added"; readonly workId: Id; readonly runId: Id; readonly at: Timestamp }
  | { readonly type: "head-moved"; readonly workId: Id; readonly runId: Id; readonly reason: HeadReason; readonly at: Timestamp }
  | { readonly type: "close-requested"; readonly workId: Id; readonly at: Timestamp }
  | { readonly type: "work-closed"; readonly workId: Id; readonly conclusion: WorkConclusion; readonly at: Timestamp };

type Step<O = void> = Result<Decision<Work, WorkEvent, O>>;

export function startWork(command: { id: Id; taskDefinitionId: Id; firstRunId: Id; at: Timestamp }): Step {
  const bad = firstInvalid([["id", isId(command.id)], ["taskDefinitionId", isId(command.taskDefinitionId)], ["firstRunId", isId(command.firstRunId)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const work: Work = { id: command.id, taskDefinitionId: command.taskDefinitionId, status: "active", head: command.firstRunId, migrated: false,
    headHistory: [{ runId: command.firstRunId, reason: "start", at: command.at }], runIds: [command.firstRunId], createdAt: command.at, version: 1 };
  return ok({ state: work, events: [{ type: "work-started", workId: work.id, runId: command.firstRunId, at: command.at }], outcome: undefined });
}

/** A work rebuilt from legacy development runs. Without a single obvious leaf it has no head until someone selects one. */
export function migrateWork(command: { id: Id; taskDefinitionId: Id; runIds: readonly Id[]; defaultHead?: Id; at: Timestamp }): Step {
  const bad = firstInvalid([["id", isId(command.id)], ["taskDefinitionId", isId(command.taskDefinitionId)], ["runIds", command.runIds.length > 0 && command.runIds.every(isId) && unique(command.runIds)],
    ["defaultHead", command.defaultHead === undefined || command.runIds.includes(command.defaultHead)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const history: HeadChange[] = command.defaultHead ? [{ runId: command.defaultHead, reason: "migration-default", at: command.at }] : [];
  const work: Work = { id: command.id, taskDefinitionId: command.taskDefinitionId, status: "active", ...(command.defaultHead ? { head: command.defaultHead } : {}), migrated: true,
    headHistory: history, runIds: [...command.runIds], createdAt: command.at, version: 1 };
  return ok({ state: work, events: [{ type: "work-started", workId: work.id, runId: command.runIds[0], at: command.at }], outcome: undefined });
}

function open(work: Work, what: string): Result<void> {
  return work.status === "active" ? ok(undefined) : conflict(`the work is ${work.status}; ${what}`);
}

/** Refine the head and move the head to the new run, but only if the caller still sees the same head. */
export function continueWork(work: Work, command: { newRunId: Id; expectedHead: Id; at: Timestamp }): Step {
  const bad = firstInvalid([["newRunId", isId(command.newRunId)], ["expectedHead", isId(command.expectedHead)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const allowed = open(work, "no new run can be added");
  if (!allowed.ok) return allowed;
  if (work.head === undefined) return conflict("the work has no head yet; select one first");
  if (work.head !== command.expectedHead) return conflict(`the head is now ${work.head}, not ${command.expectedHead}`);
  if (work.runIds.includes(command.newRunId)) return conflict("the run already belongs to this work");
  return advance(work, { head: command.newRunId, runIds: [...work.runIds, command.newRunId], headHistory: [...work.headHistory, { runId: command.newRunId, reason: "continue", at: command.at }] },
    [{ type: "run-added", workId: work.id, runId: command.newRunId, at: command.at }, { type: "head-moved", workId: work.id, runId: command.newRunId, reason: "continue", at: command.at }], undefined);
}

/** Refine some other node of the tree without moving the head. */
export function addBranch(work: Work, command: { newRunId: Id; at: Timestamp }): Step {
  const bad = firstInvalid([["newRunId", isId(command.newRunId)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const allowed = open(work, "no new run can be added");
  if (!allowed.ok) return allowed;
  if (work.runIds.includes(command.newRunId)) return conflict("the run already belongs to this work");
  return advance(work, { runIds: [...work.runIds, command.newRunId] }, [{ type: "run-added", workId: work.id, runId: command.newRunId, at: command.at }], undefined);
}

/** Put the head on another run of the same work; never inferred from time or from results. */
export function selectHead(work: Work, command: { runId: Id; expectedHead?: Id; at: Timestamp }): Step {
  const bad = firstInvalid([["runId", isId(command.runId)], ["expectedHead", command.expectedHead === undefined || isId(command.expectedHead)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const allowed = open(work, "the head cannot move");
  if (!allowed.ok) return allowed;
  if (!work.runIds.includes(command.runId)) return conflict("the run does not belong to this work");
  if (command.expectedHead !== undefined && command.expectedHead !== work.head) return conflict(`the head is now ${work.head ?? "unselected"}, not ${command.expectedHead}`);
  if (work.head === command.runId) return advance(work, {}, [], undefined);
  return advance(work, { head: command.runId, headHistory: [...work.headHistory, { runId: command.runId, reason: "select", at: command.at }] },
    [{ type: "head-moved", workId: work.id, runId: command.runId, reason: "select", at: command.at }], undefined);
}

const finished = (status: TaskRunStatus | undefined) => status === "delivered" || status === "failed" || status === "cancelled";

/**
 * Close the entrances. If runs are still active the work stays "closing" and
 * the caller learns which ones to cancel or wait for; it asks again later.
 */
export function requestClose(work: Work, command: { at: Timestamp }, runs: ReadonlyMap<Id, TaskRunStatus>): Step<{ blockedBy: readonly Id[] }> {
  if (!isTimestamp(command.at)) return invalid("at is missing or malformed");
  const blockedBy = work.runIds.filter(id => !finished(runs.get(id)));
  if (work.status === "closed") return advance(work, {}, [], { blockedBy: [] });
  if (work.status === "closing") return advance(work, {}, [], { blockedBy });
  return advance(work, { status: "closing" }, [{ type: "close-requested", workId: work.id, at: command.at }], { blockedBy });
}

/** Finish closing once every run ended and the release of kept sandboxes is reserved; remember what was seen at that moment. */
export function completeClose(work: Work, command: { at: Timestamp; conclusion: WorkConclusion; releasesReserved: boolean }, runs: ReadonlyMap<Id, TaskRunStatus>): Step {
  const bad = firstInvalid([["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (work.status === "closed") return advance(work, {}, [], undefined);
  if (work.status !== "closing") return conflict("request the close first");
  const active = work.runIds.filter(id => !finished(runs.get(id)));
  if (active.length > 0) return conflict(`runs are still active: ${active.join(", ")}`);
  if (!command.releasesReserved) return conflict("the release of kept sandboxes must be reserved before the work closes");
  return advance(work, { status: "closed", closedFact: { ...(work.head ? { head: work.head } : {}), conclusion: command.conclusion, at: command.at } },
    [{ type: "work-closed", workId: work.id, conclusion: command.conclusion, at: command.at }], undefined);
}

/** The conclusion a work shows, derived from its head run and that run's acceptance. */
export function workConclusion(work: Pick<Work, "head">, headRun: TaskRunStatus | undefined, acceptance: AcceptanceConclusion | undefined): WorkConclusion {
  if (work.head === undefined || headRun === undefined) return "head-unselected";
  if (headRun === "pending" || headRun === "running") return "in-progress";
  if (headRun === "failed") return "failed";
  if (headRun === "cancelled") return "cancelled";
  return acceptance ?? "pending";
}

export function workViolations(work: Work): string[] {
  const problems: string[] = [];
  if (!unique(work.runIds)) problems.push("a run belongs to a work once");
  if (work.head !== undefined && !work.runIds.includes(work.head)) problems.push("the head is a run of this work");
  if (work.head === undefined && !work.migrated) problems.push("only a migrated work may lack a head");
  const last = work.headHistory[work.headHistory.length - 1];
  if ((last?.runId) !== work.head) problems.push("the last head change names the current head");
  if (!work.headHistory.every(change => work.runIds.includes(change.runId))) problems.push("every head change names a run of this work");
  if ((work.status === "closed") !== (work.closedFact !== undefined)) problems.push("a closing fact is recorded exactly when the work is closed");
  return problems;
}
