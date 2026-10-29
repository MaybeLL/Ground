import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeRouteExecutions, type RouteEngine, type RouteEngineStatus, type RouteExecution } from "../src/code-route-execution.js";
import { CodeRouteRequests } from "../src/code-route-requests.js";
import { CodeRouteController } from "../src/code-route-controller.js";
import { git } from "../src/env-git.js";
import { newUUIDv7 } from "../src/identity.js";
import { executionFixture, actor } from "./code-route-execution-fixture.js";

class Engine implements RouteEngine {
  state: "absent" | "created" | "running" | "paused" | "exited" = "absent";
  async identity() { return "controller-test-engine"; }
  async create(run: RouteExecution) { this.state = "created"; return run.execution_id; }
  async find(run: RouteExecution) { return this.state === "absent" ? undefined : run.execution_id; }
  async start() { this.state = "running"; }
  async pause() { this.state = "paused"; }
  async assertPaused() { assert.equal(this.state, "paused"); }
  async refreshGitView() { await this.assertPaused(); }
  async resume() { this.state = "running"; }
  async removeStopped() { this.state = "absent"; }
  async status(): Promise<RouteEngineStatus> {
    assert.ok(["running", "paused", "exited"].includes(this.state));
    return this.state === "exited" ? { state: "exited", exit_code: 17 } : { state: this.state as "running" | "paused" };
  }
}
const image = `sha256:${"1".repeat(64)}`;

test("the controller waits for requests, publishes a receipt and stops only after the in-flight operation completes", { timeout: 180_000 }, async t => {
  const x = await executionFixture(t);
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  class Delayed extends Engine {
    override async pause() { await super.pause(); entered(); await gate; }
  }
  const engine = new Delayed();
  const executions = new CodeRouteExecutions(x.ledger.store, engine), requests = new CodeRouteRequests(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, transport = await requests.transport(ref);
  const cancel = new AbortController();
  t.after(() => cancel.abort());
  const receipts: string[] = [];
  const serving = new CodeRouteController(x.ledger.store, engine).serve(ref, { signal: cancel.signal, interval_ms: 20,
    onReceipt: receipt => { receipts.push(receipt.state); cancel.abort(); } });
  writeFileSync(join(x.route.path, "service.txt"), "handled by controller\n");
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify({ request_id: newUUIDv7(), execution_id: run.execution_id,
    action: "stage", paths: ["service.txt"] }));
  await arrived;
  try {
    await assert.rejects(new CodeRouteController(x.ledger.store, engine).serve(ref), /busy/);
    cancel.abort();
    assert.equal(engine.state, "paused", "cancellation cannot remove a container during the accepted operation");
    await assert.rejects(executions.stop(ref), /busy/);
  } finally { release(); }
  assert.equal((await serving).reason, "cancelled");
  assert.deepEqual(receipts, ["completed"]);
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "handled by controller");
  assert.equal((await executions.show(ref)).state, "stopped");
  assert.equal(engine.state, "absent");
});

test("a restarted controller recovers the accepted commit after reply loss without using a replacement inbox", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const executions = new CodeRouteExecutions(x.ledger.store, engine), requests = new CodeRouteRequests(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, transport = await requests.transport(ref);
  const input = join(transport.inbox, "request.json");
  writeFileSync(join(x.route.path, "service.txt"), "recover controller commit\n");
  writeFileSync(input, JSON.stringify({ request_id: newUUIDv7(), execution_id: run.execution_id, action: "stage", paths: ["service.txt"] }));
  await requests.poll(ref);
  const request = { request_id: newUUIDv7(), execution_id: run.execution_id, action: "commit", message: "Controller recovery",
    author: { name: "Agent", email: "agent@example.invalid" } };
  writeFileSync(input, JSON.stringify(request));
  const restore = x.failAfterGit(`refs/heads/${x.route.development.branch}`);
  try { await assert.rejects(new CodeRouteController(x.ledger.store, engine).serve(ref)); } finally { restore(); }
  const head = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  assert.notEqual(head, x.firstCommit.split(":")[1]);
  assert.notEqual(JSON.parse(readFileSync(join(transport.outbox, "response.json"), "utf8")).request_id, request.request_id);
  writeFileSync(input, "untrusted replacement");
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(new CodeRouteController(x.ledger.store, engine).serve(ref, { signal: cancelled.signal }), { code: "STATE_CONFLICT" });
  assert.equal(engine.state, "paused", "cancellation cannot discard an uncertain Git result");
  const cancel = new AbortController();
  const receipts: string[] = [];
  await new CodeRouteController(x.ledger.store, engine).serve(ref, { signal: cancel.signal,
    onReceipt: receipt => { receipts.push(receipt.request_id); cancel.abort(); } });
  assert.deepEqual(receipts, [request.request_id]);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), head);
  assert.equal(git(["rev-list", "--count", `${x.firstCommit.split(":")[1]}..HEAD`], { cwd: x.route.path }), "1");
  assert.equal((await executions.show(ref)).state, "stopped");
});

test("polling returns a rejection only after proving no Git change, then accepts a corrected request", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const executions = new CodeRouteExecutions(x.ledger.store, engine), requests = new CodeRouteRequests(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, transport = await requests.transport(ref);
  assert.equal(await requests.poll(ref), undefined);
  writeFileSync(join(x.route.path, ".gitattributes"), "*.txt filter=unsupported\n");
  writeFileSync(join(x.route.path, "service.txt"), "corrected after rejection\n");
  const request = { request_id: newUUIDv7(), execution_id: run.execution_id, action: "stage", paths: ["service.txt"] };
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify(request));
  const rejected = await requests.poll(ref);
  assert.equal(rejected?.state, "rejected");
  assert.equal(engine.state, "running");
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "first version");
  const response = readFileSync(join(transport.outbox, "response.json"), "utf8");
  assert.equal(JSON.parse(response).request_id, request.request_id);
  assert.ok(!response.includes(x.dataRoot), "container errors do not reveal host paths");
  assert.equal(await requests.poll(ref), undefined, "idle polling does not redispatch a completed rejection");
  unlinkSync(join(x.route.path, ".gitattributes"));
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify({ ...request, request_id: newUUIDv7() }));
  assert.equal((await requests.poll(ref))?.state, "completed");
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "corrected after rejection");
  engine.state = "exited";
  assert.deepEqual(await new CodeRouteController(x.ledger.store, engine).serve(ref), { reason: "exited", exit_code: 17 });
  assert.equal((await executions.show(ref)).state, "stopped");
  assert.equal((await executions.show(ref)).exit_code, 17, "removal must retain the observed exit result");
});
