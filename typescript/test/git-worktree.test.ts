import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertReviewWorktreeCandidateArtifact, captureArtifact, materializeArtifact, materializeCandidateWorktree, readReviewWorktreeMarker, type ReviewWorktreeMarker } from "../src/git.js";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const repositoryFixture = (): { root: string; repository: string; baseline: string; source: string; artifact: ReturnType<typeof captureArtifact> } => {
  const root = mkdtempSync(join(tmpdir(), "grounds-worktree-test-"));
  const repository = join(root, "source");
  execFileSync("git", ["init", "-q", repository]);
  git(repository, "config", "user.name", "Grounds Test");
  git(repository, "config", "user.email", "grounds@example.test");
  const exclude = git(repository, "rev-parse", "--git-path", "info/exclude");
  writeFileSync(join(repository, exclude), "/.grounds/\n");
  writeFileSync(join(repository, "file.txt"), "before\n");
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "baseline");
  const format = git(repository, "rev-parse", "--show-object-format");
  const plainBaseline = git(repository, "rev-parse", "HEAD");
  const baseline = `${format}:${plainBaseline}`;
  writeFileSync(join(repository, "file.txt"), "candidate\n");
  const artifact = captureArtifact(repository, baseline);
  git(repository, "add", "-A"); git(repository, "commit", "-qm", "candidate");
  const source = `${format}:${git(repository, "rev-parse", "HEAD")}`;
  git(repository, "reset", "--hard", plainBaseline);
  return { root, repository, baseline, source, artifact };
};

test("materialization creates detached review and named delivery worktrees", () => {
  const fixture = repositoryFixture();
  try {
    const reviewPath = join(fixture.root, "review");
    const review = materializeCandidateWorktree({ source_path: fixture.repository, source_commit: fixture.source, target_path: reviewPath, mode: "review", baseline_oid: fixture.baseline, patch: fixture.artifact.patch, expected_tree_oid: fixture.artifact.result_tree_oid });
    assert.equal(review.mode, "review");
    assert.equal(review.branch, undefined);
    assert.equal(git(reviewPath, "branch", "--show-current"), "");
    assert.match(git(reviewPath, "diff", fixture.baseline.slice(5), "HEAD", "--", "file.txt"), /\+candidate/);

    const deliveryPath = join(fixture.root, "delivery");
    const branch = "grounds/candidate/test";
    const delivery = materializeCandidateWorktree({ source_path: fixture.repository, source_commit: fixture.source, target_path: deliveryPath, mode: "delivery", branch, baseline_oid: fixture.baseline, patch: fixture.artifact.patch, expected_tree_oid: fixture.artifact.result_tree_oid });
    assert.equal(delivery.branch, branch);
    assert.equal(git(deliveryPath, "branch", "--show-current"), branch);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review materialization records Candidate identity outside the worktree contents", () => {
  const fixture = repositoryFixture();
  try {
    const reviewPath = join(fixture.root, "review-with-marker");
    const marker: ReviewWorktreeMarker = {
      format: "patchledger.review-worktree/v1",
      database_id: newUUIDv7(),
      candidate_id: newUUIDv7(),
      repository_id: newUUIDv7(),
      baseline_oid: fixture.baseline,
      result_tree_oid: fixture.artifact.result_tree_oid,
      patch_digest: fixture.artifact.patch_digest,
    };
    materializeCandidateWorktree({ source_path: fixture.repository, source_commit: fixture.source, target_path: reviewPath, mode: "review", baseline_oid: fixture.baseline, patch: fixture.artifact.patch, expected_tree_oid: fixture.artifact.result_tree_oid, review_marker: marker });
    assert.deepEqual(readReviewWorktreeMarker(reviewPath), marker);
    assert.doesNotThrow(() => assertReviewWorktreeCandidateArtifact(reviewPath, marker));
    writeFileSync(join(reviewPath, "file.txt"), "changed after review materialization\n");
    assert.throws(
      () => assertReviewWorktreeCandidateArtifact(reviewPath, marker),
      (error: unknown) => error instanceof DomainError
        && error.code === "WORKTREE_MISMATCH"
        && error.details.resource_id === marker.candidate_id
        && error.details.reason === "review worktree content has drifted from the Candidate artifact; restore it or query the Candidate explicitly",
    );
    assert.equal(readReviewWorktreeMarker(fixture.repository), undefined);
    assert.doesNotMatch(git(reviewPath, "status", "--short"), /grounds-review/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed materialization removes the worktree it created", () => {
  const fixture = repositoryFixture();
  try {
    const target = join(fixture.root, "failed");
    assert.throws(() => materializeCandidateWorktree({ source_path: fixture.repository, source_commit: fixture.source, target_path: target, mode: "review", baseline_oid: fixture.baseline, patch: fixture.artifact.patch, expected_tree_oid: `sha1:${"0".repeat(40)}` }));
    assert.equal(existsSync(target), false);

    const deliveryTarget = join(fixture.root, "failed-delivery");
    const branch = "grounds/candidate/failed";
    assert.throws(() => materializeCandidateWorktree({ source_path: fixture.repository, source_commit: fixture.source, target_path: deliveryTarget, mode: "delivery", branch, baseline_oid: fixture.baseline, patch: fixture.artifact.patch, expected_tree_oid: `sha1:${"0".repeat(40)}` }));
    assert.equal(existsSync(deliveryTarget), false);
    assert.throws(() => git(fixture.repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("materialization rejects blank target paths", () => {
  const fixture = repositoryFixture();
  try {
    assert.throws(
      () => materializeCandidateWorktree({ source_path: fixture.repository, source_commit: fixture.source, target_path: "", mode: "existing", baseline_oid: fixture.baseline, patch: fixture.artifact.patch, expected_tree_oid: fixture.artifact.result_tree_oid }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "path",
    );
    assert.throws(
      () => materializeCandidateWorktree({ source_path: fixture.repository, source_commit: fixture.source, target_path: "   ", mode: "review", baseline_oid: fixture.baseline, patch: fixture.artifact.patch, expected_tree_oid: fixture.artifact.result_tree_oid }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "path",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("materialization rejects overlong target paths in every mode", () => {
  const fixture = repositoryFixture();
  try {
    assert.throws(
      () => materializeCandidateWorktree({ source_path: fixture.repository, source_commit: fixture.source, target_path: "x".repeat(32769), mode: "existing", baseline_oid: fixture.baseline, patch: fixture.artifact.patch, expected_tree_oid: fixture.artifact.result_tree_oid }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "path",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("patch-only restoration rejects without changing existing files", () => {
  const fixture = repositoryFixture();
  try {
    const before = readFileSync(join(fixture.repository, "file.txt"));
    assert.throws(() => materializeArtifact(fixture.repository, fixture.baseline, fixture.artifact.patch, fixture.artifact.result_tree_oid), { code: "UNSUPPORTED_CANDIDATE_ARTIFACT" });
    assert.deepEqual(readFileSync(join(fixture.repository, "file.txt")), before);
    assert.equal(git(fixture.repository, "rev-parse", "HEAD"), fixture.baseline.slice(5));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
