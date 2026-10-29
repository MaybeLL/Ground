import { cleanupRestoration } from "./code-route-restoration-cleanup.js";
import type { VolumeVerificationReference } from "./code-route-volume-evidence.js";
import { assertVolumeWritable } from "./code-route-volume-retirement.js";
import { inspectRetainedVolume, unknownVolume } from "./code-route-volume-preview.js";
import { assertRestoredExportSource, restoredExportSnapshot, type RestoredExportSource, inspectRestorationVolume, inspectServiceVolumeRestore, restoreServiceVolume, type RestoreVolumeInput } from "./code-route-volume-restore.js";
import { exportServiceVolume, type VolumeComparisonReference } from "./code-route-volume-archive.js";
import { spawnSync } from "node:child_process";
import type { ServiceSnapshot, ServiceDiagnostics } from "./code-route-service-cleanup.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "./canonical-json.js";
import { docker } from "./env-docker.js";
import { isUUIDv7 } from "./identity.js";
import { DomainError } from "./errors.js";
import { atomicPrivateWrite, safeRead, digestBytes, privateDirectory } from "./runtime-files.js";
import type { RouteDependency, RouteExecution } from "./code-route-execution.js";

interface ResourceReceipt {
  format: "grounds.route-postgres/v1"; key: string; engine_id: string; creation_execution_id: string;
  attempted: { network?: boolean; volume?: boolean; container?: boolean };
  network_id?: string; volume_created_at?: string; container_id?: string;
  state: "preparing" | "ready" | "stopped";
  cleanup?: { operation_id: string; snapshot: ServiceSnapshot; diagnostics: ServiceDiagnostics;
    container: "pending" | "removing" | "removed"; network: "pending" | "removing" | "removed" };
}
const fail = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
const labelsMatch = (actual: Record<string, string> | undefined, expected: Record<string, string>) =>
  Object.entries(expected).every(([key, value]) => actual?.[key] === value);

/** Route lock and durable execution reservation are held by the caller throughout these operations.
 * Resource names exclude the execution image/version: changing tools preserves this route's DB.
 * Changed service image selects a new retained resource set; no implicit data migration or deletion.
 */
