import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, readFileSync, renameSync, mkdirSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { CodeRouteExecutions, type RouteEngine } from "../src/code-route-execution.js";
import { CodeRouteGit } from "../src/code-route-git.js";
import { runCLI } from "../src/cli.js";
import { git } from "../src/env-git.js";
import { newUUIDv7 } from "../src/identity.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";
import { assertContract } from "./schema-fixture.js";
import { CodeWorkspaceCleanup } from "../src/code-workspace-cleanup.js";
import { archivePolicyFor } from "../src/repository-archive-cli.js";
import { PreflightService } from "../src/preflight.js";
import { sha256 } from "../src/canonical-json.js";

const fURL = (remote: string) => `url.file://${remote}.insteadOf`;

async function fixture(t: Parameters<typeof executionFixture>[0], related = false) {
  const x = await executionFixture(t, undefined, related);
  const config = join(x.root, "cli-config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const raw = async (cwd: string, ...args: string[]) => {
    const output: string[] = [];
    const code = await runCLI([...args, "--config", config, "--json"],
      { cwd, stdout: line => output.push(line), stderr: () => {} });
    const envelope = JSON.parse(output.join("\n"));
    try { assertContract("cli-envelope.schema.json", envelope); }
    catch (cause) { throw new Error(JSON.stringify(envelope), { cause }); }
    return { code, envelope };
  };
  const invokeAt = async (cwd: string, ...args: string[]) => {
    const result = await raw(cwd, ...args);
    assert.equal(result.code, 0, JSON.stringify(result.envelope)); return result.envelope.data;
  };
  const invoke = (...args: string[]) => invokeAt(x.route.path, ...args);
  const managed = new CodeRouteGit(x.ledger.store, x.route.route_id);
  const commit = async (content: string) => {
    writeFileSync(join(x.route.path, "service.txt"), content);
    await managed.apply({ ...actor(), action: "stage", snapshot: await managed.snapshot(["service.txt"]) });
    return managed.apply({ ...actor(), action: "commit", snapshot: await managed.snapshot([]),
      message: "Implement the issue", author: { name: "Agent", email: "agent@example.invalid" } });
  };
  return { ...x, raw, invoke, invokeAt, commit, managed };
}

test("a code route produces a Candidate template from its committed history without legacy local state", async t => {
  const x = await fixture(t);
  await x.commit("implemented\n");
  const template = await x.invoke("candidate", "template", "--dev-run", x.route.dev_run_id!);
  assert.equal(template.submission.claims.length, 1);
  assert.ok(template.submission.change_rationales.length > 0);
  assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "implemented\n");
  assert.equal(git(["status", "--porcelain"], { cwd: x.route.path }), "");
});

async function submission(x: Awaited<ReturnType<typeof fixture>>) {
  const template = await x.invoke("candidate", "template", "--dev-run", x.route.dev_run_id!);
  const form = template.submission;
  form.explanation = "Archive the exact implemented source";
  for (const claim of form.claims) {
    claim.explanation = "Implemented";
    for (const criterion of claim.criteria) criterion.explanation = "Checked the fixed context";
  }
  for (const rationale of form.change_rationales) {
    rationale.target_refs = [{ type: "criterion", id: form.claims[0].criteria[0].criterion_id }];
    rationale.rationale = "Implements the issue criterion";
  }
  const file = join(x.root, "submission.json"); writeFileSync(file, JSON.stringify(form));
  return file;
}

test("a code route archives its exact Candidate once and restores it independently of the workspace cache", async t => {
  const x = await fixture(t);
  const transport = archiveCLITransport(t, x.root, x.remote, x.ledger.repository.repository_id);
  git(["config", "--unset-all", fURL(x.remote)], { cwd: x.route.path });
  const committed = await x.commit("archived implementation\n"), file = await submission(x);
  const op = newUUIDv7(), args = ["candidate", "submit", "--dev-run", x.route.dev_run_id!, "--expected-version", "1",
    "--file", file, "--archive-policy", transport.policy(), "--operation-id", op, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const candidate = await x.invoke(...args);
  assert.equal(candidate.source.commit, `sha1:${committed.head}`);
  assert.equal(candidate.result_tree_oid, `sha1:${committed.tree}`);
  const ref = `refs/tags/grounds/candidates/${candidate.candidate_id}`;
  assert.equal(git(["rev-parse", ref], { gitDir: x.remote }), committed.head);
  assert.deepEqual(await x.invoke(...args), candidate, "retry must preserve the Candidate and first archive receipt");
  assert.equal((await x.ledger.module.showDevRun(x.route.dev_run_id!)).state, "submitted");
  // A host can still change its own files; an old operation must not bless a
  // different source identity, even when the resulting tree is unchanged.
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "later host commit"], { cwd: x.route.path });
  assert.equal((await x.raw(x.route.path, ...args)).envelope.error.code, "WORKTREE_MISMATCH");
  const later = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  git(["update-ref", `refs/heads/${x.route.development.branch}`, committed.head, later], { cwd: x.route.path });
  assert.equal(git(["rev-parse", ref], { gitDir: x.remote }), committed.head);

  await assert.rejects(x.managed.snapshot([]), { code: "WORKTREE_MISMATCH" });
  const fresh = join(x.root, "independent-clone"), restored = join(x.root, "restored-source");
  git(["clone", "--no-local", "--no-tags", "--single-branch", "--branch", "main", x.remote, fresh]);
  renameSync(x.dataRoot, join(x.root, "offline-workspace-and-cache"));
  git(["remote", "set-url", "origin", "ssh://git@example.test/team/repo"], { cwd: fresh });
  await x.invokeAt(fresh, "candidate", "restore", "--candidate", candidate.candidate_id, "--path", restored);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: restored }), committed.head);
  assert.equal(readFileSync(join(restored, "service.txt"), "utf8"), "archived implementation\n");
  assert.equal(git(["rev-list", "--count", "HEAD"], { cwd: restored }), "2");
  assert.equal(git(["rev-parse", "refs/heads/main"], { gitDir: x.remote }), x.firstCommit.split(":")[1]);
});

