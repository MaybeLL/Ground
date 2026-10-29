import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { docker } from "./env-docker.js";
import { DomainError } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { sha256 } from "./canonical-json.js";
import { atomicPrivateWrite, digestBytes, privateDirectory, safeRead } from "./runtime-files.js";
import type { RouteExecution } from "./code-route-execution.js";
import type { ServiceSnapshot } from "./code-route-service-cleanup.js";
import { readVolumeRetirement } from "./code-route-volume-retirement.js";
import type { VolumeCapture, VolumeVerificationReference } from "./code-route-volume-evidence.js";

// Bounded first implementation: raw tar, no decompression or untrusted extraction on the host.
const MAX_ARCHIVE = 128 * 1024 * 1024;
const fail = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
export interface VolumeComparisonReference { archive_id: string; archive_digest: string }
export interface VolumeComparison extends VolumeComparisonReference {
  algorithm: "docker-tar-sha256/v1"; status: "identical" | "different"; compared_at: string;
}
export interface ServiceVolumeArchive {
  operation_id: string; route_id: string; execution_id: string; source_volume: string; source_created_at: string;
  engine_id: string; image: string; directory: string; path: string; digest: string; size_bytes: number;
  review_after: string; restore_status: "not_verified"; source_restore_id?: string; comparison?: VolumeComparison; capture?: VolumeCapture;
}
interface Journal {
  format: "grounds.service-volume-export/v1"; request_digest: string; review_after: string;
  phase: "planned" | "creating" | "copying" | "removing" | "completed"; helper_id?: string; result?: ServiceVolumeArchive;
  capture?: VolumeCapture;
}
/** Caller holds workspace -> route locks. Source assertion excludes only this exact read-only helper. */
export async function exportServiceVolume(run: RouteExecution, snapshot: ServiceSnapshot, operationID: string,
  assertSource: (helperID?: string) => void, comparison?: VolumeComparisonReference, sourceRestoreID?: string,
  verification?: VolumeVerificationReference): Promise<ServiceVolumeArchive> {
  if (!isUUIDv7(operationID)) fail("Volume export requires an operation UUIDv7");
  const root = resolve(run.code_path, "../../../.."), image = run.environment!.configuration.postgres!.image;
  const path = join(root, "runtime", "volume-exports", `${operationID}.json`);
  const directory = join(root, "archive", "service-volumes", operationID), tarPath = join(directory, "volume.tar");
  const manifestPath = join(directory, "manifest.json"), name = `grounds-volume-export-${operationID}`;
  const digest = sha256({ operationID, execution: run.execution_id, route: run.route_id, snapshot, image, ...(comparison ? { comparison } : {}), ...(sourceRestoreID ? { source_restore_id: sourceRestoreID } : {}), ...(verification ? { verification } : {}) });
  let record = existsSync(path) ? JSON.parse(safeRead(path).toString()) as Journal : undefined;
  if (record && (record.format !== "grounds.service-volume-export/v1" || record.request_digest !== digest))
    fail("Volume export differs from its original request");
  const verifyArchive = (result: ServiceVolumeArchive) => {
    if (result.path !== tarPath || result.directory !== directory || result.operation_id !== operationID) fail("Archive identity changed");
    const bytes = safeRead(tarPath, MAX_ARCHIVE);
    if (bytes.length !== result.size_bytes || digestBytes(bytes) !== result.digest) fail("Volume archive integrity digest failed");
    const manifest = JSON.parse(safeRead(manifestPath).toString());
    if (sha256(manifest) !== sha256({ format: "grounds.service-volume-archive/v1", ...result, snapshot })) fail("Volume archive manifest integrity failed");
  };
  if (record?.phase === "completed") { verifyArchive(record.result!); return record.result!; }
  if (!record) {
    assertSource();
    // Never attach a new causal claim to bytes left behind without their original journal.
    if (existsSync(tarPath)) fail("Archive bytes already exist without capture intent; retain them");
    let capture: VolumeCapture | undefined;
    try {
      const retirement = readVolumeRetirement(run, snapshot.volume_name)?.retirement;
      if (retirement && retirement.execution_id === run.execution_id && retirement.source_restore_id === sourceRestoreID
        && retirement.volume_created_at === snapshot.volume_created_at)
        capture = { retirement_id: retirement.operation_id, retirement_digest: sha256(retirement), ...(verification ? { verification } : {}) };
    } catch { /* Protective export may still proceed, but cannot claim a proven retirement. */ }
    if (verification && !capture) fail("Verified recheck requires matching persistent volume retirement before capture");
    record = { format: "grounds.service-volume-export/v1", request_digest: digest, phase: "planned",
      review_after: new Date(Date.now() + 90 * 86400000).toISOString(), ...(capture ? { capture } : {}) };
    atomicPrivateWrite(path, JSON.stringify(record));
  }
  const persist = () => atomicPrivateWrite(path, JSON.stringify(record));
  const find = () => {
    if (docker(["info", "--format", "{{.ID}}"] ) !== run.engine_id) fail("Volume export engine changed");
    const ids = docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${name}$`]).split("\n").filter(Boolean);
    if (!ids.length) {
      if (!["planned", "removing"].includes(record!.phase)) fail("Volume export helper creation or absence is unknown; resume original operation");
      return undefined;
    }
    const helper = JSON.parse(docker(["inspect", ids[0]!]))[0], mounts = helper.Mounts;
    if (ids.length !== 1 || helper.Name !== `/${name}` || (record!.helper_id && helper.Id !== record!.helper_id)
      || helper.Image !== image || helper.Config.Labels?.["grounds.volume-export"] !== operationID
      || helper.Config.Labels?.["grounds.code-route"] !== run.route_id
      || helper.HostConfig.NetworkMode !== "none" || helper.HostConfig.ReadonlyRootfs !== true
      || helper.State.Status !== "created" || JSON.stringify(helper.Config.Entrypoint) !== '["true"]'
      || mounts.length !== 1 || mounts[0].Type !== "volume" || mounts[0].Name !== snapshot.volume_name
      || mounts[0].Destination !== "/var/lib/postgresql/data" || mounts[0].RW !== false)
      fail("Volume export helper identity or read-only configuration changed");
    return helper.Id as string;
  };
  let helper = find();
  assertSource(helper);
  privateDirectory(directory);
  // Every archive entry has an explicit review date even if copying never completes.
  if (!existsSync(manifestPath)) atomicPrivateWrite(manifestPath, JSON.stringify({ format: "grounds.service-volume-archive-pending/v1",
    operation_id: operationID, review_after: record.review_after, snapshot }));
  if (!helper && record.phase === "planned") {
    record.phase = "creating"; persist();
    record.helper_id = docker(["create", "--pull", "never", "--name", name, "--network", "none", "--read-only",
      "--label", `grounds.volume-export=${operationID}`, "--label", `grounds.code-route=${run.route_id}`,
      "--mount", `type=volume,src=${snapshot.volume_name},dst=/var/lib/postgresql/data,readonly`, "--entrypoint", "true", image]);
    helper = find(); record.phase = "copying"; persist();
  } else if (helper && record.phase === "creating") {
    record.helper_id = helper; record.phase = "copying"; persist();
  }
  if (!record.result) {
    if (!helper) fail("Archive is missing and export helper was removed");
    assertSource(helper);
    // A stopped, never-started helper lets Docker archive the volume without running any code against it.
    // Interrupted reads are safe to repeat; they cannot write the source volume.
    if (!existsSync(tarPath)) {
      const copy = spawnSync("docker", ["cp", "-a", `${helper}:/var/lib/postgresql/data/.`, "-"],
        { timeout: 60_000, maxBuffer: MAX_ARCHIVE });
      if (copy.status !== 0 || copy.error || copy.stdout.length > MAX_ARCHIVE) fail("Volume export incomplete or exceeds 128 MiB; retain source and helper");
      assertSource(helper);
      atomicPrivateWrite(tarPath, copy.stdout);
    }
    const bytes = safeRead(tarPath, MAX_ARCHIVE);
    record.result = { operation_id: operationID, route_id: run.route_id, execution_id: run.execution_id,
      source_volume: snapshot.volume_name, source_created_at: snapshot.volume_created_at, engine_id: run.engine_id, image,
      directory, path: tarPath, digest: digestBytes(bytes), size_bytes: bytes.length,
      review_after: record.review_after, restore_status: "not_verified",
      ...(record.capture ? { capture: record.capture } : {}),
      ...(sourceRestoreID ? { source_restore_id: sourceRestoreID } : {}),
      ...(comparison ? { comparison: { ...comparison, algorithm: "docker-tar-sha256/v1" as const,
        status: digestBytes(bytes) === comparison.archive_digest ? "identical" as const : "different" as const,
        compared_at: new Date().toISOString() } } : {}) };
    persist();
  }
  const result = record.result;
  const manifest = JSON.parse(safeRead(manifestPath).toString());
  if (manifest.format === "grounds.service-volume-archive-pending/v1") {
    if (sha256(manifest) !== sha256({ format: "grounds.service-volume-archive-pending/v1", operation_id: operationID,
      review_after: record.review_after, snapshot })) fail("Pending volume archive manifest changed");
    atomicPrivateWrite(manifestPath, JSON.stringify({ format: "grounds.service-volume-archive/v1", ...result, snapshot }));
  }
  verifyArchive(result); assertSource(helper);
  record.phase = "removing"; persist();
  helper = find();
  if (helper) docker(["rm", helper]);
  if (find()) fail("Volume export helper removal is unproven");
  assertSource();
  record.phase = "completed"; persist();
  return result;
}
