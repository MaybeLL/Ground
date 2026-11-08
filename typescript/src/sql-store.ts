import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isUUIDv7, newUUIDv7 } from "./identity.js";
import { DomainError, schemaDetails, storageTransient, validation } from "./errors.js";
import type { SqlDialect } from "./sql-dialect.js";
import { mysqlDialect, postgresDialect, sqliteDialect } from "./sql-dialects.js";
import { mysql, mysqlClient, postgresClient, sqliteClient, DatabaseSync, type SQLClient } from "./sql-client.js";
import { Pool as PgPool } from "pg";
import { schemaStatements, SCHEMA_VERSION, PROTOCOL_VERSION, REMOTE_NORMALIZATION_VERSION, MINIMUM_CLI_VERSION } from "./sql-schema.js";
export type DatabaseTarget = { state: "empty" } | { state: "unrecognized" } | { state: "initialized"; metadata: Metadata };
import type { IntegrityReport, Metadata } from "./store-types.js";

export { SCHEMA_VERSION, PROTOCOL_VERSION, REMOTE_NORMALIZATION_VERSION, MINIMUM_CLI_VERSION } from "./sql-schema.js";
const CLI_VERSION = "0.2.53";
import { asText, isMissingTableError, isSchemaShapeError, retryDelay, safeInteger, isSafeTransactionRetry, mapStorageError, compareVersions } from "./sql-shared.js";

import { inspectWorkIntegrity } from "./work/adapters/sql/integrity.js";

/**
 * The advisory-lock key that serializes migrations on one PostgreSQL database.  A stable 64-bit
 * value from the connection identity: processes on the same database wait for each other while
 * migrations on another database do not.  Exported so tests can hold the same lock.
 */
export const postgresMigrationLockKey = (config: { host: string; port: number; database: string }): string => {
  const identity = `tcp\0${config.host.replace(/^\[|\]$/g, "")}:${config.port}\0${config.database}`;
  return createHash("sha256").update(identity, "utf8").digest().readBigInt64BE(0).toString().replace("-", "");
};

/** Migration-lock timeouts: their wait is spent, so the lifecycle retry loop must not repeat it. */
const lockWaitExpired = new WeakSet<object>();

export class SQLStore {
  private queue: Promise<void> = Promise.resolve();
  private constructor(readonly dialect: SqlDialect, private readonly connectionFactory: () => Promise<SQLClient>, private readonly closeFactory: () => Promise<void>, private readonly migrationLockKey = "", private readonly retryAttempts = 7, private readonly afterInitialize?: (client: SQLClient) => Promise<void>) {}

  /**
   * Engines with row locks serialize lifecycle work on the metadata row, which
   * waits for every in-flight business transaction's shared lock (ADR 0025).
   * SQLite has no row locks and relies on its single database write lock.
   */
  private get lifecycleLock(): "none" | "exclusive" { return this.dialect.forUpdate ? "exclusive" : "none"; }

  private async acquireClient(): Promise<SQLClient> {
    try { return await this.connectionFactory(); }
    catch (error) { throw mapStorageError(error, this.dialect); }
  }

