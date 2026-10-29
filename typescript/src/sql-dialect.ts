// Dialect adapter: the single place where SQLite, MySQL and PostgreSQL
// differences are expressed.  Business transaction code calls these members
// by name and never branches on a dialect name.
//
// Two kinds of difference live here, and they fail differently:
//   - Syntax primitives (JSON extraction, type casts, current time, DDL types,
//     column probing) fail loudly: a wrong primitive is a syntax error or an
//     immediate mismatch.
//   - Transaction capabilities (read snapshot semantics, whether DDL can roll
//     back, lock-wait bounds, retryable error codes, migration coordination)
//     fail silently when wrong: an integrity scan can skip or repeat rows, and
//     a migration can fail half-way.  Each capability is therefore an explicit
//     member rather than an assumption.

/** Parameter placeholder style.  SQLite and MySQL use `?`, PostgreSQL `$n`. */
export type PlaceholderStyle = "question" | "numbered";

/** Isolation a read transaction needs so a multi-statement scan stays on one snapshot. */
export type ReadIsolation = "database_default" | "repeatable_read";

export type DialectName = "sqlite" | "mysql" | "postgres";

export interface SqlDialect {
  readonly name: DialectName;
  /** Human-readable engine name for messages. */
  readonly displayName: string;

  // ---- syntax primitives ------------------------------------------------

  /** Placeholder style; the client rewrites `?` accordingly. */
  readonly placeholders: PlaceholderStyle;

  /** Extract a scalar JSON value at a simple `$.a.b` path from a text column. */
  jsonExtract(column: string, path: string): string;

  /** Cast a possibly-large integer column to text for exact parsing. */
  integerText(column: string): string;

  /** Authoritative current time, canonical RFC3339 with milliseconds. */
  readonly nowExpression: string;

  /** DDL column type for a 36-character identifier. */
  readonly idType: string;
  /** DDL column type for a digest column stored as text (64-hex or equivalent). */
  readonly digestType: string;
  /**
   * DDL column type for a raw 32-byte SHA-256 digest.  Engines with a native
   * variable-length binary type use it; engines that model fixed-width binary
   * separately (MySQL's BINARY) keep that spelling.
   */
  readonly rawDigestType: string;
  /** DDL column type for text of at most `chars` characters. */
  boundedText(chars: number): string;
  /** DDL column type for unbounded text. */
  readonly textType: string;
  /** DDL column type for binary payloads. */
  readonly blobType: string;
  /** DDL column type for a bounded binary column (path bytes, remotes). */
  boundedBinary(bytes: number): string;
  /** Appended to every `CREATE TABLE` statement. */
  readonly tableSuffix: string;
  /** Column definition for an auto-incrementing ledger sequence. */
  readonly eventSeqColumn: string;

  /** Suffix that turns a SELECT into a locking read, or "" when unsupported. */
  readonly forUpdate: string;
  /** Suffix that turns a SELECT into a shared locking read, or "". */
  readonly forShare: string;

  /**
   * Fixed-width ordering key for a stored RFC3339 timestamp column.  Plain text
   * comparison is wrong because trailing fraction zeros are stripped, so
   * "…:05.5Z" would sort after "…:05.51Z".
   */
  timeKey(column: string): string;

  /**
   * Index length limit, not a dialect quirk: MySQL's InnoDB and PostgreSQL's
   * btree both refuse to index an unbounded text column, while SQLite accepts
   * one.  Engines that cannot index the raw remote store a SHA-256 digest and
   * keep the raw value in the predicate alongside it.
   */
  readonly needsRemoteDigest: boolean;
  /** Expression selecting the digest column, or "NULL" when none is stored. */
  remoteDigestExpression(qualifiedColumn: string): string;

  // ---- transaction capabilities ----------------------------------------

  /** Isolation a read transaction must request; `database_default` means none. */
  readonly readIsolation: ReadIsolation;

  /**
   * True when initialize/open/inspect/migrate should be retried on a transient
   * failure.  MySQL lifecycle calls are deliberately not retried: they hold a
   * named advisory lock and a failed attempt must surface to the operator.
   */
  readonly retriesLifecycle: boolean;

