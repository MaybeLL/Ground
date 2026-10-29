import { CodeWorkspaceCleanup } from "../src/code-workspace-cleanup.js";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { codeRouteFencePath } from "../src/code-route-fence.js";
import { withRuntimeLock } from "../src/runtime-files.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";
import { isRouteLeased } from "../src/env-route-lease.js";
import { CodeWorkspaceRoutes } from "../src/code-workspace-route.js";
import { PreflightService } from "../src/preflight.js";
import { hostIdentity } from "../src/runtime-files.js";
import { newUUIDv7 } from "../src/identity.js";
import { git } from "../src/env-git.js";
import { codeWorkspaceFixture } from "./code-workspace-fixture.js";
import { reviseTargetIssue } from "./preflight-fixture.js";
import { testAgent } from "./fixture.js";

const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
async function fixture(t: TestContext) {
  const x = await codeWorkspaceFixture(t);
  const canonical = "ssh://git@example.test/team/repo";
  git(["remote", "set-url", "origin", canonical], { cwd: x.writer });
  git(["config", `url.file://${x.remote}.insteadOf`, canonical], { cwd: x.writer });
  await reviseTargetIssue(x.ledger.module, x.ledger.store, x.writer, {
    ...actor(), issue_id: x.ledger.issue.issue_id, expected_predecessor_id: x.ledger.issue.issue_revision_id,
    requirement_revision_id: x.ledger.requirement.requirement_revision_id, requirement_revision_explicit: true,
    baseline: { git_oid: x.firstCommit, reachability: "remote_tracking_reachable" },
    input: { format: 1, summary: "Workspace target", target_branch: { remote: "origin", ref: "refs/heads/main" },
      goals: [{ statement: "Implement the issue", criteria: ["Preserve the fixed context"] }] },
  });
  const hostId = hostIdentity(join(x.dataRoot, "runtime"));
  const instance = await x.service.createInstance({ ...actor(), configuration_id: x.configurationId, configuration_version: 1,
    issue_id: x.ledger.issue.issue_id, issue_version: 2, host_id: hostId });
  await x.service.prepareInstance({ instance_id: instance.instance_id, host_id: hostId, data_root: x.dataRoot });
  const cache = join(x.dataRoot, "cache", "repos", instance.target_repository_id);
  git(["config", "remote.origin.url", canonical], { gitDir: cache });
  git(["config", `url.file://${x.remote}.insteadOf`, canonical], { gitDir: cache });
  const routes = new CodeWorkspaceRoutes(x.ledger.store);
  const route = await routes.prepare({ ...actor(), instance_id: instance.instance_id, host_id: hostId,
    data_root: x.dataRoot, issue_slug: "target" });
  const request = { ...actor(), route_id: route.route_id, host_id: hostId, data_root: x.dataRoot };
  return { ...x, hostId, instance, routes, route, request };
}

test("a prepared route binds exactly one preparing DevRun and keeps execution reserved", async t => {
  const x = await fixture(t);
  const bound = await x.routes.bindDevRun(x.request);
  assert.equal(bound.dev_run_id, x.request.operation_id);
  assert.equal(bound.execution_enabled, false);
  const context = await x.ledger.module.devRunContext(bound.dev_run_id!);
  assert.equal(context.context.issue.id, x.ledger.issue.issue_id);
  assert.equal(context.context.base_commit, x.firstCommit);
  assert.deepEqual(context.context.dev_run.development, x.route.development);
  const preflight = new PreflightService(x.ledger.store, x.route.path);
  assert.equal((await preflight.devRunReadModel(bound.dev_run_id!))?.state, "preparing");
  await assert.rejects(x.ledger.module.assertDevelopmentAdmission(bound.dev_run_id!), { code: "STATE_CONFLICT" });
  assert.deepEqual(await new CodeWorkspaceRoutes(x.ledger.store).bindDevRun(x.request), bound);
  await assert.rejects(x.routes.bindDevRun({ ...x.request, ...actor() }), { code: "STATE_CONFLICT" });
});

test("new route admission checks actual code and target, and a new preparation supersedes admission", async t => {
  const x = await fixture(t);
  const bound = await x.routes.bindDevRun(x.request);
  const devRunId = bound.dev_run_id!;
  const service = new PreflightService(x.ledger.store, x.route.path);
  const assess = async () => {
    const observed = await service.observe({ ...actor(), phase: "start", dev_run_id: devRunId, refresh: true });
    const assessed = await service.assess({ ...actor(), observation_id: observed.id,
      file: { assessment: "applicable", rationale: "Reviewed the actual route and target", affected: [] } });
    return assessed.id;
  };
  const assessmentId = await assess();
  writeFileSync(join(x.route.path, "service.txt"), "changed after assessment\n");
  await assert.rejects(service.admit({ ...actor(), dev_run_id: devRunId, assessment_id: assessmentId, refresh: true }), { code: "STATE_CONFLICT" });
  const revisedAssessment = await assess();
  const admission = { ...actor(), dev_run_id: devRunId, assessment_id: revisedAssessment, refresh: true };
  await service.admit(admission);
  await x.ledger.module.assertDevelopmentAdmission(devRunId);
  assert.equal((await x.routes.show(bound.route_id)).execution_enabled, false);
  assert.equal(isRouteLeased(bound.path), true, "admission does not release the preparation fence");
  await service.markPreparing({ ...actor(), dev_run_id: devRunId });
  await service.admit(admission); // Historical replay is not renewed permission.
  await assert.rejects(x.ledger.module.assertDevelopmentAdmission(devRunId), { code: "STATE_CONFLICT" });
  x.publish("remote moved\n");
  await assert.rejects(service.admit({ ...admission, ...actor() }), { code: "STATE_CONFLICT" });
});

