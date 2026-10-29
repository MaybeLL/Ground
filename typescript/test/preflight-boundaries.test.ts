import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCLI, parseArgs, commandNeedsOperationID } from "../src/cli.js";
import { newUUIDv7 } from "../src/identity.js";
import { PreflightService } from "../src/preflight.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { SQLStore } from "../src/sql-store.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { reviseTargetIssue } from "./preflight-fixture.js";

/**
 * Reachable boundary coverage for the target-flow preflight gate. Every case
 * drives the real `PreflightService` (or the real CLI) against a real SQLite
 * ledger, a real local bare remote and a real managed preparation worktree.
 * Nothing here mocks Git, the ledger or the refresh: a "refreshed" observation
 * only ever comes from a real `git fetch`, and the preparation scene is the one
 * `devrun prepare --issue --plan` actually built.
 *
 * This file owns its fixture so it never has to change the shared
 * `preflight-fixture.ts` / `fixture.ts` helpers the main session maintains.
 */

const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
const target = { remote: "origin", ref: "refs/heads/main" };

interface Fixture {
  root: string;
  source: string;
  remote: string;
  f: LedgerFixture;
  service: PreflightService;
  base: string;
  git: (cwd: string, ...args: string[]) => string;
  issueRevisionId: string;
  devRunId: string;
  worktree: string;
  config: string;
  isolate: <T>(action: () => Promise<T>) => Promise<T>;
  invoke: (args: string[]) => Promise<{ code: number; envelope: any }>;
  ok: (args: string[]) => Promise<any>;
}

async function fixture(t: { after: (f: () => Promise<void>) => void }): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-preflight-boundaries-")));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init", "--bare", "-q", remote);
  git(source, "init", "-qb", "main");
  git(source, "config", "user.name", "Boundary");
  git(source, "config", "user.email", "boundary@invalid");
  // Must match the canonical remote `LedgerFixture` registers on the Repository.
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
  const f = await LedgerFixture.createWithStore(store, () => store.close(), {
    preflightCoordinator: new PreflightService(store, source).coordinator({ refresh: true }),
  });
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
      summary: "Preflight boundary target Issue",
      target_branch: target,
      goals: [{ statement: "Keep the target gate closed", criteria: ["A stale premise cannot start work"] }],
    },
  });
  const service = new PreflightService(f.store, source);
  const database = (await f.store.inspect()).database_id;
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: databasePath, expected_database_id: database } }));
  const isolate = <T>(action: () => Promise<T>): Promise<T> =>
    withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, action);
  const invoke = async (args: string[]): Promise<{ code: number; envelope: any }> => {
    const write = commandNeedsOperationID(parseArgs(args));
    const argv = [...args, ...(write && !args.includes("--operation-id") ? ["--operation-id", newUUIDv7()] : [])];
    const withIdentity = [...argv, ...(write ? ["--agent-id", "preflight-boundary", "--agent-name", "Preflight Boundary"] : [])];
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
  const prepared = await ok(["devrun", "prepare", "--development-mode", "simple", "--issue", f.issue.issue_id, "--plan", plan.plan.workspace_id]);
  return {
    root, source, remote, f, service, base, git,
    issueRevisionId: revised.result.issue_revision_id,
    devRunId: prepared.context.dev_run.id,
    worktree: prepared.local_worktree.path,
    config, isolate, invoke, ok,
  };
}

/** The real refreshed start observation of the fixture's Issue revision. */
const startObservation = (x: Fixture, phase: "start" | "definition" = "start") => x.service.observe({
  ...actor(),
  phase,
  refresh: true,
  repository_id: x.f.repository.repository_id,
  issue_id: x.f.issue.issue_id,
  issue_revision_id: x.issueRevisionId,
});

/** A second real clone that advances the remote target. Never runs in `source`. */
function advanceRemote(x: Fixture): string {
  const peer = join(x.root, "peer");
  const exists = (() => { try { x.git(peer, "rev-parse", "HEAD"); return true; } catch { return false; } })();
  if (!exists) x.git(x.root, "clone", "-q", "-b", "main", x.remote, peer);
  x.git(peer, "config", "user.name", "Peer");
  x.git(peer, "config", "user.email", "peer@invalid");
  writeFileSync(join(peer, "advanced.txt"), "advanced\n");
  x.git(peer, "add", ".");
  x.git(peer, "commit", "-qm", "advanced");
  x.git(peer, "push", "-q", "origin", "HEAD:refs/heads/main");
  return `sha1:${x.git(peer, "rev-parse", "HEAD")}`;
}

