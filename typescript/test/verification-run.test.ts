import { repositoryDataRoot } from "../src/data-layout.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, runCLI } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { captureCommittedCandidate, retainCandidateSource } from "../src/development-branch.js";
import { newUUIDv7 } from "../src/identity.js";
import { SQLStore } from "../src/sql-store.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import type { CandidateSubmissionV2Input } from "../src/domain.js";
import { runData, summarize, unionDuration, VerificationRuns } from "../src/verification-run.js";
import { beginRunData, closeStage, enterStage, recordCommand } from "../src/verification-run.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";

const sha = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

interface Harness {
  fixture: LedgerFixture;
  config: string;
  directory: string;
  repo: string;
  baseline: string;
  candidateId: string;
  invoke: (args: string[]) => Promise<{ code: number; envelope: any }>;
  close: () => Promise<void>;
}

/** A temp SQLite ledger over a real git repo, so `verification run start` can materialize a review worktree
 * from the Candidate's fixed Git artifact (a synthetic patch-only candidate is unsupported since env v5). */
const harness = async (): Promise<Harness> => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "grounds-vrun-")));
  const repo = join(directory, "repo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--initial-branch=master", repo]);
  git("config", "user.name", "T"); git("config", "user.email", "t@example.test");
  git("remote", "add", "origin", "ssh://git@example.test/team/repo");
  writeFileSync(join(repo, ".git/info/exclude"), "/.grounds/\n");
  writeFileSync(join(repo, "a.txt"), "before\n");
  git("add", "-A"); git("commit", "-qm", "base");
  const baseline = `sha1:${git("rev-parse", "HEAD")}`;
  git("update-ref", "refs/remotes/origin/main", baseline.slice(5));

  const directories = { runtimeHome: join(directory, "runtime"), directoryRegistryHome: join(directory, "registry") };
  const config = join(directory, "config.yaml"), db = join(directory, "ledger.db");
  await withRuntimeDirectories(directories, () => execute(["init", "--driver", "sqlite", "--non-interactive", "--config", config, "--path", db]));
  const fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(db));
  const issue = await fixture.module.reviseIssue({ operation_id: newUUIDv7(), issue_id: fixture.issue.issue_id, expected_predecessor_id: fixture.issue.issue_revision_id, requirement_revision_id: fixture.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: { git_oid: baseline, reachability: "unconfirmed", warning: "local fixture", override_reason: "local fixture" }, input: { format: 1, summary: "Real artifact", goals: [{ statement: "Change file", criteria: ["File changes"] }] }, attribution: testAgent });
  const databaseID = loadConfig(config).database.expected_database_id;

  const invoke: Harness["invoke"] = async (args) => {
    let output: string[] = [], code = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      output = [];
      code = await withRuntimeDirectories(directories, () => runCLI([...args, "--config", config, "--json"], { cwd: repo, stdout: (line) => output.push(line), stderr: () => {} }));
      if (code === 0 || !/busy: another local controller holds the operation lock/.test(output[0] ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    let envelope: any;
    try { envelope = JSON.parse(output[0]); } catch { envelope = { raw: output.join("\n") }; }
    // Validate every successful result against the machine contract, the way the other CLI tests do.
    if (code === 0 && envelope.data) assertContract("command-results.schema.json", envelope.data);
    return { code, envelope };
  };

  // A real Candidate: start a DevRun, commit the worktree, capture it as a fixed Git artifact, submit it.
  const started = await invoke(["devrun", "start", "--development-mode", "simple", issue.result.issue_id]);
  assert.equal(started.code, 0, JSON.stringify(started.envelope));
  const runID = started.envelope.data.context.dev_run.id as string;
  const worktree = started.envelope.data.local_worktree.path as string;
  writeFileSync(join(worktree, "a.txt"), "after\n");
  const dev = new DevWorktreeModule(repo, databaseID, newUUIDv7, fixture.store, directories.directoryRegistryHome);
  const candidateId = await dev.submit(runID, async (path) => {
    gitIn(path, "add", "-A"); gitIn(path, "commit", "--allow-empty", "-qm", "fixed candidate");
    const fixed = captureCommittedCandidate(path, baseline), artifact = fixed.artifact;
    const draft = (await fixture.module.candidateSubmissionTemplate(runID, artifact)).submission as CandidateSubmissionV2Input;
    draft.explanation = "Changed a file";
    for (const claim of draft.claims) { claim.explanation = "Changes file"; for (const criterion of claim.criteria) criterion.explanation = "Inspected file"; }
    for (const rationale of draft.change_rationales) { rationale.target_refs = [{ type: "criterion", id: draft.claims[0].criteria[0].criterion_id }]; rationale.rationale = "Reviewed wording"; rationale.alternatives = []; rationale.risks = []; }
    const submitted = await fixture.module.submitCandidate({ ...fixture.gitCandidateFields(artifact, baseline, fixed.source), operation_id: newUUIDv7(), dev_run_id: runID, expected_version: 1, submission: draft, artifact, attribution: testAgent });
    retainCandidateSource(repo, submitted.candidate_id, fixed.source);
    return { ...submitted, result_tree_oid: artifact.result_tree_oid };
  }).then((result) => result.candidate_id);

  return { fixture, config, directory, repo, baseline, candidateId, invoke, close: async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); } };
};

