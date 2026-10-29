import assert from "node:assert/strict";
import { test } from "node:test";
import { CodeRouteExecutions, type RouteExecution, type RouteEngine } from "../src/code-route-execution.js";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { isRouteLeased } from "../src/env-route-lease.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeRouteFencePath } from "../src/code-route-fence.js";
import { CodeRouteGit } from "../src/code-route-git.js";

class Engine implements RouteEngine {
  id = "test-engine";
  loseCreateReply = false;
  loseRemoveReply = false;
  failStart = false;
  createUnavailable = false;
  containers = new Map<string, { running: boolean }>();
  async identity() { return this.id; }
  async create(run: RouteExecution) {
    if (this.createUnavailable) throw new Error("create outcome unknown");
    this.containers.set(run.execution_id, { running: false });
    if (this.loseCreateReply) throw new Error("create reply lost");
    return run.execution_id;
  }
  async find(run: RouteExecution) { return this.containers.has(run.execution_id) ? run.execution_id : undefined; }
  async start(run: RouteExecution) {
    this.containers.get(run.execution_id)!.running = true;
    if (this.failStart) throw new Error("start reply lost");
  }
  async removeStopped(run: RouteExecution) {
    this.containers.delete(run.execution_id);
    if (this.loseRemoveReply) throw new Error("remove reply lost");
  }
}
const image = `sha256:${"1".repeat(64)}`;

class PausableEngine extends Engine {
  paused = new Set<string>();
  losePauseReply = false;
  loseResumeReply = false;
  async pause(run: RouteExecution) {
    if (!this.containers.get(run.execution_id)?.running) throw new Error("executor not running");
    this.paused.add(run.execution_id);
    if (this.losePauseReply) throw new Error("pause reply lost");
  }
  async assertPaused(run: RouteExecution) {
    if (!this.containers.get(run.execution_id)?.running || !this.paused.has(run.execution_id)) throw new Error("pause unproven");
  }
  async resume(run: RouteExecution) {
    if (!this.containers.get(run.execution_id)?.running) throw new Error("executor not running");
    this.paused.delete(run.execution_id);
    if (this.loseResumeReply) throw new Error("resume reply lost");
  }
}

test("a paused execution retains its route and a stale resume cannot release a later pause window", async t => {
  const x = await executionFixture(t), engine = new PausableEngine();
  const service = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await service.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "60"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id };
  const first = { ...ref, ...actor() };
  const paused = await service.pause(first);
  assert.equal(paused.state, "paused");
  assert.equal((await service.show(ref)).state, "paused");
  assert.equal((await service.show(ref)).generation, run.generation);
  await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
  await assert.rejects(service.start({ ...actor(), route_id: run.route_id, image, argv: ["true"] }));
  await assert.rejects(service.pause({ ...ref, ...actor() }));
  const recovered = new CodeRouteExecutions(x.ledger.store, engine);
  assert.equal((await recovered.resume(first)).state, "resumed");
  assert.equal((await recovered.show(ref)).state, "running");
  const second = { ...ref, ...actor() };
  assert.equal((await recovered.pause(second)).state, "paused");
  assert.equal((await recovered.resume(first)).state, "resumed");
  assert.equal((await recovered.pause(first)).state, "resumed", "old pause request must not pause again");
  assert.equal((await recovered.show(ref)).state, "paused");
  assert.equal(engine.paused.has(run.execution_id), true);
  await recovered.resume(second);
  await recovered.stop(ref);
});

test("pause requires fresh engine proof and never delegates preparation or Git writes", async t => {
  const x = await executionFixture(t);
  class AcknowledgingEngine extends PausableEngine {
    acknowledgeOnly = true;
    override async pause(run: RouteExecution) { if (!this.acknowledgeOnly) await super.pause(run); }
  }
  const engine = new AcknowledgingEngine(), service = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await service.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "60"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, window = { ...ref, ...actor() };
  await assert.rejects(service.pause(window), /pause unproven/);
  assert.equal((await service.show(ref)).state, "pausing");
  await assert.rejects(service.resume(window), { code: "STATE_CONFLICT" });
  await assert.rejects(new CodeRouteGit(x.ledger.store, run.route_id).snapshot(["service.txt"]));
  engine.acknowledgeOnly = false;
  assert.equal((await service.pause(window)).state, "paused");
  await assert.rejects(new CodeRouteGit(x.ledger.store, run.route_id).snapshot(["service.txt"]));
  await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
  engine.id = "replacement-engine";
  await assert.rejects(service.resume(window), { code: "STATE_CONFLICT" });
  assert.equal(engine.paused.has(run.execution_id), true);
  engine.id = "test-engine";
  engine.paused.delete(run.execution_id); // External state diverges from the last saved receipt.
  await assert.rejects(service.pause(window), /pause unproven/);
  await assert.rejects(service.resume(window), /pause unproven/);
  assert.equal((await service.show(ref)).state, "paused", "show is a saved progress record, not a fresh engine proof");
  engine.paused.add(run.execution_id);
  await service.resume(window);
  await service.stop(ref);
});

test("execution holds a durable single-owner reservation until proven stopped, then permits preparation", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const service = new CodeRouteExecutions(x.ledger.store, engine);
  const request = { ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "60"] };
  const run = await service.start(request);
  assert.equal(run.state, "running");
  assert.equal(run.generation, 1);
  assert.equal(isRouteLeased(x.route.path), true);
  await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
  await assert.rejects(service.start({ ...request, ...actor() }));
  assert.deepEqual(await new CodeRouteExecutions(x.ledger.store, engine).start(request), run);
  assert.equal(engine.containers.size, 1);
  const stopped = await service.stop({ route_id: request.route_id, execution_id: run.execution_id });
  assert.equal(stopped.state, "stopped");
  assert.equal(engine.containers.size, 0);
  assert.equal(isRouteLeased(x.route.path), true, "return to preparation never removes the persistent fence");
  await x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! });
});

