import { RequestConflict, StorageFailure } from "../ports/index.js";
import type { Rejection } from "../domain/index.js";

/** What a caller can do something about. Anything else is a bug or damaged data and is thrown. */
export type FailureCode = "invalid" | "conflict" | "forbidden" | "unsupported" | "not-found" | "stale" | "request-conflict" | "unavailable";
export interface Failure { readonly code: FailureCode; readonly message: string }
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Failure };

export const succeed = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const fail = (code: FailureCode, message: string): { ok: false; error: Failure } => ({ ok: false, error: { code, message } });
export const fromRejection = (rejection: Rejection): { ok: false; error: Failure } => fail(rejection.code, rejection.message);

/** The failure a thrown storage error stands for, or undefined when it is not one the caller can act on. */
export function failureOf(error: unknown): Failure | undefined {
  if (error instanceof RequestConflict) return { code: "request-conflict", message: error.message };
  if (error instanceof StorageFailure) {
    if (error.reason === "stale") return { code: "stale", message: error.message };
    if (error.reason === "duplicate") return { code: "conflict", message: error.message };
    if (error.reason === "missing") return { code: "not-found", message: error.message };
  }
  return undefined;
}
