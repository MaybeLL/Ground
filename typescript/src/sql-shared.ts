import { GIT_CANDIDATE_ARTIFACT_FORMAT, validateGitArtifactCandidateBinding } from "./git-artifact-storage.js";
// Shared plumbing for the store implementation: row decoding, integrity
// validation and driver-error classification.  Both the schema/migration code
// and the business transaction code use these, so they live on their own
// rather than inside either one.
//
// Everything below is moved verbatim from sql-store.ts; behaviour is unchanged.

import { inflateSync } from "node:zlib";
import type { SqlDialect } from "./sql-dialect.js";
import type { SQLClient } from "./sql-client.js";
import { isGitOID, isSha256, isUUIDv7 } from "./identity.js";
import { sha256, sha256Bytes } from "./canonical-json.js";
import { DomainError, idempotencyConflict, notFound, storageTransient, validation } from "./errors.js";
import { evidenceDigest } from "./domain.js";
import { qualityOverallVerdict } from "./quality-review.js";
import {
  CANDIDATE_ARTIFACT_FORMAT,
  validateAttribution,
} from "./domain.js";
import type {
  Attribution,
  Candidate,
  CandidateArtifact,
  CandidateFile,
  CandidateSubmissionInput,
  EvidenceInput,
  IssueRevision,
  VerificationReportInput,
} from "./domain.js";
import type { VerificationRecord, VerificationSummaryItem } from "./store-types.js";

export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const asText = (value: unknown): string => value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value ?? "");
export const asOptionalText = (value: unknown): string | undefined => value === null || value === undefined ? undefined : asText(value);
export const asBuffer = (value: unknown): Buffer => Buffer.isBuffer(value) ? value : Buffer.from(value instanceof Uint8Array ? value : String(value ?? ""));
// mysql2 normally returns BINARY(32) values as Buffers.  Keep the adapter
// tolerant of drivers/test doubles that expose a canonical hexadecimal
// string, while still treating every other representation as raw bytes so a
// malformed digest cannot be silently accepted.
export const asDigestBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  return Buffer.from(String(value ?? ""));
};
export const json = (value: unknown): string => JSON.stringify(value);
export const parseJSON = <T>(value: unknown): T => JSON.parse(asText(value)) as T;
export const nullable = (value: string | undefined): string | null => value === undefined ? null : value;
export const timestamp = (value: string): string => value;

export const errorCode = (error: unknown): string => error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
export const errorNumber = (error: unknown): number => {
  if (!error || typeof error !== "object") return 0;
  if ("errno" in error) return Number((error as { errno?: unknown }).errno ?? 0);
  if ("errcode" in error) return Number((error as { errcode?: unknown }).errcode ?? 0);
  return 0;
};
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const validResourceId = (value: unknown): string | undefined => isUUIDv7(value) ? value : undefined;

export const isDuplicateKeyError = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "ER_DUP_ENTRY" || code === "23505" || errorNumber(error) === 1062 || code.startsWith("SQLITE_CONSTRAINT") || /UNIQUE constraint failed/i.test(errorMessage(error));
};

export const isMissingTableError = (error: unknown): boolean => {
  const code = errorCode(error);
  const errno = errorNumber(error);
  const message = errorMessage(error);
  return code === "ER_NO_SUCH_TABLE" || code === "42P01" || errno === 1146 || /no such table|unknown table|doesn't exist|relation .* does not exist/i.test(message);
};

export const isSchemaShapeError = (error: unknown): boolean => {
  const code = errorCode(error);
  const errno = errorNumber(error);
  const message = errorMessage(error);
  return isMissingTableError(error)
    || code === "ER_BAD_FIELD_ERROR"
    || code === "42703"
    || errno === 1054
    || /no such column|unknown column|column .* does not exist|table .* has no column named/i.test(message);
};

/** Failures that mean "could not reach the server", independent of engine. */
const unreachableCodes = ["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"];

export const isSafeTransactionRetry = (error: unknown, dialect: SqlDialect): boolean => {
  if (error instanceof DomainError) return error.code === "STORAGE_TRANSIENT" && error.retryable;
  return dialect.retryableErrorCodes.includes(errorCode(error)) || dialect.retryableErrnos.includes(errorNumber(error));
};

export const retryDelay = async (attempt: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));

