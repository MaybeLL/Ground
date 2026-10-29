import { sha256 } from "./canonical-json.js";
import { DomainError, idempotencyConflict, validation } from "./errors.js";
import type { RuntimeRecord } from "./runtime-record.js";
import { runtimeGet } from "./runtime-record.js";
import type { Store, Tx } from "./store-types.js";
import type { PreflightActor, PreflightAssessmentData, PreflightObservationData, PreflightMatch, PublishGateInput, StartGateInput } from "./preflight-types.js";
import { ASSESSMENT_FORMAT, OBSERVATION_FORMAT } from "./preflight-types.js";

export const cleanPreflight = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function preflightConflict(reason: string, details: Record<string, unknown> = {}): never {
  throw new DomainError("STATE_CONFLICT", reason, false, { reason, ...details });
}
export function observationData(record: RuntimeRecord): PreflightObservationData {
  if (record.data.format !== OBSERVATION_FORMAT) throw validation("preflight", "expected an observation record");
  return record.data as unknown as PreflightObservationData;
}
export function assessmentData(record: RuntimeRecord): PreflightAssessmentData {
  if (record.data.format !== ASSESSMENT_FORMAT) throw validation("preflight", "expected an assessment record");
  return record.data as unknown as PreflightAssessmentData;
}
const hash = (request: unknown) => sha256(cleanPreflight(request));

export async function preflightReplay(store: Store, command: string, input: PreflightActor): Promise<RuntimeRecord | undefined> {
  return store.read(async tx => {
    const replay = await tx.getOperation(input.operation_id);
    if (!replay) return undefined;
    if (replay.command !== command || replay.request_hash !== hash(input)) throw idempotencyConflict(replay.command, hash(input), replay.request_hash);
    return runtimeGet(tx, "runtime_operation", input.operation_id);
  });
}
export async function savePreflightOperation(store: Store, command: string, input: PreflightActor,
  create: (tx: Tx) => Promise<RuntimeRecord>): Promise<RuntimeRecord> {
  return store.write(async tx => {
    const replay = await tx.reserveOperation({ id: input.operation_id, command, request_hash: hash(input) });
    if (replay) return runtimeGet(tx, "runtime_operation", input.operation_id);
    const record = await create(tx);
    await tx.saveRuntimeRecord(record, 0);
    await tx.completeOperation(input.operation_id, JSON.stringify({ format: "patchledger.cli/v1", ok: true,
      operation_id: input.operation_id, data: { result_type: "grounds.result.preflight-record/v1", command, preflight: record }, warnings: [] }));
    return record;
  });
}

export async function latestAssessment(tx: Tx, observationId: string): Promise<RuntimeRecord | undefined> {
  return (await tx.listRuntimeRecords("runtime_operation", observationId))
    .filter(row => row.data.format === ASSESSMENT_FORMAT)
    .sort((a, b) => Number(b.data.assessment_seq ?? 0) - Number(a.data.assessment_seq ?? 0)
      || String(b.data.assessed_at).localeCompare(String(a.data.assessed_at)) || b.id.localeCompare(a.id))[0];
}

async function matchRecord(tx: Tx, observation: RuntimeRecord, selectedAssessment?: string): Promise<PreflightMatch> {
  const data = observationData(observation);
  if (!data.observation.refreshed || data.observation.failure || !data.observation.commit) preflightConflict("a successful refreshed target observation is required");
  const latest = await latestAssessment(tx, observation.id);
  if (!latest || (selectedAssessment && latest.id !== selectedAssessment)) preflightConflict("the selected assessment is missing or no longer current; inspect preflight show and re-assess");
  const assessed = assessmentData(latest);
  if (assessed.assessment !== "applicable") preflightConflict(`preflight assessment is ${assessed.assessment}; resolve it before proceeding`);
  if (assessed.target_commit !== data.observation.commit.oid || hash(assessed.binds) !== hash(data.binds)) preflightConflict("assessment does not match the immutable observation inputs");
  return { observation_id: observation.id, assessment_id: latest.id, target_commit: data.observation.commit.oid };
}

async function canonicalFor(tx: Tx, input: { repository_id?: string; canonical_remote?: string }): Promise<string> {
  if (input.repository_id) return (await tx.getRepository(input.repository_id)).canonical_remote;
  if (!input.canonical_remote) return "";
  try { return (await tx.findRepositoryByRemote(input.canonical_remote)).canonical_remote; }
  catch (error) { if (error instanceof DomainError && error.code === "NOT_FOUND") return input.canonical_remote; throw error; }
}
const newestObservations = (rows: RuntimeRecord[]) => rows.filter(row => row.data.format === OBSERVATION_FORMAT)
  .sort((a, b) => String(b.data.observed_at).localeCompare(String(a.data.observed_at)) || b.id.localeCompare(a.id));

export async function enforcePublishGate(tx: Tx, input: PublishGateInput, expected?: PreflightMatch): Promise<PreflightMatch> {
  if (!input.target || !input.content_digest) preflightConflict("publication requires its full content binding and target");
  const canonical = await canonicalFor(tx, input);
  const candidates = expected ? [await runtimeGet(tx, "runtime_operation", expected.observation_id)]
    : newestObservations(await tx.listRuntimeRecords("runtime_operation", input.repository_id));
  const row = candidates.find(record => {
    const data = observationData(record);
    return data.phase === "publish" && data.binds.canonical_remote === canonical
      && (!data.binds.repository_id || !input.repository_id || data.binds.repository_id === input.repository_id)
      && data.target.remote === input.target!.remote && data.target.ref === input.target!.ref
      && data.binds.content_digest === input.content_digest
      && (input.reviewed_version === undefined || data.binds.scope_digest === input.reviewed_version);
  });
  if (!row) preflightConflict("publication requires a refreshed observation and assessment of this exact reviewed scope and content; run preflight observe --phase publish --workspace <name> --expected-version <version> --refresh");
  const matched = await matchRecord(tx, row, expected?.assessment_id);
  if (expected && matched.target_commit !== expected.target_commit) preflightConflict("publication target differs from the final refreshed check");
  return matched;
}

export async function enforceStartGate(tx: Tx, input: StartGateInput, expected?: PreflightMatch): Promise<PreflightMatch> {
  const revision = await tx.getIssueRevisionById(input.issue_revision_id);
  const canonical = await canonicalFor(tx, input);
  const rows = expected ? [await runtimeGet(tx, "runtime_operation", expected.observation_id)]
    : newestObservations(await tx.listRuntimeRecords("runtime_operation", input.repository_id));
  const row = rows.find(record => {
    const data = observationData(record);
    return data.phase === "start" && !data.binds.dev_run_id && data.binds.issue_revision_id === revision.id
      && data.binds.repository_id === input.repository_id && data.binds.canonical_remote === canonical
      && data.target.remote === revision.target_branch?.remote && data.target.ref === revision.target_branch?.ref
      && data.observation.commit?.oid === input.expected_commit;
  });
  if (!row) preflightConflict("start requires a refreshed Issue-version assessment at the selected target base; run preflight observe --phase start --issue <id> --issue-version <version> --refresh");
  const matched = await matchRecord(tx, row, expected?.assessment_id);
  if (expected && matched.target_commit !== expected.target_commit) preflightConflict("start target differs from the final refreshed check");
  return matched;
}