// --- Invalid inputs, authors, affected clauses and phases -------------------

test("observe rejects an unsupported phase, a non-boolean refresh and a malformed binding", async (t) => {
  const x = await fixture(t);
  const common = { repository_id: x.f.repository.repository_id };
  const reject = (error: any, field: string) => error.code === "VALIDATION_ERROR" && error.details.field === field;

  // A phase outside the three declared values, and a missing explicit refresh
  // boolean, are both refused before any observation is recorded.
  await assert.rejects((x.service as any).observe({ ...actor(), ...common, phase: "shipit", refresh: true }), (e: any) => reject(e, "phase"));
  await assert.rejects((x.service as any).observe({ ...actor(), ...common, phase: "definition" }), (e: any) => reject(e, "phase"));
  // Run-scoped inputs are only meaningful for a start observation.
  await assert.rejects(
    (x.service as any).observe({ ...actor(), ...common, phase: "definition", refresh: true, dev_run_id: x.devRunId, target }),
    (e: any) => reject(e, "dev-run"),
  );
  // The reviewed Workspace version and content digest have canonical shapes.
  await assert.rejects(
    (x.service as any).observe({ ...actor(), ...common, phase: "definition", refresh: true, target, scope_digest: "not-a-version" }),
    (e: any) => reject(e, "scope_digest"),
  );
  await assert.rejects(
    (x.service as any).observe({ ...actor(), ...common, phase: "definition", refresh: true, target, content_digest: "a".repeat(64) }),
    (e: any) => reject(e, "content_digest"),
  );
  await assert.rejects(
    (x.service as any).observe({ ...actor(), ...common, phase: "definition", refresh: true, target, definition_commit: "HEAD" }),
    (e: any) => reject(e, "definition_commit"),
  );
  // A bad operation identity is refused before anything else runs.
  await assert.rejects(
    (x.service as any).observe({ operation_id: "nope", attribution: testAgent, ...common, phase: "definition", refresh: true, target }),
    (e: any) => reject(e, "operation_id"),
  );
});

test("assess rejects an unsupported file shape, assessment, author and affected clause", async (t) => {
  const x = await fixture(t);
  const observed = await startObservation(x);
  const reject = (field: string) => (e: any) => e.code === "VALIDATION_ERROR" && e.details.field === field;
  const file = (over: Record<string, unknown>) => ({ ...actor(), observation_id: observed.id, file: over });

  // Unknown fields, a non-object and an array are all refused as file shapes.
  await assert.rejects((x.service as any).assess(file({ assessment: "applicable", rationale: "ok", note: "extra" })), reject("file"));
  await assert.rejects((x.service as any).assess(file("not-an-object")), reject("file"));
  await assert.rejects((x.service as any).assess(file([])), reject("file"));
  await assert.rejects((x.service as any).assess(file({ assessment: "passed", rationale: "ok" })), reject("assessment"));
  // The declared author must be a well-formed attribution, not just a match.
  await assert.rejects(
    (x.service as any).assess(file({ assessment: "applicable", rationale: "ok", author: { kind: "agent", agent_id: "a", display_name: "a", extra: 1 } })),
    reject("attribution"),
  );
  await assert.rejects(
    (x.service as any).assess(file({ assessment: "applicable", rationale: "ok", author: { kind: "robot", agent_id: "a", display_name: "a" } })),
    reject("attribution.kind"),
  );
  // affected must be a bounded array of well-formed clause references.
  await assert.rejects((x.service as any).assess(file({ assessment: "applicable", rationale: "ok", affected: "goal" })), reject("affected"));
  await assert.rejects(
    (x.service as any).assess(file({ assessment: "applicable", rationale: "ok", affected: Array.from({ length: 2001 }, () => ({})) })),
    reject("affected"),
  );
  await assert.rejects(
    (x.service as any).assess(file({ assessment: "applicable", rationale: "ok", affected: [{ target_type: "goal", target_id: newUUIDv7(), note: "ok", extra: 1 }] })),
    reject("affected"),
  );
  await assert.rejects(
    (x.service as any).assess(file({ assessment: "applicable", rationale: "ok", affected: [{ target_type: "spaceship", target_id: newUUIDv7(), note: "ok" }] })),
    reject("affected"),
  );
  await assert.rejects(
    (x.service as any).assess(file({ assessment: "applicable", rationale: "ok", affected: [{ target_type: "goal", target_id: "not-a-uuid", note: "ok" }] })),
    reject("affected"),
  );
  await assert.rejects(
    (x.service as any).assess(file({ assessment: "applicable", rationale: "ok", affected: [{ target_type: "goal", target_id: newUUIDv7(), criterion_id: "nope", note: "ok" }] })),
    reject("affected.criterion_id"),
  );
  await assert.rejects(
    (x.service as any).assess(file({ assessment: "applicable", rationale: "ok", affected: [{ target_type: "goal", target_id: newUUIDv7(), note: "   " }] })),
    reject("affected.note"),
  );
  // A well-formed clause reference is accepted and echoed back intact.
  const clauseId = newUUIDv7();
  const criterionId = newUUIDv7();
  const accepted = await x.service.assess(file({ assessment: "applicable", rationale: "Reviewed the affected goals", affected: [{ target_type: "goal", target_id: clauseId, criterion_id: criterionId, note: "Still applicable" }] }));
  assert.deepEqual(accepted.data.affected, [{ target_type: "goal", target_id: clauseId, criterion_id: criterionId, note: "Still applicable" }]);
});

