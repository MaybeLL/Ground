import { DomainError, validation } from "./errors.js";
import type { EvalListFilter, ReadTx, Store } from "./store-types.js";
import { idValue, type EvalKind, type EvalRecord } from "./evaluation.js";

// Lightweight, cursor-paged Eval listing.  The classic `eval KIND list` keeps
// returning complete latest records; `--view summary` (implied by paging
// options) returns bounded summaries that never inline Grader source, private
// QA material, answers or grading evidence — callers read those through the
// existing `show` commands.
export const EVAL_PAGE_DEFAULT = 100;
export const EVAL_PAGE_MAX = 1000;
const RESULT_LIMIT_BYTES = 8 * 1024 * 1024;
export const EVAL_LIST_SORT = "id:asc";

type FilterSource = { parent: true } | { path: string; enum?: readonly string[] };
// Exact-match filters by kind.  A kind without a relation simply has no such
// option: relations are never guessed from names or bodies.
const filterSpecs: Partial<Record<EvalKind, Record<string, FilterSource>>> = {
  grader: { issue: { path: "$.data.issue.id" }, qa: { path: "$.data.qa.id" } },
  envcheck: { environment: { parent: true } },
  preparation: { environment: { path: "$.data.environment.id" } },
  instance: { run: { parent: true }, preparation: { path: "$.data.preparation_id" } },
  experiment: { snapshot: { parent: true } },
  run: { experiment: { parent: true }, state: { path: "$.data.state", enum: ["open", "closed"] } },
};

export const evalFilterOptions = (kind: EvalKind): string[] => Object.keys(filterSpecs[kind] ?? {});

export const buildEvalFilter = (kind: EvalKind, request: Record<string, string>): { filter: EvalListFilter; bound: Record<string, string> } => {
  const spec = filterSpecs[kind] ?? {};
  const fields: NonNullable<EvalListFilter["fields"]> = []; let parent_id: string | undefined; const bound: Record<string, string> = {};
  for (const [name, value] of Object.entries(request)) {
    const source = spec[name];
    if (!source) throw validation(name, `is not a filter of ${kind} lists`);
    if ("parent" in source) parent_id = idValue(value);
    else if (source.enum) { if (!source.enum.includes(value)) throw validation(name, `must be one of: ${source.enum.join(", ")}`); fields.push({ path: source.path, value }); }
    else fields.push({ path: source.path, value: idValue(value) });
    bound[name] = value;
  }
  return { filter: { ...(parent_id === undefined ? {} : { parent_id }), ...(fields.length ? { fields } : {}) }, bound };
};

const preview = (value: string, max = 200): { text: string; truncated: boolean } => { const runes = [...value]; return { text: runes.slice(0, max).join(""), truncated: runes.length > max }; };

export interface EvalSummaryItem { id: string; kind: EvalKind; version: number; created_at: string; parent_id?: string; name?: string; summary: Record<string, unknown> }

/** Fixed, small projection per kind: identity, relations and state — no bodies. */
export const summarizeEvalRecord = (record: EvalRecord, runs?: { open: number; closed: number }): EvalSummaryItem => {
  const base = { id: record.id, kind: record.kind, version: record.version, created_at: record.created_at, ...(record.parent_id ? { parent_id: record.parent_id } : {}) };
  const data = record.data as any;
  switch (record.kind) {
    case "environment": return { ...base, name: data.name, summary: { task_kind: data.task_kind, role: data.role } };
    case "envcheck": return { ...base, summary: { environment: data.environment, checks: data.checks } };
    case "preparation": return { ...base, summary: { environment: data.environment, state: data.state, attempt: data.attempt } };
    case "instance": return { ...base, summary: { run_id: data.run_id, role: data.role, state: data.state, environment: data.environment, preparation_id: data.preparation_id, validity: data.validity } };
    case "qa": return { ...base, name: data.name, summary: { source_identity: data.source.identity } };
    case "grader": return { ...base, name: data.name, summary: { scope: data.scope.kind, definition_type: data.definition.type, result_kind: data.result_spec.kind, ...(data.issue ? { issue: data.issue } : {}), ...(data.qa ? { qa: data.qa } : {}) } };
    case "suite": return { ...base, name: data.name, summary: { task_count: data.tasks.length } };
    case "experiment": {
      const description = preview(data.subject.description);
      return { ...base, summary: { snapshot_id: data.snapshot_id, subject: { name: data.subject.name, description_preview: description.text, description_truncated: description.truncated }, runs: { total: (runs?.open ?? 0) + (runs?.closed ?? 0), open: runs?.open ?? 0, closed: runs?.closed ?? 0 } } };
    }
    case "run": return { ...base, summary: { experiment_id: data.experiment_id, mode: data.mode, state: data.state, task: { id: data.task.id, name: data.task.name }, ...(data.result_id ? { result_id: data.result_id } : {}) } };
    default: throw validation("kind", "has no list summary");
  }
};

