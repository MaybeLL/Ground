import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execute, runCLI } from "../src/cli.js";
import { loadConfig, validateConfig } from "../src/config.js";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";

const invalid = (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR";

for (const action of ["data", "patchledger"]) {
  test(`retired migrate ${action} is unavailable, including command help, before accessing storage`, async t => {
    const directory = mkdtempSync(join(tmpdir(), "grounds-retired-migration-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = join(directory, "missing.yaml");
    for (const args of [
      ["migrate", action, "--config", config],
      ["migrate", action, "--help"],
      ["help", "migrate"],
    ]) {
      const lines: string[] = [];
      const code = await runCLI([...args, "--json"], { cwd: directory, stdout: line => lines.push(line), stderr: () => {} });
      const result = JSON.parse(lines.join("\n"));
      assert.equal(code, 2);
      assert.equal(result.error.code, "VALIDATION_ERROR");
      assert.equal(result.operation_id, undefined);
      assertContract("cli-envelope.schema.json", result);
    }
    assert.equal(existsSync(config), false);
    const result = await execute(["--help"]) as { usage: string };
    assert.doesNotMatch(result.usage, /migrate data|migrate patchledger/);
    assert.match(result.usage, /task \| work \| grade/);
  });
}

test("fresh initialization ignores historical locations and leaves every historical byte untouched", t => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-no-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = join(directory, "repo");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q", repository]);
  const root = join(directory, "current");
  const paths = [
    join(directory, "Library", "Application Support", "PatchLedger", "config.yaml"),
    join(directory, "Library", "Application Support", "Grounds", "config.yaml"),
    join(directory, ".config", "patchledger", "config.yaml"),
    join(directory, ".config", "grounds", "config.yaml"),
    join(repository, ".patchledger", "devruns", "record.json"),
    join(repository, ".grounds", "deliveries", "record.json"),
    join(directory, ".grounds", "directory-registry", "migration-active.json"),
    join(root, "migration", "old", "journal.json"),
  ];
  for (const path of paths) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "historical bytes; not valid JSON or config\n");
  }
  const script = `
    import { execute } from './src/cli.ts';
    const config = ${JSON.stringify(join(root, "config.yaml"))};
    await execute(['init', '--non-interactive', '--config', config, '--path', ${JSON.stringify(join(root, "grounds.db"))}], { cwd: ${JSON.stringify(repository)} });
    const result = await execute(['task', 'list', '--config', config], { cwd: ${JSON.stringify(repository)} });
    console.log(JSON.stringify(result));
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, HOME: directory, GROUNDS_CONFIG: "", GROUNDS_DATA_HOME: root,
      XDG_CONFIG_HOME: join(directory, ".config"), XDG_DATA_HOME: join(directory, ".local", "share") },
  });
  assert.deepEqual(JSON.parse(output).tasks, []);
  for (const path of paths) assert.equal(readFileSync(path, "utf8"), "historical bytes; not valid JSON or config\n");
});

test("configuration accepts only the current version and current credential source names", t => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-current-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = { driver: "sqlite", path: join(directory, "db"), expected_database_id: newUUIDv7() };
  assert.throws(() => validateConfig({ version: 1, database }), invalid);
  const path = join(directory, "old.json");
  const content = JSON.stringify({ version: 1, database });
  writeFileSync(path, content);
  assert.throws(() => loadConfig(path), invalid);
  assert.equal(readFileSync(path, "utf8"), content);
  assert.equal(existsSync(database.path), false);
  assert.throws(() => validateConfig({ version: 2, database: {
    driver: "mysql", host: "localhost", port: 3306, database: "test", username: "test", expected_database_id: newUUIDv7(),
    tls: { mode: "verify_identity" }, password: { source: "environment", variable: "PATCHLEDGER_MYSQL_PASSWORD" },
  } }), invalid);
});

test("retired migration errors and recovery instructions are no longer public contracts", () => {
  const valid = { code: "STATE_CONFLICT", message: "operation refused", retryable: false, details: {} };
  assertContract("error.schema.json", valid);
  assertContract("cli-envelope.schema.json", { format: "patchledger.cli/v1", ok: false, error: valid });
  for (const error of [
    { ...valid, code: "BRAND_MIGRATION_REQUIRED" },
    { ...valid, details: { migrate_argv: ["grounds", "migrate", "data"] } },
  ]) {
    assert.throws(() => assertContract("error.schema.json", error));
    assert.throws(() => assertContract("cli-envelope.schema.json", { format: "patchledger.cli/v1", ok: false, error }));
  }
  // SQL schema migration is not retired by this bounded deletion.
  assertContract("error.schema.json", { ...valid, code: "MIGRATION_DIRTY", details: { reason: "incomplete SQL schema migration" } });
});

test("removed migration success types are no longer admitted by the distributed contract", () => {
  for (const result of [
    { result_type: "patchledger.result.brand-migration/v1", command: "migrate.patchledger", dry_run: true, config: { status: "not_found" }, repository: { status: "not_found" } },
    { result_type: "grounds.result.data-migration/v1", command: "migrate.data", phase: "complete", data_root: "/data", journal_path: "/journal", moved_entries: 0 },
  ]) assert.throws(() => assertContract("command-results.schema.json", result));
});