test("admit rejects a malformed DevRun, assessment identity, expected-head and expected-version", async (t) => {
  const x = await fixture(t);
  const observed = await startObservation(x);
  const assessed = await x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "applicable", rationale: "Reviewed", affected: [] } });
  const reject = (field: string) => (e: any) => e.code === "VALIDATION_ERROR" && e.details.field === field;
  const admit = (over: Record<string, unknown>) => ({ ...actor(), dev_run_id: x.devRunId, assessment_id: assessed.id, refresh: true, ...over });

  await assert.rejects((x.service as any).admit(admit({ dev_run_id: "nope" })), reject("preflight"));
  await assert.rejects((x.service as any).admit(admit({ assessment_id: "nope" })), reject("preflight"));
  await assert.rejects((x.service as any).admit(admit({ expected_head: "HEAD" })), reject("expected-head"));
  await assert.rejects((x.service as any).admit(admit({ expected_version: 0 })), reject("expected-version"));
  await assert.rejects((x.service as any).admit(admit({ expected_version: 1.5 })), reject("expected-version"));
});

// --- The read model across missing / unknown / revision_required / stale ----

test("the read model reports missing before any observation and the assessed outcome after one", async (t) => {
  const x = await fixture(t);
  // A freshly prepared run has a preparation but no observed inputs at all.
  const missing = await x.service.devRunReadModel(x.devRunId);
  assert.equal(missing?.state, "preparing");
  assert.equal(missing?.code, "no_observation");
  assert.ok(missing!.next_commands.some((command) => command.includes("preflight observe")));

  const observed = await x.isolate(() => x.service.observe({ ...actor(), phase: "start", refresh: true, repository_id: x.f.repository.repository_id, issue_id: x.f.issue.issue_id, issue_revision_id: x.issueRevisionId, dev_run_id: x.devRunId }));

  // With no assessment yet the model asks for exactly that assessment.
  const unassessed = await x.service.devRunReadModel(x.devRunId);
  assert.equal(unassessed?.code, "assessment_missing");
  assert.ok(unassessed!.next_commands.some((command) => command.includes(`grounds preflight assess --observation ${observed.id}`)));

  // A non-applicable judgement is surfaced verbatim, never as an admission.
  const unknown = await x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "unknown", rationale: "Cannot judge from the recorded inputs", affected: [] } });
  const unknownModel = await x.service.devRunReadModel(x.devRunId);
  assert.equal(unknownModel?.state, "preparing");
  assert.equal(unknownModel?.code, "assessment_unknown");
  assert.equal(unknownModel?.summary, "Cannot judge from the recorded inputs");
  assert.equal(unknownModel?.assessment, undefined);

  const required = await x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "revision_required", rationale: "The sealed contract must be revised first", affected: [] } });
  assert.notEqual(required.id, unknown.id);
  const requiredModel = await x.service.devRunReadModel(x.devRunId);
  assert.equal(requiredModel?.code, "assessment_revision_required");
  assert.equal(requiredModel?.summary, "The sealed contract must be revised first");

  // An applicable assessment does not itself admit: a final refresh is still owed.
  await x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "applicable", rationale: "Reviewed", affected: [] } });
  const notAdmitted = await x.service.devRunReadModel(x.devRunId);
  assert.equal(notAdmitted?.code, "not_admitted");
  assert.equal(notAdmitted?.required_inputs.base_commit, x.base);
  assert.equal(notAdmitted?.required_inputs.issue_version, 2);
  assert.ok(notAdmitted!.next_commands.some((command) => command.includes("grounds devrun admit")));
});

