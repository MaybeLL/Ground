import { captureCommittedCandidate } from "../src/development-branch.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LedgerFixture, testAgent } from "./fixture.js";
import { reviseTargetIssueSeeded, seedStartPreflight, seedRunAdmission, ledgerOnlyPreflightCoordinator } from "./preflight-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { SQLStore } from "../src/sql-store.js";
import { Module } from "../src/module.js";
import { EvalModule } from "../src/eval-module.js";
import { snapshotRelation } from "../src/integration-history.js";
import { renderReviewMarkdown } from "../src/review.js";
import { captureArtifact, diffTrees, materializeCandidateWorktree } from "../src/git.js";
import { assertTargetBase } from "../src/target-branch.js";
import { blindContextDigestFor, blindContextDigestMatches, blindSubjectFor } from "../src/projections.js";
import { assertContract } from "./schema-fixture.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "grounds-candidate-base-")), cwd = join(root, "repo"); mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("remote", "add", "origin", "ssh://git@example.test/team/repo");
  writeFileSync(join(cwd, ".git", "info", "exclude"), "/.grounds/\n");
  writeFileSync(join(cwd, "feature"), "old\n"); git("add", "."); git("commit", "-m", "snapshot");
  const snapshot = `sha1:${git("rev-parse", "HEAD")}`;
  writeFileSync(join(cwd, "upstream"), "upstream change\n"); git("add", "."); git("commit", "-m", "upstream");
  const base = `sha1:${git("rev-parse", "HEAD")}`;
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "--detach");
  const path = join(root, "ledger.db"), store = SQLStore.sqlite(path), f = await LedgerFixture.createWithStore(store, () => store.close(), { preflightCoordinator: ledgerOnlyPreflightCoordinator(store) });
  t.after(async () => { await f.close(); rmSync(root, { recursive: true, force: true }); });
  const revised = await reviseTargetIssueSeeded(f.module, f.store, { operation_id: newUUIDv7(), attribution: testAgent, issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id,
    requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true,
    baseline: { git_oid: snapshot, reachability: "remote_tracking_reachable" },
    input: { format: 1, summary: "Target flow", target_branch: { remote: "origin", ref: "refs/heads/main" }, goals: [{ statement: "Feature", criteria: ["Feature is changed"] }] },
  });
  assertTargetBase(cwd, { remote: "origin", ref: "refs/heads/main" }, [f.repository.canonical_remote], base);
  // This fixture drives the Module directly with no managed worktree, so it
  // records the Issue-version assessment a first target start requires rather
  // than running the per-run observation the real CLI path performs.
  const seedStart = async (commit: string) => seedStartPreflight(f.store, { repositoryId: f.repository.repository_id, canonicalRemote: f.repository.canonical_remote, issueId: f.issue.issue_id, issueRevisionId: revised.result.issue_revision_id, target: { remote: "origin", ref: "refs/heads/main" }, commit });
  await seedStart(base);
  await seedStart(snapshot);
  const start = async (startingBase = base, extra: { refines_candidate_id?: string } = {}) => {
    // A refinement inherits its parent Candidate's base and must not declare one.
    const run = await f.module.startDevRun({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: f.issue.issue_id, issue_revision_id: revised.result.issue_revision_id, issue_revision_explicit: false, repository_remote_snapshot: f.repository.canonical_remote, ...(extra.refines_candidate_id ? { refines_candidate_id: extra.refines_candidate_id, prepare_only: true } : { base_commit: startingBase }) });
    // A ledger-only fixture records the run admission the real observe/admit
    // sequence would; parent refinements build a prepare-only scene first.
    await seedRunAdmission(f.store, { devRunId: run.result.context.dev_run.id });
    return run;
  };
  return { ...f, f, root, cwd, git, path, snapshot, base, revised, start };
}