  private async lifecycleRetry<T>(callback: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await callback();
      } catch (error) {
        const mapped = mapStorageError(error, this.dialect);
        if (this.dialect.retriesLifecycle && attempt < this.retryAttempts && !lockWaitExpired.has(mapped as object) && isSafeTransactionRetry(mapped, this.dialect)) {
          await retryDelay(attempt);
          continue;
        }
        throw mapped;
      }
    }
  }

  private integerText(column: string): string {
    return this.dialect.integerText(column);
  }

  private async exclusive<T>(callback: () => Promise<T>): Promise<T> {
    // A single shared connection cannot run overlapping transactions, so it
    // serializes in-process.  Pooled dialects give each transaction its own
    // connection and need no such queue.
    if (this.dialect.pooled) return callback();
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await callback(); } finally { release(); }
  }

  static sqlite(filePath: string, options: { busyTimeoutMs?: number; retryAttempts?: number } = {}): SQLStore {
    const absolute = resolve(filePath);
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw validation("busy_timeout", "must be between 0 and 60000 milliseconds");
    const retryAttempts = options.retryAttempts ?? 7;
    if (!Number.isSafeInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 100) throw validation("retry_attempts", "must be between 0 and 100");
    let client: SQLClient | undefined;
    const acquire = async (): Promise<SQLClient> => {
      if (client) return client;
      mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
      const database = new DatabaseSync(absolute);
      try {
        database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON;`);
        client = sqliteClient(sqliteDialect, database);
        return client;
      } catch (error) {
        try { database.close(); } catch { /* preserve the setup error */ }
        throw error;
      }
    };
    return new SQLStore(sqliteDialect, acquire, async () => {
      if (!client) return;
      const current = client;
      client = undefined;
      await current.close();
    }, "", retryAttempts, client => client.exec("PRAGMA journal_mode = WAL"));
  }

  static mysql(config: { host: string; port: number; database: string; username: string; password: string; caFile?: string }): SQLStore {
    const ssl: Record<string, unknown> = { rejectUnauthorized: true };
    if (config.caFile) ssl.ca = readFileSync(config.caFile);
    const pool = mysql.createPool({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password, ssl, waitForConnections: true, connectionLimit: 8, namedPlaceholders: false, timezone: "Z", dateStrings: true });
    // The advisory-lock identity separates network, address, and logical
    // database with NULs; the first 12 digest bytes fit MySQL's 64-byte limit.
    const host = config.host.replace(/^\[|\]$/g, "");
    const address = host.includes(":") ? `[${host}]:${config.port}` : `${host}:${config.port}`;
    const lockIdentity = `tcp\0${address}\0${config.database}`;
    const lockName = `grounds:migration:${createHash("sha256").update(lockIdentity, "utf8").digest("hex").slice(0, 24)}`;
    return new SQLStore(mysqlDialect, async () => mysqlClient(mysqlDialect, await pool.getConnection()), async () => pool.end(), lockName);
  }

  static postgres(config: { host: string; port: number; database: string; username: string; password: string; caFile?: string }, options: { lockWaitTimeoutMs?: number; retryAttempts?: number } = {}): SQLStore {
    const lockWaitTimeoutMs = options.lockWaitTimeoutMs ?? postgresDialect.lockWaitTimeoutMs;
    if (!Number.isSafeInteger(lockWaitTimeoutMs) || lockWaitTimeoutMs < 1 || lockWaitTimeoutMs > 600_000) throw validation("lock_wait_timeout", "must be between 1 and 600000 milliseconds");
    const retryAttempts = options.retryAttempts ?? 7;
    if (!Number.isSafeInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 100) throw validation("retry_attempts", "must be between 0 and 100");
    const dialect = lockWaitTimeoutMs === postgresDialect.lockWaitTimeoutMs ? postgresDialect : { ...postgresDialect, lockWaitTimeoutMs };
    // TLS identity verification is not optional.  Configuration validation
    // already requires verify_identity for every network database; a CA file
    // narrows trust, its absence means the system trust store.  This must
    // never become conditional on the CA file, or an operator relying on
    // system trust would silently get a plaintext connection.
    const ssl: Record<string, unknown> = { rejectUnauthorized: true };
    if (config.caFile) ssl.ca = readFileSync(config.caFile).toString();
    const pool = new PgPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl,
      max: 8,
      // Keep the session timezone fixed so stored timestamps and the
      // authoritative clock agree with the other dialects.
      options: "-c timezone=UTC",
    });
    // The server can terminate an idle pooled connection (restart, failover, administrator
    // action).  pg reports that on the pool, and an unhandled 'error' event would end the
    // process.  Swallowing it is safe: the pool drops the dead connection and the next
    // checkout opens a fresh one, with retryable errors mapped on the transaction path.
    pool.on("error", () => undefined);
    const key = postgresMigrationLockKey(config);
    return new SQLStore(dialect, async () => postgresClient(dialect, await pool.connect()), async () => pool.end(), key, retryAttempts);
  }

  private async acquireMigrationLock(client: SQLClient): Promise<boolean> {
    const lock = this.dialect.migrationLock;
    if (!lock) return false;
    const deadline = Date.now() + this.dialect.lockWaitTimeoutMs;
    for (;;) {
      const row = await client.get<{ acquired: unknown }>(lock.acquireSql(this.migrationLockKey), [this.migrationLockKey]);
      if (Number(row?.acquired ?? 0) === 1) return true;
      if (!lock.pollIntervalMs || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, lock.pollIntervalMs));
    }
    // The wait already used its whole bound; retrying here would multiply it, so the caller is
    // told to retry instead (the error is retryable) and lifecycleRetry leaves it alone.
    const expired = storageTransient(`${this.dialect.displayName} migration lock could not be acquired`, 500);
    lockWaitExpired.add(expired);
    throw expired;
  }

  private async releaseMigrationLock(client: SQLClient, acquired: boolean): Promise<void> {
    const lock = this.dialect.migrationLock;
    if (acquired && lock) await client.get(lock.releaseSql(this.migrationLockKey), [this.migrationLockKey]);
  }

  private metadataSelect(lock: "none" | "shared" | "exclusive" = "none"): string {
    const suffix = lock === "none" ? "" : lock === "shared" ? this.dialect.forShare : this.dialect.forUpdate;
    // SQLite's integer driver values are JavaScript numbers, and mysql2 may
    // return BIGINT values as numbers depending on connection options. Cast
    // every metadata integer to text before parsing so a corrupted value
    // cannot be rounded past Number.MAX_SAFE_INTEGER on the way in.
    const columns = [
      "database_id",
      `${this.integerText("schema_version")} AS schema_version`,
      `${this.integerText("protocol_version")} AS protocol_version`,
      "minimum_cli_version",
      `${this.integerText("remote_normalization_version")} AS remote_normalization_version`,
      "baseline_reachability_policy",
      "migration_state",
    ].join(", ");
    return `SELECT ${columns} FROM schema_metadata WHERE singleton = 1${suffix}`;
  }

  private async metadataFrom(client: SQLClient, lock: "none" | "shared" | "exclusive" = "none"): Promise<Metadata> {
    let row: Record<string, unknown> | undefined;
    try {
      row = await client.get<Record<string, unknown>>(this.metadataSelect(lock));
    } catch (error) {
      // open is allowed to run against an arbitrary configured database. A
      // missing metadata table is a stable schema state, not an implementation
      // error from the SQL driver.
      if (isMissingTableError(error)) throw new DomainError("SCHEMA_INCOMPATIBLE", "database is not initialized", false, schemaDetails(SCHEMA_VERSION, "missing schema_metadata table"));
      if (isSchemaShapeError(error)) throw new DomainError("SCHEMA_INCOMPATIBLE", "database schema metadata is invalid", false, schemaDetails(SCHEMA_VERSION, "schema_metadata table has incompatible columns"));
      throw error;
    }
    if (!row) throw new DomainError("SCHEMA_INCOMPATIBLE", "database is not initialized", false, schemaDetails(SCHEMA_VERSION, "missing metadata"));
    return this.metadataRow(row);
  }

  private async hasMetadataTable(client: SQLClient): Promise<boolean> {
    const row = await client.get<{ present: unknown }>(this.dialect.tableExistsSql("schema_metadata"));
    return Number(row?.present ?? 0) === 1;
  }

  private async userTableCount(client: SQLClient): Promise<number> {
    const row = await client.get<{ total: unknown }>(this.dialect.userTableCountSql);
    return Number(row?.total ?? 0);
  }

  private assertCompatible(metadata: Metadata): void {
    if (metadata.migration_state !== "clean") throw new DomainError("MIGRATION_DIRTY", "database migration is incomplete", false, { reason: `migration_state=${metadata.migration_state}` });
    if (metadata.schema_version !== SCHEMA_VERSION || metadata.protocol_version !== PROTOCOL_VERSION || metadata.remote_normalization_version !== REMOTE_NORMALIZATION_VERSION || compareVersions(metadata.minimum_cli_version, CLI_VERSION) > 0) throw new DomainError("SCHEMA_INCOMPATIBLE", "database schema is incompatible with this CLI", false, schemaDetails(SCHEMA_VERSION, `schema=${metadata.schema_version}, protocol=${metadata.protocol_version}, minimum_cli=${metadata.minimum_cli_version}, remote_normalization=${metadata.remote_normalization_version}`));
  }

  async classifyTarget(): Promise<DatabaseTarget> {
    return this.exclusive(() => this.lifecycleRetry(async () => {
      const client = await this.acquireClient();
      try {
        if (await this.hasMetadataTable(client)) return { state: "initialized", metadata: await this.metadataFrom(client) };
        return await this.userTableCount(client) === 0 ? { state: "empty" } : { state: "unrecognized" };
      } catch (error) {
        throw mapStorageError(error, this.dialect);
      } finally {
        if (this.dialect.pooled) await client.close();
      }
    }));
  }

  async initialize(policy: "warn" | "require_override"): Promise<{ metadata: Metadata; action: "initialized" | "attached" }> {
    return this.exclusive(() => this.lifecycleRetry(() => this.initializeExclusive(policy)));
  }

  private async initializeExclusive(policy: "warn" | "require_override"): Promise<{ metadata: Metadata; action: "initialized" | "attached" }> {
    const client = await this.acquireClient();
    let lock = false;
    let transaction = false;
    try {
      lock = await this.acquireMigrationLock(client);
      if (this.dialect.ddlIsTransactional) {
        await client.begin(true);
        transaction = true;
      }
      const existing = await this.hasMetadataTable(client) ? await this.metadataFrom(client, this.lifecycleLock) : undefined;
      const resuming = !this.dialect.ddlIsTransactional && existing?.migration_state === "in_progress";
      if (existing) {
        // An in-progress bootstrap marker authorizes finishing only this ledger family.
        this.assertCompatible(resuming ? { ...existing, migration_state: "clean" } : existing);
        if (!resuming) {
          if (transaction) { await client.commit(); transaction = false; }
          await this.afterInitialize?.(client);
          return { metadata: existing, action: "attached" };
        }
      } else if (await this.userTableCount(client) !== 0) {
        throw new DomainError("SCHEMA_INCOMPATIBLE", "database is neither empty nor an initialized Grounds database", false, schemaDetails(SCHEMA_VERSION, "unrecognized database objects"));
      }

      const [metadataDDL, ...tables] = schemaStatements(this.dialect);
      const identity = [existing?.database_id ?? newUUIDv7(), SCHEMA_VERSION, PROTOCOL_VERSION, MINIMUM_CLI_VERSION, REMOTE_NORMALIZATION_VERSION, existing?.baseline_reachability_policy ?? policy];
      const columns = "singleton, database_id, schema_version, protocol_version, minimum_cli_version, remote_normalization_version, baseline_reachability_policy, migration_state";
      if (!existing) {
        if (transaction) {
          await client.exec(metadataDDL + this.dialect.tableSuffix);
          await client.run(`INSERT INTO schema_metadata (${columns}) VALUES (1, ?, ?, ?, ?, ?, ?, 'in_progress')`, identity);
        } else {
          // MySQL commits DDL independently. Create its durable identity and
          // bootstrap marker in the same atomic CREATE TABLE ... SELECT.
          await client.run(metadataDDL + this.dialect.tableSuffix + " AS SELECT 1 AS singleton, ? AS database_id, ? AS schema_version, ? AS protocol_version, ? AS minimum_cli_version, ? AS remote_normalization_version, ? AS baseline_reachability_policy, 'in_progress' AS migration_state", identity);
        }
      }
      for (const ddl of tables) await client.exec(ddl + this.dialect.tableSuffix);
      if (!transaction) { await client.begin(true); transaction = true; }
      await client.run("UPDATE schema_metadata SET migration_state = 'clean' WHERE singleton = 1 AND database_id = ? AND migration_state = 'in_progress'", [identity[0]]);
      const metadata = await this.metadataFrom(client, this.lifecycleLock);
      this.assertCompatible(metadata);
      await client.commit(); transaction = false;
      await this.afterInitialize?.(client);
      return { metadata, action: "initialized" };
    } catch (error) {
      if (transaction) await client.rollback();
      throw mapStorageError(error, this.dialect);
    } finally {
      await this.releaseMigrationLock(client, lock);
      if (this.dialect.pooled) await client.close();
    }
  }

  private metadataRow(row: Record<string, unknown>): Metadata {
    try {
      const metadata: Metadata = {
        database_id: asText(row.database_id),
        schema_version: safeInteger(row.schema_version, "schema_version"),
        protocol_version: safeInteger(row.protocol_version, "protocol_version"),
        minimum_cli_version: asText(row.minimum_cli_version),
        remote_normalization_version: safeInteger(row.remote_normalization_version, "remote_normalization_version"),
        baseline_reachability_policy: asText(row.baseline_reachability_policy) as Metadata["baseline_reachability_policy"],
        migration_state: asText(row.migration_state) as Metadata["migration_state"],
      };
      if (!isUUIDv7(metadata.database_id)) throw new Error("database_id is not UUIDv7");
      if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.minimum_cli_version)) throw new Error("minimum_cli_version is not a version");
      if (!(metadata.baseline_reachability_policy === "warn" || metadata.baseline_reachability_policy === "require_override")) throw new Error("baseline_reachability_policy is invalid");
      if (!(metadata.migration_state === "clean" || metadata.migration_state === "dirty" || metadata.migration_state === "in_progress")) throw new Error("migration_state is invalid");
      return metadata;
    } catch (error) {
      if (error instanceof DomainError && error.code === "SCHEMA_INCOMPATIBLE") throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new DomainError("SCHEMA_INCOMPATIBLE", "database schema metadata is invalid", false, schemaDetails(SCHEMA_VERSION, reason));
    }
  }

  async open(): Promise<Metadata> {
    return this.exclusive(() => this.lifecycleRetry(async () => {
      const client = await this.acquireClient();
      try {
        await client.begin(false, false);
        const metadata = await this.metadataFrom(client, "shared");
        this.assertCompatible(metadata);
        await client.commit();
        return metadata;
      } catch (error) {
        try { await client.rollback(); } catch { /* preserve the original storage error */ }
        throw mapStorageError(error, this.dialect);
      } finally {
        if (this.dialect.pooled) await client.close();
      }
    }));
  }

  private async inspectUnlocked(): Promise<Metadata> {
    const client = await this.acquireClient();
    try { return await this.metadataFrom(client); }
    catch (error) { throw mapStorageError(error, this.dialect); }
    finally { if (this.dialect.pooled) await client.close(); }
  }

  async inspect(): Promise<Metadata> { return this.exclusive(() => this.lifecycleRetry(() => this.inspectUnlocked())); }

  async inspectIntegrity(): Promise<{ metadata: Metadata; report: IntegrityReport }> {
    return this.transaction(false, async client => ({
      metadata: await this.metadataFrom(client),
      report: await inspectWorkIntegrity(client),
    }));
  }

  /**
   * One business transaction with direct access to the SQL client, for adapters
   * that own their tables (the work model). It shares the store's retry,
   * compatibility check and error mapping; the callback may run more than once.
   */
  async transaction<T>(write: boolean, callback: (client: SQLClient) => Promise<T>): Promise<T> {
    return this.exclusive(() => this.businessTransaction(write, callback));
  }

  private async businessTransaction<T>(write: boolean, callback: (client: SQLClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      let client: SQLClient | undefined;
      let retry = false;
      try {
        // Keep connection acquisition inside the retry/error boundary.  A
        // refused or interrupted pool checkout is just as transient as a
        // failed BEGIN, and must not bypass the stable storage error mapping.
        client = await this.acquireClient();
        await client.begin(write);
        this.assertCompatible(await this.metadataFrom(client, write ? "exclusive" : "shared"));
        const result = await callback(client);
        await client.commit();
        return result;
      } catch (error) {
        if (client) {
          try { await client.rollback(); } catch { /* preserve the original transaction error */ }
        }
        retry = attempt < this.retryAttempts && isSafeTransactionRetry(error, this.dialect);
        if (!retry) throw mapStorageError(error, this.dialect);
      } finally {
        if (this.dialect.pooled && client) {
          try { await client.close(); } catch { /* preserve the transaction result/error */ }
        }
      }
      await retryDelay(attempt);
    }
  }

  async close(): Promise<void> { await this.exclusive(() => this.closeFactory()); }
}
