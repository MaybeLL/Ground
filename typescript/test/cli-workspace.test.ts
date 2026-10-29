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
import { parseIssueMarkdown, renderIssueMarkdown } from "../src/workspace-markdown.js";

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

test("CLI Workspace owns the complete Requirement and Issue authoring lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-cli-workspace-"));
  try {
    const repository = prepareRepository(root);
    const config = await initialize(root);
    const created = await run(["workspace", "new", "--format", "markdown", "first", "--config", config, "--json"], repository);
    assert.equal(created.code, 0, JSON.stringify(created.envelope));
    assertContract("cli-envelope.schema.json", created.envelope);
    assert.match(created.envelope.data.path, /\.grounds\/drafts\/[^/]+\/first$/);

    const dryRun = await run(["workspace", "publish", "first", "--config", config, "--dry-run", "--json"], repository);
    assert.equal(dryRun.code, 0, JSON.stringify(dryRun.envelope));
    assert.equal(dryRun.envelope.data.command, "workspace.publish");
    assert.equal(dryRun.envelope.data.dry_run, true);
    assertContract("cli-envelope.schema.json", dryRun.envelope);
    assert.deepEqual(dryRun.envelope.data.requirement, { action: "create", version: 1 });
    assert.deepEqual(dryRun.envelope.data.issues[0].requirement, { version: 1 });

    const published = await run(["workspace", "publish", "first", "--config", config, "--json"], repository);
    assert.equal(published.code, 0, JSON.stringify(published.envelope));
    assertContract("cli-envelope.schema.json", published.envelope);
    assert.equal(published.envelope.data.requirement.version, 1);
    assert.equal(published.envelope.data.issues[0].version, 1);

    const shown = await run(["workspace", "show", "first", "--config", config, "--json"], repository);
    assert.equal(shown.envelope.data.state, "clean");
    const requirement = await run(["requirement", "show", published.envelope.data.requirement.id, "--config", config, "--json"], repository);
    assert.equal(requirement.code, 0, JSON.stringify(requirement.envelope));
    assert.equal(requirement.envelope.data.requirement.id, published.envelope.data.requirement.id);

    const removed = await run(["workspace", "remove", "first", "--config", config, "--json"], repository);
    assert.equal(removed.code, 0, JSON.stringify(removed.envelope));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Chinese Workspace policy checks dry-run and publication, with an explicit override", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-cli-workspace-language-"));
  try {
    const repository = prepareRepository(root);
    const config = await initialize(root);
    const chinese = await run(["workspace", "new", "--format", "markdown", "chinese", "--content-language", "zh-CN", "--config", config, "--json"], repository);
    assert.equal(chinese.code, 0, JSON.stringify(chinese.envelope));
    assert.match(readFileSync(join(chinese.envelope.data.path, "requirement.md"), "utf8"), /描述需求/);
    const chinesePlan = await run(["workspace", "publish", "chinese", "--content-language", "zh-CN", "--dry-run", "--config", config, "--json"], repository);
    assert.equal(chinesePlan.code, 0, JSON.stringify(chinesePlan.envelope));
    const chinesePublished = await run(["workspace", "publish", "chinese", "--content-language", "zh-CN", "--config", config, "--json"], repository);
    assert.equal(chinesePublished.code, 0, JSON.stringify(chinesePublished.envelope));

    const english = await run(["workspace", "new", "--format", "markdown", "english", "--config", config, "--json"], repository);
    assert.equal(english.code, 0, JSON.stringify(english.envelope));
    const blocked = await run(["workspace", "publish", "english", "--content-language", "zh-CN", "--dry-run", "--config", config, "--json"], repository);
    assert.equal(blocked.code, 2);
    assert.equal(blocked.envelope.error.details.field, "content_language");
    assert.match(blocked.envelope.error.details.reason, /requirement\.md\.summary/);
    const unpublished = await run(["workspace", "show", "english", "--config", config, "--json"], repository);
    assert.equal(unpublished.envelope.data.state, "draft");

    const overridden = await run(["workspace", "publish", "english", "--content-language", "zh-CN", "--language-override-reason", "保留上游英文原文", "--config", config, "--json"], repository);
    assert.equal(overridden.code, 0, JSON.stringify(overridden.envelope));
    assert.ok(overridden.envelope.warnings.some((warning: { code: string }) => warning.code === "CONTENT_LANGUAGE_OVERRIDE"));
    const shown = await run(["requirement", "show", overridden.envelope.data.requirement.id, "--config", config, "--json"], repository);
    assert.match(JSON.stringify(shown.envelope.data), /Describe the requirement/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Workspace new requires an explicit remote choice when the clone is ambiguous", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-cli-workspace-remotes-"));
  try {
    const repository = prepareRepository(root, ["origin", "upstream"]);
    const config = await initialize(root);
    const ambiguous = await run(["workspace", "new", "--format", "markdown", "ambiguous", "--config", config, "--json"], repository);
    assert.equal(ambiguous.code, 6);
    assert.equal(ambiguous.envelope.error.code, "REPOSITORY_AMBIGUOUS");
    const selected = await run(["workspace", "new", "--format", "markdown", "selected", "--remote", "upstream", "--config", config, "--json"], repository);
    assert.equal(selected.code, 0, JSON.stringify(selected.envelope));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Workspace new can remain unbound when the clone has no remote", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-cli-workspace-no-remote-"));
  try {
    const repository = prepareRepository(root, []);
    const config = await initialize(root);
    const result = await run(["workspace", "new", "--format", "markdown", "missing", "--config", config, "--json"], repository);
    assert.equal(result.code, 0, JSON.stringify(result.envelope));
    const manifest = JSON.parse(readFileSync(join(result.envelope.data.path, ".workspace.json"), "utf8"));
    assert.equal(manifest.repository_remote, "");
    const publish = await run(["workspace", "publish", "missing", "--config", config, "--json"], repository);
    assert.notEqual(publish.code, 0);
    assert.match(JSON.stringify(publish.envelope.error), /bind a Repository/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Workspace publication blocks a second Issue for one Requirement and Repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-cli-workspace-issue-limit-"));
  try {
    const repository = prepareRepository(root);
    const config = await initialize(root);
    const created = await run(["workspace", "new", "--format", "markdown", "two", "--config", config, "--json"], repository);
    const main = join(created.envelope.data.path, "issues", "main.md");
    writeFileSync(join(created.envelope.data.path, "issues", "extra.md"), readFileSync(main, "utf8").replace("Implement the requirement", "Implement the second delivery"));

    const blocked = await run(["workspace", "publish", "two", "--dry-run", "--config", config, "--json"], repository);
    assert.equal(blocked.code, 6);
    assert.equal(blocked.envelope.error.code, "REPOSITORY_ISSUE_LIMIT");
    assert.match(blocked.envelope.error.details.reason, /--allow-second-issue-per-repository/);
    assert.equal(blocked.envelope.error.details.resource_type, "requirement");

    const missingReason = await run(["workspace", "publish", "two", "--allow-second-issue-per-repository", "--config", config, "--json"], repository);
    assert.equal(missingReason.code, 2);
    assert.equal(missingReason.envelope.error.details.field, "override-reason");

    const overridden = await run(["workspace", "publish", "two", "--allow-second-issue-per-repository", "--override-reason", "split reviewed with the team", "--config", config, "--json"], repository);
    assert.equal(overridden.code, 0, JSON.stringify(overridden.envelope));
    assert.equal(overridden.envelope.data.issues.length, 2);
    assert.ok(overridden.envelope.warnings.some((warning: { code: string }) => warning.code === "SECOND_ISSUE_PER_REPOSITORY_OVERRIDE"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Workspace publication applies baseline override policy from Markdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-cli-workspace-baseline-"));
  try {
    const repository = prepareRepository(root);
    const historical = git(repository, "rev-parse", "HEAD");
    writeFileSync(join(repository, "a.txt"), "second\n");
    git(repository, "add", "-A");
    git(repository, "commit", "-m", "second");
    const config = join(root, "config.yaml");
    await run(["init", "--driver", "sqlite", "--baseline-policy", "require_override", "--path", join(root, "ledger.db"), "--config", config, "--non-interactive", "--json"], root);
    const created = await run(["workspace", "new", "--format", "markdown", "historical", "--config", config, "--json"], repository);
    const issue = join(created.envelope.data.path, "issues", "main.md");
    writeFileSync(issue, readFileSync(issue, "utf8").replace("baseline: HEAD", "baseline: HEAD~1"));
    const blocked = await run(["workspace", "publish", "historical", "--config", config, "--json"], repository);
    assert.equal(blocked.code, 6);
    assert.equal(blocked.envelope.error.code, "BASELINE_UNAVAILABLE");
    const published = await run(["workspace", "publish", "historical", "--config", config, "--allow-unpublished-baseline", "--override-reason", "local historical test", "--json"], repository);
    assert.equal(published.code, 0, JSON.stringify(published.envelope));
    assert.equal(published.envelope.data.issues[0].baseline.git_oid, `sha1:${historical}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    const originRemote = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "-q", originRemote]);
    git(repository, "config", `url.file://${originRemote}.insteadOf`, "ssh://git@example.test/team/origin");
    git(repository, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(repository, "update-ref", "refs/remotes/origin/main", "HEAD");
    const created = await run(["workspace", "new", "target", "--config", config, "--json"], repository);
    assert.equal(created.code, 0, JSON.stringify(created.envelope));
    const read = await run(["workspace", "read", "target", "--config", config, "--json"], repository);
    assert.equal(read.code, 0, JSON.stringify(read.envelope));
    const draft = read.envelope.data.draft;
    draft.issues[0].input.target_branch = { remote: "origin", ref: "refs/heads/main" };
    draft.issues[0].baselineExpression = `sha1:${snapshot}`;
    const draftFile = join(root, "draft.json"); writeFileSync(draftFile, JSON.stringify(draft));
    const saved = await run(["workspace", "save", "target", "--file", draftFile, "--expected-version", read.envelope.data.version, "--config", config, "--json"], repository);
    assert.equal(saved.code, 0, JSON.stringify(saved.envelope));
    // Publish gate: observe the declared target bound to the reviewed scope, then assess.
    const reviewed = await run(["workspace", "read", "target", "--config", config, "--json"], repository);
    const publishObservation = await run(["preflight", "observe", "--phase", "publish", "--workspace", "target", "--expected-version", reviewed.envelope.data.version, "--refresh", "--config", config, "--json"], repository);
    assert.equal(publishObservation.code, 0, JSON.stringify(publishObservation.envelope));
    const publishAssessmentFile = join(root, "publish-assessment.json");
    writeFileSync(publishAssessmentFile, JSON.stringify({ assessment: "applicable", rationale: "Reviewed the new target Issue against the refreshed target", affected: [] }));
    await run(["preflight", "assess", "--observation", publishObservation.envelope.data.observation_id, "--file", publishAssessmentFile, "--config", config, "--json"], repository);
    const published = await run(["workspace", "publish", "target", "--expected-version", saved.envelope.data.version, "--refresh", "--config", config, "--json"], repository);
    assert.equal(published.code, 0, JSON.stringify(published.envelope));
    writeFileSync(join(repository, "upstream.txt"), "upstream\n"); git(repository, "add", "upstream.txt"); git(repository, "commit", "-m", "upstream");
    const base = git(repository, "rev-parse", "HEAD"); git(repository, "push", "-q", "origin", "HEAD:refs/heads/main"); git(repository, "update-ref", "refs/remotes/origin/main", "HEAD");
    const startObservation = await run(["preflight", "observe", "--phase", "start", "--issue", published.envelope.data.issues[0].id, "--refresh", "--config", config, "--json"], repository);
    assert.equal(startObservation.code, 0, JSON.stringify(startObservation.envelope));
    const startAssessmentFile = join(root, "start-assessment.json");
    writeFileSync(startAssessmentFile, JSON.stringify({ assessment: "applicable", rationale: "Contract still applies to the advanced target", affected: [] }));
    await run(["preflight", "assess", "--observation", startObservation.envelope.data.observation_id, "--file", startAssessmentFile, "--config", config, "--json"], repository);
    const bypass = await run(["devrun", "start", "--issue", published.envelope.data.issues[0].id, "--legacy-fixed", "--base-commit", `sha1:${base}`, "--refresh", "--config", config, "--json"], repository);
    assert.notEqual(bypass.code, 0);
    const historical = await historicalTargetOperation(root, repository, published.envelope.data.issues[0].id, `sha1:${base}`);
    const started = await run(["devrun", "start", "--issue", published.envelope.data.issues[0].id, "--base-commit", `sha1:${base}`, "--operation-id", historical, "--config", config, "--json"], repository);
    assert.equal(started.code, 0, JSON.stringify(started.envelope));
    const context = started.envelope.data.context, worktree = started.envelope.data.local_worktree.path;
    assert.equal(context.base_commit, `sha1:${base}`); assert.equal(context.baseline.git_oid, `sha1:${snapshot}`);
    assert.deepEqual(context.snapshot_relation, { kind: "ahead", base_ahead: 1, snapshot_ahead: 0 });
    assertContract("devrun-context.schema.json", context);
    assert.equal(git(worktree, "rev-parse", "HEAD"), base);
    writeFileSync(join(worktree, "a.txt"), "feature\n");
    git(worktree, "add", "a.txt"); git(worktree, "commit", "-m", "test source");
    const transport = archiveCLITransport(t, root, originRemote, context.repository.id, "ssh://git@example.test/team/origin");
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
    const selected = await run(["selection", "set", "--issue", published.envelope.data.issues[0].id, "--issue-version", "1", "--candidate", submitted.envelope.data.candidate_id, "--expected-version", "0", "--reason", "测试中明确选择尚未验证的候选", "--config", config, "--json"], repository);
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