test("binding rejects foreign locations before writing and observations retain the route lock and fence", async t => {
  const x = await fixture(t);
  const wrongRoot = join(x.root, "foreign-root");
  await assert.rejects(x.routes.bindDevRun({ ...x.request, data_root: wrongRoot }), { code: "VALIDATION_ERROR" });
  assert.equal(existsSync(wrongRoot), false);
  await assert.rejects(x.routes.bindDevRun({ ...x.request, host_id: newUUIDv7() }), { code: "VALIDATION_ERROR" });
  assert.equal((await x.routes.show(x.route.route_id)).dev_run_id, undefined);
  const bound = await x.routes.bindDevRun(x.request);
  const observe = () => new PreflightService(x.ledger.store, x.route.path).observe({ ...actor(), phase: "start", dev_run_id: bound.dev_run_id!, refresh: true });
  await withRuntimeLock(join(x.dataRoot, "runtime"), `code-route:${x.route.route_id}`, async () => {
    await assert.rejects(observe(), { code: "STATE_CONFLICT" });
    await assert.rejects(x.routes.bindDevRun(x.request), { code: "STATE_CONFLICT" });
  });
  await assert.rejects(new PreflightService(x.ledger.store, x.writer).observe({ ...actor(), phase: "start", dev_run_id: bound.dev_run_id!, refresh: true }), { code: "WORKTREE_MISMATCH" });
  const fencePath = codeRouteFencePath(x.route.path), fence = readFileSync(fencePath);
  rmSync(fencePath);
  await assert.rejects(observe(), { code: "WORKTREE_MISMATCH" });
  assert.equal(existsSync(fencePath), false);
  writeFileSync(fencePath, fence, { mode: 0o600 });
  assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "first version\n");
});

