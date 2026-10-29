import { join, resolve } from "node:path";
import { sha256 } from "./canonical-json.js";
import { DomainError } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { atomicPrivateWrite, safeRead } from "./runtime-files.js";
import type { RouteExecution } from "./code-route-execution.js";

export interface VolumeRetirement {
  operation_id: string; route_id: string; execution_id: string; engine_id: string;
  volume_name: string; volume_created_at: string; source_restore_id?: string;
  scope: "grounds_managed_writes"; state: "retiring"; recorded_at: string;
}
interface Receipt {
  format: "grounds.volume-retirement/v1"; database_id: string; host_id: string;
  request_digest: string; retirement: VolumeRetirement;
}
const fail = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
// The name remains reserved even if somebody replaces the underlying volume. A replacement
// must never silently inherit write permission just because its creation timestamp changed.
function path(run: RouteExecution, name: string) {
  const key = sha256({ engine_id: run.engine_id, volume_name: name }).slice(7);
  return join(resolve(run.code_path, "../../../.."), "runtime", "volume-retirements", `${key}.json`);
}
export function readVolumeRetirement(run: RouteExecution, name: string): Receipt | undefined {
  let bytes: Buffer;
  try { bytes = safeRead(path(run, name), 16 * 1024); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fail("Volume write retirement is unreadable; retain the write fence");
  }
  let record: Receipt;
  try { record = JSON.parse(bytes.toString()) as Receipt; }
  catch { return fail("Volume write retirement is invalid; retain the write fence"); }
  const r = record.retirement;
  if (record.format !== "grounds.volume-retirement/v1" || record.database_id !== run.database_id || record.host_id !== run.host_id
    || !/^sha256:[a-f0-9]{64}$/.test(record.request_digest) || !r || !isUUIDv7(r.operation_id)
    || r.route_id !== run.route_id || !isUUIDv7(r.execution_id) || r.engine_id !== run.engine_id || r.volume_name !== name
    || !r.volume_created_at || !Number.isFinite(Date.parse(r.recorded_at))
    || r.scope !== "grounds_managed_writes" || r.state !== "retiring"
    || (r.source_restore_id !== undefined && !isUUIDv7(r.source_restore_id)))
    return fail("Volume write retirement identity changed; retain the write fence");
  return record;
}
export function assertVolumeWritable(run: RouteExecution, name: string): void {
  if (readVolumeRetirement(run, name)) fail("Volume is retired for managed writes; retain it and use a new volume");
}
/** Caller holds workspace -> route locks. Persist before confirming stop or replying to the caller. */
export function persistVolumeRetirement(run: RouteExecution, retirement: VolumeRetirement, requestDigest: string): void {
  const record: Receipt = { format: "grounds.volume-retirement/v1", database_id: run.database_id, host_id: run.host_id,
    request_digest: requestDigest, retirement };
  const previous = readVolumeRetirement(run, retirement.volume_name);
  if (previous) {
    if (sha256(previous) !== sha256(record)) fail("Volume retirement differs from its original request");
    return;
  }
  atomicPrivateWrite(path(run, retirement.volume_name), JSON.stringify(record));
  if (sha256(readVolumeRetirement(run, retirement.volume_name)) !== sha256(record)) fail("Volume retirement persistence is unproven");
}

export type ManagedVolumeWrites = { state: "not_retired" | "unknown" } | { state: "retiring"; operation_id: string };
export function managedVolumeWrites(run: RouteExecution, name: string): ManagedVolumeWrites {
  try {
    const record = readVolumeRetirement(run, name);
    return record ? { state: "retiring", operation_id: record.retirement.operation_id } : { state: "not_retired" };
  } catch { return { state: "unknown" }; }
}
