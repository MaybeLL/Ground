import { isolateStatement } from "../src/sql-shared.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runCLI } from "../src/cli.js";
import { SQLStore, postgresMigrationLockKey } from "../src/sql-store.js";
import { DomainError } from "../src/errors.js";
import { isDuplicateKeyError, isMissingTableError } from "../src/sql-shared.js";
import { newUUIDv7 } from "../src/identity.js";
import { isolatedPostgres, postgresEnabled, postgresTarget, rawConnection } from "./isolated-postgres.js";

const skip = postgresEnabled ? false : "GROUNDS_TEST_PG_* is not configured; PostgreSQL is NOT verified by this run";

test("postgres: TLS identity verification is enforced", { skip }, async () => {
  const target = postgresTarget();
  const pg = await isolatedPostgres();
  try {
    // No CA supplied: the self-signed test server must be rejected, not silently accepted.
    const untrusted = SQLStore.postgres({ ...pg.connection, caFile: undefined }, { retryAttempts: 0 });
    await assert.rejects(untrusted.initialize("warn"), (error) => /self.signed|unable to verify|certificate/i.test(error instanceof Error ? error.message : String(error)));
    await untrusted.close();
    // Plaintext is refused by the driver configuration: the server must have offered TLS to a verifying client.
    const raw = await rawConnection(pg.database, target);
    const ssl = (await raw.query("SHOW ssl")).rows[0].ssl;
    await raw.end();
    assert.equal(ssl, "on", "the test server must really speak TLS for this evidence to count");
  } finally { await pg.cleanup(); }
});

test("postgres: a read transaction sees one snapshot while writers commit", { skip }, async () => {
  const pg = await isolatedPostgres();
  try {
    await pg.store.initialize("warn");
    const reader = await pg.raw();
    const writer = await pg.raw();
    const count = async (client: typeof reader): Promise<number> => Number((await client.query("SELECT count(*) AS n FROM work_counters")).rows[0].n);
    const insert = async (): Promise<void> => {
      const id = newUUIDv7().replaceAll("-", "");
      await writer.query("INSERT INTO work_counters (name, value) VALUES ($1, $2)", [id, 1]);
    };
    // Control: PostgreSQL's default isolation shows the concurrent commit mid-transaction,
    // which is exactly the page-skipping hazard the dialect must avoid.
    await reader.query("BEGIN");
    const controlBefore = await count(reader);
    await insert();
    const controlAfter = await count(reader);
    await reader.query("ROLLBACK");
    assert.equal(controlAfter, controlBefore + 1, "default READ COMMITTED must expose the concurrent write (control)");

    // Subject: the store's own read transaction setup pins the snapshot.
    const { postgresClient } = await import("../src/sql-client.js");
    const { postgresDialect } = await import("../src/sql-dialects.js");
    const client = postgresClient(postgresDialect, reader);
    await client.begin(false, false);
    const before = await count(reader);
    await insert();
    await insert();
    const after = await count(reader);
    await client.rollback();
    assert.equal(after, before, "a paged scan must not see rows committed after it started");
    assert.equal(await count(reader), before + 2, "after the transaction the committed rows are visible");
    await reader.end();
    await writer.end();
  } finally { await pg.cleanup(); }
});

test("postgres: a lock wait is bounded and surfaces as a retryable storage error", { skip }, async () => {
  const pg = await isolatedPostgres({ lockWaitTimeoutMs: 300, retryAttempts: 1 });
  try {
    await pg.store.initialize("warn");
    const holder = await pg.raw();
    await holder.query("BEGIN");
    await holder.query("SELECT * FROM schema_metadata WHERE singleton = 1 FOR UPDATE");
    const started = Date.now();
    await assert.rejects(pg.store.transaction(true, async () => "never"), (error) => error instanceof DomainError && error.code === "STORAGE_TRANSIENT" && error.retryable === true);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `the wait must be bounded by lock_timeout, took ${elapsed}ms`);
    await holder.query("ROLLBACK");
    await holder.end();
    assert.equal(await pg.store.transaction(true, async () => "recovered"), "recovered", "the store must work once the lock is released");
  } finally { await pg.cleanup(); }
});