export const mapStorageError = (error: unknown, dialect: SqlDialect): unknown => {
  if (error instanceof DomainError) return error;
  if (isSafeTransactionRetry(error, dialect) || unreachableCodes.includes(errorCode(error))) {
    return storageTransient(errorMessage(error), 250);
  }
  return error;
};

export const requireRow = <T>(row: T | undefined, resourceType: string, resourceId: string): T => {
  if (!row) throw notFound(resourceType, resourceId);
  return row;
};

export const parseAttribution = (value: unknown): Attribution => {
  try {
    const parsed = parseJSON<unknown>(value);
    validateAttribution(parsed as Attribution);
    return parsed as Attribution;
  } catch (error) {
    const reason = error instanceof DomainError
      ? String(error.details.reason ?? error.message)
      : error instanceof Error ? error.message : String(error);
    const boundedReason = [...reason].length > 4096 ? `${[...reason].slice(0, 4095).join("")}…` : reason;
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored attribution is invalid", false, { reason: boundedReason });
  }
};
export const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};
export const storedLedgerFacts = (value: unknown, eventId: string): { name: string; value: string }[] => {
  let raw: unknown;
  const resourceId = validResourceId(eventId);
  try { raw = parseJSON<unknown>(value); } catch { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored ledger facts are invalid", false, { ...(resourceId ? { resource_id: resourceId } : {}), reason: "facts_json is not valid JSON" }); }
  const invalid = (reason: string): never => { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored ledger facts are invalid", false, { ...(resourceId ? { resource_id: resourceId } : {}), reason }); };
  const facts: { name: string; value: string }[] = [];
  const names = new Set<string>();
  if (Array.isArray(raw)) {
    if (raw.length > 100) invalid("facts contains more than 100 entries");
    raw.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid(`facts[${index}] must be an object`);
      const record = entry as Record<string, unknown>;
      if (Object.keys(record).some((key) => key !== "name" && key !== "value") || !("name" in record) || !("value" in record)) invalid(`facts[${index}] must contain only name and value`);
      const name = record.name;
      const factValue = record.value;
      if (typeof name !== "string" || hasLoneSurrogate(name) || [...name].length < 1 || [...name].length > 256) invalid(`facts[${index}].name is invalid`);
      if (typeof factValue !== "string" || hasLoneSurrogate(factValue) || [...factValue].length > 4096) invalid(`facts[${index}].value is invalid`);
      const validName = name as string;
      const validValue = factValue as string;
      if (names.has(validName)) invalid(`facts[${index}].name is duplicated`);
      names.add(validName);
      facts.push({ name: validName, value: validValue });
    });
  } else if (raw && typeof raw === "object") {
    const entries = Object.entries(raw);
    if (entries.length > 100) invalid("facts contains more than 100 entries");
    entries.forEach(([name, factValue]) => {
      if (hasLoneSurrogate(name) || [...name].length < 1 || [...name].length > 256) invalid("facts.name is invalid");
      if (typeof factValue !== "string" || hasLoneSurrogate(factValue) || [...factValue].length > 4096) invalid(`facts.${name} is invalid`);
      facts.push({ name, value: factValue as string });
    });
  } else invalid("facts must be an object or array");
  facts.sort((left, right) => compareText(left.name, right.name));
  return facts;
};
export const parseDate = (value: unknown): string => {
  let raw = asText(value);
  // SQLite legacy rows use a space separator and MySQL dateStrings omit the
  // UTC suffix.  Accept those two storage forms, but reject everything else
  // instead of allowing corrupted timestamps to leak into cursors and
  // deterministic ordering.
  if (raw.includes(" ")) raw = raw.replace(" ", "T");
  if (!raw.endsWith("Z")) raw += "Z";
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.([0-9]{1,9}))?Z$/.exec(raw);
  if (!match) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored timestamp is invalid", false, { reason: "database timestamp is not RFC3339Nano" });
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== match[1]) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored timestamp is invalid", false, { reason: "database timestamp is not RFC3339Nano" });
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return `${match[1]}${fraction ? `.${fraction}` : ""}Z`;
};

export const safeInteger = (value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
  let number: number;
  if (typeof value === "number") number = value;
  else if (typeof value === "bigint") number = Number(value);
  else if (typeof value === "string" && /^[+-]?\d+$/.test(value)) number = Number(value);
  else throw new DomainError("ARTIFACT_INTEGRITY_ERROR", `${field} is not an integer`, false, { field });
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", `${field} is outside the safe integer range`, false, { field });
  return number;
};

