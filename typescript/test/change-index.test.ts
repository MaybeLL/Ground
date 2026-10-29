import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Bytes } from "../src/canonical-json.js";
import { indexCandidateChanges, inspectChangeRationaleBindings, matchChangeLine } from "../src/change-index.js";
import type { CandidateArtifact, CandidateSubmissionInput, IssueRevision } from "../src/domain.js";
import { newUUIDv7 } from "../src/identity.js";
import { captureArtifact, materializeCandidateWorktree, resolveBaseline } from "../src/git.js";

const artifactFor = (patch: Buffer): CandidateArtifact => ({
  patch,
  patch_digest: sha256Bytes(patch),
  result_tree_oid: "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd",
  uncompressed_size: patch.length,
  files: [
    { path_bytes: Buffer.from("src/app.ts").toString("base64"), display_path: "src/app.ts", change: "modified", old_mode: "100644", new_mode: "100644" },
    { path_bytes: Buffer.from("logo.png").toString("base64"), display_path: "logo.png", change: "modified", old_mode: "100644", new_mode: "100644" },
  ],
});

test("Change Index deterministically creates hunk units and a file unit for a binary section", () => {
  const patch = Buffer.from([
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " same",
    "@@ -10,0 +11,2 @@ function run() {",
    "+first",
    "+second",
    "diff --git a/logo.png b/logo.png",
    "index 3333333..4444444 100644",
    "GIT binary patch",
    "literal 0",
    "HcmV?d00001",
    "",
  ].join("\n"));
  const artifact = artifactFor(patch);

  const first = indexCandidateChanges(artifact);
  const second = indexCandidateChanges(artifact);

  assert.deepEqual(second, first);
  assert.equal(first.patch_digest, artifact.patch_digest);
  assert.equal(first.change_units.length, 3);
  assert.deepEqual(first.change_units.map((unit) => unit.kind), ["hunk", "hunk", "file"]);
  assert.deepEqual(first.change_units[0].old_range, { start: 1, lines: 2 });
  assert.deepEqual(first.change_units[0].new_range, { start: 1, lines: 2 });
  assert.deepEqual(first.change_units[1].old_range, { start: 10, lines: 0 });
  assert.deepEqual(first.change_units[1].new_range, { start: 11, lines: 2 });
  assert.equal(new Set(first.change_units.map((unit) => unit.change_unit_id)).size, 3);

  const textUnits = first.change_units.slice(0, 2);
  assert.deepEqual(matchChangeLine(artifact, textUnits, 1, "old"), {
    status: "deleted",
    change_units: [first.change_units[0]],
  });
  assert.deepEqual(matchChangeLine(artifact, textUnits, 1, "new"), {
    status: "added",
    change_units: [first.change_units[0]],
  });
  assert.deepEqual(matchChangeLine(artifact, textUnits, 2, "new"), {
    status: "context",
    change_units: [],
  });
  assert.deepEqual(matchChangeLine(artifact, textUnits, 99, "new"), {
    status: "outside_hunks",
    change_units: [],
  });
  assert.deepEqual(matchChangeLine(artifact, [first.change_units[2]], 1, "new"), {
    status: "unavailable",
    change_units: [],
  });
});

