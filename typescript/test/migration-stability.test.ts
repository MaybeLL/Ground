import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync, sqliteClient, type SQLClient } from "../src/sql-client.js";
import { sqliteDialect } from "../src/sql-dialects.js";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";

const withDirectory = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-migration-"));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};

/** Every row of every table plus the schema text: a full logical dump. */
const dump = (path: string): string => {
  const database = new DatabaseSync(path);
  try {
    const tables = database.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { name: string; sql: string }[];
    const body = tables.map((table) => {
      const isTable = /^CREATE TABLE/i.test(table.sql ?? "");
      const rows = isTable ? database.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all() : [];
      return { name: table.name, sql: table.sql, rows };
    });
    return JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value));
  } finally { database.close(); }
};

/** Column structure per table, order-insensitive: ADD COLUMN appends, CREATE TABLE does not. */
const structure = (path: string): Record<string, string[]> => {
  const database = new DatabaseSync(path);
  try {
    const result: Record<string, string[]> = {};
    for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
      const columns = database.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
      result[name] = columns.map((column) => `${column.name}|${column.type}|${column.notnull}|${column.dflt_value ?? ""}|${column.pk}`).sort();
    }
    return result;
  } finally { database.close(); }
};

/** Wraps a real client and records every statement that reaches the engine. */
class SpyClient implements SQLClient {
  readonly statements: string[] = [];
  constructor(private readonly inner: SQLClient) {}
  get dialect() { return this.inner.dialect; }
  run(sql: string, params?: unknown[]) { this.statements.push(sql); return this.inner.run(sql, params); }
  get<T extends Record<string, unknown>>(sql: string, params?: unknown[]) { this.statements.push(sql); return this.inner.get<T>(sql, params); }
  all<T extends Record<string, unknown>>(sql: string, params?: unknown[]) { this.statements.push(sql); return this.inner.all<T>(sql, params); }
  exec(sql: string) { this.statements.push(sql); return this.inner.exec(sql); }
  begin(write: boolean, gated?: boolean) { return this.inner.begin(write, gated); }
  commit() { return this.inner.commit(); }
  rollback() { return this.inner.rollback(); }
  close() { return this.inner.close(); }
}

const spiedStore = (path: string): { store: SQLStore; spy: SpyClient } => {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  const spy = new SpyClient(sqliteClient(sqliteDialect, database));
  const Constructor = SQLStore as unknown as new (
    dialect: typeof sqliteDialect, factory: () => Promise<SpyClient>, close: () => Promise<void>, lockKey: string, retries: number,
  ) => SQLStore;
  return { store: new Constructor(sqliteDialect, async () => spy, async () => undefined, "", 7), spy };
};

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA\s+\w+\s*=)/i;

test("migrating a database that is already current performs no DDL or DML", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "ledger.db");
    const seed = SQLStore.sqlite(path);
    await seed.initialize("warn");
    const before = await seed.inspect();
    await seed.close();
    const dumpBefore = dump(path);

    const { store, spy } = spiedStore(path);
    const after = await store.migrate();

    assert.equal(after.schema_version, SCHEMA_VERSION);
    assert.equal(after.migration_state, "clean");
    assert.equal(after.database_id, before.database_id);
    assert.deepEqual(spy.statements.filter((statement) => WRITE.test(statement)), [], "no write statement may reach the engine");
    assert.ok(spy.statements.length > 0, "the spy must have observed the metadata read");
    assert.equal(dump(path), dumpBefore, "table contents and schema text must be byte-identical");
  });
});

test("migration history is preserved when an older database is brought forward", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "ledger.db");
    const seed = SQLStore.sqlite(path);
    await seed.initialize("warn");
    await seed.close();
    const database = new DatabaseSync(path);
    database.exec("DROP TABLE runtime_records; UPDATE schema_metadata SET schema_version = 17; DELETE FROM schema_migrations WHERE schema_version = 20");
    const recordedBefore = (database.prepare("SELECT schema_version FROM schema_migrations ORDER BY schema_version").all() as { schema_version: number }[]).map((row) => row.schema_version);
    database.close();

    const store = SQLStore.sqlite(path);
    try { await store.migrate(); } finally { await store.close(); }

    const after = new DatabaseSync(path);
    const recordedAfter = (after.prepare("SELECT schema_version FROM schema_migrations ORDER BY schema_version").all() as { schema_version: number }[]).map((row) => row.schema_version);
    after.close();
    for (const version of recordedBefore) assert.ok(recordedAfter.includes(version), `migration record ${version} must survive`);
    assert.ok(recordedAfter.includes(SCHEMA_VERSION));
  });
});

test("an older existing database migrates to exactly the structure a new database gets", async () => {
  await withDirectory(async (directory) => {
    const freshPath = join(directory, "fresh.db");
    const fresh = SQLStore.sqlite(freshPath);
    await fresh.initialize("warn");
    await fresh.close();

    const legacyPath = join(directory, "legacy.db");
    const legacy = SQLStore.sqlite(legacyPath);
    await legacy.initialize("warn");
    await legacy.close();
    // Rebuild an older shape: drop the storage added in later schema versions and
    // the additive columns that CREATE TABLE IF NOT EXISTS cannot install.
    const database = new DatabaseSync(legacyPath);
    database.exec(`
      DROP TABLE runtime_records;
      DROP TABLE issue_target_branches;
      DROP TABLE dev_run_bases;
      DROP TABLE candidate_bases;
      DROP TABLE verification_quality_reviews;
      ALTER TABLE candidate_claim_criteria DROP COLUMN self_verification_json;
      ALTER TABLE requirement_decisions DROP COLUMN details_json;
      UPDATE schema_metadata SET schema_version = 17;
      DELETE FROM schema_migrations WHERE schema_version = ${SCHEMA_VERSION};
    `);
    database.close();
    assert.notDeepEqual(structure(legacyPath), structure(freshPath), "the rebuilt database must really differ before migration");

    const { store: migrator, spy } = spiedStore(legacyPath);
    await migrator.migrate();
    assert.equal((await migrator.inspectIntegrity()).report.valid, true);
    // Control for the zero-write test above: the same spy must see writes here.
    assert.ok(spy.statements.some((statement) => WRITE.test(statement)), "the spy must observe DDL/DML when a migration really runs");

    assert.deepEqual(structure(legacyPath), structure(freshPath));
  });
});
