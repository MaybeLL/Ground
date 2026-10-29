import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LedgerFixture, testAgent } from "./fixture.js";
import { reviseTargetIssue, seedPublishPreflight } from "./preflight-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { SQLStore } from "../src/sql-store.js";
import { PreflightService, contentDigestFor } from "../src/preflight.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { Module } from "../src/module.js";import { assertContract } from "./schema-fixture.js";
import { runCLI } from "../src/cli.js";

const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });

interface Fixture {
  root: string;
  source: string;
  remote: string;
  f: LedgerFixture;
  service: PreflightService;
  base: string;
  git: (cwd: string, ...args: string[]) => string;
  issue_revision_id: string;
  config: string;
  dev_run_id: string;
  worktree: string;
  run: (args: string[]) => Promise<{ code: number; envelope: any }>;
  ok: (args: string[]) => Promise<any>;
}

async function fixture(t: { after: (f: () => Promise<void>) => void }): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-preflight-")));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init", "--bare", "-q", remote);
  git(source, "init", "-qb", "main");
  git(source, "config", "user.name", "Test");
  git(source, "config", "user.email", "test@invalid");
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
  const f = await LedgerFixture.createWithStore(store, () => store.close(), { preflightCoordinator: new PreflightService(store, source).coordinator({ refresh: true }) });
  t.after(async () => {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  });
  const revised = await reviseTargetIssue(f.module, f.store, source, {
    ...actor(),
    issue_id: f.issue.issue_id,
    expected_predecessor_id: f.issue.issue_revision_id,
    requirement_revision_id: f.requirement.requirement_revision_id,
    requirement_revision_explicit: true,
    baseline: { git_oid: base, reachability: "remote_tracking_reachable" },
    input: {
      format: 1,
      summary: "Preflight target flow",
      target_branch: { remote: "origin", ref: "refs/heads/main" },
      goals: [{ statement: "Check target freshness", criteria: ["The target is observed before start"] }],
    },
  });
  const service = new PreflightService(f.store, source);
  const revisionId = revised.result.issue_revision_id;
  const database = (await f.store.inspect()).database_id;
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: databasePath, expected_database_id: database } }));
  const run = async (args: string[]) => {
    const out: string[] = [];
    const code = await withRuntimeDirectories(
      { runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") },
      () => runCLI([...args, "--config", config, "--json"], { cwd: source, stdout: (line) => out.push(line), stderr: () => undefined }),
    );
    return { code, envelope: JSON.parse(out.join("\n")) };
  };
  const ok = async (args: string[]): Promise<any> => {
    const invocation = await run(args);
    assert.equal(invocation.code, 0, JSON.stringify(invocation.envelope));
    return invocation.envelope.data;
  };
  // A real preparation round: the managed worktree `observe --dev-run` and
  // `devrun admit` both capture and compare.
  const plan = await ok(["devrun", "plan", "--issue-slug", "fixture", "--repository", f.repository.repository_id, "--definition-commit", base, "--target-remote", "origin", "--target-branch", "refs/heads/main"]);
  const prepared = await ok(["devrun", "prepare", "--development-mode", "simple", "--issue", f.issue.issue_id, "--plan", plan.plan.workspace_id]);
  return {
    root, source, remote, f, service, base, git,
    issue_revision_id: revisionId,
    dev_run_id: prepared.context.dev_run.id,
    worktree: prepared.local_worktree.path,
    config, run, ok,
  };
}

/** Run a service call that touches the managed worktree under isolated runtime directories. */
const withIsolation = <T>(x: Fixture, action: () => Promise<T>): Promise<T> =>
  withRuntimeDirectories({ runtimeHome: join(x.root, "runtime"), directoryRegistryHome: join(x.root, "registry") }, action);

const startObservation = (x: Fixture) => x.service.observe({
  ...actor(),
  phase: "start",
  refresh: true,
  repository_id: x.f.repository.repository_id,
  issue_id: x.f.issue.issue_id,
  issue_revision_id: x.issue_revision_id,
  attribution: testAgent,
});

