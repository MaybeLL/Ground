import { join, resolve } from "node:path";
import { sha256 } from "./canonical-json.js";
import { DomainError, validation } from "./errors.js";
import { isUUIDv7, newUUIDv7 } from "./identity.js";
import { atomicPrivateWrite, safeRead } from "./runtime-files.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { assessVolumeEvidence, completedVolumeArchive } from "./code-route-volume-evidence.js";
import { archiveIntegrity, type RetainedVolume } from "./code-route-volume-preview.js";
import type { ServiceVolumeArchive } from "./code-route-volume-archive.js";
import type { RestoredExportSource, ServiceVolumeRestoration, VolumeBusinessCheck } from "./code-route-volume-restore.js";
import type { ServiceCleanupEngine } from "./code-route-service-cleanup.js";
import type { RouteExecution } from "./code-route-execution.js";
import type { Store } from "./store-types.js";

export interface VolumeDeleteRequest {
  route_id: string; execution_id: string; archive_id: string; operation_id: string;
  expected_version: number; early?: boolean; attribution: Attribution;
}
export interface VolumeDeletion {
  scope: "service_volume"; operation_id: string; route_id: string; execution_id: string; engine_id: string;
  evidence_archive_id: string; volume: { name: string; created_at: string; state: "deleted" };
  recheck: ServiceVolumeArchive; deleted_at: string;
}
interface Journal {
  format: "grounds.volume-deletion/v1"; request_digest: string;
  phase: "planned" | "capturing" | "removing" | "blocked" | "completed";
  attempts: { id: string; archive?: ServiceVolumeArchive }[]; result?: VolumeDeletion;
}
const fail = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };

