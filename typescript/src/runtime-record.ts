import { isUUIDv7 } from "./identity.js";
import { validation, DomainError } from "./errors.js";
import type { Store, Tx } from "./store-types.js";
export type RuntimeKind = "runtime_operation";

/** Kinds of the retired environment model. Their rows stay in the ledger, but no code reads or interprets them. */
export const RETIRED_RUNTIME_KINDS: ReadonlySet<string> = new Set(["sandbox", "use", "execution", "content"]);
export interface RuntimeRecord {
  id: string;
  kind: RuntimeKind;
  parent_id?: string;
  version: number;
  data: Record<string, unknown>;
}
export type RuntimeReason =
  | "state_conflict"
  | "busy"
  | "connection_drift"
  | "outcome_unknown"
  | "unsupported"
  | "material_conflict"
  | "ownership_mismatch"
  | "recovery_required";
export const runtimeError = (
  reason: string,
  id?: string,
  reasonCode: RuntimeReason = "state_conflict",
): DomainError =>
  new DomainError("STATE_CONFLICT", reason, false, {
    reason,
    reason_code: reasonCode,
    ...(id ? { resource_id: id } : {}),
  });
export function validateRuntimeRecord(record: RuntimeRecord): void {
  if (
    !isUUIDv7(record.id) ||
    record.kind !== "runtime_operation" ||
    !Number.isSafeInteger(record.version) ||
    record.version < 1 ||
    !record.data ||
    Array.isArray(record.data) ||
    (record.parent_id !== undefined && !isUUIDv7(record.parent_id))
  )
    throw validation("runtime_record", "invalid identity, kind or version");
  // Internal recipes contain at most 4 MiB of file bytes encoded as base64.
  // Other runtime records retain the original bound.
  const maximum = record.data.format === "grounds.development-recipe/v1" ? 6 * 1024 * 1024 : 1024 * 1024;
  if (Buffer.byteLength(JSON.stringify(record)) > maximum)
    throw validation("runtime_record", `maximum record size is ${maximum / 1024 / 1024} MiB`);
}
export async function runtimeGet(
  tx: Tx,
  kind: RuntimeKind,
  id: string,
): Promise<RuntimeRecord> {
  if (!isUUIDv7(id)) throw validation("id", "UUIDv7 required");
  const row = await tx.getRuntimeRecord(kind, id);
  if (!row)
    throw new DomainError("NOT_FOUND", `${kind} not found`, false, {
      resource_type: kind,
      resource_id: id,
    });
  return row;
}
export async function runtimeChange(
  store: Store,
  kind: RuntimeKind,
  id: string,
  change: (row: RuntimeRecord, tx: Tx) => Promise<void> | void,
): Promise<RuntimeRecord> {
  return store.write(async (tx) => {
    const row = await runtimeGet(tx, kind, id);
    const old = row.version;
    await change(row, tx);
    row.version++;
    await tx.saveRuntimeRecord(row, old);
    return row;
  });
}