export const storedEvidence = (row: Record<string, unknown>, resourceType: string, resourceId: string): EvidenceInput => {
  const command = asText(row.command);
  const exit_code = safeInteger(row.exit_code, "exit_code", -2_147_483_648, 2_147_483_647);
  const output = row.output === null || row.output === undefined ? undefined : asText(row.output);
  let evidence: EvidenceInput;
  if (command.startsWith("@patchledger-evidence:")) {
    try { evidence = JSON.parse(output ?? "") as EvidenceInput; } catch { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored typed evidence is not valid JSON", false, { resource_type: resourceType, ...(validResourceId(resourceId) ? { resource_id: resourceId } : {}) }); }
  } else evidence = { type: "command", command, exit_code, ...(output === undefined ? {} : { output }) };
  const storedDigest = asText(row.output_digest);
  const legacyDigest = evidence.type === "command" ? sha256({ command: evidence.command, exit_code: evidence.exit_code, output: evidence.output === undefined ? null : evidence.output }) : "";
  if (storedDigest !== evidenceDigest(evidence) && storedDigest !== legacyDigest) {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored evidence digest does not match evidence facts", false, { resource_type: resourceType, ...(validResourceId(resourceId) ? { resource_id: resourceId } : {}) });
  }
  return evidence;
};

export const evidenceColumns = (evidence: EvidenceInput): [string, number, string | null, string] => evidence.type === "command" && !evidence.command.startsWith("@patchledger-evidence:")
  ? [evidence.command, evidence.exit_code, evidence.output ?? null, evidenceDigest(evidence)]
  : [`@patchledger-evidence:${evidence.type}`, 0, JSON.stringify(evidence), evidenceDigest(evidence)];


export const verificationModeProjection = (record: VerificationRecord): Pick<VerificationSummaryItem, "mode" | "quality"> =>
  record.quality ? { mode: "ultra", quality: { verdict: qualityOverallVerdict(record.quality.report), attribution: record.quality.attribution } } : { mode: "normal" };

/** Cheap mode projection for directory pages that do not load full reports. */
export const directoryModeProjection = (row: Record<string, unknown>): Pick<VerificationSummaryItem, "mode" | "quality"> => {
  if (row.quality_verdict == null) return { mode: "normal" };
  const verdict = asText(row.quality_verdict);
  if (!["qualified", "rejected", "inconclusive"].includes(verdict)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "invalid Verification directory entry");
  return { mode: "ultra", quality: { verdict: verdict as "qualified" | "rejected" | "inconclusive", attribution: parseAttribution(row.quality_attribution_json) } };
};

export const nullableBuffer = (value: Buffer | undefined): Buffer | null => value ?? null;

export const decodeArtifactChunks = (chunks: Buffer[], expectedSize: number, digest: string): Buffer => {
  const size = safeInteger(expectedSize, "uncompressed_size");
  if (size > 32 * 1024 * 1024) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "artifact uncompressed size is invalid");
  if (chunks.length < 1 || chunks.some((chunk) => chunk.length < 1 || chunk.length > 1024 * 1024)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "artifact chunk must contain between 1 byte and 1 MiB");
  let decoded: Buffer;
  try { decoded = inflateSync(Buffer.concat(chunks), { maxOutputLength: size + 1 }); } catch { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "artifact zlib stream is invalid"); }
  if (decoded.length !== size || sha256Bytes(decoded) !== digest) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "artifact digest does not match metadata");
  return decoded;
};

export const persistedArtifactError = (reason: string, resourceId?: string): never => {
  throw new DomainError("ARTIFACT_INTEGRITY_ERROR", reason, false, { ...(validResourceId(resourceId) ? { resource_id: resourceId } : {}) });
};

export const persistedRecordError = (resourceType: string, resourceId: string, message: string, error: unknown): never => {
  if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") throw error;
  const reason = error instanceof DomainError
    ? String(error.details.reason ?? error.message)
    : error instanceof Error ? error.message : String(error);
  const boundedReason = [...reason].length > 4096 ? `${[...reason].slice(0, 4095).join("")}…` : reason;
  throw new DomainError("ARTIFACT_INTEGRITY_ERROR", message, false, { resource_type: resourceType, ...(validResourceId(resourceId) ? { resource_id: resourceId } : {}), reason: boundedReason });
};

