import type { GitArtifactResolver } from "./git-artifact-storage.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { isUUIDv7, newUUIDv7 } from "./identity.js";
import { sha256 } from "./canonical-json.js";
import { DomainError, schemaDetails, storageTransient, validation } from "./errors.js";
import type { SqlDialect } from "./sql-dialect.js";
import { mysqlDialect, postgresDialect, sqliteDialect } from "./sql-dialects.js";
import { mysql, mysqlClient, postgresClient, sqliteClient, DatabaseSync, type SQLClient } from "./sql-client.js";
import { Pool as PgPool } from "pg";
import { applySchema, ensureLegacyColumns, migrateCandidateArtifacts, SCHEMA_VERSION, PROTOCOL_VERSION, REMOTE_NORMALIZATION_VERSION, MINIMUM_CLI_VERSION } from "./sql-schema.js";
export type DatabaseTarget = { state: "empty" } | { state: "unrecognized" } | { state: "initialized"; metadata: Metadata };
import { type Candidate } from "./domain.js";
import type { IntegrityReport, Metadata, ReadTx, Store, Tx } from "./store-types.js";

export { SCHEMA_VERSION, PROTOCOL_VERSION, REMOTE_NORMALIZATION_VERSION, MINIMUM_CLI_VERSION } from "./sql-schema.js";
const CLI_VERSION = "0.1.0";
import { asText, isMissingTableError, isSchemaShapeError, retryDelay, safeInteger, isSafeTransactionRetry, mapStorageError, compareVersions } from "./sql-shared.js";

import { SqlTx } from "./sql-tx.js";
import { scanIntegrity } from "./sql-integrity.js";

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

