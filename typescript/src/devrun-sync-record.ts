import { isGitOID, isUUIDv7 } from "./identity.js";
import { validation } from "./errors.js";
import type { Attribution } from "./domain.js";
import { validateAttribution } from "./domain.js";
import type { RuntimeRecord } from "./runtime-record.js";

/** A durable reservation; absence of a terminal receipt MUST keep the run blocked. */
export interface DevRunSync {
  format: "grounds.devrun-sync/v1";
  dev_run_id: string;
  source_head?: string;
  original_base: string;
  target: string;
  run_version: number;
  phase: "reserved" | "prepared" | "applying" | "resolving" | "completing" | "abandoning" | "completed" | "abandoned";
  created_at: string;
  attribution: Attribution;
  recovery: { host_id: string; directory: string };
  material_digest?: string;
  conflicts?: string[];
  decisions?: { path: string; explanation: string }[];
  /** Final local receipt includes HEAD/index/raw manifest; not merely a Git-normalized patch. */
  receipt_digest?: string;
  finished_at?: string;
  finished_by?: Attribution;
}
export interface SyncReview {
  id: string;
  original_base: string;
  target: string;
  outcome: "completed" | "abandoned";
  conflicts: string[];
  decisions: { path: string; explanation: string }[];
  created_at: string;
  finished_at: string;
  started_by: Attribution;
  finished_by: Attribution;
}
export function syncReview(row: RuntimeRecord): SyncReview {
  const data = syncData(row);
  if (!syncTerminal(data)) throw validation("sync", "a Candidate cannot refer to an unfinished sync");
  return { id: row.id, original_base: data.original_base, target: data.target, outcome: data.phase as "completed" | "abandoned", conflicts: data.conflicts ?? [], decisions: data.decisions ?? [], created_at: data.created_at, finished_at: data.finished_at!, started_by: data.attribution, finished_by: data.finished_by ?? data.attribution };
}
export const SYNC_FORMAT = "grounds.devrun-sync/v1";
export function isSyncRecord(row: RuntimeRecord): boolean {
  return row.kind === "runtime_operation" && row.data.format === SYNC_FORMAT;
}
export const syncTerminal = (sync: DevRunSync): boolean => ["completed", "abandoned"].includes(sync.phase);
export function syncData(row: RuntimeRecord): DevRunSync {
  const value = row.data as unknown as DevRunSync;
  const text = (s: unknown, max: number): s is string => typeof s === "string" && s.length > 0 && s.length <= max && !s.includes("\0");
  const digest = (s: unknown): boolean => typeof s === "string" && /^sha256:[a-f0-9]{64}$/.test(s);
  const time = (s: unknown): boolean => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));
  const path = (s: unknown): s is string => text(s, 4096) && !s.startsWith("/") && !s.split("/").some(p => !p || p === "." || p === ".." || [".git", ".grounds"].includes(p.toLowerCase()));
  if (!isSyncRecord(row) || !isUUIDv7(value.dev_run_id) || value.dev_run_id !== row.parent_id || !isGitOID(value.original_base) || !isGitOID(value.target) || value.original_base === value.target
    || !Number.isSafeInteger(value.run_version) || value.run_version < 2 || !time(value.created_at)
    || !["reserved", "prepared", "applying", "resolving", "completing", "abandoning", "completed", "abandoned"].includes(value.phase)
    || !value.recovery || !text(value.recovery.host_id, 512) || !text(value.recovery.directory, 4096)
    || (value.source_head !== undefined && !isGitOID(value.source_head))
    || (value.material_digest !== undefined && !digest(value.material_digest))
    || (value.receipt_digest !== undefined && !digest(value.receipt_digest))
    || (value.conflicts !== undefined && (!Array.isArray(value.conflicts) || value.conflicts.length > 10000 || !value.conflicts.every(path) || new Set(value.conflicts).size !== value.conflicts.length))
    || (value.decisions !== undefined && (!Array.isArray(value.decisions) || !value.decisions.every(d => d && path(d.path) && text(d.explanation, 4096) && value.conflicts?.includes(d.path)) || new Set(value.decisions.map(d => d.path)).size !== value.decisions.length))
    || (value.finished_at !== undefined && !time(value.finished_at))) throw validation("sync", "invalid persisted sync identity or recovery state");
  validateAttribution(value.attribution);
  if (value.finished_by) validateAttribution(value.finished_by);
  if (["prepared", "applying", "resolving", "completing", "completed"].includes(value.phase) && (!value.material_digest || !value.conflicts)) throw validation("sync", "prepared sync requires recovery material and conflict paths");
  if (syncTerminal(value) !== Boolean(value.finished_at && value.receipt_digest)) throw validation("sync", "terminal sync requires an exact local receipt and timestamp");
  if (value.phase === "completed" && value.conflicts!.some(p => !value.decisions?.some(d => d.path === p))) throw validation("sync", "every conflict requires a retained decision, including zero-diff resolutions");
  return value;
}