test("Candidate base different from snapshot survives capture, SQL, blind context, replay and materialization", async t => {
  const x = await fixture(t), started = await x.start();
  assert.equal(started.result.context.base_commit, x.base);
  assert.equal(started.result.context.baseline.git_oid, x.snapshot);
  assertContract("devrun-context.schema.json", started.result.context);
  assert.equal((await x.f.module.devRunContext(started.result.context.dev_run.id)).context.base_commit, x.base);
  writeFileSync(join(x.cwd, "feature"), "new\n");
  x.git("add", "--all"); x.git("commit", "-qm", "candidate feature");
  const { artifact, source: fixedSource } = captureCommittedCandidate(x.cwd, x.base);
  assert.equal(artifact.files.length, 1, "upstream is not part of this Candidate's changes");
  const draft = await x.f.module.candidateSubmissionTemplate(started.result.context.dev_run.id);
  const submission = draft.submission;
  submission.explanation = "Change the feature only";
  for (const claim of submission.claims) { claim.explanation = "Implemented"; for (const criterion of claim.criteria) criterion.explanation = "Feature changed"; }
  const submitted = await x.f.module.submitCandidate({ operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: started.result.context.dev_run.id, expected_version: 1, submission, artifact, ...x.f.gitCandidateFields(artifact, x.base, fixedSource) });
  const id = submitted.candidate_id;
  const descriptor = await x.f.module.candidateArtifactDescriptor(id);
  assert.equal(descriptor.base_commit, x.base); assert.equal(descriptor.base_commit_source, "candidate");
  assert.equal((await x.f.module.replaySubject({ candidate_id: id })).base_commit, x.base);
  const blind = (await x.f.module.verificationContext(id, "blind")).context;
  assert.equal(blind.phase, "blind");
  if (blind.phase !== "blind") throw new Error("expected blind context");
  assert.equal(blind.base_commit, x.base); assert.equal(blind.baseline.git_oid, x.snapshot);
  assertContract("verification-context.schema.json", blind);
  assert.deepEqual(blind.snapshot_relation, { kind: "unknown" });
  const localModule = new Module(x.f.store, newUUIDv7, undefined, (snapshot, base) => snapshotRelation(x.cwd, snapshot, base));
  const localBlind = (await localModule.verificationContext(id, "blind")).context;
  assert.equal(localBlind.blind_context_digest, blind.blind_context_digest, "derived history availability must not alter the immutable subject");
  assert.ok(localBlind.phase === "blind");
  assert.deepEqual(localBlind.snapshot_relation, { kind: "ahead", base_ahead: 1, snapshot_ahead: 0 });
  const quality = (await localModule.verificationContext(id, "blind", "quality")).context;
  assert.ok(quality.phase === "blind");
  assert.equal(quality.base_commit, x.base);
  assert.equal(quality.blind_context_digest, blind.blind_context_digest);
  assert.deepEqual(quality.snapshot_relation, localBlind.snapshot_relation);
  assertContract("quality-context.schema.json", quality);
  assert.doesNotMatch(JSON.stringify(quality), /sync_records|submission_explanation|self_verification/);
  const siblingRun = await x.start();
  const sibling = await x.f.module.submitCandidate({ operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: siblingRun.result.context.dev_run.id, expected_version: 1, submission, artifact, ...x.f.gitCandidateFields(artifact, x.base, fixedSource) });
  const summary = await x.f.module.compareCandidateSummary([id, sibling.candidate_id]);
  assert.equal(summary.candidates[0]!.base_commit, x.base);
  assertContract("query-results.schema.json", summary);
  const unavailable = new Module(x.f.store, newUUIDv7, undefined, () => { throw new Error("history unavailable"); });
  const unknown = (await unavailable.verificationContext(id, "blind")).context;
  assert.ok(unknown.phase === "blind");
  assert.deepEqual(unknown.snapshot_relation, { kind: "unknown" });
  const review = await x.f.module.reviewCandidate(id);
  assert.equal(review.trace.artifact.base_commit, x.base);
  assert.equal(review.trace.baseline.git_oid, x.snapshot);
  assertContract("query-results.schema.json", review);
  const material = await x.f.module.loadCandidateMaterialization(id);
  assert.equal(material.baseline.git_oid, x.base);
  for (const mode of ["review", "delivery"] as const) {
    const output = join(x.root, mode);
    materializeCandidateWorktree({ source_path: x.cwd, target_path: output, mode, ...(mode === "delivery" ? { branch: "delivery" } : {}), source_commit: material.source?.commit, baseline_oid: material.baseline.git_oid, patch: material.patch, expected_tree_oid: material.result_tree_oid });
    assert.equal(readFileSync(join(output, "upstream"), "utf8"), "upstream change\n");
    assert.equal(readFileSync(join(output, "feature"), "utf8"), "new\n");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: output, encoding: "utf8" }).trim(), fixedSource.commit.slice(5));
  }
  const refined = await x.start(x.base, { refines_candidate_id: id });
  assert.equal(refined.result.context.base_commit, x.base, "refinement starts at parent base, not snapshot");
  const source = await x.f.store.read(async tx => {
    const record = await tx.getCandidate(id), issue = await tx.getIssueRevisionById(record.candidate.issue_revision_id);
    return { candidate_id: id, repository_id: x.f.repository.repository_id, canonical_remote_at_submission: x.f.repository.canonical_remote,
      base_commit: record.candidate.base_commit!, result_tree_oid: artifact.result_tree_oid, patch_digest: artifact.patch_digest,
      requirement_revision: await tx.getRequirementRevision(issue.requirement_id, issue.requirement_revision_id), issue_revision: issue, artifact, submission };
  });
  assertContract("blind-subject-v2.schema.json", blindSubjectFor(source));
  const digest = blindContextDigestFor(source);
  assert.equal(digest, blind.blind_context_digest);
  assert.equal(blindContextDigestMatches(digest, { ...source, base_commit: x.snapshot }), false);
  assert.equal(blindContextDigestMatches(digest, { ...source, issue_revision: { ...source.issue_revision, baseline: { ...source.issue_revision.baseline, git_oid: x.base } } }), false);
  assert.equal(blindContextDigestMatches(digest, { ...source, issue_revision: { ...source.issue_revision, target_branch: { remote: "origin", ref: "refs/heads/other" } } }), false);
  const raw = new DatabaseSync(x.path);
  try { raw.prepare("UPDATE candidate_bases SET base_commit=? WHERE candidate_id=?").run(x.snapshot, id); } finally { raw.close(); }
  await assert.rejects(x.f.module.verificationContext(id, "blind"), { code: "ARTIFACT_INTEGRITY_ERROR" });
});