export class SQLStore implements Store {
  private queue: Promise<void> = Promise.resolve();
  private gitArtifactResolver?: GitArtifactResolver;
  setGitArtifactResolver(resolver: GitArtifactResolver): void { this.gitArtifactResolver = resolver; }
  private constructor(readonly dialect: SqlDialect, private readonly connectionFactory: () => Promise<SQLClient>, private readonly closeFactory: () => Promise<void>, private readonly migrationLockKey = "", private readonly retryAttempts = 7) {}

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
        // busy_timeout must be active before journal_mode: setting WAL can
        // itself need a lock while another CLI process has the database open.
        database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON;`);
        const journalMode = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined)?.journal_mode ?? "").toLowerCase();
        if (journalMode !== "wal") database.exec("PRAGMA journal_mode = WAL;");
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
    }, "", retryAttempts);
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

  private assertMigratable(metadata: Metadata): void {
    // A previous migration may have left either durable marker behind. Every
    // non-clean state is a recovery stop: callers must inspect the database
    // and make an explicit recovery decision rather than silently replaying DDL.
    if (metadata.migration_state !== "clean") throw new DomainError("MIGRATION_DIRTY", "database migration is incomplete", false, { reason: `migration_state=${metadata.migration_state}` });
    // The current schema with a stale normalization version is not a
    // migration candidate: there is no safe rewrite for already-persisted
    // repository identities.  Only strictly older schema versions may pass
    // through the versioned upgrade path (the exact current version is
    // handled by the fast path above).
    // An older schema can be upgraded even when its remote-normalization marker
    // predates the current one; migration rewrites that marker. A mismatch is
    // unrecoverable only when the database already claims the current schema.
    if (metadata.schema_version < 1 || metadata.schema_version >= SCHEMA_VERSION || metadata.protocol_version !== PROTOCOL_VERSION || compareVersions(metadata.minimum_cli_version, CLI_VERSION) > 0) {
      throw new DomainError("SCHEMA_INCOMPATIBLE", "database cannot be migrated by this CLI", false, schemaDetails(SCHEMA_VERSION, `schema=${metadata.schema_version}, protocol=${metadata.protocol_version}, remote_normalization=${metadata.remote_normalization_version}`));
    }
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
      if (this.dialect.requiresExplicitLifecycleTransaction) {
        await client.begin(true);
        transaction = true;
      }
      if (await this.hasMetadataTable(client)) {
        if (!transaction) { await client.begin(true); transaction = true; }
        const metadata = await this.metadataFrom(client, this.lifecycleLock);
        this.assertCompatible(metadata);
        if (transaction) { await client.commit(); transaction = false; }
        return { metadata, action: "attached" };
      }
      if (await this.userTableCount(client) !== 0) {
        throw new DomainError("SCHEMA_INCOMPATIBLE", "database is neither empty nor an initialized Grounds database", false, schemaDetails(SCHEMA_VERSION, "unrecognized tables"));
      }

      // MySQL DDL auto-commits, so no transaction may span schema creation.
      // The advisory lock is the initialization serialization boundary.
      if (!this.dialect.ddlIsTransactional && transaction) { await client.commit(); transaction = false; }
      await applySchema(client, this.dialect);
      if (!transaction) { await client.begin(true); transaction = true; }
      // Recheck after DDL: a concurrent initializer that does not honor our
      // lock must not be allowed to silently replace the database identity.
      const existing = await client.get<Record<string, unknown>>(this.metadataSelect(this.lifecycleLock));
      if (existing) {
        const metadata = this.metadataRow(existing);
        this.assertCompatible(metadata);
        await client.commit(); transaction = false;
        return { metadata, action: "attached" };
      }
      const id = newUUIDv7();
      await client.run("INSERT INTO schema_metadata (singleton, database_id, schema_version, protocol_version, minimum_cli_version, remote_normalization_version, baseline_reachability_policy, migration_state) VALUES (1, ?, ?, ?, ?, ?, ?, 'clean')", [id, SCHEMA_VERSION, PROTOCOL_VERSION, MINIMUM_CLI_VERSION, REMOTE_NORMALIZATION_VERSION, policy]);
      await client.run("INSERT INTO schema_migrations (schema_version, applied_at) VALUES (?, CURRENT_TIMESTAMP)", [SCHEMA_VERSION]);
      const metadata = await this.metadataFrom(client, this.lifecycleLock);
      await client.commit();
      transaction = false;
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
    return this.exclusive(() => this.lifecycleRetry(async () => {
      const metadata = await this.inspectUnlocked();
      const client = await this.acquireClient();
      try { return await scanIntegrity(this.dialect, client, metadata, this.gitArtifactResolver); }
      catch (error) {
        try { await client.rollback(); } catch { /* preserve the original storage error */ }
        throw mapStorageError(error, this.dialect);
      } finally { if (this.dialect.pooled) await client.close(); }
    }));
  }

  async migrate(): Promise<Metadata> {
    return this.exclusive(() => this.lifecycleRetry(() => this.migrateExclusive()));
  }

  private async migrateExclusive(): Promise<Metadata> {
      const client = await this.acquireClient();
      let lock = false;
      let transaction = false;
      let foreignKeysDisabled = false;
      try {
        lock = await this.acquireMigrationLock(client);
        // SQLite cannot change FK enforcement inside a transaction. The store
        // queue plus BEGIN IMMEDIATE protects the parent-table rebuild below.
        if (this.dialect.tableRebuild) {
          const current = await this.metadataFrom(client, this.lifecycleLock);
          if (current.migration_state === "clean" && current.schema_version === SCHEMA_VERSION && current.protocol_version === PROTOCOL_VERSION && current.remote_normalization_version === REMOTE_NORMALIZATION_VERSION) {
            this.assertCompatible(current);
            return current;
          }
          await client.exec(this.dialect.tableRebuild.disableForeignKeysSql);
          foreignKeysDisabled = true;
        }
        await client.begin(true); transaction = true;
        let metadata = await this.metadataFrom(client, this.lifecycleLock);
        if (metadata.migration_state === "clean" && metadata.schema_version === SCHEMA_VERSION && metadata.protocol_version === PROTOCOL_VERSION && metadata.remote_normalization_version === REMOTE_NORMALIZATION_VERSION) {
          this.assertCompatible(metadata);
          await client.commit(); transaction = false;
          return metadata;
        }
        this.assertMigratable(metadata);

        if (!this.dialect.ddlIsTransactional) {
          // The metadata row is taken exclusively so a locking read waits for
          // every business transaction's shared lock.  The dirty marker is
          // committed before DDL because this engine's DDL auto-commits, so no
          // transaction may span schema creation.
          await client.run("UPDATE schema_metadata SET migration_state = 'in_progress' WHERE singleton = 1");
          await client.commit(); transaction = false;
          // Create any tables first, but defer the refinement foreign key
          // until the legacy column has been added.  Older databases may have
          // a dev_runs table without refines_candidate_id; attempting to add
          // the constraint before ensureLegacyColumns would fail with an
          // unknown-column error.  Running schema twice is intentional:
          // CREATE IF NOT EXISTS is idempotent, while the second pass installs
          // the constraint after the additive ALTER TABLE steps.
          await applySchema(client, this.dialect, false);
          await ensureLegacyColumns(client, this.dialect);
          await migrateCandidateArtifacts(client, this.dialect);
          await applySchema(client, this.dialect);
          await client.begin(true); transaction = true;
          metadata = await this.metadataFrom(client, "exclusive");
        } else {
          await client.run("UPDATE schema_metadata SET migration_state = 'in_progress' WHERE singleton = 1");
          await applySchema(client, this.dialect, false);
          await ensureLegacyColumns(client, this.dialect);
          await migrateCandidateArtifacts(client, this.dialect);
          await applySchema(client, this.dialect);
        }

        if (this.dialect.foreignKeyCheckSql && (await client.all(this.dialect.foreignKeyCheckSql)).length) throw new DomainError("SCHEMA_INCOMPATIBLE", "Migration would leave invalid foreign-key bindings");
        await client.run("UPDATE schema_metadata SET schema_version = ?, protocol_version = ?, minimum_cli_version = ?, remote_normalization_version = ?, migration_state = 'clean' WHERE singleton = 1", [SCHEMA_VERSION, PROTOCOL_VERSION, MINIMUM_CLI_VERSION, REMOTE_NORMALIZATION_VERSION]);
        await client.run("INSERT INTO schema_migrations (schema_version, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE schema_version = ?)", [SCHEMA_VERSION, SCHEMA_VERSION]);
        metadata = await this.metadataFrom(client, this.lifecycleLock);
        this.assertCompatible(metadata);
        await client.commit(); transaction = false;
        return metadata;
      } catch (error) {
        if (transaction) await client.rollback();
        throw mapStorageError(error, this.dialect);
      } finally {
        if (foreignKeysDisabled) await client.exec(this.dialect.tableRebuild!.restoreForeignKeysSql);
        await this.releaseMigrationLock(client, lock);
        if (this.dialect.pooled) await client.close();
      }
  }

  async write<T>(callback: (tx: Tx) => Promise<T>): Promise<T> {
    return this.exclusive(() => this.businessTransaction(true, (client) => callback(new SqlTx(client, false, true, this.gitArtifactResolver))));
  }

  async read<T>(callback: (tx: ReadTx) => Promise<T>): Promise<T> {
    return this.exclusive(() => this.businessTransaction(false, (client) => callback(new SqlTx(client, true, true, this.gitArtifactResolver))));
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

export const artifactChunks = (patch: Buffer): Buffer[] => {
  const compressed = deflateSync(patch);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < compressed.length; offset += 1024 * 1024) chunks.push(compressed.subarray(offset, Math.min(compressed.length, offset + 1024 * 1024)));
  if (chunks.length === 0) chunks.push(Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]));
  return chunks;
};