test("Candidate capture refuses running or paused executors, pending Git, dirty files and foreign roots", async t => {
  const x = await fixture(t);
  await x.commit("ready for capture\n");
  const template = ["candidate", "template", "--dev-run", x.route.dev_run_id!];
  const form = await submission(x);
  const submit = ["candidate", "submit", "--dev-run", x.route.dev_run_id!, "--expected-version", "1", "--file", form,
    "--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"];
  let container: string | undefined;
  const engine: RouteEngine = {
    identity: async () => "isolated-engine", create: async run => (container = run.execution_id), start: async () => {},
    find: async () => container, removeStopped: async () => { container = undefined; }, pause: async () => {}, assertPaused: async () => {}, resume: async () => {},
  };
  const executions = new CodeRouteExecutions(x.ledger.store, engine);
  await x.admit();
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image: `sha256:${"1".repeat(64)}`, argv: ["true"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id };
  for (const args of [template, submit]) assert.equal((await x.raw(x.route.path, ...args)).envelope.error.code, "STATE_CONFLICT");
  await executions.pause({ ...actor(), ...ref });
  for (const args of [template, submit]) assert.equal((await x.raw(x.route.path, ...args)).envelope.error.code, "STATE_CONFLICT");
  await executions.stop(ref);
  assert.equal((await x.raw(x.writer, ...template)).envelope.error.code, "WORKTREE_MISMATCH");
  writeFileSync(join(x.route.path, "service.txt"), "unfinished changes\n");
  for (const args of [template, submit]) assert.equal((await x.raw(x.route.path, ...args)).envelope.error.code, "WORKTREE_MISMATCH");
  const stage = { ...actor(), action: "stage" as const, snapshot: await x.managed.snapshot(["service.txt"]) };
  await x.managed.apply(stage);
  const commit = { ...actor(), action: "commit" as const, snapshot: await x.managed.snapshot([]),
    message: "Recover commit", author: { name: "Agent", email: "agent@example.invalid" } };
  const restore = x.failAfterGit(`refs/heads/${x.route.development.branch}`);
  try { await assert.rejects(x.managed.apply(commit)); } finally { restore(); }
  for (const args of [template, submit]) assert.equal((await x.raw(x.route.path, ...args)).envelope.error.code, "STATE_CONFLICT");
  await x.managed.apply(commit);
  await x.invoke(...template);
  assert.equal((await x.ledger.module.showDevRun(x.route.dev_run_id!)).state, "open");
  mkdirSync(join(x.route.path, ".grounds", "runtime"), { recursive: true });
  writeFileSync(join(x.route.path, ".grounds", "runtime", "private.txt"), "fixture-only private material");
  git(["add", ".grounds/runtime/private.txt"], { cwd: x.route.path });
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "private runtime must not archive"], { cwd: x.route.path });
  assert.equal((await x.raw(x.route.path, ...template)).envelope.error.code, "VALIDATION_ERROR");
});