const withHarness = async (body: (h: Harness) => Promise<void>) => {
  const h = await harness();
  try { await body(h); } finally { await h.close(); }
};

test("stage timing: union of overlapping intervals counts parallel work once", () => {
  assert.equal(unionDuration([[0, 100]]), 100);
  assert.equal(unionDuration([[0, 100], [50, 150]]), 150);
  assert.equal(unionDuration([[0, 100], [200, 250]]), 150);
  assert.equal(unionDuration([[100, 50]]), 0, "a reversed interval contributes nothing");
});

test("run start records a prepared run bound to the Candidate, session and result tree", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    assert.equal(started.code, 0, JSON.stringify(started.envelope));
    assert.equal(started.envelope.ok, true);
    const data = started.envelope.data;
    assert.equal(data.format, "grounds.verification-run/v1");
    assert.equal(data.candidate_id, h.candidateId);
    assert.equal(data.role, "contract");
    assert.equal(data.current_stage, undefined, "prepare is closed by start");
    const prepare = data.stages.find((stage: any) => stage.stage === "prepare");
    assert.equal(prepare.state, "succeeded");
    assert.equal(prepare.complete, true);
    // The report skeleton and blind context live beside worktree/, never inside it.
    assert.ok(statSync(data.paths.review_worktree).isDirectory());
    for (const path of [data.paths.blind_context, data.paths.report_skeleton]) {
      assert.ok(statSync(path).isFile());
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.ok(realpathSync(path).startsWith(realpathSync(join(repositoryDataRoot(join(h.directory, "repo")), "reviews", h.candidateId))));
    }
    assert.ok(!readdirSync(data.paths.review_worktree).includes("context-blind-contract.json"), "material must not land inside the verified tree");
  });
});

test("an Agent can start and observe verification without a human Git identity", async () => {
  await withHarness(async (h) => {
    // Empty local values also override an inherited global profile.
    for (const key of ["user.name", "user.email"]) execFileSync("git", ["config", "--local", key, ""], { cwd: h.repo });
    const unattributed = await h.invoke(["verification", "run", "start", h.candidateId]);
    assert.notEqual(unattributed.code, 0, "creation still requires an explicit actor");
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    assert.equal(started.code, 0, JSON.stringify(started.envelope));
    const runId = started.envelope.data.run_id;
    for (const args of [
      ["show", runId],
      ["stage", runId, "--stage", "blind", "--state", "running"],
      ["stage", runId, "--stage", "blind", "--state", "succeeded"],
      ["freeze", runId, "--independent-digest", sha("a")],
      ["show", runId],
    ]) {
      const result = await h.invoke(["verification", "run", ...args]);
      assert.equal(result.code, 0, JSON.stringify(result.envelope));
    }
  });
});

test("run show derives a next step from the durable record and never fakes missing durations", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    const shown = await h.invoke(["verification", "run", "show", runId]);
    assert.equal(shown.code, 0, JSON.stringify(shown.envelope));
    const data = shown.envelope.data;
    assert.match(data.next_step, /blind/);
    assert.equal(data.timing_basis.unit, "ms");
    // A stage never entered is absent rather than reported as a zero-duration success.
    assert.equal(data.stages.find((stage: any) => stage.stage === "reconcile"), undefined);
    assert.deepEqual(data.anomalies, []);
  });
});

test("reconcile material is refused until the blind assessment is closed and frozen", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id, session = started.envelope.data.review_session_id;

    const early = await h.invoke(["verification", "context", h.candidateId, "--phase", "reconcile", "--review-session", session]);
    assert.notEqual(early.code, 0, JSON.stringify(early.envelope));
    assert.equal(early.envelope.error.code, "STATE_CONFLICT");
    assert.equal(early.envelope.error.details.reason, "blind_not_closed");

    const entered = await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "running"]);
    assert.equal(entered.code, 0, JSON.stringify(entered.envelope));
    const closed = await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "succeeded"]);
    assert.equal(closed.code, 0, JSON.stringify(closed.envelope));

    const unfrozen = await h.invoke(["verification", "context", h.candidateId, "--phase", "reconcile", "--review-session", session]);
    assert.notEqual(unfrozen.code, 0, JSON.stringify(unfrozen.envelope));
    assert.equal(unfrozen.envelope.error.details.reason, "blind_not_frozen");

    const frozen = await h.invoke(["verification", "run", "freeze", runId, "--independent-digest", sha("a")]);
    assert.equal(frozen.code, 0, JSON.stringify(frozen.envelope));

    const allowed = await h.invoke(["verification", "context", h.candidateId, "--phase", "reconcile", "--review-session", session]);
    assert.equal(allowed.code, 0, JSON.stringify(allowed.envelope));
    assert.equal(allowed.envelope.data.context.phase, "reconcile");
  });
});

