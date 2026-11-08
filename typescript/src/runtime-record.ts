import { DomainError } from "./errors.js";
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
