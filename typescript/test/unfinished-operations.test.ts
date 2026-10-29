import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unfinishedOperationPaths } from "../src/development-branch.js";

const MARKERS = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"];
const run = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

test("unfinished-operation markers resolve in one Git process and match per-marker resolution in a linked worktree", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-unfinished-")));
  const bin = join(root, "bin"), log = join(root, "calls.log"), originalPath = process.env.PATH ?? "";
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  t.after(() => { process.env.PATH = originalPath; rmSync(root, { recursive: true, force: true }); });

  const main = join(root, "main"), linked = join(root, "linked");
  mkdirSync(main);
  run(main, "init", "-qb", "main");
  run(main, "config", "user.name", "Test");
  run(main, "config", "user.email", "test@invalid");
  writeFileSync(join(main, "file.txt"), "base\n");
  run(main, "add", ".");
  run(main, "commit", "-qm", "base");
  run(main, "worktree", "add", "-q", "-b", "linked", linked);

  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);

  process.env.PATH = `${bin}:${originalPath}`;
  const resolved = unfinishedOperationPaths(linked);
  process.env.PATH = originalPath;

  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls.length, 1);
  for (const name of MARKERS) assert.ok(calls[0]!.includes(`--git-path ${name}`), name);
  assert.deepEqual(resolved, MARKERS.map(name => resolve(linked, run(linked, "rev-parse", "--git-path", name))));
  assert.ok(resolved.every(entry => !existsSync(entry)));

  writeFileSync(resolved[0]!, "0000000000000000000000000000000000000000\n");
  assert.ok(unfinishedOperationPaths(linked).some(entry => existsSync(entry)));
});
