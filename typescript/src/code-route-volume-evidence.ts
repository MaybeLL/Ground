import { join, resolve } from "node:path";
import { sha256 } from "./canonical-json.js";
import { DomainError } from "./errors.js";
import { safeRead } from "./runtime-files.js";
import { isUUIDv7 } from "./identity.js";
import { validateVolumeChecks, type RestoredExportSource, type VolumeBusinessCheck, type ServiceVolumeRestoration } from "./code-route-volume-restore.js";
import { readVolumeRetirement, type VolumeRetirement } from "./code-route-volume-retirement.js";
import { archiveIntegrity, unknownVolume } from "./code-route-volume-preview.js";
import type { RouteExecution } from "./code-route-execution.js";
import type { ServiceVolumeArchive } from "./code-route-volume-archive.js";
import type { ServiceCleanupEngine, ServiceSnapshot } from "./code-route-service-cleanup.js";
import type { Store } from "./store-types.js";

export interface VolumeVerificationReference {
  restore_id: string; result_digest: string; archive_id: string; archive_digest: string; checks_digest: string;
}
export interface VolumeCapture {
  retirement_id: string; retirement_digest: string; verification?: VolumeVerificationReference;
}
const fail = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };

/** Historical verification: no restart, no current-health inference, no dependency on target still existing. */
export function verificationReference(run: RouteExecution, source: RestoredExportSource): VolumeVerificationReference {
  const { input, result } = source;
  validateVolumeChecks(input.checks);
  const checks = result.verification.business_checks;
  if (result.operation_id !== input.operation_id || result.archive_id !== input.archive.operation_id
    || result.archive_digest !== input.archive.digest || result.route_id !== run.route_id || result.execution_id !== run.execution_id
    || result.engine_id !== run.engine_id || result.image !== input.archive.image || result.container_state !== "stopped"
    || result.volume_name !== `grounds-volume-restore-${input.operation_id}` || result.volume_name === input.archive.source_volume
    || result.verification.kind !== "postgres-startup-and-catalog" || !checks || checks.status !== "passed"
    || checks.checks_digest !== sha256(input.checks)
    || sha256(checks.results) !== sha256(input.checks.map(check => ({ ...check, actual_count: check.expected_count, status: "passed" }))))
    return fail("Verification requires matching passed fixed business checks on an independent restoration");
  const record = JSON.parse(safeRead(join(resolve(run.code_path, "../../../.."), "runtime", "volume-restores", `${input.operation_id}.json`)).toString());
  if (record.format !== "grounds.service-volume-restore/v1" || record.phase !== "completed" || record.probe_failed
    || record.request_digest !== sha256({ input, database: run.database_id, host: run.host_id })
    || record.container_id !== result.container_id || record.volume_created_at !== result.volume_created_at
    || sha256(record.result) !== sha256(result) || sha256(record.verification) !== sha256(result.verification))
    return fail("Verification requires matching completed local restoration evidence");
  return { restore_id: result.operation_id, result_digest: sha256(result), archive_id: result.archive_id,
    archive_digest: result.archive_digest, checks_digest: checks.checks_digest };
}

export async function completedVolumeArchive(store: Store, run: RouteExecution, id: string) {
  if (!isUUIDv7(id)) return fail("Archive ID must be UUIDv7");
  const row = await store.read(tx => tx.getRuntimeRecord("runtime_operation", id));
  const archive = row?.data.result as unknown as ServiceVolumeArchive | undefined;
  if (!row || row.parent_id !== run.route_id || row.data.format !== "grounds.service-volume-export-operation/v1"
    || row.data.phase !== "completed" || !archive || archive.operation_id !== id || archive.route_id !== run.route_id
    || archive.execution_id !== run.execution_id) return fail("Requires a completed archive from this execution");
  return { archive, snapshot: row.data.snapshot as unknown as ServiceSnapshot };
}

/** The capture's causal references were persisted before reading tar bytes; old journals never acquire them on replay. */
function recordedCapture(run: RouteExecution, archive: ServiceVolumeArchive, snapshot: ServiceSnapshot): boolean {
  try {
    if (!archive.capture) return false;
    const journal = JSON.parse(safeRead(join(resolve(run.code_path, "../../../.."), "runtime", "volume-exports", `${archive.operation_id}.json`)).toString());
    const comparison = archive.comparison ? { archive_id: archive.comparison.archive_id, archive_digest: archive.comparison.archive_digest } : undefined;
    const digest = sha256({ operationID: archive.operation_id, execution: run.execution_id, route: run.route_id, snapshot,
      image: run.environment!.configuration.postgres!.image, ...(comparison ? { comparison } : {}),
      ...(archive.source_restore_id ? { source_restore_id: archive.source_restore_id } : {}),
      ...(archive.capture.verification ? { verification: archive.capture.verification } : {}) });
    return journal.format === "grounds.service-volume-export/v1" && journal.phase === "completed"
      && journal.request_digest === digest && sha256(journal.result) === sha256(archive) && sha256(journal.capture) === sha256(archive.capture);
  } catch { return false; }
}

