// Concrete dialect implementations.  Each one is the complete answer to
// "what does this engine require?", so business transaction code can call
// these members without knowing which engine is underneath.
//
// Adding an engine means adding one object here.  It must not require edits
// to the transaction code.

import type { SqlDialect } from "./sql-dialect.js";
import { DomainError } from "./errors.js";

const catalogIdentifier = (name: string, delimiter: string): string => {
  if (!name || name.includes("\0")) throw new DomainError("SCHEMA_INCOMPATIBLE", "Invalid constraint catalog identifier");
  return delimiter + name.split(delimiter).join(delimiter + delimiter) + delimiter;
};

/** SQLite's integer columns are driver numbers, so text casting is a no-op type change. */
export const sqliteDialect: SqlDialect = {
  name: "sqlite",
  displayName: "SQLite",
  placeholders: "question",

  jsonExtract: (column, path) => `json_extract(${column}, '${path}')`,
  integerText: (column) => `CAST(${column} AS TEXT)`,
  nowExpression: "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_value",

  idType: "TEXT",
  digestType: "TEXT",
  rawDigestType: "BLOB",
  textType: "TEXT",
  boundedText: () => "TEXT",
  blobType: "BLOB",
  boundedBinary: () => "BLOB",
  tableSuffix: "",
  eventSeqColumn: "INTEGER PRIMARY KEY AUTOINCREMENT",

  forUpdate: "",
  forShare: "",

  timeKey: (column) => {
    const fraction = `CASE WHEN length(${column}) > 20 THEN substr(${column}, 21, length(${column}) - 21) ELSE '' END`;
    return `substr(${column}, 1, 19) || substr((${fraction}) || '000000000', 1, 9)`;
  },

  needsRemoteDigest: false,
  remoteDigestExpression: () => "NULL",

  readIsolation: "database_default",
  retriesLifecycle: true,
  ddlIsTransactional: true,
  errorAbortsTransaction: false,
  lockWaitTimeoutMs: 5000,
  retryableErrorCodes: ["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_IOERR", "SQLITE_CANTOPEN", "SQLITE_NOTADB"],
  retryableErrnos: [5, 6, 10, 11, 257, 261, 262, 517],

  pooled: false,
  inlineForwardForeignKey: true,
  tableExistsSql: (table) => `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
  // pragma_table_info is a table-valued function, so the shape matches the
  // information_schema queries the other dialects use and no caller branch is
  // needed to read the result.
  columnExistsSql: (table, column) => `SELECT COUNT(*) AS present FROM pragma_table_info('${table}') WHERE name = '${column}'`,
  userTableCountSql: "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  constraintExistsSql: () => "SELECT 0 AS present",
  requiresExplicitLifecycleTransaction: true,
  foreignKeyCheckSql: "PRAGMA foreign_key_check",
  tableRebuild: {
    disableForeignKeysSql: "PRAGMA foreign_keys = OFF",
    restoreForeignKeysSql: "PRAGMA foreign_keys = ON",
    definitionSql: table => `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
  },
};

export const mysqlDialect: SqlDialect = {
  name: "mysql",
  displayName: "MySQL",
  placeholders: "question",

  jsonExtract: (column, path) => `JSON_UNQUOTE(JSON_EXTRACT(${column}, '${path}'))`,
  integerText: (column) => `CAST(${column} AS CHAR)`,
  nowExpression: "SELECT UTC_TIMESTAMP(6) AS now_value",

  idType: "VARCHAR(36)",
  digestType: "VARCHAR(71)",
  rawDigestType: "BINARY(32)",
  textType: "LONGTEXT",
  boundedText: (chars) => `VARCHAR(${chars})`,
  blobType: "LONGBLOB",
  boundedBinary: (bytes) => `VARBINARY(${bytes})`,
  tableSuffix: " ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
  eventSeqColumn: "BIGINT AUTO_INCREMENT PRIMARY KEY",

  forUpdate: " FOR UPDATE",
  forShare: " FOR SHARE",

  timeKey: (column) => {
    const fraction = `CASE WHEN CHAR_LENGTH(${column}) > 20 THEN substr(${column}, 21, CHAR_LENGTH(${column}) - 21) ELSE '' END`;
    return `CONCAT(substr(${column}, 1, 19), substr(CONCAT(${fraction}, '000000000'), 1, 9))`;
  },

  needsRemoteDigest: true,
  remoteDigestExpression: (column) => column,

  readIsolation: "repeatable_read",
  retriesLifecycle: false,
  ddlIsTransactional: false,
  errorAbortsTransaction: false,
  // innodb_lock_wait_timeout default; the server enforces it, Grounds does not set it.
  lockWaitTimeoutMs: 50_000,
  retryableErrorCodes: [
    "ER_LOCK_DEADLOCK",
    "ER_LOCK_WAIT_TIMEOUT",
    "PROTOCOL_CONNECTION_LOST",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
  ],
  retryableErrnos: [1040, 1042, 1043, 1047, 1205, 1213, 2006, 2013],

  pooled: true,
  inlineForwardForeignKey: false,
  tableExistsSql: (table) => `SELECT COUNT(*) AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`,
  columnExistsSql: (table, column) => `SELECT COUNT(*) AS present FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`,
  userTableCountSql: "SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'",
  constraintExistsSql: (table, constraint) => `SELECT COUNT(*) AS present FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = '${table}' AND constraint_name = '${constraint}'`,
  requiresExplicitLifecycleTransaction: false,
  constraintEditing: {
    foreignKeysSql: (table, column, referenced) => `SELECT DISTINCT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}' AND REFERENCED_TABLE_NAME = '${referenced}'`,
    checksSql: table => `SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS definition FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = '${table}' AND tc.CONSTRAINT_TYPE = 'CHECK'`,
    dropForeignKeySql: (table, constraint) => `ALTER TABLE ${catalogIdentifier(table, "`")} DROP FOREIGN KEY ${catalogIdentifier(constraint, "`")}`,
    dropCheckSql: (table, constraint) => `ALTER TABLE ${catalogIdentifier(table, "`")} DROP CHECK ${catalogIdentifier(constraint, "`")}`,
  },
  migrationLock: {
    acquireSql: () => "SELECT GET_LOCK(?, 30) AS acquired",
    releaseSql: () => "SELECT RELEASE_LOCK(?) AS released",
    waitSeconds: 30,
  },
};

