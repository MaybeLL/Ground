import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureGroundsExcluded, withGroundsExclude } from "../src/grounds-exclude.js";

const RULES = "/.grounds/*\n!/.grounds/environments/\n/.grounds/environments/*\n!/.grounds/environments/*.yaml\n";

test("an empty exclude file gains the Grounds rules with environment definitions re-included", () => {
  assert.equal(withGroundsExclude(""), RULES);
});

test("existing unrelated rules are kept and the rules are not duplicated", () => {
  const once = withGroundsExclude("node_modules/\n");
  assert.equal(once, `node_modules/\n${RULES}`);
  assert.equal(withGroundsExclude(once), once);
});

test("the legacy whole-directory rule is upgraded so environment definitions stay trackable", () => {
  assert.equal(withGroundsExclude("/.grounds/\n"), RULES);
  assert.equal(withGroundsExclude("a\r\n/.grounds/\r\n"), "a\n" + RULES);
});

test("ensureGroundsExcluded accepts tracked environment definitions and refuses other tracked Grounds state", () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-exclude-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const ignored = (path: string): boolean => {
    try {
      git("check-ignore", "-q", path);
      return true;
    } catch {
      return false;
    }
  };
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Exclude Tester");
    git("config", "user.email", "exclude@example.invalid");
    mkdirSync(join(root, ".grounds", "environments"), { recursive: true });
    writeFileSync(join(root, ".grounds", "environments", "dev.yaml"), "format: x\n");
    git("add", "-f", ".grounds/environments/dev.yaml");
    git("commit", "-q", "-m", "definition");
    ensureGroundsExcluded(root);
    writeFileSync(join(root, ".grounds", "environments", "eval.yaml"), "format: x\n");
    assert.equal(ignored(".grounds/environments/eval.yaml"), false);
    mkdirSync(join(root, ".grounds", "devruns"), { recursive: true });
    writeFileSync(join(root, ".grounds", "devruns", "state.json"), "{}\n");
    assert.equal(ignored(".grounds/devruns/state.json"), true);
    git("add", "-f", ".grounds/devruns/state.json");
    git("commit", "-q", "-m", "state");
    assert.throws(() => ensureGroundsExcluded(root), (error: { code?: string }) => error.code === "VALIDATION_ERROR");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("the exclude file is rewritten to the new rules when the legacy rule is present", () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-exclude-legacy-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
    const exclude = join(root, ".git", "info", "exclude");
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(exclude, "/.grounds/\n");
    ensureGroundsExcluded(root);
    assert.equal(readFileSync(exclude, "utf8"), RULES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