test("target rewrite rejects an old base without changing the worktree", async t => {
  const x = await fixture(t);
  x.git("update-ref", "refs/remotes/origin/main", x.snapshot.slice(5));
  const before = x.git("status", "--porcelain");
  assert.throws(() => assertTargetBase(x.cwd, { remote: "origin", ref: "refs/heads/main" }, [x.f.repository.canonical_remote], x.base));
  assert.equal(x.git("status", "--porcelain"), before);
  assert.equal(x.git("rev-parse", "HEAD"), x.base.slice(5));
});

test("cross-base refinement Review and pairwise comparison separate upstream from author changes", async t => {
  const x = await fixture(t);
  const local = new Module(x.f.store, newUUIDv7, async (left, right) => diffTrees(x.cwd, left, right));
  const submit = async (runId: string, base: string, expected_version = 1) => {
    const { submission } = await x.f.module.candidateSubmissionTemplate(runId);
    submission.explanation = "Feature implementation";
    for (const claim of submission.claims) { claim.explanation = "Implemented"; for (const criterion of claim.criteria) criterion.explanation = "Feature changed"; }
    return x.f.module.submitCandidate({ operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: runId, expected_version, submission, artifact: captureArtifact(x.cwd, base), ...x.f.gitCandidateFields(captureArtifact(x.cwd, base), base) });
  };
  x.git("checkout", "--detach", x.snapshot.slice(5));
  const parentRun = await x.start(x.snapshot);
  writeFileSync(join(x.cwd, "feature"), "parent\n");
  const parent = await submit(parentRun.result.context.dev_run.id, x.snapshot);
  const childRun = await x.start(x.base, { refines_candidate_id: parent.candidate_id });
  // Fixture only: model the persisted output of a completed sync. This is not
  // evidence that a public sync/recovery command has been implemented.
  const raw = new DatabaseSync(x.path);
  try { raw.prepare("UPDATE dev_run_bases SET base_commit=? WHERE dev_run_id=?").run(x.base, childRun.result.context.dev_run.id); raw.prepare("UPDATE dev_runs SET version=2 WHERE id=?").run(childRun.result.context.dev_run.id); } finally { raw.close(); }
  // The fixture's raw base/version move supersedes the scene's admission, so the
  // sync that this models must be followed by a fresh admission before submit.
  await seedRunAdmission(x.f.store, { devRunId: childRun.result.context.dev_run.id });
  x.git("checkout", "--detach", x.base.slice(5));
  writeFileSync(join(x.cwd, "feature"), "child\n");
  const child = await submit(childRun.result.context.dev_run.id, x.base, 2);
  const review = await local.reviewCandidate(child.candidate_id, { include_patch: true });
  const upstream = review.trace.upstream_changes!;
  assert.equal(upstream.status, "available");
  assert.equal(upstream.role, "base_changes_not_candidate_changes");
  assert.equal(upstream.left_base_commit, x.snapshot); assert.equal(upstream.right_base_commit, x.base);
  assert.match(upstream.diff!.unified_diff!, /upstream/); assert.doesNotMatch(upstream.diff!.unified_diff!, /feature/);
  assert.equal(review.trace.artifact.file_manifest.length, 1);
  assertContract("query-results.schema.json", review);
  assert.match(renderReviewMarkdown(review), /Upstream base changes \(not Candidate changes\)/);
  const summary = await local.reviewSummary(child.candidate_id);
  assert.equal(summary.trace.upstream_changes!.diff!.diff_state, "not_requested");
  assertContract("query-results.schema.json", summary);
  const comparison = await local.compareCandidates([parent.candidate_id, child.candidate_id], { pairwise_pairs: [[parent.candidate_id, child.candidate_id]] });
  assert.equal(comparison.pairwise_diffs[0]!.upstream_changes!.diff!.stats.files, 1);
  assert.deepEqual(comparison.candidates.map(candidate => candidate.diff_from_baseline.files), [1, 1]);
  assertContract("query-results.schema.json", comparison);
  const unavailable = await x.f.module.reviewCandidate(child.candidate_id);
  assert.equal(unavailable.trace.upstream_changes!.status, "unavailable");
  assert.equal(unavailable.trace.upstream_changes!.diff, undefined);
  assertContract("query-results.schema.json", unavailable);
});

