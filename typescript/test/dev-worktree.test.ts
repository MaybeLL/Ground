import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { createDevelopmentPlan, developmentPath } from "../src/development-branch.js";
import { DomainError, validation } from "../src/errors.js";
import { captureArtifact, resolveBaseline } from "../src/git.js";
import { newUUIDv7 } from "../src/identity.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const repository = (): { root: string; repo: string; baseline: string } => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-local-worktree-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  git(repo, "config", "user.name", "T");
  git(repo, "config", "user.email", "t@example.test");
  writeFileSync(join(repo, "file.txt"), "baseline\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "baseline");
  writeFileSync(join(repo, ".git", "info", "exclude"), "/.grounds/\n");
  return { root, repo, baseline: resolveBaseline(repo, "HEAD") };
};

test("a retryable start failure retains and reuses its provisional worktree", async () => {
  const fixture = repository();
  try {
    const manager = new DevWorktreeModule(fixture.repo, newUUIDv7(), newUUIDv7, undefined, join(fixture.root, "registry"));
    const input = { operation_id: newUUIDv7(), repository_id: newUUIDv7(), issue_revision_id: newUUIDv7(), baseline_oid: fixture.baseline };
    let provisional = "";
    await assert.rejects(manager.start(input, async (devRunID) => {
      provisional = devRunID;
      throw new DomainError("STORAGE_TRANSIENT", "retry", true);
    }), (error: unknown) => { assert.ok(error instanceof DomainError && error.retryable, JSON.stringify(error)); return true; });
    const retainedPath = join(manager.root, provisional, "worktree");
    assert.equal(existsSync(retainedPath), true);
    assert.deepEqual(manager.inspect(provisional), { status: "available", path: retainedPath });

    const recovered = await manager.start(input, async (devRunID) => ({ value: { recovered: true }, dev_run_id: devRunID }));
    assert.deepEqual(recovered.value, { recovered: true });
    assert.equal(recovered.local_worktree.status, "available");
    if (recovered.local_worktree.status === "available") assert.equal(recovered.local_worktree.path, retainedPath);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a refinement start idempotently restores the exact parent Git commit", async () => {
  const fixture = repository();
  try {
    writeFileSync(join(fixture.repo, "file.txt"), "parent candidate\n");
    const parent = captureArtifact(fixture.repo, fixture.baseline);
    git(fixture.repo, "add", "-A"); git(fixture.repo, "commit", "-qm", "fixed parent candidate");
    const source = `sha1:${git(fixture.repo, "rev-parse", "HEAD")}`;
    git(fixture.repo, "reset", "--hard", fixture.baseline.slice(5));
    const database = newUUIDv7(), repositoryId = newUUIDv7(), workspace = newUUIDv7();
    const identity = { format: "grounds.development-branch/v1" as const, workspace_id: workspace, branch: `grounds/refinement/${workspace}` };
    const plan = createDevelopmentPlan(fixture.repo, { ...identity, database_id: database, repository_id: repositoryId, definition_commit: fixture.baseline, target: { remote: "origin", ref: "refs/heads/main" }, path: developmentPath(fixture.repo, identity), observed_at: new Date().toISOString(), observation: "local_tracking", status: "planned" });
    const manager = new DevWorktreeModule(fixture.repo, database, newUUIDv7, undefined, join(fixture.root, "registry"));
    const input = {
      operation_id: newUUIDv7(),
      repository_id: repositoryId, development_plan: plan,
      issue_revision_id: newUUIDv7(),
      baseline_oid: fixture.baseline,
      refinement: { candidate_id: newUUIDv7(), result_tree_oid: parent.result_tree_oid, patch: parent.patch, source_commit: source, source_parents: [fixture.baseline] },
    };
    let provisional = "";
    await assert.rejects(manager.start(input, async (devRunID) => {
      provisional = devRunID;
      assert.equal(readFileSync(join(plan.path, "file.txt"), "utf8"), "parent candidate\n");
      throw new DomainError("STORAGE_TRANSIENT", "retry", true);
    }), (error: unknown) => error instanceof DomainError && error.retryable);

    const recovered = await manager.start(input, async (devRunID) => {
      assert.equal(devRunID, provisional);
      assert.equal(readFileSync(join(plan.path, "file.txt"), "utf8"), "parent candidate\n");
      return { value: devRunID, dev_run_id: devRunID };
    });
    assert.equal(recovered.value, provisional);
    assert.equal(recovered.local_worktree.status, "available");
    await assert.rejects(
      manager.start({ ...input, refinement: { ...input.refinement, candidate_id: newUUIDv7() } }, async (devRunID) => ({ value: devRunID, dev_run_id: devRunID })),
      (error: unknown) => error instanceof DomainError && error.details.reason === "pending DevRun worktree belongs to a different start request",
    );
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a deterministic rejected start removes only its new provisional worktree", async () => {
  const fixture = repository();
  try {
    const manager = new DevWorktreeModule(fixture.repo, newUUIDv7(), newUUIDv7, undefined, join(fixture.root, "registry"));
    const input = { operation_id: newUUIDv7(), repository_id: newUUIDv7(), issue_revision_id: newUUIDv7(), baseline_oid: fixture.baseline };
    let provisional = "";
    await assert.rejects(manager.start(input, async (devRunID) => {
      provisional = devRunID;
      throw validation("issue", "rejected");
    }));
    assert.deepEqual(manager.inspect(provisional), { status: "missing", reason: "not_available_on_this_machine" });
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("read-only inspection rejects a symlinked local state file", () => {
  const fixture = repository();
  try {
    const manager = new DevWorktreeModule(fixture.repo, newUUIDv7(), newUUIDv7, undefined, join(fixture.root, "registry"));
    const devRunID = newUUIDv7();
    const runDirectory = join(manager.root, devRunID);
    const outside = join(fixture.root, "outside.json");
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, join(runDirectory, "state.json"));
    const inspected = manager.inspect(devRunID);
    assert.equal(inspected.status, "invalid");
    if (inspected.status === "invalid") assert.match(inspected.reason, /real file/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("cleanup trusts the submitted Candidate tree after a local state write crash", async () => {
  const fixture = repository();
  try {
    const manager = new DevWorktreeModule(fixture.repo, newUUIDv7(), newUUIDv7, undefined, join(fixture.root, "registry"));
    const input = { operation_id: newUUIDv7(), repository_id: newUUIDv7(), issue_revision_id: newUUIDv7(), baseline_oid: fixture.baseline };
    const started = await manager.start(input, async (devRunID) => ({ value: devRunID, dev_run_id: devRunID }));
    assert.equal(started.local_worktree.status, "available");
    if (started.local_worktree.status !== "available") return;
    writeFileSync(join(started.local_worktree.path, "file.txt"), "submitted change\n");
    const resultTree = captureArtifact(started.local_worktree.path, fixture.baseline).result_tree_oid;

    // Simulate the database commit winning the race while the local lifecycle
    // file still says active and has no captured_result_tree_oid.
    const cleaned = await manager.cleanup(started.value, "submitted", false, resultTree);
    assert.equal(cleaned.removed, true);
    assert.equal(existsSync(started.local_worktree.path), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("an orphaned lock without owner metadata is recoverable", async () => {
  const fixture = repository();
  try {
    const manager = new DevWorktreeModule(fixture.repo, newUUIDv7(), newUUIDv7, undefined, join(fixture.root, "registry"));
    const input = { operation_id: newUUIDv7(), repository_id: newUUIDv7(), issue_revision_id: newUUIDv7(), baseline_oid: fixture.baseline };
    const lock = join(manager.root, ".locks", `operation-${input.operation_id}`);
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const started = await manager.start(input, async (devRunID) => ({ value: devRunID, dev_run_id: devRunID }));
    assert.equal(started.local_worktree.status, "available");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