test("observe records the real refreshed target commit, persists it and reads it back", async (t) => {
  const x = await fixture(t);
  const observed = await startObservation(x);
  assert.equal(observed.data.observation.refreshed, true);
  assert.equal((observed.data.observation.commit as { oid: string }).oid, x.base);
  assert.deepEqual(observed.data.target, { remote: "origin", ref: "refs/heads/main" });
  assert.equal(observed.data.binds.issue_id, x.f.issue.issue_id);

  const shown = await x.service.show(observed.id);
  assert.equal(shown.data.format, "grounds.preflight-observation/v1");
  assert.equal(shown.id, observed.id);
  assert.equal(shown.version, 1);
});

test("a failed refresh is recorded as a failure, never silently as the local ref", async (t) => {
  const x = await fixture(t);
  // Keep the declared ssh remote identity but make the transport fail fast, so
  // only the refresh fails while the local tracking ref is still present.
  x.git(x.source, "config", "--unset-all", `url.file://${x.remote}.insteadOf`);
  x.git(x.source, "config", "core.sshCommand", "/usr/bin/false");
  const observed = await startObservation(x);
  assert.equal(observed.data.observation.refreshed, false);
  assert.equal(observed.data.observation.commit, undefined);
  assert.equal(observed.data.observation.failure, "refresh_failed");
});

test("assess rejects an empty rationale and accepts an author-attributed applicable judgement", async (t) => {
  const x = await fixture(t);
  const observed = await startObservation(x);
  await assert.rejects(
    x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "applicable", author: testAgent, rationale: "   ", affected: [] } }),
    (error: any) => error.code === "VALIDATION_ERROR" && error.details.field === "rationale",
  );
  await assert.rejects(
    x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "passed" as any, author: testAgent, rationale: "ok", affected: [] } }),
    (error: any) => error.code === "VALIDATION_ERROR" && error.details.field === "assessment",
  );
  const assessment = await x.service.assess({
    ...actor(),
    observation_id: observed.id,
    file: { assessment: "applicable", author: { kind: "agent", agent_id: "test-agent", display_name: "Test Agent" }, rationale: "Reviewed goals and constraints; unchanged behaviour", affected: [] },
  });
  assert.equal(assessment.data.assessment, "applicable");
  assert.deepEqual(assessment.data.author, testAgent);
  assert.equal((assessment.data as { target_commit: string }).target_commit, x.base);
  // A second, differing author would be two conflicting records of who judged.
  await assert.rejects(
    x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "applicable", author: { kind: "agent", agent_id: "someone-else", display_name: "Someone Else" }, rationale: "x", affected: [] } }),
    (error: any) => error.code === "VALIDATION_ERROR" && error.details.field === "author",
  );
});

test("devrun preflight reports the real admission transitions for a target round", async (t) => {
  const x = await fixture(t);
  // The fixture's preparation round has only built its scene: it is not admitted.
  const preparing = await x.service.devRunReadModel(x.dev_run_id);
  assert.equal(preparing?.state, "preparing");
  assert.equal(preparing?.code, "no_observation");
  assert.ok(preparing!.next_commands.some((command) => command.includes("preflight observe")));

  // Once the run's actual inputs are observed and assessed and it is admitted,
  // the read model reports that admission.
  const observation = await withIsolation(x, () => x.service.observe({
    ...actor(), phase: "start", refresh: true, repository_id: x.f.repository.repository_id,
    issue_id: x.f.issue.issue_id, issue_revision_id: x.issue_revision_id, dev_run_id: x.dev_run_id,
  }));
  const assessed = await x.service.assess({ ...actor(), observation_id: observation.id, file: { assessment: "applicable", author: testAgent, rationale: "The run's actual inputs match the refreshed target", affected: [] } });
  await withIsolation(x, () => x.service.admit({ ...actor(), dev_run_id: x.dev_run_id, assessment_id: assessed.id, refresh: true }));
  const admitted = await x.service.devRunReadModel(x.dev_run_id);
  assert.equal(admitted?.state, "admitted");
  assert.equal(admitted?.admission?.target_commit, x.base);
});

test("target-flow DevRun without a declared target branch keeps the historical read model", async (t) => {
  const x = await fixture(t);
  const plain = await x.f.module.startDevRun({
    ...actor(),
    issue_id: x.f.issue.issue_id,
    issue_revision_id: x.f.issue.issue_revision_id,
    issue_revision_explicit: true,
    repository_remote_snapshot: x.f.repository.canonical_remote,
  });
  const model = await x.service.devRunReadModel(plain.result.context.dev_run.id);
  assert.equal(model, undefined);
});