test("captured patches reconcile file sections with sorted raw-path manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-change-index-"));
  const repo = join(root, "repo");
  try {
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repo });
    execFileSync("git", ["config", "core.quotePath", "false"], { cwd: repo });
    writeFileSync(join(repo, "旧 名.txt"), "old\n");
    writeFileSync(join(repo, "middle.txt"), "middle\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo });
    writeFileSync(join(repo, ".git", "info", "exclude"), "/.grounds/\n");
    renameSync(join(repo, "旧 名.txt"), join(repo, "新 名.txt"));
    writeFileSync(join(repo, "middle.txt"), "changed\n");

    const artifact = captureArtifact(repo, resolveBaseline(repo, "HEAD"));
    const index = indexCandidateChanges(artifact);

    assert.deepEqual(index.change_units.map((unit) => unit.display_path), artifact.files.map((file) => file.display_path));
    assert.equal(index.change_units.length, 2);
    assert.equal(index.change_units.some((unit) => unit.old_path_bytes !== undefined), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const withTypeChanges = (reverse: boolean, inspect: (artifact: CandidateArtifact, repo: string, baseline: string) => void, objectFormat = "sha1"): void => {
  const root = mkdtempSync(join(tmpdir(), "grounds-type-change-"));
  const repo = join(root, "repo");
  try {
    execFileSync("git", ["init", "-q", `--object-format=${objectFormat}`, repo]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repo });
    const contents = new Map([
      ["CLAUDE.md", Buffer.from("rules\nsecond line\n")],
      ["中文 空格.txt", Buffer.from("non ASCII path\n")],
      ["binary file", Buffer.from([0, 1, 2, 3])],
      ["empty.txt", Buffer.alloc(0)],
    ]);
    for (const [name, content] of contents) {
      if (reverse) symlinkSync("AGENTS.md", join(repo, name));
      else writeFileSync(join(repo, name), content);
      if (!reverse && name === "CLAUDE.md") chmodSync(join(repo, name), 0o755);
    }
    writeFileSync(join(repo, "ordinary.txt"), "old\n");
    writeFileSync(join(repo, "rename.txt"), "renamed\n");
    writeFileSync(join(repo, "executable.txt"), "mode\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo });
    writeFileSync(join(repo, ".git", "info", "exclude"), "/.grounds/\n");
    const baseline = resolveBaseline(repo, "HEAD");
    for (const [name, content] of contents) {
      unlinkSync(join(repo, name));
      if (reverse) writeFileSync(join(repo, name), content);
      else symlinkSync("AGENTS.md", join(repo, name));
      if (reverse && name === "CLAUDE.md") chmodSync(join(repo, name), 0o755);
    }
    writeFileSync(join(repo, "ordinary.txt"), "new\n");
    renameSync(join(repo, "rename.txt"), join(repo, "renamed.txt"));
    chmodSync(join(repo, "executable.txt"), 0o755);
    inspect(captureArtifact(repo, baseline), repo, baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

for (const reverse of [false, true]) test(`canonical Git ${reverse ? "symlink to regular" : "regular to symlink"} pairs are one immutable file unit`, () => {
  withTypeChanges(reverse, (artifact, repo, baseline) => {
    const index = indexCandidateChanges(artifact);
    const starts = [...artifact.patch.toString("utf8").matchAll(/^diff --git /gm)].map((match) => match.index!);
    assert.equal(starts.length, artifact.files.length + 4);
    assert.deepEqual(index.change_units.map((unit) => unit.display_path), artifact.files.map((file) => file.display_path));
    let offset = 0;
    for (const file of artifact.files) {
      const unit = index.change_units.find((item) => item.path_bytes === file.path_bytes)!;
      if (file.change === "type_changed") {
        assert.equal(unit.kind, "file");
        assert.equal(unit.content_digest, sha256Bytes(artifact.patch.subarray(starts[offset], starts[offset + 2] ?? artifact.patch.length)));
        assert.deepEqual(matchChangeLine(artifact, [unit], 1, "new"), { status: "unavailable", change_units: [] });
        offset += 2;
      } else offset += 1;
    }
    assert.deepEqual(indexCandidateChanges(artifact), index);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixed type changes"], { cwd: repo });
    const source = resolveBaseline(repo, "HEAD"), target = join(repo, "..", "review");
    materializeCandidateWorktree({ source_path: repo, source_commit: source, target_path: target, mode: "review", baseline_oid: baseline, patch: artifact.patch, expected_tree_oid: artifact.result_tree_oid });
    assert.deepEqual(captureArtifact(target, baseline), artifact);
    assert.equal(readFileSync(join(repo, "ordinary.txt"), "utf8"), "new\n");
  });
});

for (const reverse of [false, true]) test(`SHA-256 canonical type change supports ${reverse ? "reverse" : "forward"} full-index pairs`, () => {
  withTypeChanges(reverse, (artifact) => {
    assert.ok(artifact.result_tree_oid.startsWith("sha256:"));
    assert.equal(indexCandidateChanges(artifact).change_units.filter((unit) => unit.change === "type_changed" && unit.kind === "file").length, 4);
  }, "sha256");
});

test("type-change indexing rejects missing, reordered, duplicated, wrong-mode and foreign-path pairs", () => {
  withTypeChanges(false, (artifact) => {
    const patch = artifact.patch.toString("utf8");
    const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);
    const pair = sections.findIndex((section) => section.startsWith("diff --git a/CLAUDE.md b/CLAUDE.md\n"));
    assert.ok(pair >= 0);
    const rejected = (parts: string[], files = artifact.files): void => {
      const bytes = Buffer.from(parts.join(""));
      assert.throws(() => indexCandidateChanges({ ...artifact, patch: bytes, patch_digest: sha256Bytes(bytes), files }), { code: "ARTIFACT_INTEGRITY_ERROR" });
    };
    rejected(sections.filter((_, index) => index !== pair + 1));
    rejected(sections.map((section, index) => index === pair ? sections[pair + 1] : index === pair + 1 ? sections[pair] : section));
    rejected([...sections.slice(0, pair + 2), sections[pair + 1], ...sections.slice(pair + 2)]);
    rejected(sections.map((section, index) => index === pair + 1 ? section.replace("new file mode 120000", "new file mode 100755") : section));
    rejected(sections.map((section, index) => index === pair + 1 ? section.replaceAll("CLAUDE.md", "../foreign") : section));
    rejected(sections.map((section, index) => index === pair + 1 ? section.replace("+++ b/CLAUDE.md", "+++ b/other.md") : section));
    rejected(sections.map((section, index) => index === pair ? section.replace("+++ /dev/null", "+++ b/CLAUDE.md") : section));
    rejected(sections.map((section, index) => index === pair + 1 ? section.replace("+AGENTS.md", " AGENTS.md") : section));
    rejected(sections.map((section, index) => index === pair + 1 ? section.replace(/index 0+\.\./, "index " + "1".repeat(40) + "..") : section));
    rejected(sections, artifact.files.map((file) => file.display_path === "CLAUDE.md" ? { ...file, change: "modified" } : file));
    rejected(sections, artifact.files.map((file) => file.display_path === "CLAUDE.md" ? { ...file, new_mode: "100755" } : file));
    rejected(sections, artifact.files.map((file) => file.display_path === "CLAUDE.md" ? { ...file, old_path_bytes: file.path_bytes } : file));
    const binary = sections.findIndex((section) => section.startsWith("diff --git a/binary file b/binary file\n"));
    rejected(sections.map((section, index) => index === binary ? section.replace("literal 0", "literal 1") : section));
    rejected(sections.map((section, index) => index === binary ? section.replace("HcmV?d00001", "Hbad") : section));
    const empty = sections.findIndex((section) => section.startsWith("diff --git a/empty.txt b/empty.txt\n"));
    rejected(sections.map((section, index) => index === empty ? section.replace(/index [a-f0-9]+\.\./, "index " + "1".repeat(40) + "..") : section));
  });
});

test("Change Rationale binding inspection detects drift, unknown refs, and incomplete coverage", () => {
  const patch = Buffer.from("diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/logo.png b/logo.png\nGIT binary patch\nliteral 0\nHcmV?d00001\n");
  const artifact = artifactFor(patch);
  const index = indexCandidateChanges(artifact);
  const requirementID = newUUIDv7();
  const issueID = newUUIDv7();
  const criterionID = newUUIDv7();
  const issue: IssueRevision = {
    id: newUUIDv7(), issue_id: issueID, requirement_id: requirementID, requirement_revision_id: newUUIDv7(), revision_number: 1,
    baseline: { git_oid: "sha1:0123456789abcdef0123456789abcdef01234567", reachability: "remote_tracking_reachable" },
    summary: "Change behavior",
    goals: [{ id: newUUIDv7(), statement: "Goal", guidance: [], criteria: [{ id: criterionID, statement: "Criterion" }] }],
    constraints: [],
  };
  const submission: CandidateSubmissionInput = {
    format: "patchledger.candidate-submission/v2",
    explanation: "Implemented",
    claims: [{ target_type: "goal", target_id: issue.goals[0].id, explanation: "Done", criteria: [{ criterion_id: criterionID, explanation: "Done", evidence: [] }] }],
    change_index: { format: index.format, patch_digest: index.patch_digest, units_digest: "sha256:" + "0".repeat(64) },
    change_rationales: [{
      change_refs: [index.change_units[0].change_unit_id, "sha256:" + "f".repeat(64)],
      relation: "implements",
      target_refs: [{ type: "criterion", id: newUUIDv7() }],
      rationale: "Reason",
      alternatives: [],
      risks: [],
    }],
  };

  const inspection = inspectChangeRationaleBindings(submission, issue, artifact);
  assert.equal(inspection.problems.some((problem) => problem.includes("units_digest")), true);
  assert.equal(inspection.problems.some((problem) => problem.includes("unknown Change Unit")), true);
  assert.equal(inspection.problems.some((problem) => problem.includes("outside the bound Issue Revision")), true);
  assert.equal(inspection.problems.some((problem) => problem.includes("do not explain 1 Change Unit")), true);
});
