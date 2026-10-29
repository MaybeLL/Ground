import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { createDevelopmentPlan, developmentPath, type DevelopmentPlan } from "../src/development-branch.js";
import { captureArtifact, resolveBaseline } from "../src/git.js";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";
import { readCommit } from "../src/integration-history.js";
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-exact-refinement-")));
  git(root, "init", "-qb", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "file"), "base\n"); git(root, "add", "."); git(root, "commit", "-qm", "base");
  const base = resolveBaseline(root, "HEAD"); writeFileSync(join(root, ".git", "info", "exclude"), "/.grounds/\n");
  git(root, "checkout", "-qb", "candidate"); writeFileSync(join(root, "file"), "candidate\n"); git(root, "commit", "-qam", "original candidate");
  const source = readCommit(root, resolveBaseline(root, "HEAD")), artifact = captureArtifact(root, base); git(root, "checkout", "main");
  const database = newUUIDv7(), repository = newUUIDv7(), identity = { format: "grounds.development-branch/v1" as const, workspace_id: newUUIDv7(), branch: `grounds/${newUUIDv7()}` };
  identity.branch = `grounds/archive-test/${identity.workspace_id}`;
  const plan: DevelopmentPlan = { ...identity, database_id: database, repository_id: repository, definition_commit: base, target: { remote: "origin", ref: "refs/heads/main" }, path: developmentPath(root, identity), observed_at: new Date().toISOString(), observation: "local_tracking", status: "planned" }; createDevelopmentPlan(root, plan);
  const manager = new DevWorktreeModule(root, database, newUUIDv7, undefined, join(root, "registry"));
  const input = { operation_id: newUUIDv7(), repository_id: repository, issue_revision_id: newUUIDv7(), baseline_oid: base, development_plan: plan, refinement: { candidate_id: newUUIDv7(), result_tree_oid: source.tree_oid, patch: Buffer.from("intentionally unusable patch: exact Git restoration must not read this"), source_commit: source.oid, source_parents: source.parents } };
  return { root, base, source, artifact, plan, manager, input, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test("new development route starts at exact archived source without applying patch or creating seed", async () => {
  const f = fixture(); try {
    const started = await f.manager.start(f.input, async id => ({ value: id, dev_run_id: id }));
    assert.equal(started.local_worktree.status, "available"); assert.equal(resolveBaseline(f.plan.path, "HEAD"), f.source.oid); assert.deepEqual(readCommit(f.plan.path, f.source.oid), f.source); assert.equal(git(f.plan.path, "status", "--porcelain"), ""); assert.equal(readFileSync(join(f.plan.path, "file"), "utf8"), "candidate\n");
    const state = JSON.parse(readFileSync(join(f.manager.root, started.value, "state.json"), "utf8")); assert.equal(state.refinement_source_commit, f.source.oid); assert.deepEqual(state.refinement_source_parents, f.source.parents);
  } finally { f.cleanup(); }
});
test("SQL interruption resumes original source and rejects operation identity drift even for same tree", async () => {
  const f = fixture(); try {
    let original = "";
    await assert.rejects(f.manager.start(f.input, async id => { original = id; throw new DomainError("STORAGE_TRANSIENT", "retry", true); }));
    git(f.root, "checkout", "candidate"); git(f.root, "commit", "--allow-empty", "-qm", "same tree new identity"); const next = readCommit(f.root, resolveBaseline(f.root, "HEAD")); git(f.root, "checkout", "main");
    await assert.rejects(f.manager.start({ ...f.input, refinement: { ...f.input.refinement, source_commit: next.oid, source_parents: next.parents } }, async id => ({ value: id, dev_run_id: id })));
    assert.equal(resolveBaseline(f.plan.path, "HEAD"), f.source.oid);
    const result = await f.manager.start(f.input, async id => { assert.equal(id, original); return { value: id, dev_run_id: id }; }); assert.equal(result.value, original); assert.equal(resolveBaseline(f.plan.path, "HEAD"), f.source.oid);
  } finally { f.cleanup(); }
});
test("pending exact-source retry preserves later local edits and refuses to overwrite them", async () => {
  const f = fixture(); try {
    await assert.rejects(f.manager.start(f.input, async () => { throw new DomainError("STORAGE_TRANSIENT", "retry", true); })); writeFileSync(join(f.plan.path, "file"), "later edits\n");
    await assert.rejects(f.manager.start(f.input, async id => ({ value: id, dev_run_id: id }))); assert.equal(readFileSync(join(f.plan.path, "file"), "utf8"), "later edits\n"); assert.equal(resolveBaseline(f.plan.path, "HEAD"), f.source.oid);
  } finally { f.cleanup(); }
});
test("incorrect tree or ordered parents fails before creating the development branch", async () => {
  for (const field of ["tree", "parents"]) {
    const f = fixture(); try {
      const refinement = field === "tree" ? { ...f.input.refinement, result_tree_oid: readCommit(f.root, f.base).tree_oid } : { ...f.input.refinement, source_parents: [] };
      await assert.rejects(f.manager.start({ ...f.input, refinement }, async id => ({ value: id, dev_run_id: id }))); assert.equal(existsSync(f.plan.path), false); assert.equal(git(f.root, "for-each-ref", "--format=%(refname)", `refs/heads/${f.plan.branch}`), "");
    } finally { f.cleanup(); }
  }
});
test("patch-only refinement is unsupported and creates no worktree or synthetic recovery commit", async () => {
  const f = fixture(); try {
    const { source_commit: _commit, source_parents: _parents, ...legacy } = f.input.refinement;
    await assert.rejects(f.manager.start({ ...f.input, refinement: { ...legacy, patch: f.artifact.patch } }, async id => ({ value: id, dev_run_id: id })), (error: unknown) => error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT");
    assert.equal(existsSync(f.plan.path), false);
    assert.equal(git(f.root, "for-each-ref", "--format=%(refname)", `refs/heads/${f.plan.branch}`), "");
  } finally { f.cleanup(); }
});