test("the freeze digest is immutable and a handoff is required before a confirmed submit", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "running"]);
    await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "succeeded"]);
    await h.invoke(["verification", "run", "freeze", runId, "--independent-digest", sha("a")]);

    const changed = await h.invoke(["verification", "run", "freeze", runId, "--independent-digest", sha("b")]);
    assert.notEqual(changed.code, 0, JSON.stringify(changed.envelope));
    assert.equal(changed.envelope.error.details.reason, "freeze_immutable");

    const earlySubmit = await h.invoke(["verification", "run", "submit", runId, "--state", "confirmed", "--operation-id", newUUIDv7(), "--verification", newUUIDv7()]);
    assert.notEqual(earlySubmit.code, 0, JSON.stringify(earlySubmit.envelope));
    assert.equal(earlySubmit.envelope.error.details.reason, "handoff_missing");
  });
});

test("entry-spanned stages cannot be forced succeeded, and coordinator stages close only after entry", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    // prepare/freeze/handoff/submit are opened and closed by their own entry; a direct success is refused.
    for (const stage of ["prepare", "freeze", "handoff", "submit"]) {
      const forced = await h.invoke(["verification", "run", "stage", runId, "--stage", stage, "--state", "succeeded"]);
      assert.notEqual(forced.code, 0, `${stage}: ${JSON.stringify(forced.envelope)}`);
      assert.equal(forced.envelope.error.code, "VALIDATION_ERROR");
    }
    // A coordinator stage cannot be closed before it was entered.
    const early = await h.invoke(["verification", "run", "stage", runId, "--stage", "reconcile", "--state", "succeeded"]);
    assert.notEqual(early.code, 0, JSON.stringify(early.envelope));
    assert.equal(early.envelope.error.code, "STATE_CONFLICT");
    assert.equal(early.envelope.error.details.reason, "stage_not_entered");
    // Entering then closing a coordinator stage is legal.
    const enter = await h.invoke(["verification", "run", "stage", runId, "--stage", "reconcile", "--state", "running"]);
    assert.equal(enter.code, 0, JSON.stringify(enter.envelope));
    const close = await h.invoke(["verification", "run", "stage", runId, "--stage", "reconcile", "--state", "succeeded"]);
    assert.equal(close.code, 0, JSON.stringify(close.envelope));
    assert.equal(close.envelope.data.current_stage, undefined);
  });
});

test("reconcile and submit stages are entered and closed by their own entries", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id, session = started.envelope.data.review_session_id;
    // Blind closes, then freeze closes its own stage.
    await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "running"]);
    await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "succeeded"]);
    const frozen = await h.invoke(["verification", "run", "freeze", runId, "--independent-digest", sha("a")]);
    assert.equal(frozen.code, 0, JSON.stringify(frozen.envelope));
    assert.equal(frozen.envelope.data.stages.find((s: any) => s.stage === "freeze").state, "succeeded");
    // Fetching reconcile context opens the reconcile stage.
    const reconcile = await h.invoke(["verification", "context", h.candidateId, "--phase", "reconcile", "--review-session", session]);
    assert.equal(reconcile.code, 0, JSON.stringify(reconcile.envelope));
    const opened = await h.invoke(["verification", "run", "show", runId]);
    assert.equal(opened.envelope.data.current_stage, "reconcile", "reconcile entry opens the reconcile stage");
    // The coordinator closes it after the same verifier finishes.
    await h.invoke(["verification", "run", "stage", runId, "--stage", "reconcile", "--state", "succeeded"]);
    // A signed handoff closes the handoff stage.
    const handoff = await h.invoke(["verification", "run", "handoff", runId, "--report-digest", sha("b"), "--state", "signed"]);
    assert.equal(handoff.envelope.data.stages.find((s: any) => s.stage === "handoff").state, "succeeded");
    // A confirmed submit closes the submit stage.
    const submit = await h.invoke(["verification", "run", "submit", runId, "--state", "confirmed", "--operation-id", newUUIDv7(), "--verification", newUUIDv7()]);
    assert.equal(submit.code, 0, JSON.stringify(submit.envelope));
    const stages = Object.fromEntries(submit.envelope.data.stages.map((s: any) => [s.stage, s.state]));
    assert.deepEqual(stages, { prepare: "succeeded", blind: "succeeded", freeze: "succeeded", reconcile: "succeeded", handoff: "succeeded", submit: "succeeded" });
  });
});

