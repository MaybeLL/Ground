// Shared plumbing for the store implementation: row decoding, integrity
// validation and driver-error classification.  Both the schema/migration code
// and the business transaction code use these, so they live on their own
// rather than inside either one.
//
// Everything below is moved verbatim from sql-store.ts; behaviour is unchanged.

import type { SqlDialect } from "./sql-dialect.js";
import type { SQLClient } from "./sql-client.js";
import { DomainError, storageTransient } from "./errors.js";

export const asText = (value: unknown): string => value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value ?? "");

export const errorCode = (error: unknown): string => error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
export const errorNumber = (error: unknown): number => {
  if (!error || typeof error !== "object") return 0;
  if ("errno" in error) return Number((error as { errno?: unknown }).errno ?? 0);
  if ("errcode" in error) return Number((error as { errcode?: unknown }).errcode ?? 0);
  return 0;
};
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

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

export const safeInteger = (value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
  let number: number;
  if (typeof value === "number") number = value;
  else if (typeof value === "bigint") number = Number(value);
  else if (typeof value === "string" && /^[+-]?\d+$/.test(value)) number = Number(value);
  else throw new DomainError("ARTIFACT_INTEGRITY_ERROR", `${field} is not an integer`, false, { field });
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", `${field} is outside the safe integer range`, false, { field });
  return number;
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
