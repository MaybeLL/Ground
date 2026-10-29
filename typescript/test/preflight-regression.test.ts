import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCLI, parseArgs, commandNeedsOperationID } from "../src/cli.js";
import { resolveBaseline } from "../src/git.js";
import { newUUIDv7 } from "../src/identity.js";
import { PreflightService, contentDigestFor, issueWriteBinding, publishAuthoringBinding } from "../src/preflight.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { SQLStore } from "../src/sql-store.js";
import { LedgerFixture, testAgent } from "./fixture.js";

/**
 * Reachable-gap regressions for the target-flow freshness gate. Every case here
 * drives the public CLI (or the Module service the CLI itself calls) against a
 * real SQLite ledger and a real local bare remote. Nothing is mocked: a
 * "refreshed" observation is only ever produced by a real `git fetch`, and a
 * target that moved is always advanced by a second real clone.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const target = { remote: "origin", ref: "refs/heads/main" };

interface Invocation {
  code: number;
  envelope: any;
}

interface Fixture {
  root: string;
  source: string;
  remote: string;
  f: LedgerFixture;
  base: string;
  config: string;
  git: (cwd: string, ...args: string[]) => string;
  invoke: (args: string[]) => Promise<Invocation>;
  ok: (args: string[]) => Promise<any>;
  issueRevisionId: string;
  planId: string;
}

async function fixture(t: { after: (f: () => Promise<void>) => void }): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-preflight-regression-")));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  mkdirSync(source);
  git(root, "init", "--bare", "-q", remote);
  git(source, "init", "-qb", "main");
  git(source, "config", "user.name", "Preflight Regression");
  git(source, "config", "user.email", "regression@invalid");
  git(source, "remote", "add", "origin", "ssh://git@example.test/team/repo");
  git(source, "config", `url.file://${remote}.insteadOf`, "ssh://git@example.test/team/repo");
  writeFileSync(join(source, ".gitignore"), ".grounds/\n");
  writeFileSync(join(source, "file"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "base");
  const base = `sha1:${git(source, "rev-parse", "HEAD")}`;
  git(source, "push", "-q", remote, "HEAD:refs/heads/main");
  git(source, "fetch", "-q", "origin");

  const databasePath = join(root, "ledger.db");
  const store = SQLStore.sqlite(databasePath);
  // The module this file's real CLI drives holds the production coordinator, so
  // every target write in the route below is gated by a real refresh.
  const f = await LedgerFixture.createWithStore(store, () => store.close(), { preflightCoordinator: new PreflightService(store, source).coordinator({ refresh: true }) });
  t.after(async () => {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  });
  // Sealed locally rather than through preflight-fixture's helper, so this file
  // owns its write binding and stays valid however the main session reworks the
  // shared fixtures.
  const issueInput = {
    format: 1 as const,
    summary: "Preflight regression target Issue",
    target_branch: target,
    goals: [{ statement: "Keep the target gate closed", criteria: ["A stale premise cannot start work"] }],
  };
  const binding = issueWriteBinding({
    requirement_revision_id: f.requirement.requirement_revision_id,
    predecessor_requirement_revision_id: f.requirement.requirement_revision_id,
    issue_id: f.issue.issue_id,
    expected_predecessor_id: f.issue.issue_revision_id,
    baseline_oid: base,
    target_branch: target,
    issue_input: issueInput,
  });
  const publishService = new PreflightService(f.store, source);
  const sealedObservation = await publishService.observe({
    operation_id: newUUIDv7(),
    attribution: testAgent,
    phase: "publish",
    refresh: true,
    repository_id: f.repository.repository_id,
    target,
    content_digest: contentDigestFor(binding),
  });
  assert.equal((sealedObservation.data.observation as { refreshed: boolean }).refreshed, true, "the fixture's target must be refreshable");
  await publishService.assess({
    operation_id: newUUIDv7(),
    attribution: testAgent,
    observation_id: sealedObservation.id,
    file: { assessment: "applicable", author: testAgent, rationale: "Sealed contract reviewed against the refreshed target", affected: [] },
  });
  const revised = await f.module.reviseIssue({
    operation_id: newUUIDv7(),
    attribution: testAgent,
    issue_id: f.issue.issue_id,
    expected_predecessor_id: f.issue.issue_revision_id,
    requirement_revision_id: f.requirement.requirement_revision_id,
    requirement_revision_explicit: true,
    baseline: { git_oid: base, reachability: "remote_tracking_reachable" },
    input: issueInput,
  });
  const database = (await f.store.inspect()).database_id;
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: databasePath, expected_database_id: database } }));
  const invoke = async (args: string[]): Promise<Invocation> => {
    const write = commandNeedsOperationID(parseArgs(args));
    const argv = [...args, ...(write && !args.includes("--operation-id") ? ["--operation-id", newUUIDv7()] : [])];
    const withIdentity = [...argv, ...(write ? ["--agent-id", "preflight-regression", "--agent-name", "Preflight Regression"] : [])];
    const out: string[] = [];
    const code = await withRuntimeDirectories(
      { runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") },
      () => runCLI([...withIdentity, "--config", config, "--json"], { cwd: source, stdout: (line) => out.push(line), stderr: () => undefined }),
    );
    return { code, envelope: JSON.parse(out.join("\n")) };
  };
  const ok = async (args: string[]): Promise<any> => {
    const invocation = await invoke(args);
    assert.equal(invocation.code, 0, JSON.stringify(invocation.envelope));
    return invocation.envelope.data;
  };
  const plan = await ok(["devrun", "plan", "--issue-slug", "fixture", "--repository", f.repository.repository_id, "--definition-commit", base, "--target-remote", "origin", "--target-branch", "refs/heads/main"]);
  return { root, source, remote, f, base, config, git, invoke, ok, issueRevisionId: revised.result.issue_revision_id, planId: plan.plan.workspace_id };
}

/** A second real clone that advances the remote target. Never runs in `source`. */
function advanceRemote(x: Fixture, name = "advance"): string {
  const peer = join(x.root, `peer-${name}`);
  if (!existsSync(peer)) git(x.root, "clone", "-q", "-b", "main", x.remote, peer);
  git(peer, "config", "user.name", "Peer");
  git(peer, "config", "user.email", "peer@invalid");
  writeFileSync(join(peer, `${name}.txt`), `${name}\n`);
  git(peer, "add", ".");
  git(peer, "commit", "-qm", name);
  git(peer, "push", "-q", "origin", "HEAD:refs/heads/main");
  return `sha1:${git(peer, "rev-parse", "HEAD")}`;
}

