import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { stringify } from "yaml";
import { legacyBrandState, migratePatchLedgerBrand, requireNoLegacyBrandState } from "../src/brand-migration.js";
import { execute } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { DomainError } from "../src/errors.js";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const repository = (): { root: string; repo: string } => {
  const root = mkdtempSync(join(tmpdir(), "grounds-brand-migration-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  git(repo, "config", "user.name", "Migration Test");
  git(repo, "config", "user.email", "migration@example.test");
  writeFileSync(join(repo, "tracked.txt"), "baseline\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "baseline");
  return { root, repo };
};

test("repository migration dry-run is read-only, then moves local state and Git metadata", async () => {
  const fixture = repository();
  const oldRoot = join(fixture.repo, ".patchledger");
  const newRoot = join(fixture.repo, ".grounds");
  const run = "run-one";
  const oldWorktree = join(oldRoot, "devruns", run, "worktree");
  const newWorktree = join(newRoot, "devruns", run, "worktree");
  const noConfig = join(fixture.root, "missing-legacy-config.yaml");
  try {
    mkdirSync(join(oldRoot, "authoring", "draft"), { recursive: true });
    writeFileSync(join(oldRoot, "authoring", "draft", "requirement.md"), "# Draft\n");
    mkdirSync(join(oldRoot, "devruns", run), { recursive: true });
    git(fixture.repo, "worktree", "add", "--detach", oldWorktree, "HEAD");
    writeFileSync(join(oldWorktree, "dirty.txt"), "preserve me\n");
    writeFileSync(join(oldRoot, "devruns", run, "state.json"), JSON.stringify({ worktree_path: oldWorktree }) + "\n");
    writeFileSync(join(fixture.repo, ".git", "info", "exclude"), "/.patchledger/\n");
    writeFileSync(join(fixture.repo, ".git", "patchledger-review.json"), "{}\n");
    mkdirSync(join(fixture.repo, ".git", "patchledger-deliveries"));

    const dryRun = await migratePatchLedgerBrand({ cwd: fixture.repo, legacyConfig: noConfig, dryRun: true });
    assert.equal(dryRun.repository.status, "planned");
    assert.equal(dryRun.repository.moved_worktrees, 1);
    assert.equal(existsSync(oldRoot), true);
    assert.equal(existsSync(newRoot), false);

    const migrated = await migratePatchLedgerBrand({ cwd: fixture.repo, legacyConfig: noConfig, dryRun: false });
    assert.equal(migrated.repository.status, "migrated");
    assert.equal(existsSync(oldRoot), false);
    assert.equal(readFileSync(join(newRoot, "authoring", "draft", "requirement.md"), "utf8"), "# Draft\n");
    assert.equal(readFileSync(join(newWorktree, "dirty.txt"), "utf8"), "preserve me\n");
    assert.equal(JSON.parse(readFileSync(join(newRoot, "devruns", run, "state.json"), "utf8")).worktree_path, resolve(git(fixture.repo, "worktree", "list", "--porcelain").split("\n").find((line) => line.startsWith("worktree ") && line.endsWith("/.grounds/devruns/run-one/worktree"))!.slice(9)));
    assert.match(git(fixture.repo, "worktree", "list", "--porcelain"), /worktree .*\/\.grounds\/devruns\/run-one\/worktree/);
    assert.equal(existsSync(join(fixture.repo, ".git", "grounds-review.json")), true);
    assert.equal(existsSync(join(fixture.repo, ".git", "grounds-deliveries")), true);
    const exclude = readFileSync(join(fixture.repo, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\/\.grounds\/\*$/m);
    assert.match(exclude, /^!\/\.grounds\/environments\/$/m);
    assert.doesNotMatch(exclude, /^\/\.patchledger\/$/m);
    assert.deepEqual(legacyBrandState(fixture.repo, noConfig), { required: false, reasons: [] });
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("config migration upgrades v1 while preserving a custom SQLite database identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-config-migration-"));
  const source = join(root, "legacy", "config.yaml");
  const target = join(root, "grounds", "config.yaml");
  const database = join(root, "custom-ledger.db");
  const previous = process.env.GROUNDS_CONFIG;
  try {
    const store = SQLStore.sqlite(database);
    const initialized = await store.initialize("warn");
    await store.close();
    const legacyDatabase = new DatabaseSync(database);
    legacyDatabase.exec("ALTER TABLE candidate_claim_criteria DROP COLUMN self_verification_json; UPDATE schema_metadata SET schema_version=14; DELETE FROM schema_migrations WHERE schema_version=20");
    legacyDatabase.close();
    mkdirSync(join(root, "legacy"), { recursive: true });
    writeFileSync(source, stringify({ version: 1, database: { driver: "sqlite", path: database, expected_database_id: initialized.metadata.database_id } }));
    process.env.GROUNDS_CONFIG = target;

    const dryRun = await migratePatchLedgerBrand({ cwd: root, legacyConfig: source, dryRun: true });
    assert.equal(dryRun.config.status, "planned");
    assert.equal(existsSync(source), true);
    assert.equal(existsSync(target), false);

    const result = await migratePatchLedgerBrand({ cwd: root, legacyConfig: source, dryRun: false });
    assert.equal(result.config.status, "migrated");
    const config = loadConfig(target);
    assert.equal(config.version, 2);
    assert.equal(config.database.path, database);
    assert.equal(config.database.expected_database_id, initialized.metadata.database_id);
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(join(root, "grounds", "migration", "patchledger-config-v1.yaml")), true);
    const migratedStore = SQLStore.sqlite(database);
    assert.equal((await migratedStore.migrate()).schema_version, SCHEMA_VERSION);
    await migratedStore.close();
  } finally {
    if (previous === undefined) delete process.env.GROUNDS_CONFIG; else process.env.GROUNDS_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later config verification failure rolls an already moved repository back", async () => {
  const fixture = repository();
  const oldRoot = join(fixture.repo, ".patchledger");
  const source = join(fixture.root, "legacy", "config.yaml");
  const target = join(fixture.root, "grounds", "config.yaml");
  const database = join(fixture.root, "ledger.db");
  const previous = process.env.GROUNDS_CONFIG;
  try {
    const store = SQLStore.sqlite(database);
    await store.initialize("warn");
    await store.close();
    mkdirSync(join(oldRoot, "authoring"), { recursive: true });
    writeFileSync(join(oldRoot, "authoring", "draft.md"), "# Preserve me\n");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, stringify({
      version: 1,
      database: { driver: "sqlite", path: database, expected_database_id: "019c0000-0000-7000-8000-000000000099" },
    }));
    process.env.GROUNDS_CONFIG = target;

    await assert.rejects(
      migratePatchLedgerBrand({ cwd: fixture.repo, legacyConfig: source, dryRun: false }),
      (error) => error instanceof DomainError && error.code === "DATABASE_ID_MISMATCH",
    );
    assert.equal(readFileSync(join(oldRoot, "authoring", "draft.md"), "utf8"), "# Preserve me\n");
    assert.equal(existsSync(join(fixture.repo, ".grounds")), false);
    assert.equal(existsSync(source), true);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(join(fixture.repo, ".git", "grounds-brand-migration.json")), false);
  } finally {
    if (previous === undefined) delete process.env.GROUNDS_CONFIG; else process.env.GROUNDS_CONFIG = previous;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("migration rejects conflicts and ordinary commands surface an exact recovery command", async () => {
  const fixture = repository();
  const noConfig = join(fixture.root, "missing-legacy-config.yaml");
  try {
    mkdirSync(join(fixture.repo, ".patchledger", "devruns", ".pending"), { recursive: true });
    writeFileSync(join(fixture.repo, ".patchledger", "devruns", ".pending", "operation.json"), "{}\n");
    assert.throws(
      () => requireNoLegacyBrandState(fixture.repo, noConfig),
      (error) => error instanceof DomainError && error.code === "BRAND_MIGRATION_REQUIRED" && Array.isArray(error.details.migrate_argv),
    );
    for (const argv of [
      ["config", "path", "--config", noConfig],
      ["init", "--config", noConfig, "--driver", "sqlite", "--path", join(fixture.root, "ledger.db"), "--non-interactive"],
      ["repository", "list", "--config", noConfig],
    ]) {
      await assert.rejects(
        execute(argv, { cwd: fixture.repo }),
        (error) => error instanceof DomainError && error.code === "BRAND_MIGRATION_REQUIRED"
          && JSON.stringify(error.details.migrate_argv) === JSON.stringify(["grounds", "migrate", "patchledger", "--cwd", resolve(fixture.repo)]),
      );
    }
    const help = await execute(["help"], { cwd: fixture.repo }) as { usage: string };
    assert.match(help.usage, /grounds doctor/);
    await assert.rejects(
      migratePatchLedgerBrand({ cwd: fixture.repo, legacyConfig: noConfig, dryRun: false }),
      (error) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && /pending/.test(String(error.details.reason)),
    );
    assert.equal(existsSync(join(fixture.repo, ".patchledger")), true);
    assert.equal(existsSync(join(fixture.repo, ".grounds")), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