test("admission binds the exact observed commit and the read model reports admitted", async (t) => {
  const x = await fixture(t);
  // `observe --dev-run` captures the run's actual inputs; admission compares them.
  const runObservation = await withIsolation(x, () => x.service.observe({
    ...actor(), phase: "start", refresh: true, repository_id: x.f.repository.repository_id,
    issue_id: x.f.issue.issue_id, issue_revision_id: x.issue_revision_id, dev_run_id: x.dev_run_id,
  }));
  const runAssessment = await x.service.assess({ ...actor(), observation_id: runObservation.id, file: { assessment: "applicable", author: testAgent, rationale: "The run's actual development inputs still match the refreshed target", affected: [] } });
  const pre = await x.service.devRunReadModel(x.dev_run_id);
  assert.equal(pre?.code, "not_admitted");
  const { record } = await withIsolation(x, () => x.service.admit({ ...actor(), dev_run_id: x.dev_run_id, assessment_id: runAssessment.id, refresh: true }));
  assert.equal(record.version, 1);
  const model = await x.service.devRunReadModel(x.dev_run_id);
  assert.equal(model?.state, "admitted");
  assert.equal(model?.admission?.target_commit, x.base);
  assert.equal(model?.assessment?.assessment_id, runAssessment.id);
});

test("admission refuses a target that moved after the assessment", async (t) => {
  const x = await fixture(t);
  const observed = await startObservation(x);
  const assessment = await x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "applicable", author: testAgent, rationale: "Approved this commit", affected: [] } });
  // The target advances beyond the assessment's commit; admission must refuse.
  writeFileSync(join(x.source, "advance"), "later\n");
  x.git(x.source, "add", ".");
  x.git(x.source, "commit", "-qm", "advance");
  x.git(x.source, "push", "-q", x.remote, "HEAD:refs/heads/main");
  await assert.rejects(
    x.service.admit({ ...actor(), dev_run_id: (x as any).dev_run_id, assessment_id: assessment.id, refresh: true }),
    (error: any) => error.code === "STATE_CONFLICT",
  );
});

test("publish gate binds the reviewed scope digest and refuses a bare/unrelated observation", async (t) => {
  const x = await fixture(t);
  const scope = "a".repeat(64);
  const target = { remote: "origin", ref: "refs/heads/main" };
  const digest = contentDigestFor({ canonical_remote: x.f.repository.canonical_remote, issues: [] });
  // No observation bound to this scope yet: the exact match must be refused.
  await assert.rejects(
    x.service.requirePublish({ repository_id: x.f.repository.repository_id, reviewed_version: scope, content_digest: digest, target, what: "publish" }),
    (error: any) => error.code === "STATE_CONFLICT",
  );
  const observed = await x.service.observe({
    ...actor(), phase: "publish", refresh: true,
    repository_id: x.f.repository.repository_id,
    scope_digest: scope, content_digest: digest, target,
  });
  await assert.rejects(
    x.service.requirePublish({ repository_id: x.f.repository.repository_id, reviewed_version: "b".repeat(64), content_digest: digest, target, what: "publish" }),
    (error: any) => error.code === "STATE_CONFLICT",
  );
  const assessment = await x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "applicable", author: testAgent, rationale: "Scope unchanged against the refreshed target", affected: [] } });
  const gate = await x.service.requirePublish({ repository_id: x.f.repository.repository_id, reviewed_version: scope, content_digest: digest, target, what: "publish" });
  assert.equal(gate.assessment_id, assessment.id);
  assert.equal(gate.target_commit, x.base);
});

/** The fixture already exposes the real CLI `run`/`ok` against this ledger. */
const cliFixture = fixture;