export const persistedVerificationError = (resourceId: string, error: unknown): never => {
  return persistedRecordError("verification", resourceId, "stored Verification report is invalid", error);
};

export interface StoredOperationRow {
  [key: string]: unknown;
  command: unknown;
  request_hash: unknown;
  result_json: unknown;
  status: unknown;
}

export const storedOperation = (row: StoredOperationRow, operationId: string): { command: string; request_hash: string; result_json: unknown; status: string } => {
  const command = asText(row.command);
  const requestHash = asText(row.request_hash);
  const status = asText(row.status);
  if (!command || [...command].length > 256 || hasLoneSurrogate(command) || !isSha256(requestHash) || (status !== "pending" && status !== "completed")) {
    persistedArtifactError("stored idempotency record is invalid", operationId);
  }
  return { command, request_hash: requestHash, result_json: row.result_json, status };
};

export const validateContiguousOrdinals = (ordinals: unknown[], field: string, resourceId: string): void => {
  for (const [index, ordinal] of ordinals.entries()) {
    if (safeInteger(ordinal, field) !== index) persistedArtifactError(`${field} values are not contiguous`, resourceId);
  }
};

export const decodePersistedPath = (value: string, field: string, resourceId: string): Buffer => {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) persistedArtifactError(`${field} is not canonical base64`, resourceId);
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.toString("base64") !== value || decoded.includes(0)) persistedArtifactError(`${field} is not a valid Git path`, resourceId);
  if (decoded.length > 1024) persistedArtifactError(`${field} exceeds 1,024 bytes`, resourceId);
  return decoded;
};

export const validatePersistedCandidateFiles = (files: CandidateFile[], resourceId: string, ordinals: unknown[] = files.map((_file, index) => index)): void => {
  if (files.length > 100_000) persistedArtifactError("Candidate file manifest exceeds 100,000 entries", resourceId);
  let previousPath: Buffer | undefined;
  for (const [index, file] of files.entries()) {
    if (safeInteger(ordinals[index], "candidate_file.ordinal") !== index) persistedArtifactError("Candidate file ordinals are not contiguous", resourceId);
    const path = decodePersistedPath(file.path_bytes, `candidate.files[${index}].path_bytes`, resourceId);
    if (previousPath && Buffer.compare(previousPath, path) >= 0) persistedArtifactError("Candidate file manifest is not strictly sorted by raw path bytes", resourceId);
    previousPath = path;
    if (hasLoneSurrogate(file.display_path) || [...file.display_path].length < 1 || [...file.display_path].length > 4096 || Buffer.byteLength(file.display_path, "utf8") > 4096) persistedArtifactError("Candidate display path is invalid", resourceId);
    if (!["added", "modified", "deleted", "renamed", "copied", "type_changed"].includes(file.change)) persistedArtifactError("Candidate file change kind is invalid", resourceId);
    if (file.old_path_bytes !== undefined) decodePersistedPath(file.old_path_bytes, `candidate.files[${index}].old_path_bytes`, resourceId);
    if ((file.change === "renamed" || file.change === "copied") && file.old_path_bytes === undefined) persistedArtifactError("renamed or copied Candidate file is missing old_path_bytes", resourceId);
    if (file.old_mode !== undefined && !/^[0-7]{6}$/.test(file.old_mode)) persistedArtifactError("Candidate old file mode is invalid", resourceId);
    if (file.new_mode !== undefined && !/^[0-7]{6}$/.test(file.new_mode)) persistedArtifactError("Candidate new file mode is invalid", resourceId);
    if (file.change === "deleted" && file.old_mode === undefined) persistedArtifactError("deleted Candidate file is missing old_mode", resourceId);
    if (file.change !== "deleted" && file.new_mode === undefined) persistedArtifactError("non-deleted Candidate file is missing new_mode", resourceId);
  }
};