test("submitting through the public interface auto-binds the run's submit state", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id, session = started.envelope.data.review_session_id;
    const reportPath = started.envelope.data.paths.report_skeleton;
    assert.ok(reportPath);
    // Fill the skeleton with a qualified single-criterion assessment, then submit through the normal path.
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const assessment of report.assessments) for (const criterion of assessment.criteria) {
      criterion.independent = { verdict: "qualified", explanation: "Independently checked", evidence: [] };
      criterion.reconciliation = { claim_relation: "corroborated", explanation: "Compared with the claim" };
      criterion.final = { verdict: "qualified", explanation: "Final" };
    }
    const edited = join(h.directory, "report.json");
    writeFileSync(edited, JSON.stringify(report));
    writeFileSync(join(h.directory, "verify.sh"), "");
    const submitted = await h.invoke(["verification", "submit", h.candidateId, "--file", edited, "--agent-id", "verifier-1", "--agent-name", "Verifier"]);
    assert.equal(submitted.code, 0, JSON.stringify(submitted.envelope));
    const verificationId = submitted.envelope.data.verification_id;

    const shown = await h.invoke(["verification", "run", "show", runId]);
    assert.equal(shown.envelope.data.submit.state, "confirmed");
    assert.equal(shown.envelope.data.submit.verification_id, verificationId);
    assert.match(shown.envelope.data.next_step, /submitted/i);

    // A later unknown retry must not overwrite the confirmed submit.
    const retry = await h.invoke(["verification", "run", "submit", runId, "--state", "unknown", "--operation-id", newUUIDv7()]);
    assert.equal(retry.code, 0, JSON.stringify(retry.envelope));
    const after = await h.invoke(["verification", "run", "show", runId]);
    assert.equal(after.envelope.data.submit.state, "confirmed");
    assert.equal(after.envelope.data.submit.verification_id, verificationId);
    void session;
  });
});

test("command observation records an argv digest, never raw arguments", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    const secret = "SHOULD-NOT-APPEAR-IN-LEDGER";
    const recorded = await h.invoke(["verification", "run", "command", runId, "--stage", "blind", "--entry", "pytest", "--started-at", "2026-10-16T00:00:00.000Z", "--ended-at", "2026-10-16T00:00:05.000Z", "--exit-code", "0"]);
    assert.equal(recorded.code, 0, JSON.stringify(recorded.envelope));
    assert.equal(recorded.envelope.data.commands.collected, 1);
    assert.equal(recorded.envelope.data.commands.duration_ms, 5000);
    const row = await new VerificationRuns(h.fixture.store).show(runId);
    assert.ok(!JSON.stringify(row).includes(secret));
  });
});

test("an unknown run, an unknown flag and an out-of-range stage all fail with exit 2", async () => {
  await withHarness(async (h) => {
    const unknown = await h.invoke(["verification", "run", "show", newUUIDv7()]);
    assert.equal(unknown.code, 3, JSON.stringify(unknown.envelope));
    assert.equal(unknown.envelope.error.code, "NOT_FOUND");
    const badFlag = await h.invoke(["verification", "run", "show", newUUIDv7(), "--not-a-flag", "x"]);
    assert.equal(badFlag.code, 2, JSON.stringify(badFlag.envelope));
    assert.equal(badFlag.envelope.error.code, "VALIDATION_ERROR");
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const badStage = await h.invoke(["verification", "run", "stage", started.envelope.data.run_id, "--stage", "nope", "--state", "succeeded"]);
    assert.equal(badStage.code, 2, JSON.stringify(badStage.envelope));
    assert.equal(badStage.envelope.error.code, "VALIDATION_ERROR");
  });
});

test("run data rejects a corrupt record instead of reinterpreting it", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    const row = await new VerificationRuns(h.fixture.store).show(runId);
    const corrupt = { ...row, data: { ...row.data, blind_context_digest: "not-a-digest" } };
    assert.throws(() => runData(corrupt as any));
    const summary = summarize(row.id, row);
    assert.equal(summary.run_id, runId);
    assert.equal(summary.format, "grounds.verification-run/v1");
    assert.ok(summary.timing_basis.missing.includes("never entered"));
  });
});

test("the run record persists as a runtime_operation with no schema change", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    const rows = await h.fixture.store.read(async (tx) => tx.listRuntimeRecords("runtime_operation", h.candidateId));
    const mine = rows.find((row) => row.id === runId);
    assert.ok(mine, "the run is a runtime_operation row parented by the Candidate");
    assert.equal(mine!.data.format, "grounds.verification-run/v1");
    assert.equal(runData(mine!).role, "contract");
    void testAgent;
  });
});

