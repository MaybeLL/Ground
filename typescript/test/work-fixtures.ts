import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import type { Decision, Hasher, Id, Result, Timestamp } from "../src/work/domain/index.js";

export const hash: Hasher = text => createHash("sha256").update(text).digest("hex");

/** Deterministic identifiers: `ids("run")` yields run-1, run-2, ... */
export function ids(prefix: string): () => Id {
  let count = 0;
  return () => `${prefix}-${++count}`;
}

/** Timestamps that advance one second per call from a fixed origin. */
export function clock(): () => Timestamp {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)).toISOString();
}

export function accept<S, E, O>(result: Result<Decision<S, E, O>>): Decision<S, E, O> {
  assert.ok(result.ok, result.ok ? "" : `unexpected rejection: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

export function rejected<T>(result: Result<T>, code?: string, pattern?: RegExp): void {
  assert.ok(!result.ok, "expected a rejection");
  if (!result.ok) {
    if (code) assert.equal(result.error.code, code, result.error.message);
    if (pattern) assert.match(result.error.message, pattern);
  }
}

/** Seeded pseudo-random numbers for property-style tests (mulberry32). */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