/** A valid commit that exists only locally, never pushed to the observed target. */
function unreachableCommit(x: Fixture): string {
  const scratch = join(x.root, "scratch");
  if (!existsSync(scratch)) git(x.root, "clone", "-q", "-b", "main", x.remote, scratch);
  git(scratch, "config", "user.name", "Scratch");
  git(scratch, "config", "user.email", "scratch@invalid");
  writeFileSync(join(scratch, "scratch.txt"), "scratch\n");
  git(scratch, "add", ".");
  git(scratch, "commit", "-qm", "unreachable");
  return `sha1:${git(scratch, "rev-parse", "HEAD")}`;
}

/** The real trades: an applicable assessment of the exact refresh just recorded. */
async function assessApplicable(x: Fixture, observationId: string, rationale: string): Promise<string> {
  const file = join(x.root, `assessment-${observationId}.json`);
  writeFileSync(file, JSON.stringify({ assessment: "applicable", rationale, affected: [] }));
  const assessed = await x.ok(["preflight", "assess", "--observation", observationId, "--file", file]);
  return assessed.assessment_id as string;
}

// --- Gap 1: an observation taken before the remote advanced never authorised
// the publication. The record on its own is not fresh: this clone's tracking ref
// still points at the old commit and no further refresh happened.
test("workspace publish is refused when the remote target advanced after the reviewed observation and this clone never refreshed", async (t) => {
  const x = await fixture(t);
  const created = await x.ok(["workspace", "new", "pub"]);
  const manifestPath = join(created.path, ".workspace.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.draft.issues[0].input.target_branch = target;
  manifest.draft.issues[0].baselineExpression = x.base;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const reviewed = (await x.ok(["workspace", "read", "pub"])).version as string;
  const observed = await x.ok(["preflight", "observe", "--phase", "publish", "--workspace", "pub", "--expected-version", reviewed, "--refresh"]);
  assert.equal(observed.observation.refreshed, true);
  assert.equal(observed.observation.commit.oid, x.base);
  await assessApplicable(x, observed.observation_id, "Reviewed these exact declarations against the refreshed target");

  // A different clone advances the target. This clone keeps its stale tracking
  // ref and the recorded observation stays the newest ledger fact.
  const advanced = advanceRemote(x);
  assert.notEqual(advanced, x.base);
  assert.equal(x.git(x.source, "rev-parse", "refs/remotes/origin/main"), x.base.replace("sha1:", ""));

  const issuesBefore = (await x.ok(["issue", "list", "--limit", "50"])).resources.length;
  const refused = await x.invoke(["workspace", "publish", "pub", "--expected-version", reviewed, "--refresh"]);
  assert.notEqual(refused.code, 0, `publication used a pre-advance observation: ${JSON.stringify(refused.envelope)}`);
  assert.equal(refused.envelope.error.code, "STATE_CONFLICT");
  assert.match(refused.envelope.error.message, /target changed or could not be refreshed/);
  assert.equal(x.git(x.source, "rev-parse", "refs/remotes/origin/main"), advanced.replace("sha1:", ""), "the refusal must follow a real final refresh, not a missing-authorization error");
  const issuesAfter = (await x.ok(["issue", "list", "--limit", "50"])).resources.length;
  assert.equal(issuesAfter, issuesBefore, "a refused publication must not write");
});

// --- Positive path: the same CLI sequence, with the observation taken after the
// refresh, does publish. This is the recovery the refusals above must point at:
// the gate is satisfiable, not a dead end.
test("workspace publish succeeds when the observation is refreshed for the reviewed version", async (t) => {
  const x = await fixture(t);
  const created = await x.ok(["workspace", "new", "pub"]);
  const manifestPath = join(created.path, ".workspace.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.draft.issues[0].input.target_branch = target;
  manifest.draft.issues[0].baselineExpression = x.base;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const reviewed = (await x.ok(["workspace", "read", "pub"])).version as string;
  const observed = await x.ok(["preflight", "observe", "--phase", "publish", "--workspace", "pub", "--expected-version", reviewed, "--refresh"]);
  assert.equal(observed.observation.refreshed, true);
  assert.equal(observed.binds.scope_digest, reviewed);
  await assessApplicable(x, observed.observation_id, "Reviewed these exact declarations against the refreshed target");

  const published = await x.ok(["workspace", "publish", "pub", "--expected-version", reviewed, "--refresh"]);
  assert.equal(published.issues.length, 1);
  assert.equal(published.issues[0].baseline.git_oid, x.base);
});


test("a first start refreshes the target and refuses an assessed but outdated base before creating a worktree", async t => {
  const x = await fixture(t);
  const observed = await x.ok(["preflight", "observe", "--phase", "start", "--issue", x.f.issue.issue_id, "--refresh"]);
  const assessment = await assessApplicable(x, observed.observation_id, "The sealed contract applies to the observed first-start target");
  const advanced = advanceRemote(x, "before-start");
  const refused = await x.invoke(["devrun", "start", "--development-mode", "simple", "--issue", x.f.issue.issue_id, "--plan", x.planId,
    "--base-commit", x.base, "--preflight", assessment, "--refresh"]);
  assert.notEqual(refused.code, 0);
  assert.equal(refused.envelope.error.code, "STATE_CONFLICT");
  assert.match(refused.envelope.error.message, /target changed or could not be refreshed/);
  assert.equal(x.git(x.source, "rev-parse", "refs/remotes/origin/main"), advanced.slice(5));
  assert.equal(existsSync(join(x.source, ".grounds", "development", x.planId, "worktree")), false);
  assert.equal((await x.ok(["devrun", "list", "--issue", x.f.issue.issue_id])).resources.length, 0);
});

test("an unfinished coordinator check cannot cache away the next target refresh", async t => {
  const x = await fixture(t);
  const service = new PreflightService(x.f.store, x.source);
  const observation = await service.observe({ operation_id: newUUIDv7(), attribution: testAgent, phase: "start", refresh: true, issue_id: x.f.issue.issue_id });
  await service.assess({ operation_id: newUUIDv7(), attribution: testAgent, observation_id: observation.id,
    file: { assessment: "applicable", rationale: "The fixed contract matches this target", affected: [] } });
  const coordinator = service.coordinator({ refresh: true });
  const input = { issue_revision_id: x.issueRevisionId, repository_id: x.f.repository.repository_id, expected_commit: x.base, what: "start", operation_id: newUUIDv7() };
  await coordinator.start(input);
  const advanced = advanceRemote(x, "after-check");
  await assert.rejects(coordinator.start(input), { code: "STATE_CONFLICT" });
  assert.equal(x.git(x.source, "rev-parse", "refs/remotes/origin/main"), advanced.slice(5));
});

test("publishAuthoring refuses a reused reviewed version whose declarations changed", async (t) => {
  const x = await fixture(t);
  const service = new PreflightService(x.f.store, x.source);
  const reviewedVersion = "a".repeat(64);
  // Each case declares a distinct Issue, so a refusal can never be the separate
  // one-Issue-per-Repository rule instead of the freshness gate.
  const declaration = (summary: string, baselineOid = x.base) => ({
    baseline: { git_oid: baselineOid, reachability: "remote_tracking_reachable" as const },
    target_branch: target,
    input: { format: 1 as const, summary, target_branch: target, goals: [{ statement: "G", criteria: ["C"] }] },
  });
  const reviewedIssue = declaration("Reviewed Issue");
  const reviewed = publishAuthoringBinding({
    canonical_remote: x.f.repository.canonical_remote,
    requirement: { expected_revision_id: x.f.requirement.requirement_revision_id, input: { format: 1, summary: "Reviewed Requirement", outcomes: ["Reviewed outcome"] } },
    issues: [reviewedIssue],
  });
  const observation = await service.observe({
    operation_id: newUUIDv7(),
    attribution: testAgent,
    phase: "publish",
    refresh: true,
    repository_id: x.f.repository.repository_id,
    target,
    scope_digest: reviewedVersion,
    content_digest: contentDigestFor(reviewed),
  });
  assert.equal((observation.data.observation as { refreshed: boolean }).refreshed, true);
  await service.assess({ operation_id: newUUIDv7(), attribution: testAgent, observation_id: observation.id, file: { assessment: "applicable", author: testAgent, rationale: "Reviewed these exact declarations against the refreshed target", affected: [] } });

  const substitutions = [
    { name: "Issue body", issue: declaration("Substituted Issue content") },
    { name: "baseline", issue: declaration("Reviewed Issue", `sha1:${"f".repeat(40)}`) },
  ];
  for (const substitution of substitutions) {
    const before = await x.f.module.currentRequirementRevision(x.f.requirement.requirement_id);
    await assert.rejects(
      x.f.module.publishAuthoring({
        operation_id: newUUIDv7(),
        canonical_remote: x.f.repository.canonical_remote,
        reviewed_version: reviewedVersion,
        requirement: { requirement_id: x.f.requirement.requirement_id, expected_revision_id: x.f.requirement.requirement_revision_id, input: { format: 1, summary: `${substitution.name} substitution`, outcomes: ["A substituted outcome"] } },
        issues: [substitution.issue],
        attribution: testAgent,
      }),
      (error: any) => error.code === "STATE_CONFLICT" && !/one Requirement may have only one Issue/.test(error.message),
      substitution.name,
    );
    const after = await x.f.module.currentRequirementRevision(x.f.requirement.requirement_id);
    assert.equal(after.revision_number, before.revision_number, `${substitution.name}: a refused publication must not write a Requirement revision`);
  }
});

// --- Gap 3: the admission must bind the preparation scene it was assessed
// against, and a declared --expected-head must be honoured.
test("devrun admit refuses a malformed --expected-head", async (t) => {
  const x = await fixture(t);
  const prepared = await x.ok(["devrun", "prepare", "--development-mode", "simple", "--issue", x.f.issue.issue_id, "--plan", x.planId]);
  const runId = prepared.context.dev_run.id as string;
  const observed = await x.ok(["preflight", "observe", "--phase", "start", "--issue", x.f.issue.issue_id, "--refresh"]);
  const assessmentId = await assessApplicable(x, observed.observation_id, "The prepared scene still matches the refreshed target");

  const malformed = await x.invoke(["devrun", "admit", "--dev-run", runId, "--preflight", assessmentId, "--expected-head", "not-a-commit", "--refresh"]);
  assert.notEqual(malformed.code, 0, `admit accepted a malformed --expected-head: ${JSON.stringify(malformed.envelope)}`);
  assert.ok(["VALIDATION_ERROR", "STATE_CONFLICT"].includes(malformed.envelope.error.code), JSON.stringify(malformed.envelope.error));
  assert.equal(resolveBaseline(prepared.local_worktree.path as string, "HEAD"), x.base, "a refused admission must not change the scene");
});

test("devrun admit refuses an --expected-head the preparation scene does not hold", async (t) => {
  const x = await fixture(t);
  const prepared = await x.ok(["devrun", "prepare", "--development-mode", "simple", "--issue", x.f.issue.issue_id, "--plan", x.planId]);
  const runId = prepared.context.dev_run.id as string;
  const worktree = prepared.local_worktree.path as string;
  const observed = await x.ok(["preflight", "observe", "--phase", "start", "--issue", x.f.issue.issue_id, "--refresh"]);
  const assessmentId = await assessApplicable(x, observed.observation_id, "The prepared scene still matches the refreshed target");

  const foreign = unreachableCommit(x);
  assert.notEqual(foreign, x.base);
  const refused = await x.invoke(["devrun", "admit", "--dev-run", runId, "--preflight", assessmentId, "--expected-head", foreign, "--refresh"]);
  assert.notEqual(refused.code, 0, `admit accepted a foreign --expected-head: ${JSON.stringify(refused.envelope)}`);
  assert.equal(refused.envelope.error.code, "STATE_CONFLICT");
  assert.equal(resolveBaseline(worktree, "HEAD"), x.base, "a refused admission must not change the scene");
});

test("devrun admit refuses a preparation scene that moved after the assessment", async (t) => {
  const x = await fixture(t);
  const prepared = await x.ok(["devrun", "prepare", "--development-mode", "simple", "--issue", x.f.issue.issue_id, "--plan", x.planId]);
  const runId = prepared.context.dev_run.id as string;
  const worktree = prepared.local_worktree.path as string;
  const observed = await x.ok(["preflight", "observe", "--phase", "start", "--issue", x.f.issue.issue_id, "--refresh"]);
  const assessmentId = await assessApplicable(x, observed.observation_id, "The prepared scene still matches the refreshed target");

  // The scene itself moves after the assessment: same target, same Issue, same
  // base commit, but no longer the input that was assessed.
  x.git(worktree, "commit", "--allow-empty", "-qm", "scene moved after the assessment");
  const movedHead = resolveBaseline(worktree, "HEAD");
  assert.notEqual(movedHead, x.base);
  const refused = await x.invoke(["devrun", "admit", "--dev-run", runId, "--preflight", assessmentId, "--refresh"]);
  assert.notEqual(refused.code, 0, `admit used an assessment of a scene that no longer exists: ${JSON.stringify(refused.envelope)}`);
  assert.equal(refused.envelope.error.code, "STATE_CONFLICT");
  assert.equal(resolveBaseline(worktree, "HEAD"), movedHead, "a refused admission must not change the scene");
});

// --- Gap 4: the newest valid admission governs; a fresh preparation supersedes it.
test("the read model uses the newest admission and a new preparation invalidates the old one", async (t) => {
  const x = await fixture(t);
  const prepared = await x.ok(["devrun", "prepare", "--development-mode", "simple", "--issue", x.f.issue.issue_id, "--plan", x.planId]);
  const runId = prepared.context.dev_run.id as string;
  assert.equal(prepared.context.preflight.state, "preparing");

  // Admission binds the run's actual inputs, so each round observes --dev-run.
  const admitRound = async (rationale: string) => {
    const observation = await x.ok(["preflight", "observe", "--phase", "start", "--dev-run", runId, "--refresh"]);
    const assessment = await assessApplicable(x, observation.observation_id, rationale);
    await x.ok(["devrun", "admit", "--dev-run", runId, "--preflight", assessment, "--refresh"]);
    return assessment;
  };
  const first = await admitRound("First review of the run's actual inputs");
  const admitted = await x.ok(["devrun", "show", "--dev-run", runId]);
  assert.equal(admitted.preflight.state, "admitted");
  assert.equal(admitted.preflight.assessment.assessment_id, first);

  // A second round of the same target: the DevRun is admitted again, and the
  // newest admission must be the one that governs.
  const second = await admitRound("Second review of the run's actual inputs");
  assert.notEqual(second, first);
  const readmitted = await x.ok(["devrun", "show", "--dev-run", runId]);
  assert.equal(readmitted.preflight.state, "admitted", `the newest admission was not used: ${JSON.stringify(readmitted.preflight)}`);
  assert.equal(readmitted.preflight.assessment.assessment_id, second);

  // A new preparation supersedes the admission until a matching admit exists.
  await x.ok(["devrun", "prepare", "--dev-run", runId]);
  const preparedAgain = await x.ok(["devrun", "show", "--dev-run", runId]);
  assert.notEqual(preparedAgain.preflight.state, "admitted", `a new preparation left the old admission in force: ${JSON.stringify(preparedAgain.preflight)}`);
  assert.equal(preparedAgain.preflight.state, "preparing");

  const template = await x.invoke(["candidate", "template", "--dev-run", runId]);
  assert.notEqual(template.code, 0, `a superseded admission still allowed a Candidate: ${JSON.stringify(template.envelope)}`);
  assert.match(JSON.stringify(template.envelope.error), /admission|preparing/);
});
