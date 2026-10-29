// Database clients.  Each client owns one connection and speaks the dialect it
// was constructed with.  Business code never sees the driver: it sees run/get/
// all/exec plus transaction control, and the dialect supplies everything the
// engine needs beyond that.

import { DatabaseSync } from "node:sqlite";
import mysql, { type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { storageTransient } from "./errors.js";
import type { SqlDialect } from "./sql-dialect.js";

export interface SQLClient {
  readonly dialect: SqlDialect;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; insertId?: number }>;
  get<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  begin(write: boolean, gated?: boolean): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Rewrite `?` placeholders into the dialect's style.  PostgreSQL numbers its
 * parameters, so the shared business SQL keeps one spelling while each engine
 * receives what it accepts.
 */
export const bindPlaceholders = (dialect: SqlDialect, sql: string): string => {
  if (dialect.placeholders === "question") return sql;
  let index = 0;
  let out = "";
  let quote: string | undefined;
  for (let position = 0; position < sql.length; position += 1) {
    const character = sql[position];
    if (quote) {
      out += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      out += character;
      continue;
    }
    // A doubled single quote inside a literal is an escaped quote, not a
    // toggle; the loop above consumes it as part of the literal.
    out += character === "?" ? `$${(index += 1)}` : character;
  }
  return out;
};

class SQLiteClient implements SQLClient {
  constructor(readonly dialect: SqlDialect, readonly database: DatabaseSync) {}

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; insertId?: number }> {
    const result = this.database.prepare(sql).run(...params as any[]);
    return { changes: Number(result.changes), insertId: Number(result.lastInsertRowid) };
  }

  async get<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.database.prepare(sql).get(...params as any[]) as T | undefined;
  }

  async all<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...params as any[]) as T[];
  }

  async exec(sql: string): Promise<void> { this.database.exec(sql); }
  // Business reads use the same coordination lock as writes so a migration
  // cannot commit a DDL change between metadata preflight and the end of a
  // multi-table snapshot.
  // Lifecycle inspection passes gated=false so status/migration recovery can
  // still obtain a deferred snapshot while another process is writing.
  async begin(write: boolean, gated = true): Promise<void> {
    this.database.exec(write || gated ? "BEGIN IMMEDIATE" : "BEGIN");
  }
  async commit(): Promise<void> { this.database.exec("COMMIT"); }
  async rollback(): Promise<void> { try { this.database.exec("ROLLBACK"); } catch { /* already rolled back */ } }
  async close(): Promise<void> { this.database.close(); }
}

class MySQLClient implements SQLClient {
  constructor(readonly dialect: SqlDialect, readonly connection: any) {}
  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; insertId?: number }> {
    const [result] = await this.connection.execute(bindPlaceholders(this.dialect, sql), params as any[]);
    const header = result as ResultSetHeader;
    return { changes: Number(header.affectedRows), insertId: Number(header.insertId) };
  }

  async get<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const [rows] = await this.connection.execute(bindPlaceholders(this.dialect, sql), params as any[]);
    return (rows as RowDataPacket[])[0] as T | undefined;
  }

  async all<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.connection.execute(bindPlaceholders(this.dialect, sql), params as any[]);
    return rows as T[];
  }

  async exec(sql: string): Promise<void> { await this.connection.query(sql); }
  async begin(write: boolean, _gated = true): Promise<void> {
    if (write) await this.connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    else await this.connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await this.connection.beginTransaction();
  }
  async commit(): Promise<void> { await this.connection.commit(); }
  async rollback(): Promise<void> { try { await this.connection.rollback(); } catch { /* already rolled back */ } }
  async close(): Promise<void> { this.connection.release(); }
}

export const sqliteClient = (dialect: SqlDialect, database: DatabaseSync): SQLClient =>
  new SQLiteClient(dialect, database);

export const mysqlClient = (dialect: SqlDialect, connection: any): SQLClient =>
  new MySQLClient(dialect, connection);

