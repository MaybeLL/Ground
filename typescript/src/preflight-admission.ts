import { DomainError } from "./errors.js";
import type { RuntimeRecord } from "./runtime-record.js";
import type { Tx } from "./store-types.js";
import { latestAssessment } from "./preflight-records.js";

export const PREPARATION_FORMAT = "grounds.preflight-preparation/v1";
export const ADMISSION_FORMAT = "grounds.preflight-admission/v1";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const isTransition = (row: RuntimeRecord): boolean =>
  row.data.format === PREPARATION_FORMAT || row.data.format === ADMISSION_FORMAT;
const sequence = (row: RuntimeRecord): number =>
  typeof row.data.transition_seq === "number" && Number.isSafeInteger(row.data.transition_seq)
    && row.data.transition_seq >= 0 ? row.data.transition_seq : -1;
const timestamp = (row: RuntimeRecord): string =>
  String(row.data.format === ADMISSION_FORMAT ? row.data.admitted_at ?? "" : row.data.prepared_at ?? "");
const newestFirst = (a: RuntimeRecord, b: RuntimeRecord): number =>
  sequence(b) - sequence(a) || timestamp(b).localeCompare(timestamp(a)) || b.id.localeCompare(a.id);

/** The caller must hold tx.lockDevRun(devRunId) while allocating and saving. */
export async function nextPreflightTransition(tx: Tx, devRunId: string): Promise<number> {
  const rows = (await tx.listRuntimeRecords("runtime_operation", devRunId)).filter(isTransition);
  const highest = rows.reduce((max, row) => Math.max(max, sequence(row)), 0);
  if (highest >= Number.MAX_SAFE_INTEGER) {
    throw new DomainError("STATE_CONFLICT", `DevRun ${devRunId} preflight transition sequence exhausted`, false, { resource_id: devRunId });
  }
  return highest + 1;
}

/** Read-only: callers that mutate must acquire the DevRun fence themselves. */
export async function getCurrentAdmission(tx: Tx, devRunId: string): Promise<RuntimeRecord | undefined> {
  const run = await tx.getDevRun(devRunId);
  const revision = await tx.getIssueRevisionById(run.issue_revision_id);
  if (!revision.target_branch) return undefined;
  const rows = await tx.listRuntimeRecords("runtime_operation", devRunId);
  if (rows.some(row => row.data.format === "grounds.devrun-sync/v1"
    && !["completed", "abandoned"].includes(String(row.data.phase)))) return undefined;
  const latest = rows.filter(isTransition).sort(newestFirst)[0];
  if (!latest || latest.data.format !== ADMISSION_FORMAT) return undefined;
  const data = latest.data;
  const base = run.base_commit ?? revision.baseline.git_oid;
  if (data.dev_run_id !== devRunId || (data.issue_revision_id !== undefined && data.issue_revision_id !== revision.id)
    || data.base_commit !== base || data.target_commit !== base) return undefined;
  if (typeof data.assessment_id !== "string" || typeof data.observation_id !== "string") return undefined;
  const assessment = (await tx.getRuntimeRecord("runtime_operation", data.assessment_id))?.data;
  const observation = (await tx.getRuntimeRecord("runtime_operation", data.observation_id))?.data;
  if (assessment?.format !== "grounds.preflight-assessment/v1" || assessment.assessment !== "applicable"
    || assessment.observation_id !== data.observation_id || assessment.target_commit !== base
    || object(assessment.binds).issue_revision_id !== revision.id) return undefined;
  const observed = object(observation?.observation);
  if (observation?.format !== "grounds.preflight-observation/v1" || observation.phase !== "start"
    || object(observation.binds).issue_revision_id !== revision.id || observed.refreshed !== true
    || observed.failure !== undefined || object(observed.commit).oid !== base) return undefined;
  if ((await latestAssessment(tx, data.observation_id))?.id !== data.assessment_id) return undefined;
  const binds = object(observation.binds), inputs = object(data.input_binding);
  if (object(observation.target).remote !== revision.target_branch.remote || object(observation.target).ref !== revision.target_branch.ref) return undefined;
  if (binds.dev_run_id !== undefined) {
    if (binds.dev_run_id !== run.id || inputs.dev_run_id !== run.id || inputs.parent_candidate_id !== run.refines_candidate_id) return undefined;
    const keys = ["dev_run_version", "base_commit", "source_head", "source_tree", "input_digest", "sync_digest", "workspace_identity", "preparation_id", "parent_candidate_id", "parent_result_tree", "parent_patch_digest"];
    if (keys.some(key => binds[key] !== inputs[key])) return undefined;
  } else if (run.refines_candidate_id) return undefined;
  return latest;
}

export async function assertDevRunAdmitted(tx: Tx, devRunId: string): Promise<void> {
  const run = await tx.getDevRun(devRunId);
  const revision = await tx.getIssueRevisionById(run.issue_revision_id);
  if (!revision.target_branch) return;
  if (run.state === "open" && await getCurrentAdmission(tx, devRunId)) return;
  throw new DomainError("STATE_CONFLICT", `DevRun ${devRunId} requires preflight admission for an open development round; run grounds preflight observe --phase start --dev-run ${devRunId} --refresh, grounds preflight assess --observation <id> --file assessment.json, then grounds devrun admit --dev-run ${devRunId} --preflight <assessment-id> --refresh`, false, { resource_id: devRunId });
}
