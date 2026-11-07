import { LedgerFixture, testAgent } from "./fixture.js";
import { reviseTargetIssue } from "./preflight-fixture.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { commonRepositoryRoot, DevWorktreeModule } from "../src/dev-worktree.js";
import { Module } from "../src/module.js";
import { SQLStore } from "../src/sql-store.js";
import { PreflightService } from "../src/preflight.js";
import { newUUIDv7 } from "../src/identity.js";
import { snapshotRelation } from "../src/integration-history.js";
import { test } from "node:test";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const run = async (args: string[], cwd: string): Promise<{ code: number; envelope: any }> => {
  let output: string[] = [];
  const configAt = args.indexOf("--config");
  const root = configAt >= 0 ? dirname(resolve(cwd, args[configAt + 1])) : cwd;
  const code = await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") },
    () => runCLI(args, { cwd, stdout: (line) => { output = [...output, line]; }, stderr: () => undefined }));
  return { code, envelope: JSON.parse(output.join("\n")) };
};

const prepareRepository = (root: string, remotes: string[] = ["origin"]): string => {
  const repository = join(root, "repo");
  execFileSync("git", ["init", "-q", repository]);
  git(repository, "config", "user.name", "T");
  git(repository, "config", "user.email", "t@example.test");
  writeFileSync(join(repository, "a.txt"), "x\n");
  writeFileSync(join(repository, ".gitignore"), ".grounds/\n");
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "base");
  for (const name of remotes) git(repository, "remote", "add", name, `ssh://git@example.test/team/${name}`);
  return repository;
};

const initialize = async (root: string): Promise<string> => {
  const config = join(root, "config.yaml");
  const result = await run(["init", "--driver", "sqlite", "--path", join(root, "ledger.db"), "--config", config, "--non-interactive", "--json"], root);
  assert.equal(result.code, 0, JSON.stringify(result.envelope));
  return config;
};

async function historicalTargetOperation(root: string, repository: string, issueId: string, base: string): Promise<string> {
  const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.open();
    const work = new Module(store, newUUIDv7, undefined, (snapshot, commit) => snapshotRelation(repository, snapshot, commit), new PreflightService(store, repository).coordinator({ refresh: true }));
    const detail = await work.loadIssue(issueId);
    const operation = newUUIDv7();
    await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, () =>
      new DevWorktreeModule(repository, metadata.database_id, newUUIDv7, store).start({ operation_id: operation,
        repository_id: detail.repository.id, issue_revision_id: detail.issue_revision.id, baseline_oid: base }, async id => {
        const value = await work.startDevRun({ operation_id: operation, dev_run_id: id, issue_id: issueId,
          issue_revision_id: detail.issue_revision.id, issue_revision_explicit: false, base_commit: base,
          repository_remote_snapshot: detail.repository.canonical_remote, attribution: { kind: "human", git_name: "T", git_email: "t@example.test" } });
        return { value, dev_run_id: value.result.context.dev_run.id };
      }));
    return operation;
  } finally { await store.close(); }
}

