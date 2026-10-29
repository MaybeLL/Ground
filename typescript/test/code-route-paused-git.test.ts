import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeRouteExecutions, type RouteEngine, type RouteExecution } from "../src/code-route-execution.js";
import { CodeRouteGit } from "../src/code-route-git.js";
import { git } from "../src/env-git.js";
import { executionFixture, actor } from "./code-route-execution-fixture.js";

class Engine implements RouteEngine {
  state: "absent" | "created" | "running" | "paused" = "absent";
  async identity() { return "pause-test-engine"; }
  async create(run: RouteExecution) { this.state = "created"; return run.execution_id; }
  async find(run: RouteExecution) { return this.state === "absent" ? undefined : run.execution_id; }
  async start() { this.state = "running"; }
  async pause() { this.state = "paused"; }
  async assertPaused() { assert.equal(this.state, "paused"); }
  async resume() { this.state = "running"; }
  async removeStopped() { this.state = "absent"; }
}
const image = `sha256:${"1".repeat(64)}`;

test("a paused route stages its fixed snapshot without surrendering execution ownership", async t => {
  const x = await executionFixture(t), engine = new Engine();
  writeFileSync(join(x.route.path, "service.txt"), "paused stage\n");
  await x.admit();
  const executions = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, window = { ...ref, ...actor() };
  await executions.pause(window);
  const writer = executions.git(window);
  const snapshot = await writer.snapshot(["service.txt"]);
  const result = await writer.apply({ ...actor(), action: "stage", snapshot });
  assert.equal(result.state, "completed");
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "paused stage");
  assert.equal(git(["rev-parse", "refs/heads/main"], { cwd: x.route.path }), x.firstCommit.split(":")[1]);
  assert.equal((await executions.show(ref)).state, "paused");
  assert.equal((await executions.show(ref)).generation, run.generation);
  assert.equal((await executions.show(ref)).git_view_dirty, true);
  await assert.rejects(new CodeRouteGit(x.ledger.store, run.route_id).snapshot([]));
  await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
  await executions.stop(ref);
});

test("a lost paused commit reply blocks resume and stop until the exact request is recovered", async t => {
  const x = await executionFixture(t), engine = new Engine();
  writeFileSync(join(x.route.path, "service.txt"), "paused commit\n");
  await x.admit();
  const executions = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, window = { ...ref, ...actor() };
  await executions.pause(window);
  const writer = executions.git(window);
  await writer.apply({ ...actor(), action: "stage", snapshot: await writer.snapshot(["service.txt"]) });
  const request = { ...actor(), action: "commit" as const, snapshot: await writer.snapshot([]),
    message: "Commit in the paused window", author: { name: "Window author", email: "window@example.invalid" } };
  const restore = x.failAfterGit(`refs/heads/${x.route.development.branch}`);
  try { await assert.rejects(writer.apply(request)); } finally { restore(); }
  const head = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  assert.notEqual(head, x.firstCommit.split(":")[1]);
  await assert.rejects(executions.resume(window), { code: "STATE_CONFLICT" });
  await assert.rejects(executions.stop(ref), { code: "STATE_CONFLICT" });
  assert.equal(engine.state, "paused");
  await assert.rejects(writer.abort(request), { code: "STATE_CONFLICT" });
  await assert.rejects(writer.snapshot([]), { code: "STATE_CONFLICT" });
  const recovered = new CodeRouteExecutions(x.ledger.store, engine).git(window);
  assert.equal((await recovered.apply(request)).head, head);
  assert.equal(git(["rev-list", "--count", `${x.firstCommit.split(":")[1]}..HEAD`], { cwd: x.route.path }), "1");
  // The engine has no refresh capability: even a completed write must not expose an old view.
  await assert.rejects(executions.resume(window), { code: "STATE_CONFLICT" });
  assert.equal(engine.state, "paused");
  await executions.stop(ref);
});

test("Git writes and view refresh hold the same route lock as resume and stop", { timeout: 180_000 }, async t => {
  const x = await executionFixture(t);
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let refreshEntered!: () => void, refreshRelease!: () => void;
  const refreshing = new Promise<void>(resolve => { refreshEntered = resolve; });
  const refreshGate = new Promise<void>(resolve => { refreshRelease = resolve; });
  class DelayedEngine extends Engine {
    hold = false;
    override async assertPaused() {
      await super.assertPaused();
      if (this.hold) { this.hold = false; entered(); await gate; }
    }
    async refreshGitView() { await this.assertPaused(); refreshEntered(); await refreshGate; }
  }
  writeFileSync(join(x.route.path, "service.txt"), "serialized write\n");
  await x.admit();
  const engine = new DelayedEngine(), service = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await service.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, window = { ...ref, ...actor() };
  await service.pause(window);
  const writer = service.git(window), snapshot = await writer.snapshot(["service.txt"]);
  engine.hold = true;
  const pending = writer.apply({ ...actor(), action: "stage", snapshot });
  await arrived;
  const contender = new CodeRouteExecutions(x.ledger.store, engine);
  try {
    await assert.rejects(contender.resume(window), /busy/);
    await assert.rejects(contender.stop(ref), /busy/);
    await assert.rejects(contender.git(window).snapshot([]), /busy/);
    assert.equal(engine.state, "paused");
  } finally { release(); await pending; }
  const resuming = service.resume(window);
  await refreshing;
  try {
    await assert.rejects(contender.git(window).snapshot([]), /busy/);
    await assert.rejects(contender.stop(ref), /busy/);
    assert.equal(engine.state, "paused");
  } finally { refreshRelease(); await resuming; }
  assert.equal(engine.state, "running");
  await assert.rejects(writer.apply({ ...actor(), action: "stage", snapshot }), { code: "STATE_CONFLICT" });
  await service.stop(ref);
});

test("a rejected paused staging operation can abort without releasing the route or changing the index", async t => {
  const x = await executionFixture(t);
  class RefreshEngine extends Engine { async refreshGitView() { await this.assertPaused(); } }
  writeFileSync(join(x.route.path, "service.txt"), "not staged\n");
  await x.admit();
  const engine = new RefreshEngine(), service = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await service.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, window = { ...ref, ...actor() };
  await service.pause(window);
  // A new attribute introduced during development must be rejected at write time too.
  writeFileSync(join(x.route.path, ".gitattributes"), "*.txt filter=unsupported\n");
  await assert.rejects(service.git({ ...window, attribution: { kind: "agent", agent_id: "another-agent", display_name: "Other Agent" } }).snapshot([]), { code: "STATE_CONFLICT" });
  const writer = service.git(window), snapshot = await writer.snapshot(["service.txt"]);
  const request = { ...actor(), action: "stage" as const, snapshot };
  await assert.rejects(writer.apply(request), { code: "VALIDATION_ERROR" });
  await assert.rejects(service.resume(window), { code: "STATE_CONFLICT" });
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "first version");
  assert.equal((await writer.abort(request)).state, "aborted");
  assert.equal(engine.state, "paused");
  assert.equal((await writer.snapshot([])).index_digest, snapshot.index_digest);
  await assert.rejects(writer.apply(request), { code: "STATE_CONFLICT" });
  await service.resume(window);
  assert.equal(engine.state, "running");
  assert.equal((await service.show(ref)).git_view_dirty, false);
  await service.stop(ref);
});
