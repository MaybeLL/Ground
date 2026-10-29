import { assertVolumeWritable } from "./code-route-volume-retirement.js";
import { inspectRetainedVolume, unknownVolume, type RetainedVolume } from "./code-route-volume-preview.js";
import { isUUIDv7 } from "./identity.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { docker } from "./env-docker.js";
import { DomainError, validation } from "./errors.js";
import { sha256 } from "./canonical-json.js";
import { atomicPrivateWrite, digestBytes, safeRead } from "./runtime-files.js";
import type { RouteExecution } from "./code-route-execution.js";
import type { ServiceSnapshot } from "./code-route-service-cleanup.js";
import type { ServiceVolumeArchive } from "./code-route-volume-archive.js";

export interface VolumeBusinessCheck { id: string; database: string; schema: string; table: string; expected_count: number }
export interface VolumeBusinessResult extends VolumeBusinessCheck { actual_count: number | null; status: "passed" | "failed" | "error" }
export function validateVolumeChecks(checks: unknown): asserts checks is VolumeBusinessCheck[] {
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > 16) throw validation("checks", "requires 1 to 16 table row-count checks");
  const ids = new Set<string>();
  for (const check of checks) {
    if (!check || typeof check !== "object" || Object.keys(check).sort().join(",") !== "database,expected_count,id,schema,table"
      || [check.id, check.database, check.schema, check.table].some(value => typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value))
      || !Number.isSafeInteger(check.expected_count) || check.expected_count < 0 || ids.has(check.id))
      throw validation("checks", "requires unique IDs, simple SQL identifiers and nonnegative safe integer counts; arbitrary SQL is unsupported");
    ids.add(check.id);
  }
}
export interface VolumeVerification {
  kind: "postgres-startup-and-catalog"; checked_at: string; server_version_num: number; databases: string[]; role_count: number;
  business_checks?: { checks_digest: string; status: "passed" | "failed"; results: VolumeBusinessResult[] };
}
export interface ServiceVolumeRestoration {
  operation_id: string; archive_id: string; archive_digest: string; route_id: string; execution_id: string; engine_id: string;
  image: string; volume_name: string; volume_created_at: string; container_id: string; container_state: "stopped";
  verification: VolumeVerification;
}
export interface RestoredExportSource { input: RestoreVolumeInput; result: ServiceVolumeRestoration }
export interface RestoreVolumeInput { operation_id: string; archive: ServiceVolumeArchive; snapshot: ServiceSnapshot; checks?: VolumeBusinessCheck[] }
type Phase = "planned" | "volume-creating" | "volume-ready" | "container-creating" | "created" | "importing" | "imported"
  | "starting" | "verifying" | "stopping" | "completed" | "failed" | "halting" | "halted";
