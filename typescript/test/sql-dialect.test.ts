import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindPlaceholders, DatabaseSync, sqliteClient } from "../src/sql-client.js";
import type { SqlDialect } from "../src/sql-dialect.js";
import { mysqlDialect, postgresDialect, sqliteDialect } from "../src/sql-dialects.js";
import { schemaStatements } from "../src/sql-schema.js";
import { isSafeTransactionRetry, mapStorageError } from "../src/sql-shared.js";
import { SQLStore } from "../src/sql-store.js";
import { DomainError, storageTransient } from "../src/errors.js";
import { LedgerFixture } from "./fixture.js";

const dialects: SqlDialect[] = [sqliteDialect, mysqlDialect, postgresDialect];
const sourceDirectory = new URL("../src/", import.meta.url);
const sqlModules = readdirSync(sourceDirectory).filter((name) => /^sql-.*\.ts$/.test(name));

// --- G1: the dialect exposes syntax primitives AND transaction capabilities ---

test("every dialect states each transaction capability explicitly", () => {
  for (const dialect of dialects) {
    assert.ok(["database_default", "repeatable_read"].includes(dialect.readIsolation), `${dialect.name} readIsolation`);
    assert.equal(typeof dialect.ddlIsTransactional, "boolean", `${dialect.name} ddlIsTransactional`);
    assert.ok(Number.isFinite(dialect.lockWaitTimeoutMs) && dialect.lockWaitTimeoutMs > 0, `${dialect.name} lock wait must be bounded`);
    assert.ok(dialect.retryableErrorCodes.length > 0, `${dialect.name} retryable codes`);
    assert.equal(typeof dialect.pooled, "boolean");
    assert.equal(typeof dialect.inlineForwardForeignKey, "boolean");
  }
});

test("capabilities that fail silently are pinned to the verified engine behaviour", () => {
  // PostgreSQL defaults to READ COMMITTED, where each statement sees a fresh
  // snapshot and a paged scan can skip or repeat rows; it must ask for more.
  assert.equal(postgresDialect.readIsolation, "repeatable_read");
  assert.equal(mysqlDialect.readIsolation, "repeatable_read");
  // MySQL DDL auto-commits; SQLite and PostgreSQL DDL can roll back.
  assert.equal(mysqlDialect.ddlIsTransactional, false);
  assert.equal(sqliteDialect.ddlIsTransactional, true);
  assert.equal(postgresDialect.ddlIsTransactional, true);
  // A blocking pg_advisory_lock runs outside any transaction, where lock_timeout does not apply;
  // PostgreSQL's lock is therefore polled against lockWaitTimeoutMs.  MySQL's GET_LOCK waits
  // inside the statement with its own limit; SQLite has no lock at all.
  assert.ok((postgresDialect.migrationLock?.pollIntervalMs ?? 0) > 0);
  assert.equal(postgresDialect.migrationLock?.waitSeconds, 0);
  assert.equal(mysqlDialect.migrationLock?.pollIntervalMs, undefined);
  assert.ok((mysqlDialect.migrationLock?.waitSeconds ?? 0) > 0);
  assert.equal(sqliteDialect.migrationLock, undefined);
});

test("syntax primitives differ per engine but share one calling convention", () => {
  const sample = ["json", "$.data.state"] as const;
  assert.equal(sqliteDialect.jsonExtract(...sample), "json_extract(json, '$.data.state')");
  assert.equal(mysqlDialect.jsonExtract(...sample), "JSON_UNQUOTE(JSON_EXTRACT(json, '$.data.state'))");
  // TEXT columns need the jsonb cast; the expression text alone cannot prove it runs, which the
  // eval-list conformance test on a real PostgreSQL does.
  assert.equal(postgresDialect.jsonExtract(...sample), "(json)::jsonb #>> '{data,state}'");
  assert.equal(sqliteDialect.integerText("n"), "CAST(n AS TEXT)");
  assert.equal(mysqlDialect.integerText("n"), "CAST(n AS CHAR)");
  assert.equal(postgresDialect.integerText("n"), "CAST(n AS TEXT)");
});

