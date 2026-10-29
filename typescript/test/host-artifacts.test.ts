import { repositoryDataRoot } from "../src/data-layout.js";
import { captureCommittedCandidate, retainCandidateSource } from '../src/development-branch.js';
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execute, runCLI } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { assertReviewWorktreeCandidateArtifact, captureArtifact, readReviewWorktreeMarker } from "../src/git.js";
import { newUUIDv7, isUUIDv7 } from "../src/identity.js";
import { SCHEMA_VERSION, SQLStore } from "../src/sql-store.js";
import type { CandidateSubmissionV2Input } from "../src/domain.js";
import { ReviewSessions } from "../src/review-session.js";
import { countEntries } from "../src/worktree-removal.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-host-artifacts-")));
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

const events = (w: World, type: string): any[] => {
  const database = new DatabaseSync(w.db);
  try { return database.prepare("SELECT * FROM ledger_events WHERE event_type = ? ORDER BY event_seq").all(type) as any[]; } finally { database.close(); }
};
/** Independent of the implementation: files, directories and symbolic links below the root, root excluded. */
const countBelow = (root: string): number => execFileSync("find", [root, "-mindepth", "1", "(", "-type", "f", "-o", "-type", "d", "-o", "-type", "l", ")"], { encoding: "utf8" }).split("\n").filter(Boolean).length;
const abandoned = async (w: World) => {
  const run = await w.startRun();
  const result = await w.invoke(["devrun", "abandon", run.id, "--expected-version", "1"]);
  assert.equal(result.code, 0, JSON.stringify(result.envelope));
  return run;
};

test("cleanup appends one removal event with a registered operation and a matching summary", async () => {
  const w = await world();
  try {
    const run = await abandoned(w);
    const expectedEntries = countBelow(run.path);
    const op = newUUIDv7();
    const removed = await w.invoke(["devrun", "cleanup", run.id, "--operation-id", op, "--agent-id", "dev-1", "--agent-name", "Dev One"]);
    assert.equal(removed.code, 0, JSON.stringify(removed.envelope));
    const data = removed.envelope.data;
    assert.equal(data.removed, true);
    const summary = data.deletion_summary;
    assert.deepEqual(Object.keys(summary).sort(), ["dev_run_id", "discard_changes", "entry_count", "occurred_at", "worktree_path"]);
    assert.equal(summary.dev_run_id, run.id); assert.equal(summary.discard_changes, false); assert.equal(summary.entry_count, expectedEntries);
    assert.equal(realpathSync(join(summary.worktree_path, "..")), realpathSync(join(run.path, "..")));
    assert.equal(existsSync(run.path), false);

    const rows = events(w, "devrun.worktree_removed");
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.event_version, 1); assert.equal(row.subject_type, "dev_run"); assert.equal(row.subject_id, run.id); assert.equal(row.operation_id, op);
    assert.deepEqual(JSON.parse(row.facts_json), { dev_run_id: run.id, worktree_path: summary.worktree_path, discard_changes: "false", entry_count: String(expectedEntries) });
    assert.equal(row.occurred_at, summary.occurred_at);
    assert.deepEqual(JSON.parse(row.attribution_json), { kind: "agent", agent_id: "dev-1", display_name: "Dev One" });
    assert.equal(Object.keys(JSON.parse(row.facts_json)).some((key) => ["occurred_at", "attribution"].includes(key)), false);
    const database = new DatabaseSync(w.db);
    try { assert.equal((database.prepare("SELECT count(*) AS n FROM idempotency_records WHERE operation_id = ?").get(op) as any).n, 1); assert.equal((database.prepare("SELECT schema_version FROM schema_metadata").get() as any).schema_version, SCHEMA_VERSION); } finally { database.close(); }

    // Same operation id: identical result, still one event.
    const replay = await w.invoke(["devrun", "cleanup", run.id, "--operation-id", op, "--agent-id", "dev-1", "--agent-name", "Dev One"]);
    assert.equal(replay.code, 0, JSON.stringify(replay.envelope));
    assert.deepEqual(replay.envelope.data.deletion_summary, summary);
    // A new operation on the already removed worktree reports removed:false and adds nothing.
    const again = await w.invoke(["devrun", "cleanup", run.id]);
    assert.equal(again.code, 0); assert.equal(again.envelope.data.removed, false); assert.equal("deletion_summary" in again.envelope.data, false);
    assert.equal(events(w, "devrun.worktree_removed").length, 1);
    // The ledger read model and reconcile keep their previous shape.
    const reconcile = await w.invoke(["devrun", "reconcile", run.id]);
    assert.equal(reconcile.envelope.data.overall, "consistent"); assert.deepEqual(reconcile.envelope.data.findings, []);
    const listed = await w.invoke(["ledger", "list", "--subject-type", "dev_run", "--subject-id", run.id]);
    assert.deepEqual(listed.envelope.data.events.map((event: any) => event.event_type), ["devrun.started", "devrun.abandoned", "devrun.worktree_removed"]);
  } finally { await w.close(); }
});