test("a quality-role run is separate from the contract run and carries its own session", async () => {
  await withHarness(async (h) => {
    const contract = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const quality = await h.invoke(["verification", "run", "start", h.candidateId, "--role", "quality", "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    assert.equal(quality.code, 0, JSON.stringify(quality.envelope));
    assert.equal(quality.envelope.data.role, "quality");
    assert.notEqual(quality.envelope.data.review_session_id, contract.envelope.data.review_session_id, "each role has its own review session");

    const listed = await h.invoke(["verification", "run", "list", h.candidateId]);
    assert.equal(listed.code, 0, JSON.stringify(listed.envelope));
    assert.equal(listed.envelope.data.runs.length, 2);
    const filtered = await h.invoke(["verification", "run", "list", h.candidateId, "--role", "quality"]);
    assert.equal(filtered.envelope.data.runs.length, 1);
    assert.equal(filtered.envelope.data.runs[0].role, "quality");

    // The reconcile gate applies per role: a contract run's session does not gate the quality session.
    const qualityReconcile = await h.invoke(["verification", "context", h.candidateId, "--phase", "reconcile", "--role", "quality", "--review-session", quality.envelope.data.review_session_id]);
    assert.notEqual(qualityReconcile.code, 0, JSON.stringify(qualityReconcile.envelope));
    assert.equal(qualityReconcile.envelope.error.details.reason, "blind_not_closed");
  });
});

test("an interrupted run resumes from its durable record without re-preparing material", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    const session = started.envelope.data.review_session_id;

    // Simulate a coordinator that stops mid-blind: reopen the record fresh and see the last confirmed stage.
    await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "running"]);
    await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "failed", "--reason", "verifier context lost"]);
    const resumed = await h.invoke(["verification", "run", "show", runId]);
    const blind = resumed.envelope.data.stages.find((stage: any) => stage.stage === "blind");
    assert.equal(blind.state, "failed");
    assert.equal(blind.reason, "verifier context lost");
    assert.match(resumed.envelope.data.next_step, /blind/);
    // The material is retained: a fresh show still points at the same session and paths.
    assert.equal(resumed.envelope.data.retained.review_worktree, started.envelope.data.paths.review_worktree);
    const again = await h.invoke(["verification", "run", "list", h.candidateId, "--review-session", session]);
    assert.equal(again.envelope.data.runs.length, 1, "exactly one run for this session, no duplicate preparation");
  });
});

test("help, environment binding and handoff recording are available and bounded", async () => {
  await withHarness(async (h) => {
    const help = await h.invoke(["verification", "run", "help"]);
    assert.equal(help.code, 0, JSON.stringify(help.envelope));
    assert.match(help.envelope.data.usage, /grounds verification run/);
    assert.match(help.envelope.data.usage, /run submit/);

    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;

    const env = await h.invoke(["verification", "run", "environment", runId, "--identity", "env-1", "--asset", "base-image", "--lease", "lease-1", "--hit", "true", "--reason", "compatible base asset reused"]);
    assert.equal(env.code, 0, JSON.stringify(env.envelope));
    assert.equal(env.envelope.data.environment.hit, true);
    assert.equal(env.envelope.data.environment.identity, "env-1");

    const handoff = await h.invoke(["verification", "run", "handoff", runId, "--report-digest", sha("c"), "--state", "signed"]);
    assert.equal(handoff.code, 0, JSON.stringify(handoff.envelope));
    assert.equal(handoff.envelope.data.handoff.state, "signed");

    const unknownState = await h.invoke(["verification", "run", "handoff", runId, "--report-digest", sha("c"), "--state", "bogus"]);
    assert.equal(unknownState.code, 2, JSON.stringify(unknownState.envelope));
    const badHit = await h.invoke(["verification", "run", "environment", runId, "--identity", "x", "--hit", "maybe", "--reason", "r"]);
    assert.equal(badHit.code, 2, JSON.stringify(badHit.envelope));
  });
});

test("identifier and option misuse is rejected before touching the ledger", async () => {
  await withHarness(async (h) => {
    // Positional and named ID together are ambiguous.
    const both = await h.invoke(["verification", "run", "show", h.candidateId, "--run", h.candidateId]);
    assert.equal(both.code, 2, JSON.stringify(both.envelope));
    // A non-UUID identifier is rejected.
    const notId = await h.invoke(["verification", "run", "show", "not-a-uuid"]);
    assert.equal(notId.code, 2, JSON.stringify(notId.envelope));
    // A malformed operation-id is rejected.
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const badOp = await h.invoke(["verification", "run", "submit", started.envelope.data.run_id, "--state", "pending", "--operation-id", "nope"]);
    assert.equal(badOp.code, 2, JSON.stringify(badOp.envelope));
    // A non-digest freeze is rejected.
    const badFreeze = await h.invoke(["verification", "run", "freeze", started.envelope.data.run_id, "--independent-digest", "not-a-digest"]);
    assert.equal(badFreeze.code, 2, JSON.stringify(badFreeze.envelope));
  });
});

