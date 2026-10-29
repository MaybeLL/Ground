import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { DeliveryWorktreeModule } from "../src/delivery-worktree.js";
import { retainCandidateSource } from "../src/development-branch.js";
import { captureCommittedArtifact } from "../src/git.js";
import { newUUIDv7 } from "../src/identity.js";
import type { DeliveryReceipt, SelectionResult } from "../src/selection.js";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(work: (f: any) => Promise<void>, options: { trackedIgnoredLog?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-recovery-"))); const source = join(root, "source");
  try {
    execFileSync("git", ["init", "-q", source]); git(source, "config", "user.name", "Test"); git(source, "config", "user.email", "test@example.test");
    writeFileSync(join(source, ".git/info/exclude"), "/.grounds/\n"); writeFileSync(join(source, "file"), "before\n");
    if (options.trackedIgnoredLog) writeFileSync(join(source, ".gitignore"), "*.log\n");
    git(source, "add", "."); git(source, "commit", "-qm", "base");
    const baseline = `sha1:${git(source, "rev-parse", "HEAD")}`;
    writeFileSync(join(source, "file"), "after\n");
    if (options.trackedIgnoredLog) {
      writeFileSync(join(source, "agent.stderr.log"), "retained diagnostic\n");
      git(source, "add", "-f", "agent.stderr.log");
    }
    git(source, "add", "-A"); git(source, "commit", "-qm", "fixed candidate");
    const commit = `sha1:${git(source, "rev-parse", "HEAD")}`, parents = git(source, "show", "-s", "--format=%P", "HEAD").split(" ").map(oid => `sha1:${oid}`);
    const artifact = captureCommittedArtifact(source, baseline, commit);
    const receipt: DeliveryReceipt = { format: "grounds.delivery-worktree/v2", database_id: newUUIDv7(), issue: { id: newUUIDv7(), version: 1 }, selection_id: newUUIDv7(), selection_version: 1, candidate_id: newUUIDv7(), repository_id: newUUIDv7(), baseline_oid: baseline, patch_digest: artifact.patch_digest, result_tree_oid: artifact.result_tree_oid, source_commit: commit };
    retainCandidateSource(source, receipt.candidate_id, { commit, parents });
    const selection: SelectionResult = { result_type: "patchledger.result.selection/v1", command: "selection.show", issue: receipt.issue, selection: { id: receipt.selection_id, version: 1, state: "selected", candidate_id: receipt.candidate_id, verification_changed: false, warnings: [] } };
    const module = new DeliveryWorktreeModule(source, receipt.database_id); const target = join(root, "target");
    const load = async () => ({ receipt, patch: artifact.patch, source: { commit, parents }, warnings: [] });
    const prepare = () => module.prepare(target, "chosen", load).catch(error => { error.message += JSON.stringify(error.details); throw error; });
    const recordPath = join(module.root, createHash("sha256").update(target).digest("hex") + ".json");
    await work({ root, source, target, receipt, selection, module, load, prepare, recordPath });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("delivery preserves tracked ignored logs while detecting their edits and deletion", async () => fixture(async f => {
  const result = await f.prepare();
  const log = join(f.target, "agent.stderr.log");
  const retained = readFileSync(log);
  const indexPath = git(f.target, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const index = readFileSync(indexPath), receipt = readFileSync(result.receipt_path), record = readFileSync(f.recordPath);
  assert.equal(git(f.target, "check-ignore", "--no-index", "agent.stderr.log"), "agent.stderr.log");
  assert.equal(f.module.inspect(f.selection, f.target)[0].status, "ready");
  assert.equal(f.module.inspectCandidate(f.receipt.candidate_id)[0].status, "ready");
  assert.equal(new DeliveryWorktreeModule(f.target, f.receipt.database_id).inspect(f.selection)[0].status, "ready");
  await f.prepare();
  assert.deepEqual(readFileSync(log), retained);
  assert.deepEqual(readFileSync(indexPath), index);
  assert.deepEqual(readFileSync(result.receipt_path), receipt);
  assert.deepEqual(readFileSync(f.recordPath), record);

  writeFileSync(join(f.target, "runtime.log"), "untracked ignored output\n");
  assert.equal(f.module.inspect(f.selection)[0].status, "ready");
  writeFileSync(log, "user diagnostic edit\n");
  assert.equal(f.module.inspect(f.selection)[0].status, "changed");
  await assert.rejects(f.prepare);
  assert.equal(readFileSync(log, "utf8"), "user diagnostic edit\n");
  rmSync(log);
  assert.equal(f.module.inspect(f.selection)[0].status, "changed");
  await assert.rejects(f.prepare);
  writeFileSync(log, retained);
  rmSync(result.receipt_path);
  assert.equal(f.module.inspect(f.selection)[0].next_action, "resume_preparation");
  await f.prepare();
  assert.equal(f.module.inspect(f.selection)[0].status, "ready");
  assert.deepEqual(readFileSync(indexPath), index);
}, { trackedIgnoredLog: true }));

test("delivery retries repair missing receipts without changing index, source, branch or Selection", async () => fixture(async f => {
  const result = await f.prepare(); const before = git(f.target, "status", "--porcelain");
  rmSync(result.receipt_path);
  const state = f.module.inspect(f.selection, f.target)[0]; assert.equal(state.status, "incomplete"); assert.equal(state.next_action, "resume_preparation");
  await f.prepare(); assert.equal(git(f.target, "status", "--porcelain"), before);
  assert.equal(f.module.inspect(f.selection, f.target)[0].status, "ready");
  const fromLinked = new DeliveryWorktreeModule(f.target, f.receipt.database_id);
  assert.equal(fromLinked.inspect(f.selection)[0].status, "ready");
  const metadata = readFileSync(f.recordPath, "utf8"); const index = readFileSync(join(f.source, ".git/worktrees/target/index"));
  f.module.inspect(f.selection); assert.equal(readFileSync(f.recordPath, "utf8"), metadata); assert.deepEqual(readFileSync(join(f.source, ".git/worktrees/target/index")), index);
  f.selection.selection.version = 2;
  assert.equal(f.module.inspect(f.selection)[0].next_action, "review_selection");
  f.selection.selection.state = "unselected"; delete f.selection.selection.candidate_id;
  assert.equal(f.module.inspect(f.selection)[0].selection_changed, true);
}));

test("delivery refuses edited, staged, committed, unowned and conflicting worktrees", async () => fixture(async f => {
  const result = await f.prepare();
  writeFileSync(join(f.target, "extra"), "user data");
  assert.equal(f.module.inspect(f.selection)[0].status, "changed"); await assert.rejects(f.prepare);
  assert.equal(readFileSync(join(f.target, "extra"), "utf8"), "user data"); rmSync(join(f.target, "extra"));
  writeFileSync(join(f.target, "file"), "staged edit\n"); git(f.target, "add", "file"); assert.equal(f.module.inspect(f.selection)[0].status, "changed"); await assert.rejects(f.prepare);
  git(f.target, "commit", "-qm", "human commit"); assert.equal(f.module.inspect(f.selection)[0].status, "changed"); await assert.rejects(f.prepare);
  git(f.target, "reset", "--mixed", f.receipt.baseline_oid.slice(5));
  writeFileSync(result.receipt_path, "invalid"); assert.equal(f.module.inspect(f.selection)[0].status, "invalid"); await assert.rejects(f.prepare); assert.equal(readFileSync(result.receipt_path, "utf8"), "invalid");
  rmSync(result.receipt_path); rmSync(f.recordPath); assert.equal(f.module.inspect(f.selection, f.target)[0].status, "invalid"); await assert.rejects(f.prepare);
  const alias = join(f.root, "alias"); symlinkSync(f.target, alias); assert.equal(f.module.inspect(f.selection, alias)[0].status, "invalid");
}));

test("delivery handles recorded crash stages and retains ambiguous creation", async () => fixture(async f => {
  const result = await f.prepare();
  const record = JSON.parse(readFileSync(f.recordPath, "utf8"));
  rmSync(result.receipt_path); git(f.target, "reset", "--hard"); record.stage = "created"; writeFileSync(f.recordPath, JSON.stringify(record));
  assert.equal(f.module.inspect(f.selection)[0].status, "incomplete"); await f.prepare(); assert.equal(readFileSync(join(f.target, "file"), "utf8"), "after\n");
  rmSync(result.receipt_path); record.stage = "planned"; writeFileSync(f.recordPath, JSON.stringify(record));
  assert.equal(f.module.inspect(f.selection)[0].status, "invalid"); await assert.rejects(f.prepare);
  git(f.source, "worktree", "remove", "--force", f.target); git(f.source, "branch", "-D", "chosen");
  assert.equal(f.module.inspect(f.selection)[0].status, "incomplete"); await f.prepare();
  git(f.source, "worktree", "remove", "--force", f.target);
  assert.equal(f.module.inspect(f.selection)[0].status, "missing"); await assert.rejects(f.prepare);
}));

test("delivery accepts legacy receipts, rejects different requests, and serializes retries", async () => fixture(async f => {
  const results = await Promise.all([f.prepare(), f.prepare()]); assert.deepEqual(results[0].receipt, results[1].receipt);
  await assert.rejects(() => f.module.prepare(f.target, "other", f.load));
  await assert.rejects(() => f.module.prepare(join(f.root, "second"), "chosen", f.load));
  rmSync(f.recordPath); assert.equal(f.module.inspect(f.selection)[0].status, "ready"); await f.prepare();
  const wrong = new DeliveryWorktreeModule(f.source, newUUIDv7()); assert.equal(wrong.inspect(f.selection, f.target)[0].status, "invalid");
}));

test("delivery diagnoses receipt failures, preserves them, and completes after the obstruction is removed", async () => fixture(async f => {
  const result = await f.prepare(); rmSync(result.receipt_path); mkdirSync(result.receipt_path);
  await assert.rejects(f.prepare, (e: any) => { assert.equal(e.code, "WORKTREE_MISMATCH"); assert.equal(e.details.target_path, f.target); return true; });
  assert.equal(f.module.inspect(f.selection)[0].status, "invalid");
  rmSync(result.receipt_path, { recursive: true });
  await f.prepare(); assert.equal(f.module.inspect(f.selection)[0].status, "ready");
  const before = readFileSync(result.receipt_path, "utf8");
  await assert.rejects(() => f.module.prepare(f.target, "chosen", async () => { throw new Error("selection version changed"); }));
  assert.equal(readFileSync(result.receipt_path, "utf8"), before);
}));

test("delivery recovers a dead lock and preserves an active lock", async () => fixture(async f => {
  mkdirSync(f.module.root); const lock = join(f.module.root, "lock"); mkdirSync(lock); writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 99999999 }));
  await f.prepare(); assert.equal(f.module.inspect(f.selection)[0].status, "ready");
  mkdirSync(lock); writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  await assert.rejects(f.prepare, /operating|preparing|worktree/i);
  assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid, process.pid);
}));

test("delivery reports an invalid registry without following its symlink", async () => fixture(async f => {
  const outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep"), "unchanged"); symlinkSync(outside, f.module.root);
  const before = readdirSync(outside);
  const result = f.module.inspect(f.selection); assert.equal(result[0].status, "invalid"); assert.equal(result[0].next_action, "inspect_manually");
  await assert.rejects(f.prepare); assert.deepEqual(readdirSync(outside), before); assert.equal(readFileSync(join(outside, "keep"), "utf8"), "unchanged");
}));