export class DockerRouteRuntime {
  private readonly key: string;
  private readonly file: string;
  private readonly name: string;
  private readonly volume: string;
  private readonly image: string;
  constructor(private readonly run: RouteExecution) {
    this.image = run.environment?.configuration.postgres?.image ?? fail("PostgreSQL declaration is missing");
    this.key = sha256({ database: run.database_id, host: run.host_id, route: run.route_id, image: this.image, profile: "postgres16-v1" });
    this.name = `grounds-dep-${this.key.replace(/^sha256:/, "").slice(0, 40)}`;
    this.volume = `${this.name}-data`;
    this.file = join(resolve(run.code_path, "../../../.."), "runtime", "route-services", run.route_id, `${this.name}.json`);
  }
  private read(): ResourceReceipt | undefined {
    if (docker(["info", "--format", "{{.ID}}"] ) !== this.run.engine_id) fail("Service engine changed; retain route ownership");
    if (!existsSync(this.file)) return undefined;
    const record = JSON.parse(safeRead(this.file, 16 * 1024).toString()) as ResourceReceipt;
    if (record.format !== "grounds.route-postgres/v1" || record.key !== this.key || record.engine_id !== this.run.engine_id)
      fail("Dependency receipt identity differs; retain resources");
    return record;
  }
  private persist(record: ResourceReceipt) { atomicPrivateWrite(this.file, JSON.stringify(record)); }
  private labels(record: ResourceReceipt) {
    return { "grounds.code-service": this.key, "grounds.code-route": this.run.route_id,
      "grounds.database": this.run.database_id, "grounds.host": this.run.host_id,
      "grounds.creation-execution": record.creation_execution_id };
  }
  private network(record: ResourceReceipt, allowMissing = false): any | undefined {
    const ids = docker(["network", "ls", "--no-trunc", "-q", "--filter", `name=^${this.name}$`]).split("\n").filter(Boolean);
    if (!ids.length) {
      if (record.attempted.network && !allowMissing) fail("Dependency network creation or absence is unknown; retain ownership");
      return undefined;
    }
    const network = JSON.parse(docker(["network", "inspect", ids[0]!]))[0];
    if (ids.length !== 1 || network.Name !== this.name || (record.network_id && network.Id !== record.network_id)
      || !labelsMatch(network.Labels, this.labels(record)) || network.Internal !== true || network.Driver !== "bridge"
      || Object.keys(network.Containers ?? {}).some(id => id !== record.container_id && id !== this.run.container_id))
      fail("Dependency network ownership or consumers changed");
    return network;
  }
  private inspectVolume(record: ResourceReceipt): any | undefined {
    const names = docker(["volume", "ls", "-q", "--filter", `name=^${this.volume}$`]).split("\n").filter(Boolean);
    if (!names.length) {
      if (record.attempted.volume) fail("Dependency volume creation or absence is unknown; preserve data");
      return undefined;
    }
    const volume = JSON.parse(docker(["volume", "inspect", this.volume]))[0];
    if (names.length !== 1 || names[0] !== this.volume || volume.Name !== this.volume || volume.Driver !== "local"
      || Object.keys(volume.Options ?? {}).length || !labelsMatch(volume.Labels, this.labels(record))
      || (record.volume_created_at && volume.CreatedAt !== record.volume_created_at)) fail("Dependency volume identity changed; preserve data");
    return volume;
  }
  private container(record: ResourceReceipt, allowMissing = false): any | undefined {
    const ids = docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${this.name}$`]).split("\n").filter(Boolean);
    if (!ids.length) {
      if (record.attempted.container && !allowMissing) fail("Dependency container creation or absence is unknown; retain ownership");
      return undefined;
    }
    const service = JSON.parse(docker(["inspect", ids[0]!]))[0];
    const networks = Object.values(service.NetworkSettings.Networks ?? {}) as { NetworkID: string }[];
    const mounts = service.Mounts as { Type: string; Name?: string; Destination: string; RW: boolean }[];
    if (ids.length !== 1 || service.Name !== `/${this.name}` || (record.container_id && service.Id !== record.container_id)
      || service.Image !== this.image || !labelsMatch(service.Config.Labels, this.labels(record))
      || service.HostConfig.NetworkMode !== record.network_id || networks.length !== 1
      || Object.keys(service.NetworkSettings.Networks)[0] !== this.name
      || (networks[0]!.NetworkID ? networks[0]!.NetworkID !== record.network_id : service.State.Running)
      || Object.keys(service.HostConfig.PortBindings ?? {}).length || service.HostConfig.RestartPolicy.Name !== "no"
      || mounts.length !== 1 || mounts[0]!.Type !== "volume" || mounts[0]!.Name !== this.volume
      || mounts[0]!.Destination !== "/var/lib/postgresql/data" || !mounts[0]!.RW)
      fail("Dependency container configuration or identity changed");
    return service;
  }
  private binding(record: ResourceReceipt): RouteDependency {
    if (!record.network_id || !record.container_id || !record.volume_created_at) fail("Dependency preparation is incomplete");
    return { kind: "postgres", network_id: record.network_id!, container_id: record.container_id!, volume_name: this.volume,
      host: "postgres", port: 5432, database: "task", user: "postgres" };
  }
  async prepare(): Promise<RouteDependency> {
    assertVolumeWritable(this.run, this.volume);
    const image = JSON.parse(docker(["image", "inspect", this.image]))[0];
    if (image.Id !== this.image || !image.Config.Env?.includes("PG_MAJOR=16")
      || JSON.stringify(Object.keys(image.Config.Volumes ?? {})) !== '["/var/lib/postgresql/data"]')
      fail("This runtime profile requires a fixed local PostgreSQL 16 image with its standard data volume");
    const record = this.read() ?? { format: "grounds.route-postgres/v1", key: this.key, engine_id: this.run.engine_id,
      creation_execution_id: this.run.execution_id, attempted: {}, state: "preparing" } as ResourceReceipt;
    if (record.cleanup) fail("Service resources are retired or being reclaimed; retain the data volume");
    record.state = "preparing"; this.persist(record);
    const labelArgs = Object.entries(this.labels(record)).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
    // Reconcile a container first when its create reply was lost, before checking network consumers.
    if (record.attempted.container && !record.container_id) {
      const found = this.container(record);
      if (found) { record.container_id = found.Id; this.persist(record); }
    }
    let network = this.network(record);
    if (!network) {
      record.attempted.network = true; this.persist(record);
      const id = docker(["network", "create", "--internal", "--driver", "bridge", ...labelArgs, this.name]);
      record.network_id = id; network = this.network(record); this.persist(record);
    } else { record.network_id = network.Id; this.persist(record); }
    let volume = this.inspectVolume(record);
    if (!volume) {
      record.attempted.volume = true; this.persist(record);
      docker(["volume", "create", "--driver", "local", ...labelArgs, this.volume]);
      volume = this.inspectVolume(record);
    }
    record.volume_created_at = volume.CreatedAt; this.persist(record);
    let service = this.container(record);
    if (!service) {
      record.attempted.container = true; this.persist(record);
      record.container_id = docker(["create", "--name", this.name, "--pull", "never", "--restart", "no", ...labelArgs,
        "--network", record.network_id!, "--network-alias", "postgres", "--security-opt", "no-new-privileges",
        "--cpus", "1", "--memory", "512m", "--pids-limit", "128",
        "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false",
        "--mount", `type=volume,src=${this.volume},dst=/var/lib/postgresql/data`,
        "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_DB=task",
        "--env", "PGDATA=/var/lib/postgresql/data/pgdata", this.image]);
      service = this.container(record); this.persist(record);
    }
    if (service.State.Paused || service.State.Restarting) fail("Dependency service has an unknown transition");
    if (!service.State.Running) docker(["start", service.Id]);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (!this.container(record)?.State.Running) break;
      try {
        docker(["exec", record.container_id!, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "task"], 5000);
        record.state = "ready"; this.persist(record); return this.binding(record);
      } catch { /* Initialization is bounded; no executor is started before readiness. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return fail("PostgreSQL did not become ready; stop/reconcile this execution before retrying");
  }
  assertReady(): void {
    assertVolumeWritable(this.run, this.volume);
    const record = this.read() ?? fail("Dependency receipt is missing");
    if (record.state !== "ready" || sha256(this.binding(record)) !== sha256(this.run.dependency))
      fail("Execution does not hold the prepared dependency binding");
    this.network(record); this.inspectVolume(record);
    const container = this.container(record);
    if (!container?.State.Running || container.State.Paused || container.State.Restarting) fail("Dependency is no longer running");
    docker(["exec", container.Id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "task"], 5000);
  }
  private logs(containerId: string): Buffer {
    const result = spawnSync("docker", ["logs", "--timestamps", containerId], { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
    if (result.status !== 0 || result.error) fail("Cannot preserve complete stopped-service diagnostics");
    return Buffer.from(JSON.stringify({ format: "grounds.service-log/v1", stdout: result.stdout.toString("base64"), stderr: result.stderr.toString("base64") }));
  }
  async retainedVolume() {
    try {
      const record = this.read();
      if (!record) return unknownVolume(this.volume);
      return inspectRetainedVolume(this.run, this.volume, record.volume_created_at ?? null, this.labels(record));
    } catch { return unknownVolume(this.volume); }
  }
  async cleanupSnapshot(): Promise<ServiceSnapshot> {
    const record = this.read() ?? fail("Service receipt is missing");
    if (record.state !== "stopped") fail("Service cleanup requires proven stopped resources");
    const container = this.container(record, !!record.cleanup && record.cleanup.container !== "pending");
    const network = this.network(record, !!record.cleanup && record.cleanup.network !== "pending");
    const volume = this.inspectVolume(record) ?? fail("Retained service data volume is missing");
    if (!record.container_id || !record.network_id || !record.volume_created_at) fail("Service creation was not completed");
    const blockers: string[] = [];
    if (container?.State.Running || container?.State.Paused || container?.State.Restarting) blockers.push("service_not_stopped");
    if (network && Object.keys(network.Containers ?? {}).some(id => id !== record.container_id)) blockers.push("network_has_other_consumers");
    const consumers = docker(["ps", "-aq", "--no-trunc", "--filter", `volume=${this.volume}`]).split("\n").filter(Boolean);
    if (consumers.some(id => id !== record.container_id)) blockers.push("volume_has_other_consumers");
    // Only PostgreSQL's known directory metadata changes are reconstructible.
    // Any new/deleted/changed file, including under /run, retains the container.
    if (container && docker(["diff", container.Id]).split("\n").filter(Boolean)
      .some(line => !["C /run", "C /run/postgresql"].includes(line))) blockers.push("unpreserved_container_changes");
    return { key: this.key, engine_id: this.run.engine_id, container_id: record.container_id!, network_id: record.network_id!,
      volume_name: volume.Name, volume_created_at: volume.CreatedAt, blockers,
      log_digest: container ? digestBytes(this.logs(container.Id)) : record.cleanup!.snapshot.log_digest,
      container_state: container ? "eligible" : "removed", network_state: network ? "eligible" : "removed" };
  }
  async reclaimService(input: { operation_id: string; snapshot: ServiceSnapshot }): Promise<ServiceDiagnostics> {
    if (!isUUIDv7(input.operation_id)) fail("Service cleanup requires an operation UUIDv7");
    const record = this.read() ?? fail("Service receipt is missing");
    const actual = await this.cleanupSnapshot();
    if (actual.blockers.length) fail("Service has unpreserved contents or additional consumers");
    if (!record.cleanup) {
      if (sha256(actual) !== sha256(input.snapshot)) fail("Service cleanup snapshot changed");
      const directory = join(resolve(this.run.code_path, "../../../.."), "archive", "service-cleanup", input.operation_id);
      record.cleanup = { operation_id: input.operation_id, snapshot: input.snapshot,
        diagnostics: { directory, digest: actual.log_digest, review_after: new Date(Date.now() + 90 * 86400000).toISOString() },
        container: "pending", network: "pending" };
      this.persist(record); // Intent precedes archive and each deletion.
    }
    const cleanup = record.cleanup;
    if (cleanup.operation_id !== input.operation_id || sha256(cleanup.snapshot) !== sha256(input.snapshot))
      fail("Resume the original service cleanup operation");
    const { container_state: _container, network_state: _network, ...identity } = actual;
    const { container_state: _oldContainer, network_state: _oldNetwork, ...expected } = cleanup.snapshot;
    if (sha256(identity) !== sha256(expected)) fail("Service identity, data volume or diagnostics changed during cleanup");
    const directory = privateDirectory(cleanup.diagnostics.directory);
    const logPath = join(directory, "postgres-log.json"), manifestPath = join(directory, "manifest.json");
    if (!existsSync(logPath)) {
      if (actual.container_state !== "eligible") fail("Diagnostics disappeared after service removal; retain remaining resources");
      const logs = this.logs(actual.container_id);
      if (digestBytes(logs) !== cleanup.diagnostics.digest) fail("Stopped-service diagnostics changed");
      atomicPrivateWrite(logPath, logs);
    }
    if (digestBytes(safeRead(logPath, 12 * 1024 * 1024)) !== cleanup.diagnostics.digest) fail("Archived service diagnostics failed integrity validation");
    const manifest = { format: "grounds.service-cleanup-archive/v1", operation_id: input.operation_id,
      route_id: this.run.route_id, database_id: this.run.database_id, host_id: this.run.host_id,
      snapshot: cleanup.snapshot, review_after: cleanup.diagnostics.review_after, log_digest: cleanup.diagnostics.digest };
    if (existsSync(manifestPath)) {
      if (sha256(JSON.parse(safeRead(manifestPath).toString())) !== sha256(manifest)) fail("Service archive manifest changed");
    } else atomicPrivateWrite(manifestPath, JSON.stringify(manifest));
    if (cleanup.container !== "removed") {
      cleanup.container = "removing"; this.persist(record);
      const container = this.container(record, true);
      if (container) {
        if (container.State.Running || container.State.Paused || container.State.Restarting) fail("Service restarted during cleanup");
        docker(["rm", container.Id]); // No force and no volume deletion.
      }
      if (this.container(record, true)) fail("Service container removal is unproven");
      cleanup.container = "removed"; this.persist(record);
    } else if (this.container(record, true)) fail("Service container reappeared after cleanup");
    if (cleanup.network !== "removed") {
      cleanup.network = "removing"; this.persist(record);
      const network = this.network(record, true);
      if (network) {
        if (Object.keys(network.Containers ?? {}).length) fail("Service network acquired a consumer");
        docker(["network", "rm", network.Id]);
      }
      if (this.network(record, true)) fail("Service network removal is unproven");
      cleanup.network = "removed"; this.persist(record);
    } else if (this.network(record, true)) fail("Service network reappeared after cleanup");
    this.inspectVolume(record); // Prove the original data volume remains, never remove it.
    return cleanup.diagnostics;
  }
  async inspectRestoreVolume(input: RestoreVolumeInput) { return inspectRestorationVolume(this.run, input); }
  async removeVolume(snapshot: ServiceSnapshot) {
    if (snapshot.engine_id !== this.run.engine_id || docker(["info", "--format", "{{.ID}}"] ) !== this.run.engine_id
      || !/^grounds-[a-z0-9-]+$/.test(snapshot.volume_name)) fail("Volume deletion engine or name changed");
    docker(["volume", "rm", snapshot.volume_name]);
  }
  async cleanupRestore(input: { operation_id: string; source: RestoredExportSource }) { return cleanupRestoration(this.run, input); }
  async inspectRestore(input: RestoreVolumeInput) { return inspectServiceVolumeRestore(this.run, input); }
  async stopRestore(input: RestoreVolumeInput, operationID: string) { return restoreServiceVolume(this.run, input, operationID); }
  async restoreVolume(input: RestoreVolumeInput) { return restoreServiceVolume(this.run, input); }
  async restoreExportSnapshot(source: RestoredExportSource) {
    assertRestoredExportSource(this.run, source);
    return restoredExportSnapshot(source);
  }
  async exportVolume(input: { operation_id: string; snapshot: ServiceSnapshot; comparison?: VolumeComparisonReference; restoration?: RestoredExportSource; verification?: VolumeVerificationReference }) {
    const snapshot = input.snapshot;
    if (input.restoration) {
      const source = input.restoration;
      if (sha256(snapshot) !== sha256(restoredExportSnapshot(source))) fail("Restored export snapshot changed");
      return exportServiceVolume(this.run, snapshot, input.operation_id,
        helperID => assertRestoredExportSource(this.run, source, helperID), input.comparison, source.input.operation_id, input.verification);
    }
    return exportServiceVolume(this.run, snapshot, input.operation_id, helperID => {
      const record = this.read() ?? fail("Service receipt is missing");
      if (!record.cleanup || record.cleanup.container !== "removed" || record.cleanup.network !== "removed"
        || record.key !== snapshot.key || record.container_id !== snapshot.container_id || record.network_id !== snapshot.network_id)
        fail("Volume export requires completed service cleanup");
      if (this.container(record, true) || this.network(record, true)) fail("Retired service resources reappeared");
      const volume = this.inspectVolume(record) ?? fail("Retained source volume is missing");
      if (volume.Name !== snapshot.volume_name || volume.CreatedAt !== snapshot.volume_created_at) fail("Source volume identity changed");
      const consumers = docker(["ps", "-aq", "--no-trunc", "--filter", `volume=${volume.Name}`]).split("\n").filter(Boolean);
      if (consumers.some(id => id !== helperID)) fail("Source volume has another consumer; cold export is blocked");
    }, input.comparison, undefined, input.verification);
  }
  async stop(): Promise<void> {
    const record = this.read();
    if (!record) {
      if (this.run.dependency) fail("Dependency receipt disappeared; retain ownership");
      return; // No intent means no dependency effect could have been issued by this execution.
    }
    const service = this.container(record);
    if (service && !record.container_id) { record.container_id = service.Id; this.persist(record); }
    this.network(record); this.inspectVolume(record);
    if (service) {
      if (service.State.Paused || service.State.Restarting) fail("Cannot prove dependency stop during an external transition");
      if (service.State.Running) docker(["stop", "--time", "5", service.Id]);
      if (this.container(record)?.State.Running) fail("Dependency stop is unproven");
    }
    record.state = "stopped"; this.persist(record);
  }
}