test("Coding Eval stays pinned to task snapshot even when the Issue target is unavailable", async t => {
  const x = await fixture(t), evals = new EvalModule(x.f.store);
  const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
  const issue = { id: x.f.issue.issue_id, version: 2 };
  const grader = await evals.publishGrader({ format: "patchledger.eval-grader/v1", issue, name: "Behavior", scope: { kind: "diagnostic", name: "Behavior" }, result_spec: { kind: "decision" }, definition: { type: "agent", instructions: "Check feature behavior" }, limitations: "Fixture only" }, actor());
  const empty = await evals.createSuite("Pinned", actor());
  const suite = await evals.changeTask(empty.id, 1, { type: "add", task: { name: "Develop", issue, graders: [{ id: grader.id, version: 1 }] } }, actor());
  const experiment = await evals.createExperiment({ suite_id: suite.id }, { name: "Agent", description: "Pinned fixture" }, actor());
  x.git("update-ref", "-d", "refs/remotes/origin/main");
  const run = await evals.startRun({ experiment_id: experiment.id, task_id: suite.data.tasks[0]!.id }, actor());
  // The Eval-created run is a ledger-only fixture; record the admission its
  // real observe/admit sequence would before requesting a Candidate template.
  await seedRunAdmission(x.f.store, { devRunId: run.data.dev_run_id! });
  const context = (await x.f.module.devRunContext(run.data.dev_run_id!)).context;
  assert.equal(context.baseline.git_oid, x.snapshot); assert.equal(context.base_commit, undefined);
  assert.equal(context.snapshot_relation, undefined);
  x.git("checkout", "--detach", x.snapshot.slice(5)); writeFileSync(join(x.cwd, "feature"), "eval\n");
  const { submission } = await x.f.module.candidateSubmissionTemplate(run.data.dev_run_id!);
  submission.explanation = "Pinned implementation";
  for (const claim of submission.claims) { claim.explanation = "Implemented"; for (const criterion of claim.criteria) criterion.explanation = "Feature changed"; }
  const candidate = await x.f.module.submitCandidate({ ...actor(), dev_run_id: run.data.dev_run_id!, expected_version: 1, submission, artifact: captureArtifact(x.cwd, x.snapshot), ...x.f.gitCandidateFields(captureArtifact(x.cwd, x.snapshot), x.snapshot) });
  const descriptor = await x.f.module.candidateArtifactDescriptor(candidate.candidate_id);
  assert.equal(descriptor.base_commit, x.snapshot); assert.equal(descriptor.base_commit_source, "issue_version_baseline");
  assert.equal((await x.f.module.replaySubject({ candidate_id: candidate.candidate_id })).base_commit, x.snapshot);
});
