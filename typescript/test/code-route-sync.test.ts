import { DevRunSyncService } from "../src/devrun-sync-service.js";
import { CodeRouteSyncWorkspace } from "../src/code-route-sync.js";
import { CodeRouteExecutions, type RouteEngine, type RouteExecution } from "../src/code-route-execution.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { CodeRouteGit } from "../src/code-route-git.js";
import { git } from "../src/env-git.js";
import { newUUIDv7 } from "../src/identity.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";

const actorArgs = () => ["--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"];
async function fixture(t: Parameters<typeof executionFixture>[0], conflict = false) {
  const x = await executionFixture(t);
  const config = join(x.root, "cli-config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const raw = async (...args: string[]) => {
    const output: string[] = [];
    const code = await runCLI([...args, "--config", config, "--json"], { cwd: x.route.path,
      stdout: line => output.push(line), stderr: () => {} });
    const envelope = JSON.parse(output.join("\n")); assertContract("cli-envelope.schema.json", envelope);
    return { code, envelope };
  };
  const invoke = async (...args: string[]) => {
    const result = await raw(...args); assert.equal(result.code, 0, JSON.stringify(result.envelope)); return result.envelope.data;
  };
  const managed = new CodeRouteGit(x.ledger.store, x.route.route_id), name = conflict ? "service.txt" : "feature.txt";
  writeFileSync(join(x.route.path, name), "our implementation\n");
  await managed.apply({ ...actor(), action: "stage", snapshot: await managed.snapshot([name]) });
  const source = await managed.apply({ ...actor(), action: "commit", snapshot: await managed.snapshot([]),
    message: "Implement feature", author: { name: "Agent", email: "agent@example.invalid" } });
  const target = x.publish("upstream change\n");
  const args = ["devrun", "sync", "--dev-run", x.route.dev_run_id!, "--expected-version", "1", "--target-commit", target,
    "--expected-head", `sha1:${source.head}`, "--refresh", ...actorArgs()];
  return { ...x, config, raw, invoke, managed, source, target, args };
}

test("code route sync preserves both histories and fixed context while advancing the DevRun base", async t => {
  const x = await fixture(t);
  for (const [option, replacement] of [["--expected-head", x.firstCommit], ["--target-commit", x.firstCommit]]) {
    const stale = [...x.args]; stale[stale.indexOf(option!) + 1] = replacement!;
    assert.equal((await x.raw(...stale)).envelope.error.code, "STATE_CONFLICT");
    assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), x.source.head);
    assert.equal((await x.ledger.module.showDevRun(x.route.dev_run_id!)).version, 1);
  }
  const result = await x.invoke(...x.args);
  assert.equal(result.sync.data.phase, "completed");
  const merge = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  assert.equal(git(["show", "-s", "--format=%P", merge], { cwd: x.route.path }), `${x.source.head} ${x.target.split(":")[1]}`);
  assert.equal(readFileSync(join(x.route.path, "feature.txt"), "utf8"), "our implementation\n");
  assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "upstream change\n");
  const context = await x.invoke("devrun", "context", "--dev-run", x.route.dev_run_id!);
  assert.equal(context.context.base_commit, x.target);
  assert.equal(context.context.dev_run.initial_base_commit, x.firstCommit);
  const instance = await x.service.instance(x.instance.instance_id);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: instance.baselines[0]!.path }), x.firstCommit.split(":")[1]);
  assert.equal((await x.preflight.devRunReadModel(x.route.dev_run_id!))?.state, "preparing");
  await assert.rejects(x.ledger.module.assertDevelopmentAdmission(x.route.dev_run_id!), { code: "STATE_CONFLICT" });
  await x.admit();
  assert.equal((await x.managed.snapshot([])).head, merge);
  assert.equal((await x.invoke(...x.args)).sync.id, result.sync.id);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), merge);
});

// External execution boundary only; Git, preflight and the ledger remain real.
class Engine implements RouteEngine {
  containers = new Set<string>();
  async identity() { return "sync-test-engine"; }
  async create(run: RouteExecution) { this.containers.add(run.execution_id); return run.execution_id; }
  async find(run: RouteExecution) { return this.containers.has(run.execution_id) ? run.execution_id : undefined; }
  async start() {}
  paused = new Set<string>();
  async pause(run: RouteExecution) { this.paused.add(run.execution_id); }
  async assertPaused(run: RouteExecution) { assert.ok(this.paused.has(run.execution_id)); }
  async resume(run: RouteExecution) { this.paused.delete(run.execution_id); }
  async removeStopped(run: RouteExecution) { this.containers.delete(run.execution_id); }
}
const image = `sha256:${"1".repeat(64)}`;

test("a synced route can execute after fresh admission and excludes sync while running or paused", async t => {
  const x = await fixture(t);
  await x.invoke(...x.args);
  const engine = new Engine(), executions = new CodeRouteExecutions(x.ledger.store, engine);
  const request = { ...actor(), route_id: x.route.route_id, image, argv: ["true"] };
  await assert.rejects(executions.start(request), { code: "STATE_CONFLICT" });
  assert.equal(engine.containers.size, 0);
  await x.admit();
  const execution = await executions.start(request);
  const ref = { route_id: x.route.route_id, execution_id: execution.execution_id };
  const next = x.publish("second upstream\n"), head = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  const args = ["devrun", "sync", "--dev-run", x.route.dev_run_id!, "--expected-version", "3", "--target-commit", next,
    "--expected-head", `sha1:${head}`, "--refresh", ...actorArgs()];
  assert.equal((await x.raw(...args)).envelope.error.code, "STATE_CONFLICT");
  await executions.pause({ ...ref, ...actor() });
  assert.equal((await x.raw(...args)).envelope.error.code, "STATE_CONFLICT");
  assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), head);
  await executions.stop(ref);
  assert.equal((await x.invoke(...args)).sync.data.phase, "completed");
});

