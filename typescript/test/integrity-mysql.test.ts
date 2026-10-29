import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { SQLStore } from "../src/sql-store.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";
import { bindPlaceholders } from "../src/sql-client.js";
import { postgresDialect } from "../src/sql-dialects.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";

const enabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every(k => process.env[`GROUNDS_TEST_MYSQL_${k}`]);
type Row = Record<string, unknown>;
interface RawDatabase { first(sql: string, params?: unknown[]): Promise<Row | undefined>; insertMany(table: string, keys: string[], rows: unknown[][]): Promise<void>; exec(sql: string, params?: unknown[]): Promise<void> }

// One scenario for every networked engine: numeric Intent Links round-trip and integrity paging rejects tail corruption.
const numericLinksScenario = async (f: LedgerFixture, db: RawDatabase): Promise<void> => {
  for (const count of [10, 11, 13, 200]) {
    const outcomes = Array.from({ length: Math.min(count, 100) }, (_, i) => `Outcome ${i}`);
    const decisions = Array.from({ length: Math.max(0, count - 100) }, (_, i) => ({ statement: `Decision ${i}` }));
    const req = await f.module.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent, input: { format: 1, summary: "Numeric links", outcomes, decisions } });
    const traces_to = [...outcomes.map((_, i) => ({ type: "outcome" as const, ordinal: i + 1 })), ...decisions.map((_, i) => ({ type: "decision" as const, ordinal: i + 1 }))];
    const issue = await f.module.createIssue({ operation_id: newUUIDv7(), attribution: testAgent,
      requirement_id: req.result.requirement_id, requirement_revision_id: req.result.requirement_revision_id, requirement_revision_explicit: true,
      repository_id: f.repository.repository_id, baseline: testBaseline, input: { format: 1, summary: "Numeric round trip", goals: [{ statement: "Links", criteria: ["All survive"], traces_to }] } });
    assert.deepEqual((await f.store.read(tx => tx.getIssueRevisionById(issue.result.issue_revision_id))).goals[0].traces_to, traces_to);
  }
  const op = (await db.first("SELECT * FROM idempotency_records ORDER BY operation_id LIMIT 1"))!;
  const event = (await db.first("SELECT * FROM ledger_events WHERE operation_id = ?", [op.operation_id]))!;
  const opKeys = Object.keys(op), eventKeys = Object.keys(event).filter(k => k !== "event_seq");
  const opRows = [], eventRows = [];
  let last = "", lastEvent = "";
  for (let i = 0; i < 1001; i++) {
    last = newUUIDv7(); lastEvent = newUUIDv7();
    opRows.push(opKeys.map(k => k === "operation_id" ? last : op[k]));
    eventRows.push(eventKeys.map(k => k === "operation_id" ? last : k === "event_id" ? lastEvent : event[k]));
  }
  await db.insertMany("idempotency_records", opKeys, opRows);
  await db.insertMany("ledger_events", eventKeys, eventRows);
  assert.deepEqual((await f.store.inspectIntegrity()).report, { valid: true, issues: [] });
  await db.exec("UPDATE idempotency_records SET result_json = ? WHERE operation_id = ?", [Buffer.from('{}'), last]);
  await db.exec("UPDATE ledger_events SET subject_id = ? WHERE event_id = ?", [newUUIDv7(), lastEvent]);
  const bad = (await f.store.inspectIntegrity()).report;
  assert.ok(bad.issues.some(i => i.check === "idempotency" && i.resource_id === last));
  assert.ok(bad.issues.some(i => i.check === "ledger_graph" && i.resource_id === lastEvent));
};

test("MySQL numeric Intent Links and integrity pagination preserve valid rows and reject tail corruption", { skip: !enabled }, async t => {
  const config = { host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306),
    database: process.env.GROUNDS_TEST_MYSQL_DATABASE!, username: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD! };
  const f = await LedgerFixture.createWithStore(SQLStore.mysql({ ...config,
    ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE } : {}) }));
  t.after(() => f.close());
  const { username, ...connection } = config;
  const db = await mysql.createConnection({ ...connection, user: username,
    ssl: { rejectUnauthorized: true, ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { ca: readFileSync(process.env.GROUNDS_TEST_MYSQL_CA_FILE) } : {}) } });
  t.after(() => db.end());
  await numericLinksScenario(f, {
    first: async (sql, params = []) => ((await db.query<mysql.RowDataPacket[]>(sql, params))[0][0] as Row | undefined),
    insertMany: async (table, keys, rows) => { await db.query(`INSERT INTO ${table} (${keys.join(",")}) VALUES ?`, [rows]); },
    exec: async (sql, params = []) => { await db.query(sql, params); },
  });
});

test("PostgreSQL numeric Intent Links and integrity pagination preserve valid rows and reject tail corruption", { skip: !postgresEnabled }, async t => {
  const pg = await isolatedPostgres();
  const f = await LedgerFixture.createWithStore(pg.store, pg.cleanup);
  const db = await pg.raw();
  t.after(async () => { await db.end(); await f.close(); });
  const bound = (sql: string): string => bindPlaceholders(postgresDialect, sql);
  await numericLinksScenario(f, {
    first: async (sql, params = []) => (await db.query(bound(sql), params)).rows[0] as Row | undefined,
    insertMany: async (table, keys, rows) => {
      const statement = `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")})`;
      for (const row of rows) await db.query(statement, row);
    },
    exec: async (sql, params = []) => { await db.query(bound(sql), params); },
  });
});
