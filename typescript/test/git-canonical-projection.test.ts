import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureCommittedArtifact, resolveBaseline } from "../src/git.js";
import { captureCommittedDevelopment, createDevelopmentPlan, developmentPath, type DevelopmentPlan } from "../src/development-branch.js";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { newUUIDv7 } from "../src/identity.js";
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-canonical-diff-")));
  git(root, "init", "-qb", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, ".git", "info", "exclude"), "/.grounds/\n");
  writeFileSync(join(root, ".gitattributes"), "*.txt diff=custom\n");
  writeFileSync(join(root, "file.txt"), Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n") + "\n");
  writeFileSync(join(root, "old name.txt"), "rename source\n"); writeFileSync(join(root, "binary"), Buffer.from([0, 1, 2, 255])); git(root, "add", "."); git(root, "commit", "-qm", "base"); const base = resolveBaseline(root, "HEAD");
  writeFileSync(join(root, "file.txt"), readFileSync(join(root, "file.txt"), "utf8").replace("line 10", "changed ten")); git(root, "mv", "old name.txt", "renamed.txt"); writeFileSync(join(root, "binary"), Buffer.from([0, 1, 3, 255])); git(root, "add", "."); git(root, "commit", "-qm", "source"); const source = resolveBaseline(root, "HEAD");
  return { root, base, source, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function skewConfig(root: string, marker: string) {
  for (const [key, value] of Object.entries({ "diff.context": "0", "diff.interHunkContext": "100", "diff.algorithm": "histogram", "diff.noprefix": "true", "diff.mnemonicprefix": "true", "diff.relative": "true", "diff.renames": "false", "diff.renameLimit": "1", "diff.indentHeuristic": "true", "diff.suppressBlankEmpty": "true", "core.quotePath": "false", "color.ui": "always", "color.diff": "always", "diff.external": marker, "diff.custom.command": marker, "diff.custom.textconv": marker })) git(root, "config", key, value);
  writeFileSync(join(root, ".git", "info", "attributes"), "* -diff\n");
}
test("same fixed commits produce identical canonical patch and manifest in differently configured clones", () => {
  const f = fixture(); const other = f.root + "-clone";
  try {
    git(f.root, "clone", "--no-local", "-q", f.root, other); const expected = captureCommittedArtifact(f.root, f.base, f.source);
    const marker = join(f.root, ".git", "external-diff"); writeFileSync(marker, "#!/bin/sh\nprintf ran > \"$0.called\"\nexit 97\n", { mode: 0o700 }); skewConfig(other, marker);
    writeFileSync(join(other, ".gitattributes"), "* -diff\n"); writeFileSync(join(other, "file.txt"), "dirty unrelated content\n");
    const index = readFileSync(join(other, ".git", "index")), head = git(other, "rev-parse", "HEAD");
    const actual = captureCommittedArtifact(other, f.base, f.source);
    assert.deepEqual(actual, expected); assert.equal(actual.patch_digest, expected.patch_digest); assert.match(actual.patch.toString(), /@@ -8,7 \+8,7 @@/); assert.match(actual.patch.toString(), /diff --git a\/file.txt b\/file.txt/); assert.match(actual.patch.toString(), /GIT binary patch/); assert.ok(actual.files.some(file => file.change === "renamed"));
    assert.equal(existsSync(marker + ".called"), false); assert.deepEqual(readFileSync(join(other, ".git", "index")), index); assert.equal(git(other, "rev-parse", "HEAD"), head); assert.equal(readFileSync(join(other, "file.txt"), "utf8"), "dirty unrelated content\n");
  } finally { rmSync(other, { recursive: true, force: true }); f.cleanup(); }
});
test("canonical generation ignores inherited Git diff environment and never invokes external/textconv", () => {
  const f = fixture(), saved = new Map<string, string | undefined>(); try {
    const expected = captureCommittedArtifact(f.root, f.base, f.source), marker = join(f.root, ".git", "external-diff"); writeFileSync(marker, "#!/bin/sh\nprintf called > \"$0.called\"\nexit 97\n", { mode: 0o700 }); skewConfig(f.root, marker);
    for (const [key, value] of Object.entries({ GIT_EXTERNAL_DIFF: marker, GIT_DIFF_OPTS: "--unified=0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "diff.context", GIT_CONFIG_VALUE_0: "999" })) { saved.set(key, process.env[key]); process.env[key] = value; }
    assert.deepEqual(captureCommittedArtifact(f.root, f.base, f.source), expected); assert.equal(existsSync(marker + ".called"), false);
  } finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } f.cleanup(); }
});
test("managed canonical capture and later immutable regeneration have the same identity without changing index", async () => {
  const f = fixture(); try {
    const database = newUUIDv7(), repository = newUUIDv7(), identity = { format: "grounds.development-branch/v1" as const, workspace_id: newUUIDv7(), branch: `grounds/${newUUIDv7()}` };
    identity.branch = `grounds/archive-test/${identity.workspace_id}`;
  const plan: DevelopmentPlan = { ...identity, database_id: database, repository_id: repository, definition_commit: f.base, target: { remote: "origin", ref: "refs/heads/main" }, path: developmentPath(f.root, identity), observed_at: new Date().toISOString(), observation: "local_tracking", status: "planned" }; createDevelopmentPlan(f.root, plan);
    const manager = new DevWorktreeModule(f.root, database, newUUIDv7, undefined, join(f.root, ".git", "test-registry")); await manager.start({ operation_id: newUUIDv7(), repository_id: repository, issue_revision_id: newUUIDv7(), baseline_oid: f.source, development_plan: plan }, async id => ({ value: id, dev_run_id: id }));
    const marker = join(f.root, ".git", "external-diff"); writeFileSync(marker, "#!/bin/sh\nexit 97\n", { mode: 0o700 }); skewConfig(f.root, marker);
    const index = git(plan.path, "rev-parse", "--path-format=absolute", "--git-path", "index"), bytes = readFileSync(index);
    const captured = captureCommittedDevelopment(plan.path, identity, f.base, true); assert.equal(captured.source.commit, f.source); assert.deepEqual(captured.artifact, captureCommittedArtifact(f.root, f.base, f.source)); assert.deepEqual(readFileSync(index), bytes);
  } finally { f.cleanup(); }
});