/**
 * PostgreSQL.  Three differences need handling here rather than in SQL:
 *   - Every parameter is numbered, so `?` is rewritten per statement.
 *   - BYTEA arrives as a Buffer and must be written as one; text columns
 *     holding digests must not be coerced.
 *   - A read transaction must ask for REPEATABLE READ explicitly.  The
 *     server default is READ COMMITTED, where each statement sees a fresh
 *     snapshot and a paged scan can skip or repeat rows.
 */
class PostgresClient implements SQLClient {
  /**
   * The error that ended this connection, recorded when the server terminates a
   * backend we hold (failover, restart, an administrator command).  Once set,
   * every further statement is refused because the transaction is already void.
   */
  private terminated: unknown;
  private readonly onConnectionError = (error: unknown): void => { this.terminated ??= error; };

  constructor(readonly dialect: SqlDialect, readonly connection: any) {
    // pg-pool removes its idle 'error' listener when it hands a client out and
    // reinstalls it only on release.  A checked-out client therefore has no
    // 'error' listener, and a server-side termination — which the driver
    // reports as an 'error' event, not as a query failure — would end the
    // process.  Hold our own listener for the checkout's lifetime instead.  It
    // is removed in close(), after release() has already reinstalled the idle
    // listener, so no window is left with no listener at all.
    connection.on("error", this.onConnectionError);
  }

  private rewrite(sql: string): string { return bindPlaceholders(this.dialect, sql); }

  /** Reason text for a connection the server has already torn down. */
  private terminationReason(): string {
    const reason = this.terminated instanceof Error ? this.terminated.message : String(this.terminated ?? "connection lost");
    return `PostgreSQL server terminated the connection: ${reason}`;
  }

  /**
   * Run one statement.  A connection the server has already torn down is
   * reported as a retryable storage failure rather than the driver's uncoded
   * client-state error, so the transaction retries on a fresh connection
   * instead of surfacing an unclassifiable failure.  The connection is checked
   * before and after the statement because it can die either between statements
   * or while one is in flight.
   */
  private async statement(sql: string, params: unknown[] = []): Promise<any> {
    if (this.terminated) throw storageTransient(this.terminationReason(), 250);
    try {
      return await this.connection.query(sql, params as any[]);
    } catch (error) {
      if (this.terminated) throw storageTransient(this.terminationReason(), 250);
      throw error;
    }
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; insertId?: number }> {
    const result = await this.statement(this.rewrite(sql), params);
    return { changes: Number(result.rowCount ?? 0) };
  }

  async get<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.statement(this.rewrite(sql), params);
    return result.rows[0] as T | undefined;
  }

  async all<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.statement(this.rewrite(sql), params);
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> { await this.statement(sql); }

  async begin(write: boolean, _gated = true): Promise<void> {
    // A read must land on one snapshot for the whole transaction.  The server
    // default (READ COMMITTED) gives every statement a fresh one, which lets a
    // paged integrity scan skip or repeat rows.  The transaction is not marked
    // READ ONLY: taking the metadata row's shared lock is a locking read, which
    // the engine refuses inside a read-only transaction.
    const opening = !write && this.dialect.readIsolation === "repeatable_read" ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN";
    await this.statement(opening);
    // Bound every lock wait.  SET LOCAL only takes effect inside a transaction
    // block (outside one it is a silently ignored warning and the wait stays
    // unbounded), so it must follow BEGIN, for reads as well as writes.
    await this.statement(`SET LOCAL lock_timeout = ${this.dialect.lockWaitTimeoutMs}`);
  }

  async commit(): Promise<void> { await this.statement("COMMIT"); }
  async rollback(): Promise<void> { try { await this.statement("ROLLBACK"); } catch { /* already rolled back */ } }
  async close(): Promise<void> {
    // release() installs pg-pool's own idle listener as its first act, so our
    // listener can only come off once it has returned.  Removing it after a
    // failed release would leave the connection with no listener at all.
    this.connection.release();
    this.connection.removeListener("error", this.onConnectionError);
  }
}

export const postgresClient = (dialect: SqlDialect, connection: any): SQLClient =>
  new PostgresClient(dialect, connection);

export { DatabaseSync };
export { mysql };