export const validatePersistedCandidateArtifact = (candidate: Candidate, artifact: CandidateArtifact, patch: Buffer): void => {
  if (candidate.artifact_format === GIT_CANDIDATE_ARTIFACT_FORMAT) {
    if (!candidate.git_artifact) persistedArtifactError("Candidate Git artifact metadata is missing", candidate.id);
    validateGitArtifactCandidateBinding(candidate.git_artifact!, candidate);
  } else if (candidate.artifact_format !== CANDIDATE_ARTIFACT_FORMAT) persistedArtifactError("Candidate artifact format is invalid", candidate.id);
  else if (candidate.git_artifact) validateGitArtifactCandidateBinding(candidate.git_artifact, candidate);
  if (!isSha256(candidate.patch_digest) || !isSha256(artifact.patch_digest) || candidate.patch_digest !== artifact.patch_digest) persistedArtifactError("Candidate patch digest is invalid", candidate.id);
  if (!isGitOID(candidate.result_tree_oid) || candidate.result_tree_oid !== artifact.result_tree_oid) persistedArtifactError("Candidate result tree OID is invalid", candidate.id);
  if (!isSha256(candidate.blind_context_digest)) persistedArtifactError("Candidate blind context digest is invalid", candidate.id);
  if (patch.length > 32 * 1024 * 1024 || sha256Bytes(patch) !== candidate.patch_digest) persistedArtifactError("Candidate patch does not match its digest", candidate.id);
  if (safeInteger(artifact.uncompressed_size, "candidate.uncompressed_size") !== patch.length) persistedArtifactError("Candidate patch size does not match its artifact metadata", candidate.id);
  validatePersistedCandidateFiles(artifact.files, candidate.id);
};

export const validatePersistedVerificationCoverage = (report: VerificationReportInput, issueRevision: IssueRevision, resourceId: string): void => {
  const expected = new Set<string>();
  for (const target of issueRevision.goals) for (const criterion of target.criteria) expected.add("goal:" + target.id + ":" + criterion.id);
  for (const target of issueRevision.constraints) for (const criterion of target.criteria) expected.add("constraint:" + target.id + ":" + criterion.id);
  const actual = new Set<string>();
  for (const target of report.assessments) {
    for (const criterion of target.criteria) actual.add(target.target_type + ":" + target.target_id + ":" + criterion.criterion_id);
  }
  if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
    persistedArtifactError("Verification does not cover every sealed Criterion", resourceId);
  }
};

export const validatePersistedCandidateCoverage = (submission: CandidateSubmissionInput, issueRevision: IssueRevision, resourceId: string): void => {
  const expected = new Map<string, Set<string>>();
  for (const target of issueRevision.goals) expected.set(`goal:${target.id}`, new Set(target.criteria.map((criterion) => criterion.id)));
  for (const target of issueRevision.constraints) expected.set(`constraint:${target.id}`, new Set(target.criteria.map((criterion) => criterion.id)));
  const seen = new Set<string>();
  for (const claim of submission.claims) {
    const key = `${claim.target_type}:${claim.target_id}`;
    const criteria = expected.get(key);
    if (!criteria) { persistedArtifactError("Candidate claims contain an unknown target", resourceId); return; }
    if (seen.has(key)) { persistedArtifactError("Candidate claims contain a duplicated target", resourceId); return; }
    seen.add(key);
    const actual = new Set(claim.criteria.map((criterion) => criterion.criterion_id));
    if (actual.size !== criteria.size || [...criteria].some((id) => !actual.has(id))) persistedArtifactError("Candidate claims do not cover every sealed Criterion", resourceId);
  }
  if (seen.size !== expected.size) persistedArtifactError("Candidate claims do not cover every sealed target", resourceId);
};

export const standingFromCounts = (total: number, qualified: number, rejected: number): string => {
  if (total === 0) return "unverified";
  if (qualified > 0 && rejected > 0) return "disputed";
  if (qualified > 0) return "qualified";
  if (rejected > 0) return "rejected";
  return "inconclusive";
};

export const compareVersions = (left: string, right: string): number => {
  const parse = (value: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
    return match ? match.slice(1).map(Number) : undefined;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
};

/**
 * Run a statement whose failure the caller handles and continues from.  Where a failed statement
 * aborts the transaction (PostgreSQL) it is isolated in a savepoint, so the caller's follow-up
 * statements still run; elsewhere nothing is needed.
 */
export const isolateStatement = async <T>(client: SQLClient, statement: () => Promise<T>): Promise<T> => {
  if (!client.dialect.errorAbortsTransaction) return statement();
  await client.exec("SAVEPOINT recoverable_statement");
  try {
    const value = await statement();
    await client.exec("RELEASE SAVEPOINT recoverable_statement");
    return value;
  } catch (error) {
    await client.exec("ROLLBACK TO SAVEPOINT recoverable_statement");
    await client.exec("RELEASE SAVEPOINT recoverable_statement");
    throw error;
  }
};