test("CLI observe -> assess -> devrun show reports admitted, and an unrefreshed start is refused", async (t) => {
  const x = await cliFixture(t);
  const observed = await x.run(["preflight", "observe", "--phase", "start", "--dev-run", x.dev_run_id, "--refresh"]);
  assert.equal(observed.code, 0, JSON.stringify(observed.envelope));
  assertContract("cli-envelope.schema.json", observed.envelope);
  const observationId = observed.envelope.data.observation_id;
  assert.match(observationId, /^[0-9a-f-]{36}$/);

  const file = join(x.root, "assessment.json");
  writeFileSync(file, JSON.stringify({ assessment: "applicable", rationale: "Reviewed the sealed contract against the refreshed target; unchanged", affected: [] }));
  const assessed = await x.run(["preflight", "assess", "--observation", observationId, "--file", file]);
  assert.equal(assessed.code, 0, JSON.stringify(assessed.envelope));
  assertContract("cli-envelope.schema.json", assessed.envelope);
  const assessmentId = assessed.envelope.data.assessment_id;

  const admitted = await x.run(["devrun", "admit", "--dev-run", x.dev_run_id, "--preflight", assessmentId, "--refresh"]);
  assert.equal(admitted.code, 0, JSON.stringify(admitted.envelope));
  assertContract("cli-envelope.schema.json", admitted.envelope);

  const shown = await x.run(["devrun", "show", "--dev-run", x.dev_run_id]);
  assert.equal(shown.code, 0, JSON.stringify(shown.envelope));
  assertContract("cli-envelope.schema.json", shown.envelope);
  assert.equal(shown.envelope.data.preflight.state, "admitted");
  assert.equal(shown.envelope.data.preflight.admission.target_commit, x.base);

  const shownObservation = await x.run(["preflight", "show", observationId]);
  assert.equal(shownObservation.code, 0, JSON.stringify(shownObservation.envelope));
  assertContract("cli-envelope.schema.json", shownObservation.envelope);
  assert.equal(shownObservation.envelope.data.preflight.id, observationId);
});

test("prepare --issue builds the scene without admission and blocks Candidate submit", async (t) => {
  const x = await cliFixture(t);
  // The fixture's own preparation round is exactly this scenario.
  const runID = x.dev_run_id;
  const shown = await x.run(["devrun", "show", "--dev-run", runID]);
  assert.equal(shown.envelope.data.preflight.state, "preparing");

  // A preparing round cannot produce a Candidate at all: the submission
  // template is refused on the missing admission, so the block is the gate and
  // not a submission-shape error.
  const template = await x.run(["candidate", "template", "--dev-run", runID]);
  assert.notEqual(template.code, 0, JSON.stringify(template.envelope));
  assert.match(JSON.stringify(template.envelope.error), /admission|preparing/);

  const submission = join(x.root, "submission.json");
  writeFileSync(submission, JSON.stringify({ format: "patchledger.candidate-submission/v1", explanation: "x", claims: [] }));
  const rejected = await x.run(["candidate", "submit", "--dev-run", runID, "--expected-version", "1", "--file", submission]);
  assert.notEqual(rejected.code, 0, JSON.stringify(rejected.envelope));
});

test("an assessment that no longer matches the observed input is refused on admit and keeps the scene", async (t) => {
  const x = await cliFixture(t);
  const observed = await x.run(["preflight", "observe", "--phase", "start", "--dev-run", x.dev_run_id, "--refresh"]);
  assert.equal(observed.code, 0, JSON.stringify(observed.envelope));
  const file = join(x.root, "assessment.json");
  writeFileSync(file, JSON.stringify({ assessment: "applicable", rationale: "Reviewed the refreshed target", affected: [] }));
  const assessed = await x.run(["preflight", "assess", "--observation", observed.envelope.data.observation_id, "--file", file]);
  assert.equal(assessed.code, 0, JSON.stringify(assessed.envelope));
  const assessmentId = assessed.envelope.data.assessment_id;

  // The target advances after the assessment was recorded.
  writeFileSync(join(x.source, "advance"), "later\n");
  x.git(x.source, "add", ".");
  x.git(x.source, "commit", "-qm", "advance");
  x.git(x.source, "push", "-q", x.remote, "HEAD:refs/heads/main");

  const before = x.git(x.source, "status", "--porcelain");
  const refused = await x.run(["devrun", "admit", "--dev-run", x.dev_run_id, "--preflight", assessmentId, "--refresh"]);
  assert.equal(refused.code, 4, JSON.stringify(refused.envelope));
  assert.equal(refused.envelope.error.code, "STATE_CONFLICT");
  // The refusal must leave the working scene untouched.
  assert.equal(x.git(x.source, "status", "--porcelain"), before);
});