const holdMigrationLock = async (pg: Awaited<ReturnType<typeof isolatedPostgres>>) => {
  const holder = await pg.raw();
  const key = postgresMigrationLockKey(pg.connection);
  await holder.query("SELECT pg_advisory_lock($1::bigint)", [key]);
  return { release: async () => { await holder.query("SELECT pg_advisory_unlock($1::bigint)", [key]); await holder.end(); } };
};

test("postgres: another holder of the migration lock makes initialize fail fast and retryable", { skip }, async () => {
  // The default retry budget is kept on purpose: the wait is one bound, not one bound per retry.
  const pg = await isolatedPostgres({ lockWaitTimeoutMs: 500 });
  try {
    const held = await holdMigrationLock(pg);
    for (const [name, call] of [["initialize", () => pg.store.initialize("warn")]] as const) {
      const started = Date.now();
      await assert.rejects(call(), (error) => error instanceof DomainError && error.code === "STORAGE_TRANSIENT" && error.retryable === true, name);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2500, `${name} must wait at most the lock bound once, took ${elapsed}ms`);
    }
    await held.release();
    const initialized = await pg.store.initialize("warn");
    assert.equal(initialized.action, "initialized", "once the holder lets go the lifecycle call proceeds");
    assert.equal((await pg.store.open()).migration_state, "clean");
  } finally { await pg.cleanup(); }
});

test("postgres: the store keeps working after the server terminates its idle connections", { skip }, async () => {
  const pg = await isolatedPostgres();
  try {
    await pg.store.initialize("warn");
    assert.equal(await pg.store.transaction(true, async () => "before"), "before");
    assert.ok((await pg.store.transaction(false, async () => 1)) === 1);
    const admin = await rawConnection(process.env.GROUNDS_TEST_PG_DATABASE ?? "postgres");
    try { await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [pg.database]); }
    finally { await admin.end(); }
    // An idle pooled connection that the server closes is reported on the pool, not on a query.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await pg.store.transaction(true, async () => "after"), "after");
  } finally { await pg.cleanup(); }
});