test("historical target operation replays and submits without changing its contract snapshot", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-cli-target-base-")));
  try {
    const repository = prepareRepository(root), snapshot = git(repository, "rev-parse", "HEAD"), config = await initialize(root);
    // A real, refreshable remote so the target-flow preflight can confirm freshness.
    git(repository, "remote", "set-url", "origin", "ssh://git@example.test/team/repo");
    const originRemote = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "-q", originRemote]);
    git(repository, "config", `url.file://${originRemote}.insteadOf`, "ssh://git@example.test/team/repo");
    git(repository, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(repository, "update-ref", "refs/remotes/origin/main", "HEAD");
    const store = SQLStore.sqlite(join(root, "ledger.db"));
    const fixture = await LedgerFixture.createWithStore(store, undefined, {
      preflightCoordinator: new PreflightService(store, repository).coordinator({ refresh: true }),
    });
    const issueId = fixture.issue.issue_id;
    const revised = await reviseTargetIssue(fixture.module, store, repository, {
      attribution: testAgent, issue_id: issueId, expected_predecessor_id: fixture.issue.issue_revision_id,
      requirement_revision_id: fixture.requirement.requirement_revision_id, requirement_revision_explicit: true,
      baseline: { git_oid: `sha1:${snapshot}`, reachability: "remote_tracking_reachable" },
      input: { format: 1, summary: "Target issue", target_branch: { remote: "origin", ref: "refs/heads/main" },
        goals: [{ statement: "Implement the feature", criteria: ["Feature works"] }] },
    });
    await fixture.close();
    writeFileSync(join(repository, "upstream.txt"), "upstream\n"); git(repository, "add", "upstream.txt"); git(repository, "commit", "-m", "upstream");
    const base = git(repository, "rev-parse", "HEAD"); git(repository, "push", "-q", "origin", "HEAD:refs/heads/main"); git(repository, "update-ref", "refs/remotes/origin/main", "HEAD");
    const startObservation = await run(["preflight", "observe", "--phase", "start", "--issue", issueId, "--refresh", "--config", config, "--json"], repository);
    assert.equal(startObservation.code, 0, JSON.stringify(startObservation.envelope));
    const startAssessmentFile = join(root, "start-assessment.json");
    writeFileSync(startAssessmentFile, JSON.stringify({ assessment: "applicable", rationale: "Contract still applies to the advanced target", affected: [] }));
    await run(["preflight", "assess", "--observation", startObservation.envelope.data.observation_id, "--file", startAssessmentFile, "--config", config, "--json"], repository);
    const bypass = await run(["devrun", "start", "--issue", issueId, "--legacy-fixed", "--base-commit", `sha1:${base}`, "--refresh", "--config", config, "--json"], repository);
    assert.notEqual(bypass.code, 0);
    const historical = await historicalTargetOperation(root, repository, issueId, `sha1:${base}`);
    const started = await run(["devrun", "start", "--issue", issueId, "--base-commit", `sha1:${base}`, "--operation-id", historical, "--config", config, "--json"], repository);
    assert.equal(started.code, 0, JSON.stringify(started.envelope));
    const context = started.envelope.data.context, worktree = started.envelope.data.local_worktree.path;
    assert.equal(context.base_commit, `sha1:${base}`); assert.equal(context.baseline.git_oid, `sha1:${snapshot}`);
    assert.deepEqual(context.snapshot_relation, { kind: "ahead", base_ahead: 1, snapshot_ahead: 0 });
    assertContract("devrun-context.schema.json", context);
    assert.equal(git(worktree, "rev-parse", "HEAD"), base);
    writeFileSync(join(worktree, "a.txt"), "feature\n");
    git(worktree, "add", "a.txt"); git(worktree, "commit", "-m", "test source");
    const transport = archiveCLITransport(t, root, originRemote, context.repository.id, "ssh://git@example.test/team/repo");
    git(repository, "config", "--unset-all", `url.file://${originRemote}.insteadOf`);
    const template = await run(["candidate", "template", context.dev_run.id, "--config", config, "--json"], repository);
    assert.equal(template.code, 0, JSON.stringify(template.envelope));
    const submission = template.envelope.data.submission;
    submission.explanation = "实现功能";
    for (const claim of submission.claims) { claim.explanation = "完成目标"; for (const criterion of claim.criteria) criterion.explanation = "满足标准"; }
    if (submission.change_rationales) for (const rationale of submission.change_rationales) { rationale.rationale = "实现目标所需"; rationale.relation = "implements"; rationale.target_refs = [{ type: "criterion", id: submission.claims[0].criteria[0].criterion_id }]; }
    const file = join(root, "submission.json"); writeFileSync(file, JSON.stringify(submission));
    const submitted = await run(["candidate", "submit", context.dev_run.id, "--expected-version", "1", "--file", file, "--archive-policy", transport.policy(), "--config", config, "--json"], repository);
    assert.equal(submitted.code, 0, JSON.stringify(submitted.envelope));
    const descriptor = await run(["candidate", "artifact", submitted.envelope.data.candidate_id, "--config", config, "--json"], repository);
    assert.equal(descriptor.code, 0, JSON.stringify(descriptor.envelope));
    assert.equal(descriptor.envelope.data.artifact.base_commit, `sha1:${base}`);
    assert.equal(descriptor.envelope.data.artifact.base_commit_source, "candidate");
    const blind = await run(["verification", "context", submitted.envelope.data.candidate_id, "--phase", "blind", "--config", config, "--json"], repository);
    assert.equal(blind.code, 0, JSON.stringify(blind.envelope));
    assert.deepEqual(blind.envelope.data.context.snapshot_relation, context.snapshot_relation);
    assertContract("verification-context.schema.json", blind.envelope.data.context);

    const remote = originRemote;
    git(repository, "push", remote, `${base}:refs/heads/main`);
    const source = `sha1:${git(worktree, "rev-parse", "HEAD")}`;
    git(repository, "push", remote, `${source.slice(5)}:refs/heads/feature`);
    const selected = await run(["selection", "set", "--issue", issueId, "--issue-version", String(revised.result.revision_number), "--candidate", submitted.envelope.data.candidate_id, "--expected-version", "0", "--reason", "测试中明确选择尚未验证的候选", "--config", config, "--json"], repository);
    assert.equal(selected.code, 0, JSON.stringify(selected.envelope));
    const observed = await run(["integration", "observe", "--candidate", submitted.envelope.data.candidate_id, "--selection", selected.envelope.data.selection.id, "--selection-version", "1", "--source-remote", "origin", "--source-ref", "refs/heads/feature", "--source-commit", source, "--refresh", "--config", config, "--json"], repository);
    assert.equal(observed.code, 0, JSON.stringify(observed.envelope));
    assertContract("cli-envelope.schema.json", observed.envelope);
    assert.equal(observed.envelope.data.record.gate.decision.consistency, "ready");
    assert.equal(observed.envelope.data.record.gate.verification.current_verification.standing, "unverified");
    const shown = await run(["integration", "show", observed.envelope.data.record.id, "--config", config, "--json"], repository);
    assert.equal(shown.code, 0, JSON.stringify(shown.envelope));
    assert.deepEqual(shown.envelope.data.record, observed.envelope.data.record);
    git(repository, "push", remote, `${source.slice(5)}:refs/heads/main`);
    const adoption = join(root, "adoption.json");
    writeFileSync(adoption, JSON.stringify({ format: "grounds.adoption-binding/v1", repository_id: context.repository.id, candidate_id: submitted.envelope.data.candidate_id, source_commit: source, landed_commit: source, target: { remote: "origin", ref: "refs/heads/main" }, method: "ff", target_predecessor: `sha1:${base}`, source: { kind: "user_confirmation", reference: "Controlled temporary target fast-forward" } }));
    const landing = await run(["integration", "landing", "--observation", observed.envelope.data.record.id, "--commit", source, "--provenance", "user", "--adoption-file", adoption, "--refresh", "--config", config, "--json"], repository);
    assert.equal(landing.code, 0, JSON.stringify(landing.envelope)); assertContract("cli-envelope.schema.json", landing.envelope);
    assert.equal(landing.envelope.data.record.landing.decision.delivery_link_commit, source);
    const linked = await run(["delivery-link", "record", "--candidate", submitted.envelope.data.candidate_id, "--commit", source.slice(5), "--expected-version", "0", "--config", config, "--json"], repository);
    assert.equal(linked.code, 0, JSON.stringify(linked.envelope));
    const trace = await run(["trace", "--at", "a.txt:1", "--config", config, "--json"], worktree);
    assert.equal(trace.code, 0, JSON.stringify(trace.envelope));
    assert.match(JSON.stringify(trace.envelope.data), new RegExp(submitted.envelope.data.candidate_id));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