test("the read model reports a stale target until the observed commit matches the run base", async (t) => {
  const x = await fixture(t);
  const observed = await x.isolate(() => x.service.observe({ ...actor(), phase: "start", refresh: true, repository_id: x.f.repository.repository_id, issue_id: x.f.issue.issue_id, issue_revision_id: x.issueRevisionId, dev_run_id: x.devRunId }));
  await x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "applicable", rationale: "Looks applicable", affected: [] } });
  assert.equal((await x.service.devRunReadModel(x.devRunId))?.code, "not_admitted");

  // The target advances and a newer observation records the new commit. The
  // run's base is unchanged, so the model must report the target as advanced.
  const advanced = advanceRemote(x);
  assert.notEqual(advanced, x.base);
  const newer = await x.isolate(() => x.service.observe({ ...actor(), phase: "start", refresh: true, repository_id: x.f.repository.repository_id, issue_id: x.f.issue.issue_id, issue_revision_id: x.issueRevisionId, dev_run_id: x.devRunId }));
  assert.equal((newer.data.observation as { commit: { oid: string } }).commit.oid, advanced);
  const stale = await x.service.devRunReadModel(x.devRunId);
  assert.equal(stale?.code, "stale_target");
  assert.equal(stale?.state, "preparing");
});

// --- Real preparation scene boundaries --------------------------------------

test("observe refuses to evaluate the run inputs while an unfinished Git operation is present", async (t) => {
  const x = await fixture(t);
  // A real unfinished merge in the managed scene, expressed the way Git records
  // it, so the check cannot pass by accident of a clean worktree.
  const marker = resolve(x.worktree, x.git(x.worktree, "rev-parse", "--git-path", "MERGE_HEAD"));
  writeFileSync(marker, `${x.base.replace("sha1:", "")}\n`);
  try {
    await assert.rejects(
      x.isolate(() => x.service.observe({ ...actor(), phase: "start", refresh: true, repository_id: x.f.repository.repository_id, issue_id: x.f.issue.issue_id, issue_revision_id: x.issueRevisionId, dev_run_id: x.devRunId })),
      (e: any) => e.code === "STATE_CONFLICT" && /complete the Git operation/.test(String(e.details.reason)),
    );
  } finally { rmSync(marker, { force: true }); }
  // With the operation cleared the same observation succeeds, so the refusal
  // was the unfinished operation and not a broken scene.
  const observed = await x.isolate(() => x.service.observe({ ...actor(), phase: "start", refresh: true, repository_id: x.f.repository.repository_id, issue_id: x.f.issue.issue_id, issue_revision_id: x.issueRevisionId, dev_run_id: x.devRunId }));
  assert.equal(observed.data.binds.dev_run_id, x.devRunId);
});

test("admit refuses a preparation scene that moved after the observation and keeps the new state", async (t) => {
  const x = await fixture(t);
  const observed = await x.isolate(() => x.service.observe({ ...actor(), phase: "start", refresh: true, repository_id: x.f.repository.repository_id, issue_id: x.f.issue.issue_id, issue_revision_id: x.issueRevisionId, dev_run_id: x.devRunId }));
  const assessed = await x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "applicable", rationale: "The prepared scene matches the refreshed target", affected: [] } });

  // The prepared worktree gains uncommitted work after the observation, so the
  // captured input digest no longer matches what was assessed.
  writeFileSync(join(x.worktree, "file"), "changed after the observation\n");
  const dirtyHead = x.git(x.worktree, "status", "--porcelain");
  await assert.rejects(
    x.isolate(() => x.service.admit({ ...actor(), dev_run_id: x.devRunId, assessment_id: assessed.id, refresh: true })),
    (e: any) => e.code === "STATE_CONFLICT" && /development inputs changed|actual development inputs changed/.test(String(e.details.reason ?? e.message)),
  );
  // The refusal must not touch the scene, and no admission may be recorded.
  assert.equal(x.git(x.worktree, "status", "--porcelain"), dirtyHead);
  const model = await x.service.devRunReadModel(x.devRunId);
  assert.notEqual(model?.state, "admitted");
});

