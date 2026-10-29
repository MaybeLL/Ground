import { randomBytes } from "node:crypto";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const isUUIDv7 = (value: unknown): value is string => typeof value === "string" && UUID_V7.test(value);

export const newUUIDv7 = (now = Date.now()): string => {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Math.max(0, now));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const isSha256 = (value: unknown): value is string => typeof value === "string" && value.startsWith("sha256:") && SHA256.test(value.slice(7));

export const isGitOID = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator < 0) return false;
  const algorithm = value.slice(0, separator);
  const digest = value.slice(separator + 1);
  return (algorithm === "sha1" && SHA1.test(digest)) || (algorithm === "sha256" && SHA256.test(digest));
};

export const qualifiedOID = (algorithm: string, digest: string): string => {
  const valid = (algorithm === "sha1" && SHA1.test(digest)) || (algorithm === "sha256" && SHA256.test(digest));
  if (!valid) throw new Error("invalid Git object ID");
  return `${algorithm}:${digest}`;
};
