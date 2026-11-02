// Shared kernel of the work domain: identifiers, results, decisions and the
// canonical form used for content digests. Pure; no I/O and no other layer.

export type Id = string;
/** ISO-8601 UTC timestamp supplied by the caller; the domain never reads a clock. */
export type Timestamp = string;
export type Digest = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type RejectionCode =
  | "invalid"      // the command itself is malformed
  | "conflict"     // the aggregate is in a state that forbids it, or a version/expectation mismatched
  | "forbidden"    // the caller is not the party allowed to do this
  | "unsupported"; // a required capability is not declared
export interface Rejection { readonly code: RejectionCode; readonly message: string }
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Rejection };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const reject = (code: RejectionCode, message: string): { ok: false; error: Rejection } => ({ ok: false, error: { code, message } });
export const invalid = (message: string) => reject("invalid", message);
export const conflict = (message: string) => reject("conflict", message);

/** The new state, the facts it produced and a command-specific outcome. */
export interface Decision<S, E, O = void> { readonly state: S; readonly events: readonly E[]; readonly outcome: O }

/** Aggregates carry a version; a decision that changes anything advances it by one. */
export interface Versioned { readonly version: number }

/** Apply `changes` and advance the version when something happened; otherwise return `state` untouched. */
export function advance<S extends Versioned, E, O>(state: S, changes: Partial<S>, events: readonly E[], outcome: O): Result<Decision<S, E, O>> {
  const next = events.length === 0 ? state : { ...state, ...changes, version: state.version + 1 };
  return ok({ state: next, events, outcome });
}

const controlCharacters = /[\u0000-\u001f\u007f]/;
export const isId = (value: unknown): value is Id => typeof value === "string" && value.length >= 1 && value.length <= 128 && !controlCharacters.test(value);
export const isText = (value: unknown, maximum = 4096): value is string => typeof value === "string" && value.length >= 1 && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
export const isTimestamp = (value: unknown): value is Timestamp => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
export const isDigest = (value: unknown): value is Digest => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
export const isNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** First failed field check, or undefined when every field is acceptable. */
export function firstInvalid(checks: ReadonlyArray<readonly [name: string, passes: boolean]>): { ok: false; error: Rejection } | undefined {
  for (const [name, passes] of checks) if (!passes) return invalid(`${name} is missing or malformed`);
  return undefined;
}

/** Deterministic text for a JSON value: object keys sorted, no whitespace. Rejects values with no stable form. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("non-finite number has no canonical form");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => {
    const entry = value[key];
    if (entry === undefined) throw new TypeError(`undefined is not JSON (${key})`);
    return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
  }).join(",")}}`;
}

/** Supplies SHA-256 as 64 lowercase hex characters; injected so the domain stays free of I/O and Node. */
export type Hasher = (canonicalText: string) => string;

export function digestOf(value: JsonValue, hash: Hasher): Result<Digest> {
  let text: string;
  try { text = canonicalJson(value); } catch (error) { return invalid(`value has no canonical form: ${(error as Error).message}`); }
  const digest = `sha256:${hash(text)}`;
  return isDigest(digest) ? ok(digest) : invalid("hasher must return 64 lowercase hex characters");
}

export const unique = <T>(values: readonly T[], key: (value: T) => string = String): boolean => new Set(values.map(key)).size === values.length;