// --- Explicit refresh authorization and refresh failure ---------------------

test("the coordinator requires explicit refresh authorization and refuses a target it cannot refresh", async (t) => {
  const x = await fixture(t);
  const observed = await startObservation(x);
  await x.service.assess({ ...actor(), observation_id: observed.id, file: { assessment: "applicable", rationale: "The fixed contract matches this target", affected: [] } });
  const gate = { issue_revision_id: x.issueRevisionId, repository_id: x.f.repository.repository_id, expected_commit: x.base, what: "start", operation_id: newUUIDv7() };

  // Without --refresh the authorization is missing and no fetch is attempted.
  await assert.rejects(
    x.service.coordinator({ refresh: false }).start(gate),
    (e: any) => e.code === "STATE_CONFLICT" && /explicit target refresh authorization/.test(e.message ?? String(e.details?.reason)),
  );

  // With authorization but an unreachable transport the final refresh fails and
  // the gate refuses, reporting both the approved and the observed commit.
  x.git(x.source, "config", "--unset-all", `url.file://${x.remote}.insteadOf`);
  x.git(x.source, "config", "core.sshCommand", "/usr/bin/false");
  await assert.rejects(
    x.service.coordinator({ refresh: true }).start(gate),
    (e: any) => e.code === "STATE_CONFLICT" && /target changed or could not be refreshed/.test(e.message ?? String(e.details?.reason)),
  );
});

// --- Idempotent replays must reject a different request ---------------------

test("an observe replay rejects a different request on the same operation ID", async (t) => {
  const x = await fixture(t);
  const operationId = newUUIDv7();
  const first = await x.ok(["preflight", "observe", "--phase", "definition", "--target-remote", "origin", "--target-branch", "refs/heads/main", "--repository", x.f.repository.repository_id, "--refresh", "--operation-id", operationId]);
  assert.equal(first.observation.refreshed, true);

  // The same request replays byte-for-byte from the recorded operation.
  const replay = await x.ok(["preflight", "observe", "--phase", "definition", "--target-remote", "origin", "--target-branch", "refs/heads/main", "--repository", x.f.repository.repository_id, "--refresh", "--operation-id", operationId]);
  assert.deepEqual(replay, first);

  // A different target under the same operation ID is a different request.
  const conflicting = await x.invoke(["preflight", "observe", "--phase", "definition", "--target-remote", "origin", "--target-branch", "refs/heads/other", "--repository", x.f.repository.repository_id, "--refresh", "--operation-id", operationId]);
  assert.notEqual(conflicting.code, 0, JSON.stringify(conflicting.envelope));
  assert.equal(conflicting.envelope.error.code, "IDEMPOTENCY_CONFLICT");
});

test("an admit replay rejects a different expected version on the same operation ID", async (t) => {
  const x = await fixture(t);
  const observed = await x.ok(["preflight", "observe", "--phase", "start", "--dev-run", x.devRunId, "--refresh"]);
  const file = join(x.root, "assessment.json");
  writeFileSync(file, JSON.stringify({ assessment: "applicable", rationale: "The run inputs match the refreshed target", affected: [] }));
  const assessed = await x.ok(["preflight", "assess", "--observation", observed.observation_id, "--file", file]);

  const operationId = newUUIDv7();
  const admitted = await x.ok(["devrun", "admit", "--dev-run", x.devRunId, "--preflight", assessed.assessment_id, "--expected-version", "1", "--refresh", "--operation-id", operationId]);
  assert.equal(admitted.admission.target_commit, x.base);

  const replay = await x.ok(["devrun", "admit", "--dev-run", x.devRunId, "--preflight", assessed.assessment_id, "--expected-version", "1", "--refresh", "--operation-id", operationId]);
  assert.equal(replay.admission.admitted_at, admitted.admission.admitted_at);

  const conflicting = await x.invoke(["devrun", "admit", "--dev-run", x.devRunId, "--preflight", assessed.assessment_id, "--expected-version", "2", "--refresh", "--operation-id", operationId]);
  assert.notEqual(conflicting.code, 0, JSON.stringify(conflicting.envelope));
  assert.equal(conflicting.envelope.error.code, "IDEMPOTENCY_CONFLICT");
});
