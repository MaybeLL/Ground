import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DomainError } from "../src/errors.js";
import { targetTrackingRef, validateTargetBranch } from "../src/target-branch.js";

const target = { remote: "upstream", ref: "refs/heads/release/stable" };
test("target branch uses configured exact and wildcard refspecs", () => {
  assert.equal(targetTrackingRef(target, ["+refs/heads/*:refs/remotes/cache/*"]), "refs/remotes/cache/release/stable");
  assert.equal(targetTrackingRef(target, ["refs/heads/release/stable:refs/remotes/pinned/stable"]), "refs/remotes/pinned/stable");
  assert.equal(targetTrackingRef(target, ["+refs/heads/*:refs/remotes/cache/*", "^refs/heads/private/*"]), "refs/remotes/cache/release/stable");
});

test("target branch rejects missing, ambiguous, excluded or unsafe tracking destinations", () => {
  for (const specs of [
    [], ["refs/heads/else:refs/remotes/cache/else"],
    ["refs/heads/*:refs/remotes/one/*", "refs/heads/*:refs/remotes/two/*"],
    ["refs/heads/*:refs/remotes/cache/*", "^refs/heads/release/*"],
    ["refs/heads/*:refs/heads/*"], ["refs/heads/*:refs/remotes/cache/fixed"],
  ]) assert.throws(() => targetTrackingRef(target, specs), /validation/);
  assert.throws(() => targetTrackingRef({ ...target, ref: "main" }, ["refs/heads/*:refs/remotes/cache/*"]), /validation/);
});

test("target branch accepts the same host and path over a different transport, and a retired alias only by exact string", t => {
  const cwd = mkdtempSync(join(tmpdir(), "grounds-target-branch-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init");
  // The clone's origin is spelled over https; the ledger registered ssh.
  git("remote", "add", "origin", "https://git.example.test/team/proj.git");
  git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  const registeredSsh = "ssh://gitlab@git.example.test:2222/team/proj";
  const doesNotBelong = (error: unknown): boolean => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.reason ?? "").includes("does not belong to this Repository");
  assert.equal(validateTargetBranch(cwd, { remote: "origin", ref: "refs/heads/main" }, [registeredSsh]), "refs/remotes/origin/main");
  // A different host or path still fails with the existing error.
  assert.throws(() => validateTargetBranch(cwd, { remote: "origin", ref: "refs/heads/main" }, ["ssh://gitlab@git.example.test:2222/team/other"]), doesNotBelong);
  // An alias on another host matches only by exact string, never by key.
  assert.equal(validateTargetBranch(cwd, { remote: "origin", ref: "refs/heads/main" }, [registeredSsh, "ssh://gitlab@mirror.example.test/team/proj"]), "refs/remotes/origin/main");
  // A retired alias (exact match only, excluded from key matching) still passes
  // when the remote's canonical is exactly the retired string.
  git("remote", "set-url", "origin", "ssh://gitlab@retired.example.test/team/proj");
  assert.throws(() => validateTargetBranch(cwd, { remote: "origin", ref: "refs/heads/main" }, ["ssh://gitlab@git.example.test:2222/team/proj"], []), doesNotBelong);
  assert.equal(validateTargetBranch(cwd, { remote: "origin", ref: "refs/heads/main" }, ["ssh://gitlab@retired.example.test/team/proj"], []), "refs/remotes/origin/main");
});

test("local declaration validation checks repository identity without fetching or changing configuration", t => {
  const cwd = mkdtempSync(join(tmpdir(), "grounds-target-branch-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init");
  git("remote", "add", "upstream", "https://example.invalid/team/project.git");
  git("config", "remote.upstream.fetch", "+refs/heads/*:refs/remotes/cache/*");
  const before = readFileSync(join(cwd, ".git", "config"));
  assert.equal(validateTargetBranch(cwd, target, ["https://example.invalid/team/project"]), "refs/remotes/cache/release/stable");
  assert.throws(() => validateTargetBranch(cwd, target, ["https://example.invalid/other/project"]), /validation/);
  for (const invalid of [
    { remote: "missing", ref: "refs/heads/main" },
    { remote: "upstream", ref: "refs/heads/../main" },
    { remote: "upstream", ref: "HEAD" },
    { remote: "-option", ref: "refs/heads/main" },
  ]) assert.throws(() => validateTargetBranch(cwd, invalid, ["https://example.invalid/team/project"]), /validation/);
  assert.deepEqual(readFileSync(join(cwd, ".git", "config")), before);
});
