import { repositoryDataRoot } from "../src/data-layout.js";
import { captureCommittedCandidate, retainCandidateSource } from '../src/development-branch.js';
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execute, runCLI } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { captureArtifact } from "../src/git.js";
import { newUUIDv7 } from "../src/identity.js";
import { SQLStore } from "../src/sql-store.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import type { CandidateSubmissionV2Input } from "../src/domain.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const REMOTE = "ssh://git@example.test/team/repo";

interface World {
  root: string; repo: string; config: string; db: string; baseline: string; f: LedgerFixture; databaseID: string; issueVersion: number;
  invoke: (args: string[], cwd?: string) => Promise<{ code: number; envelope: any }>;
  startRun: () => Promise<{ id: string; path: string }>;
  submit: (runID: string) => Promise<string>;
  close: () => Promise<void>;
}

const world = async (): Promise<World> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-reconcile-")));
  const repo = join(root, "source"), config = join(root, "config.yaml"), db = join(root, "db");
  // The remote rewrite scenario below explicitly targets master; do not inherit the user's init.defaultBranch.
  execFileSync("git", ["init", "-q", "--initial-branch=master", repo]);
  git(repo, "config", "user.name", "T"); git(repo, "config", "user.email", "t@example.test"); git(repo, "remote", "add", "origin", REMOTE);
  writeFileSync(join(repo, ".git/info/exclude"), "/.grounds/\n*.log\n"); writeFileSync(join(repo, "file.txt"), "before\n"); git(repo, "add", "-A"); git(repo, "commit", "-m", "base");
  const baseline = `sha1:${git(repo, "rev-parse", "HEAD")}`;
  git(repo, "update-ref", "refs/remotes/origin/main", baseline.slice(5));
  const directories = { runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") };
  await withRuntimeDirectories(directories, () => execute(["init", "--driver", "sqlite", "--path", db, "--config", config, "--non-interactive", "--json"], { cwd: root }));
  const f = await LedgerFixture.createWithStore(SQLStore.sqlite(db));
  const issue = await f.module.reviseIssue({ operation_id: newUUIDv7(), issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: { git_oid: baseline, reachability: "unconfirmed", warning: "local fixture", override_reason: "local fixture" }, input: { format: 1, summary: "Real artifact", goals: [{ statement: "Change file", criteria: ["File changes"] }] }, attribution: testAgent });
  const databaseID = loadConfig(config).database.expected_database_id;
  const invoke = async (args: string[], cwd = repo) => {
    const output: string[] = [];
    const code = await withRuntimeDirectories(directories, () => runCLI([...args, ...(args.includes("--config") ? [] : ["--config", config]), "--json"], { cwd, stdout: (line) => output.push(line), stderr: () => {} }));
    const envelope = JSON.parse(output[0]); assertContract("cli-envelope.schema.json", envelope);
    if (code === 0) assertContract("command-results.schema.json", envelope.data); else assertContract("error.schema.json", envelope.error);
    return { code, envelope };
  };
  const startRun = async () => {
    const started = await invoke(["devrun", "start", "--development-mode", "simple", f.issue.issue_id]);
    assert.equal(started.code, 0, JSON.stringify(started.envelope));
    return { id: started.envelope.data.context.dev_run.id as string, path: started.envelope.data.local_worktree.path as string };
  };
  const submit = async (runID: string) => {
    const dev = new DevWorktreeModule(repo, databaseID, newUUIDv7, f.store, directories.directoryRegistryHome);
    const result = await dev.submit(runID, async (path) => {
      git(path, "add", "-A"); git(path, "commit", "--allow-empty", "-qm", "fixed candidate");
      const fixed = captureCommittedCandidate(path, baseline), artifact = fixed.artifact;
      const draft = (await f.module.candidateSubmissionTemplate(runID, artifact)).submission as CandidateSubmissionV2Input;
      draft.explanation = "Implement it";
      for (const claim of draft.claims) { claim.explanation = "Changes file"; for (const criterion of claim.criteria) criterion.explanation = "Inspected file"; }
      for (const rationale of draft.change_rationales) { rationale.target_refs = [{ type: "criterion", id: draft.claims[0].criteria[0].criterion_id }]; rationale.rationale = "Reviewed wording"; rationale.alternatives = []; rationale.risks = []; }
      const submitted = await f.module.submitCandidate({ ...f.gitCandidateFields(artifact, baseline, fixed.source), operation_id: newUUIDv7(), dev_run_id: runID, expected_version: 1, submission: draft, artifact, attribution: testAgent });
      retainCandidateSource(repo, submitted.candidate_id, fixed.source);
      return { ...submitted, result_tree_oid: artifact.result_tree_oid };
    });
    return result.candidate_id;
  };
  return { root, repo, config, db, baseline, f, databaseID, issueVersion: issue.result.revision_number ?? 2, invoke, startRun, submit, close: async () => { await f.close(); rmSync(root, { recursive: true, force: true }); } };
};