test("an unconfirmed route archive retains its Candidate reservation and retries without changing identity", async t => {
  const x = await fixture(t);
  const transport = archiveCLITransport(t, x.root, x.remote, x.ledger.repository.repository_id);
  git(["config", "--unset-all", fURL(x.remote)], { cwd: x.route.path });
  const committed = await x.commit("recoverable archive\n"), file = await submission(x), op = newUUIDv7();
  const args = ["candidate", "submit", "--dev-run", x.route.dev_run_id!, "--expected-version", "1", "--file", file,
    "--archive-policy", transport.policy(), "--operation-id", op, "--agent-id", "fixture", "--agent-name", "Fixture"];
  transport.fail(true);
  const failed = await x.raw(x.route.path, ...args);
  assert.equal(failed.envelope.error.code, "STATE_CONFLICT");
  assert.equal(failed.envelope.error.details.operation_id, op);
  assert.equal((await x.ledger.module.showDevRun(x.route.dev_run_id!)).state, "open");
  const pending = await x.invoke("candidate", "archive-operation", "--operation-id", op);
  assert.equal(pending.operation.data.phase, "unknown");
  assert.equal(pending.operation.data.binding.source_commit, `sha1:${committed.head}`);
  transport.fail(false);
  const result = await x.invoke(...args);
  assert.equal(result.candidate_id, pending.operation.data.candidate_id);
  assert.equal((await x.invoke("candidate", "archive-operation", "--operation-id", op)).operation.data.phase, "committed");
  assert.deepEqual(await x.invoke(...args), result);
});

test("cleanup requires current archive proof, preserves later commits and reclaims resources independently before Candidate restore", async t => {
  const x = await fixture(t), ref = { instance_id: x.instance.instance_id, host_id: x.route.host_id, data_root: x.dataRoot };
  const cleanup = new CodeWorkspaceCleanup(x.ledger.store);
  await assert.rejects(cleanup.end({ ...ref, ...actor(), expected_version: 0 }), { code: "STATE_CONFLICT" });
  const transport = archiveCLITransport(t, x.root, x.remote, x.ledger.repository.repository_id);
  git(["config", "--unset-all", fURL(x.remote)], { cwd: x.route.path });
  const committed = await x.commit("preserved Candidate\n"), file = await submission(x);
  const candidate = await x.invoke("candidate", "submit", "--dev-run", x.route.dev_run_id!, "--expected-version", "1",
    "--file", file, "--archive-policy", transport.policy(), "--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture");
  await cleanup.end({ ...ref, ...actor(), expected_version: 0, retention_days: 0 });
  const development = (plan: Awaited<ReturnType<typeof cleanup.preview>>) => plan.resources.find(resource => resource.kind === "development")!;
  assert.equal(development(await cleanup.preview(ref)).reason, "archive_protection_unconfirmed");
  const verified = new CodeWorkspaceCleanup(x.ledger.store, { policyCheck: archivePolicyFor(x.ledger.store, x.root, transport.policy()) });
  transport.fail(true);
  assert.equal(development(await verified.preview(ref)).state, "blocked");
  transport.fail(false);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "later unarchived commit"], { cwd: x.route.path });
  assert.equal(development(await verified.preview(ref)).reason, "unarchived_commit");
  const later = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  git(["update-ref", `refs/heads/${x.route.development.branch}`, committed.head, later], { cwd: x.route.path });
  const baseline = (await x.service.instance(x.instance.instance_id)).baselines[0]!.path;
  writeFileSync(join(baseline, "unique-input"), "keep this input");
  const plan = await verified.preview(ref);
  assert.equal(development(plan).state, "eligible");
  const result = await verified.reclaim({ ...ref, ...actor(), expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest });
  assert.equal(result.resources.find(resource => resource.kind === "development")!.state, "removed");
  assert.equal(result.resources.find(resource => resource.kind === "baseline")!.state, "blocked");
  assert.equal(existsSync(x.route.path), false);
  assert.equal(readFileSync(join(baseline, "unique-input"), "utf8"), "keep this input");
  assert.equal((await x.service.instance(x.instance.instance_id)).lifecycle!.state, "ended");
  unlinkSync(join(baseline, "unique-input"));
  const next = await verified.preview(ref);
  await verified.reclaim({ ...ref, ...actor(), expected_version: next.lifecycle_version, plan_digest: next.plan_digest });
  assert.equal((await x.service.instance(x.instance.instance_id)).lifecycle!.state, "code_reclaimed");
  const fresh = join(x.root, "restore-repository"), restored = join(x.root, "after-cleanup");
  git(["clone", "--no-local", "--no-tags", "--single-branch", "--branch", "main", x.remote, fresh]);
  git(["remote", "set-url", "origin", "ssh://git@example.test/team/repo"], { cwd: fresh });
  await x.invokeAt(fresh, "candidate", "restore", "--candidate", candidate.candidate_id, "--path", restored);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: restored }), committed.head);
  assert.equal(readFileSync(join(restored, "service.txt"), "utf8"), "preserved Candidate\n");
});

