import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { locateFirstParentLanding, snapshotRelation } from "../src/integration-history.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"],
}).trim();
function fixture(t: { after: (fn: () => void) => void }): string {
  const path = mkdtempSync(join(tmpdir(), "grounds-integration-history-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  git(path, "init", "-b", "main"); git(path, "config", "user.email", "test@example.invalid"); git(path, "config", "user.name", "Test");
  return path;
}
function commit(path: string, file: string, content: string): string {
  writeFileSync(join(path, file), content); git(path, "add", "--", file); git(path, "commit", "-m", content);
  return git(path, "rev-parse", "HEAD");
}

test("snapshot relation: equal, ahead, diverged and unrelated with exact counts", t => {
  const cwd = fixture(t);
  const base = commit(cwd, "base", "base");
  const main = commit(cwd, "main", "main");
  assert.deepEqual(snapshotRelation(cwd, base, base), { kind: "ahead", base_ahead: 0, snapshot_ahead: 0 });
  assert.deepEqual(snapshotRelation(cwd, `sha1:${base}`, main), { kind: "ahead", base_ahead: 1, snapshot_ahead: 0 });
  git(cwd, "checkout", "-b", "side", base);
  const side = commit(cwd, "side", "side");
  assert.deepEqual(snapshotRelation(cwd, main, side), { kind: "diverged", base_ahead: 1, snapshot_ahead: 1 });
  git(cwd, "checkout", "--orphan", "unrelated");
  git(cwd, "rm", "-rf", ".");
  const unrelated = commit(cwd, "unrelated", "unrelated");
  assert.deepEqual(snapshotRelation(cwd, base, unrelated), { kind: "unrelated" });
  assert.deepEqual(snapshotRelation(cwd, base, "1".repeat(40)), { kind: "unknown" });
  assert.throws(() => snapshotRelation(cwd, "HEAD", base), /validation/);
});

test("supplied merge second parent reports actual merge entry, not exact landing", t => {
  const cwd = fixture(t);
  const base = commit(cwd, "base", "base");
  git(cwd, "checkout", "-b", "candidate");
  const source = commit(cwd, "feature", "feature");
  git(cwd, "checkout", "main");
  commit(cwd, "upstream", "upstream");
  git(cwd, "merge", "--no-ff", "candidate", "-m", "merge");
  const merge = git(cwd, "rev-parse", "HEAD");
  const target = commit(cwd, "later", "later");
  const result = locateFirstParentLanding(cwd, target, source);
  assert.equal(result.on_first_parent, false);
  assert.equal(result.landed?.oid, `sha1:${source}`);
  assert.equal(result.first_parent_landing?.oid, `sha1:${merge}`);
  assert.equal(result.first_parent_landing?.parents.length, 2);
  assert.equal(locateFirstParentLanding(cwd, source, source).on_first_parent, true);
  assert.equal(locateFirstParentLanding(cwd, target, base).on_first_parent, true);
});

test("same tree and parent do not substitute an unrelated supplied commit", t => {
  const cwd = fixture(t);
  const base = commit(cwd, "base", "base");
  const tree = git(cwd, "rev-parse", "HEAD^{tree}");
  const first = git(cwd, "commit-tree", tree, "-p", base, "-m", "first");
  const second = git(cwd, "commit-tree", tree, "-p", base, "-m", "second");
  const before = readFileSync(join(cwd, ".git", "index"));
  const result = locateFirstParentLanding(cwd, first, second);
  assert.equal(result.on_first_parent, false);
  assert.equal(result.first_parent_landing, undefined);
  assert.equal(result.landed?.oid, `sha1:${second}`);
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), before);
  assert.equal(git(cwd, "rev-parse", "HEAD"), base);
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test("replacement refs cannot forge ancestry; grafts fail closed", t => {
  const cwd = fixture(t);
  const base = commit(cwd, "base", "base");
  const head = commit(cwd, "later", "later");
  const tree = git(cwd, "rev-parse", "HEAD^{tree}");
  const fakeRoot = git(cwd, "commit-tree", tree, "-m", "fake root");
  git(cwd, "replace", head, fakeRoot);
  assert.deepEqual(snapshotRelation(cwd, base, head), { kind: "ahead", base_ahead: 1, snapshot_ahead: 0 });
  assert.equal(locateFirstParentLanding(cwd, head, base).on_first_parent, true);
  writeFileSync(join(cwd, ".git", "info", "grafts"), `${head}\n`);
  assert.deepEqual(snapshotRelation(cwd, base, head), { kind: "unknown" });
  assert.equal(locateFirstParentLanding(cwd, head, base).on_first_parent, null);
});

test("shallow history remains unknown rather than claiming unrelated or complete counts", t => {
  const cwd = fixture(t);
  commit(cwd, "base", "base");
  const head = commit(cwd, "later", "later");
  const shallow = join(cwd, "shallow");
  git(cwd, "clone", "--depth=1", `file://${cwd}`, shallow);
  assert.deepEqual(snapshotRelation(shallow, head, head), { kind: "unknown" });
  assert.equal(locateFirstParentLanding(shallow, head, head).on_first_parent, null);
});