export interface RestorationStop {
  operation_id: string; restore_id: string; route_id: string; execution_id: string; engine_id: string;
  container_id: string; container_state: "stopped"; volume_name: string; volume_state: "retained"; stopped_at: string;
}
export interface RestorationAttempt {
  phase: Phase | "not_started"; failure: "import_unknown" | "probe_failed" | null;
  container_id: string | null; volume_name: string | null;
}
interface Journal {
  format: "grounds.service-volume-restore/v1"; request_digest: string; phase: Phase; volume_created_at?: string; container_id?: string;
  verification?: VolumeVerification; probe_failed?: boolean; result?: ServiceVolumeRestoration;
  halt_operation_id?: string; halt_from?: Phase; stopped?: RestorationStop;
}
const fail = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
export function inspectServiceVolumeRestore(run: RouteExecution, input: RestoreVolumeInput): RestorationAttempt {
  if (!isUUIDv7(input.operation_id)) fail("Restore ID must be UUIDv7");
  const file = join(resolve(run.code_path, "../../../.."), "runtime", "volume-restores", `${input.operation_id}.json`);
  if (!existsSync(file)) return { phase: "not_started", failure: null, container_id: null, volume_name: null };
  const record = JSON.parse(safeRead(file).toString()) as Journal;
  if (record.format !== "grounds.service-volume-restore/v1" || record.request_digest !== sha256({ input, database: run.database_id, host: run.host_id }))
    fail("Restore request differs from original");
  return { phase: record.phase, failure: record.probe_failed ? "probe_failed" : record.phase === "importing" || record.halt_from === "importing" ? "import_unknown" : null,
    container_id: record.container_id ?? null, volume_name: record.volume_created_at ? `grounds-volume-restore-${input.operation_id}` : null };
}
/** Local attempt identity plus current Docker volume observation; no restore replay. */
export function inspectRestorationVolume(run: RouteExecution, input: RestoreVolumeInput): { attempt: RestorationAttempt | null; volume: RetainedVolume } {
  const name = `grounds-volume-restore-${input.operation_id}`;
  try {
    const attempt = inspectServiceVolumeRestore(run, input);
    const file = join(resolve(run.code_path, "../../../.."), "runtime", "volume-restores", `${input.operation_id}.json`);
    const record = existsSync(file) ? JSON.parse(safeRead(file).toString()) as Journal : undefined;
    const volume = inspectRetainedVolume(run, name, record?.volume_created_at ?? null,
      { "grounds.volume-restore": input.operation_id, "grounds.database": run.database_id, "grounds.host": run.host_id, "grounds.archive": input.archive.operation_id });
    return { attempt, volume };
  } catch { return { attempt: null, volume: unknownVolume(name) }; }
}
/** Only registered, integrity-checked archives; never accepts an arbitrary destination or tar file. */
export function restoreServiceVolume(run: RouteExecution, input: RestoreVolumeInput): Promise<ServiceVolumeRestoration>;
export function restoreServiceVolume(run: RouteExecution, input: RestoreVolumeInput, stopOperationID: string): Promise<RestorationStop>;
export async function restoreServiceVolume(run: RouteExecution, input: RestoreVolumeInput, stopOperationID?: string): Promise<ServiceVolumeRestoration | RestorationStop> {
  if (stopOperationID !== undefined && !isUUIDv7(stopOperationID)) fail("Stop operation ID must be UUIDv7");
  if (!isUUIDv7(input.operation_id) || !isUUIDv7(input.archive.operation_id)) fail("Restore requires operation and archive UUIDv7");
  if (input.checks !== undefined) validateVolumeChecks(input.checks);
  const { archive, snapshot, operation_id: id } = input, root = resolve(run.code_path, "../../../..");
  const directory = join(root, "archive", "service-volumes", archive.operation_id);
  if (archive.directory !== directory || archive.path !== join(directory, "volume.tar") || archive.route_id !== run.route_id
    || archive.execution_id !== run.execution_id || archive.engine_id !== run.engine_id || archive.image !== run.environment!.configuration.postgres!.image
    || (archive.source_restore_id !== undefined
      ? !isUUIDv7(archive.source_restore_id) || archive.source_volume !== `grounds-volume-restore-${archive.source_restore_id}`
      : archive.source_volume !== run.dependency!.volume_name)
    || archive.source_volume !== snapshot.volume_name || archive.source_created_at !== snapshot.volume_created_at)
    fail("Restore archive does not belong to this execution");
  const file = join(root, "runtime", "volume-restores", `${id}.json`), name = `grounds-volume-restore-${id}`;
  const requestDigest = sha256({ input, database: run.database_id, host: run.host_id });
  let record = existsSync(file) ? JSON.parse(safeRead(file).toString()) as Journal : undefined;
  if (record && (record.format !== "grounds.service-volume-restore/v1" || record.request_digest !== requestDigest)) fail("Restore request differs from original");
  if (stopOperationID) {
    if (!record) return fail("Restore has no recorded attempt to stop");
    if (record.phase === "completed") fail("Restore already completed; incomplete-attempt stop is unavailable");
    if (record.halt_operation_id && record.halt_operation_id !== stopOperationID) fail("Restore stop differs from original operation");
    if (record.phase === "halted") return record.stopped!;
  } else if (record?.phase === "halted" || record?.phase === "halting") fail("Restore was halted or is halting; use a new restore operation");
  let bytes: Buffer | undefined;
  if (!stopOperationID) {
    bytes = safeRead(archive.path, 128 * 1024 * 1024);
    if (bytes.length !== archive.size_bytes || digestBytes(bytes) !== archive.digest) fail("Restore archive integrity digest failed");
    if (sha256(JSON.parse(safeRead(join(directory, "manifest.json")).toString())) !== sha256({ format: "grounds.service-volume-archive/v1", ...archive, snapshot }))
      fail("Restore archive manifest integrity failed");

    if (record?.phase === "completed") return record.result!; // Historical replay; no live-health claim.
  }
  if (!stopOperationID) assertVolumeWritable(run, name);
  if (!record) { record = { format: "grounds.service-volume-restore/v1", request_digest: requestDigest, phase: "planned" }; atomicPrivateWrite(file, JSON.stringify(record)); }
  const persist = () => atomicPrivateWrite(file, JSON.stringify(record));
  const labels = { "grounds.volume-restore": id, "grounds.database": run.database_id, "grounds.host": run.host_id, "grounds.archive": archive.operation_id };
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const matches = (actual: Record<string, string>) => Object.entries(labels).every(([key, value]) => actual?.[key] === value);
  const engine = () => { if (docker(["info", "--format", "{{.ID}}"] ) !== run.engine_id) fail("Restore engine changed"); };
  const volume = () => {
    engine();
    const names = docker(["volume", "ls", "-q", "--filter", `name=^${name}$`]).split("\n").filter(Boolean);
    if (!names.length) { if (record!.phase !== "planned") fail("Restore volume creation or absence is unknown"); return undefined; }
    if (record!.phase === "planned") fail("Restore volume already exists without creation intent");
    const v = JSON.parse(docker(["volume", "inspect", name]))[0];
    if (names.length !== 1 || v.Name !== name || v.Driver !== "local" || Object.keys(v.Options ?? {}).length || !matches(v.Labels)
      || (record!.volume_created_at && record!.volume_created_at !== v.CreatedAt)) fail("Restore volume identity changed");
    return v;
  };
  const command = ["-D", "/var/lib/postgresql/data/pgdata", "-c", "listen_addresses=", "-c", "unix_socket_directories=/tmp",
    "-c", "shared_preload_libraries=", "-c", "local_preload_libraries=", "-c", "session_preload_libraries=",
    "-c", "archive_mode=off", "-c", "ssl=off", "-c", "logging_collector=off"];
  const container = () => {
    engine();
    const ids = docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${name}$`]).split("\n").filter(Boolean);
    if (!ids.length) {
      if (!["planned", "volume-creating", "volume-ready"].includes(record!.phase)) fail("Restore container creation or absence is unknown");
      return undefined;
    }
    if (["planned", "volume-creating", "volume-ready"].includes(record!.phase)) fail("Restore container exists without creation intent");
    const c = JSON.parse(docker(["inspect", ids[0]!]))[0], mounts = c.Mounts.filter((m: any) => m.Type !== "tmpfs");
    if (ids.length !== 1 || c.Name !== `/${name}` || (record!.container_id && c.Id !== record!.container_id)
      || c.Image !== archive.image || !matches(c.Config.Labels) || c.Config.User !== "postgres"
      || JSON.stringify(c.Config.Entrypoint) !== '["postgres"]' || JSON.stringify(c.Config.Cmd) !== JSON.stringify(command)
      || c.HostConfig.NetworkMode !== "none" || !c.HostConfig.ReadonlyRootfs || Object.keys(c.HostConfig.PortBindings ?? {}).length
      || c.HostConfig.RestartPolicy.Name !== "no" || mounts.length !== 1 || mounts[0].Type !== "volume" || mounts[0].Name !== name
      || mounts[0].Destination !== "/var/lib/postgresql/data" || !mounts[0].RW)
      fail("Restore container configuration or identity changed");
    return c;
  };
  const consumers = () => {
    volume();
    if (docker(["ps", "-aq", "--no-trunc", "--filter", `volume=${name}`]).split("\n").filter(Boolean).some(other => other !== record!.container_id))
      fail("Restore volume has an unexpected consumer");
  };
  if (stopOperationID) {
    volume(); const target = container();
    if (!target || !record.volume_created_at) fail("Restore target creation is unproven; retained for inspection");
    record.container_id = target.Id;
    consumers();
    if (target.State.Paused || target.State.Restarting) fail("Restore target stop is uncertain");
    if (record.phase !== "halting") { record.halt_from = record.phase; record.phase = "halting"; record.halt_operation_id = stopOperationID; persist(); }
    if (target.State.Running) docker(["stop", "--time", "5", target.Id]);
    consumers(); const stopped = container();
    if (stopped.State.Running || stopped.State.Paused || stopped.State.Restarting) fail("Restore target stop is unproven");
    record.stopped = { operation_id: stopOperationID, restore_id: id, route_id: run.route_id, execution_id: run.execution_id,
      engine_id: run.engine_id, container_id: stopped.Id, container_state: "stopped", volume_name: name, volume_state: "retained", stopped_at: new Date().toISOString() };
    record.phase = "halted"; persist(); return record.stopped;
  }
  let v = volume();
  if (!v) {
    record.phase = "volume-creating"; persist();
    docker(["volume", "create", "--driver", "local", ...labelArgs, name]); v = volume();
  }
  if (record.phase === "planned" || record.phase === "volume-creating") {
    record.volume_created_at = v.CreatedAt; record.phase = "volume-ready"; persist();
  }
  let c = container();
  if (!c) {
    consumers();
    record.phase = "container-creating"; persist();
    record.container_id = docker(["create", "--pull", "never", "--name", name, ...labelArgs, "--network", "none", "--read-only",
      "--user", "postgres", "--entrypoint", "postgres", "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
      "--cpus", "1", "--memory", "512m", "--pids-limit", "128", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
      "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false",
      "--mount", `type=volume,src=${name},dst=/var/lib/postgresql/data,volume-nocopy`, archive.image, ...command]);
    c = container();
  }
  if (record.phase === "container-creating" || record.phase === "volume-ready") {
    record.container_id = c.Id; record.phase = "created"; persist();
  }
  consumers();
  if (record.phase === "importing") fail("Restore import outcome is unknown; retain this volume and use a new operation for a fresh volume");
  if (record.phase === "failed") fail("Restore probe failed; retained resources require inspection; use a new operation for a fresh restore");
  if (record.phase === "created") {
    if (c.State.Status !== "created") fail("Restore target was started before import");
    record.phase = "importing"; persist();
    const copy = spawnSync("docker", ["cp", "-a", "-", `${c.Id}:/var/lib/postgresql/data`], { input: bytes, timeout: 60_000, maxBuffer: 1024 * 1024 });
    if (copy.status !== 0 || copy.error) fail("Restore import outcome is unknown; retain this volume and use a new operation for a fresh volume");
    record.phase = "imported"; persist();
  }
  if (record.phase === "imported") {
    if (container().State.Status !== "created") fail("Restore target changed before startup");
    record.phase = "starting"; persist(); docker(["start", c.Id]);
  }
  if (record.phase === "starting" || record.phase === "verifying") {
    record.phase = "verifying"; persist();
    try {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        const current = container();
        if (!current.State.Running || current.State.Paused || current.State.Restarting) fail("Restore PostgreSQL is not running");
        try { docker(["exec", c.Id, "pg_isready", "-h", "/tmp", "-U", "postgres"], 5000); ready = true; break; }
        catch { await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      if (!ready) fail("Restore PostgreSQL readiness timed out");
      const sql = (database: string, query: string) => docker(["exec", "--env", "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000",
        c.Id, "psql", "-X", "-h", "/tmp", "-U", "postgres", "-d", database, "-At", "-v", "ON_ERROR_STOP=1", "-c", query], 10_000);
      const version = Number(sql("postgres", "SHOW server_version_num"));
      if (version < 160000 || version >= 170000) fail("Restored server is not PostgreSQL 16");
      const databases = JSON.parse(sql("postgres", "SELECT coalesce(json_agg(datname ORDER BY datname), '[]') FROM pg_database WHERE datallowconn AND NOT datistemplate")) as string[];
      if (!Array.isArray(databases) || databases.length > 128 || databases.some(db => typeof db !== "string" || !db || db.length > 63 || /[=:\x00-\x1f]/.test(db)))
        fail("Restore database names exceed the bounded catalog probe profile");
      for (const db of databases) sql(db, "SELECT count(*) FROM pg_catalog.pg_class");
      const roleCount = Number(sql("postgres", "SELECT count(*) FROM pg_roles"));
      if (!Number.isSafeInteger(roleCount) || roleCount < 1) fail("Restore role catalog is invalid");
      record.verification = { kind: "postgres-startup-and-catalog", checked_at: new Date().toISOString(), server_version_num: version,
        databases, role_count: roleCount };
      if (input.checks) {
        const results: VolumeBusinessResult[] = [];
        for (const check of input.checks) {
          try {
            // Names were restricted above. Catalog guard excludes views and foreign tables.
            const kind = sql(check.database, `SELECT c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${check.schema}' AND c.relname='${check.table}'`);
            if (kind !== "r" && kind !== "p") throw new Error("unsupported relation");
            const count = Number(sql(check.database, `SELECT count(*) FROM "${check.schema}"."${check.table}"`));
            if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid count");
            results.push({ ...check, actual_count: count, status: count === check.expected_count ? "passed" : "failed" });
          } catch { results.push({ ...check, actual_count: null, status: "error" }); }
        }
        record.verification.business_checks = { checks_digest: sha256(input.checks),
          status: results.every(result => result.status === "passed") ? "passed" : "failed", results };
      }
    } catch { record.probe_failed = true; }
    record.phase = "stopping"; persist();
  }
  if (record.phase === "stopping") {
    consumers(); c = container();
    if (c.State.Paused || c.State.Restarting) fail("Restore target stop is uncertain");
    if (c.State.Running) docker(["stop", "--time", "5", c.Id]);
    c = container(); if (c.State.Running || c.State.Paused || c.State.Restarting) fail("Restore target stop is unproven");
    if (record.probe_failed || !record.verification) { record.phase = "failed"; persist(); fail("Restore startup or catalog probe failed; stopped resources retained"); }
    record.result = { operation_id: id, archive_id: archive.operation_id, archive_digest: archive.digest,
      route_id: run.route_id, execution_id: run.execution_id, engine_id: run.engine_id, image: archive.image,
      volume_name: name, volume_created_at: record.volume_created_at!, container_id: c.Id, container_state: "stopped", verification: record.verification! };
    record.phase = "completed"; persist();
  }
  return record.result ?? fail("Restore state is incomplete");
}

