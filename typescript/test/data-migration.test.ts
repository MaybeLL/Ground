import { executeDataMigration } from "../src/data-migration-cli.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planDataMigration } from "../src/data-migration-plan.js";
import { migrateDataLayout } from "../src/data-migration.js";
import { SQLStore } from "../src/sql-store.js";
import { loadConfig, writeConfig, type Config } from "../src/config.js";
import { newUUIDv7 } from "../src/identity.js";
import { acquireRuntimeLease, directoryRegistryRoot, withRuntimeDirectories } from "../src/runtime-files.js";
import { repositoryDataRoot } from "../src/data-layout.js";
import { requireCurrentDataLayout } from "../src/data-layout-status.js";

test("one migration cuts over SQLite, Git worktrees and local/ledger routing, then replays", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-upgrade-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return withRuntimeDirectories({ runtimeHome: join(root, "runtime-scope"), directoryRegistryHome: join(root, "registry-scope") }, async () => {
  const old = join(root, "old"), target = join(root, "new"), repository = join(root, "repo");
  mkdirSync(repository); mkdirSync(join(old, "runtime"), { recursive: true }); mkdirSync(join(old, "cache", "repos"), { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trimEnd();
  git(repository, "init", "-qb", "main"); git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@invalid");
  writeFileSync(join(repository, "code"), "base\n"); git(repository, "add", "."); git(repository, "commit", "-qm", "base");
  const cache = join(old, "cache", "repos", "repo"), checkout = join(old, "workspaces", "instance", "development", "route");
  git(repository, "clone", "--bare", "--no-hardlinks", repository, cache); git(cache, "worktree", "add", "-qb", "development", checkout);
  writeFileSync(join(checkout, "code"), "staged\n"); git(checkout, "add", "code"); writeFileSync(join(checkout, "code"), "unstaged\n");
  const nestedReview = join(checkout, ".grounds", "reviews", "session");
  mkdirSync(nestedReview, { recursive: true }); writeFileSync(join(nestedReview, "report.json"), '{"original":true}');
  // Managed review state is ignored code material, as in real developer routes.
  writeFileSync(join(cache, "info", "exclude"), ".grounds/\n");
  const oldLocks = join(old, "runtime", "locks"), oldLock = join(oldLocks, "sample.lock");
  mkdirSync(oldLocks); writeFileSync(oldLock, "");
  const oldLockInode = statSync(oldLock).ino;
  const host = newUUIDv7(), route = newUUIDv7(); writeFileSync(join(old, "runtime", "host-id"), host);
  const store = SQLStore.sqlite(join(old, "grounds.db")); await store.initialize("warn"); const metadata = await store.open();
  const config: Config = { version: 2, database: { driver: "sqlite", path: join(old, "grounds.db"), expected_database_id: metadata.database_id } };
  writeConfig(join(old, "config.yaml"), config);
  await store.write(tx => tx.saveRuntimeRecord({ kind: "runtime_operation", id: route, version: 1,
    data: { format: "grounds.code-workspace-route/v1", host_id: host, path: checkout } }, 0));
  await store.close();
  const fence = join(old, "workspaces", "instance", "development", ".route.grounds-route.json");
  writeFileSync(fence, JSON.stringify({ format: "grounds.code-route-fence/v1", path: checkout, control: { generation: 0 } }));
  const oldRegistry = join(root, "old-registry"); mkdirSync(oldRegistry);
  writeFileSync(join(oldRegistry, "workspace-registry.json"), JSON.stringify({ external: {
    run: "external", database: metadata.database_id, ownership: "external", directory: repository,
    identity: "retained-external", input_digest: "unchanged-input" } }));
  for (const category of ["contract-reviews", "release"]) {
    mkdirSync(join(repository, ".grounds", category, "historical"), { recursive: true });
    writeFileSync(join(repository, ".grounds", category, "historical", "record.txt"), category);
  }
  const oldDraft = join(repository, ".grounds", "authoring", "draft"); mkdirSync(oldDraft, { recursive: true });
  writeFileSync(join(oldDraft, ".workspace.json"), JSON.stringify({ database_id: metadata.database_id }));
  const input = { id: "data-layout-v1", targetRoot: target, oldDataRoot: old, oldConfig: join(old, "config.yaml"),
    oldRuntime: join(root, "unused-runtime"), oldRegistry, repositories: [repository] };
  const inputFile = join(root, "migration-input.json");
  writeFileSync(inputFile, JSON.stringify({ oldDataRoot: old, oldConfig: input.oldConfig,
    oldRuntime: input.oldRuntime, oldRegistry, repositories: [repository] }));
  const invokeMigration = async (dryRun: boolean) => {
    const lines: string[] = [];
    const code = await runCLI(["migrate", "data", "--file", inputFile, "--data-root", target, "--json", ...(dryRun ? ["--dry-run"] : [])],
      { cwd: root, stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n"));
    assert.equal(code, 0, JSON.stringify(envelope)); assertContract("cli-envelope.schema.json", envelope);
    return envelope.data;
  };
  const preview = await invokeMigration(true);
  assert.equal(preview.phase, "planned"); assert.equal(existsSync(target), false);
  const connect = (value: Config) => SQLStore.sqlite(value.database.path!);
  const legacyLock = join(repository, ".grounds", "devruns", ".locks", "active");
  mkdirSync(legacyLock, { recursive: true });
  await assert.rejects(migrateDataLayout(input, connect), (error: any) => String(error.details?.reason).includes("controller lock"));
  assert.equal(existsSync(join(old, "grounds.db")), true);
  rmSync(legacyLock, { recursive: true });
  const oldRelease = await acquireRuntimeLease(join(old, "runtime"), "previous-controller");
  try {
    await assert.rejects(migrateDataLayout(input, connect), (error: any) => /previous-version controller/.test(error.details?.reason));
  } finally { oldRelease(); }
  const release = await acquireRuntimeLease(directoryRegistryRoot(), "data-layout", "shared");
  try {
    await assert.rejects(migrateDataLayout(input, connect));
    assert.equal(existsSync(join(old, "grounds.db")), true);
  } finally { release(); }
  await assert.rejects(migrateDataLayout(input, value => {
    if (value.database.path === join(target, "grounds.db")) throw new Error("simulated interruption before ledger cutover");
    return connect(value);
  }), /simulated interruption/);
  assert.throws(() => requireCurrentDataLayout(repository), (error: any) => error.code === "MIGRATION_DIRTY");
  const result = await migrateDataLayout(input, connect);
  for (const category of ["contract-reviews", "release"])
    assert.equal(readFileSync(join(repositoryDataRoot(repository, target), category, "historical", "record.txt"), "utf8"), category);

  assert.equal(result.phase, "complete");
  assert.equal(statSync(oldLocks).isDirectory(), true, "coordination lock directory must stay in place");
  assert.equal(statSync(oldLock).ino, oldLockInode, "old controllers must not obtain a replacement lock inode");
  assert.equal(existsSync(join(target, "drafts", metadata.database_id, "draft", ".workspace.json")), true);
  assert.equal(JSON.parse(readFileSync(join(old, "grounds.db"), "utf8")).format, "grounds.retired-data-location/v1");
  assert.equal(existsSync(join(old, "grounds.db.retired-data-layout-v1")), true);
  assert.throws(() => loadConfig(join(old, "config.yaml")), "old CLI configuration must no longer be usable");
  const nextConfig = loadConfig(join(target, "config.yaml")); assert.equal(nextConfig.database.path, join(target, "grounds.db"));
  const moved = checkout.replace(old, target);
  assert.equal(readFileSync(join(moved, "code"), "utf8"), "unstaged\n"); assert.equal(git(moved, "show", ":code"), "staged");
  const movedReview = join(repositoryDataRoot(moved, target), "reviews", "session");
  assert.equal(readFileSync(join(movedReview, "report.json"), "utf8"), '{"original":true}');
  assert.equal(JSON.parse(readFileSync(join(moved, ".grounds", "reviews", "session"), "utf8")).format, "grounds.retired-data-location/v1");
  assert.equal(existsSync(nestedReview.replace(join(old, "workspaces"), join(old, "workspaces.retired-data-layout-v1"))), true);
  assert.equal(JSON.parse(readFileSync(fence.replace(old, target), "utf8")).path, moved);
  const nextStore = connect(nextConfig);
  try { assert.equal((await nextStore.read(tx => tx.getRuntimeRecord("runtime_operation", route)))?.data.path, moved); }
  finally { await nextStore.close(); }
  const previousRoot = process.env.GROUNDS_DATA_HOME;
  try {
    process.env.GROUNDS_DATA_HOME = target;
    requireCurrentDataLayout(repository);
    const retiredDraft = join(repository, ".grounds", "authoring", "draft"), marker = readFileSync(retiredDraft);
    writeFileSync(retiredDraft, "recreated old data");
    assert.throws(() => requireCurrentDataLayout(repository));
    await assert.rejects(migrateDataLayout(input, connect));
    writeFileSync(retiredDraft, marker);
  } finally {
    if (previousRoot === undefined) delete process.env.GROUNDS_DATA_HOME; else process.env.GROUNDS_DATA_HOME = previousRoot;
  }
  assert.deepEqual(await migrateDataLayout(input, connect), result);
  assert.deepEqual(await invokeMigration(false), result);
  const retiredController = join(repository, ".grounds", "devruns", ".locks");
  const controllerMarker = readFileSync(retiredController);
  assert.equal(JSON.parse(controllerMarker.toString()).format, "grounds.retired-data-location/v1");
  writeFileSync(retiredController, "unknown controller state");
  await assert.rejects(migrateDataLayout(input, connect), (error: any) => /controller lock/.test(error.details?.reason));
  writeFileSync(retiredController, JSON.stringify({ ...JSON.parse(controllerMarker.toString()), target: join(root, "unrelated") }));
  await assert.rejects(migrateDataLayout(input, connect), (error: any) => /controller lock/.test(error.details?.reason));
  writeFileSync(retiredController, controllerMarker);
  assert.deepEqual(await migrateDataLayout(input, connect), result);
  });
});

test("read-only planning creates neither target data nor the shared registry", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-plan-readonly-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "new"), registry = join(root, "registry");
  await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: registry }, async () => {
    const plan = planDataMigration({ id: "preview", targetRoot: target, oldDataRoot: join(root, "old"),
      oldConfig: join(root, "old-config"), oldRuntime: join(root, "old-runtime"), oldRegistry: join(root, "old-registry"), repositories: [] });
    assert.equal(plan.relocation.entries.length, 0);
    assert.equal(existsSync(target), false); assert.equal(existsSync(registry), false);
  });
});


