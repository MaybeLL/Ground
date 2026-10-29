import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitLabAPIFixture, defaultTagRules } from "./gitlab-api-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCLI, commandNeedsOperationID, parseArgs } from "../src/cli.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { resolveBaseline } from "../src/git.js";
import { deriveLocalGitArtifact } from "../src/git-artifact-local.js";
import { receiveDevelopmentObjects, receiveDevelopmentSource, captureCommittedDevelopment } from "../src/development-branch.js";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { Module } from "../src/module.js";
import { PreflightService } from "../src/preflight.js";
import { reviseTargetIssue } from "./preflight-fixture.js";
import { SQLStore } from "../src/sql-store.js";
import { CandidateArchiveService } from "../src/candidate-archive-service.js";
import { newUUIDv7 } from "../src/identity.js";
import { sha256 } from "../src/canonical-json.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trimEnd();
const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });

test("GitLab onboarding: public binding, Developer candidate/landing archives, drift recovery and immutable tags", async t => {
  const api = await gitLabAPIFixture(); t.after(() => api.close());
  t.after(() => { if (process.env.GROUNDS_ARCHIVE_TEST_TRANSCRIPT) writeFileSync(process.env.GROUNDS_ARCHIVE_TEST_TRANSCRIPT, JSON.stringify(api.transcript, null, 2)); });
  const original = { instance: process.env.GROUNDS_GITLAB_INSTANCE, token: process.env.GROUNDS_GITLAB_TOKEN, policy: process.env.GROUNDS_ARCHIVE_POLICY };
  t.after(() => {
    for (const [key, value] of Object.entries({ GROUNDS_GITLAB_INSTANCE: original.instance, GROUNDS_GITLAB_TOKEN: original.token, GROUNDS_ARCHIVE_POLICY: original.policy })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  process.env.GROUNDS_GITLAB_INSTANCE = api.instance; process.env.GROUNDS_GITLAB_TOKEN = "fixture-developer"; delete process.env.GROUNDS_ARCHIVE_POLICY;
  const x = await fixture(t, "ssh://git@127.0.0.1/team/repo"), id = x.f.repository.repository_id;
  const unbound = await x.invoke("repository", "archive-show", "--repository", id); assert.equal(unbound.status.state, "unbound");
  const guide = await x.invoke("repository", "archive-guide", "--repository", id, "--instance", api.instance);
  assert.equal(guide.projects[0].report.state, "unbound"); assert.equal(guide.projects[0].guide.namespaces.length, 2);
  const binding = await x.invoke("repository", "archive-bind", "--repository", id, "--instance", api.instance, "--expected-version", "0", "--operation-id", newUUIDv7());
  assert.equal(binding.report.state, "ready"); assert.equal(binding.binding.project_id, 101);
  assert.equal((await x.invoke("db", "status")).integrity.valid, true);
  assert.ok(!JSON.stringify(binding).includes("fixture-developer")); assert.ok(!JSON.stringify(binding.binding).includes(x.root));
  const check = await x.invoke("repository", "archive-check", "--repository", id, "--repository", newUUIDv7());
  assert.deepEqual(check.summary, { selected: 2, ready: 1, requires_attention: 1 }); assert.ok(check.projects[1].error);
  const run = await x.start(); commit(run.path, "feature", "GitLab-bound Developer change\n"); const form = await x.submission(run), operation = newUUIDv7();
  const project = api.projects.get("team/repo")!;
  project.rules = defaultTagRules().map(rule => ({ ...rule, create_access_levels: [{ access_level: 40, access_level_description: "Maintainers" }] }));
  const denied = await x.rawAt(x.cwd, "candidate", "submit", "--dev-run", run.id, "--expected-version", "1", "--file", form.file, "--operation-id", operation);
  assert.equal(denied.exit, 4); assert.equal(denied.envelope.error.details.protection_diagnosis.state, "permission_denied");
  const reserved = (await x.invoke("candidate", "archive-operation", "--operation-id", operation)).operation.data;
  assert.throws(() => git(x.remote, "rev-parse", reserved.binding.archive_ref));
  project.rules = defaultTagRules();
  const candidate = await x.invoke("candidate", "submit", "--dev-run", run.id, "--expected-version", "1", "--file", form.file, "--operation-id", operation);
  assert.equal(candidate.candidate_id, reserved.candidate_id);
  const source = candidate.source.commit, candidateRef = reserved.binding.archive_ref;
  const archive = await x.invoke("candidate", "archive-operation", "--operation-id", operation);
  assert.equal(archive.operation.data.receipt.protection.source.kind, "platform-api");
  assert.match(archive.operation.data.receipt.protection.source.locator, /\/projects\/101\/protected_tags$/);
  const replacement = execFileSync("git", ["commit-tree", `${source.slice(5)}^{tree}`, "-p", source.slice(5), "-m", "conflicting immutable archive identity"], { cwd: x.cwd, encoding: "utf8" }).trim();
  assert.throws(() => git(x.cwd, "push", "--force", x.remote, `${replacement}:${candidateRef}`));
  assert.throws(() => git(x.cwd, "push", x.remote, `:${candidateRef}`));
  assert.equal(git(x.remote, "rev-parse", candidateRef), source.slice(5));
  const selection = await x.invoke("selection", "set", "--issue", x.f.issue.issue_id, "--issue-version", "2", "--candidate", candidate.candidate_id, "--expected-version", "0", "--reason", "Explicit temporary fixture selection");
  git(x.cwd, "push", x.remote, `${source.slice(5)}:refs/heads/feature`);
  const observed = await x.invoke("integration", "observe", "--candidate", candidate.candidate_id, "--selection", selection.selection.id, "--selection-version", "1", "--source-remote", "origin", "--source-ref", "refs/heads/feature", "--source-commit", source, "--refresh", "--operation-id", newUUIDv7());
  git(x.cwd, "merge", "--no-ff", source.slice(5), "-m", "fixture landing"); const landed = resolveBaseline(x.cwd, "HEAD"); git(x.cwd, "push", x.remote, "HEAD:refs/heads/main");
  const adoption = join(x.root, "gitlab-adoption.json");
  writeFileSync(adoption, JSON.stringify({ format: "grounds.adoption-binding/v1", repository_id: id, candidate_id: candidate.candidate_id, source_commit: source, landed_commit: landed, target: { remote: "origin", ref: "refs/heads/main" }, method: "merge", source: { kind: "user_confirmation", reference: "Isolated target merge explicitly confirmed" } }));
  const args = ["integration", "landing", "--observation", observed.record.id, "--commit", source, "--provenance", "user", "--adoption-file", adoption, "--refresh", "--operation-id", newUUIDv7()];
  project.rules = [defaultTagRules()[0]!];
  const pending = await x.invoke(...args); assert.equal(pending.record.landing.actual_landing.oid, landed); assert.equal(pending.landing_archive.status, "unknown");
  assert.equal(pending.landing_archive.protection_diagnosis.state, "needs_configuration", JSON.stringify(pending.landing_archive));
  project.rules = defaultTagRules();
  const completed = await x.invoke(...args); assert.deepEqual(completed.record, pending.record); assert.equal(completed.landing_archive.status, "confirmed");
  assert.equal(git(x.remote, "rev-parse", `refs/tags/grounds/deliveries/${completed.record.id}`), landed.slice(5));
  assert.equal(git(x.remote, "rev-parse", candidateRef), source.slice(5));
  assert.ok(api.transcript.every(request => request.method === "GET"));
  assert.ok(api.transcript.some(request => request.actor === "developer" && request.path.startsWith("/projects/101/protected_tags")));
  if (process.env.GROUNDS_ARCHIVE_TEST_TRANSCRIPT) writeFileSync(process.env.GROUNDS_ARCHIVE_TEST_TRANSCRIPT, JSON.stringify(api.transcript, null, 2));
});
test("GitLab onboarding compatibility preserves literal rules and versioned group grants through public CLI", async t => {
  const api = await gitLabAPIFixture(); t.after(() => api.close());
  const original = { GROUNDS_GITLAB_INSTANCE: process.env.GROUNDS_GITLAB_INSTANCE, GROUNDS_GITLAB_TOKEN: process.env.GROUNDS_GITLAB_TOKEN, GROUNDS_ARCHIVE_POLICY: process.env.GROUNDS_ARCHIVE_POLICY };
  t.after(() => { for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.GROUNDS_GITLAB_INSTANCE = api.instance; process.env.GROUNDS_GITLAB_TOKEN = "fixture-maintainer"; delete process.env.GROUNDS_ARCHIVE_POLICY;
  const x = await fixture(t, "ssh://git@127.0.0.1/team/repo"), id = x.f.repository.repository_id;
  const project = api.projects.get("team/repo")!;
  project.rules = [{ name: "grounds/*", create_access_levels: [{ access_level: null, group_id: 9 }] },
    { name: "release]", create_access_levels: [{ access_level: 40 }] }];
  project.shared = [{ group_id: 9, group_access_level: 30 }];
  api.state.groups.set("/groups/9/members/12", { id: 12, access_level: 10 });
  const bound = await x.invoke("repository", "archive-bind", "--repository", id, "--instance", api.instance, "--expected-version", "0", "--operation-id", newUUIDv7());
  assert.equal(bound.report.state, "ready"); assert.equal(bound.report.actor.access_level, 40);
  api.state.version = "17.2.0-ee";
  const denied = await x.invoke("repository", "archive-check", "--repository", id);
  assert.equal(denied.projects[0].report.state, "permission_denied");
  api.state.groups.set("/groups/9/members/12", { id: 12, access_level: 30 });
  const repaired = await x.invoke("repository", "archive-check", "--repository", id);
  assert.equal(repaired.projects[0].report.state, "ready");
  assert.ok(api.transcript.every(item => item.method === "GET" && item.status === 200));
});

function commit(cwd: string, name: string, content: string) { writeFileSync(join(cwd, name), content); git(cwd, "add", "-A"); git(cwd, "commit", "-qm", name); }
async function fixture(t: { after(f: () => void | Promise<void>): void }, canonicalRemote = "ssh://git@example.test/team/repo") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-archive-cli-"))), cwd = join(root, "author"), remote = join(root, "remote.git"), databasePath = join(root, "ledger.db");
  git(root, "init", "--bare", "-q", remote); git(root, "init", "-qb", "main", cwd);
  git(cwd, "config", "user.name", "Archive CLI Test"); git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "remote", "add", "origin", canonicalRemote);
  writeFileSync(join(cwd, ".gitignore"), ".grounds/*\n!.grounds/environments/\n"); commit(cwd, "file", "base\n"); git(cwd, "push", remote, "HEAD:refs/heads/main");
  const base = resolveBaseline(cwd, "HEAD"), f = await LedgerFixture.createWithStore(SQLStore.sqlite(databasePath));
  if (canonicalRemote !== f.repository.canonical_remote) Object.assign(f.repository, await f.module.moveRepository({ ...actor(), repository_id: f.repository.repository_id, expected_version: 1, canonical_remote: canonicalRemote }));
  const transport = archiveCLITransport(t, root, remote, f.repository.repository_id, canonicalRemote);
  git(cwd, "fetch", "origin");
  const publisher = new Module(f.store, newUUIDv7, undefined, undefined, new PreflightService(f.store, cwd).coordinator({ refresh: true }));
  const revised = await reviseTargetIssue(publisher, f.store, cwd, { ...actor(), issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: { git_oid: base, reachability: "remote_tracking_reachable" }, input: { format: 1, summary: "Archive CLI behavior", target_branch: { remote: "origin", ref: "refs/heads/main" }, goals: [{ statement: "Preserve archive identity", criteria: ["Original code and history are recoverable"] }] } });
  const database = (await f.store.inspect()).database_id, config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: databasePath, expected_database_id: database } }));
  f.store.setGitArtifactResolver(ref => deriveLocalGitArtifact(cwd, ref.git_artifact!.binding));
  async function rawAt(at: string, ...args: string[]) {
    const output: string[] = [];
    const argv = [...args, ...(args[0] === "env" ? [] : ["--config", config]), "--json", ...(commandNeedsOperationID(parseArgs(args)) ? ["--agent-id", "archive-cli-test", "--agent-name", "Archive CLI Test"] : [])];
    if (process.env.GROUNDS_ARCHIVE_TEST_CLI) {
      const home = join(root, "package-home"); mkdirSync(home, { recursive: true });
      try {
        const result = await promisify(execFile)(process.execPath, [process.env.GROUNDS_ARCHIVE_TEST_CLI, ...argv], { cwd: at, env: { ...process.env, HOME: home, GROUNDS_RUNTIME_HOME: join(root, "runtime") }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
        return { exit: 0, envelope: JSON.parse(result.stdout) };
      } catch (error: any) { return { exit: Number(error.code) || 1, envelope: JSON.parse(error.stdout) }; }
    }
    const exit = await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, () => runCLI(argv, { cwd: at, stdout: s => output.push(s), stderr: () => {} }));
    return { exit, envelope: JSON.parse(output.join("\n")) };
  }
  async function invokeAt(at: string, ...args: string[]) { const result = await rawAt(at, ...args); assert.equal(result.exit, 0, JSON.stringify(result.envelope)); assertContract("command-results.schema.json", result.envelope.data); return result.envelope.data; }
  const invoke = (...args: string[]) => invokeAt(cwd, ...args);
  // A target-flow refinement no longer starts directly: it restores the parent
  // Candidate through `devrun prepare`, then admits the actual restored inputs
  // before any substantive development. This mirrors the real CLI flow.
  async function admit(runId: string) {
    const observation = await invoke("preflight", "observe", "--phase", "start", "--dev-run", runId, "--refresh", "--operation-id", newUUIDv7());
    const file = join(root, `assessment-${runId}.json`);
    writeFileSync(file, JSON.stringify({ assessment: "applicable", rationale: "The restored parent inputs retain this sealed archive contract", affected: [] }));
    const assessment = await invoke("preflight", "assess", "--observation", observation.observation_id, "--file", file, "--operation-id", newUUIDv7());
    return invoke("devrun", "admit", "--dev-run", runId, "--preflight", assessment.assessment_id, "--refresh", "--operation-id", newUUIDv7());
  }
  async function start(parent?: string) {
    const planned = parent ? undefined : await invoke("devrun", "plan", "--issue-slug", "archive-cli-behavior", "--repository", f.repository.repository_id, "--definition-commit", base, "--target-remote", "origin", "--target-branch", "refs/heads/main", "--operation-id", newUUIDv7());
    const run = await invoke("devrun", "prepare", "--development-mode", "simple", "--issue", f.issue.issue_id, ...(parent ? ["--refines-candidate", parent] : ["--plan", planned.plan.workspace_id]), "--operation-id", newUUIDv7());
    await admit(run.context.dev_run.id);
    return { id: run.context.dev_run.id, path: run.local_worktree.path, development: run.context.dev_run.development };
  }
  async function submission(run: { id: string }) {
    const template = await invoke("candidate", "template", "--dev-run", run.id);
    template.submission.explanation = "Persist exact original code and history";
    for (const claim of template.submission.claims) { claim.explanation = "Implemented"; for (const criterion of claim.criteria) criterion.explanation = "Confirmed focused behavior"; }
    if (template.submission.format === "patchledger.candidate-submission/v2") for (const rationale of template.submission.change_rationales) { rationale.target_refs = [{ type: "criterion", id: template.submission.claims[0].criteria[0].criterion_id }]; rationale.rationale = "Implements this archive Criterion"; }
    const file = join(root, `submission-${run.id}.json`); writeFileSync(file, JSON.stringify(template.submission)); return { file, value: template.submission };
  }
  async function submit(run: { id: string }, file: string, operation = newUUIDv7()) { return invoke("candidate", "submit", "--dev-run", run.id, "--expected-version", "1", "--file", file, "--archive-policy", transport.policy(), "--operation-id", operation); }
  t.after(async () => { await f.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, remote, f, revised, base, config, database, databasePath, transport, rawAt, invokeAt, invoke, start, submission, submit };
}

test("public Git Candidate uses no SQL patch and restores exact history after author and branch loss", async t => {
  const x = await fixture(t), run = await x.start();
  commit(run.path, "feature", "original\n"); writeFileSync(join(run.path, "binary"), Buffer.from([0, 255, 1])); writeFileSync(join(run.path, "executable"), "#!/bin/sh\nexit 0\n"); chmodSync(join(run.path, "executable"), 0o755); symlinkSync("feature", join(run.path, "symbolic")); git(run.path, "add", "-A"); git(run.path, "commit", "-qm", "binary and modes");
  const source = resolveBaseline(run.path, "HEAD"), tree = `sha1:${git(run.path, "rev-parse", "HEAD^{tree}")}`, parents = git(run.path, "show", "-s", "--format=%P", "HEAD");
  const form = await x.submission(run), op = newUUIDv7(), candidate = await x.submit(run, form.file, op);
  assert.equal(candidate.source.commit, source);
  const db = new DatabaseSync(x.databasePath);
  assert.equal((db.prepare("SELECT count(*) AS count FROM artifact_blobs").get() as { count: number }).count, 0); assert.equal((db.prepare("SELECT count(*) AS count FROM artifact_chunks").get() as { count: number }).count, 0); db.close();
  const archiveRef = `refs/tags/grounds/candidates/${candidate.candidate_id}`;
  assert.equal(git(x.remote, "rev-parse", archiveRef), source.slice(5));
  const traffic = x.transport.calls(); x.transport.fail(true);
  const status = await x.invoke("candidate", "archive-status", "--candidate", candidate.candidate_id);
  assert.equal(status.remote_check, "not_requested"); assert.equal(status.local_availability.status, "confirmed");
  const listed = await x.invoke("candidate", "list", "--issue", x.f.issue.issue_id); assert.ok(listed.resources.some((r: { resource_id: string }) => r.resource_id === candidate.candidate_id));
  const lineage = await x.invoke("candidate", "lineage", "--candidate", candidate.candidate_id); assert.equal(lineage.lineage.initial_base_commit, x.base);
  const ownDiff = await x.invoke("candidate", "diff", "--candidate", candidate.candidate_id, "--view", "candidate");
  assert.equal(ownDiff.comparison.left_commit, x.base); assert.equal(ownDiff.comparison.right_commit, source); assert.equal(ownDiff.comparison.binary, true); assert.equal(ownDiff.comparison.diff_state, "available");
  const upstream = await x.invoke("candidate", "diff", "--candidate", candidate.candidate_id, "--view", "upstream"); assert.equal(upstream.comparison.left_commit, x.base); assert.equal(upstream.comparison.right_commit, x.base); assert.equal(upstream.comparison.patch, "");
  const observedAt = new Date().toISOString(), target = await x.invoke("candidate", "diff", "--candidate", candidate.candidate_id, "--view", "target", "--target-commit", x.base, "--observation-time", observedAt); assert.equal(target.comparison.observed_at, observedAt); assert.equal(target.comparison.delivery_ready, false);
  const noTime = await x.rawAt(x.cwd, "candidate", "diff", "--candidate", candidate.candidate_id, "--view", "target", "--target-commit", x.base); assert.notEqual(noTime.exit, 0);
  assert.equal(x.transport.calls(), traffic, "metadata reads must not contact the remote");
  x.transport.fail(false);
  const child = await x.start(candidate.candidate_id); commit(child.path, "later", "later\n"); const childForm = await x.submission(child), successor = await x.submit(child, childForm.file);
  const chain = await x.invoke("candidate", "lineage", "--candidate", candidate.candidate_id); assert.deepEqual(chain.lineage.successor_candidate_ids, [successor.candidate_id]);
  const reverse = await x.invoke("candidate", "lineage", "--candidate", successor.candidate_id); assert.equal(reverse.lineage.refines_candidate_id, candidate.candidate_id); assert.equal(reverse.lineage.initial_base_commit, x.base);
  const colleague = join(x.root, "colleague"); git(x.root, "clone", "-q", "--no-local", "--no-tags", "--single-branch", "--branch", "main", x.remote, colleague); git(colleague, "remote", "set-url", "origin", x.f.repository.canonical_remote);
  const beforeHead = resolveBaseline(colleague, "HEAD"), index = readFileSync(join(colleague, ".git", "index")); writeFileSync(join(colleague, "file"), "colleague work\n");
  assert.equal((await x.invokeAt(colleague, "candidate", "archive-status", "--candidate", candidate.candidate_id)).local_availability.status, "incomplete");
  const unavailableLineage = await x.invokeAt(colleague, "candidate", "lineage", "--candidate", candidate.candidate_id); assert.equal(unavailableLineage.lineage.initial_base_commit, x.base);
  const fetched = await x.invokeAt(colleague, "candidate", "fetch", "--candidate", candidate.candidate_id); assert.equal(fetched.observation.status, "confirmed");
  assert.equal(resolveBaseline(colleague, "HEAD"), beforeHead); assert.deepEqual(readFileSync(join(colleague, ".git", "index")), index); assert.equal(readFileSync(join(colleague, "file"), "utf8"), "colleague work\n");
  git(x.cwd, "push", x.remote, `${source.slice(5)}:refs/heads/development`); git(x.cwd, "push", x.remote, ":refs/heads/development"); git(x.remote, "reflog", "expire", "--expire=now", "--all"); git(x.remote, "gc", "--prune=now");
  // Remove the entire author clone and managed routes; all subsequent reads use
  // the independent colleague clone plus protected remote tag and SQL metadata.
  rmSync(x.cwd, { recursive: true, force: true });
  const restored = join(x.root, "restored"), result = await x.invokeAt(colleague, "candidate", "restore", "--candidate", candidate.candidate_id, "--path", restored, "--branch", "resume-original");
  assert.equal(result.observation.status, "confirmed"); assert.equal(resolveBaseline(restored, "HEAD"), source); assert.equal(`sha1:${git(restored, "rev-parse", "HEAD^{tree}")}`, tree); assert.equal(git(restored, "show", "-s", "--format=%P", "HEAD"), parents);
  assert.deepEqual(readFileSync(join(restored, "binary")), Buffer.from([0, 255, 1])); assert.match(git(restored, "ls-tree", "HEAD", "executable"), /^100755 /); assert.match(git(restored, "ls-tree", "HEAD", "symbolic"), /^120000 /);
  const occupied = await x.rawAt(colleague, "candidate", "restore", "--candidate", candidate.candidate_id, "--path", restored); assert.notEqual(occupied.exit, 0); assert.equal(readFileSync(join(restored, "feature"), "utf8"), "original\n");
});

test("archive failure leaves an open DevRun and retry preserves the reserved Candidate identity", async t => {
  const x = await fixture(t), run = await x.start(); commit(run.path, "feature", "pending\n"); const form = await x.submission(run), operation = newUUIDv7(), policy = x.transport.policy();
  const missingPolicy = await x.rawAt(x.cwd, "candidate", "submit", "--dev-run", run.id, "--expected-version", "1", "--file", form.file, "--operation-id", newUUIDv7()); assert.notEqual(missingPolicy.exit, 0);
  x.transport.fail(true);
  const failed = await x.rawAt(x.cwd, "candidate", "submit", "--dev-run", run.id, "--expected-version", "1", "--file", form.file, "--archive-policy", policy, "--operation-id", operation); assert.equal(failed.exit, 4); assert.equal(failed.envelope.error.code, "STATE_CONFLICT");
  assert.equal((await x.f.store.read(tx => tx.getDevRun(run.id))).state, "open"); assert.equal((await x.f.module.listCandidates()).resources.length, 0);
  const pending = await x.invoke("candidate", "archive-operation", "--operation-id", operation); assert.equal(pending.operation.data.phase, "unknown");
  x.transport.fail(false);
  const fixed = await x.submit(run, form.file, operation); assert.equal(fixed.candidate_id, pending.operation.data.candidate_id);
  const replay = await x.submit(run, form.file, operation); assert.equal(replay.candidate_id, fixed.candidate_id);
  assert.equal((await x.invoke("candidate", "archive-operation", "--operation-id", operation)).operation.data.phase, "committed");
  assert.equal((await x.f.module.listCandidates()).resources.length, 1);
  git(run.path, "commit", "--allow-empty", "-qm", "same tree different history");
  const changed = await x.rawAt(x.cwd, "candidate", "submit", "--dev-run", run.id, "--expected-version", "1", "--file", form.file, "--archive-policy", policy, "--operation-id", operation);
  assert.notEqual(changed.exit, 0); assert.ok(["IDEMPOTENCY_CONFLICT", "WORKTREE_MISMATCH"].includes(changed.envelope.error.code)); assert.equal(git(x.remote, "rev-parse", `refs/tags/grounds/candidates/${fixed.candidate_id}`), fixed.source.commit.slice(5));
});

test("GitLab onboarding dry-run retains unbound and API failure diagnoses without mutating the Candidate", async t => {
  const api = await gitLabAPIFixture(); t.after(() => api.close());
  const original = { GROUNDS_GITLAB_INSTANCE: process.env.GROUNDS_GITLAB_INSTANCE, GROUNDS_GITLAB_TOKEN: process.env.GROUNDS_GITLAB_TOKEN, GROUNDS_ARCHIVE_POLICY: process.env.GROUNDS_ARCHIVE_POLICY };
  t.after(() => { for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.GROUNDS_GITLAB_INSTANCE = api.instance; process.env.GROUNDS_GITLAB_TOKEN = "fixture-developer"; delete process.env.GROUNDS_ARCHIVE_POLICY;
  const x = await fixture(t, "ssh://git@127.0.0.1/team/repo"), run = await x.start();
  commit(run.path, "preview", "preserve preview diagnostics\n");
  const form = await x.submission(run), candidate = await x.submit(run, form.file);
  const before = (await x.f.module.historyCandidate(candidate.candidate_id)).record;
  const preview = () => x.rawAt(x.cwd, "candidate", "archive", "--candidate", candidate.candidate_id, "--dry-run");
  const missing = await preview();
  assert.equal(missing.exit, 4); assert.equal(missing.envelope.error.code, "STATE_CONFLICT");
  assert.equal(missing.envelope.error.details.protection_diagnosis.state, "unbound");
  assert.ok(missing.envelope.error.details.protection_diagnosis.recovery.length);
  await x.invoke("repository", "archive-bind", "--repository", x.f.repository.repository_id, "--instance", api.instance, "--expected-version", "0", "--operation-id", newUUIDv7());
  for (const [status, reason] of [[403, "api_forbidden"], [401, "authentication_failed"]] as const) {
    api.failures.set("/projects/101/protected_tags", { status });
    const failed = await preview(), diagnosis = failed.envelope.error.details.protection_diagnosis;
    assert.equal(failed.exit, 4); assert.equal(failed.envelope.error.code, "STATE_CONFLICT");
    assert.equal(diagnosis.state, "unknown"); assert.equal(diagnosis.repository_id, x.f.repository.repository_id);
    assert.ok(diagnosis.unknowns.includes(reason)); assert.ok(diagnosis.recovery.length);
  }
  api.failures.clear();
  const ready = await preview(); assert.equal(ready.exit, 0); assert.equal(ready.envelope.data.policy_check.status, "confirmed");
  assertContract("command-results.schema.json", ready.envelope.data);
  assert.deepEqual((await x.f.module.historyCandidate(candidate.candidate_id)).record, before);
  assert.equal(git(x.remote, "rev-parse", `refs/tags/grounds/candidates/${candidate.candidate_id}`), candidate.source.commit.slice(5));
});

test("historical patch-only archive requests are unsupported and preserve the SQL row", async t => {
  const x = await fixture(t), run = await x.start(); commit(run.path, "legacy", "old\n"); const form = await x.submission(run);
  const old = await x.submit(run, form.file);
  const db = new DatabaseSync(x.databasePath);
  db.prepare("UPDATE candidates SET artifact_format = ? WHERE id = ?").run("patchledger.git-full-index-binary-patch/v1", old.candidate_id);
  const before = db.prepare("SELECT * FROM candidates WHERE id = ?").get(old.candidate_id), traffic = x.transport.calls();
  for (const args of [["--dry-run"], ["--archive-policy", x.transport.policy(), "--operation-id", newUUIDv7()]]) {
    const result = await x.rawAt(x.cwd, "candidate", "archive", "--candidate", old.candidate_id, ...args);
    assert.equal(result.envelope.error.code, "UNSUPPORTED_CANDIDATE_ARTIFACT");
  }
  assert.deepEqual(db.prepare("SELECT * FROM candidates WHERE id = ?").get(old.candidate_id), before);
  assert.equal(x.transport.calls(), traffic); db.close();
});

test("actual landing survives pending archival and the original operation completes a separate delivery tag", async t => {
  const x = await fixture(t), run = await x.start(); commit(run.path, "feature", "to deliver\n");
  const form = await x.submission(run), candidate = await x.submit(run, form.file), source = candidate.source.commit;
  const selection = await x.invoke("selection", "set", "--issue", x.f.issue.issue_id, "--issue-version", "2", "--candidate", candidate.candidate_id, "--expected-version", "0", "--reason", "User-selected temporary test Candidate");
  git(x.cwd, "push", x.remote, `${source.slice(5)}:refs/heads/feature`);
  const observation = await x.invoke("integration", "observe", "--candidate", candidate.candidate_id, "--selection", selection.selection.id, "--selection-version", "1", "--source-remote", "origin", "--source-ref", "refs/heads/feature", "--source-commit", source, "--refresh", "--operation-id", newUUIDv7());
  const predecessor = resolveBaseline(x.cwd, "HEAD"); git(x.cwd, "merge", "--no-ff", source.slice(5), "-m", "actual target landing"); const landed = resolveBaseline(x.cwd, "HEAD"); git(x.cwd, "push", x.remote, "HEAD:refs/heads/main");
  const adoption = join(x.root, "adoption.json"); writeFileSync(adoption, JSON.stringify({ format: "grounds.adoption-binding/v1", repository_id: x.f.repository.repository_id, candidate_id: candidate.candidate_id, source_commit: source, landed_commit: landed, target: { remote: "origin", ref: "refs/heads/main" }, method: "merge", source: { kind: "user_confirmation", reference: "This exact temporary target merge was confirmed" } }));
  const operation = newUUIDv7(), args = ["integration", "landing", "--observation", observation.record.id, "--commit", source, "--provenance", "user", "--adoption-file", adoption, "--refresh", "--operation-id", operation];
  const pending = await x.invoke(...args); assert.equal(pending.record.landing.actual_landing.oid, landed); assert.equal(pending.landing_archive.status, "pending");
  const archiveOperation = await x.invoke("candidate", "archive-operation", "--operation-id", pending.record.id); assert.equal(archiveOperation.operation.data.phase, "prepared"); assert.equal(archiveOperation.operation.data.binding.base_commit, predecessor); assert.equal(archiveOperation.operation.data.binding.source_commit, landed);
  const calls = x.transport.calls(); const shown = await x.invoke("integration", "show", pending.record.id); assert.equal(shown.landing_archive.status, "pending"); assert.equal(x.transport.calls(), calls); assert.equal((await x.invoke("candidate", "archive-operation", "--operation-id", pending.record.id)).operation.version, archiveOperation.operation.version);
  const completed = await x.invoke(...args, "--archive-policy", x.transport.policy("refs/tags/grounds/deliveries/")); assert.equal(completed.landing_archive.status, "confirmed"); assert.deepEqual(completed.record, pending.record);
  assert.equal(git(x.remote, "rev-parse", `refs/tags/grounds/deliveries/${pending.record.id}`), landed.slice(5)); assert.equal(git(x.remote, "rev-parse", `refs/tags/grounds/candidates/${candidate.candidate_id}`), source.slice(5));
  const diff = await x.invoke("candidate", "diff", "--candidate", candidate.candidate_id, "--view", "landing", "--landing-record", pending.record.id); assert.equal(diff.comparison.left_commit, predecessor); assert.equal(diff.comparison.right_commit, landed); assert.equal(diff.comparison.diff_state, "available");
  const replay = await x.invoke(...args, "--archive-policy", x.transport.policy("refs/tags/grounds/deliveries/")); assert.equal(replay.landing_archive.status, "confirmed"); assert.equal((await x.invoke("integration", "show", pending.record.id)).landing_archive.status, "confirmed");
  const confirmedCalls = x.transport.calls(); x.transport.fail(true); assert.equal((await x.invoke("integration", "show", pending.record.id)).landing_archive.status, "confirmed"); assert.equal(x.transport.calls(), confirmedCalls);
});


test("Git archive binding survives completion-marker failure and fresh checked retries preserve its first receipt", async t => {
  const x = await fixture(t), run = await x.start(); commit(run.path, "legacy-retry", "recoverable history\n");
  const form = await x.submission(run), fixed = captureCommittedDevelopment(run.path, run.development, x.base);
  const old = await x.submit(run, form.file);
  const before = (await x.f.module.historyCandidate(old.candidate_id)).record;
  const policy = x.transport.policy(), policyBytes = readFileSync(policy), operation = newUUIDv7();
  const args = ["candidate", "archive", "--candidate", old.candidate_id, "--archive-policy", policy, "--operation-id", operation];
  // Inject at the public workflow's real non-atomic boundary: the Candidate's
  // SQL binding has committed, while the separate completion marker cannot.
  const complete = CandidateArchiveService.prototype.committed;
  let markerFailures = 0;
  const failCompletion: typeof complete = async function () {
    assert.ok((await x.f.store.read(tx => tx.findCandidateArtifactRef({ candidate_id: old.candidate_id })))?.git_artifact);
    markerFailures++; throw new Error("Simulated completion-marker storage failure");
  };
  CandidateArchiveService.prototype.committed = failCompletion;
  let failed: Awaited<ReturnType<typeof x.rawAt>>;
  try { failed = await x.rawAt(x.cwd, ...args); }
  finally { CandidateArchiveService.prototype.committed = complete; }
  assert.equal(markerFailures, 1); assert.notEqual(failed!.exit, 0);
  const stored = (await x.f.store.read(tx => tx.findCandidateArtifactRef({ candidate_id: old.candidate_id })))!.git_artifact!;
  const snapshot = () => {
    const db = new DatabaseSync(x.databasePath);
    try { return db.prepare("SELECT metadata_json, metadata_digest, patch_size FROM candidate_git_artifacts WHERE candidate_id = ?").get(old.candidate_id); }
    finally { db.close(); }
  };
  const frozenBytes = snapshot();
  const pending = await x.invoke("candidate", "archive-operation", "--operation-id", operation);
  assert.equal(pending.operation.data.phase, "verified"); assert.deepEqual(pending.operation.data.receipt.binding, stored.receipt.binding); assert.equal(pending.operation.data.receipt.status, "confirmed");
  // Retry directly from verified as well: a second marker failure must be
  // reachable after binding the same Candidate with a fresh observation.
  CandidateArchiveService.prototype.committed = failCompletion;
  try { assert.notEqual((await x.rawAt(x.cwd, ...args)).exit, 0); }
  finally { CandidateArchiveService.prototype.committed = complete; }
  assert.equal(markerFailures, 2, "the original verified operation must get past SQL binding on retry");
  assert.deepEqual(snapshot(), frozenBytes);
  const traffic = x.transport.calls(), expired = JSON.parse(policyBytes.toString()); expired.valid_until = "2000-01-01T00:00:00.000Z"; writeFileSync(policy, JSON.stringify(expired));
  const refused = await x.rawAt(x.cwd, ...args); assert.equal(refused.exit, 4); assert.equal(refused.envelope.error.code, "STATE_CONFLICT");
  assert.notEqual((await x.invoke("candidate", "archive-operation", "--operation-id", operation)).operation.data.phase, "committed"); assert.deepEqual(snapshot(), frozenBytes);
  writeFileSync(policy, policyBytes);
  git(run.path, "commit", "--allow-empty", "-qm", "distinct history must not replace the archive");
  const different = resolveBaseline(run.path, "HEAD"), archiveRef = stored.binding.archive_ref;
  git(x.cwd, "push", x.remote, `${different.slice(5)}:refs/heads/other-history`); git(x.remote, "update-ref", archiveRef, different.slice(5));
  const drift = await x.rawAt(x.cwd, ...args); assert.equal(drift.exit, 4); assert.equal(drift.envelope.error.code, "STATE_CONFLICT");
  const conflicted = await x.invoke("candidate", "archive-operation", "--operation-id", operation); assert.equal(conflicted.operation.data.receipt.status, "conflict"); assert.deepEqual(snapshot(), frozenBytes);
  git(x.remote, "update-ref", archiveRef, fixed.source.commit.slice(5));
  const resumed = await x.invoke(...args);
  assert.equal(resumed.operation.id, operation); assert.equal(resumed.operation.data.phase, "committed"); assert.ok(x.transport.calls() > traffic, "unfinished retry must recheck remote objects");
  assert.notEqual(resumed.operation.data.receipt.observed_at, stored.receipt.observed_at);
  assert.deepEqual(resumed.artifact, stored, "public result must identify the persisted artifact, not the fresh observation");
  assert.deepEqual(resumed.operation.data.result.artifact, stored); assert.deepEqual(snapshot(), frozenBytes);
  const after = (await x.f.module.historyCandidate(old.candidate_id)).record;
  assert.deepEqual(after, before);
  assert.deepEqual((await x.invoke(...args)).artifact, stored);
});

async function fastForwardLandingFixture(t: Parameters<typeof fixture>[0], gateTargetDiffers = false) {
  const x = await fixture(t), run = await x.start();
  commit(run.path, "feature-one", "first feature commit\n"); const intermediate = resolveBaseline(run.path, "HEAD");
  let predecessor = x.base;
  if (gateTargetDiffers) {
    commit(x.cwd, "upstream-only", "already on actual target\n"); predecessor = resolveBaseline(x.cwd, "HEAD");
    // The future target predecessor is deliberately a second-parent ancestor
    // of L, while the gate will still observe the old remote target B.
    git(run.path, "merge", "--no-ff", predecessor.slice(5), "-m", "integrate future target");
  }
  commit(run.path, "feature-two", "second feature commit\n");
  const form = await x.submission(run), candidate = await x.submit(run, form.file), source = candidate.source.commit;
  const selection = await x.invoke("selection", "set", "--issue", x.f.issue.issue_id, "--issue-version", "2", "--candidate", candidate.candidate_id, "--expected-version", "0", "--reason", "User-selected temporary multi-commit FF Candidate");
  git(x.cwd, "push", x.remote, `${source.slice(5)}:refs/heads/feature`);
  const observation = await x.invoke("integration", "observe", "--candidate", candidate.candidate_id, "--selection", selection.selection.id, "--selection-version", "1", "--source-remote", "origin", "--source-ref", "refs/heads/feature", "--source-commit", source, "--refresh", "--operation-id", newUUIDv7());
  if (gateTargetDiffers) git(x.cwd, "push", x.remote, "HEAD:refs/heads/main");
  assert.equal(resolveBaseline(x.cwd, "HEAD"), predecessor);
  git(x.cwd, "merge", "--ff-only", source.slice(5)); git(x.cwd, "push", x.remote, "HEAD:refs/heads/main");
  assert.notEqual(`sha1:${git(x.cwd, "rev-parse", "HEAD^")}`, predecessor);
  const adoption = (targetPredecessor?: string) => ({ format: "grounds.adoption-binding/v1", repository_id: x.f.repository.repository_id, candidate_id: candidate.candidate_id, source_commit: source, landed_commit: source, target: { remote: "origin", ref: "refs/heads/main" }, method: "ff", source: { kind: "user_confirmation", reference: "Controlled target update was a multi-commit fast-forward" }, ...(targetPredecessor ? { target_predecessor: targetPredecessor } : {}) });
  const record = async (name: string, targetPredecessor?: string, withPolicy = false) => {
    const file = join(x.root, `${name}.json`); writeFileSync(file, JSON.stringify(adoption(targetPredecessor)));
    const operation = newUUIDv7(), args = ["integration", "landing", "--observation", observation.record.id, "--commit", source, "--provenance", "user", "--adoption-file", file, "--refresh", "--operation-id", operation, ...(withPolicy ? ["--archive-policy", x.transport.policy("refs/tags/grounds/deliveries/")] : [])];
    const response = await x.rawAt(x.cwd, ...args); assert.equal(response.exit, 0, JSON.stringify(response.envelope));
    const landed = response.envelope.data; return { landed, args, operation };
  };
  return { ...x, run, intermediate, predecessor, candidate, source, observation, record };
}

test("multi-commit FF without predecessor evidence preserves adoption and refuses a guessed landing diff", async t => {
  const x = await fastForwardLandingFixture(t), missing = await x.record("missing-predecessor");
  assert.equal(missing.landed.record.landing.actual_landing.oid, x.source);
  assert.equal(missing.landed.record.landing.decision.identity, "trusted");
  const diff = await x.rawAt(x.cwd, "candidate", "diff", "--candidate", x.candidate.candidate_id, "--view", "landing", "--landing-record", missing.landed.record.id);
  assert.notEqual(diff.exit, 0, "missing P must not produce an incomplete L.first-parent to L diff");
  assertContract("command-results.schema.json", missing.landed);
  assert.equal(missing.landed.record.landing.target_predecessor.state, "unknown");
  assert.ok(["pending", "unknown"].includes(missing.landed.landing_archive.status));
  const reservation = await x.rawAt(x.cwd, "candidate", "archive-operation", "--operation-id", missing.landed.record.id); assert.equal(reservation.envelope.error.code, "NOT_FOUND");
  assert.deepEqual((await x.invoke(...missing.args)).record, missing.landed.record);
  const db = new DatabaseSync(x.databasePath);
  try { assert.equal((db.prepare("SELECT count(*) AS count FROM ledger_events WHERE event_type = 'integration.landing' AND subject_id = ?").get(x.candidate.candidate_id) as { count: number }).count, 1); }
  finally { db.close(); }
  const wrong = await x.record("conflicting-predecessor", x.source, true);
  assertContract("command-results.schema.json", wrong.landed);
  assert.equal(wrong.landed.record.landing.actual_landing.oid, x.source); assert.equal(wrong.landed.record.landing.decision.identity, "trusted");
  assert.equal(wrong.landed.record.landing.target_predecessor.state, "conflict"); assert.notEqual(wrong.landed.landing_archive.status, "confirmed");
  assert.notEqual((await x.rawAt(x.cwd, "candidate", "diff", "--candidate", x.candidate.candidate_id, "--view", "landing", "--landing-record", wrong.landed.record.id)).exit, 0);
  assert.equal((await x.rawAt(x.cwd, "candidate", "archive-operation", "--operation-id", wrong.landed.record.id)).envelope.error.code, "NOT_FOUND");
  // Recreate a coherent pre-field serialized record in this temporary ledger:
  // both the append-only fact envelope and its old idempotent replay lack P.
  const legacy = structuredClone(missing.landed.record); delete legacy.landing.target_predecessor;
  const historical = new DatabaseSync(x.databasePath);
  try {
    const row = historical.prepare("SELECT facts_json FROM ledger_events WHERE event_id = ?").get(legacy.id) as { facts_json: string };
    const facts = JSON.parse(row.facts_json); facts.record = JSON.stringify(legacy); facts.record_digest = sha256(legacy);
    historical.prepare("UPDATE ledger_events SET facts_json = ? WHERE event_id = ?").run(JSON.stringify(facts), legacy.id);
    const replay = historical.prepare("SELECT result_json FROM idempotency_records WHERE operation_id = ?").get(missing.operation) as { result_json: Uint8Array };
    const envelope = JSON.parse(Buffer.from(replay.result_json).toString()); envelope.data.record = legacy;
    historical.prepare("UPDATE idempotency_records SET result_json = ? WHERE operation_id = ?").run(Buffer.from(JSON.stringify(envelope)), missing.operation);
  } finally { historical.close(); }
  const restoredHistory = await x.invoke("integration", "show", legacy.id); assert.equal(restoredHistory.record.landing.actual_landing.oid, x.source); assert.equal("target_predecessor" in restoredHistory.record.landing, false); assert.notEqual(restoredHistory.landing_archive.status, "confirmed");
  assert.notEqual((await x.rawAt(x.cwd, "candidate", "diff", "--candidate", x.candidate.candidate_id, "--view", "landing", "--landing-record", legacy.id)).exit, 0);
  assert.deepEqual((await x.invoke(...missing.args)).record, legacy);
  assert.equal(git(x.remote, "rev-parse", `refs/tags/grounds/candidates/${x.candidate.candidate_id}`), x.source.slice(5));
});


for (const gateTargetDiffers of [false, true]) test(`multi-commit FF archives the proved target predecessor${gateTargetDiffers ? " beyond a stale gate via second-parent ancestry" : " across both feature commits"}`, async t => {
  const x = await fastForwardLandingFixture(t, gateTargetDiffers), captured = await x.record("proved-predecessor", x.predecessor, true), landed = captured.landed;
  assertContract("command-results.schema.json", landed);
  assert.equal(landed.record.landing.actual_landing.oid, x.source);
  assert.notEqual(landed.record.landing.actual_landing.parents[0], x.predecessor);
  assert.equal(landed.record.landing.target_predecessor.state, "confirmed"); assert.equal(landed.record.landing.target_predecessor.commit.oid, x.predecessor);
  assert.equal(landed.record.landing.target_predecessor.source, "adoption_binding"); assert.equal(landed.landing_archive.status, "confirmed");
  assert.equal(x.observation.record.gate.target_observation.commit.oid, x.base);
  if (gateTargetDiffers) {
    assert.notEqual(x.predecessor, x.base);
    const firstParents = git(x.cwd, "rev-list", "--first-parent", x.source.slice(5)).split("\n");
    assert.equal(firstParents.includes(x.predecessor.slice(5)), false, "P intentionally arrives through the second-parent path");
  }
  const archive = await x.invoke("candidate", "archive-operation", "--operation-id", landed.record.id), reservation = archive.operation.data;
  assert.equal(reservation.binding.base_commit, x.predecessor); assert.deepEqual(reservation.binding.retained_commits, [x.predecessor]); assert.equal(reservation.binding.source_commit, x.source);
  const expectedRequest = { purpose: "landing", owner_id: x.candidate.candidate_id, candidate_id: x.candidate.candidate_id, binding: reservation.binding, request: { landing_record_id: landed.record.id, landed_commit: x.source, target_predecessor: x.predecessor }, attribution: reservation.attribution };
  assert.equal(reservation.request_digest, sha256(expectedRequest), "the frozen archive request must use actual P as well");
  const diff = await x.invoke("candidate", "diff", "--candidate", x.candidate.candidate_id, "--view", "landing", "--landing-record", landed.record.id);
  assert.equal(diff.comparison.left_commit, x.predecessor); assert.equal(diff.comparison.right_commit, x.source); assert.equal(diff.comparison.diff_state, "available");
  assert.match(diff.comparison.patch, /feature-one/); assert.match(diff.comparison.patch, /feature-two/); assert.doesNotMatch(diff.comparison.patch, /upstream-only/);
  assert.equal(git(x.remote, "rev-parse", `refs/tags/grounds/candidates/${x.candidate.candidate_id}`), x.source.slice(5));
  assert.equal(git(x.remote, "rev-parse", `refs/tags/grounds/deliveries/${landed.record.id}`), x.source.slice(5));
  assert.deepEqual((await x.invoke(...captured.args)).record, landed.record);
  const db = new DatabaseSync(x.databasePath); try { assert.equal((db.prepare("SELECT count(*) AS count FROM ledger_events WHERE event_type = 'integration.landing' AND subject_id = ?").get(x.candidate.candidate_id) as { count: number }).count, 1); } finally { db.close(); }
});

test("squash landing archives its real target parent and keeps the different Candidate source tag", async t => {
  const x = await fixture(t), run = await x.start(); commit(run.path, "feature-one", "squashed first feature\n"); commit(run.path, "feature-two", "squashed second feature\n");
  const form = await x.submission(run), candidate = await x.submit(run, form.file), source = candidate.source.commit;
  const selection = await x.invoke("selection", "set", "--issue", x.f.issue.issue_id, "--issue-version", "2", "--candidate", candidate.candidate_id, "--expected-version", "0", "--reason", "User-selected temporary squash Candidate");
  git(x.cwd, "push", x.remote, `${source.slice(5)}:refs/heads/feature`);
  const observation = await x.invoke("integration", "observe", "--candidate", candidate.candidate_id, "--selection", selection.selection.id, "--selection-version", "1", "--source-remote", "origin", "--source-ref", "refs/heads/feature", "--source-commit", source, "--refresh", "--operation-id", newUUIDv7());
  const predecessor = resolveBaseline(x.cwd, "HEAD"); git(x.cwd, "merge", "--squash", source.slice(5)); git(x.cwd, "commit", "-qm", "actual squash landing"); const landed = resolveBaseline(x.cwd, "HEAD"); git(x.cwd, "push", x.remote, "HEAD:refs/heads/main");
  assert.notEqual(landed, source);
  const file = join(x.root, "squash-adoption.json"); writeFileSync(file, JSON.stringify({ format: "grounds.adoption-binding/v1", repository_id: x.f.repository.repository_id, candidate_id: candidate.candidate_id, source_commit: source, landed_commit: landed, target: { remote: "origin", ref: "refs/heads/main" }, method: "squash", source: { kind: "user_confirmation", reference: "The controlled target update squash adopted this exact Candidate" } }));
  const result = await x.invoke("integration", "landing", "--observation", observation.record.id, "--commit", landed, "--provenance", "user", "--adoption-file", file, "--refresh", "--operation-id", newUUIDv7(), "--archive-policy", x.transport.policy("refs/tags/grounds/deliveries/"));
  assert.equal(result.record.landing.actual_landing.oid, landed); assert.equal(result.record.landing.target_predecessor.state, "confirmed"); assert.equal(result.record.landing.target_predecessor.commit.oid, predecessor); assert.equal(result.record.landing.target_predecessor.source, "landing_first_parent"); assert.equal(result.landing_archive.status, "confirmed");
  const archive = await x.invoke("candidate", "archive-operation", "--operation-id", result.record.id); assert.equal(archive.operation.data.binding.base_commit, predecessor); assert.deepEqual(archive.operation.data.binding.retained_commits, [predecessor]);
  const diff = await x.invoke("candidate", "diff", "--candidate", candidate.candidate_id, "--view", "landing", "--landing-record", result.record.id); assert.equal(diff.comparison.left_commit, predecessor); assert.equal(diff.comparison.right_commit, landed); assert.match(diff.comparison.patch, /feature-one/); assert.match(diff.comparison.patch, /feature-two/);
  assert.equal(git(x.remote, "rev-parse", `refs/tags/grounds/candidates/${candidate.candidate_id}`), source.slice(5)); assert.equal(git(x.remote, "rev-parse", `refs/tags/grounds/deliveries/${result.record.id}`), landed.slice(5));
});


test("two ordinary task repositories submit Git Candidates, retain YAML and recover by immutable tags with explicit lineage", async t => {
  const x = await fixture(t);
  let previous: { candidate_id: string; source: { commit: string } } | undefined;
  for (let round = 1; round <= 2; round++) {
    const run = await x.start(previous?.candidate_id), expected = resolveBaseline(run.path, "HEAD");
    const task = join(x.root, `task-${round}`);
    if (previous) {
      git(x.root, "clone", "-q", "--no-local", "--no-tags", "--single-branch", "--branch", "main", x.remote, task);
      git(task, "fetch", "--no-tags", x.remote, `refs/tags/grounds/candidates/${previous.candidate_id}`);
      git(task, "checkout", "-qb", run.development.branch, "FETCH_HEAD");
      assert.equal(resolveBaseline(task, "HEAD"), previous.source.commit);
    } else git(x.root, "clone", "-q", "--no-local", "--branch", run.development.branch, x.cwd, task);
    assert.equal(existsSync(join(task, ".git", "objects", "info", "alternates")), false);
    git(task, "config", "user.name", "Independent task"); git(task, "config", "user.email", "task@invalid");
    mkdirSync(join(task, ".grounds", "environments"), { recursive: true });
    commit(task, ".grounds/environments/development.yaml", `format: grounds.environment-definition/v1\nname: development\nbackend: host\n# round: ${round}\n`);
    const source = resolveBaseline(task, "HEAD"), environmentId = newUUIDv7();
    const received = receiveDevelopmentObjects({ target_path: run.path, source_path: task, source_commit: source, environment_id: environmentId });
    assert.equal(resolveBaseline(run.path, "HEAD"), expected, "object reception cannot advance the managed route");
    receiveDevelopmentSource({ target_path: run.path, source_path: task, source_commit: source, expected_head: expected, development: run.development });
    const form = await x.submission(run), candidate = await x.submit(run, form.file);
    assert.equal(candidate.source.commit, source);
    const tag = `refs/tags/grounds/candidates/${candidate.candidate_id}`;
    assert.equal(git(x.remote, "rev-parse", tag), source.slice(5));
    assert.throws(() => git(x.cwd, "push", "--force", x.remote, `${x.base.slice(5)}:${tag}`), /archive tags are immutable|hook declined/);
    assert.throws(() => git(x.cwd, "push", x.remote, `:${tag}`), /archive tags are immutable|hook declined/);
    assert.equal(git(x.remote, "rev-parse", tag), source.slice(5));
    const lineage = await x.invoke("candidate", "lineage", "--candidate", candidate.candidate_id);
    assert.equal(lineage.lineage.refines_candidate_id, previous?.candidate_id);
    assert.equal(resolveBaseline(run.path, received.ref), source);
    rmSync(task, { recursive: true, force: true });
    const recovered = join(x.root, `recovered-${round}`);
    git(x.root, "clone", "-q", "--no-local", "--no-tags", "--single-branch", "--branch", "main", x.remote, recovered);
    git(recovered, "remote", "set-url", "origin", x.f.repository.canonical_remote);
    await x.invokeAt(recovered, "candidate", "fetch", "--candidate", candidate.candidate_id);
    git(recovered, "checkout", "--detach", source.slice(5));
    assert.equal(readFileSync(join(recovered, ".grounds", "environments", "development.yaml"), "utf8"), `format: grounds.environment-definition/v1\nname: development\nbackend: host\n# round: ${round}\n`);
    assert.equal(`sha1:${git(recovered, "rev-parse", "HEAD^{tree}")}`, candidate.result_tree_oid);
    git(recovered, "checkout", "-qb", `grounds/restored/${candidate.candidate_id}`);
    const prepared = await x.invokeAt(recovered, "env", "up", "--definition", "development");
    assert.equal(prepared.environment.backend, "host");
    await x.invokeAt(recovered, "env", "down", prepared.environment.id);
    assert.ok(existsSync(join(recovered, ".grounds", "environments", "development.yaml")), "caller declarations survive environment cleanup");
    if (round === 1) {
      git(recovered, "config", "user.name", "Negative test"); git(recovered, "config", "user.email", "negative@invalid");
      writeFileSync(join(recovered, ".grounds", "private-runtime.json"), "private runtime\n");
      git(recovered, "add", "-f", ".grounds/private-runtime.json"); git(recovered, "commit", "-qm", "invalid private runtime");
      assert.throws(() => receiveDevelopmentObjects({ target_path: run.path, source_path: recovered, source_commit: resolveBaseline(recovered, "HEAD"), environment_id: newUUIDv7() }));
      assert.equal(readFileSync(join(recovered, ".grounds", "private-runtime.json"), "utf8"), "private runtime\n");
    }
    previous = candidate;
  }
});