/**
 * PostgreSQL.  Two capabilities differ from MySQL in ways that fail silently
 * rather than loudly, so they are stated explicitly here:
 *   - A read transaction must ask for REPEATABLE READ.  PostgreSQL defaults to
 *     READ COMMITTED, where every statement gets a fresh snapshot, which would
 *     let a paged integrity scan skip or repeat rows.
 *   - A lock wait has no default bound, so one must be set per connection or a
 *     blocked command hangs indefinitely.
 */
export const postgresDialect: SqlDialect = {
  name: "postgres",
  displayName: "PostgreSQL",
  placeholders: "numbered",

  // The stored record bodies are TEXT columns, and PostgreSQL has no `text #>> text[]`
  // operator, so the column is parsed as jsonb first.  The bodies are canonical JSON
  // written by Grounds, so the cast cannot fail on stored data.
  jsonExtract: (column, path) => `(${column})::jsonb #>> '{${path.replace(/^\$\.?/, "").replace(/\./g, ",")}}'`,
  integerText: (column) => `CAST(${column} AS TEXT)`,
  nowExpression: "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now_value",

  idType: "VARCHAR(36)",
  digestType: "VARCHAR(71)",
  rawDigestType: "BYTEA",
  textType: "TEXT",
  boundedText: (chars) => `VARCHAR(${chars})`,
  blobType: "BYTEA",
  boundedBinary: () => "BYTEA",
  tableSuffix: "",
  eventSeqColumn: "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",

  forUpdate: " FOR UPDATE",
  forShare: " FOR SHARE",

  timeKey: (column) => {
    const fraction = `CASE WHEN length(${column}) > 20 THEN substr(${column}, 21, length(${column}) - 21) ELSE '' END`;
    return `substr(${column}, 1, 19) || substr((${fraction}) || '000000000', 1, 9)`;
  },

  needsRemoteDigest: true,
  remoteDigestExpression: (column) => column,

  readIsolation: "repeatable_read",
  retriesLifecycle: true,
  ddlIsTransactional: true,
  errorAbortsTransaction: true,
  lockWaitTimeoutMs: 30_000,
  // 40001 serialization failure, 40P01 deadlock, 55P03 lock not available
  // (the lock_timeout bound), 57P01 administrator shutdown, 08006/08003
  // connection failure.  PostgreSQL reports SQLSTATE strings, not numbers.
  retryableErrorCodes: ["40001", "40P01", "55P03", "57P01", "08006", "08003", "ECONNRESET", "ETIMEDOUT", "EPIPE"],
  retryableErrnos: [],

  pooled: true,
  inlineForwardForeignKey: false,
  tableExistsSql: (table) => `SELECT COUNT(*) AS present FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '${table}'`,
  columnExistsSql: (table, column) => `SELECT COUNT(*) AS present FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name = '${column}'`,
  userTableCountSql: "SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
  constraintExistsSql: (table, constraint) => `SELECT COUNT(*) AS present FROM information_schema.table_constraints WHERE constraint_schema = current_schema() AND table_name = '${table}' AND constraint_name = '${constraint}'`,
  requiresExplicitLifecycleTransaction: false,
  constraintEditing: {
    foreignKeysSql: (table, _column, referenced) => `SELECT conname AS name FROM pg_constraint WHERE conrelid = '${table}'::regclass AND confrelid = '${referenced}'::regclass AND contype = 'f'`,
    checksSql: table => `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '${table}'::regclass AND contype = 'c'`,
    dropForeignKeySql: (table, constraint) => `ALTER TABLE ${catalogIdentifier(table, '"')} DROP CONSTRAINT ${catalogIdentifier(constraint, '"')}`,
    dropCheckSql: (table, constraint) => `ALTER TABLE ${catalogIdentifier(table, '"')} DROP CONSTRAINT ${catalogIdentifier(constraint, '"')}`,
  },
  // pg_advisory_lock takes a bigint key; the manager derives a stable 64-bit
  // value from the connection identity so two processes on the same database
  // serialize while migrations on another database do not.
  migrationLock: {
    // The lock is taken before the lifecycle transaction begins, so the per-transaction
    // `SET LOCAL lock_timeout` cannot bound it, and a blocking pg_advisory_lock would wait
    // forever behind a stuck holder.  pg_try_advisory_lock returns at once and the caller
    // polls until lockWaitTimeoutMs, so the wait is bounded and surfaces as a retryable error.
    acquireSql: () => "SELECT pg_try_advisory_lock(?::bigint)::int AS acquired",
    releaseSql: () => "SELECT (pg_advisory_unlock(?::bigint))::int AS released",
    waitSeconds: 0,
    pollIntervalMs: 100,
  },
};