/** Everything a read-only inspection must leave untouched in the clone and its local Grounds state. */
const snapshot = (repo: string, extraWorktrees: string[] = []): string => {
  const parts: string[] = [];
  parts.push(git(repo, "for-each-ref", "--format=%(refname) %(objectname)"));
  parts.push(execFileSync("git", ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"], { cwd: repo, encoding: "utf8" }));
  const common = join(repo, ".git");
  for (const name of ["index", "FETCH_HEAD", "HEAD"]) { const path = join(common, name); parts.push(existsSync(path) ? readFileSync(path).toString("base64") : "-"); }
  const trees = join(common, "worktrees");
  if (existsSync(trees)) for (const name of readdirSync(trees).sort()) for (const file of ["index", "HEAD"]) { const path = join(trees, name, file); parts.push(`${name}/${file}:${existsSync(path) ? readFileSync(path).toString("base64") : "-"}`); }
  const runs = join(repositoryDataRoot(repo), "devruns");
  if (existsSync(runs)) for (const name of readdirSync(runs).sort()) { const path = join(runs, name, "state.json"); if (existsSync(path)) parts.push(`${name}:${readFileSync(path).toString("base64")}`); }
  for (const worktree of extraWorktrees) parts.push(git(worktree, "status", "--porcelain=v1", "--untracked-files=all"));
  return parts.join("\n--\n");
};

const reconcile = async (w: World, runID: string, cwd = w.repo) => {
  const result = await w.invoke(["devrun", "reconcile", "--dev-run", runID], cwd);
  assert.equal(result.code, 0, JSON.stringify(result.envelope));
  return result.envelope.data as { overall: string; findings: Array<{ code: string; severity: string; fields: Record<string, unknown>; next_actions: unknown[] }>; local_worktree: Record<string, unknown>; route_lease: { held: boolean }; delivery: any; next_actions: any[] };
};
const codes = (data: { findings: Array<{ code: string }> }): string[] => data.findings.map((finding) => finding.code);
const statePath = (w: World, runID: string): string => join(repositoryDataRoot(w.repo), "devruns", runID, "state.json");
const editState = (w: World, runID: string, change: (state: Record<string, unknown>) => void): void => {
  const path = statePath(w, runID); const state = JSON.parse(readFileSync(path, "utf8")); change(state); writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
};

test("reconcile classifies every local/ledger combination without changing anything", async () => {
  const w = await world();
  try {
    const clean = await w.startRun();
    let data = await reconcile(w, clean.id);
    assert.equal(data.overall, "consistent"); assert.deepEqual(codes(data), ["open_local_ready"]);
    assert.equal(data.local_worktree.journal_lifecycle, "active"); assert.equal(data.local_worktree.uncaptured_changes, false);

    // Dirty work in an open DevRun is normal; the same facts are listed as only-on-this-machine work.
    writeFileSync(join(clean.path, "file.txt"), "after\n"); writeFileSync(join(clean.path, "new.txt"), "new\n"); writeFileSync(join(clean.path, "debug.log"), "noise\n");
    const before = snapshot(w.repo, [clean.path]);
    data = await reconcile(w, clean.id);
    assert.deepEqual(codes(data), ["open_local_ready"]); assert.equal(data.local_worktree.uncaptured_changes, true);
    assert.equal(data.local_worktree.tracked_modified, 1); assert.equal(data.local_worktree.untracked, 1); assert.equal(data.local_worktree.ignored, 1);
    const listed = await w.invoke(["devrun", "uncommitted"]);
    assert.equal(listed.code, 0); assert.equal(listed.envelope.data.dev_runs.length, 1);
    assert.deepEqual(listed.envelope.data.dev_runs[0].risk_reasons, ["uncaptured_changes", "ignored_files"]);
    assert.equal(snapshot(w.repo, [clean.path]), before, "reconcile and uncommitted must not change the clone or local state");
    assert.equal(snapshot(w.repo, [clean.path]), before, "repeated calls are stable");

    // Submitted DevRun: whole-tree rule means captured content is not reported, an ignored file still is.
    const candidateID = await w.submit(clean.id);
    data = await reconcile(w, clean.id);
    assert.deepEqual(codes(data), ["submitted_local_dirty"]); assert.equal(data.local_worktree.captured_by_candidate, true); assert.equal(data.local_worktree.uncaptured_changes, false);
    assert.equal(data.findings[0].fields.ignored, 1);
    const ignoredOnly = await w.invoke(["devrun", "uncommitted"]);
    assert.deepEqual(ignoredOnly.envelope.data.dev_runs.map((item: any) => [item.dev_run_id, item.risk_reasons]), [[clean.id, ["ignored_files"]]]);
    rmSync(join(clean.path, "debug.log"));
    data = await reconcile(w, clean.id);
    assert.equal(data.overall, "consistent"); assert.deepEqual(codes(data), []);
    assert.equal((await w.invoke(["devrun", "uncommitted"])).envelope.data.dev_runs.length, 0);
    writeFileSync(join(clean.path, "late.txt"), "late\n");
    data = await reconcile(w, clean.id);
    assert.deepEqual(codes(data), ["submitted_local_dirty"]); assert.equal(data.local_worktree.uncaptured_changes, true); assert.equal(data.overall, "attention");
    rmSync(join(clean.path, "late.txt"));

    // Ledger submitted while the journal still says active (crash window) is a mismatch even when clean.
    editState(w, clean.id, (state) => { state.lifecycle = "active"; });
    data = await reconcile(w, clean.id);
    assert.deepEqual(codes(data), ["ledger_local_lifecycle_mismatch"]); assert.equal(data.findings[0].fields.journal_lifecycle, "active");
    editState(w, clean.id, (state) => { state.lifecycle = "submitted"; });

    // Open DevRun whose journal claims a terminal state.
    const open = await w.startRun();
    editState(w, open.id, (state) => { state.lifecycle = "submitted"; });
    data = await reconcile(w, open.id);
    assert.deepEqual(codes(data), ["ledger_local_lifecycle_mismatch"]);
    editState(w, open.id, (state) => { state.lifecycle = "removed"; });
    data = await reconcile(w, open.id);
    assert.deepEqual(codes(data), ["open_local_removed"]);
    assert.ok(data.next_actions.some((next: any) => next.action === "start_new_devrun" && next.requires === "authorization"));

    // A genuinely unknown future lifecycle remains visible and unhealthy.
    editState(w, open.id, (state) => { state.lifecycle = "future_lifecycle"; });
    data = await reconcile(w, open.id);
    assert.equal(data.overall, "needs_inspection"); assert.deepEqual(codes(data), ["local_state_unrecognized"]);
    assert.equal(data.local_worktree.journal_lifecycle, "future_lifecycle"); assert.equal(data.local_worktree.journal_lifecycle_recognized, false);
    const context = await w.invoke(["devrun", "context", open.id]);
    assert.equal(context.envelope.data.local_worktree.status, "invalid");
    editState(w, open.id, (state) => { state.lifecycle = "active"; });

    // Missing, and invalid in both an open and a submitted DevRun.
    rmSync(open.path, { recursive: true, force: true });
    data = await reconcile(w, open.id);
    assert.deepEqual(codes(data), ["open_local_missing"]);
    const bad = await w.startRun();
    writeFileSync(statePath(w, bad.id), "{not json");
    data = await reconcile(w, bad.id);
    assert.deepEqual(codes(data), ["local_invalid"]);
    const saved = readFileSync(statePath(w, clean.id), "utf8");
    writeFileSync(statePath(w, clean.id), "{not json");
    data = await reconcile(w, clean.id);
    assert.deepEqual(codes(data), ["local_invalid"]); assert.equal(data.overall, "attention");
    writeFileSync(statePath(w, clean.id), saved);

    // Two findings at once: unrecognised journal and uncaptured changes after submit.
    editState(w, clean.id, (state) => { state.lifecycle = "future_lifecycle"; });
    writeFileSync(join(clean.path, "late.txt"), "late\n");
    data = await reconcile(w, clean.id);
    assert.equal(data.overall, "needs_inspection");
    assert.deepEqual(codes(data), ["submitted_local_dirty", "local_state_unrecognized"]);
    assert.equal(data.route_lease.held, false);
    assert.equal(candidateID.length > 0, true);
  } finally { await w.close(); }
});

test("reconcile reports an abandoned DevRun and a changed delivery directory", async () => {
  const w = await world();
  try {
    const run = await w.startRun();
    writeFileSync(join(run.path, "file.txt"), "abandon me\n");
    const abandoned = await w.invoke(["devrun", "abandon", run.id, "--expected-version", "1"]);
    assert.equal(abandoned.code, 0, JSON.stringify(abandoned.envelope));
    assert.equal(abandoned.envelope.warnings[0].code, "DEVRUN_UNCOMMITTED_WORK"); assert.match(abandoned.envelope.warnings[0].message, /1 tracked modification/);
    let data = await reconcile(w, run.id);
    assert.deepEqual(codes(data), ["abandoned_local_dirty"]);
    const blocked = await w.invoke(["devrun", "cleanup", run.id]);
    assert.notEqual(blocked.code, 0); assert.equal(blocked.envelope.error.code, "WORKTREE_MISMATCH"); assert.match(blocked.envelope.error.message, /exists only on this machine/);
    assert.ok(existsSync(run.path));
    const discarded = await w.invoke(["devrun", "cleanup", run.id, "--discard-changes"]);
    assert.equal(discarded.code, 0); assert.equal(discarded.envelope.warnings[0].code, "DEVRUN_UNCOMMITTED_WORK");
    data = await reconcile(w, run.id);
    assert.equal(data.overall, "consistent"); assert.deepEqual(codes(data), []);

    // Delivery directory prepared for a selected Candidate, then edited by someone.
    const second = await w.startRun();
    writeFileSync(join(second.path, "file.txt"), "deliver\n");
    const candidateID = await w.submit(second.id);
    const set = await w.invoke(["selection", "set", "--issue", w.f.issue.issue_id, "--issue-version", String(w.issueVersion), "--candidate", candidateID, "--expected-version", "0", "--reason", "Reviewed"]);
    assert.equal(set.code, 0, JSON.stringify(set.envelope));
    const target = join(w.root, "delivery");
    const made = await w.invoke(["selection", "materialize", "--issue", w.f.issue.issue_id, "--issue-version", String(w.issueVersion), "--expected-version", "1", "--path", target]);
    assert.equal(made.code, 0, JSON.stringify(made.envelope));
    data = await reconcile(w, second.id);
    assert.deepEqual(codes(data), []); assert.equal(data.delivery.worktrees[0].status, "ready");
    writeFileSync(join(target, "file.txt"), "edited by hand\n");
    const afterEdit = snapshot(w.repo, [target]);
    data = await reconcile(w, second.id);
    assert.deepEqual(codes(data), ["delivery_changed"]); assert.equal(data.delivery.worktrees[0].status, "changed");
    assert.equal(snapshot(w.repo, [target]), afterEdit);
  } finally { await w.close(); }
});

test("candidate artifact returns only the descriptor and candidate show is unchanged", async () => {
  const w = await world();
  try {
    const run = await w.startRun();
    writeFileSync(join(run.path, "file.txt"), "artifact\n");
    const candidateID = await w.submit(run.id);
    const artifact = await w.invoke(["candidate", "artifact", "--candidate", candidateID]);
    assert.equal(artifact.code, 0, JSON.stringify(artifact.envelope));
    const data = artifact.envelope.data;
    assert.equal(data.artifact.base_commit, w.baseline); assert.equal(data.artifact.base_commit_source, "issue_version_baseline");
    assert.match(data.artifact.patch_digest, /^sha256:[0-9a-f]{64}$/); assert.equal(data.artifact.artifact_format, "grounds.git-commit-artifact/v1");
    assert.ok(data.artifact.patch_size > 0); assert.equal(data.artifact.result_tree_oid, captureArtifact(run.path, w.baseline).result_tree_oid);
    assert.equal("patch" in data, false); assert.equal("patch" in data.artifact, false);
    const shown = await w.invoke(["candidate", "show", "--candidate", candidateID]);
    assert.equal(shown.code, 0);
    assert.equal("artifact" in shown.envelope.data.candidate, false);
    assert.equal((await w.invoke(["candidate", "artifact", "--candidate", newUUIDv7()])).code, 3);
  } finally { await w.close(); }
});

const tamper = (db: string, sql: string): void => { const database = new DatabaseSync(db); try { database.exec(`PRAGMA foreign_keys = OFF; ${sql}`); } finally { database.close(); } };

test("replay-check follows the documented decision rules", async () => {
  const w = await world();
  try {
    const run = await w.startRun();
    writeFileSync(join(run.path, "file.txt"), "replay\n");
    const candidateID = await w.submit(run.id);
    const check = async (extra: string[] = [], cwd = w.repo) => { const result = await w.invoke(["candidate", "replay-check", "--candidate", candidateID, ...extra], cwd); return result; };
    const verdict = (data: any) => [data.artifact_integrity, data.local_rebuild, data.reason, data.remote_reachability, data.remote_reason];

    // Rule 8 + reachable, offline and without touching the clone.
    const before = snapshot(w.repo);
    let result = await check();
    assert.equal(result.code, 0, JSON.stringify(result.envelope));
    assert.deepEqual(verdict(result.envelope.data), ["consistent", "yes", "ok", "reachable", "none"]);
    assert.equal("remote_hint" in result.envelope.data, false);
    assert.equal(result.envelope.data.refs_may_be_stale, true); assert.equal(result.envelope.data.refresh.outcome, "not_requested");
    assert.deepEqual(result.envelope.data.checked_refs.map((ref: any) => [ref.ref, ref.contains_base_commit]), [["refs/remotes/origin/main", true]]);
    assert.equal(snapshot(w.repo), before);

    // Selecting by Issue and public version needs a selected Candidate.
    const noSelection = await w.invoke(["candidate", "replay-check", "--issue", w.f.issue.issue_id, "--issue-version", String(w.issueVersion)]);
    assert.equal(noSelection.code, 4, JSON.stringify(noSelection.envelope));
    assert.equal((await w.invoke(["selection", "set", "--issue", w.f.issue.issue_id, "--issue-version", String(w.issueVersion), "--candidate", candidateID, "--expected-version", "0", "--reason", "Reviewed"])).code, 0);
    const bySelection = await w.invoke(["candidate", "replay-check", "--issue", w.f.issue.issue_id, "--issue-version", String(w.issueVersion)]);
    assert.equal(bySelection.code, 0); assert.equal(bySelection.envelope.data.candidate_id, candidateID);
    for (const args of [[], ["--issue", w.f.issue.issue_id], ["--issue-version", "1"], ["--candidate", candidateID, "--issue", w.f.issue.issue_id, "--issue-version", "1"]]) assert.equal((await w.invoke(["candidate", "replay-check", ...args])).code, 2);

    // The target branch was rewritten: no remote-tracking ref contains the base commit any more.
    const orphan = git(w.repo, "commit-tree", execFileSync("git", ["mktree"], { cwd: w.repo, input: "", encoding: "utf8" }).trim(), "-m", "rewritten");
    git(w.repo, "update-ref", "refs/remotes/origin/main", orphan);
    result = await check();
    assert.deepEqual(verdict(result.envelope.data), ["consistent", "yes", "ok", "unreachable", "none"]);
    assert.match(result.envelope.data.remote_hint, /rewritten/); assert.match(result.envelope.data.remote_hint, /does not prove the remote lacks the object/);
    // No remote-tracking refs at all is unknown, not unreachable.
    git(w.repo, "update-ref", "-d", "refs/remotes/origin/main");
    result = await check();
    assert.deepEqual(verdict(result.envelope.data), ["consistent", "yes", "ok", "unknown", "no_remote_tracking_refs"]);
    git(w.repo, "update-ref", "refs/remotes/origin/main", w.baseline.slice(5));

    // Refresh failure keeps the local conclusions and makes reachability unknown.
    const failed = await (async () => { process.env.GIT_SSH_COMMAND = "false"; try { return await check(["--refresh"]); } finally { delete process.env.GIT_SSH_COMMAND; } })();
    assert.equal(failed.code, 0, JSON.stringify(failed.envelope));
    assert.deepEqual(verdict(failed.envelope.data), ["consistent", "yes", "ok", "unknown", "refresh_failed"]);
    assert.equal(failed.envelope.data.refresh.outcome, "failed"); assert.equal(failed.envelope.data.refs_may_be_stale, true);

    // A refresh that succeeds replaces the observation.  A stub "ssh" serves the registered remote from a local bare repository.
    const upstream = join(w.root, "upstream.git");
    execFileSync("git", ["clone", "-q", "--bare", w.repo, upstream]);
    const stub = join(w.root, "fake-ssh.sh");
    writeFileSync(stub, `#!/bin/sh\nfor last; do :; done\ncmd=$(printf '%s' "$last" | sed "s#'/team/repo'#'${upstream}'#")\nexec sh -c "$cmd"\n`, { mode: 0o755 });
    git(w.repo, "update-ref", "-d", "refs/remotes/origin/main");
    const quiet = (): string => [git(run.path, "status", "--porcelain=v1", "--untracked-files=all"), readFileSync(join(w.repo, ".git", "worktrees", readdirSync(join(w.repo, ".git", "worktrees"))[0], "index")).toString("base64"), readFileSync(statePath(w, run.id)).toString("base64")].join("\n--\n");
    const quietBefore = quiet();
    const refreshed = await (async () => { process.env.GIT_SSH_COMMAND = stub; try { return await check(["--refresh"]); } finally { delete process.env.GIT_SSH_COMMAND; } })();
    assert.equal(refreshed.code, 0, JSON.stringify(refreshed.envelope));
    assert.equal(refreshed.envelope.data.refresh.outcome, "succeeded", JSON.stringify(refreshed.envelope.data.refresh)); assert.equal(refreshed.envelope.data.refs_may_be_stale, false);
    assert.equal(refreshed.envelope.data.remote_reachability, "reachable"); // unknown (no refs) became reachable
    assert.ok(existsSync(join(w.repo, ".git", "FETCH_HEAD")));
    assert.equal(quiet(), quietBefore, "refresh may change refs, FETCH_HEAD and objects only, never worktree, index or journal");
    // The target branch is rewritten upstream: the stale local observation says reachable, a refresh turns it into unreachable.
    const emptyTree = execFileSync("git", ["--git-dir", upstream, "mktree"], { input: "", encoding: "utf8" }).trim();
    const rewritten = execFileSync("git", ["--git-dir", upstream, "commit-tree", emptyTree, "-m", "rewritten"], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
    execFileSync("git", ["--git-dir", upstream, "update-ref", "refs/heads/master", rewritten]);
    git(w.repo, "update-ref", "refs/remotes/origin/master", w.baseline.slice(5));
    result = await check();
    assert.deepEqual(verdict(result.envelope.data), ["consistent", "yes", "ok", "reachable", "none"]); assert.equal(result.envelope.data.refs_may_be_stale, true);
    const afterRewrite = await (async () => { process.env.GIT_SSH_COMMAND = stub; try { return await check(["--refresh"]); } finally { delete process.env.GIT_SSH_COMMAND; } })();
    assert.deepEqual(verdict(afterRewrite.envelope.data), ["consistent", "yes", "ok", "unreachable", "none"]); assert.equal(afterRewrite.envelope.data.refs_may_be_stale, false);

    // Base commit absent locally: another clone of the same Repository that never had it.
    const other = join(w.root, "other");
    execFileSync("git", ["init", "-q", other]); git(other, "config", "user.name", "T"); git(other, "config", "user.email", "t@example.test"); git(other, "remote", "add", "origin", REMOTE);
    writeFileSync(join(other, "x.txt"), "x\n"); git(other, "add", "-A"); git(other, "commit", "-m", "elsewhere"); git(other, "update-ref", "refs/remotes/origin/main", git(other, "rev-parse", "HEAD"));
    result = await check([], other);
    assert.deepEqual(verdict(result.envelope.data), ["unknown", "no", "base_commit_missing", "unknown", "base_commit_missing_locally"]);

    // Shallow clone that never fetched the base commit is still "base_commit_missing", and nothing is fetched lazily.
    const shallow = join(w.root, "shallow");
    writeFileSync(join(w.repo, "second.txt"), "2\n"); git(w.repo, "add", "-A"); git(w.repo, "commit", "-m", "second");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${w.repo}`, shallow]); git(shallow, "remote", "set-url", "origin", REMOTE);
    result = await check([], shallow);
    assert.equal(result.envelope.data.reason, "base_commit_missing"); assert.equal(result.envelope.data.remote_reachability, "unknown");
    git(w.repo, "reset", "-q", "--hard", w.baseline.slice(5));

    // Fixed Git objects are the source. Local loss must not be called corrupt SQL patch bytes.
    const source = (await w.f.module.loadCandidateMaterialization(candidateID)).source!.commit.slice(5);
    const objectPath = join(w.repo, ".git", "objects", source.slice(0,2), source.slice(2));
    const bytes = readFileSync(objectPath); rmSync(objectPath);
    result = await check();
    assert.deepEqual([result.envelope.data.artifact_integrity, result.envelope.data.local_rebuild, result.envelope.data.reason], ["unknown", "unknown", "local_repository_incomplete"]);
    writeFileSync(objectPath, bytes);
    result = await check();
    assert.deepEqual([result.envelope.data.artifact_integrity, result.envelope.data.local_rebuild, result.envelope.data.reason], ["consistent", "yes", "ok"]);

  } finally { await w.close(); }
});

test("replay-check classifies patch and repository problems on the local side", async () => {
  const { replayCheck } = await import("../src/replay-check.js");
  const { sha256Bytes } = await import("../src/canonical-json.js");
  const root = mkdtempSync(join(tmpdir(), "grounds-replay-unit-"));
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", repo]); git(repo, "config", "user.name", "T"); git(repo, "config", "user.email", "t@example.test"); git(repo, "remote", "add", "origin", REMOTE);
    writeFileSync(join(repo, ".git/info/exclude"), "/.grounds/\n"); writeFileSync(join(repo, "file.txt"), "before\n"); git(repo, "add", "-A"); git(repo, "commit", "-m", "base");
    const baseline = `sha1:${git(repo, "rev-parse", "HEAD")}`;
    git(repo, "update-ref", "refs/remotes/origin/main", baseline.slice(5));
    writeFileSync(join(repo, "file.txt"), "after\n");
    const artifact = captureArtifact(repo, baseline);
    git(repo, "checkout", "--", "file.txt");
    const subject = (patch: Buffer, tree = artifact.result_tree_oid, base = baseline) => ({ candidate_id: newUUIDv7(), issue: { id: newUUIDv7(), version: 1 }, repository_id: newUUIDv7(), registered_remotes: [REMOTE], base_commit: base, patch_digest: sha256Bytes(patch), result_tree_oid: tree, patch: { state: "present" as const, bytes: patch } });
    const verdict = (subjectValue: ReturnType<typeof subject>, path = repo) => { const result = replayCheck(path, subjectValue, { refresh: false }); return [result.artifact_integrity, result.local_rebuild, result.reason]; };
    assert.deepEqual(verdict(subject(artifact.patch)), ["consistent", "yes", "ok"]);
    // The patch applies but yields a different tree than the one recorded.
    assert.deepEqual(verdict(subject(artifact.patch, `sha1:${"1".repeat(40)}`)), ["inconsistent", "no", "result_tree_mismatch"]);
    // A patch that cannot apply to the base.
    const unrelated = Buffer.from(artifact.patch.toString("utf8").replace("before", "something else"));
    assert.deepEqual(verdict(subject(unrelated)), ["inconsistent", "no", "patch_apply_failed"]);
    // An empty patch reproduces the base tree.
    assert.deepEqual(verdict(subject(Buffer.alloc(0), `sha1:${git(repo, "rev-parse", "HEAD^{tree}")}`)), ["consistent", "yes", "ok"]);
    // Nothing was written into the object database by any of the above.
    const objectsBefore = git(repo, "count-objects", "-v");
    verdict(subject(artifact.patch));
    assert.equal(git(repo, "count-objects", "-v"), objectsBefore);

    // Partial clone: the base commit is present but its blobs are not, and nothing may be fetched lazily.
    git(repo, "config", "uploadpack.allowFilter", "true"); git(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
    const partial = join(root, "partial");
    execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${repo}`, partial]); git(partial, "remote", "set-url", "origin", REMOTE);
    const lazyBefore = git(partial, "count-objects", "-v");
    assert.deepEqual(verdict(subject(artifact.patch), partial), ["unknown", "unknown", "local_repository_incomplete"]);
    assert.equal(git(partial, "count-objects", "-v"), lazyBefore, "no lazy fetch happened");
    // Reachability cannot be called "unreachable" in an incomplete clone, and an unregistered remote is undetermined.
    for (const ref of git(partial, "for-each-ref", "--format=%(refname)", "refs/remotes").split("\n").filter(Boolean)) git(partial, "update-ref", "-d", ref);
    const emptyTree = execFileSync("git", ["mktree"], { cwd: partial, input: "", encoding: "utf8" }).trim();
    const orphan = execFileSync("git", ["commit-tree", emptyTree, "-m", "elsewhere"], { cwd: partial, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
    git(partial, "update-ref", "refs/remotes/origin/main", orphan);
    const incomplete = replayCheck(partial, subject(artifact.patch), { refresh: false });
    assert.deepEqual([incomplete.remote_reachability, incomplete.remote_reason, "remote_hint" in incomplete], ["unknown", "repository_incomplete", false]);
    const undetermined = replayCheck(repo, { ...subject(artifact.patch), registered_remotes: [] }, { refresh: false });
    assert.deepEqual([undetermined.remote_reachability, undetermined.remote_reason], ["unknown", "remote_undetermined"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("historical result fields remain stable alongside explicit Git artifact and managed branch additions", async (t) => {
  let root: string;
  try { root = git(process.cwd(), "rev-parse", "--show-toplevel"); }
  catch { t.skip("historical Git comparison needs a source checkout, not a source export"); return; }
  const published = "ec81f1eaf6fdf9f703508e63f97893ffa65b5981";
  try { git(root, "cat-file", "-e", `${published}^{commit}`); } catch { t.skip("the published revision is not available in this clone"); return; }
  const read = (name: string): any => JSON.parse(git(root, "show", `${published}:docs/contracts/v1/${name}`));
  const now = (name: string): any => JSON.parse(readFileSync(join(root, "docs/contracts/v1", name), "utf8"));
  // Historical definitions remain exact after removing only these optional additions for managed branches.
  // The cleanup result gained exactly one property, `deletion_summary`, tied to `removed` by a single conditional; nothing else about it may change.
  const withoutDeletionSummary = (definition: any): any => { const copy = structuredClone(definition); delete copy.properties.deletion_summary; delete copy.allOf; return copy; };
  assert.deepEqual(withoutDeletionSummary(now("command-results.schema.json").$defs.devRunWorktreeCleanupResult), read("command-results.schema.json").$defs.devRunWorktreeCleanupResult, "devRunWorktreeCleanupResult");
  const cleanup = now("command-results.schema.json").$defs.devRunWorktreeCleanupResult;
  assert.equal(cleanup.required.includes("deletion_summary"), false, "deletion_summary is not unconditionally required");
  assert.deepEqual(cleanup.allOf, [{ if: { properties: { removed: { const: true } }, required: ["removed"] }, then: { required: ["deletion_summary"] }, else: { not: { required: ["deletion_summary"] } } }]);
  const withoutOptional = (definition: any, keys: string[]): any => {
    const copy = structuredClone(definition);
    for (const key of keys) {
      assert.ok(copy.properties[key], key);
      assert.equal(copy.required?.includes(key) ?? false, false, `${key} remains optional`);
      delete copy.properties[key];
    }
    return copy;
  };
  assert.deepEqual(now("command-results.schema.json").$defs.devRunMutationResult, read("command-results.schema.json").$defs.devRunMutationResult);
  const local = structuredClone(now("command-results.schema.json").$defs.localWorktree);
  local.oneOf[0] = withoutOptional(local.oneOf[0], ["development", "head", "base_commit", "active_dev_run_id", "owner_phase", "continuation", "working_tree_dirty", "git_operation_in_progress", "initial_base_commit", "definition_commit"]);
  assert.deepEqual(local, read("command-results.schema.json").$defs.localWorktree);
  const candidate = withoutOptional(now("query-results.schema.json").$defs.candidateRecord, ["source", "git_artifact", "lineage", "archive_history", "adoption"]);
  assert.equal(candidate.properties.artifact_format.const, "grounds.git-commit-artifact/v1");
  candidate.properties.artifact_format = read("query-results.schema.json").$defs.candidateRecord.properties.artifact_format;
  assert.deepEqual(candidate, read("query-results.schema.json").$defs.candidateRecord);
  assert.deepEqual(now("query-results.schema.json").$defs.candidateDetail, read("query-results.schema.json").$defs.candidateDetail);
  assert.deepEqual(withoutOptional(now("query-results.schema.json").$defs.devRunDetail, ["development", "local_worktree", "current_head", "initial_base_commit", "artifact_restoration", "preflight", "execution_mode"]), read("query-results.schema.json").$defs.devRunDetail);
  // New result types are additions only: every previously listed alternative is still listed.
  const before = read("query-results.schema.json").oneOf.map((entry: any) => entry.$ref); const after = now("query-results.schema.json").oneOf.map((entry: any) => entry.$ref);
  for (const ref of before) assert.ok(after.includes(ref), ref);
  const w = await world();
  try {
    const run = await w.startRun(); writeFileSync(join(run.path, "file.txt"), "compat\n");
    const abandoned = await w.invoke(["devrun", "abandon", run.id, "--expected-version", "1"]);
    assert.equal(abandoned.code, 0, JSON.stringify(abandoned.envelope)); assert.equal(abandoned.envelope.data.result_type, "patchledger.result.devrun-mutation/v1"); assert.equal("warnings" in abandoned.envelope.data, false);
    const cleaned = await w.invoke(["devrun", "cleanup", run.id, "--discard-changes"]);
    assert.equal(cleaned.code, 0, JSON.stringify(cleaned.envelope)); assert.equal(cleaned.envelope.data.result_type, "patchledger.result.devrun-worktree-cleanup/v1"); assert.equal("warnings" in cleaned.envelope.data, false);
  } finally { await w.close(); }
});