  /** True when a DDL statement inside a transaction can be rolled back. */
  readonly ddlIsTransactional: boolean;

  /**
   * True when a failed statement poisons the whole transaction: every later statement is
   * refused until it ends (PostgreSQL).  Code that catches a SQL error and carries on, such as
   * a duplicate-key probe or an optional-table fallback, must then isolate the statement in a
   * savepoint.  SQLite and MySQL keep the transaction usable after a failed statement.
   */
  readonly errorAbortsTransaction: boolean;

  /**
   * Bound on lock waits, in milliseconds.  PostgreSQL has no bounded default,
   * so its client applies this to every transaction.  SQLite (busy_timeout) and
   * MySQL (innodb_lock_wait_timeout) already bound waits themselves; for them
   * this records the engine's own bound and is not applied by Grounds.
   */
  readonly lockWaitTimeoutMs: number;

  /** Driver error codes/SQLSTATEs that make a failed transaction safe to retry. */
  readonly retryableErrorCodes: readonly string[];
  /** Numeric driver error numbers that make a failed transaction safe to retry. */
  readonly retryableErrnos: readonly number[];

  // ---- catalog and connection management --------------------------------

  /** True when the client must return its connection to a pool after use. */
  readonly pooled: boolean;

  /**
   * True when a foreign key to a table defined later in the same schema can be
   * installed inside CREATE TABLE.  Engines without it need the constraint
   * added separately after all tables exist.
   */
  readonly inlineForwardForeignKey: boolean;

  /** Engines without DROP CONSTRAINT rebuild a parent table atomically. FK
   * enforcement must be suspended before BEGIN and restored after completion;
   * the caller must check every FK before committing the replacement. */
  readonly tableRebuild?: {
    readonly disableForeignKeysSql: string;
    readonly restoreForeignKeysSql: string;
    definitionSql(table: string): string;
  };

  /** Catalog/DDL primitives for targeted constraint migration. Queries return
   * {name} for FKs and {name, definition} for CHECKs. */
  readonly constraintEditing?: {
    foreignKeysSql(table: string, column: string, referencedTable: string): string;
    checksSql(table: string): string;
    dropForeignKeySql(table: string, constraint: string): string;
    dropCheckSql(table: string, constraint: string): string;
  };

  /** Statement returning `present = 1` when the named table exists. */
  tableExistsSql(table: string): string;

  /** Statement returning `present = 1` when the named column exists on a table. */
  columnExistsSql(table: string, column: string): string;

  /** Statement returning `total` = number of user (non-catalog) base tables. */
  readonly userTableCountSql: string;

  /** Statement returning `present` = 1 when the named constraint exists. */
  constraintExistsSql(table: string, constraint: string): string;

  /**
   * True when the engine needs an explicit transaction opened before its
   * lifecycle statements observe a consistent catalog.
   */
  readonly requiresExplicitLifecycleTransaction: boolean;

  /**
   * Statement listing whole-database foreign-key violations, or undefined when
   * the engine has no equivalent sweep.  Rows carry `table`, `rowid` and
   * `parent`.
   */
  readonly foreignKeyCheckSql?: string;

  /**
   * Advisory lock used to serialize migrations across processes.  Engines
   * without one serialize through their transaction locks instead.
   */
  readonly migrationLock?: {
    /** Statement returning `acquired` = 1 when the lock was taken. */
    acquireSql(lockName: string): string;
    /** Statement releasing the lock. */
    releaseSql(lockName: string): string;
    /** Seconds the acquire statement itself waits before giving up; 0 when it never waits. */
    readonly waitSeconds: number;
    /**
     * Set when the acquire statement returns at once instead of waiting.  The caller then
     * polls at this interval until `lockWaitTimeoutMs` has passed.  PostgreSQL needs this:
     * a blocking `pg_advisory_lock` runs outside any transaction, so no `lock_timeout`
     * applies to it and a stuck holder would hang the command.
     */
    readonly pollIntervalMs?: number;
  };
}
