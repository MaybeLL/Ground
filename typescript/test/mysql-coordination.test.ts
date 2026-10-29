import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";
import type { SqlDialect } from "../src/sql-dialect.js";
import { mysqlDialect } from "../src/sql-dialects.js";

interface MetadataState {
  database_id: string;
  schema_version: number;
  protocol_version: number;
  minimum_cli_version: string;
  remote_normalization_version: number;
  baseline_reachability_policy: string;
  migration_state: string;
}

class RecordingMySQLClient {
  readonly dialect = mysqlDialect;
  readonly log: string[] = [];
  constructor(readonly metadata: MetadataState) {}

  async run(sql: string): Promise<{ changes: number }> {
    this.log.push(`run:${sql}`);
    if (sql.includes("migration_state = 'in_progress'")) this.metadata.migration_state = "in_progress";
    if (sql.includes("migration_state = 'clean'")) {
      this.metadata.schema_version = SCHEMA_VERSION;
      this.metadata.protocol_version = 1;
      this.metadata.minimum_cli_version = "0.1.0";
      this.metadata.remote_normalization_version = 1;
      this.metadata.migration_state = "clean";
    }
    return { changes: 1 };
  }

  async get<T extends Record<string, unknown>>(sql: string): Promise<T | undefined> {
    this.log.push(`get:${sql}`);
    if (sql.includes("GET_LOCK")) return { acquired: 1 } as T;
    if (sql.includes("RELEASE_LOCK")) return { released: 1 } as T;
    if (sql.includes("FROM schema_metadata")) return { ...this.metadata } as T;
    return undefined;
  }

  async all<T extends Record<string, unknown>>(sql: string): Promise<T[]> { this.log.push(`all:${sql}`); return []; }
  async exec(sql: string): Promise<void> { this.log.push(`exec:${sql}`); }
  async begin(write: boolean): Promise<void> { this.log.push(`begin:${write ? "write" : "read"}`); }
  async commit(): Promise<void> { this.log.push("commit"); }
  async rollback(): Promise<void> { this.log.push("rollback"); }
  async close(): Promise<void> { this.log.push("close"); }
}

const createStore = (client: RecordingMySQLClient): SQLStore => {
  const Constructor = SQLStore as unknown as new (
    dialect: SqlDialect,
    connectionFactory: () => Promise<RecordingMySQLClient>,
    closeFactory: () => Promise<void>,
    migrationLockName: string,
  ) => SQLStore;
  return new Constructor(mysqlDialect, async () => client, async () => undefined, "grounds:test");
};

const metadata = (migrationState = "clean"): MetadataState => ({
  database_id: "019c0000-0000-7000-8000-000000000001",
  schema_version: SCHEMA_VERSION,
  protocol_version: 1,
  minimum_cli_version: "0.1.0",
  remote_normalization_version: 1,
  baseline_reachability_policy: "require_override",
  migration_state: migrationState,
});

test("ordinary MySQL write transactions hold an exclusive metadata lock through commit", async () => {
  const client = new RecordingMySQLClient(metadata());
  const store = createStore(client);
  await store.write(async () => "done");
  const gate = client.log.findIndex((entry) => entry.includes("FROM schema_metadata") && entry.endsWith("FOR UPDATE"));
  const commit = client.log.indexOf("commit");
  assert.ok(gate > client.log.indexOf("begin:write"));
  assert.ok(commit > gate);
});

test("MySQL migration drains shared locks and commits in-progress before DDL", async () => {
  const client = new RecordingMySQLClient(metadata("clean"));
  client.metadata.schema_version = 6;
  const store = createStore(client);
  const result = await store.migrate();
  assert.equal(result.migration_state, "clean");

  const exclusiveGate = client.log.findIndex((entry) => entry.includes("FROM schema_metadata") && entry.endsWith("FOR UPDATE"));
  const inProgress = client.log.findIndex((entry) => entry.includes("migration_state = 'in_progress'"));
  const inProgressCommit = client.log.indexOf("commit", inProgress);
  const firstDDL = client.log.findIndex((entry) => entry.startsWith("exec:CREATE TABLE"));
  const clean = client.log.findIndex((entry) => entry.includes("migration_state = 'clean'"));
  assert.ok(exclusiveGate >= 0 && inProgress > exclusiveGate);
  assert.ok(inProgressCommit > inProgress && firstDDL > inProgressCommit);
  assert.ok(clean > firstDDL);
});

test("deadlocks retry the whole transaction within a bounded budget", async () => {
  const client = new RecordingMySQLClient(metadata());
  const store = createStore(client);
  let attempts = 0;
  const result = await store.write(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
    return "committed";
  });
  assert.equal(result, "committed");
  assert.equal(attempts, 3);
  assert.equal(client.log.filter((entry) => entry === "rollback").length, 2);
});
