import { createHash } from "node:crypto";

// RFC 8785 sorts object member names by UTF-16 code units. JavaScript's
// relational string comparison has the same ordering for valid Unicode
// strings, so the comparator deliberately does not use localeCompare.
const compareKeys = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const numberToJCS = (value: number): string => {
  if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot encode non-finite numbers");
  // RFC 8785 deliberately adopts ECMAScript's Number::toString algorithm.
  // JSON.stringify is the host implementation of that algorithm and also
  // emits the JCS decimal/exponent thresholds (including `0` for -0).
  return JSON.stringify(value);
};

const assertValidUnicode = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("canonical JSON cannot encode a lone UTF-16 surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("canonical JSON cannot encode a lone UTF-16 surrogate");
    }
  }
};

const encodeString = (value: string): string => {
  assertValidUnicode(value);
  return JSON.stringify(value);
};

const encode = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return numberToJCS(value);
  if (typeof value === "bigint") throw new TypeError("canonical JSON cannot encode bigint values");
  if (Array.isArray(value)) return `[${value.map((item) => encode(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareKeys);
    return `{${keys.map((key) => `${encodeString(key)}:${encode(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
};

export const canonicalStringify = (value: unknown): string => encode(value);
export const canonicalBytes = (value: unknown): Buffer => Buffer.from(canonicalStringify(value), "utf8");
export const sha256 = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalBytes(value)).digest("hex")}`;
export const sha256Bytes = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