// --- placeholders ---

test("question-mark dialects pass SQL through untouched", () => {
  const sql = "SELECT a FROM t WHERE x = ? AND y = ?";
  assert.equal(bindPlaceholders(sqliteDialect, sql), sql);
  assert.equal(bindPlaceholders(mysqlDialect, sql), sql);
});

test("PostgreSQL placeholders are numbered and literals are left alone", () => {
  assert.equal(bindPlaceholders(postgresDialect, "SELECT a FROM t WHERE x = ? AND y = ?"), "SELECT a FROM t WHERE x = $1 AND y = $2");
  assert.equal(bindPlaceholders(postgresDialect, "SELECT '?' AS q, x FROM t WHERE y = ?"), "SELECT '?' AS q, x FROM t WHERE y = $1");
  assert.equal(bindPlaceholders(postgresDialect, 'SELECT "weird?col" FROM t WHERE y = ?'), 'SELECT "weird?col" FROM t WHERE y = $1');
  assert.equal(bindPlaceholders(postgresDialect, "SELECT 'it''s ?' FROM t WHERE y = ?"), "SELECT 'it''s ?' FROM t WHERE y = $1");
});

// --- retry classification is driven by the dialect ---

test("each dialect retries only its own transient failures", () => {
  const sqlstate = (code: string) => Object.assign(new Error(code), { code });
  for (const code of ["40001", "40P01", "55P03"]) {
    assert.equal(isSafeTransactionRetry(sqlstate(code), postgresDialect), true, `postgres ${code}`);
    assert.equal(isSafeTransactionRetry(sqlstate(code), sqliteDialect), false, `sqlite must not retry ${code}`);
    assert.equal(isSafeTransactionRetry(sqlstate(code), mysqlDialect), false, `mysql must not retry ${code}`);
  }
  assert.equal(isSafeTransactionRetry(sqlstate("SQLITE_BUSY"), sqliteDialect), true);
  assert.equal(isSafeTransactionRetry(sqlstate("SQLITE_BUSY"), postgresDialect), false);
  assert.equal(isSafeTransactionRetry(Object.assign(new Error("d"), { code: "ER_LOCK_DEADLOCK", errno: 1213 }), mysqlDialect), true);
  assert.equal(isSafeTransactionRetry(Object.assign(new Error("n"), { errno: 1205 }), mysqlDialect), true);
  assert.equal(isSafeTransactionRetry(Object.assign(new Error("b"), { errno: 5 }), sqliteDialect), true);
});

test("non-transient failures are not retried and stay unmapped", () => {
  const duplicate = Object.assign(new Error("duplicate key"), { code: "23505" });
  for (const dialect of dialects) {
    assert.equal(isSafeTransactionRetry(duplicate, dialect), false);
    assert.equal(mapStorageError(duplicate, dialect), duplicate);
  }
});

test("a lock timeout surfaces as the retryable storage-transient error", () => {
  const timeout = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
  const mapped = mapStorageError(timeout, postgresDialect);
  assert.ok(mapped instanceof DomainError);
  assert.equal((mapped as DomainError).code, "STORAGE_TRANSIENT");
  assert.equal((mapped as DomainError).retryable, true);
  assert.equal(isSafeTransactionRetry(storageTransient("x", 1), sqliteDialect), true);
});

// --- schema shapes: same tables everywhere, no foreign syntax ---

test("every dialect creates the same set of tables", () => {
  const names = (dialect: SqlDialect): string[] => schemaStatements(dialect)
    .map((statement) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)?.[1] ?? "")
    .sort();
  const reference = names(sqliteDialect);
  assert.ok(reference.length > 30);
  assert.deepEqual(names(mysqlDialect), reference);
  assert.deepEqual(names(postgresDialect), reference);
});

