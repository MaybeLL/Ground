import type { RestorationCleanup } from "./code-route-restoration-cleanup.js";
import { deleteServiceVolume, type VolumeDeleteRequest } from "./code-route-volume-delete.js";
import { assessVolumeEvidence, verificationReference, type VolumeVerificationReference } from "./code-route-volume-evidence.js";
import { readVolumeRetirement, managedVolumeWrites, persistVolumeRetirement, type VolumeRetirement } from "./code-route-volume-retirement.js";
import { archiveIntegrity, volumeBlockers, unknownVolume, type RetainedVolume } from "./code-route-volume-preview.js";
import { validateVolumeChecks, type RestoredExportSource, type RestorationAttempt, type RestorationStop, type VolumeBusinessCheck, type RestoreVolumeInput, type ServiceVolumeRestoration } from "./code-route-volume-restore.js";
import type { VolumeComparisonReference, ServiceVolumeArchive } from "./code-route-volume-archive.js";
import { join, resolve } from "node:path";
import { CodeWorkspaces } from "./code-workspace.js";
import { CodeWorkspaceRoutes } from "./code-workspace-route.js";
import { assertRoutePreparing, routeExecutionPath } from "./code-route-fence.js";
import { DockerRouteRuntime } from "./code-route-runtime.js";
import type { RouteExecution } from "./code-route-execution.js";
import { sha256 } from "./canonical-json.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { DomainError, validation } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { safeRead, withRuntimeLock } from "./runtime-files.js";
import type { Store } from "./store-types.js";

export interface ServiceSnapshot {
  key: string; engine_id: string; container_id: string; network_id: string; volume_name: string; volume_created_at: string;
  log_digest: string; blockers: string[];
  container_state: "eligible" | "removed"; network_state: "eligible" | "removed";
}
export interface ServiceDiagnostics { directory: string; digest: string; review_after: string }
export interface ServiceCleanupEngine {
  removeVolume?(snapshot: ServiceSnapshot): Promise<void>;
  cleanupRestore?(input: { operation_id: string; source: RestoredExportSource }): Promise<RestorationCleanup>;
  inspectRestoreVolume?(input: RestoreVolumeInput): Promise<{ attempt: RestorationAttempt | null; volume: RetainedVolume }>;
  retainedVolume?(): Promise<RetainedVolume>;
  inspectRestore?(input: RestoreVolumeInput): Promise<RestorationAttempt>;
  stopRestore?(input: RestoreVolumeInput, operationID: string): Promise<RestorationStop>;
  restoreVolume?(input: RestoreVolumeInput): Promise<ServiceVolumeRestoration>;
  restoreExportSnapshot?(source: RestoredExportSource): Promise<ServiceSnapshot>;
  exportVolume?(input: { operation_id: string; snapshot: ServiceSnapshot; comparison?: VolumeComparisonReference; restoration?: RestoredExportSource; verification?: VolumeVerificationReference }): Promise<ServiceVolumeArchive>;
  cleanupSnapshot(): Promise<ServiceSnapshot>;
  reclaimService(input: { operation_id: string; snapshot: ServiceSnapshot }): Promise<ServiceDiagnostics>;
}
interface Location { route_id: string; execution_id: string; early?: boolean }
interface Reclaim extends Location { operation_id: string; attribution: Attribution; expected_version: number; plan_digest: string }
export interface ServiceCleanupPlan {
  scope: "route_service"; instance_id: string; route_id: string; execution_id: string; lifecycle_version: number;
  gate: "ready" | "retention" | "pinned" | "blocked"; snapshot: ServiceSnapshot;
  container: { id: string; state: "eligible" | "removed" };
  network: { id: string; state: "eligible" | "removed" };
  volume: { name: string; state: "retained" }; retained_images: string[]; plan_digest: string;
}
export interface ServiceCleanupResult {
  scope: "route_service"; operation_id: string; instance_id: string; route_id: string; execution_id: string;
  container: { id: string; state: "removed" }; network: { id: string; state: "removed" };
  volume: { name: string; state: "retained" }; retained_images: string[]; diagnostics: ServiceDiagnostics;
}
interface Journal { format: "grounds.route-service-cleanup/v1"; request_digest: string; plan: ServiceCleanupPlan;
  phase: "pending" | "completed"; attribution: Attribution; result?: ServiceCleanupResult }
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };

/** Ended-instance cleanup. Volume data and images deliberately remain protected. */
export class CodeRouteServiceCleanup {
  constructor(private readonly store: Store, private readonly engine: (run: RouteExecution) => ServiceCleanupEngine = run => new DockerRouteRuntime(run)) {}
  private async locked<T>(input: Location, action: (context: { run: RouteExecution; instance_id: string;
    lifecycle_version: number; gate: "ready" | "retention" | "pinned"; engine: ServiceCleanupEngine }) => Promise<T>) {
    if (!isUUIDv7(input.route_id) || !isUUIDv7(input.execution_id) || (input.early !== undefined && typeof input.early !== "boolean"))
      throw validation("service_cleanup", "requires route/execution UUIDv7 and optional boolean early");
    const routes = new CodeWorkspaceRoutes(this.store), workspaces = new CodeWorkspaces(this.store);
    const route = await routes.show(input.route_id), before = await workspaces.instance(route.instance_id), root = before.data_root;
    if (!root || safeRead(join(root, "runtime", "host-id"), 128).toString().trim() !== route.host_id
      || route.host_id !== before.host_id || route.database_id !== before.database_id
      || route.database_id !== (await this.store.open()).database_id
      || route.path !== join(resolve(root), "workspaces", before.instance_id, "development", route.route_id))
      conflict("Service cleanup requires its recorded host, database and route");
    return withRuntimeLock(join(root!, "runtime"), `workspace:${route.instance_id}`, () =>
      withRuntimeLock(join(root!, "runtime"), `code-route:${route.route_id}`, async () => {
        const instance = await workspaces.instance(route.instance_id);
        const lifecycle = instance.lifecycle ?? conflict("Explicitly end the Workspace before service cleanup");
        assertRoutePreparing(route);
        const run = JSON.parse(safeRead(routeExecutionPath(route, input.execution_id)).toString()) as RouteExecution;
        if (run.format !== "grounds.code-route-execution/v1" || run.execution_id !== input.execution_id || run.route_id !== route.route_id
          || run.host_id !== route.host_id || run.database_id !== route.database_id || run.code_path !== route.path
          || run.dev_run_id !== route.dev_run_id || run.state !== "stopped" || !run.dependency || !run.environment?.configuration.postgres)
          conflict("Service cleanup requires an exact stopped execution with a dependency");
        return action({ run, instance_id: instance.instance_id, lifecycle_version: lifecycle.version,
          gate: lifecycle.pinned ? "pinned" : !input.early && Date.now() < Date.parse(lifecycle.retain_until) ? "retention" : "ready",
          engine: this.engine(run) });
      }));
  }
  private async plan(input: Location, context: { run: RouteExecution; instance_id: string; lifecycle_version: number;
    gate: "ready" | "retention" | "pinned"; engine: ServiceCleanupEngine }): Promise<ServiceCleanupPlan> {
    const snapshot = await context.engine.cleanupSnapshot();
    const body = { scope: "route_service" as const, instance_id: context.instance_id, route_id: input.route_id, execution_id: input.execution_id,
      lifecycle_version: context.lifecycle_version, gate: snapshot.blockers.length ? "blocked" as const : context.gate, snapshot,
      container: { id: snapshot.container_id, state: snapshot.container_state }, network: { id: snapshot.network_id, state: snapshot.network_state },
      volume: { name: snapshot.volume_name, state: "retained" as const },
      retained_images: [context.run.image, context.run.environment!.configuration.postgres!.image] };
    return { ...body, plan_digest: sha256(body) };
  }
  async retireVolume(input: Omit<Location, "early"> & { operation_id: string; attribution: Attribution; restore_id?: string }): Promise<VolumeRetirement> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id)) throw validation("operation_id", "requires UUIDv7");
    validateAttribution(request.attribution);
    return this.locked(request, async context => {
      const requestDigest = sha256(request);
      let row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
      if (row && (row.data.format !== "grounds.volume-retirement-operation/v1" || row.data.request_digest !== requestDigest))
        return conflict("Volume retirement differs from its original request");
      const observe = async () => {
        if (request.restore_id !== undefined) {
          const selected = await this.restorationInput({ ...request, restore_id: request.restore_id });
          if (selected.row.data.phase !== "completed" || !selected.row.data.result || !context.engine.restoreExportSnapshot)
            return conflict("Volume retirement requires a completed restoration");
          return context.engine.restoreExportSnapshot({ input: selected.restore,
            result: selected.row.data.result as unknown as ServiceVolumeRestoration });
        }
        return context.engine.cleanupSnapshot();
      };
      if (!row) {
        const snapshot = await observe();
        if (snapshot.blockers.length || snapshot.engine_id !== context.run.engine_id)
          return conflict("Volume retirement requires stopped resources without other consumers");
        const previous = readVolumeRetirement(context.run, snapshot.volume_name);
        if (previous && (previous.request_digest !== requestDigest || previous.retirement.operation_id !== request.operation_id))
          return conflict("Volume retirement differs from its original request");
        const retirement: VolumeRetirement = previous?.retirement ?? { operation_id: request.operation_id, route_id: request.route_id,
          execution_id: request.execution_id, engine_id: context.run.engine_id, volume_name: snapshot.volume_name,
          volume_created_at: snapshot.volume_created_at, scope: "grounds_managed_writes", state: "retiring", recorded_at: new Date().toISOString(),
          ...(request.restore_id ? { source_restore_id: request.restore_id } : {}) };
        await this.store.write(async tx => {
          await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.service-volume-retire", request_hash: requestDigest });
          // File effects deliberately outlive a SQL rollback; same-request recovery uses this receipt.
          persistVolumeRetirement(context.run, retirement, requestDigest);
          const data = { format: "grounds.volume-retirement-operation/v1", request_digest: requestDigest,
            attribution: request.attribution, phase: "pending", retirement };
          await tx.saveRuntimeRecord({ id: request.operation_id, parent_id: request.route_id, kind: "runtime_operation", version: 1, data }, 0);
          await tx.completeOperation(request.operation_id, JSON.stringify(data));
        });
        row = (await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id)))!;
      }
      const retirement = row!.data.retirement as unknown as VolumeRetirement;
      // Local admission is fenced even when the following observation or SQL completion fails.
      persistVolumeRetirement(context.run, retirement, requestDigest);
      if (row!.data.phase === "completed") return retirement; // Historical; never touch a replacement resource.
      const current = await observe();
      if (current.blockers.length || current.engine_id !== retirement.engine_id || current.volume_name !== retirement.volume_name
        || current.volume_created_at !== retirement.volume_created_at) return conflict("Volume retirement stop or identity is unproven; write fence retained");
      await this.store.write(tx => tx.saveRuntimeRecord({ ...row!, version: row!.version + 1,
        data: { ...row!.data, phase: "completed" } }, row!.version));
      return retirement;
    });
  }
  async deleteVolume(input: VolumeDeleteRequest) {
    return this.locked(input, context => deleteServiceVolume(this.store, context, input));
  }
  async assessVolume(input: Location & { archive_id: string }) {
    return this.locked(input, context => assessVolumeEvidence(this.store, context.run, context.engine, {
      archive_id: input.archive_id, instance_id: context.instance_id, lifecycle_version: context.lifecycle_version, gate: context.gate }));
  }
  async exportVolume(input: Omit<Location, "early"> & { operation_id: string; attribution: Attribution; compare_archive_id?: string; restore_id?: string; verified_restore_id?: string }): Promise<ServiceVolumeArchive> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id)) throw validation("operation_id", "requires UUIDv7");
    validateAttribution(request.attribution);
    return this.locked(request, async context => {
      if (!context.engine.exportVolume) conflict("Engine does not support volume export");
      let row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
      if (row && (row.data.format !== "grounds.service-volume-export-operation/v1" || row.data.request_digest !== sha256(request)))
        conflict("Volume export differs from its original request");
      let restoration: RestoredExportSource | undefined;
      if (request.restore_id !== undefined) {
        const selected = await this.restorationInput({ ...request, restore_id: request.restore_id });
        if (selected.row.data.phase !== "completed" || !selected.row.data.result)
          return conflict("Restored export requires a completed restoration");
        restoration = { input: selected.restore, result: selected.row.data.result as unknown as ServiceVolumeRestoration };
      }
      let comparison: VolumeComparisonReference | undefined;
      if (request.compare_archive_id !== undefined) {
        if (!isUUIDv7(request.compare_archive_id) || request.compare_archive_id === request.operation_id)
          throw validation("compare_archive_id", "requires a distinct completed archive UUIDv7");
        const target = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.compare_archive_id!));
        const archive = target?.data.result as unknown as ServiceVolumeArchive | undefined;
        if (!target || target.parent_id !== request.route_id || target.data.format !== "grounds.service-volume-export-operation/v1"
          || target.data.phase !== "completed" || !archive || archive.operation_id !== request.compare_archive_id
          || archive.source_restore_id !== request.restore_id
          || (restoration && (archive.source_volume !== restoration.result.volume_name || archive.source_created_at !== restoration.result.volume_created_at))
          || archiveIntegrity(context.run, archive, target.data.snapshot as unknown as ServiceSnapshot) !== "valid")
          return conflict("Comparison requires an intact completed archive from this source volume");
        comparison = { archive_id: archive.operation_id, archive_digest: archive.digest };
        if (row && sha256(row.data.comparison ?? null) !== sha256(comparison)) conflict("Comparison archive differs from original reference");
      }
      let verification: VolumeVerificationReference | undefined;
      if (request.verified_restore_id !== undefined) {
        if (!comparison) return conflict("Verified recheck requires compare_archive_id");
        const selected = await this.restorationInput({ ...request, restore_id: request.verified_restore_id });
        if (selected.row.data.phase !== "completed" || !selected.row.data.result
          || selected.restore.archive.operation_id !== comparison.archive_id || selected.restore.archive.digest !== comparison.archive_digest)
          return conflict("Verification must restore the exact comparison archive");
        verification = verificationReference(context.run, { input: selected.restore, result: selected.row.data.result as unknown as ServiceVolumeRestoration });
        if (row && sha256(row.data.verification ?? null) !== sha256(verification)) return conflict("Verification differs from original reference");
      }
      if (!row) {
        if (restoration && !context.engine.restoreExportSnapshot) return conflict("Engine does not support restored volume export");
        const snapshot = restoration ? await context.engine.restoreExportSnapshot!(restoration) : await context.engine.cleanupSnapshot();
        if (!restoration && (snapshot.blockers.length || snapshot.container_state !== "removed" || snapshot.network_state !== "removed"))
          conflict("Volume export requires completed service cleanup without other consumers");
        await this.store.write(async tx => {
          await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.service-volume-export", request_hash: sha256(request) });
          const data = { format: "grounds.service-volume-export-operation/v1", request_digest: sha256(request), snapshot,
            attribution: request.attribution, phase: "pending", ...(comparison ? { comparison } : {}), ...(verification ? { verification } : {}),
            ...(restoration ? { source_restore_id: request.restore_id!, execution_id: request.execution_id } : {}) };
          await tx.saveRuntimeRecord({ id: request.operation_id, parent_id: request.route_id, kind: "runtime_operation", version: 1, data }, 0);
          await tx.completeOperation(request.operation_id, JSON.stringify(data));
        });
        row = (await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id)))!;
      }
      // Even completed replay revalidates archive bytes; historical success is not current integrity proof.
      const result = await context.engine.exportVolume!({ operation_id: request.operation_id, snapshot: row!.data.snapshot as unknown as ServiceSnapshot, ...(comparison ? { comparison } : {}), ...(restoration ? { restoration } : {}), ...(verification ? { verification } : {}) });
      if (row!.data.phase === "completed") {
        if (sha256(row!.data.result) !== sha256(result)) conflict("Volume archive differs from recorded result");
      } else await this.store.write(tx => tx.saveRuntimeRecord({ ...row!, version: row!.version + 1,
        data: { ...row!.data, phase: "completed", result } }, row!.version));
      return result;
    });
  }
  async restoreVolume(input: Omit<Location, "early"> & { archive_id: string; operation_id: string; attribution: Attribution; checks?: VolumeBusinessCheck[] }): Promise<ServiceVolumeRestoration> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id) || !isUUIDv7(request.archive_id)) throw validation("restore", "requires operation and archive UUIDv7");
    if (request.checks !== undefined) validateVolumeChecks(request.checks);
    validateAttribution(request.attribution);
    return this.locked(request, async context => {
      if (!context.engine.restoreVolume) conflict("Engine does not support volume restore");
      const source = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.archive_id));
      if (!source || source.data.format !== "grounds.service-volume-export-operation/v1" || source.data.phase !== "completed"
        || source.parent_id !== request.route_id) conflict("Restore requires a completed export from this route");
      const archive = source!.data.result as unknown as ServiceVolumeArchive;
      if (archive.route_id !== request.route_id || archive.execution_id !== request.execution_id) conflict("Archive execution differs");
      let row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
      if (row && (row.data.format !== "grounds.service-volume-restoration-operation/v1" || row.data.request_digest !== sha256(request)))
        conflict("Restore differs from its original request");
      if (!row) {
        await this.store.write(async tx => {
          await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.service-volume-restore", request_hash: sha256(request) });
          const data = { format: "grounds.service-volume-restoration-operation/v1", request_digest: sha256(request),
            archive_id: request.archive_id, execution_id: request.execution_id, attribution: request.attribution, phase: "pending",
            ...(request.checks ? { checks: request.checks } : {}) };
          await tx.saveRuntimeRecord({ id: request.operation_id, parent_id: request.route_id, kind: "runtime_operation", version: 1, data }, 0);
          await tx.completeOperation(request.operation_id, JSON.stringify(data));
        });
        row = (await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id)))!;
      }
      const result = await context.engine.restoreVolume!({ operation_id: request.operation_id, archive,
        snapshot: source!.data.snapshot as unknown as ServiceSnapshot, ...(request.checks ? { checks: request.checks } : {}) });
      if (row!.data.phase === "completed") {
        if (sha256(row!.data.result) !== sha256(result)) conflict("Restoration differs from recorded result");
      } else await this.store.write(tx => tx.saveRuntimeRecord({ ...row!, version: row!.version + 1,
        data: { ...row!.data, phase: "completed", result } }, row!.version));
      return result;
    });
  }
  private async restorationInput(input: Omit<Location, "early"> & { restore_id: string }) {
    if (!isUUIDv7(input.restore_id)) throw validation("restore_id", "requires UUIDv7");
    const row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", input.restore_id));
    if (!row || row.parent_id !== input.route_id || row.data.execution_id !== input.execution_id
      || row.data.format !== "grounds.service-volume-restoration-operation/v1") return conflict("Restoration record does not belong to this execution");
    const source = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", row.data.archive_id as string));
    if (!source || source.parent_id !== input.route_id || source.data.format !== "grounds.service-volume-export-operation/v1" || source.data.phase !== "completed")
      return conflict("Restore requires its completed export");
    const archive = source.data.result as unknown as ServiceVolumeArchive;
    if (archive.route_id !== input.route_id || archive.execution_id !== input.execution_id) conflict("Archive execution differs");
    const restore: RestoreVolumeInput = { operation_id: input.restore_id, archive, snapshot: source.data.snapshot as unknown as ServiceSnapshot,
      ...(row.data.checks ? { checks: row.data.checks as unknown as VolumeBusinessCheck[] } : {}) };
    return { row, restore };
  }
  async cleanupRestoration(input: Location & { restore_id: string; operation_id: string; attribution: Attribution; expected_version: number }): Promise<RestorationCleanup> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id) || !Number.isSafeInteger(request.expected_version) || request.expected_version < 0)
      throw validation("restoration_cleanup", "requires operation UUIDv7 and lifecycle version");
    validateAttribution(request.attribution);
    return this.locked(request, async context => {
      const { row: restored, restore } = await this.restorationInput(request);
      if (restored.data.phase !== "completed" || !restored.data.result) return conflict("Cleanup requires a completed restoration");
      if (!context.engine.cleanupRestore) return conflict("Engine does not support restoration cleanup");
      let row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
      if (row && (row.data.format !== "grounds.restoration-cleanup-operation/v1" || row.data.request_digest !== sha256(request)))
        conflict("Restoration cleanup differs from its original request");
      if (row?.data.phase !== "completed" && (context.gate !== "ready" || context.lifecycle_version !== request.expected_version))
        conflict("Restoration cleanup lifecycle version, retention or pin prevents removal");
      if (!row) {
        await this.store.write(async tx => {
          await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.service-volume-restoration-cleanup", request_hash: sha256(request) });
          const data = { format: "grounds.restoration-cleanup-operation/v1", request_digest: sha256(request), restore_id: request.restore_id,
            execution_id: request.execution_id, attribution: request.attribution, phase: "pending" };
          await tx.saveRuntimeRecord({ id: request.operation_id, parent_id: request.route_id, kind: "runtime_operation", version: 1, data }, 0);
          await tx.completeOperation(request.operation_id, JSON.stringify(data));
        });
        row = (await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id)))!;
      }
      const result = await context.engine.cleanupRestore({ operation_id: request.operation_id,
        source: { input: restore, result: restored.data.result as unknown as ServiceVolumeRestoration } });
      if (row.data.phase === "completed") {
        if (sha256(row.data.result) !== sha256(result)) conflict("Restoration cleanup result changed");
      } else await this.store.write(tx => tx.saveRuntimeRecord({ ...row!, version: row!.version + 1,
        data: { ...row!.data, phase: "completed", result } }, row!.version));
      return result;
    });
  }
  async restoration(input: Omit<Location, "early"> & { restore_id: string }) {
    return this.locked(input, async context => {
      const { row, restore } = await this.restorationInput(input);
      if (!context.engine.inspectRestore) return conflict("Engine does not support restore inspection");
      return { operation_id: input.restore_id, archive_id: row.data.archive_id as string, phase: row.data.phase as "pending" | "completed",
        attempt: await context.engine.inspectRestore(restore),
        ...(row.data.result ? { result: row.data.result as unknown as ServiceVolumeRestoration } : {}) };
    });
  }
  async stopRestoration(input: Omit<Location, "early"> & { restore_id: string; operation_id: string; attribution: Attribution }): Promise<RestorationStop> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id)) throw validation("operation_id", "requires UUIDv7");
    validateAttribution(request.attribution);
    return this.locked(request, async context => {
      const { restore } = await this.restorationInput(request);
      if (!context.engine.stopRestore) return conflict("Engine does not support restore stop");
      let row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
      if (row && (row.data.format !== "grounds.service-volume-stop-operation/v1" || row.data.request_digest !== sha256(request)))
        conflict("Restore stop differs from original request");
      if (row?.data.phase === "completed") return row.data.result as unknown as RestorationStop;
      if (!row) {
        await this.store.write(async tx => {
          await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.service-volume-restoration-stop", request_hash: sha256(request) });
          const data = { format: "grounds.service-volume-stop-operation/v1", request_digest: sha256(request), restore_id: request.restore_id,
            execution_id: request.execution_id, attribution: request.attribution, phase: "pending" };
          await tx.saveRuntimeRecord({ id: request.operation_id, parent_id: request.route_id, kind: "runtime_operation", version: 1, data }, 0);
          await tx.completeOperation(request.operation_id, JSON.stringify(data));
        });
        row = (await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id)))!;
      }
      const result = await context.engine.stopRestore(restore, request.operation_id);
      await this.store.write(tx => tx.saveRuntimeRecord({ ...row!, version: row!.version + 1,
        data: { ...row!.data, phase: "completed", result } }, row!.version));
      return result;
    });
  }
  async volumePreview(input: Omit<Location, "early">) {
    return this.locked(input, async context => {
      if (!context.engine.retainedVolume) return conflict("Engine does not support retained volume inspection");
      const all = (await this.store.read(tx => tx.listRuntimeRecords("runtime_operation", input.route_id))).sort((a, b) => a.id.localeCompare(b.id));
      const rows = all.filter(row => row.data.format === "grounds.service-volume-export-operation/v1"
          && ((row.data.snapshot as unknown as ServiceSnapshot)?.volume_name === context.run.dependency!.volume_name
            || (typeof row.data.source_restore_id === "string" && row.data.execution_id === input.execution_id)))
        ;
      const restoreRows = all.filter(row => row.data.format === "grounds.service-volume-restoration-operation/v1" && row.data.execution_id === input.execution_id);
      if (rows.length + restoreRows.length > 32) return conflict("Volume preview supports at most 32 related archive and restoration records");
      const archives = rows.map(row => {
        const archive = row.data.result as unknown as ServiceVolumeArchive | undefined;
        return { archive_id: row.id, execution_id: archive?.execution_id ?? null, phase: row.data.phase as "pending" | "completed",
          digest: archive?.digest ?? null,
          ...(row.data.source_restore_id ? { source_restore_id: row.data.source_restore_id as string } : {}), ...(archive?.comparison ? { comparison: archive.comparison } : {}), integrity: row.data.phase === "completed" && archive
            ? archive.operation_id !== row.id ? "unavailable" as const : archiveIntegrity(context.run, archive, row.data.snapshot as unknown as ServiceSnapshot) : "not_checked" as const };
      });
      const restorations = [];
      for (const row of restoreRows) {
        let observed: { attempt: RestorationAttempt | null; volume: RetainedVolume } = {
          attempt: null, volume: unknownVolume(`grounds-volume-restore-${row.id}`) };
        try {
          const { restore } = await this.restorationInput({ ...input, restore_id: row.id });
          if (context.engine.inspectRestoreVolume) observed = await context.engine.inspectRestoreVolume(restore);
        } catch { /* Keep one unavailable attempt visible without hiding other retained resources. */ }
        observed.volume = { ...observed.volume, managed_writes: managedVolumeWrites(context.run, observed.volume.name) };
        const archive = archives.find(archive => archive.archive_id === row.data.archive_id);
        const result = row.data.result as unknown as ServiceVolumeRestoration | undefined;
        const startupVerified = row.data.phase === "completed" && !!result && result.operation_id === row.id
          && result.route_id === input.route_id && result.execution_id === input.execution_id && result.archive_id === archive?.archive_id
          && result.archive_digest === archive?.digest;
        const businessStatus = startupVerified ? result!.verification.business_checks?.status ?? "not_requested" : "unavailable";
        const blockers = volumeBlockers(observed.volume, context.gate);
        if (archive?.integrity !== "valid") blockers.push("archive_unavailable");
        if (!startupVerified) blockers.push("restore_not_completed");
        if (!observed.attempt) blockers.push("restore_journal_unavailable");
        if (observed.attempt?.failure === "import_unknown") blockers.push("import_outcome_unknown");
        if (observed.attempt?.failure === "probe_failed") blockers.push("startup_probe_failed");
        if (businessStatus !== "passed") blockers.push(businessStatus === "failed" ? "business_checks_failed" : "business_checks_not_recorded");
        restorations.push({ restore_id: row.id, archive_id: row.data.archive_id as string, phase: row.data.phase as "pending" | "completed",
          ...observed, startup_verified: startupVerified, business_status: businessStatus, blockers });
      }
      const observedSource = await context.engine.retainedVolume();
      const volume = { ...observedSource, managed_writes: managedVolumeWrites(context.run, observedSource.name) };
      const blockers = volumeBlockers(volume, context.gate);
      if (!archives.some(archive => !archive.source_restore_id && archive.integrity === "valid")) blockers.push("no_intact_archive");
      if (!restorations.some(restore => restore.business_status === "passed" && archives.some(archive => archive.archive_id === restore.archive_id && !archive.source_restore_id))) blockers.push("no_passing_restore_checks");
      return { scope: "route_volumes" as const, instance_id: context.instance_id, route_id: input.route_id, execution_id: input.execution_id,
        lifecycle_version: context.lifecycle_version, lifecycle_gate: context.gate, observed_at: new Date().toISOString(), deletion_supported: true as const,
        source: { volume, blockers }, archives, restorations };
    });
  }
  async preview(input: Location): Promise<ServiceCleanupPlan> { return this.locked(input, context => this.plan(input, context)); }
  async reclaim(input: Reclaim): Promise<ServiceCleanupResult> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id) || !Number.isSafeInteger(request.expected_version) || request.expected_version < 1
      || !/^sha256:[a-f0-9]{64}$/.test(request.plan_digest)) throw validation("cleanup", "requires operation ID, lifecycle version and plan digest");
    validateAttribution(request.attribution);
    return this.locked(request, async context => {
      let row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
      if (row && (row.data.format !== "grounds.route-service-cleanup/v1" || row.data.request_digest !== sha256(request)))
        conflict("Cleanup operation differs from its original request");
      if (row?.data.phase === "completed") return (row.data as unknown as Journal).result!;
      if (context.gate !== "ready") conflict("Workspace retention or pin prevents service cleanup");
      if (!row) {
        const plan = await this.plan(request, context);
        if (plan.gate !== "ready" || plan.plan_digest !== request.plan_digest || plan.lifecycle_version !== request.expected_version)
          conflict("Service cleanup plan or lifecycle changed; inspect a fresh preview");
        await this.store.write(async tx => {
          await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.service-cleanup", request_hash: sha256(request) });
          const journal: Journal = { format: "grounds.route-service-cleanup/v1", request_digest: sha256(request), plan,
            phase: "pending", attribution: request.attribution };
          await tx.saveRuntimeRecord({ id: request.operation_id, parent_id: request.route_id, kind: "runtime_operation", version: 1, data: { ...journal } }, 0);
          await tx.completeOperation(request.operation_id, JSON.stringify(journal));
        });
        row = (await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id)))!;
      }
      const journal = row!.data as unknown as Journal;
      const diagnostics = await context.engine.reclaimService({ operation_id: request.operation_id, snapshot: journal.plan.snapshot });
      const result: ServiceCleanupResult = { scope: "route_service", operation_id: request.operation_id,
        instance_id: context.instance_id, route_id: request.route_id, execution_id: request.execution_id,
        container: { id: journal.plan.container.id, state: "removed" }, network: { id: journal.plan.network.id, state: "removed" },
        volume: journal.plan.volume, retained_images: journal.plan.retained_images, diagnostics };
      await this.store.write(tx => tx.saveRuntimeRecord({ ...row!, version: row!.version + 1,
        data: { ...journal, phase: "completed", result } }, row!.version));
      return result;
    });
  }
}