async function archivedAndReclaimed(t: Parameters<typeof fixture>[0], related = false, rejected = false,
  beforeReclaim?: (x: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const x = await fixture(t, related), transport = archiveCLITransport(t, x.root, x.remote, x.ledger.repository.repository_id);
  git(["config", "--unset-all", fURL(x.remote)], { cwd: x.route.path });
  const committed = await x.commit("restorable work\n"), file = await submission(x);
  const candidate = await x.invoke("candidate", "submit", "--dev-run", x.route.dev_run_id!, "--expected-version", "1",
    "--file", file, "--archive-policy", transport.policy(), "--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture");
  let verification: { verification_id: string } | undefined;
  if (rejected) {
    const { report } = await x.invoke("verification", "template", "--candidate", candidate.candidate_id);
    for (const assessment of report.assessments) for (const criterion of assessment.criteria) {
      criterion.independent = { verdict: "rejected", explanation: "Fixture: required behavior is missing", evidence: [] };
      criterion.reconciliation = { claim_relation: "contradicted", explanation: "Fixture: claim exceeds implementation" };
      criterion.final = { verdict: "rejected", explanation: "Fixture: changes required" };
    }
    const reportFile = join(x.root, "rejected-verification.json"); writeFileSync(reportFile, JSON.stringify(report));
    verification = await x.invoke("verification", "submit", "--candidate", candidate.candidate_id, "--file", reportFile,
      "--operation-id", newUUIDv7(), "--agent-id", "fixture-verifier", "--agent-name", "Fixture verifier");
  }
  await beforeReclaim?.(x);
  const cleanup = new CodeWorkspaceCleanup(x.ledger.store, { policyCheck: archivePolicyFor(x.ledger.store, x.root, transport.policy()) });
  const location = { instance_id: x.instance.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  await cleanup.end({ ...location, ...actor(), expected_version: 0, retention_days: 0 });
  const plan = await cleanup.preview(location);
  await cleanup.reclaim({ ...location, ...actor(), expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest });
  return { ...x, candidate, committed, transport, verification, original: await x.service.instance(x.instance.instance_id) };
}

test("restoration allocates a new instance with immutable original context and Candidate provenance", async t => {
  const x = await archivedAndReclaimed(t);
  const request = { ...actor(), source_instance_id: x.instance.instance_id, candidate_id: x.candidate.candidate_id,
    host_id: x.hostId, context_policy: "original" as const };
  const restored = await x.service.restoreInstance(request);
  assert.notEqual(restored.instance_id, x.instance.instance_id);
  assert.equal(restored.issue_revision_id, x.original.issue_revision_id);
  assert.equal(restored.issue_id, x.original.issue_id);
  assert.deepEqual(restored.configuration, x.original.configuration);
  assert.equal(restored.state, "preparing");
  assert.equal(restored.execution_enabled, false);
  assert.equal(restored.lifecycle, undefined);
  assert.equal(restored.restoration!.candidate_id, x.candidate.candidate_id);
  assert.equal(restored.restoration!.source_instance_id, x.instance.instance_id);
  assert.equal(restored.restoration!.source_commit, `sha1:${x.committed.head}`);
  assert.deepEqual(await x.service.restoreInstance(request), restored);
  await assert.rejects(x.service.restoreInstance({ ...request, host_id: newUUIDv7() }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(x.service.restoreInstance({ ...request, ...actor(), context_policy: "latest" as "original" }), { code: "VALIDATION_ERROR" });
  await assert.rejects(x.service.restoreInstance({ ...request, ...actor(), source_instance_id: restored.instance_id }), { code: "STATE_CONFLICT" });
  assert.deepEqual(await x.service.instance(x.instance.instance_id), x.original);
  assert.deepEqual((await x.ledger.store.inspectIntegrity()).report.issues.filter(item => item.check === "idempotency"), []);
});

test("restoration keeps the original configuration body and aliases after configuration revision and reclamation", async t => {
  const x = await archivedAndReclaimed(t, true, false, async current => {
    const old = await current.service.configuration(current.configurationId);
    current.publish("new target after configuration revision\n");
    await current.service.saveConfiguration({ ...actor(), configuration_id: current.configurationId, expected_version: old.version,
      configuration: { name: "Changed selection", repositories: [{ repository_id: current.route.repository_id,
        alias: "renamed-orders", revision: { branch: "main" } }] } });
  });
  const latest = await x.service.configuration(x.configurationId);
  assert.equal(latest.configuration.name, "Changed selection");
  assert.equal(latest.configuration.repositories.length, 1);
  assert.notEqual(latest.revision_id, x.original.configuration.revision_id);
  const restored = await x.service.restoreInstance({ ...actor(), source_instance_id: x.instance.instance_id,
    candidate_id: x.candidate.candidate_id, host_id: x.hostId, context_policy: "original" });
  assert.deepEqual(restored.configuration, x.original.configuration);
  const prepared = await x.service.prepareInstance({ instance_id: restored.instance_id, host_id: x.hostId, data_root: x.dataRoot });
  assert.deepEqual(prepared.baselines.map(item => [item.alias, item.commit]), [["orders", x.firstCommit], ["payments", x.relatedCommit]]);
  assert.equal(readFileSync(join(prepared.baselines[0].path, "service.txt"), "utf8"), "first version\n");
  assert.equal(readFileSync(join(prepared.baselines[1].path, "service.txt"), "utf8"), "related service\n");
  assert.equal(existsSync(join(x.dataRoot, "workspaces", restored.instance_id, "baselines", "renamed-orders")), false);
  assert.equal(prepared.execution_enabled, false);
  assert.deepEqual(await x.service.instance(x.instance.instance_id), x.original);
  assert.deepEqual(await x.service.configuration(x.configurationId), latest);
});

test("restoration rejects missing or inconsistent configuration snapshots and the same request succeeds after repair", async t => {
  const x = await archivedAndReclaimed(t, true);
  const latest = await x.service.saveConfiguration({ ...actor(), configuration_id: x.configurationId,
    expected_version: x.original.configuration.version, configuration: { name: "Must not be used as fallback",
      repositories: [{ repository_id: x.route.repository_id, alias: "replacement", revision: { branch: "main" } }] } });
  const db = new DatabaseSync(x.ledgerPath);
  const saved = db.prepare("SELECT record_json, record_digest FROM runtime_records WHERE id = ?").get(x.instance.instance_id)!;
  const restore = () => db.prepare("UPDATE runtime_records SET record_json = ?, record_digest = ? WHERE id = ?")
    .run(saved.record_json, saved.record_digest, x.instance.instance_id);
  try {
    for (const damage of [
      (data: any) => { delete data.configuration; },
      (data: any) => { delete data.configuration.configuration; },
      (data: any) => { data.configuration.configuration.repositories[0].alias = "replacement"; },
    ]) {
      const record = JSON.parse(String(saved.record_json)); damage(record.data);
      // Corrupt only this disposable SQLite fixture. Matching the outer checksum is not semantic validity.
      db.prepare("UPDATE runtime_records SET record_json = ?, record_digest = ? WHERE id = ?")
        .run(JSON.stringify(record), sha256(record), x.instance.instance_id);
      const operation = newUUIDv7();
      const args = ["code-workspace", "restore", x.instance.instance_id, "--candidate", x.candidate.candidate_id,
        "--context", "original", "--data-root", x.dataRoot, "--operation-id", operation, "--agent-id", "fixture", "--agent-name", "Fixture"];
      const rejected = await x.raw(x.root, ...args);
      assert.notEqual(rejected.code, 0);
      assert.equal(rejected.envelope.error.code, "ARTIFACT_INTEGRITY_ERROR");
      restore();
      const recovered = (await x.invokeAt(x.root, ...args)).instance;
      assert.deepEqual(recovered.configuration, x.original.configuration);
      assert.equal(recovered.state, "preparing");
      assert.equal(recovered.execution_enabled, false);
      assert.deepEqual((await x.invokeAt(x.root, ...args)).instance, recovered);
      assert.deepEqual(await x.service.instance(x.instance.instance_id), x.original);
      assert.deepEqual(await x.service.configuration(x.configurationId), latest);
    }
  } finally { restore(); db.close(); }
});

test("restoration stops at unavailable fixed objects and resumes the same context after cache repair", async t => {
  const x = await archivedAndReclaimed(t, true);
  const restored = await x.service.restoreInstance({ ...actor(), source_instance_id: x.instance.instance_id,
    candidate_id: x.candidate.candidate_id, host_id: x.hostId, context_policy: "original" });
  const related = x.original.baselines.find(item => item.alias === "payments")!;
  const objects = join(x.dataRoot, "cache", "repos", related.repository_id, "objects");
  const backup = join(x.root, "saved-related-objects"), offline = join(x.root, "offline-remote.git");
  const location = { instance_id: restored.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  renameSync(objects, backup); mkdirSync(objects); renameSync(x.remote, offline);
  try {
    await assert.rejects(x.service.prepareInstance({ ...location, allow_cached: true }), { code: "BASELINE_UNAVAILABLE" });
    const blocked = await x.service.instance(restored.instance_id);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.execution_enabled, false);
    assert.deepEqual(blocked.configuration, x.original.configuration);
    assert.deepEqual(blocked.baselines.map(item => [item.alias, item.commit, item.materialized]), [["orders", x.firstCommit, true]]);
    await assert.rejects(x.routes.prepare({ ...actor(), ...location, issue_slug: "incomplete-context" }), { code: "STATE_CONFLICT" });
    // Restore only the disposable fixture's objects; the remote stays offline.
    rmSync(objects, { recursive: true }); renameSync(backup, objects);
    const prepared = await x.service.prepareInstance({ ...location, allow_cached: true });
    assert.equal(prepared.state, "prepared");
    assert.equal(prepared.execution_enabled, false);
    assert.deepEqual(prepared.baselines[0], blocked.baselines[0]);
    assert.deepEqual(prepared.baselines.map(item => [item.alias, item.commit, item.refresh]),
      [["orders", x.firstCommit, "cached"], ["payments", x.relatedCommit, "cached"]]);
    assert.equal(readFileSync(join(prepared.baselines[1].path, "service.txt"), "utf8"), "related service\n");
    assert.deepEqual(await x.service.instance(x.instance.instance_id), x.original);
  } finally {
    if (existsSync(backup)) { rmSync(objects, { recursive: true }); renameSync(backup, objects); }
    renameSync(offline, x.remote);
  }
});

test("restoration prepares the original repository commits even after their remote branches advance", async t => {
  const x = await archivedAndReclaimed(t, true);
  const restored = await x.service.restoreInstance({ ...actor(), source_instance_id: x.instance.instance_id,
    candidate_id: x.candidate.candidate_id, host_id: x.hostId, context_policy: "original" });
  x.publish("new target\n");
  git(["checkout", "related"], { cwd: x.writer });
  x.publish("new related service\n");
  const prepared = await x.service.prepareInstance({ instance_id: restored.instance_id, host_id: x.hostId, data_root: x.dataRoot });
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.baselines.find(item => item.alias === "orders")!.commit, x.firstCommit);
  assert.equal(prepared.baselines.find(item => item.alias === "payments")!.commit, x.relatedCommit);
  for (const baseline of prepared.baselines) {
    assert.equal(git(["rev-parse", "HEAD"], { cwd: baseline.path }), baseline.commit.split(":")[1]);
    assert.ok(baseline.path.includes(restored.instance_id));
  }
  const route = await x.routes.prepare({ ...actor(), instance_id: restored.instance_id, host_id: x.hostId, data_root: x.dataRoot, issue_slug: "stale-target" });
  const bound = await x.routes.bindDevRun({ ...actor(), route_id: route.route_id, host_id: x.hostId, data_root: x.dataRoot });
  const actorArgs = () => ["--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"];
  const observed = await x.invokeAt(route.path, "preflight", "observe", "--phase", "start", "--dev-run", bound.dev_run_id!, "--refresh", ...actorArgs());
  const file = join(x.root, "stale-assessment.json");
  writeFileSync(file, JSON.stringify({ assessment: "applicable", rationale: "Cannot override target drift", affected: [] }));
  const assessed = await x.invokeAt(route.path, "preflight", "assess", "--observation", observed.observation_id, "--file", file, ...actorArgs());
  const rejected = await x.raw(route.path, "devrun", "admit", "--dev-run", bound.dev_run_id!, "--preflight", assessed.assessment_id, "--refresh", ...actorArgs());
  assert.equal(rejected.envelope.error.code, "STATE_CONFLICT");
  assert.equal(git(["rev-parse", "HEAD"], { cwd: route.path }), x.committed.head);
  assert.equal((await x.routes.show(route.route_id)).base_commit, x.firstCommit);
  assert.deepEqual(await x.service.instance(x.instance.instance_id), x.original);
});

test("restoration creates a fresh route from the archived Candidate and binds a preparing refinement", async t => {
  const x = await archivedAndReclaimed(t);
  const restored = await x.service.restoreInstance({ ...actor(), source_instance_id: x.instance.instance_id,
    candidate_id: x.candidate.candidate_id, host_id: x.hostId, context_policy: "original" });
  await x.service.prepareInstance({ instance_id: restored.instance_id, host_id: x.hostId, data_root: x.dataRoot });
  const request = { ...actor(), instance_id: restored.instance_id, host_id: x.hostId, data_root: x.dataRoot, issue_slug: "retry" };
  x.transport.fail(true);
  await assert.rejects(x.routes.prepare(request), { code: "BASELINE_UNAVAILABLE" });
  x.transport.fail(false);
  const repair = x.failAfterGit("worktree");
  try { await assert.rejects(x.routes.prepare(request)); } finally { repair(); }
  const route = await x.routes.prepare(request);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: route.path }), x.committed.head);
  assert.equal(readFileSync(join(route.path, "service.txt"), "utf8"), "restorable work\n");
  assert.equal(route.base_commit, x.firstCommit);
  const bound = await x.routes.bindDevRun({ ...actor(), route_id: route.route_id, host_id: x.hostId, data_root: x.dataRoot });
  const run = await x.ledger.module.showDevRun(bound.dev_run_id!);
  assert.equal(run.refines_candidate_id, x.candidate.candidate_id);
  assert.equal(bound.base_commit, x.firstCommit);
  assert.equal((await new PreflightService(x.ledger.store, route.path).devRunReadModel(run.dev_run_id))?.state, "preparing");
  await assert.rejects(x.ledger.module.assertDevelopmentAdmission(run.dev_run_id), { code: "STATE_CONFLICT" });
  await x.invokeAt(route.path, "devrun", "abandon", "--dev-run", run.dev_run_id, "--expected-version", "1",
    "--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture");
  const cleanup = new CodeWorkspaceCleanup(x.ledger.store, { policyCheck: archivePolicyFor(x.ledger.store, x.root, x.transport.policy()) });
  const location = { instance_id: restored.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  await cleanup.end({ ...location, ...actor(), expected_version: 0, retention_days: 0 });
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "later work"], { cwd: route.path });
  assert.equal((await cleanup.preview(location)).resources.find(item => item.kind === "development")!.reason, "unarchived_commit");
  const later = git(["rev-parse", "HEAD"], { cwd: route.path });
  git(["update-ref", `refs/heads/${route.development.branch}`, x.committed.head, later], { cwd: route.path });
  const plan = await cleanup.preview(location);
  assert.equal(plan.resources.find(item => item.kind === "development")!.state, "eligible", "the unchanged archived parent preserves a cancelled restoration");
  await cleanup.reclaim({ ...location, ...actor(), expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest });
  assert.equal((await x.service.instance(restored.instance_id)).lifecycle?.state, "code_reclaimed");
});

