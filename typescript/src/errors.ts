import { isUUIDv7 } from "./identity.js";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "VERIFICATION_SET_CHANGED"
  | "LIST_CHANGED"
  | "STATE_CONFLICT"
  | "AUTH_FAILED"
  | "VERSION_CONFLICT"
  | "PREDECESSOR_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "SCHEMA_INCOMPATIBLE"
  | "MIGRATION_DIRTY"
  | "BRAND_MIGRATION_REQUIRED"
  | "DATABASE_ID_MISMATCH"
  | "REPOSITORY_NOT_RESOLVED"
  | "REPOSITORY_AMBIGUOUS"
  | "BASELINE_UNAVAILABLE"
  | "REPOSITORY_ISSUE_LIMIT"
  | "WORKTREE_MISMATCH"
  | "ENVIRONMENT_CAPABILITY_UNSUPPORTED"
  | "ENVIRONMENT_SETUP_FAILED"
  | "UNSUPPORTED_CANDIDATE_ARTIFACT"
  | "ARTIFACT_TOO_LARGE"
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

export const notFound = (resourceType: string, resourceId = ""): DomainError => {
  // Storage-only lookup keys (for example alias names and blob digests) are
  // not valid public resource identities. Keep NOT_FOUND envelopes within
  // the contract even when an internal helper passes one of those keys.
  const resourceTypes = new Set(["config", "database", "repository", "requirement", "issue", "dev_run", "candidate", "verification", "artifact", "eval_grader", "eval_suite", "eval_snapshot", "eval_experiment", "eval_run", "eval_execution", "eval_result", "eval_notice", "eval_qa", "eval_artifact", "eval_environment", "eval_envcheck", "eval_preparation", "eval_instance", "environment_revision", "environment_default"]);
  const publicType = resourceTypes.has(resourceType);
  const details: ErrorDetails = { resource_type: publicType ? resourceType : "database" };
  if (publicType && isUUIDv7(resourceId)) details.resource_id = resourceId;
  return new DomainError("NOT_FOUND", "resource was not found", false, details);
};

export const predecessorConflict = (
  resourceType: string,
  resourceId: string,
  expected: string,
  actual: string,
): DomainError =>
  new DomainError("PREDECESSOR_CONFLICT", "the expected predecessor is no longer current", false, {
    resource_type: resourceType,
    resource_id: resourceId,
    expected_predecessor_id: expected,
    actual_predecessor_id: actual,
  });

export const stateConflict = (resourceType: string, resourceId: string, reason: string): DomainError =>
  new DomainError("STATE_CONFLICT", "resource state does not permit this operation", false, {
    resource_type: resourceType,
    resource_id: resourceId,
    reason: bounded(reason, 4096),
  });

export const versionConflict = (resourceType: string, resourceId: string, expected: number, actual: number): DomainError =>
  new DomainError("VERSION_CONFLICT", "resource version is no longer current", false, {
    resource_type: resourceType,
    resource_id: resourceId,
    expected_version: expected,
    actual_version: actual,
  });

export const idempotencyConflict = (command: string, requestHash: string, existingRequestHash: string): DomainError =>
  new DomainError("IDEMPOTENCY_CONFLICT", "operation ID was already used for a different request", false, {
    existing_command: command,
    request_hash: requestHash,
    existing_request_hash: existingRequestHash,
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

export const repositoryNotResolved = (reason: string): DomainError =>
  new DomainError("REPOSITORY_NOT_RESOLVED", "repository could not be resolved", false, { reason: bounded(reason, 4096) });

export const repositoryAmbiguous = (reason: string): DomainError =>
  new DomainError("REPOSITORY_AMBIGUOUS", "repository resolution is ambiguous", false, { reason: bounded(reason, 4096) });

export const baselineUnavailable = (reason: string): DomainError =>
  new DomainError("BASELINE_UNAVAILABLE", "baseline is unavailable", false, { reason: bounded(reason, 4096) });

export const repositoryIssueLimit = (requirementId: string, reason: string): DomainError =>
  new DomainError("REPOSITORY_ISSUE_LIMIT", "one Requirement may have only one Issue per Repository", false, {
    resource_type: "requirement",
    resource_id: requirementId,
    reason: bounded(reason, 4096),
  });

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