test("postgres: a transaction survives the server terminating its checked-out connection", { skip }, async () => {
  // The process must not die: a termination reported on a checked-out connection
  // that nothing is listening to is an unhandled 'error' event.  Only a
  // subprocess can show that, so the crash is an exit code, not an assertion.
  const pg = await isolatedPostgres();
  try {
    const worker = fileURLToPath(new URL("./postgres-termination-worker.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--import", "tsx", worker, pg.database], { encoding: "utf8", timeout: 30000, env: process.env });
    assert.equal(run.status, 0, `the process must survive a mid-transaction termination\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
    const outcome = JSON.parse(run.stdout.trim());
    assert.equal(outcome.result.one, 1, "the transaction is retried on a fresh connection and completes");
    assert.ok(outcome.attempts >= 2, "the terminated attempt is retried, not silently accepted");
    assert.equal(outcome.afterwards, "still-works", "later work uses a healthy pooled connection");
  } finally { await pg.cleanup(); }
});

test("postgres: a failed statement aborts the transaction unless the caller isolates it", { skip }, async () => {
  const pg = await isolatedPostgres();
  try {
    await pg.store.initialize("warn");
    const duplicate = "INSERT INTO work_counters (name, value) VALUES (?, ?)";
    const args = ["test", 1];
    await pg.store.transaction(true, client => client.run(duplicate, args));
    // The engine behaviour the dialect declares with errorAbortsTransaction: without isolation the
    // statement after a handled error is refused.
    const raw = await pg.raw();
    try {
      await raw.query("BEGIN");
      await assert.rejects(raw.query("INSERT INTO work_counters (name, value) VALUES ($1, $2)", args), (error: { code?: string }) => isDuplicateKeyError(error));
      await assert.rejects(raw.query("SELECT 1"), (error: { code?: string }) => error.code === "25P02");
      await raw.query("ROLLBACK");
    } finally { await raw.end(); }
    // The store's own helper isolates it, so duplicate-key and missing-table probes can carry on.
    await pg.store.transaction(true, async (tx) => {
      await assert.rejects(isolateStatement(tx, () => tx.run(duplicate, args)), (error) => isDuplicateKeyError(error));
      await assert.rejects(isolateStatement(tx, () => tx.get("SELECT 1 FROM table_that_does_not_exist")), (error) => isMissingTableError(error));
      assert.equal(Number((await tx.get("SELECT 1 AS one"))?.one), 1, "the transaction is still usable after handled failures");
    });
  } finally { await pg.cleanup(); }
});

test("postgres: concurrent initialization serializes on the advisory lock", { skip }, async () => {
  const pg = await isolatedPostgres();
  try {
    const second = pg.open();
    const outcomes = await Promise.all([pg.store.initialize("warn"), second.initialize("warn")]);
    assert.deepEqual(outcomes.map((outcome) => outcome.action).sort(), ["attached", "initialized"]);
    assert.equal(outcomes[0].metadata.database_id, outcomes[1].metadata.database_id);
    const raw = await pg.raw();
    assert.equal(Number((await raw.query("SELECT count(*) AS n FROM schema_metadata")).rows[0].n), 1);
    await raw.end();
  } finally { await pg.cleanup(); }
});

test("postgres: init and status work through the public CLI and no secret reaches output or config", { skip }, async () => {
  const pg = await isolatedPostgres();
  const directory = mkdtempSync(join(tmpdir(), "grounds-pg-cli-"));
  const target = postgresTarget();
  const previous = process.env.GROUNDS_POSTGRES_PASSWORD;
  process.env.GROUNDS_POSTGRES_PASSWORD = target.password;
  const configFile = join(directory, "config.yaml");
  const run = async (args: string[]): Promise<{ status: number; text: string; json: { ok: boolean; error?: { code: string }; data?: Record<string, unknown> } }> => {
    const lines: string[] = [];
    const status = await runCLI([...args, "--json", "--config", configFile], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
    const text = lines.join("\n");
    return { status, text, json: JSON.parse(lines[0]) };
  };
  try {
    const init = await run(["init", "--driver", "postgres", "--non-interactive", "--host", target.host, "--port", String(target.port), "--database", pg.database, "--username", target.username, "--password-source", "environment", "--tls-mode", "verify_identity", ...(target.caFile ? ["--ca-file", target.caFile] : []), "--confirm-initialize", "--baseline-policy", "require_override"]);
    assert.equal(init.json.ok, true, init.text);
    const written = readFileSync(configFile, "utf8");
    assert.match(written, /driver: postgres/);
    assert.match(written, /GROUNDS_POSTGRES_PASSWORD/);

    const status = await run(["db", "status"]);
    assert.equal(status.json.ok, true, status.text);

    for (const surface of [init.text, status.text, written]) {
      assert.equal(surface.includes(target.password), false, "the password must never appear in output or configuration");
    }

    // A config that points at a different database identity is refused.
    writeFileSync(configFile, written.replace(/expected_database_id: .*/, `expected_database_id: ${newUUIDv7()}`));
    const mismatch = await run(["task", "list"]);
    assert.equal(mismatch.json.ok, false);
    assert.equal(mismatch.json.error?.code, "DATABASE_ID_MISMATCH");
  } finally {
    if (previous === undefined) delete process.env.GROUNDS_POSTGRES_PASSWORD; else process.env.GROUNDS_POSTGRES_PASSWORD = previous;
    rmSync(directory, { recursive: true, force: true });
    await pg.cleanup();
  }
});