test("a pending conflict excludes other route actions and completes only with staged resolution and decisions", async t => {
  const x = await fixture(t, true);
  const { sync } = await x.invoke(...x.args);
  assert.equal(sync.data.phase, "resolving");
  assert.deepEqual(sync.data.conflicts, ["service.txt"]);
  assert.equal((await x.invoke("devrun", "sync-status", "--dev-run", x.route.dev_run_id!)).status.base_commit, x.firstCommit);
  await assert.rejects(x.managed.snapshot([]), { code: "STATE_CONFLICT" });
  assert.equal((await x.raw("candidate", "template", "--dev-run", x.route.dev_run_id!)).envelope.error.code, "STATE_CONFLICT");
  assert.equal((await x.raw("devrun", "abandon", "--dev-run", x.route.dev_run_id!, "--expected-version", "2", ...actorArgs())).envelope.error.code, "STATE_CONFLICT");
  await assert.rejects(x.admit(), { code: "STATE_CONFLICT" });
  const other = [...x.args]; other[other.indexOf("--operation-id") + 1] = newUUIDv7();
  assert.equal((await x.raw(...other)).envelope.error.code, "STATE_CONFLICT");
  const engine = new Engine();
  await assert.rejects(new CodeRouteExecutions(x.ledger.store, engine).start({ ...actor(), route_id: x.route.route_id, image, argv: ["true"] }), { code: "STATE_CONFLICT" });
  assert.equal(engine.containers.size, 0);
  const complete = ["devrun", "sync-complete", "--sync", sync.id, "--expected-version", String(sync.version)];
  assert.equal((await x.raw(...complete, ...actorArgs())).envelope.error.code, "VALIDATION_ERROR");
  // Conflict resolution is an explicit trusted-host action, outside the container Git channel.
  writeFileSync(join(x.route.path, "service.txt"), "resolved with both requirements\n");
  git(["add", "service.txt"], { cwd: x.route.path });
  const decisions = join(x.root, "decisions.json");
  writeFileSync(decisions, JSON.stringify([{ path: "service.txt", explanation: "Preserve upstream and issue requirements" }]));
  const args = [...complete, "--file", decisions, ...actorArgs()];
  assert.equal((await x.invoke(...args)).sync.data.phase, "completed");
  assert.equal((await x.invoke(...args)).sync.data.phase, "completed");
  assert.equal((await x.invoke("devrun", "context", "--dev-run", x.route.dev_run_id!)).context.base_commit, x.target);
  await x.admit();
  assert.equal((await x.managed.snapshot([])).head, git(["rev-parse", "HEAD"], { cwd: x.route.path }));
});

test("abandoning a route sync preserves later edits in recovery material and restores source and base", async t => {
  const x = await fixture(t, true);
  const { sync } = await x.invoke(...x.args);
  writeFileSync(join(x.route.path, "service.txt"), "later conflict resolution\n");
  writeFileSync(join(x.route.path, "notes.txt"), "do not lose this\n");
  const args = ["devrun", "sync-abandon", "--sync", sync.id, "--expected-version", String(sync.version), ...actorArgs()];
  const result = await x.invoke(...args);
  assert.equal(result.sync.data.phase, "abandoned");
  assert.equal((await x.invoke(...args)).sync.id, sync.id);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), x.source.head);
  assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "our implementation\n");
  const directory = result.sync.data.recovery.directory;
  const edits = readdirSync(directory).filter(name => name.startsWith("edits-"));
  assert.equal(edits.length, 1);
  const saved = JSON.parse(readFileSync(join(directory, edits[0]!, "files.json"), "utf8"));
  const content = (name: string) => readFileSync(join(directory, edits[0]!, "blobs", saved.entries[name].digest.split(":")[1]), "utf8");
  assert.equal(content("service.txt"), "later conflict resolution\n");
  assert.equal(content("notes.txt"), "do not lose this\n");
  assert.equal((await x.invoke("devrun", "context", "--dev-run", x.route.dev_run_id!)).context.base_commit, x.firstCommit);
  assert.equal((await x.preflight.devRunReadModel(x.route.dev_run_id!))?.state, "preparing");
  assert.equal((await x.managed.snapshot([])).head, x.source.head);
});

test("a merge completed before SQL interruption is recovered once without changing source history", async t => {
  const x = await fixture(t), request = actor();
  const interrupted = new DevRunSyncService(x.ledger.store, new CodeRouteSyncWorkspace(x.ledger.store, x.route.path), point => {
    if (point === "before-sql-finish") throw new Error("simulated process loss");
  });
  await assert.rejects(interrupted.start(x.route.dev_run_id!, 1, x.target, true, request, `sha1:${x.source.head}`), /simulated process loss/);
  const merge = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  assert.notEqual(merge, x.source.head);
  await assert.rejects(x.managed.snapshot([]), { code: "STATE_CONFLICT" });
  const { sync } = await x.invoke("devrun", "sync-show", "--sync", request.operation_id);
  assert.equal(sync.data.phase, "completing");
  const args = ["devrun", "sync-complete", "--sync", sync.id, "--expected-version", String(sync.version), ...actorArgs()];
  assert.equal((await x.invoke(...args)).sync.data.phase, "completed");
  await x.invoke(...args);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), merge);
  assert.equal((await x.managed.snapshot([])).head, merge);
  assert.equal((await x.invoke("devrun", "context", "--dev-run", x.route.dev_run_id!)).context.base_commit, x.target);
});
