import { isUUIDv7 } from "./identity.js";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "STATE_CONFLICT"
  | "AUTH_FAILED"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "SCHEMA_INCOMPATIBLE"
  | "MIGRATION_DIRTY"
  | "DATABASE_ID_MISMATCH"
  | "BASELINE_UNAVAILABLE"
  | "WORKTREE_MISMATCH"
  | "ENVIRONMENT_CAPABILITY_UNSUPPORTED"
  | "ENVIRONMENT_SETUP_FAILED"
  | "ARTIFACT_INTEGRITY_ERROR"
  | "STORAGE_TRANSIENT"
  | "INTERNAL";

export interface ErrorDetails {
  [key: string]: unknown;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, retryable = false, details: ErrorDetails = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

const bounded = (value: string, max: number): string => {
  if ([...value].length <= max) return value;
  return [...value].slice(0, Math.max(0, max - 1)).join("") + "…";
};

export const validation = (field: string, reason: string): DomainError =>
  new DomainError("VALIDATION_ERROR", "input failed validation", false, {
    field: bounded(field, 256),
    reason: bounded(reason, 4096),
  });

export const stateConflict = (resourceType: string, resourceId: string, reason: string): DomainError =>
  new DomainError("STATE_CONFLICT", "resource state does not permit this operation", false, {
    resource_type: resourceType,
    resource_id: resourceId,
    reason: bounded(reason, 4096),
  });

export const storageTransient = (reason: string, retryAfterMs = 250): DomainError =>
  new DomainError("STORAGE_TRANSIENT", "storage is temporarily unavailable", true, {
    reason: bounded(reason, 4096),
    retry_after_ms: Math.max(0, Math.min(3_600_000, retryAfterMs)),
  });

export const schemaDetails = (requiredVersion: number | string, actualVersionText: string): ErrorDetails => ({
  required_version: String(requiredVersion),
  actual_version_text: bounded(actualVersionText || "unknown", 128),
});

export const baselineUnavailable = (reason: string): DomainError =>
  new DomainError("BASELINE_UNAVAILABLE", "baseline is unavailable", false, { reason: bounded(reason, 4096) });

export const worktreeMismatch = (resourceId: string, reason: string): DomainError => {
  const details: ErrorDetails = { reason: bounded(reason, 4096) };
  if (resourceId) details.resource_id = resourceId;
  return new DomainError("WORKTREE_MISMATCH", "current worktree does not match the Issue repository", false, details);
};

export const asDomainError = (error: unknown): DomainError => {
  if (error instanceof DomainError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DomainError("INTERNAL", "unexpected internal failure", false, { reason: bounded(message, 4096) });
};