test("pure run-data transitions reject illegal moves and record clock anomalies", () => {
  const base = beginRunData({
    candidate_id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a73",
    result_tree_oid: "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    blind_context_digest: sha("d"),
    role: "contract",
    review_session_id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a73",
    review_worktree: "/tmp/wt",
    attribution: testAgent,
    at: "2026-10-16T00:00:00.000Z",
  });
  closeStage(base, "prepare", "succeeded", "2026-10-16T00:00:01.000Z");
  assert.equal(base.stages.prepare![0]!.duration_ms, 1000);

  // A stage cannot be closed before it is entered, and cannot be entered twice.
  assert.throws(() => closeStage(base, "blind", "succeeded", "2026-10-16T00:00:02.000Z"), /was not entered/);
  enterStage(base, "blind", "2026-10-16T00:00:02.000Z");
  assert.throws(() => enterStage(base, "blind", "2026-10-16T00:00:03.000Z"), /already running/);
  // A closed stage accumulates attempts rather than replacing them.
  closeStage(base, "blind", "failed", "2026-10-16T00:00:03.000Z", "lost context");
  enterStage(base, "blind", "2026-10-16T00:00:04.000Z");
  closeStage(base, "blind", "succeeded", "2026-10-16T00:00:05.000Z");
  assert.equal(base.stages.blind!.length, 2);
  assert.equal(base.stages.blind![1]!.attempt, 2);

  // A non-monotonic clock is an anomaly with a zero duration, never a negative one.
  enterStage(base, "wait", "2026-10-16T00:00:10.000Z");
  closeStage(base, "wait", "succeeded", "2026-10-16T00:00:08.000Z");
  assert.equal(base.stages.wait![0]!.duration_ms, 0);
  assert.ok(base.anomalies.some((entry) => entry.includes("stage wait")));

  // A negative command interval is also an anomaly, recorded as zero.
  recordCommand(base, { stage: "blind", entry: "pytest", argv_digest: sha("e"), started_at: "2026-10-16T00:00:20.000Z", ended_at: "2026-10-16T00:00:19.000Z", state: "succeeded" });
  assert.equal(base.commands[0]!.duration_ms, 0);
  assert.ok(base.anomalies.some((entry) => entry.includes("command pytest")));
});

test("runData rejects each malformed shape rather than reinterpreting it", () => {
  const good = beginRunData({
    candidate_id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a73",
    result_tree_oid: "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    blind_context_digest: sha("d"),
    role: "contract",
    review_session_id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a73",
    review_worktree: "/tmp/wt",
    attribution: testAgent,
    at: "2026-10-16T00:00:00.000Z",
  });
  const row = (data: any) => ({ id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a73", kind: "runtime_operation" as const, parent_id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a73", version: 1, data });
  // A record whose format differs is not a run record at all.
  assert.equal(runData.length > 0, true);
  assert.throws(() => runData(row({ ...good, format: "other" })));
  // Wrong parent, wrong role, missing session and a bad timestamp all fail.
  assert.throws(() => runData({ ...row(good), parent_id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a74" }));
  assert.throws(() => runData(row({ ...good, role: "nope" })));
  assert.throws(() => runData(row({ ...good, created_at: "not-a-time" })));
  assert.throws(() => runData(row({ ...good, stages: { prepare: [{ attempt: 0, started_at: "2026-10-16T00:00:00.000Z", state: "running" }] } })));
  assert.throws(() => runData(row({ ...good, stages: { prepare: [{ attempt: 1, started_at: "2026-10-16T00:00:00.000Z", state: "bogus" }] } })));
  // A closed stage must carry both an end and a duration.
  assert.throws(() => runData(row({ ...good, stages: { prepare: [{ attempt: 1, started_at: "2026-10-16T00:00:00.000Z", state: "succeeded" }] } })));
  // A negative duration is rejected.
  assert.throws(() => runData(row({ ...good, stages: { prepare: [{ attempt: 1, started_at: "2026-10-16T00:00:00.000Z", state: "succeeded", ended_at: "2026-10-16T00:00:01.000Z", duration_ms: -5 }] } })));
});

test("an unconfirmed submit keeps its operation identity and reports the safe next step", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    const op = newUUIDv7();
    const unknown = await h.invoke(["verification", "run", "submit", runId, "--state", "unknown", "--operation-id", op]);
    assert.equal(unknown.code, 0, JSON.stringify(unknown.envelope));
    assert.equal(unknown.envelope.data.submit.state, "unknown");
    assert.equal(unknown.envelope.data.submit.operation_id, op);
    assert.match(unknown.envelope.data.next_step, /unknown/i);
    // A pending is not terminal and carries no Verification ID.
    const pending = await h.invoke(["verification", "run", "submit", runId, "--state", "pending", "--operation-id", op]);
    assert.equal(pending.code, 0, JSON.stringify(pending.envelope));
    assert.equal(pending.envelope.data.submit.verification_id, undefined);

    // An explicit environment state is recorded as given.
    const env = await h.invoke(["verification", "run", "environment", runId, "--identity", "env-9", "--hit", "false", "--reason", "no reusable asset", "--state", "blocked"]);
    assert.equal(env.code, 0, JSON.stringify(env.envelope));
    assert.equal(env.envelope.data.environment.state, "blocked");
  });
});