test("each dialect's DDL uses only its own column types", () => {
  const ddl = (dialect: SqlDialect): string => schemaStatements(dialect).join("\n");
  const postgres = ddl(postgresDialect);
  for (const foreign of ["BINARY(32)", "LONGTEXT", "LONGBLOB", "AUTOINCREMENT", "AUTO_INCREMENT", "VARBINARY"]) {
    assert.ok(!postgres.includes(foreign), `PostgreSQL DDL must not contain ${foreign}`);
  }
  assert.ok(postgres.includes("BYTEA") && postgres.includes("GENERATED BY DEFAULT AS IDENTITY"));
  const mysql = ddl(mysqlDialect);
  for (const foreign of ["BYTEA", "AUTOINCREMENT", "GENERATED"]) assert.ok(!mysql.includes(foreign), `MySQL DDL must not contain ${foreign}`);
  const sqlite = ddl(sqliteDialect);
  for (const foreign of ["BYTEA", "LONGTEXT", "AUTO_INCREMENT", "GENERATED", "BINARY(32)"]) assert.ok(!sqlite.includes(foreign), `SQLite DDL must not contain ${foreign}`);
});

// --- source guards for G1-c3 and G2-c1 ---

test("transaction, schema and migration code never branches on a dialect name", () => {
  const engineSpecific = new Set(["sql-dialects.ts", "sql-client.ts"]);
  const forbidden = [
    /dialect(\.name)?\s*[!=]==?\s*["']/,
    /\.name\s*[!=]==?\s*["'](sqlite|mysql|postgres)["']/,
    /["'](sqlite|mysql|postgres)["']\s*[!=]==/,
  ];
  const offenders: string[] = [];
  for (const name of sqlModules.filter((module) => !engineSpecific.has(module))) {
    readFileSync(new URL(name, sourceDirectory), "utf8").split("\n").forEach((line, index) => {
      if (forbidden.some((pattern) => pattern.test(line))) offenders.push(`${name}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("no database access module exceeds 800 lines", () => {
  assert.ok(sqlModules.length >= 8, "expected the split modules to exist");
  for (const name of sqlModules) {
    const lines = readFileSync(new URL(name, sourceDirectory), "utf8").split("\n").length;
    assert.ok(lines <= 800, `${name} has ${lines} lines`);
  }
});

test("the schema version is defined once, so the modules cannot drift apart", () => {
  const definitions = sqlModules.filter((name) => /^export const SCHEMA_VERSION\b/m.test(readFileSync(new URL(name, sourceDirectory), "utf8")));
  assert.deepEqual(definitions, ["sql-schema.ts"]);
});

// --- G1-c5: a test-double dialect drives the whole business layer ---

test("a test-double dialect runs the full business layer without a known dialect name", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-dialect-double-"));
  const consulted = new Set<string>();
  const double: SqlDialect = {
    ...sqliteDialect,
    name: "test-double" as SqlDialect["name"],
    integerText: (column) => { consulted.add("integerText"); return sqliteDialect.integerText(column); },
    jsonExtract: (column, path) => { consulted.add("jsonExtract"); return sqliteDialect.jsonExtract(column, path); },
    timeKey: (column) => { consulted.add("timeKey"); return sqliteDialect.timeKey(column); },
  };
  const database = new DatabaseSync(join(directory, "ledger.db"));
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  const client = sqliteClient(double, database);
  const Constructor = SQLStore as unknown as new (
    dialect: SqlDialect, factory: () => Promise<typeof client>, close: () => Promise<void>, lockKey: string, retries: number,
  ) => SQLStore;
  const store = new Constructor(double, async () => client, async () => undefined, "", 7);
  const fixture = await LedgerFixture.createWithStore(store, async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  try {
    const submitted = await fixture.submitCandidate("double");
    assert.ok(submitted.candidate.candidate_id);
    const { report } = await store.inspectIntegrity();
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.ok(consulted.has("integerText"), "business code must go through the dialect, not a name check");
  } finally {
    await fixture.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