/** Invoked under the Workspace and route locks. An explicit request never deletes archives or images. */
export async function deleteServiceVolume(store: Store, context: { run: RouteExecution; engine: ServiceCleanupEngine;
  instance_id: string; lifecycle_version: number; gate: "ready" | "retention" | "pinned" }, input: VolumeDeleteRequest): Promise<VolumeDeletion> {
  const request = structuredClone(input), { run, engine } = context;
  if (!isUUIDv7(request.operation_id) || !Number.isSafeInteger(request.expected_version) || request.expected_version < 1)
    throw validation("volume_delete", "requires operation UUIDv7 and lifecycle version");
  validateAttribution(request.attribution);
  if (!engine.exportVolume || !engine.removeVolume) return fail("Engine does not support protected volume deletion");
  const { archive: b, snapshot } = await completedVolumeArchive(store, run, request.archive_id);
  const requestDigest = sha256({ request, database: run.database_id, host: run.host_id, archive: b, snapshot });
  let row = await store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
  if (row && (row.parent_id !== run.route_id || row.data.format !== "grounds.volume-deletion-operation/v1"
    || row.data.request_digest !== requestDigest)) return fail("Volume deletion differs from its original request");
  const file = join(resolve(run.code_path, "../../../.."), "runtime", "volume-deletions", `${request.operation_id}.json`);
  let journal: Journal | undefined;
  try { journal = JSON.parse(safeRead(file).toString()) as Journal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("Volume deletion journal is unreadable"); }
  if (journal && (!row || journal.format !== "grounds.volume-deletion/v1" || journal.request_digest !== requestDigest
    || !["planned", "capturing", "removing", "blocked", "completed"].includes(journal.phase))) return fail("Volume deletion journal identity changed");
  if (row?.data.phase === "completed" && journal?.phase !== "completed") return fail("Completed deletion journal is unavailable");
  const persist = () => atomicPrivateWrite(file, JSON.stringify(journal));
  const history = async () => {
    const proof = await assessVolumeEvidence(store, run, engine, { archive_id: b.operation_id, instance_id: context.instance_id,
      lifecycle_version: context.lifecycle_version, gate: "ready", history_only: true });
    if (proof.evidence_status !== "complete") fail(`Volume deletion evidence is blocked: ${proof.blockers.join(", ")}`);
  };
  const lifecycle = () => {
    if (context.gate !== "ready" || context.lifecycle_version !== request.expected_version)
      fail("Volume deletion lifecycle version, retention or pin prevents removal");
  };
  const verifyCapture = (archive: ServiceVolumeArchive) => {
    if (archiveIntegrity(run, archive, snapshot) !== "valid" || archive.execution_id !== run.execution_id
      || archive.source_restore_id !== b.source_restore_id || archive.digest !== b.digest
      || sha256(archive.capture) !== sha256(b.capture) || archive.comparison?.status !== "identical"
      || archive.comparison.archive_id !== b.comparison?.archive_id || archive.comparison.archive_digest !== b.digest)
      fail("Fresh deletion archive is unavailable or differs from verified contents; retain source");
  };
  const complete = async () => {
    const fresh = journal!.attempts.at(-1)?.archive ?? fail("Deletion lacks a durable fresh archive");
    await history(); verifyCapture(fresh);
    if (!journal!.result) {
      journal!.result = { scope: "service_volume", operation_id: request.operation_id, route_id: run.route_id,
        execution_id: run.execution_id, engine_id: run.engine_id, evidence_archive_id: b.operation_id,
        volume: { name: b.source_volume, created_at: b.source_created_at, state: "deleted" }, recheck: fresh, deleted_at: new Date().toISOString() };
      journal!.phase = "completed"; persist();
    }
    if (row!.data.phase === "completed") {
      if (sha256(row!.data.result) !== sha256(journal!.result)) fail("Deletion completion differs from recorded history");
    } else await store.write(tx => tx.saveRuntimeRecord({ ...row!, version: row!.version + 1,
      data: { ...row!.data, phase: "completed", result: journal!.result } }, row!.version));
    return journal!.result!;
  };
  if (journal?.phase === "completed") return complete(); // Historical: never observe or touch replacements.
  lifecycle(); await history();
  let restoration: RestoredExportSource | undefined;
  if (b.source_restore_id) {
    const source = await store.read(tx => tx.getRuntimeRecord("runtime_operation", b.source_restore_id!));
    if (!source || source.parent_id !== run.route_id || source.data.format !== "grounds.service-volume-restoration-operation/v1"
      || source.data.execution_id !== run.execution_id || source.data.phase !== "completed") return fail("Restored deletion source is unavailable");
    const original = await completedVolumeArchive(store, run, source.data.archive_id as string);
    restoration = { input: { operation_id: b.source_restore_id, archive: original.archive, snapshot: original.snapshot,
      ...(source.data.checks ? { checks: source.data.checks as unknown as VolumeBusinessCheck[] } : {}) }, result: source.data.result as unknown as ServiceVolumeRestoration };
  }
  const observe = async (): Promise<RetainedVolume> => {
    if (restoration && engine.inspectRestoreVolume) return (await engine.inspectRestoreVolume(restoration.input)).volume;
    if (!restoration && engine.retainedVolume) return engine.retainedVolume();
    return fail("Engine cannot observe exact deletion source");
  };
  const matching = (volume: RetainedVolume, allowConsumer = false) => {
    if (volume.state !== "matching" || volume.name !== b.source_volume || volume.expected_created_at !== b.source_created_at)
      fail("Deletion source identity is unavailable or replaced");
    if (volume.consumers === null || (!allowConsumer && volume.consumers.length)) fail("Deletion source has unknown or additional consumers");
  };
  const current = await observe();
  if (current.state === "missing") {
    if (journal?.phase !== "removing") return fail("Source disappeared without durable deletion intent");
    return complete();
  }
  matching(current, journal?.phase === "capturing");
  if (journal?.phase === "blocked") return fail("Fresh contents differed; retain archives and source, verify a new baseline before another deletion request");
  if (!row) {
    await store.write(async tx => {
      await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.service-volume-delete", request_hash: sha256(request) });
      const data = { format: "grounds.volume-deletion-operation/v1", request_digest: requestDigest, phase: "pending",
        archive_id: request.archive_id, execution_id: request.execution_id, attribution: request.attribution };
      await tx.saveRuntimeRecord({ id: request.operation_id, parent_id: run.route_id, kind: "runtime_operation", version: 1, data }, 0);
      await tx.completeOperation(request.operation_id, JSON.stringify(data));
    });
    row = (await store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id)))!;
  }
  if (!journal) { journal = { format: "grounds.volume-deletion/v1", request_digest: requestDigest, phase: "planned", attempts: [] }; persist(); }
  const capture = async (attempt: Journal["attempts"][number]) => {
    // Register every retained recheck as a normal archive so even a differing result can be restored via the public CLI.
    const exportRequest = { route_id: run.route_id, execution_id: run.execution_id, operation_id: attempt.id,
      attribution: request.attribution, compare_archive_id: b.comparison!.archive_id,
      verified_restore_id: b.capture!.verification!.restore_id, ...(b.source_restore_id ? { restore_id: b.source_restore_id } : {}) };
    let exported = await store.read(tx => tx.getRuntimeRecord("runtime_operation", attempt.id));
    if (exported && (exported.parent_id !== run.route_id || exported.data.format !== "grounds.service-volume-export-operation/v1"
      || exported.data.request_digest !== sha256(exportRequest))) return fail("Deletion recheck archive reservation changed");
    if (!exported) {
      await store.write(async tx => {
        await tx.reserveOperation({ id: attempt.id, command: "code-workspace.service-volume-export", request_hash: sha256(exportRequest) });
        const data = { format: "grounds.service-volume-export-operation/v1", request_digest: sha256(exportRequest), snapshot,
          attribution: request.attribution, phase: "pending", comparison: { archive_id: b.comparison!.archive_id, archive_digest: b.digest },
          verification: b.capture!.verification!, ...(b.source_restore_id ? { source_restore_id: b.source_restore_id, execution_id: run.execution_id } : {}) };
        await tx.saveRuntimeRecord({ id: attempt.id, parent_id: run.route_id, kind: "runtime_operation", version: 1, data }, 0);
        await tx.completeOperation(attempt.id, JSON.stringify(data));
      });
      exported = (await store.read(tx => tx.getRuntimeRecord("runtime_operation", attempt.id)))!;
    }
    attempt.archive = await engine.exportVolume!({ operation_id: attempt.id, snapshot,
      comparison: { archive_id: b.comparison!.archive_id, archive_digest: b.digest }, verification: b.capture!.verification!,
      ...(restoration ? { restoration } : {}) });
    if (exported.data.phase === "completed") {
      if (sha256(exported.data.result) !== sha256(attempt.archive)) return fail("Deletion recheck differs from its registered archive");
    } else await store.write(tx => tx.saveRuntimeRecord({ ...exported!, version: exported!.version + 1,
      data: { ...exported!.data, phase: "completed", result: attempt.archive } }, exported!.version));
    persist();
    try { verifyCapture(attempt.archive); }
    catch { journal!.phase = "blocked"; persist(); throw new DomainError("STATE_CONFLICT", "Fresh contents differ or archive integrity failed; source retained", false,
      { recheck_archive_id: attempt.id, target_path: attempt.archive.path }); }
  };
  // Reconcile an interrupted helper first. Its bytes may be stale and never authorize this retry's deletion.
  const previous = journal.attempts.at(-1);
  if (previous && !previous.archive) await capture(previous);
  matching(await observe()); await history();
  if (journal.attempts.length >= 32) return fail("Deletion retry limit reached; retained attempts require inspection");
  const attempt = { id: newUUIDv7() }; journal.attempts.push(attempt); journal.phase = "capturing"; persist();
  await capture(attempt);
  await history(); verifyCapture(journal.attempts.at(-1)!.archive!); matching(await observe()); lifecycle();
  journal.phase = "removing"; persist();
  await engine.removeVolume(snapshot); // Driver uses no force; current consumers remain an engine-level guard.
  const after = await observe();
  if (after.state !== "missing") return fail("Volume removal is unproven or a replacement appeared; retain deletion intent");
  return complete();
}