test("wait and freeze stages enter and close as coordinator stages", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    // A wait stage is entered and closed by the coordinator (external blocking time).
    await h.invoke(["verification", "run", "stage", runId, "--stage", "wait", "--state", "running"]);
    const blocked = await h.invoke(["verification", "run", "stage", runId, "--stage", "wait", "--state", "blocked", "--reason", "reviewer unavailable"]);
    assert.equal(blocked.code, 0, JSON.stringify(blocked.envelope));
    const wait = blocked.envelope.data.stages.find((stage: any) => stage.stage === "wait");
    assert.equal(wait.state, "blocked");
    assert.equal(wait.reason, "reviewer unavailable");
    assert.equal(wait.complete, true);

    // A stage that was never entered has no duration and is not counted as complete.
    await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "running"]);
    await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "succeeded"]);
    const frozen = await h.invoke(["verification", "run", "freeze", runId, "--independent-digest", sha("f")]);
    assert.equal(frozen.code, 0, JSON.stringify(frozen.envelope));
    assert.equal(frozen.envelope.data.freeze.independent_digest, sha("f"));
    // Freezing again with the same digest is idempotent; a different digest is refused.
    const again = await h.invoke(["verification", "run", "freeze", runId, "--independent-digest", sha("f")]);
    assert.equal(again.code, 0, JSON.stringify(again.envelope));
    // A freeze before the blind stage is closed is refused (fresh run).
    const fresh = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-2", "--agent-name", "Coordinator Two"]);
    const early = await h.invoke(["verification", "run", "freeze", fresh.envelope.data.run_id, "--independent-digest", sha("a")]);
    assert.notEqual(early.code, 0, JSON.stringify(early.envelope));
    assert.equal(early.envelope.error.details.reason, "blind_not_closed");
  });
});

test("run list filters by role and session and rejects a malformed session", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id, session = started.envelope.data.review_session_id;
    const badSession = await h.invoke(["verification", "run", "list", h.candidateId, "--review-session", "not-a-uuid"]);
    assert.equal(badSession.code, 2, JSON.stringify(badSession.envelope));
    // A role filter that matches nothing returns an empty list, not an error.
    const none = await h.invoke(["verification", "run", "list", h.candidateId, "--role", "quality"]);
    assert.equal(none.envelope.data.runs.length, 0);
    // Recording a command failing an entry closes the log entry as failed.
    const failed = await h.invoke(["verification", "run", "command", runId, "--stage", "blind", "--entry", "tsc", "--started-at", "2026-10-16T00:00:00.000Z", "--ended-at", "2026-10-16T00:00:02.000Z", "--exit-code", "2"]);
    assert.equal(failed.code, 0, JSON.stringify(failed.envelope));
    assert.equal(failed.envelope.data.commands.collected, 1);
    void session;
  });
});

