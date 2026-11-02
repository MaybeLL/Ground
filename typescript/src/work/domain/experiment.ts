import { advance, conflict, digestOf, firstInvalid, invalid, isId, isNonNegativeInteger, isText, isTimestamp, ok, unique, type Decision, type Hasher, type Id, type Result, type Timestamp, type Versioned } from "./kernel.js";
import { isRevisionRef, type RevisionRef } from "./definitions.js";

/** One planned sample: an evaluation case run for the n-th time. The key is unique within the batch. */
export interface Member { readonly key: string; readonly caseKey: string; readonly repeatIndex: number; readonly taskRunRequestId: Id }

export interface ExperimentRun extends Versioned {
  readonly id: Id;
  readonly experimentId: Id;
  readonly suite: RevisionRef;
  readonly agent: RevisionRef;
  readonly repeatCount: number;
  readonly taskConcurrency: number;
  /** Registered once when the batch is launched and never changed afterwards. */
  readonly members: readonly Member[];
  readonly cancelIntent?: { readonly at: Timestamp };
  readonly createdAt: Timestamp;
}

export type ExperimentEvent =
  | { readonly type: "launched"; readonly experimentRunId: Id; readonly members: number; readonly at: Timestamp }
  | { readonly type: "cancel-requested"; readonly experimentRunId: Id; readonly at: Timestamp };

export const memberKey = (caseKey: string, repeatIndex: number): string => `${caseKey}#${repeatIndex}`;

/** Derived from the member, so launching the same member twice names the same task run. */
export function deriveRequestId(experimentRunId: Id, caseKey: string, repeatIndex: number, hash: Hasher): Result<Id> {
  const digest = digestOf({ experimentRunId, caseKey, repeatIndex }, hash);
  return digest.ok ? ok(`tr-${digest.value.slice("sha256:".length, "sha256:".length + 32)}`) : digest;
}

export function launchExperimentRun(
  command: { id: Id; experimentId: Id; suite: RevisionRef; agent: RevisionRef; caseKeys: readonly string[]; repeatCount: number; taskConcurrency: number; at: Timestamp },
  hash: Hasher,
): Result<Decision<ExperimentRun, ExperimentEvent>> {
  const bad = firstInvalid([["id", isId(command.id)], ["experimentId", isId(command.experimentId)], ["suite", isRevisionRef(command.suite, "suite")], ["agent", isRevisionRef(command.agent, "agent")],
    ["caseKeys", command.caseKeys.length > 0 && command.caseKeys.every(k => isText(k, 256)) && unique(command.caseKeys)],
    ["repeatCount", Number.isSafeInteger(command.repeatCount) && command.repeatCount >= 1 && command.repeatCount <= 1000],
    ["taskConcurrency", Number.isSafeInteger(command.taskConcurrency) && command.taskConcurrency >= 1 && command.taskConcurrency <= 1000], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const members: Member[] = [];
  for (const caseKey of command.caseKeys) for (let repeatIndex = 0; repeatIndex < command.repeatCount; repeatIndex++) {
    const request = deriveRequestId(command.id, caseKey, repeatIndex, hash);
    if (!request.ok) return request;
    members.push({ key: memberKey(caseKey, repeatIndex), caseKey, repeatIndex, taskRunRequestId: request.value });
  }
  const state: ExperimentRun = { id: command.id, experimentId: command.experimentId, suite: command.suite, agent: command.agent, repeatCount: command.repeatCount, taskConcurrency: command.taskConcurrency, members, createdAt: command.at, version: 1 };
  return ok({ state, events: [{ type: "launched", experimentRunId: state.id, members: members.length, at: command.at }], outcome: undefined });
}

export function requestExperimentCancel(run: ExperimentRun, command: { at: Timestamp }): Result<Decision<ExperimentRun, ExperimentEvent>> {
  if (!isTimestamp(command.at)) return invalid("at is required");
  if (run.cancelIntent) return advance(run, {}, [], undefined);
  return advance(run, { cancelIntent: { at: command.at } }, [{ type: "cancel-requested", experimentRunId: run.id, at: command.at }], undefined);
}

/** Whether work may still be started for a member: never after cancellation, and only for members that were planned. */
export function mayStartMember(run: ExperimentRun, key: string): Result<Member> {
  const member = run.members.find(m => m.key === key);
  if (!member) return conflict("the member is not part of this batch");
  if (run.cancelIntent) return conflict("the batch was cancelled; nothing new may start");
  return ok(member);
}

export function experimentViolations(run: ExperimentRun): string[] {
  const problems: string[] = [];
  if (!unique(run.members, m => m.key)) problems.push("a member key is unique within the batch");
  if (!unique(run.members, m => m.taskRunRequestId)) problems.push("a member has its own task run request");
  const cases = new Set(run.members.map(m => m.caseKey));
  if (run.members.length !== cases.size * run.repeatCount) problems.push("every case has exactly the planned number of repeats");
  if (!run.members.every(m => m.repeatIndex >= 0 && m.repeatIndex < run.repeatCount && isNonNegativeInteger(m.repeatIndex) && m.key === memberKey(m.caseKey, m.repeatIndex))) problems.push("members are keyed by case and repeat");
  return problems;
}
