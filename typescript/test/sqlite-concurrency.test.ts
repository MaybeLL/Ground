import type { SqlDialect } from "../src/sql-dialect.js";
import { sqliteDialect } from "../src/sql-dialects.js";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DomainError } from "../src/errors.js";
import { Module } from "../src/module.js";
import { SQLStore } from "../src/sql-store.js";

const tsxLoader = import.meta.resolve("tsx");

const holderSource = String.raw`
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[1]);
database.exec("PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
process.stdout.write("ready\n");
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  try { database.exec("ROLLBACK"); } catch {}
  database.close();
  process.exit(0);
};
setTimeout(finish, Number(process.argv[2]));
process.stdin.once("data", finish);
process.stdin.resume();
`;

const lockDatabase = async (database: string, holdMilliseconds: number): Promise<ChildProcessWithoutNullStreams> => {
  const child = spawn(process.execPath, ["-e", holderSource, database, String(holdMilliseconds)], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise<void>((resolveReady, reject) => {
    let output = "";
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes("ready\n")) { child.stdout.off("data", onData); resolveReady(); }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => { if (!output.includes("ready\n")) reject(new Error(`lock holder exited ${code}: ${output}`)); });
  });
  return child;
};

const release = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null) return;
  child.stdin.write("release\n");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
};

const runProcess = async (args: string[], cwd = resolve(".")): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
  return { code, stdout, stderr };
};

test("a real CLI read waits for another process's SQLite writer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-sqlite-process-"));
  const database = join(directory, "ledger.db");
  const config = join(directory, "config.yaml");
  try {
    const initialized = await runProcess(["--import", tsxLoader, "src/main.ts", "init", "--driver", "sqlite", "--path", database, "--config", config, "--non-interactive", "--json"]);
    assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
    const holder = await lockDatabase(database, 300);
    const reader = await runProcess(["--import", tsxLoader, "src/main.ts", "requirement", "list", "--config", config, "--json"]);
    await release(holder);
    assert.equal(reader.code, 0, reader.stderr || reader.stdout);
    const envelope = JSON.parse(reader.stdout) as { ok: boolean; error?: { code: string } };
    assert.equal(envelope.ok, true);
    assert.notEqual(envelope.error?.code, "INTERNAL");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent real CLI reads and Workspace publications never return INTERNAL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-sqlite-cli-race-"));
  const repository = join(directory, "repo");
  const database = join(directory, "ledger.db");
  const config = join(directory, "config.yaml");
  const source = resolve("src/main.ts");
  try {
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["config", "user.name", "T"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "t@example.test"], { cwd: repository });
    writeFileSync(join(repository, "a.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repository });
    execFileSync("git", ["remote", "add", "origin", "ssh://git@example.test/team/concurrent-cli"], { cwd: repository });
    const initialized = await runProcess(["--import", tsxLoader, source, "init", "--driver", "sqlite", "--path", database, "--config", config, "--non-interactive", "--json"]);
    assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
    const versions = new Map<string,string>();
    for (const name of ["left", "right"]) {
      const created = await runProcess(["--import", tsxLoader, source, "workspace", "new", name, "--config", config, "--json"], repository);
      assert.equal(created.code, 0, created.stderr || created.stdout);
      const read = await runProcess(["--import", tsxLoader, source, "workspace", "read", name, "--config", config, "--json"], repository);
      assert.equal(read.code, 0, read.stderr || read.stdout);
      versions.set(name,JSON.parse(read.stdout).data.version);
    }
    const publish = (name: string): Promise<{ code: number | null; stdout: string; stderr: string }> => runProcess(["--import", tsxLoader, source, "workspace", "publish", name, "--expected-version", versions.get(name)!, "--config", config, "--agent-id", "race-agent", "--agent-name", "Race Agent", "--json"], repository);
    const writes = await Promise.all([publish("left"), publish("right")]);
    assert.ok(writes.every((result) => result.code === 0), JSON.stringify(writes));
    assert.ok(writes.every((result) => result.stdout.trim()), JSON.stringify(writes));
    const envelopes = writes.map((result) => JSON.parse(result.stdout));
    assert.ok(envelopes.every((envelope) => envelope.ok === true));
    assert.equal(envelopes[0].data.repository_id, envelopes[1].data.repository_id);
    assert.notEqual(envelopes[0].data.requirement.id, envelopes[1].data.requirement.id);

    const readArgs = ["--import", tsxLoader, source, "requirement", "list", "--config", config, "--json"];
    const reads = await Promise.all([runProcess(readArgs), runProcess(readArgs), runProcess(readArgs)]);
    assert.ok(reads.every((result) => result.code === 0), JSON.stringify(reads));
    assert.ok(reads.every((result) => JSON.parse(result.stdout).error?.code !== "INTERNAL"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exhausted SQLite lock retries map to retryable STORAGE_TRANSIENT", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-sqlite-timeout-"));
  const database = join(directory, "ledger.db");
  const initializer = SQLStore.sqlite(database);
  await initializer.initialize("warn");
  await initializer.close();
  const holder = await lockDatabase(database, 5000);
  const store = SQLStore.sqlite(database, { busyTimeoutMs: 25, retryAttempts: 2 });
  try {
    await assert.rejects(
      new Module(store).listRequirements(),
      (error: unknown) => error instanceof DomainError && error.code === "STORAGE_TRANSIENT" && error.retryable,
    );
  } finally {
    await store.close();
    await release(holder);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite lifecycle entrypoints retry lazy connection failures and never leak INTERNAL", async () => {
  const Constructor = SQLStore as unknown as new (
    dialect: SqlDialect,
    connectionFactory: () => Promise<never>,
    closeFactory: () => Promise<void>,
    migrationLockName: string,
    retryAttempts: number,
  ) => SQLStore;
  for (const entrypoint of ["open", "classifyTarget", "inspect", "inspectIntegrity"] as const) {
    let attempts = 0;
    const store = new Constructor(sqliteDialect, async () => {
      attempts += 1;
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errno: 5 });
    }, async () => undefined, "", 2);
    await assert.rejects(
      store[entrypoint](),
      (error: unknown) => error instanceof DomainError && error.code === "STORAGE_TRANSIENT" && error.retryable,
    );
    assert.equal(attempts, 3, entrypoint);
  }
});