test("CLI restoration admits actual Candidate inputs and archives subsequent work as a new refinement", async t => {
  const x = await archivedAndReclaimed(t, false, true);
  const actorArgs = () => ["--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"];
  const invoke = (...args: string[]) => x.invokeAt(x.root, ...args);
  const restoreArgs = ["code-workspace", "restore", x.instance.instance_id, "--candidate", x.candidate.candidate_id,
    "--context", "original", "--data-root", x.dataRoot, ...actorArgs()];
  const result = await invoke(...restoreArgs), instance = result.instance;
  assert.deepEqual(await invoke(...restoreArgs), result);
  await invoke("code-workspace", "prepare", instance.instance_id, "--data-root", x.dataRoot);
  const { route } = await invoke("code-workspace", "route-prepare", instance.instance_id, "--issue-slug", "retry",
    "--data-root", x.dataRoot, ...actorArgs());
  const { route: bound } = await invoke("code-workspace", "route-bind", "--development-mode", "container", route.route_id, "--data-root", x.dataRoot, ...actorArgs());
  const atRoute = (...args: string[]) => x.invokeAt(route.path, ...args);
  const context = await atRoute("devrun", "context", "--dev-run", bound.dev_run_id);
  assert.equal(context.context.base_commit, x.firstCommit);
  assert.equal(context.context.refinement.parent_candidate_id, x.candidate.candidate_id);
  assert.deepEqual(context.context.refinement.frozen_verifications.map((item: { verification_id: string }) => item.verification_id), [x.verification!.verification_id]);
  assert.equal(context.context.refinement.frozen_verifications[0].overall_verdict, "rejected");
  const observation = await atRoute("preflight", "observe", "--phase", "start", "--dev-run", bound.dev_run_id, "--refresh", ...actorArgs());
  const assessmentFile = join(x.root, "assessment.json");
  writeFileSync(assessmentFile, JSON.stringify({ assessment: "applicable", rationale: "Reviewed the restored Candidate and original context", affected: [] }));
  const assessment = await atRoute("preflight", "assess", "--observation", observation.observation_id, "--file", assessmentFile, ...actorArgs());
  await atRoute("devrun", "admit", "--dev-run", bound.dev_run_id, "--preflight", assessment.assessment_id, "--refresh", ...actorArgs());
  const managed = new CodeRouteGit(x.ledger.store, route.route_id);
  writeFileSync(join(route.path, "service.txt"), "refined work\n");
  await managed.apply({ ...actor(), action: "stage", snapshot: await managed.snapshot(["service.txt"]) });
  const committed = await managed.apply({ ...actor(), action: "commit", snapshot: await managed.snapshot([]),
    message: "Refine the Candidate", author: { name: "Agent", email: "agent@example.invalid" } });
  const file = await submission({ ...x, route: bound, invoke: atRoute });
  const candidate = await atRoute("candidate", "submit", "--dev-run", bound.dev_run_id, "--expected-version", "1",
    "--file", file, "--archive-policy", x.transport.policy(), ...actorArgs());
  assert.notEqual(candidate.candidate_id, x.candidate.candidate_id);
  await assert.rejects(x.service.restoreInstance({ ...actor(), source_instance_id: x.instance.instance_id,
    candidate_id: candidate.candidate_id, context_policy: "original", host_id: x.hostId }), { code: "VALIDATION_ERROR" });
  assert.equal(candidate.source.commit, `sha1:${committed.head}`);
  assert.equal(git(["rev-parse", `refs/tags/grounds/candidates/${x.candidate.candidate_id}`], { gitDir: x.remote }), x.committed.head);
  assert.deepEqual(await x.service.instance(x.instance.instance_id), x.original);
});

