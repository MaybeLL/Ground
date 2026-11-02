import type { Digest, Id } from "./kernel.js";
import type { GradingRecord } from "./grading.js";
import type { ExperimentRun, Member } from "./experiment.js";
import type { FailureClass, TaskRunStatus } from "./task-run.js";

// Everything here is derived from stored facts and stored nowhere.

// ---- archive integrity ----------------------------------------------------

/** How a delivered object stands now: intact, its reference moved or lost but the object is still reachable, or gone. */
export type Integrity = "intact" | "ref-changed" | "unavailable";
export function integrityOf(observation: { recordedOid: string; remoteTarget?: string; objectAvailable: boolean }): Integrity {
  if (observation.remoteTarget === observation.recordedOid) return "intact";
  return observation.objectAvailable ? "ref-changed" : "unavailable";
}
/** Only a delivery whose object can still be obtained may enter a new evaluation, an export or a rerun. */
export const reproducible = (integrity: Integrity): boolean => integrity !== "unavailable";

// ---- batch results --------------------------------------------------------

export type NotStarted = "task-failed" | "task-cancelled" | "batch-cancelled" | "not-scheduled";
/** Why a member has no grading, or undefined when grading can begin because the sample was delivered. */
export function gradingNotStarted(run: ExperimentRun, member: Member, task: { status: TaskRunStatus } | undefined): NotStarted | undefined {
  if (!task) return run.cancelIntent ? "batch-cancelled" : "not-scheduled";
  if (task.status === "failed") return "task-failed";
  if (task.status === "cancelled") return "task-cancelled";
  if (task.status === "delivered") return undefined;
  return run.cancelIntent ? "batch-cancelled" : "not-scheduled";
}
/** A failed sample whose cause was the infrastructure shows as an execution error, never as a quality result. */
export const isExecutionError = (failure: FailureClass | undefined): boolean => failure === "infrastructure";

/** What a re-evaluation sequence is: the same slot, grader revision, targets and materials. */
export interface SlotIdentity { readonly experimentRunId: Id; readonly caseKey: string; readonly repeatIndex: number; readonly requirementKey: string; readonly graderRevisionId: Id; readonly targets: readonly string[]; readonly materialsDigest: Digest }

const identityOf = (g: GradingRecord): string[] => g.targets.map(t => `${t.type}:${t.id}:${t.digest}`).sort();
const materialsKey = (g: GradingRecord): string => g.materials.map(m => `${m.id}:${m.digest}`).sort().join("|");
function inSequence(g: GradingRecord, slot: SlotIdentity, materialsFingerprint: string): boolean {
  return g.purpose === "measure" && g.origin.type === "member" && g.origin.experimentRunId === slot.experimentRunId && g.origin.caseKey === slot.caseKey && g.origin.repeatIndex === slot.repeatIndex
    && g.origin.requirementKey === slot.requirementKey && g.graderRevision.revisionId === slot.graderRevisionId && identityOf(g).join(",") === [...slot.targets].sort().join(",") && materialsKey(g) === materialsFingerprint;
}

export interface Adoption {
  /** The record the batch result reads: the latest one that completed with a legitimate grade. */
  readonly adopted?: Id;
  /** A later attempt in the same sequence failed; shown beside the adopted result, never hiding it. */
  readonly latestFault?: { readonly id: Id; readonly fault: string };
  readonly attempts: number;
}
/** The adoption rule for re-evaluation: latest normal completion wins, history is kept, and a newer failure is disclosed. */
export function adoptGrading(records: readonly GradingRecord[], slot: SlotIdentity, materialsFingerprint: string): Adoption {
  const sequence = records.filter(g => inSequence(g, slot, materialsFingerprint)).sort((a, b) => a.requestSeq - b.requestSeq);
  const completed = sequence.filter(g => g.status === "completed");
  const adopted = completed[completed.length - 1];
  const later = sequence.filter(g => g.status === "grader_fault" && (!adopted || g.requestSeq > adopted.requestSeq));
  const fault = later[later.length - 1];
  return { ...(adopted ? { adopted: adopted.id } : {}), ...(fault ? { latestFault: { id: fault.id, fault: fault.fault ?? "" } } : {}), attempts: sequence.length };
}

export type RequirementState = "adopted" | "error" | "missing";
/** A sample's gradings are complete when every required slot has an adopted record. */
export function completeness(records: readonly GradingRecord[], slots: ReadonlyArray<{ slot: SlotIdentity; materialsFingerprint: string }>): { complete: boolean; states: Record<string, RequirementState> } {
  const states: Record<string, RequirementState> = {};
  for (const { slot, materialsFingerprint } of slots) {
    const a = adoptGrading(records, slot, materialsFingerprint);
    states[slot.requirementKey] = a.adopted ? "adopted" : a.latestFault ? "error" : "missing";
  }
  return { complete: Object.values(states).every(s => s === "adopted"), states };
}

export const materialsFingerprint = (materials: readonly { id: Id; digest: Digest }[]): string => materials.map(m => `${m.id}:${m.digest}`).sort().join("|");