test("a refused cleanup writes no event and a retry with --discard-changes records the discard", async () => {
  const w = await world();
  try {
    const run = await w.startRun();
    writeFileSync(join(run.path, "file.txt"), "local only\n");
    assert.equal((await w.invoke(["devrun", "abandon", run.id, "--expected-version", "1"])).code, 0);
    const blocked = await w.invoke(["devrun", "cleanup", run.id]);
    assert.notEqual(blocked.code, 0); assert.equal(existsSync(run.path), true);
    assert.equal(events(w, "devrun.worktree_removed").length, 0);
    assert.equal(existsSync(join(repositoryDataRoot(w.repo), "devruns", run.id, "removal-receipt.json")), false);
    const discarded = await w.invoke(["devrun", "cleanup", run.id, "--discard-changes"]);
    assert.equal(discarded.code, 0); assert.equal(discarded.envelope.data.deletion_summary.discard_changes, true);
    assert.equal(events(w, "devrun.worktree_removed").length, 1);
  } finally { await w.close(); }
});

test("reusing a removal operation id reports a schema-valid conflict, not an empty request hash", async () => {
  const w = await world();
  try {
    // Record a removal under a specific operation id.
    const first = await abandoned(w);
    const op = newUUIDv7();
    const removed = await w.invoke(["devrun", "cleanup", first.id, "--operation-id", op]);
    assert.equal(removed.code, 0, JSON.stringify(removed.envelope));

    // The same operation id on a different DevRun must conflict. The lookup is
    // read-only and has no request hash of its own, but the error contract still
    // requires sha256-shaped request_hash / existing_request_hash fields.
    const second = await abandoned(w);
    const conflict = await w.invoke(["devrun", "cleanup", second.id, "--operation-id", op]);
    assert.equal(conflict.code, 4, JSON.stringify(conflict.envelope));
    assert.equal(conflict.envelope.error.code, "IDEMPOTENCY_CONFLICT");
    assert.match(conflict.envelope.error.details.request_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(conflict.envelope.error.details.existing_request_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(existsSync(second.path), true);
    assert.equal(events(w, "devrun.worktree_removed").length, 1);

    // An operation id that belongs to another command conflicts the same way.
    const third = await w.startRun();
    const foreignOp = newUUIDv7();
    assert.equal((await w.invoke(["devrun", "abandon", third.id, "--expected-version", "1", "--operation-id", foreignOp])).code, 0);
    const foreign = await w.invoke(["devrun", "cleanup", third.id, "--operation-id", foreignOp]);
    assert.equal(foreign.code, 4, JSON.stringify(foreign.envelope));
    assert.equal(foreign.envelope.error.code, "IDEMPOTENCY_CONFLICT");
    assert.match(foreign.envelope.error.details.existing_request_hash, /^sha256:[0-9a-f]{64}$/);
  } finally { await w.close(); }
});

test("cleanup of a DevRun whose local state claims an unfinished sync is refused and writes neither a receipt nor an event", async () => {
  const w = await world();
  try {
    const run = await abandoned(w);
    for (const lifecycle of ["syncing", "sync_interrupted"]) {
      const statePath = join(repositoryDataRoot(w.repo), "devruns", run.id, "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      writeFileSync(statePath, JSON.stringify({ ...state, lifecycle, sync_id: newUUIDv7() }, null, 2));
      const refused = await w.invoke(["devrun", "cleanup", run.id]);
      assert.notEqual(refused.code, 0, lifecycle); assert.equal(refused.envelope.error.code, "WORKTREE_MISMATCH", lifecycle);
      // The journal is synthetic (no recovery directory), so the refusal may come from any of the pre-existing checks; none may write.
      assert.equal(existsSync(run.path), true, lifecycle);
      assert.equal(existsSync(join(repositoryDataRoot(w.repo), "devruns", run.id, "removal-receipt.json")), false, lifecycle);
      assert.equal(events(w, "devrun.worktree_removed").length, 0, lifecycle);
    }
  } finally { await w.close(); }
});

test("a cleanup interrupted after deletion is completed by the next cleanup without a second event", async () => {
  const w = await world();
  try {
    const run = await abandoned(w);
    const op = newUUIDv7();
    // First attempt removes the files and stops before the ledger write.
    const local = await new DevWorktreeModule(w.repo, w.databaseID, newUUIDv7, w.f.store, join(w.root, "registry")).cleanup(run.id, "abandoned", false, undefined, { operation_id: op, attribution: testAgent });
    assert.equal(local.removed, true); assert.equal(events(w, "devrun.worktree_removed").length, 0);
    const retry = await w.invoke(["devrun", "cleanup", run.id]);
    assert.equal(retry.code, 0, JSON.stringify(retry.envelope));
    assert.equal(retry.envelope.data.removed, true); assert.equal(retry.envelope.data.deletion_summary.dev_run_id, run.id);
    const rows = events(w, "devrun.worktree_removed");
    assert.equal(rows.length, 1); assert.equal(rows[0].operation_id, op);
    assert.equal(JSON.parse(rows[0].attribution_json).agent_id, testAgent.agent_id);
    const later = await w.invoke(["devrun", "cleanup", run.id]);
    assert.equal(later.envelope.data.removed, false); assert.equal(events(w, "devrun.worktree_removed").length, 1);
  } finally { await w.close(); }
});

test("two concurrent cleanups of one DevRun delete once and record one event", async () => {
  const w = await world();
  try {
    const run = await abandoned(w);
    const results = await Promise.all([w.invoke(["devrun", "cleanup", run.id]), w.invoke(["devrun", "cleanup", run.id])]);
    for (const result of results) assert.equal(result.code, 0, JSON.stringify(result.envelope));
    assert.equal(results.filter((result) => result.envelope.data.removed === true).length, 1);
    assert.equal(results.filter((result) => "deletion_summary" in result.envelope.data).length, 1);
    assert.equal(events(w, "devrun.worktree_removed").length, 1);
  } finally { await w.close(); }
});

/** A world with one submitted Candidate and its expected result tree. */
const withCandidate = async (check: (w: World, candidate: string, tree: string) => Promise<void>): Promise<void> => {
  const w = await world();
  try {
    const run = await w.startRun();
    writeFileSync(join(run.path, "file.txt"), "after\n");
    const candidate = await w.submit(run.id);
    await check(w, candidate, captureArtifact(run.path, w.baseline).result_tree_oid);
  } finally { await w.close(); }
};
const materializeReview = async (w: World, candidate: string) => {
  const result = await w.invoke(["candidate", "materialize", candidate, "--mode", "review"]);
  assert.equal(result.code, 0, JSON.stringify(result.envelope));
  return result.envelope.data as { review_session_id: string; target_path: string };
};
const sessionDirectoryOf = (w: World, candidate: string, sessionID: string): string => join(repositoryDataRoot(realpathSync(w.repo)), "reviews", candidate, sessionID);

test("review sessions: a CLI-named directory per verifier, with the worktree below it", () => withCandidate(async (w, candidate) => {
  assert.equal((await w.invoke(["candidate", "materialize", candidate, "--mode", "delivery"])).code, 2);
  const one = await materializeReview(w, candidate);
  assert.ok(isUUIDv7(one.review_session_id));
  const directory = sessionDirectoryOf(w, candidate, one.review_session_id);
  assert.equal(realpathSync(one.target_path), join(directory, "worktree"));
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const two = await materializeReview(w, candidate);
  assert.notEqual(two.review_session_id, one.review_session_id);
  assert.equal(existsSync(one.target_path) && existsSync(two.target_path), true);

  // Explicit --path is unchanged and creates no session; an existing target is still refused.
  const sessionsBefore = readdirSync(join(repositoryDataRoot(w.repo), "reviews", candidate)).length;
  const explicitPath = join(w.root, "chosen-review");
  const chosen = await w.invoke(["candidate", "materialize", candidate, "--mode", "review", "--path", explicitPath]);
  assert.equal(chosen.code, 0, JSON.stringify(chosen.envelope)); assert.equal("review_session_id" in chosen.envelope.data, false);
  assert.equal(realpathSync(chosen.envelope.data.target_path), realpathSync(explicitPath));
  assert.equal(readdirSync(join(repositoryDataRoot(w.repo), "reviews", candidate)).length, sessionsBefore);
  assert.equal((await w.invoke(["candidate", "materialize", candidate, "--mode", "review", "--path", explicitPath])).code, 2);
}));

test("review session material: one fixed file per phase and role, never inside the verified tree", () => withCandidate(async (w, candidate, tree) => {
  const one = await materializeReview(w, candidate), two = await materializeReview(w, candidate);
  const directory = sessionDirectoryOf(w, candidate, one.review_session_id);

  const context = await w.invoke(["verification", "context", candidate, "--phase", "blind", "--review-session", one.review_session_id]);
  assert.equal(context.code, 0, JSON.stringify(context.envelope));
  const contextFile = join(directory, "context-blind-contract.json");
  assert.equal(realpathSync(context.envelope.data.output_path), contextFile);
  assert.deepEqual(JSON.parse(readFileSync(contextFile, "utf8")), context.envelope.data.context);
  assert.equal(statSync(contextFile).mode & 0o777, 0o600);

  // Writing material leaves the verified tree untouched: same result tree, no untracked file, integrity check still passes.
  assert.equal(captureArtifact(one.target_path, w.baseline).result_tree_oid, tree);
  assert.deepEqual(git(one.target_path, "status", "--porcelain=v1", "--untracked-files=all").split("\n").filter((line) => line.startsWith("??")), []);
  const marker = readReviewWorktreeMarker(one.target_path);
  assert.ok(marker); assert.doesNotThrow(() => assertReviewWorktreeCandidateArtifact(one.target_path, marker!));

  // Every phase and role has its own file name; nothing is overwritten.
  for (const [phase, role] of [["blind", "quality"], ["reconcile", "contract"], ["reconcile", "quality"]] as const) {
    const written = await w.invoke(["verification", "context", candidate, "--phase", phase, "--role", role, "--review-session", one.review_session_id]);
    assert.equal(written.code, 0, `${phase}/${role}: ${JSON.stringify(written.envelope)}`);
    assert.equal(realpathSync(written.envelope.data.output_path), join(directory, `context-${phase}-${role}.json`));
    assert.deepEqual(JSON.parse(readFileSync(written.envelope.data.output_path, "utf8")), written.envelope.data.context);
  }
  assert.equal(readdirSync(directory).sort().join(","), "context-blind-contract.json,context-blind-quality.json,context-reconcile-contract.json,context-reconcile-quality.json,worktree");

  // A quality handoff lands in that verifier's own session, beside its own context.
  const report = (await w.f.module.verificationReportTemplate(candidate, undefined, "quality")).report as any;
  for (const dimension of report.dimensions) {
    dimension.independent = { verdict: "qualified", explanation: "Blind judgement", findings: [], evidence: [] };
    dimension.reconciliation = { explanation: "Unchanged" };
    dimension.final = { verdict: "qualified", explanation: "Final judgement", findings: [] };
  }
  const reportFile = join(w.root, "quality-report.json"); writeFileSync(reportFile, JSON.stringify(report));
  await w.invoke(["verification", "context", candidate, "--phase", "blind", "--role", "quality", "--review-session", two.review_session_id]);
  const lines: string[] = [];
  const code = await runCLI(["verification", "handoff", "--file", reportFile, "--agent-id", "qr-1", "--agent-name", "QR", "--review-session", two.review_session_id, "--json"], { cwd: w.repo, stdout: (line) => lines.push(line), stderr: () => {} });
  const handoff = JSON.parse(lines[0]);
  assert.equal(code, 0, JSON.stringify(handoff)); assertContract("command-results.schema.json", handoff.data);
  const secondDirectory = sessionDirectoryOf(w, candidate, two.review_session_id);
  assert.equal(realpathSync(handoff.data.output_path), join(secondDirectory, "handoff-quality.json"));
  assert.equal(readdirSync(secondDirectory).sort().join(","), "context-blind-quality.json,handoff-quality.json,worktree");
}));

test("review session options: --out writes a file, no option prints only, bad combinations are refused", () => withCandidate(async (w, candidate) => {
  const session = await materializeReview(w, candidate);
  const out = join(w.root, "elsewhere", "ctx.json");
  const explicit = await w.invoke(["verification", "context", candidate, "--out", out]);
  assert.equal(explicit.code, 0); assert.equal(explicit.envelope.data.output_path, out);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), explicit.envelope.data.context);
  assert.equal("output_path" in (await w.invoke(["verification", "context", candidate])).envelope.data, false);
  assert.equal((await w.invoke(["verification", "context", candidate, "--out", out, "--review-session", session.review_session_id])).code, 2);
  assert.equal((await w.invoke(["verification", "context", candidate, "--review-session", newUUIDv7()])).code, 2);
  assert.equal((await w.invoke(["verification", "context", candidate, "--review-session", "not-a-session"])).code, 2);
}));

test("handoff writes the signed object into its review session and refuses unknown sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-handoff-session-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const candidate = newUUIDv7();
    const sessions = new ReviewSessions(realpathSync(root));
    const session = sessions.allocate(candidate);
    const report = { format: "patchledger.verification-report/v1", candidate_id: candidate, result_tree_oid: `sha1:${"1".repeat(40)}`, blind_context_digest: `sha256:${"2".repeat(64)}`, assessments: [{ target_type: "goal", target_id: newUUIDv7(), criteria: [{ criterion_id: newUUIDv7(), independent: { verdict: "qualified", explanation: "independent evidence", evidence: [] }, reconciliation: { claim_relation: "corroborated", explanation: "claim agrees" }, final: { verdict: "qualified", explanation: "qualified" } }] }] };
    const file = join(root, "report.json"); writeFileSync(file, JSON.stringify(report));
    const run = async (extra: string[]) => { const lines: string[] = []; const code = await runCLI(["verification", "handoff", "--file", file, "--agent-id", "verifier-1", "--agent-name", "Verifier One", ...extra, "--json"], { cwd: root, stdout: (line) => lines.push(line), stderr: () => {} }); return { code, envelope: JSON.parse(lines[0]) }; };
    const written = await run(["--review-session", session.session_id]);
    assert.equal(written.code, 0, JSON.stringify(written.envelope));
    const expected = join(session.directory, "handoff-contract.json");
    assert.equal(written.envelope.data.output_path, expected); assertContract("command-results.schema.json", written.envelope.data);
    assert.deepEqual(JSON.parse(readFileSync(expected, "utf8")), written.envelope.data.handoff);
    assert.equal(statSync(expected).mode & 0o777, 0o600);
    const explicitFile = join(root, "elsewhere", "handoff.json");
    const explicit = await run(["--out", explicitFile]);
    assert.equal(explicit.code, 0, JSON.stringify(explicit.envelope)); assert.equal(explicit.envelope.data.output_path, explicitFile);
    assert.deepEqual(JSON.parse(readFileSync(explicitFile, "utf8")), explicit.envelope.data.handoff);
    assert.equal((await run(["--review-session", newUUIDv7()])).code, 2);
    assert.equal((await run(["--out", join(root, "x.json"), "--review-session", session.session_id])).code, 2);
    const plain = await run([]);
    assert.equal("output_path" in plain.envelope.data, false);
    assert.equal(lstatSync(repositoryDataRoot(root)).isDirectory(), true);
    assert.match(readFileSync(join(root, ".git", "info", "exclude"), "utf8"), /^\/\.grounds\/\*$/m);
    assert.match(readFileSync(join(root, ".git", "info", "exclude"), "utf8"), /^!\/\.grounds\/environments\/$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removal entry counting covers files, directories and symbolic links without following links", () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-count-")), outside = mkdtempSync(join(tmpdir(), "grounds-count-outside-"));
  try {
    mkdirSync(join(root, "a")); writeFileSync(join(root, "a", "file"), "x"); mkdirSync(join(root, "empty"));
    writeFileSync(join(outside, "elsewhere"), "y"); symlinkSync(outside, join(root, "link-to-directory")); symlinkSync(join(root, "a", "file"), join(root, "link-to-file"));
    // a, a/file, empty, link-to-directory, link-to-file; the linked directory's own content is not counted and the root is excluded.
    assert.equal(countEntries(root), 5);
    assert.equal(countEntries(outside), 1);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("a review session directory is discarded only below the reviews root", () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-discard-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const sessions = new ReviewSessions(realpathSync(root));
    const session = sessions.allocate(newUUIDv7());
    assert.equal(existsSync(session.directory), true);
    sessions.discard(session.directory);
    assert.equal(existsSync(session.directory), false);
    const outside = join(root, "not-a-session"); mkdirSync(outside);
    sessions.discard(outside);
    assert.equal(existsSync(outside), true, "paths outside .grounds/reviews are never removed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