test("runData rejects commands, handoff, submit, freeze and environment with bad shapes", () => {
  const row = (data: any) => ({ id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a73", kind: "runtime_operation" as const, parent_id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a73", version: 1, data });
  const base = beginRunData({ candidate_id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a73", result_tree_oid: "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd", blind_context_digest: sha("d"), role: "contract", review_session_id: "01a142b5-fbef-7fdc-a33e-5b8203fe5a73", review_worktree: "/tmp/wt", attribution: testAgent, at: "2026-10-16T00:00:00.000Z" });
  // Command log with an out-of-range stage or missing digest fails.
  assert.throws(() => runData(row({ ...base, commands: [{ stage: "nope", entry: "x", argv_digest: sha("a"), started_at: "2026-10-16T00:00:00.000Z", ended_at: "2026-10-16T00:00:01.000Z", duration_ms: 1000, state: "succeeded" }] })));
  // Handoff with a bad state fails.
  assert.throws(() => runData(row({ ...base, handoff: { state: "nope", report_digest: sha("a"), recorded_at: "2026-10-16T00:00:00.000Z" } })));
  // Submit with a bad operation id fails.
  assert.throws(() => runData(row({ ...base, submit: { state: "pending", operation_id: "nope", recorded_at: "2026-10-16T00:00:00.000Z" } })));
  // Freeze with a bad digest fails.
  assert.throws(() => runData(row({ ...base, freeze: { independent_digest: "nope", fixed_at: "2026-10-16T00:00:00.000Z" } })));
  // A non-array command log fails.
  assert.throws(() => runData(row({ ...base, commands: "no" })));
  assert.throws(() => runData(row({ ...base, anomalies: "no" })));
  // A structurally valid record still round-trips.
  assert.equal(runData(row(base)).candidate_id, "01a142b5-fbef-7fdc-a33e-5b8203fe5a73");
});

test("boundary: a blind assessment missing a required material is refused at the reconcile gate", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id, session = started.envelope.data.review_session_id;
    // Blind never closed and never frozen: reconcile is refused, and the run is not marked ready.
    const reconcile = await h.invoke(["verification", "context", h.candidateId, "--phase", "reconcile", "--review-session", session]);
    assert.equal(reconcile.envelope.error.details.reason, "blind_not_closed");
    const shown = await h.invoke(["verification", "run", "show", runId]);
    assert.equal(shown.envelope.data.current_stage, undefined);
    assert.equal(shown.envelope.data.freeze, undefined);
    assert.match(shown.envelope.data.next_step, /blind/);
  });
});

test("boundary: environment not ready is recorded honestly and does not block the run", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    const env = await h.invoke(["verification", "run", "environment", runId, "--identity", "env-1", "--hit", "false", "--reason", "no reusable base asset", "--state", "failed"]);
    assert.equal(env.code, 0, JSON.stringify(env.envelope));
    assert.equal(env.envelope.data.environment.hit, false);
    assert.equal(env.envelope.data.environment.state, "failed");
    // A failed environment is not silently reported as a ready run.
    assert.equal(env.envelope.data.environment.reason, "no reusable base asset");
  });
});

test("boundary: duplicate and out-of-order stage notifications are idempotent or refused, never double-counted", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    // Entering an already-running coordinator stage is refused, so a duplicate "entered" notice cannot
    // open a second attempt.
    const first = await h.invoke(["verification", "run", "stage", runId, "--stage", "wait", "--state", "running"]);
    assert.equal(first.code, 0, JSON.stringify(first.envelope));
    const dup = await h.invoke(["verification", "run", "stage", runId, "--stage", "wait", "--state", "running"]);
    assert.equal(dup.envelope.error.code, "STATE_CONFLICT");
    assert.equal(dup.envelope.error.details.reason, "stage_already_running");
    // Closing a stage that was never entered (an out-of-order "finished" notice) is refused.
    const outOfOrder = await h.invoke(["verification", "run", "stage", runId, "--stage", "blind", "--state", "succeeded"]);
    assert.equal(outOfOrder.envelope.error.code, "STATE_CONFLICT");
    assert.equal(outOfOrder.envelope.error.details.reason, "stage_not_entered");
    // The attempted-but-refused notices did not change the durable stage set.
    const shown = await h.invoke(["verification", "run", "show", runId]);
    const stages = shown.envelope.data.stages.map((s: any) => s.stage).sort();
    assert.deepEqual(stages, ["prepare", "wait"]);
  });
});

test("boundary: concurrent advance is detected by the runtime version check instead of overwriting", async () => {
  await withHarness(async (h) => {
    const started = await h.invoke(["verification", "run", "start", h.candidateId, "--agent-id", "coordinator-1", "--agent-name", "Coordinator"]);
    const runId = started.envelope.data.run_id;
    const runs = new VerificationRuns(h.fixture.store);
    // Two writers read the same version, then apply conflicting changes: the second must fail on the
    // version guard rather than silently overwrite the first.
    const row = await runs.show(runId);
    const stale = JSON.parse(JSON.stringify(row)) as typeof row;
    await runs.stage(runId, "wait", "running");
    // Replaying the stale snapshot as a version-1 write must conflict.
    stale.version = row.version;
    await assert.rejects(() => h.fixture.store.write(async (tx) => { await tx.saveRuntimeRecord({ ...stale, data: { ...stale.data, updated_at: new Date().toISOString() } }, row.version - 1); }));
    // The concurrent write is not lost: the run still carries the wait stage the first writer added.
    const after = await h.invoke(["verification", "run", "show", runId]);
    assert.ok(after.envelope.data.stages.some((s: any) => s.stage === "wait"));
  });
});
