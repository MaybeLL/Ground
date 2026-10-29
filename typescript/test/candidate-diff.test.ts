import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateDiff, type CandidateDiffPurpose } from "../src/candidate-diff.js";
import type { GitArchiveBinding } from "../src/candidate-git-archive.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Diff Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Diff Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trimEnd();
const oid = (cwd: string, ref = "HEAD"): string => `sha1:${git(cwd, "rev-parse", ref)}`;
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "grounds-fixed-diff-"));
  git(path, "init", "-b", "main"); git(path, "remote", "add", "origin", "ssh://git@example.invalid/team/repo");
  writeFileSync(join(path, "requirement"), "base\n"); git(path, "add", "."); git(path, "commit", "-m", "base"); const b = oid(path);
  git(path, "checkout", "-b", "feature"); writeFileSync(join(path, "requirement"), "candidate\n"); git(path, "commit", "-am", "candidate zero"); const c0 = oid(path);
  git(path, "checkout", "main"); writeFileSync(join(path, "upstream"), "upstream\n"); git(path, "add", "."); git(path, "commit", "-m", "upstream"); const t = oid(path);
  git(path, "checkout", "feature"); git(path, "merge", "--no-edit", "main"); const c1 = oid(path);
  const binding: GitArchiveBinding = { repository_id: newUUIDv7(), canonical_remote: "ssh://git@example.invalid/team/repo", archive_ref: `refs/tags/grounds/candidates/${newUUIDv7()}`, source_commit: c1, ordered_parents: [c0, t], result_tree: oid(path, "HEAD^{tree}"), base_commit: t };
  return { path, b, t, c0, c1, binding, close() { rmSync(path, { recursive: true, force: true }); } };
}

test("all fixed comparison roles retain exact endpoints and isolate upstream from default Review", () => {
  const f = fixture(); try {
    const beforeIndex = readFileSync(join(f.path, ".git/index"));
    writeFileSync(join(f.path, "requirement"), "active uncommitted work\n");
    const pairs: [CandidateDiffPurpose, string, string][] = [["candidate_changes", f.t, f.c1], ["original_changes", f.b, f.c0], ["upstream_changes", f.b, f.t], ["candidate_evolution", f.c0, f.c1], ["cumulative_changes", f.b, f.c1], ["landing_changes", f.t, f.c1], ["target_observation", f.t, f.c1]];
    for (const [purpose, left_commit, right_commit] of pairs) {
      const result = candidateDiff({ repositoryPath: f.path, binding: f.binding, left_commit, right_commit, purpose, ...(purpose === "target_observation" ? { observed_at: "2026-10-16T04:00:00Z" } : {}) });
      assertContract("candidate-archive.schema.json#/$defs/fixedDiff", result);
      assert.equal(result.diff_state, "available"); assert.equal(result.left_commit, left_commit); assert.equal(result.right_commit, right_commit);
      if (purpose === "candidate_changes") { assert.match(result.patch!, /candidate/); assert.doesNotMatch(result.patch!, /upstream/); }
      if (purpose === "cumulative_changes") assert.match(result.patch!, /upstream/);
      if (purpose === "target_observation") assert.equal(result.delivery_ready, false);
    }
    assert.deepEqual(readFileSync(join(f.path, ".git/index")), beforeIndex);
    assert.equal(readFileSync(join(f.path, "requirement"), "utf8"), "active uncommitted work\n"); assert.equal(oid(f.path), f.c1);
  } finally { f.close(); }
});

test("missing objects and binary/large differences have explicit states; bad endpoints and wrong repositories are rejected", () => {
  const f = fixture(); try {
    const input = { repositoryPath: f.path, binding: f.binding, left_commit: f.t, right_commit: f.c1, purpose: "candidate_changes" as const };
    const missing = candidateDiff({ ...input, right_commit: `sha1:${"e".repeat(40)}` }); assert.equal(missing.diff_state, "unavailable"); assert.equal(missing.patch, undefined);
    assert.throws(() => candidateDiff({ ...input, left_commit: "main" }));
    assert.throws(() => candidateDiff({ ...input, purpose: "target_observation" }));
    assert.throws(() => candidateDiff({ ...input, binding: { ...f.binding, canonical_remote: "ssh://git@other.invalid/team/repo" } }), { code: "WORKTREE_MISMATCH" });
    writeFileSync(join(f.path, "binary"), Buffer.from([0, 255, 0, 1])); git(f.path, "add", "."); git(f.path, "commit", "-m", "binary");
    const binary = candidateDiff({ ...input, right_commit: oid(f.path) }); assert.equal(binary.diff_state, "available"); assert.equal(binary.binary, true); assert.match(binary.patch!, /GIT binary patch/);
    writeFileSync(join(f.path, "non-utf8"), Buffer.from([0x61, 0xff, 0x0a])); git(f.path, "add", "."); git(f.path, "commit", "-m", "non utf8");
    const invalidText = candidateDiff({ ...input, right_commit: oid(f.path) }); assert.equal(invalidText.diff_state, "unavailable"); assert.equal(invalidText.binary, true); assert.equal(invalidText.patch, undefined);
    git(f.path, "rm", "non-utf8"); git(f.path, "commit", "-m", "remove non utf8");
    writeFileSync(join(f.path, "large"), "large line\n".repeat(120000)); git(f.path, "add", "."); git(f.path, "commit", "-m", "large");
    const large = candidateDiff({ ...input, right_commit: oid(f.path) }); assert.equal(large.diff_state, "too_large"); assert.equal(large.patch, undefined);
  } finally { f.close(); }
});

test("local textconv and external diff are never executed", () => {
  const f = fixture(); try {
    const marker = join(f.path, "executed");
    git(f.path, "config", "diff.external", `touch ${marker}`); git(f.path, "config", "diff.hostile.textconv", `touch ${marker}`);
    writeFileSync(join(f.path, ".gitattributes"), "requirement diff=hostile\n");
    const result = candidateDiff({ repositoryPath: f.path, binding: f.binding, left_commit: f.t, right_commit: f.c1, purpose: "candidate_changes" });
    assert.equal(result.diff_state, "available"); assert.equal(existsSync(marker), false);
  } finally { f.close(); }
});