test("legacy delivery-only repositories require migration before ordinary commands", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-old-delivery-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".grounds", "deliveries", "unfinished"), { recursive: true });
  return withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, async () => {
    assert.throws(() => requireCurrentDataLayout(root), (error: any) => error.details.reason_code === "data_migration_required");
  });
});


for (const code of ["ENOSPC", "EACCES", "EROFS"]) test(`public migration reports ${code} without hiding the recovery action`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-migration-io-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = join(root, "old"), target = join(root, "new"); mkdirSync(old);
  writeConfig(join(old, "config.yaml"), { version: 2, database: { driver: "sqlite", path: join(old, "ledger.db"), expected_database_id: newUUIDv7() } });
  writeFileSync(join(old, "ledger.db"), "original database bytes");
  const file = join(root, "input.json");
  writeFileSync(file, JSON.stringify({ oldDataRoot: old, oldConfig: join(old, "config.yaml"), oldRuntime: join(root, "runtime"), oldRegistry: join(root, "registry"), repositories: [] }));
  return withRuntimeDirectories({ runtimeHome: join(root, "current-runtime"), directoryRegistryHome: join(root, "current-registry") }, async () => {
    await assert.rejects(executeDataMigration({ cwd: root, file, targetRoot: target, dryRun: false }, () => { throw Object.assign(new Error("injected storage failure"), { code }); }),
      (error: any) => error.code === "STATE_CONFLICT" && error.details.filesystem_code === code && /resume/.test(error.message));
    assert.equal(readFileSync(join(old, "ledger.db"), "utf8"), "original database bytes");
    assert.equal(existsSync(join(target, "grounds.db")), false);
  });
});