/** Completed restoration identity is sufficient; the old archive's bytes may be gone or damaged. */
export function restoredExportSnapshot(source: RestoredExportSource): ServiceSnapshot {
  const result = source.result;
  return { key: sha256(result), engine_id: result.engine_id, container_id: result.container_id, network_id: "",
    volume_name: result.volume_name, volume_created_at: result.volume_created_at, log_digest: sha256(result), blockers: [],
    container_state: "eligible", network_state: "removed" };
}
export function assertRestoredExportSource(run: RouteExecution, source: RestoredExportSource, helperID?: string): void {
  const { input, result } = source;
  if (!isUUIDv7(input.operation_id) || result.operation_id !== input.operation_id || result.route_id !== run.route_id
    || result.execution_id !== run.execution_id || result.engine_id !== run.engine_id
    || result.image !== run.environment!.configuration.postgres!.image || result.archive_id !== input.archive.operation_id
    || result.archive_digest !== input.archive.digest || result.volume_name !== `grounds-volume-restore-${input.operation_id}`)
    fail("Restored export source identity changed");
  const file = join(resolve(run.code_path, "../../../.."), "runtime", "volume-restores", `${input.operation_id}.json`);
  const record = JSON.parse(safeRead(file).toString()) as Journal;
  if (record.format !== "grounds.service-volume-restore/v1" || record.phase !== "completed"
    || record.request_digest !== sha256({ input, database: run.database_id, host: run.host_id })
    || sha256(record.result) !== sha256(result) || record.volume_created_at !== result.volume_created_at
    || record.container_id !== result.container_id) fail("Restored export requires a matching completed local restoration");
  const labels = { "grounds.volume-restore": input.operation_id, "grounds.database": run.database_id,
    "grounds.host": run.host_id, "grounds.archive": input.archive.operation_id };
  const volume = inspectRetainedVolume(run, result.volume_name, result.volume_created_at, labels);
  if (volume.state !== "matching" || volume.consumers === null) fail("Restored export volume identity is unavailable or changed");
  const consumers = volume.consumers ?? fail("Restored export consumers are unavailable");
  if (consumers.some(id => id !== result.container_id && id !== helperID)) fail("Restored export volume has another consumer");
  if (consumers.includes(result.container_id)) {
    const c = JSON.parse(docker(["inspect", result.container_id]))[0];
    if (c.Id !== result.container_id || c.Image !== result.image || c.Name !== `/${result.volume_name}`
      || Object.entries(labels).some(([key, value]) => c.Config.Labels?.[key] !== value)
      || c.State.Running || c.State.Paused || c.State.Restarting || !["exited", "created"].includes(c.State.Status)
      || c.HostConfig.RestartPolicy.Name !== "no") fail("Restored export requires its exact stopped restoration container");
  }
}
