import type { ManagedVolumeWrites } from "./code-route-volume-retirement.js";
import { join, resolve } from "node:path";
import { isUUIDv7 } from "./identity.js";
import { docker } from "./env-docker.js";
import { sha256 } from "./canonical-json.js";
import { digestBytes, safeRead } from "./runtime-files.js";
import type { RouteExecution } from "./code-route-execution.js";
import type { ServiceSnapshot } from "./code-route-service-cleanup.js";
import type { ServiceVolumeArchive } from "./code-route-volume-archive.js";

export interface RetainedVolume {
  name: string; expected_created_at: string | null; managed_writes?: ManagedVolumeWrites;
  state: "matching" | "missing" | "identity_changed" | "unknown"; consumers: string[] | null;
}
export function unknownVolume(name: string, createdAt: string | null = null): RetainedVolume {
  return { name, expected_created_at: createdAt, state: "unknown", consumers: null };
}
/** Docker observations only. Unavailable engine/identity is never interpreted as absence. */
export function inspectRetainedVolume(run: RouteExecution, name: string, createdAt: string | null, labels: Record<string, string>): RetainedVolume {
  const base = unknownVolume(name, createdAt);
  try {
    if (!/^grounds-[a-z0-9-]+$/.test(name) || docker(["info", "--format", "{{.ID}}"], 5000) !== run.engine_id) return base;
    const names = docker(["volume", "ls", "-q", "--filter", `name=^${name}$`], 5000).split("\n").filter(Boolean);
    if (!names.length) return { ...base, state: "missing", consumers: [] };
    if (!createdAt) return base; // Creation reply may have been lost; replacement is not proven.
    const volume = JSON.parse(docker(["volume", "inspect", name], 5000))[0];
    if (names.length !== 1 || volume.Name !== name || volume.CreatedAt !== createdAt || volume.Driver !== "local"
      || Object.keys(volume.Options ?? {}).length || Object.entries(labels).some(([key, value]) => volume.Labels?.[key] !== value))
      return { ...base, state: "identity_changed" };
    const consumers = docker(["ps", "-aq", "--no-trunc", "--filter", `volume=${name}`], 5000).split("\n").filter(Boolean).sort();
    return { ...base, state: "matching", consumers };
  } catch { return base; }
}
export function volumeBlockers(volume: RetainedVolume, gate: "ready" | "retention" | "pinned"): string[] {
  return ["explicit_deletion_required", "current_contents_not_preserved",
    ...(volume.managed_writes?.state === "unknown" ? ["managed_write_state_unknown"] : []), ...(gate === "ready" ? [] : [gate]),
    ...(volume.state === "matching" ? [] : [`volume_${volume.state}`]), ...(volume.consumers?.length ? ["volume_has_consumers"] : [])];
}
/** Revalidates archived bytes without replaying an export or creating any helper/container. */
export function archiveIntegrity(run: RouteExecution, archive: ServiceVolumeArchive, snapshot: ServiceSnapshot): "valid" | "unavailable" {
  try {
    if (!isUUIDv7(archive.operation_id)) return "unavailable";
    const directory = join(resolve(run.code_path, "../../../.."), "archive", "service-volumes", archive.operation_id);
    if (archive.directory !== directory || archive.path !== join(directory, "volume.tar") || archive.route_id !== run.route_id
      || archive.engine_id !== run.engine_id || archive.image !== run.environment!.configuration.postgres!.image
      || (archive.source_restore_id !== undefined
        ? !isUUIDv7(archive.source_restore_id) || archive.source_volume !== `grounds-volume-restore-${archive.source_restore_id}`
        : archive.source_volume !== run.dependency!.volume_name)
      || archive.source_volume !== snapshot.volume_name
      || archive.source_created_at !== snapshot.volume_created_at) return "unavailable";
    const bytes = safeRead(archive.path, 128 * 1024 * 1024);
    if (bytes.length !== archive.size_bytes || digestBytes(bytes) !== archive.digest
      || sha256(JSON.parse(safeRead(join(directory, "manifest.json")).toString())) !== sha256({ format: "grounds.service-volume-archive/v1", ...archive, snapshot }))
      return "unavailable";
    return "valid";
  } catch { return "unavailable"; }
}
