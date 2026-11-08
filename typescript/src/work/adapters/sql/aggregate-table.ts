import { createHash } from "node:crypto";
import { canonicalJson, type Id, type JsonValue, type Versioned } from "../../domain/index.js";
import { StorageFailure, type ReadOptions } from "../../ports/index.js";
import type { SQLClient } from "../../../sql-client.js";
import { errorCode, errorMessage, errorNumber, isDuplicateKeyError } from "../../../sql-shared.js";

type Cell = string | number | null;

export interface TableSpec<S> {
  readonly table: string;
  readonly kind: string;
  /** The columns, besides identity, version, digest and body, that the database must see. */
  columns(state: S): Record<string, Cell>;
  /** Invariants of the aggregate; a state that breaks them is neither stored nor trusted when read. */
  violations(state: S): string[];
  /** What goes into body_json. Defaults to the whole state. */
  body?(state: S): JsonValue;
  /** Rebuild the state from the stored body, for aggregates whose body is only part of the state. */
  restore?(body: Record<string, unknown>): S;
}

const MAXIMUM_BODY_BYTES = 8 * 1024 * 1024;
export const textOf = (value: unknown): string => String(value);
export const digestText = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
/** Drop undefined fields and fix the key order: the same state always yields the same text. */
export const canonicalBody = (value: unknown): string => canonicalJson(JSON.parse(JSON.stringify(value)) as JsonValue);

/** A row that refers to one that does not exist: MySQL 1452, PostgreSQL 23503, SQLite "FOREIGN KEY constraint failed". */
export const isForeignKeyError = (error: unknown): boolean =>
  errorCode(error) === "ER_NO_REFERENCED_ROW_2" || errorCode(error) === "23503" || errorNumber(error) === 1452 || errorNumber(error) === 787 || /FOREIGN KEY constraint failed/i.test(errorMessage(error));

export const asStorageFailure = (error: unknown, subject: string): unknown => {
  if (isForeignKeyError(error)) return new StorageFailure("missing", `${subject} refers to something that does not exist`, subject);
  return isDuplicateKeyError(error) ? new StorageFailure("duplicate", `a uniqueness rule already holds for ${subject}`, subject) : error;
};

/** Versioned storage of one aggregate in one table: optimistic writes, digest-checked reads. */
export class AggregateTable<S extends Versioned & { readonly id: Id }> {
  constructor(private readonly client: SQLClient, private readonly spec: TableSpec<S>, private readonly writable: boolean) {}

  private encode(state: S): { body: string; digest: string } {
    const problems = this.spec.violations(state);
    if (problems.length > 0) throw new StorageFailure("invalid", `${this.spec.kind} ${state.id} breaks its invariants: ${problems.join("; ")}`, state.id);
    const body = canonicalBody(this.spec.body ? this.spec.body(state) : state);
    if (Buffer.byteLength(body) > MAXIMUM_BODY_BYTES) throw new StorageFailure("invalid", `${this.spec.kind} ${state.id} is too large to store`, state.id);
    return { body, digest: digestText(body) };
  }

  private decode(row: Record<string, unknown>): S {
    const subject = textOf(row.id);
    const fail = (why: string) => new StorageFailure("integrity", `stored ${this.spec.kind} ${subject} is damaged: ${why}`, subject);
    const body = textOf(row.body_json);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { throw fail("its body is not valid JSON"); }
    if (canonicalBody(parsed) !== body) throw fail("its body is not in canonical form");
    if (digestText(body) !== textOf(row.record_digest)) throw fail("its digest does not match its body");
    const state = (this.spec.restore ? this.spec.restore(parsed) : parsed) as unknown as S;
    if (state.id !== subject || state.version !== Number(row.version)) throw fail("its identity or version differs from its columns");
    for (const [column, expected] of Object.entries(this.spec.columns(state))) {
      const actual = row[column];
      if (expected === null ? actual !== null : actual === null || String(actual) !== String(expected)) {
        throw fail(`its ${column} column differs from the stored body`);
      }
    }
    const problems = this.spec.violations(state);
    if (problems.length > 0) throw fail(problems.join("; "));
    return state;
  }

  private assertWritable(): void {
    if (!this.writable) throw new StorageFailure("read-only", `${this.spec.kind} cannot be written in a read unit`);
  }

  async get(id: Id, options: ReadOptions = {}): Promise<S | undefined> {
    const lock = options.lock && this.writable ? this.client.dialect.forUpdate : "";
    const row = await this.client.get<Record<string, unknown>>(`SELECT * FROM ${this.spec.table} WHERE id = ?${lock}`, [id]);
    return row ? this.decode(row) : undefined;
  }

  async select(where: string, params: unknown[], orderBy = "id", limit?: number): Promise<S[]> {
    const bound = limit === undefined ? "" : ` LIMIT ${Math.max(0, Math.floor(limit))}`;
    const rows = await this.client.all<Record<string, unknown>>(`SELECT * FROM ${this.spec.table} WHERE ${where} ORDER BY ${orderBy}${bound}`, params);
    return rows.map(row => this.decode(row));
  }

  async insert(state: S): Promise<void> {
    this.assertWritable();
    if (state.version !== 1) throw new StorageFailure("invalid", `a new ${this.spec.kind} starts at version 1`, state.id);
    const { body, digest } = this.encode(state);
    const extra = this.spec.columns(state);
    const names = ["id", "version", "record_digest", "body_json", ...Object.keys(extra)];
    try {
      await this.client.run(`INSERT INTO ${this.spec.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, [state.id, state.version, digest, body, ...Object.values(extra)]);
    } catch (error) { throw asStorageFailure(error, `${this.spec.kind} ${state.id}`); }
  }

  async update(state: S, expectedVersion: number): Promise<void> {
    this.assertWritable();
    if (state.version !== expectedVersion + 1) throw new StorageFailure("invalid", `a save advances ${this.spec.kind} ${state.id} by exactly one version`, state.id);
    const { body, digest } = this.encode(state);
    const extra = this.spec.columns(state);
    const assignments = ["version = ?", "record_digest = ?", "body_json = ?", ...Object.keys(extra).map(name => `${name} = ?`)];
    let changes: number;
    try {
      ({ changes } = await this.client.run(`UPDATE ${this.spec.table} SET ${assignments.join(", ")} WHERE id = ? AND version = ?`, [state.version, digest, body, ...Object.values(extra), state.id, expectedVersion]));
    } catch (error) { throw asStorageFailure(error, `${this.spec.kind} ${state.id}`); }
    if (changes === 1) return;
    const exists = await this.client.get(`SELECT id FROM ${this.spec.table} WHERE id = ?`, [state.id]);
    throw exists
      ? new StorageFailure("stale", `${this.spec.kind} ${state.id} is no longer at version ${expectedVersion}`, state.id)
      : new StorageFailure("missing", `${this.spec.kind} ${state.id} does not exist`, state.id);
  }
}