test("absence after uncertain creation is not a stop proof and cannot be bypassed with a new request", async t => {
  const x = await executionFixture(t), engine = new Engine();
  engine.createUnavailable = true;
  const service = new CodeRouteExecutions(x.ledger.store, engine);
  const request = { ...actor(), route_id: x.route.route_id, image, argv: ["true"] };
  await assert.rejects(service.start(request), /create outcome unknown/);
  await assert.rejects(service.stop({ route_id: request.route_id, execution_id: request.operation_id }), { code: "STATE_CONFLICT" });
  engine.createUnavailable = false;
  assert.equal((await service.start(request)).state, "creating");
  await assert.rejects(service.start({ ...request, ...actor() }));
  await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
  assert.equal(engine.containers.size, 0);
});

test("lost Docker replies retain ownership, recover by exact identity, and stale stop cannot release a later generation", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const service = new CodeRouteExecutions(x.ledger.store, engine);
  const request = { ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "60"] };
  const ref = { route_id: request.route_id, execution_id: request.operation_id };
  engine.loseCreateReply = true;
  await assert.rejects(service.start(request), /create reply lost/);
  assert.equal((await service.start(request)).state, "creating");
  await assert.rejects(service.start({ ...request, argv: ["true"] }), { code: "STATE_CONFLICT" });
  engine.id = "different-engine";
  await assert.rejects(service.stop(ref), { code: "STATE_CONFLICT" });
  assert.equal(engine.containers.size, 1);
  engine.id = "test-engine";
  engine.loseRemoveReply = true;
  await assert.rejects(service.stop(ref), /remove reply lost/);
  assert.equal((await service.show(ref)).state, "stopping");
  assert.equal((await service.show(ref)).container_id, request.operation_id);
  await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
  engine.loseRemoveReply = false;
  assert.equal((await new CodeRouteExecutions(x.ledger.store, engine).stop(ref)).state, "stopped");
  engine.loseCreateReply = false;
  engine.failStart = true;
  const next = { ...request, ...actor() };
  await assert.rejects(service.start(next), /start reply lost/);
  assert.equal((await service.start(next)).generation, 2);
  assert.equal((await service.start(next)).state, "starting");
  assert.equal((await service.stop(ref)).state, "stopped");
  assert.equal(engine.containers.size, 1);
  await assert.rejects(service.start({ ...request, ...actor() }));
  await service.stop({ route_id: request.route_id, execution_id: next.operation_id });
  await x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! });
});

test("execution requires current admission, unchanged actual inputs and a freshly matching target", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const service = new CodeRouteExecutions(x.ledger.store, engine);
  const request = () => ({ ...actor(), route_id: x.route.route_id, image, argv: ["true"] });
  await x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! });
  await assert.rejects(service.start(request()), { code: "STATE_CONFLICT" });
  await x.admit();
  writeFileSync(join(x.route.path, "service.txt"), "changed since admission\n");
  await assert.rejects(service.start(request()), { code: "STATE_CONFLICT" });
  await x.admit();
  x.publish("remote changed since admission\n");
  await assert.rejects(service.start(request()), { code: "STATE_CONFLICT" });
  assert.equal(engine.containers.size, 0);
});

test("shared runtime rejects concurrent request ID reuse across repositories while distinct routes execute together", async t => {
  const a = await executionFixture(t), b = await executionFixture(t, a.dataRoot);
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  class DelayedEngine extends Engine {
    first = true;
    override async identity() {
      if (this.first) { this.first = false; entered(); await gate; }
      return super.identity();
    }
  }
  const engine = new DelayedEngine();
  const serviceA = new CodeRouteExecutions(a.ledger.store, engine), serviceB = new CodeRouteExecutions(b.ledger.store, engine);
  const request = { ...actor(), route_id: a.route.route_id, image, argv: ["sleep", "60"] };
  const pending = serviceA.start(request);
  await arrived;
  try {
    await assert.rejects(serviceB.start({ ...request, route_id: b.route.route_id }), { code: "STATE_CONFLICT" });
  } finally { release(); await pending; }
  const runA = await pending;
  const runB = await serviceB.start({ ...request, ...actor(), route_id: b.route.route_id });
  assert.equal(engine.containers.size, 2);
  await serviceA.stop({ route_id: a.route.route_id, execution_id: runA.execution_id });
  assert.equal(engine.containers.size, 1);
  await assert.rejects(b.preflight.markPreparing({ ...actor(), dev_run_id: b.route.dev_run_id! }));
  await serviceB.stop({ route_id: b.route.route_id, execution_id: runB.execution_id });
});

test("damaged execution ownership fails closed instead of becoming a preparation reservation", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const service = new CodeRouteExecutions(x.ledger.store, engine);
  const request = { ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "60"] };
  const run = await service.start(request);
  const path = codeRouteFencePath(x.route.path), original = readFileSync(path);
  const damaged = JSON.parse(original.toString());
  damaged.control.execution_id = "";
  writeFileSync(path, JSON.stringify(damaged));
  try {
    await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }), { code: "WORKTREE_MISMATCH" });
    await assert.rejects(service.start({ ...request, ...actor() }), { code: "WORKTREE_MISMATCH" });
    assert.equal(engine.containers.size, 1);
  } finally {
    writeFileSync(path, original);
    await service.stop({ route_id: request.route_id, execution_id: run.execution_id });
  }
});
