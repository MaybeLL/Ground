import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "./canonical-json.js";
import { docker } from "./env-docker.js";
import { DomainError } from "./errors.js";
import { atomicPrivateWrite, digestBytes, safeRead } from "./runtime-files.js";
import { assertRestoredExportSource, type RestoredExportSource } from "./code-route-volume-restore.js";
import { readVolumeRetirement } from "./code-route-volume-retirement.js";
import type { RouteExecution } from "./code-route-execution.js";
import type { ServiceDiagnostics } from "./code-route-service-cleanup.js";

export interface RestorationCleanup {
  scope: "restoration_container"; operation_id: string; restore_id: string; route_id: string; execution_id: string;
  container: { id: string; state: "removed" }; volume: { name: string; state: "retained" };
  diagnostics: ServiceDiagnostics;
}
interface Snapshot { configuration_digest: string; state_digest: string; log_digest: string }
interface Journal {
  format: "grounds.restoration-cleanup/v1"; request_digest: string;
  phase: "planned" | "removing" | "completed"; snapshot: Snapshot; result: RestorationCleanup;
}
const fail = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };

/** Caller holds workspace -> route locks. Only completed restorations may enter this protocol. */
export function cleanupRestoration(run: RouteExecution, input: { operation_id: string; source: RestoredExportSource }): RestorationCleanup {
  const { result: source } = input.source;
  const root = resolve(run.code_path, "../../../..");
  // One durable intent per restoration: changing operation ID cannot bypass an interrupted removal.
  const file = join(root, "runtime", "restoration-cleanups", `${source.operation_id}.json`);
  const requestDigest = sha256({ input, database: run.database_id, host: run.host_id });
  let record: Journal | undefined;
  try { record = JSON.parse(safeRead(file).toString()) as Journal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("Restoration cleanup journal is unreadable"); }
  if (record && (record.format !== "grounds.restoration-cleanup/v1" || record.request_digest !== requestDigest
    || !["planned", "removing", "completed"].includes(record.phase))) fail("Resume the original restoration cleanup request");
  const persist = () => atomicPrivateWrite(file, JSON.stringify(record));
  const directory = join(root, "archive", "restoration-cleanup", input.operation_id);
  const logPath = join(directory, "postgres-log.json"), manifestPath = join(directory, "manifest.json");
  const verifyArchive = () => {
    if (record!.result.diagnostics.directory !== directory || digestBytes(safeRead(logPath, 12 * 1024 * 1024)) !== record!.snapshot.log_digest
      || record!.result.diagnostics.digest !== record!.snapshot.log_digest) fail("Restoration diagnostics integrity failed");
    const expected = { format: "grounds.restoration-cleanup-archive/v1", database_id: run.database_id, host_id: run.host_id,
      source, snapshot: record!.snapshot, result: record!.result };
    if (sha256(JSON.parse(safeRead(manifestPath).toString())) !== sha256(expected)) fail("Restoration diagnostics manifest changed");
  };
  if (record?.phase === "completed") { verifyArchive(); return record.result; }

  const observe = () => {
    assertRestoredExportSource(run, input.source);
    const retirement = readVolumeRetirement(run, source.volume_name)?.retirement;
    if (!retirement || retirement.source_restore_id !== source.operation_id || retirement.execution_id !== run.execution_id
      || retirement.volume_created_at !== source.volume_created_at) fail("Restoration cleanup requires matching persistent volume retirement");
    const named = docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${source.volume_name}$`]);
    const exact = docker(["ps", "-aq", "--no-trunc", "--filter", `id=${source.container_id}`]);
    if (named && named !== source.container_id) fail("Restoration container identity was replaced");
    if (!exact) {
      if (named || record?.phase !== "removing") fail("Restoration container disappeared without removal intent");
      return undefined;
    }
    if (exact !== source.container_id || named !== exact) fail("Restoration container identity changed");
    const c = JSON.parse(docker(["inspect", exact]))[0];
    const mounts = c.Mounts.filter((m: { Type: string }) => m.Type !== "tmpfs");
    // Retain anything outside the known persistent volume. Stopped /tmp tmpfs is ephemeral.
    if (c.Id !== source.container_id || c.Image !== source.image || c.State.Running || c.State.Paused || c.State.Restarting
      || !["exited", "created"].includes(c.State.Status) || c.HostConfig.RestartPolicy.Name !== "no"
      || !c.HostConfig.ReadonlyRootfs || c.HostConfig.NetworkMode !== "none" || c.HostConfig.AutoRemove
      || mounts.length !== 1 || mounts[0].Type !== "volume" || mounts[0].Name !== source.volume_name
      || mounts[0].Destination !== "/var/lib/postgresql/data" || !mounts[0].RW
      || Object.keys(c.HostConfig.Tmpfs ?? {}).join(",") !== "/tmp"
      || c.Mounts.some((m: { Type: string; Destination: string }) => m.Type === "tmpfs" && m.Destination !== "/tmp"))
      fail("Restoration container has unsupported configuration or writable storage");
    if (docker(["diff", exact])) fail("Restoration container has unpreserved filesystem changes; retain it");
    const logs = spawnSync("docker", ["logs", "--timestamps", exact], { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
    if (logs.status !== 0 || logs.error) fail("Cannot preserve complete available restoration diagnostics");
    const bytes = Buffer.from(JSON.stringify({ format: "grounds.service-log/v1", stdout: logs.stdout.toString("base64"), stderr: logs.stderr.toString("base64") }));
    const snapshot: Snapshot = { configuration_digest: sha256({ config: c.Config, host: c.HostConfig, mounts: c.Mounts }),
      state_digest: sha256({ state: c.State, restarts: c.RestartCount }), log_digest: digestBytes(bytes) };
    return { snapshot, bytes };
  };
  const observed = observe();
  if (!record) {
    if (!observed) return fail("Restoration container is unavailable");
    record = { format: "grounds.restoration-cleanup/v1", request_digest: requestDigest, phase: "planned", snapshot: observed.snapshot,
      result: { scope: "restoration_container", operation_id: input.operation_id, restore_id: source.operation_id,
        route_id: run.route_id, execution_id: run.execution_id, container: { id: source.container_id, state: "removed" },
        volume: { name: source.volume_name, state: "retained" },
        diagnostics: { directory, digest: observed.snapshot.log_digest, review_after: new Date(Date.now() + 90 * 86400000).toISOString() } } };
    persist();
  }
  if (observed && sha256(observed.snapshot) !== sha256(record.snapshot)) fail("Restoration changed since cleanup intent; retain it");
  if (!existsSync(logPath)) {
    if (!observed || record.phase !== "planned") return fail("Archived diagnostics disappeared after removal intent");
    atomicPrivateWrite(logPath, observed.bytes);
  }
  if (!existsSync(manifestPath)) {
    if (record.phase !== "planned") fail("Archived manifest disappeared after removal intent");
    atomicPrivateWrite(manifestPath, JSON.stringify({ format: "grounds.restoration-cleanup-archive/v1", database_id: run.database_id,
      host_id: run.host_id, source, snapshot: record.snapshot, result: record.result }));
  }
  verifyArchive();
  const latest = observe();
  if (latest && sha256(latest.snapshot) !== sha256(record.snapshot)) fail("Restoration changed before removal; retain it");
  record.phase = "removing"; persist();
  if (latest) docker(["rm", source.container_id]); // No force, no -v, no volume or network deletion.
  if (observe()) fail("Restoration container removal is unproven");
  record.phase = "completed"; persist();
  return record.result;
}