test("CLI workspace publish of a new target Issue is gated on the reviewed-scope preflight", async (t) => {
  const x = await fixture(t);
  const run = x.run;
  const created = await run(["workspace", "new", "pub"]);
  assert.equal(created.code, 0, JSON.stringify(created.envelope));
  const path = created.envelope.data.path;
  const manifest = JSON.parse(readFileSync(join(path, ".workspace.json"), "utf8"));
  manifest.draft.issues[0].input.target_branch = { remote: "origin", ref: "refs/heads/main" };
  manifest.draft.issues[0].baselineExpression = x.base;
  writeFileSync(join(path, ".workspace.json"), JSON.stringify(manifest));

  const read = await run(["workspace", "read", "pub"]);
  assert.equal(read.code, 0, JSON.stringify(read.envelope));
  const version = read.envelope.data.version;

  // A dry-run never claims publishable and leaves no pending publication.
  const dryRun = await run(["workspace", "publish", "pub", "--dry-run", "--expected-version", version]);
  assert.equal(dryRun.code, 0, JSON.stringify(dryRun.envelope));
  assert.ok((dryRun.envelope.warnings ?? []).some((warning: { code: string }) => warning.code === "PREFLIGHT_REQUIRED"));

  const blocked = await run(["workspace", "publish", "pub", "--expected-version", version, "--refresh"]);
  assert.equal(blocked.code, 4, JSON.stringify(blocked.envelope));
  assert.equal(blocked.envelope.error.code, "STATE_CONFLICT");
  assert.match(blocked.envelope.error.message, /preflight observe/);
});

test("a plain Module without any wiring still fails closed on a target publication", async (t) => {
  const x = await fixture(t);
  // No gate callback exists; a target write must fail closed on its own, even
  // though a previously valid observation and assessment are already recorded.
  const service = new PreflightService(x.f.store, x.source);
  const observed = await service.observe({
    ...actor(), phase: "publish", refresh: true, repository_id: x.f.repository.repository_id,
    content_digest: contentDigestFor({ canonical_remote: x.f.repository.canonical_remote, issues: [] }), target: { remote: "origin", ref: "refs/heads/main" },
  });
  await service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "applicable", author: testAgent, rationale: "Recorded before the Module was rewired", affected: [] } });
  const bare = new Module(x.f.store, newUUIDv7);
  await assert.rejects(
    bare.publishAuthoring({
      operation_id: newUUIDv7(),
      canonical_remote: x.f.repository.canonical_remote,
      requirement: { input: { format: 1, summary: "Gated requirement", outcomes: ["x"] } },
      issues: [{ baseline: { git_oid: x.base, reachability: "remote_tracking_reachable" }, input: { format: 1, summary: "Gated issue", target_branch: { remote: "origin", ref: "refs/heads/main" }, goals: [{ statement: "G", criteria: ["C"] }] } }],
      attribution: testAgent,
    }),
    (error: any) => error.code === "STATE_CONFLICT",
  );
  await assert.rejects(
    bare.createIssue({
      operation_id: newUUIDv7(),
      requirement_id: x.f.requirement.requirement_id,
      requirement_revision_id: x.f.requirement.requirement_revision_id,
      requirement_revision_explicit: true,
      repository_id: x.f.repository.repository_id,
      baseline: { git_oid: x.base, reachability: "remote_tracking_reachable" },
      input: { format: 1, summary: "New target issue", target_branch: { remote: "origin", ref: "refs/heads/main" }, goals: [{ statement: "G", criteria: ["C"] }] },
      attribution: testAgent,
    }),
    (error: any) => error.code === "STATE_CONFLICT",
  );
});

test("Module reviseIssue that removes a target cannot silently downgrade the gate", async (t) => {
  const x = await fixture(t);
  const bare = new Module(x.f.store, newUUIDv7);
  await assert.rejects(
    bare.reviseIssue({
      operation_id: newUUIDv7(),
      issue_id: x.f.issue.issue_id,
      expected_predecessor_id: x.issue_revision_id,
      requirement_revision_id: x.f.requirement.requirement_revision_id,
      requirement_revision_explicit: true,
      baseline: { git_oid: x.base, reachability: "remote_tracking_reachable" },
      input: { format: 1, summary: "Target removed", goals: [{ statement: "G", criteria: ["C"] }] },
      attribution: testAgent,
    }),
    (error: any) => error.code === "STATE_CONFLICT",
  );
});

