import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareSyncMerge } from "../src/sync-merge.js";

function setup(conflict = false) {
  const root = mkdtempSync(join(tmpdir(), "grounds-sync-merge-")), cwd = join(root, "repo");
  execFileSync("git", ["init", "-q", cwd]);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(cwd, ".git/info/exclude"), ".grounds/\nignored\n");
  writeFileSync(join(cwd, "a"), "original\n"); writeFileSync(join(cwd, ".gitattributes"), "a merge=hostile\n");
  git("add", "."); git("commit", "-qm", "base"); const base = `sha1:${git("rev-parse", "HEAD")}`;
  writeFileSync(join(cwd, conflict ? "a" : "upstream"), "upstream\n"); git("add", "."); git("commit", "-qm", "target"); const target = `sha1:${git("rev-parse", "HEAD")}`;
  git("checkout", "--detach", base.slice(5));
  const marker = join(root, "unsafe-execution");
  git("config", "merge.hostile.driver", `touch '${marker}'`); git("config", "rerere.enabled", "true");
  writeFileSync(join(cwd, ".git/hooks/post-merge"), `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(cwd, ".git/hooks/post-merge"), 0o755);
  writeFileSync(join(cwd, "a"), "staged\n"); git("add", "a"); writeFileSync(join(cwd, "a"), "developer\n");
  writeFileSync(join(cwd, "untracked"), "local input\n");
  return { root, cwd, base, target, marker, git, directory: join(root, "recovery") };
}

test("sync merge is isolated, retains staged input and untracked input, and combines upstream with developer work", () => {
  const x = setup();
  try {
    writeFileSync(join(x.cwd, "ignored"), "private ignored input\n");
    const index = readFileSync(join(x.cwd, ".git/index"));
    const plan = prepareSyncMerge(x);
    assert.equal(plan.conflicts.length, 0);
    assert.equal(existsSync(join(plan.repository, "ignored")), false);
    assert.equal(readFileSync(join(x.cwd, "ignored"), "utf8"), "private ignored input\n");
    assert.equal(x.git("rev-parse", "HEAD"), x.base.slice(5));
    assert.deepEqual(readFileSync(join(x.cwd, ".git/index")), index);
    assert.deepEqual(readFileSync(join(x.directory, "original-index")), index);
    assert.equal(readFileSync(join(x.cwd, "a"), "utf8"), "developer\n");
    const show = (path: string) => execFileSync("git", ["show", `${plan.result_tree.slice(5)}:${path}`], { cwd: plan.repository, encoding: "utf8" });
    assert.equal(show("upstream"), "upstream\n"); assert.equal(show("a"), "developer\n"); assert.equal(show("untracked"), "local input\n");
    assert.equal(existsSync(x.marker), false);
    assert.equal(existsSync(join(plan.repository, ".git/objects/info/alternates")), false);
    assert.throws(() => prepareSyncMerge(x), /validation/);
  } finally { rmSync(x.root, { recursive: true, force: true }); }
});

test("conflicting merge preserves stage OIDs without invoking user drivers, hooks or rerere", () => {
  const x = setup(true);
  try {
    const plan = prepareSyncMerge(x);
    assert.equal(plan.conflicts.length, 1); assert.equal(plan.conflicts[0]!.path, "a");
    assert.deepEqual(plan.conflicts[0]!.stages.map(x => x.stage), [1, 2, 3]);
    assert.equal(existsSync(x.marker), false);
    assert.equal(readFileSync(join(x.cwd, "a"), "utf8"), "developer\n");
    assert.equal(x.git("diff", "--name-only", "--diff-filter=U"), "");
  } finally { rmSync(x.root, { recursive: true, force: true }); }
});

test("raw recovery bytes remain distinct from Git-normalized patch content", () => {
  const x = setup();
  try {
    writeFileSync(join(x.cwd, ".gitattributes"), "a text merge=hostile\n");
    writeFileSync(join(x.cwd, "a"), "developer\r\n");
    const plan = prepareSyncMerge(x);
    assert.equal(readFileSync(join(plan.repository, "a"), "utf8"), "developer\r\n");
    assert.equal(readFileSync(join(x.cwd, "a"), "utf8"), "developer\r\n");
    assert.equal(execFileSync("git", ["show", `${plan.original_tree.slice(5)}:a`], { cwd: plan.repository, encoding: "utf8" }), "developer\n");
  } finally { rmSync(x.root, { recursive: true, force: true }); }
});

test("ignored collisions and non-forward target fail before recovery directory creation", () => {
  const x = setup();
  try {
    assert.throws(() => prepareSyncMerge({ ...x, target: x.base }));
    assert.equal(existsSync(x.directory), false);
    x.git("config", "core.excludesFile", join(x.root, "ignore"));
    writeFileSync(join(x.root, "ignore"), "upstream\n"); writeFileSync(join(x.cwd, "upstream"), "ignored local secret\n");
    assert.throws(() => prepareSyncMerge(x));
    assert.equal(existsSync(x.directory), false);
    assert.equal(readFileSync(join(x.cwd, "upstream"), "utf8"), "ignored local secret\n");
  } finally { rmSync(x.root, { recursive: true, force: true }); }
});

test("sync freezes new versioned environment YAML and preserves ignored private runtime bytes", () => {
  const x = setup();
  try {
    writeFileSync(join(x.cwd, ".git/info/exclude"), "/.grounds/*\n!/.grounds/environments/\n/.grounds/environments/*\n!/.grounds/environments/*.yaml\n");
    mkdirSync(join(x.cwd, ".grounds/environments"), { recursive: true });
    writeFileSync(join(x.cwd, ".grounds/environments/dev.yaml"), "backend: docker\n");
    writeFileSync(join(x.cwd, ".grounds/private"), "private-runtime\n");
    const plan = prepareSyncMerge(x);
    const captured = execFileSync("git", ["show", `${plan.original_tree.slice(5)}:.grounds/environments/dev.yaml`], { cwd: plan.repository, encoding: "utf8" });
    assert.equal(captured, "backend: docker\n");
    assert.equal(existsSync(join(plan.repository, ".grounds/private")), false);
    assert.equal(readFileSync(join(x.cwd, ".grounds/private"), "utf8"), "private-runtime\n");
  } finally { rmSync(x.root, { recursive: true, force: true }); }
});

test("sync rejects symlink environment declarations and tracked private runtime", () => {
  for (const privateRuntime of [false, true]) {
    const x = setup();
    try {
      mkdirSync(join(x.cwd, ".grounds/environments"), { recursive: true });
      const path = privateRuntime ? ".grounds/private" : ".grounds/environments/dev.yaml";
      if (privateRuntime) writeFileSync(join(x.cwd, path), "private\n");
      else symlinkSync("../../a", join(x.cwd, path));
      x.git("add", "-f", path);
      assert.throws(() => prepareSyncMerge(x));
      assert.equal(existsSync(join(x.cwd, path)), true);
    } finally { rmSync(x.root, { recursive: true, force: true }); }
  }
});
