import { DomainError, validation } from "./errors.js";
import type { ListPageKey, ReadTx, Resource, Store } from "./store-types.js";

// Cursor-paged global lists.  A page is requested explicitly (`limit` and/or
// `cursor`); an unpaged call keeps the published complete-list behaviour.  The
// cursor is opaque to callers and binds the resource kind, the exact filters,
// the ordering and the position, plus the ledger high-water mark observed by
// the first page.  Every business write appends a ledger event, so a changed
// mark means the collection may have moved and the reader must restart from
// the first page instead of risking a skipped or repeated item.
export const LIST_PAGE_DEFAULT = 100;
export const LIST_PAGE_MAX = 1000;
export const LIST_RESULT_LIMIT_BYTES = 8 * 1024 * 1024;

export interface ListPageRequest { limit?: number; cursor?: string }
export type ListPageAfter = string | ListPageKey;
export interface ListPageEntry { resource: Resource; after: ListPageAfter }
export interface ListPageLoaded { entries: ListPageEntry[]; more: boolean }
export interface ListPageInfo { limit: number; has_more: boolean; sort: string }
export interface ListPageResult { result_type: string; command: string; resources: Resource[]; page: ListPageInfo; next_cursor?: string; query?: Record<string, string | number | boolean> }

export const isPagedRequest = (request: ListPageRequest | undefined): request is ListPageRequest => request !== undefined && (request.limit !== undefined || request.cursor !== undefined);

interface CursorBinding { version: 2; resource: string; filters: Record<string, string | number | boolean | null>; sort: string; after: ListPageAfter; high_water: number }

const encodeCursor = (binding: CursorBinding): string => Buffer.from(JSON.stringify(binding), "utf8").toString("base64url");

const decodeCursor = (cursor: string, resource: string, filters: CursorBinding["filters"], sort: string): CursorBinding => {
  const invalid = (): never => { throw validation("cursor", `must be an unmodified ${resource} list cursor for the same filters and ordering`); };
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return invalid();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { return invalid(); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  // Version 1 time keys may have lost precision; they cannot be migrated safely.
  if ((value as { version?: unknown }).version === 1) throw validation("cursor", "list cursor version 1 is no longer supported; restart from the first page");
  const binding = value as Partial<CursorBinding>;
  if (Object.keys(binding).sort().join(",") !== "after,filters,high_water,resource,sort,version" || binding.version !== 2 || binding.resource !== resource || binding.sort !== sort
    || JSON.stringify(binding.filters) !== JSON.stringify(filters) || !Number.isSafeInteger(binding.high_water) || (binding.high_water as number) < 0) return invalid();
  const after = binding.after;
  const validAfter = typeof after === "string" ? after.length > 0 && after.length <= 128
    : after !== null && typeof after === "object" && Object.keys(after).sort().join(",") === "id,key" && typeof after.id === "string" && typeof after.key === "string" && after.id.length > 0 && after.id.length <= 128 && after.key.length > 0 && after.key.length <= 128;
  return validAfter ? binding as CursorBinding : invalid();
};

export const validatePageLimit = (limit: number | undefined): number => {
  const value = limit ?? LIST_PAGE_DEFAULT;
  if (!Number.isSafeInteger(value) || value < 1 || value > LIST_PAGE_MAX) throw validation("limit", `must be an integer between 1 and ${LIST_PAGE_MAX}`);
  return value;
};

export interface ListPageSpec {
  resource: string;
  command: string;
  filters: CursorBinding["filters"];
  /** Human/Agent-facing echo of the applied filters and ordering (not part of the cursor binding). */
  query?: Record<string, string | number | boolean>;
  sort: string;
  request: ListPageRequest;
  byteLimit?: number;
  load(tx: ReadTx, after: ListPageAfter | undefined, limit: number): Promise<ListPageLoaded>;
}

export const readListPage = async (store: Store, spec: ListPageSpec): Promise<ListPageResult> => {
  const limit = validatePageLimit(spec.request.limit);
  const cursor = spec.request.cursor === undefined ? undefined : decodeCursor(spec.request.cursor, spec.resource, spec.filters, spec.sort);
  const byteLimit = spec.byteLimit ?? LIST_RESULT_LIMIT_BYTES;
  return store.read(async (tx) => {
    const highWater = await tx.ledgerHighWater();
    if (cursor && cursor.high_water !== highWater) throw new DomainError("LIST_CHANGED", `${spec.resource} list changed since the first page; restart from the first page`, true, {});
    const loaded = await spec.load(tx, cursor?.after, limit);
    const entries = [...loaded.entries];
    let more = loaded.more;
    const build = (): ListPageResult => ({
      result_type: "patchledger.result.resource-list/v1", command: spec.command, resources: entries.map((entry) => entry.resource), page: { limit, has_more: more, sort: spec.sort }, ...(spec.query ? { query: spec.query } : {}),
      ...(more && entries.length ? { next_cursor: encodeCursor({ version: 2, resource: spec.resource, filters: spec.filters, sort: spec.sort, after: entries[entries.length - 1].after, high_water: highWater }) } : {}),
    });
    let result = build();
    // The page limit is a count, not a size guarantee: shrink this page until
    // it fits the public result size and let the cursor resume after the last
    // entry kept.  A single entry that still does not fit is a real error.
    while (Buffer.byteLength(JSON.stringify(result), "utf8") > byteLimit && entries.length > 1) { entries.pop(); more = true; result = build(); }
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > byteLimit) throw new DomainError("ARTIFACT_TOO_LARGE", `${spec.resource} list entry exceeds the 8 MiB result size`, false, { reason: `a single ${spec.resource} list entry exceeds the 8 MiB result size` });
    return result;
  });
};

// An unpaged list is still the complete collection.  When it outgrows the
// published bounds, point the caller at the paged form instead of a dead end.
export const withPagingHint = async <T>(resource: string, run: () => Promise<T>): Promise<T> => {
  try { return await run(); }
  catch (error) {
    if (error instanceof DomainError && error.code === "ARTIFACT_TOO_LARGE") {
      const reason = `${typeof error.details.reason === "string" ? `${error.details.reason}; ` : `${error.message}; `}read the ${resource} list in pages with --limit N (1-${LIST_PAGE_MAX}) and follow next_cursor via --cursor`;
      throw new DomainError("ARTIFACT_TOO_LARGE", error.message, false, { reason: reason.slice(0, 4096) });
    }
    throw error;
  }
};