test("the publish binding rejects a changed Requirement, baseline or predecessor even when Issue text is identical", async (t) => {
  const x = await fixture(t);
  const store = x.f.store;
  const target = { remote: "origin", ref: "refs/heads/main" };
  const issueInput = { format: 1 as const, summary: "Stable Issue text", target_branch: target, goals: [{ statement: "G", criteria: ["C"] }] };
  const base = { canonical_remote: x.f.repository.canonical_remote, requirement: { requirement_revision_id: x.f.requirement.requirement_revision_id, predecessor_revision_id: x.f.requirement.requirement_revision_id, content: { summary: "R" } }, issues: [{ baseline_oid: x.base, target_branch: target, input: issueInput }] };
  await seedPublishPreflight(store, { repositoryId: x.f.repository.repository_id, canonicalRemote: x.f.repository.canonical_remote, contentDigest: contentDigestFor(base), target, commit: x.base });
  const service = x.service;
  // Exactly the same binding is admitted.
  await service.requirePublish({ repository_id: x.f.repository.repository_id, content_digest: contentDigestFor(base), target, what: "publish" });
  // Changing only the Requirement content, only the baseline, or only the
  // predecessor must all be refused; the Issue text is identical in each.
  const requirementChanged = { ...base, requirement: { ...base.requirement, content: { summary: "R2" } } };
  const baselineChanged = { ...base, issues: [{ ...base.issues[0]!, baseline_oid: `sha1:${"f".repeat(40)}` }] };
  const predecessorChanged = { ...base, issues: [{ ...base.issues[0]!, predecessor_revision_id: x.f.issue.issue_revision_id }] };
  for (const binding of [requirementChanged, baselineChanged, predecessorChanged]) {
    await assert.rejects(
      service.requirePublish({ repository_id: x.f.repository.repository_id, content_digest: contentDigestFor(binding), target, what: "publish" }),
      (error: any) => error.code === "STATE_CONFLICT",
      JSON.stringify(binding).slice(0, 80),
    );
  }
});

test("a JSON reviewed version must match exactly; a matching content digest cannot stand in", async (t) => {
  const x = await fixture(t);
  const store = x.f.store;
  const target = { remote: "origin", ref: "refs/heads/main" };
  const issueInput = { format: 1 as const, summary: "Same Issue body", target_branch: target, goals: [{ statement: "G", criteria: ["C"] }] };
  const binding = { canonical_remote: x.f.repository.canonical_remote, issues: [{ baseline_oid: x.base, target_branch: target, input: issueInput }] };
  const reviewedVersion = "a".repeat(64);
  const contentDigest = contentDigestFor(binding);
  const observationId = newUUIDv7();
  await store.write(async (tx) => {
    await tx.saveRuntimeRecord({ id: observationId, kind: "runtime_operation", parent_id: x.f.repository.repository_id, version: 1, data: {
      format: "grounds.preflight-observation/v1", phase: "publish", observed_at: new Date().toISOString(), target, tracking_ref: "",
      observation: { refreshed: true, observed_at: new Date().toISOString(), commit: { oid: x.base, parents: [], tree_oid: x.base } },
      binds: { repository_id: x.f.repository.repository_id, canonical_remote: x.f.repository.canonical_remote, scope_digest: reviewedVersion, content_digest: contentDigest }, attribution: testAgent,
    } }, 0);
    await tx.saveRuntimeRecord({ id: newUUIDv7(), kind: "runtime_operation", parent_id: observationId, version: 1, data: {
      format: "grounds.preflight-assessment/v1", observation_id: observationId, assessment: "applicable", author: testAgent, rationale: "Fixture", affected: [], assessed_at: new Date().toISOString(),
      binds: { repository_id: x.f.repository.repository_id, canonical_remote: x.f.repository.canonical_remote, scope_digest: reviewedVersion, content_digest: contentDigest }, target_commit: x.base,
    } }, 0);
  });
  // Exact reviewed version matches, with the exact content binding.
  await x.service.requirePublish({ repository_id: x.f.repository.repository_id, reviewed_version: reviewedVersion, content_digest: contentDigest, target, what: "publish" });
  // A different reviewed version is refused even though the content digest is
  // recorded and identical.
  await assert.rejects(
    x.service.requirePublish({ repository_id: x.f.repository.repository_id, reviewed_version: "b".repeat(64), content_digest: contentDigest, target, what: "publish" }),
    (error: any) => error.code === "STATE_CONFLICT",
  );
});