/** Reads existing evidence and current identity only. It neither re-reads volume contents nor authorizes deletion. */
export async function assessVolumeEvidence(store: Store, run: RouteExecution, engine: ServiceCleanupEngine,
  input: { archive_id: string; instance_id: string; lifecycle_version: number; gate: "ready" | "retention" | "pinned"; history_only?: boolean }) {
  const selected = await completedVolumeArchive(store, run, input.archive_id), b = selected.archive;
  const blockers: string[] = input.gate === "ready" ? [] : [input.gate];
  let source = unknownVolume(b.source_volume, b.source_created_at);
  if (!input.history_only && b.source_restore_id) {
    try {
      const restored = await store.read(tx => tx.getRuntimeRecord("runtime_operation", b.source_restore_id!));
      if (!restored || restored.parent_id !== run.route_id || restored.data.format !== "grounds.service-volume-restoration-operation/v1"
        || restored.data.execution_id !== run.execution_id || restored.data.phase !== "completed") throw new Error("source unavailable");
      const old = await completedVolumeArchive(store, run, restored.data.archive_id as string);
      if (engine.inspectRestoreVolume) source = (await engine.inspectRestoreVolume({ operation_id: b.source_restore_id,
        archive: old.archive, snapshot: old.snapshot, ...(restored.data.checks ? { checks: restored.data.checks as unknown as VolumeBusinessCheck[] } : {}) })).volume;
    } catch { blockers.push("source_restore_unavailable"); }
  } else if (!input.history_only && engine.retainedVolume) source = await engine.retainedVolume();
  if (!input.history_only && (source.state !== "matching" || source.name !== b.source_volume || source.expected_created_at !== b.source_created_at))
    blockers.push("source_identity_unproven");
  if (!input.history_only && (source.consumers === null || source.consumers.length)) blockers.push("source_not_unreferenced");
  let retirement: VolumeRetirement | undefined;
  try {
    retirement = readVolumeRetirement(run, b.source_volume)?.retirement;
    const row = retirement ? await store.read(tx => tx.getRuntimeRecord("runtime_operation", retirement!.operation_id)) : undefined;
    if (!retirement || retirement.execution_id !== run.execution_id || retirement.source_restore_id !== b.source_restore_id
      || retirement.volume_created_at !== b.source_created_at || !row || row.parent_id !== run.route_id
      || row.data.format !== "grounds.volume-retirement-operation/v1" || row.data.phase !== "completed"
      || sha256(row.data.retirement) !== sha256(retirement)) blockers.push("retirement_unproven");
  } catch { blockers.push("retirement_unproven"); }
  if (archiveIntegrity(run, b, selected.snapshot) !== "valid") blockers.push("recheck_archive_unavailable");
  if (!recordedCapture(run, b, selected.snapshot)) blockers.push("recheck_capture_unproven");
  if (!retirement || !b.capture || b.capture.retirement_id !== retirement.operation_id || b.capture.retirement_digest !== sha256(retirement))
    blockers.push("recheck_not_after_retirement");
  let a: ServiceVolumeArchive | undefined;
  try {
    if (!b.comparison || b.comparison.archive_id === b.operation_id) throw new Error("comparison missing");
    const baseline = await completedVolumeArchive(store, run, b.comparison.archive_id); a = baseline.archive;
    if (archiveIntegrity(run, a, baseline.snapshot) !== "valid") blockers.push("baseline_archive_unavailable");
    if (!recordedCapture(run, a, baseline.snapshot) || !retirement || !a.capture
      || a.capture.retirement_id !== retirement.operation_id || a.capture.retirement_digest !== sha256(retirement)) blockers.push("baseline_capture_unproven");
    if (a.source_volume !== b.source_volume || a.source_created_at !== b.source_created_at || a.source_restore_id !== b.source_restore_id
      || a.engine_id !== b.engine_id || a.image !== b.image) blockers.push("archive_source_mismatch");
    if (b.comparison.algorithm !== "docker-tar-sha256/v1" || b.comparison.status !== "identical"
      || b.comparison.archive_digest !== a.digest || b.digest !== a.digest) blockers.push("recheck_differs");
  } catch { blockers.push("baseline_archive_unavailable"); }
  try {
    const ref = b.capture?.verification;
    if (!ref || !a || ref.archive_id !== a.operation_id || ref.archive_digest !== a.digest) throw new Error("verification missing");
    const row = await store.read(tx => tx.getRuntimeRecord("runtime_operation", ref.restore_id));
    if (!row || row.parent_id !== run.route_id || row.data.format !== "grounds.service-volume-restoration-operation/v1"
      || row.data.phase !== "completed" || row.data.execution_id !== run.execution_id || row.data.archive_id !== a.operation_id) throw new Error("verification unavailable");
    const reference = verificationReference(run, { input: { operation_id: ref.restore_id, archive: a,
      snapshot: (await completedVolumeArchive(store, run, a.operation_id)).snapshot, checks: row.data.checks as unknown as VolumeBusinessCheck[] }, result: row.data.result as unknown as ServiceVolumeRestoration });
    if (sha256(reference) !== sha256(ref)) throw new Error("verification changed");
  } catch { blockers.push("verification_unproven"); }
  return { scope: "volume_evidence" as const, instance_id: input.instance_id, route_id: run.route_id, execution_id: run.execution_id,
    archive_id: b.operation_id, baseline_archive_id: b.comparison?.archive_id ?? null,
    verification_id: b.capture?.verification?.restore_id ?? null, retirement_id: retirement?.operation_id ?? null,
    lifecycle_version: input.lifecycle_version, observed_at: new Date().toISOString(), source,
    evidence_status: blockers.length ? "blocked" as const : "complete" as const, blockers: [...new Set(blockers)],
    current_contents: "not_rechecked" as const, deletion_supported: true as const };
}
