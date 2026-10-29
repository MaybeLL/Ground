import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relocatePath, relocateRuntimeRecord, relocateLocalBinding, repairRelocatedWorktrees, saveRelocatedRuntimeRecords } from "../src/storage-bindings.js";
import { planRelocation, stageRelocation, activateRelocation } from "../src/storage-relocation.js";
import type { DataMigrationPlan } from "../src/data-migration-plan.js";
import type { RuntimeRecord } from "../src/runtime-record.js";
import { SQLStore } from "../src/sql-store.js";
import { newUUIDv7 } from "../src/identity.js";

test("routing relocation is path bounded and leaves immutable evidence untouched", () => {
  const mappings = [{ source: "/old", target: "/new" }, { source: "/old/specific", target: "/special" }];
  assert.equal(relocatePath("/older/file", mappings), "/older/file");
  assert.equal(relocatePath("/old/specific/file", mappings), "/special/file");
  const row: RuntimeRecord = { kind: "runtime_operation", id: "unused", version: 3,
    data: { format: "grounds.code-workspace-route/v1", path: "/old/route", source: { path: "/old/historical" } } };
  const moved = relocateRuntimeRecord(row, mappings)!;
  assert.equal(moved.version, 4);
  assert.equal(moved.data.path, "/new/route");
  assert.deepEqual(moved.data.source, { path: "/old/historical" });
  assert.equal(row.data.path, "/old/route");
  assert.equal(relocateRuntimeRecord({ ...row, data: { format: "grounds.execution-receipt/v1", path: "/old/route" } }, mappings), undefined);
});

test("relocated Git common directory and linked worktree retain staged and unstaged changes", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-git-relocate-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "old"), target = join(root, "new"); mkdirSync(source);
  const repo = join(source, "repo"), worktree = join(source, "worktree"); mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: "pipe" }).trimEnd();
  git(repo, "init", "-qb", "main"); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@invalid");
  writeFileSync(join(repo, "file"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "worktree", "add", "-qb", "development", worktree);
  writeFileSync(join(worktree, "file"), "staged\n"); git(worktree, "add", "file");
  writeFileSync(join(worktree, "file"), "unstaged\n"); writeFileSync(join(worktree, "new"), "untracked\n");
  const index = readFileSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index"));
  const relocation = planRelocation("git", [{ source, target }]);
  const plan: DataMigrationPlan = { format: "grounds.data-migration-plan/v1", target_root: target, relocation,
    repositories: [repo, worktree], preserved: [], blockers: [], worktrees: [repo, worktree].map(path => ({
      source: path, target: relocatePath(path, [{ source, target }]), head: git(path, "rev-parse", "HEAD"),
      status: git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all"), common: git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    })) };
  const journal = join(root, "journal", "move.json");
  await stageRelocation(journal, relocation); await activateRelocation(journal);
  repairRelocatedWorktrees(plan, [{ source, target }]);
  const moved = join(target, "worktree");
  assert.equal(readFileSync(join(moved, "file"), "utf8"), "unstaged\n");
  assert.equal(git(moved, "show", ":file"), "staged");
  assert.deepEqual(readFileSync(git(moved, "rev-parse", "--path-format=absolute", "--git-path", "index")), index);
  repairRelocatedWorktrees(plan, [{ source, target }]);
});

test("local binding migration refuses unfinished execution, sync and delivery", () => {
  const mappings = [{ source: "/old", target: "/new" }];
  const fence = { format: "grounds.code-route-fence/v1", path: "/old/route", control: { generation: 1 } };
  assert.equal(relocateLocalBinding(fence, mappings)?.path, "/new/route");
  assert.throws(() => relocateLocalBinding({ ...fence, control: { generation: 1, execution_id: "active" } }, mappings));
  const run = { format: "grounds.local-development-worktree/v1", worktree_path: "/old/tree", lifecycle: "active" };
  assert.equal(relocateLocalBinding(run, mappings)?.worktree_path, "/new/tree");
  assert.throws(() => relocateLocalBinding({ ...run, lifecycle: "sync_interrupted" }, mappings));
  const receipt = { format: "grounds.delivery-worktree/v2", source_commit: "unchanged" };
  const delivery = { format: "patchledger.local-delivery/v1", target_path: "/old/delivery", stage: "complete", receipt };
  assert.deepEqual(relocateLocalBinding(delivery, mappings)?.receipt, receipt);
  assert.throws(() => relocateLocalBinding({ ...delivery, stage: "applied" }, mappings));
  assert.equal(relocateLocalBinding(receipt, mappings), undefined);
});

test("ledger binding cutover is atomic, detects concurrent changes and replays without another version", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-ledger-relocate-")));
  const store = SQLStore.sqlite(join(root, "ledger.db"));
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  await store.initialize("warn");
  const rows: RuntimeRecord[] = ["a", "b"].map(name => ({ kind: "runtime_operation", id: newUUIDv7(), version: 1,
    data: { format: "grounds.code-workspace-route/v1", path: "/old/" + name } }));
  await store.write(async tx => { for (const row of rows) await tx.saveRuntimeRecord(row, 0); });
  const mappings = [{ source: "/old", target: "/new" }];
  await store.write(tx => tx.saveRuntimeRecord({ ...rows[1], version: 2, data: { ...rows[1].data, path: "/elsewhere/b" } }, 1));
  await assert.rejects(saveRelocatedRuntimeRecords(store, rows, mappings));
  assert.equal((await store.read(tx => tx.getRuntimeRecord("runtime_operation", rows[0].id)))?.data.path, "/old/a");
  await saveRelocatedRuntimeRecords(store, [rows[0]], mappings);
  await saveRelocatedRuntimeRecords(store, [rows[0]], mappings);
  const moved = await store.read(tx => tx.getRuntimeRecord("runtime_operation", rows[0].id));
  assert.equal(moved?.version, 2); assert.equal(moved?.data.path, "/new/a");
});