interface CursorBinding { version: 1; resource: string; filters: Record<string, string>; sort: string; after: string; high_water: number }
const encode = (binding: CursorBinding): string => Buffer.from(JSON.stringify(binding), "utf8").toString("base64url");
const decode = (cursor: string, resource: string, filters: Record<string, string>): CursorBinding => {
  const invalid = (): never => { throw validation("cursor", `must be an unmodified ${resource} list cursor for the same filters`); };
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return invalid();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { return invalid(); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const binding = value as Partial<CursorBinding>;
  if (Object.keys(binding).sort().join(",") !== "after,filters,high_water,resource,sort,version" || binding.version !== 1 || binding.resource !== resource || binding.sort !== EVAL_LIST_SORT
    || JSON.stringify(binding.filters) !== JSON.stringify(filters) || !Number.isSafeInteger(binding.high_water) || (binding.high_water as number) < 0 || typeof binding.after !== "string" || !binding.after || binding.after.length > 128) return invalid();
  return binding as CursorBinding;
};

export interface EvalListRequest { limit?: number; cursor?: string }
export interface EvalListPage { result_type: "patchledger.result.eval-list/v1"; kind: EvalKind; items: EvalSummaryItem[]; page: { limit: number; has_more: boolean; sort: string }; next_cursor?: string }

export const readEvalSummaryPage = async (store: Store, kind: EvalKind, request: EvalListRequest, filter: EvalListFilter, bound: Record<string, string>, byteLimit = RESULT_LIMIT_BYTES): Promise<EvalListPage> => {
  const limit = request.limit ?? EVAL_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVAL_PAGE_MAX) throw validation("limit", `must be an integer between 1 and ${EVAL_PAGE_MAX}`);
  const resource = `eval_${kind}`;
  const cursor = request.cursor === undefined ? undefined : decode(request.cursor, resource, bound);
  return store.read(async (tx: ReadTx) => {
    // Every Eval write appends a ledger event; a moved high-water mark means the
    // collection may have changed under the cursor, so restart from page one.
    const highWater = await tx.ledgerHighWater();
    if (cursor && cursor.high_water !== highWater) throw new DomainError("LIST_CHANGED", `${resource} list changed since the first page; restart from the first page`, true, {});
    const page = await tx.listEvalRecordsPage(kind, filter, cursor?.after ?? "", limit);
    const counts = kind === "experiment" ? await tx.evalRunCounts(page.rows.map(row => row.id)) : {};
    const items = page.rows.map(row => summarizeEvalRecord(row, counts[row.id]));
    let more = page.more;
    const build = (): EvalListPage => ({ result_type: "patchledger.result.eval-list/v1", kind, items, page: { limit, has_more: more, sort: EVAL_LIST_SORT }, ...(more && items.length ? { next_cursor: encode({ version: 1, resource, filters: bound, sort: EVAL_LIST_SORT, after: items[items.length - 1].id, high_water: highWater }) } : {}) });
    let result = build();
    while (Buffer.byteLength(JSON.stringify(result), "utf8") > byteLimit && items.length > 1) { items.pop(); more = true; result = build(); }
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > byteLimit) throw new DomainError("ARTIFACT_TOO_LARGE", `${resource} list entry exceeds the 8 MiB result size`, false, { reason: `a single ${resource} list entry exceeds the 8 MiB result size` });
    return result;
  });
};