test("CLI binds the route and observes its real inputs through the existing preflight commands", async t => {
  const x = await fixture(t);
  const config = join(x.root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const invoke = async (args: string[]) => {
    const output: string[] = [];
    const code = await runCLI([...args, "--config", config, "--json"], { cwd: x.route.path,
      stdout: line => output.push(line), stderr: () => {} });
    const envelope = JSON.parse(output.join("\n"));
    assert.equal(code, 0, JSON.stringify(envelope));
    assertContract("cli-envelope.schema.json", envelope);
    return envelope.data;
  };
  const binding = ["code-workspace", "route-bind", "--development-mode", "container", x.route.route_id, "--data-root", x.dataRoot,
    "--operation-id", x.request.operation_id, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const wrongRoot = join(x.root, "wrong-cli-root");
  assert.equal(await runCLI([...binding.map(value => value === x.dataRoot ? wrongRoot : value), "--config", config, "--json"],
    { cwd: x.route.path, stdout: () => {}, stderr: () => {} }), 2);
  assert.equal(existsSync(wrongRoot), false, "invalid binding must not create a host identity or locks");
  const result = await invoke(binding);
  assert.equal(result.route.dev_run_id, x.request.operation_id);
  assert.equal(result.route.execution_enabled, false);
  assert.deepEqual(await invoke(binding), result);
  const observed = await invoke(["preflight", "observe", "--phase", "start", "--dev-run", result.route.dev_run_id,
    "--refresh", "--agent-id", "fixture", "--agent-name", "Fixture"]);
  assert.equal(observed.binds.dev_run_id, result.route.dev_run_id);
  const file = join(x.root, "assessment.json");
  writeFileSync(file, JSON.stringify({ assessment: "applicable", rationale: "Reviewed actual code and refreshed target", affected: [] }));
  const assessment = await invoke(["preflight", "assess", "--observation", observed.observation_id, "--file", file,
    "--agent-id", "fixture", "--agent-name", "Fixture"]);
  await invoke(["devrun", "admit", "--dev-run", result.route.dev_run_id, "--preflight", assessment.assessment_id,
    "--refresh", "--agent-id", "fixture", "--agent-name", "Fixture"]);
  const preparing = await invoke(["devrun", "prepare", "--dev-run", result.route.dev_run_id,
    "--agent-id", "fixture", "--agent-name", "Fixture"]);
  assert.equal(preparing.preflight.state, "preparing");
  assert.equal(preparing.local_worktree, undefined, "new routes must not report the old journal's physical state");
});

test("a legacy Issue without a target cannot bypass admission through a new route", async t => {
  const x = await codeWorkspaceFixture(t);
  const instance = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  const routes = new CodeWorkspaceRoutes(x.ledger.store);
  const route = await routes.prepare({ ...actor(), instance_id: instance.instance_id, host_id: x.hostId, data_root: x.dataRoot, issue_slug: "legacy" });
  const request = { ...actor(), route_id: route.route_id, host_id: x.hostId, data_root: x.dataRoot };
  await assert.rejects(routes.bindDevRun(request), { code: "VALIDATION_ERROR" });
  assert.equal((await routes.show(route.route_id)).dev_run_id, undefined);
  await assert.rejects(x.ledger.module.devRunContext(request.operation_id), { code: "NOT_FOUND" });
});

test("Workspace creation and route binding remain valid in ledger integrity", async t => {
  const x = await fixture(t);
  await x.routes.bindDevRun(x.request);
  assert.deepEqual((await x.ledger.store.inspectIntegrity()).report, { valid: true, issues: [] });
});

test("DevRun reads find the Workspace route while legacy cleanup cannot remove it", async t => {
  const x = await fixture(t), bound = await x.routes.bindDevRun(x.request);
  const config = join(x.root, "read-config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const run = async (args: string[]) => {
    const output: string[] = [];
    const code = await runCLI(["devrun", ...args, "--config", config, "--json"], { cwd: x.writer,
      stdout: line => output.push(line), stderr: () => {} });
    const envelope = JSON.parse(output.join("\n"));
    assertContract("cli-envelope.schema.json", envelope);
    return { code, envelope };
  };
  const index = git(["rev-parse", "--git-path", "index"], { cwd: bound.path });
  const originalIndex = readFileSync(index);
  const originalRefs = git(["show-ref"], { cwd: bound.path });
  for (const action of ["context", "show"]) {
    const read = await run([action, "--dev-run", bound.dev_run_id!]);
    assert.equal(read.code, 0, JSON.stringify(read.envelope));
    assert.equal(read.envelope.data.local_worktree.status, "available");
    assert.equal(read.envelope.data.local_worktree.path, bound.path);
    assert.deepEqual(read.envelope.data.local_worktree.development, bound.development);
  }
  const reconciled = await run(["reconcile", "--dev-run", bound.dev_run_id!]);
  assert.equal(reconciled.envelope.data.local_worktree.status, "available", JSON.stringify(reconciled.envelope));
  assert.equal(reconciled.envelope.data.route_lease.held, false, "preparation fence is not an active execution");
  const preview = await run(["cleanup", "--dev-run", bound.dev_run_id!, "--preview"]);
  assert.equal(preview.envelope.data.preview.local_worktree.status, "available");
  assert.deepEqual(preview.envelope.data.preview.options, ["keep"]);
  const refused = await run(["cleanup", "--dev-run", bound.dev_run_id!, "--choice", "worktree", "--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.envelope.error.message, /code-workspace/);
  assert.ok(existsSync(bound.path));
  writeFileSync(join(bound.path, "new.txt"), "uncommitted work\n");
  assert.equal((await run(["context", "--dev-run", bound.dev_run_id!])).envelope.data.local_worktree.working_tree_dirty, true);
  const dirty = await run(["reconcile", "--dev-run", bound.dev_run_id!]);
  assert.equal(dirty.envelope.data.local_worktree.untracked, 1);
  assert.equal(dirty.envelope.data.local_worktree.uncaptured_changes, true);
  const fencePath = codeRouteFencePath(bound.path), fence = readFileSync(fencePath);
  writeFileSync(fencePath, "{}");
  assert.equal((await run(["context", "--dev-run", bound.dev_run_id!])).envelope.data.local_worktree.status, "invalid");
  writeFileSync(fencePath, fence);
  assert.deepEqual(readFileSync(index), originalIndex, "observations do not refresh the shared index");
  assert.equal(git(["show-ref"], { cwd: bound.path }), originalRefs, "observations do not update refs");
  const hostPath = join(x.dataRoot, "runtime", "host-id");
  writeFileSync(hostPath, newUUIDv7());
  assert.deepEqual((await run(["context", "--dev-run", bound.dev_run_id!])).envelope.data.local_worktree,
    { status: "missing", reason: "not_available_on_this_machine" });
  writeFileSync(hostPath, x.hostId);
  rmSync(join(bound.path, "new.txt")); // This test's known, reproducible input only.
  await x.routes.abandon(bound.route_id, bound.dev_run_id!, bound.path, () => x.ledger.module.abandonDevRun({ ...actor(),
    dev_run_id: bound.dev_run_id!, expected_version: 1 }));
  const cleanup = new CodeWorkspaceCleanup(x.ledger.store), location = { instance_id: x.instance.instance_id,
    host_id: x.hostId, data_root: x.dataRoot };
  await cleanup.end({ ...actor(), ...location, expected_version: 0, retention_days: 0 });
  const plan = await cleanup.preview(location);
  await cleanup.reclaim({ ...actor(), ...location, expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest });
  const removed = await run(["show", "--dev-run", bound.dev_run_id!]);
  assert.equal(removed.code, 0, JSON.stringify(removed.envelope));
  assert.equal(removed.envelope.data.local_worktree.status, "removed");
});