test("a synchronized Candidate keeps its new base through cleanup and original-context restoration", async t => {
  const x = await fixture(t), who = () => ["--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"];
  const committed = await x.commit("implemented against base\n");
  // Advance a different file upstream so the merge is unambiguous.
  writeFileSync(join(x.writer, "upstream.txt"), "upstream addition\n");
  git(["add", "upstream.txt"], { cwd: x.writer });
  git(["commit", "-qm", "upstream advance"], { cwd: x.writer });
  git(["push", "-q", "origin", "HEAD"], { cwd: x.writer });
  const target = `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`;
  await x.invoke("devrun", "sync", "--dev-run", x.route.dev_run_id!, "--expected-version", "1", "--target-commit", target,
    "--expected-head", `sha1:${committed.head}`, "--refresh", ...who());
  await x.admit();
  const merged = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  const transport = archiveCLITransport(t, x.root, x.remote, x.ledger.repository.repository_id);
  git(["config", "--unset-all", fURL(x.remote)], { cwd: x.route.path });
  const candidate = await x.invoke("candidate", "submit", "--dev-run", x.route.dev_run_id!, "--expected-version", "3",
    "--file", await submission(x), "--archive-policy", transport.policy(), ...who());
  assert.equal(candidate.source.commit, `sha1:${merged}`);
  assert.equal((await x.invoke("candidate", "show", "--candidate", candidate.candidate_id)).candidate.git_artifact.binding.base_commit, target);
  const cleanup = new CodeWorkspaceCleanup(x.ledger.store, { policyCheck: archivePolicyFor(x.ledger.store, x.root, transport.policy()) });
  const location = { instance_id: x.instance.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  await cleanup.end({ ...location, ...actor(), expected_version: 0, retention_days: 0 });
  const plan = await cleanup.preview(location);
  assert.ok(plan.resources.every(item => item.state === "eligible"), JSON.stringify(plan.resources));
  await cleanup.reclaim({ ...location, ...actor(), expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest });
  const restored = await x.invokeAt(x.root, "code-workspace", "restore", x.instance.instance_id, "--candidate", candidate.candidate_id,
    "--context", "original", "--data-root", x.dataRoot, ...who());
  const instanceId = restored.instance.instance_id;
  const prepared = await x.service.prepareInstance({ instance_id: instanceId, host_id: x.hostId, data_root: x.dataRoot });
  assert.equal(prepared.baselines[0]!.commit, x.firstCommit, "reading context stays at B");
  const route = await x.routes.prepare({ ...actor(), instance_id: instanceId, host_id: x.hostId, data_root: x.dataRoot, issue_slug: "synced-refinement" });
  assert.equal(route.base_commit, target, "new route starts with Candidate base T");
  assert.equal(git(["rev-parse", "HEAD"], { cwd: route.path }), merged);
  const bound = await x.routes.bindDevRun({ ...actor(), route_id: route.route_id, host_id: x.hostId, data_root: x.dataRoot });
  const atRoute = (...args: string[]) => x.invokeAt(route.path, ...args);
  const observed = await atRoute("preflight", "observe", "--phase", "start", "--dev-run", bound.dev_run_id!, "--refresh", ...who());
  const assessmentFile = join(x.root, "restored-assessment.json");
  writeFileSync(assessmentFile, JSON.stringify({ assessment: "applicable", rationale: "Reviewed restored source", affected: [] }));
  const assessed = await atRoute("preflight", "assess", "--observation", observed.observation_id, "--file", assessmentFile, ...who());
  await atRoute("devrun", "admit", "--dev-run", bound.dev_run_id!, "--preflight", assessed.assessment_id, "--refresh", ...who());
  assert.equal((await new CodeRouteGit(x.ledger.store, route.route_id).snapshot([])).head, merged);
  await x.invokeAt(route.path, "devrun", "abandon", "--dev-run", bound.dev_run_id!, "--expected-version", "1", ...who());
  const freshLocation = { ...location, instance_id: instanceId };
  await cleanup.end({ ...freshLocation, ...actor(), expected_version: 0, retention_days: 0 });
  const freshPlan = await cleanup.preview(freshLocation);
  assert.ok(freshPlan.resources.every(item => item.state === "eligible"), JSON.stringify(freshPlan.resources));
  await cleanup.reclaim({ ...freshLocation, ...actor(), expected_version: freshPlan.lifecycle_version, plan_digest: freshPlan.plan_digest });
  assert.equal(git(["rev-parse", `refs/tags/grounds/candidates/${candidate.candidate_id}`], { gitDir: x.remote }), merged);
});
