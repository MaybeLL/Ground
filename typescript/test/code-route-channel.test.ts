import assert from "node:assert/strict";
import { test } from "node:test";
import { linkSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { CodeRouteExecutions, type RouteEngine, type RouteExecution } from "../src/code-route-execution.js";
import { CodeRouteRequests } from "../src/code-route-requests.js";
import { git } from "../src/env-git.js";
import { newUUIDv7 } from "../src/identity.js";
import { executionFixture, actor } from "./code-route-execution-fixture.js";

class Engine implements RouteEngine {
  state = "absent";
  async identity() { return "channel-test-engine"; }
  async create(run: RouteExecution) { this.state = "created"; return run.execution_id; }
  async find(run: RouteExecution) { return this.state === "absent" ? undefined : run.execution_id; }
  async start() { this.state = "running"; }
  async pause() { this.state = "paused"; }
  async assertPaused() { assert.equal(this.state, "paused"); }
  async refreshGitView() { await this.assertPaused(); }
  async resume() { this.state = "running"; }
  async removeStopped() { this.state = "absent"; }
}
const image = `sha256:${"1".repeat(64)}`;

test("a pre-journal staging rejection resumes the route and permits another request", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const executions = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" });
  const ref = { route_id: run.route_id, execution_id: run.execution_id };
  const requests = new CodeRouteRequests(x.ledger.store, engine), transport = await requests.transport(ref);
  const paths = Array.from({ length: 128 }, (_, i) => `d${i}/a/b/c/d/e/f/g/file.txt`);
  for (const path of paths) { mkdirSync(dirname(join(x.route.path, path)), { recursive: true }); writeFileSync(join(x.route.path, path), "preserve this file\n"); }
  const head = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: x.route.path });
  const before = readFileSync(index);
  const request = { request_id: newUUIDv7(), execution_id: run.execution_id, action: "stage", paths };
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify(request));
  const receipt = await requests.poll(ref);
  assert.equal(receipt?.state, "rejected");
  assert.equal(engine.state, "running");
  assert.deepEqual(JSON.parse(readFileSync(join(transport.outbox, "response.json"), "utf8")), receipt);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), head);
  assert.deepEqual(readFileSync(index), before);
  for (const path of paths) assert.equal(readFileSync(join(x.route.path, path), "utf8"), "preserve this file\n");
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify({ ...request, request_id: newUUIDv7(), paths: [paths[0]] }));
  assert.equal((await requests.poll(ref))?.state, "completed");
  assert.equal(git(["show", `:${paths[0]}`], { cwd: x.route.path }), "preserve this file");
  await executions.stop(ref);
});

test("a pre-journal rejection can be abandoned after restart only while its Git snapshot is unchanged", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const executions = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" });
  const ref = { route_id: run.route_id, execution_id: run.execution_id };
  const channel = new CodeRouteRequests(x.ledger.store, engine), transport = await channel.transport(ref);
  const paths = Array.from({ length: 128 }, (_, i) => `d${i}/a/b/c/d/e/f/g/file.txt`);
  const request = { request_id: newUUIDv7(), execution_id: run.execution_id, action: "stage", paths };
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify(request));
  // The direct host API leaves validation rejection for explicit recovery.
  await assert.rejects(channel.process(ref), { code: "VALIDATION_ERROR" });
  await assert.rejects(executions.stop(ref), { code: "STATE_CONFLICT" });
  const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: x.route.path });
  const before = readFileSync(index), head = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  writeFileSync(join(x.route.path, "service.txt"), "host changed index\n");
  git(["add", "service.txt"], { cwd: x.route.path });
  await assert.rejects(new CodeRouteRequests(x.ledger.store, engine).abort(ref), { code: "STATE_CONFLICT" });
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "host changed index");
  assert.equal(engine.state, "paused");
  writeFileSync(index, before); // Restore exactly the injected external change.
  git(["-c", "user.name=Host", "-c", "user.email=host@example.invalid", "commit", "--allow-empty", "-m", "external change"], { cwd: x.route.path });
  await assert.rejects(new CodeRouteRequests(x.ledger.store, engine).abort(ref), { code: "STATE_CONFLICT" });
  git(["update-ref", "HEAD", head], { cwd: x.route.path });
  unlinkSync(join(transport.inbox, "request.json"));
  const receipt = await new CodeRouteRequests(x.ledger.store, engine).abort(ref);
  assert.equal(receipt.state, "aborted");
  assert.equal(engine.state, "running");
  assert.deepEqual(readFileSync(index), before);
  await executions.stop(ref);
});

test("a pre-journal rejection recovers its receipt after a lost resume reply", async t => {
  const x = await executionFixture(t);
  class LostResume extends Engine {
    lose = true;
    override async resume() { await super.resume(); if (this.lose) { this.lose = false; throw new Error("lost rejection resume reply"); } }
  }
  const engine = new LostResume(), executions = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" });
  const ref = { route_id: run.route_id, execution_id: run.execution_id };
  const channel = new CodeRouteRequests(x.ledger.store, engine), transport = await channel.transport(ref);
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify({ request_id: newUUIDv7(), execution_id: run.execution_id,
    action: "stage", paths: Array.from({ length: 128 }, (_, i) => `d${i}/a/b/c/d/e/f/g/file.txt`) }));
  await assert.rejects(channel.poll(ref), /lost rejection resume reply/);
  await assert.rejects(executions.stop(ref), { code: "STATE_CONFLICT" });
  unlinkSync(join(transport.inbox, "request.json"));
  const receipt = await new CodeRouteRequests(x.ledger.store, engine).recover(ref);
  assert.equal(receipt.state, "rejected");
  assert.equal(engine.state, "running");
  assert.deepEqual(JSON.parse(readFileSync(join(transport.outbox, "response.json"), "utf8")), receipt);
  await executions.stop(ref);
});

test("an execution mailbox stages and commits only its bound route and replays the same receipt", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const executions = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" });
  const ref = { route_id: run.route_id, execution_id: run.execution_id };
  const channel = new CodeRouteRequests(x.ledger.store, engine);
  const transport = await channel.transport(ref);
  const submit = async (body: object) => {
    const request = { request_id: newUUIDv7(), execution_id: run.execution_id, ...body };
    writeFileSync(join(transport.inbox, "request.json"), JSON.stringify(request));
    return channel.process(ref);
  };
  writeFileSync(join(x.route.path, "service.txt"), "mailbox change\n");
  assert.equal((await submit({ action: "stage", paths: ["service.txt"] })).state, "completed");
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "mailbox change");
  const result = await submit({ action: "commit", message: "Mailbox commit", author: { name: "Agent", email: "agent@example.invalid" } });
  assert.equal(result.state, "completed");
  assert.equal(git(["show", "HEAD:service.txt"], { cwd: x.route.path }), "mailbox change");
  assert.equal(git(["rev-parse", "refs/heads/main"], { cwd: x.route.path }), x.firstCommit.split(":")[1]);
  assert.deepEqual(await new CodeRouteRequests(x.ledger.store, engine).process(ref), result);
  assert.deepEqual(JSON.parse(readFileSync(join(transport.outbox, "response.json"), "utf8")), result);
  assert.equal(git(["rev-list", "--count", `${x.firstCommit.split(":")[1]}..HEAD`], { cwd: x.route.path }), "1");
  assert.equal(engine.state, "running");
  await executions.stop(ref);
});

test("an unfinished mailbox request blocks stop and unrelated windows until refresh and resume recover", async t => {
  const x = await executionFixture(t);
  class LostReply extends Engine {
    loseRefresh = true;
    loseResume = true;
    override async refreshGitView() {
      await super.refreshGitView();
      if (this.loseRefresh) { this.loseRefresh = false; throw new Error("refresh reply lost"); }
    }
    override async resume() {
      await super.resume();
      if (this.loseResume) { this.loseResume = false; throw new Error("resume reply lost"); }
    }
  }
  const engine = new LostReply(), executions = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, channel = new CodeRouteRequests(x.ledger.store, engine);
  const transport = await channel.transport(ref);
  writeFileSync(join(x.route.path, "service.txt"), "recover exact request\n");
  const request = { request_id: newUUIDv7(), execution_id: run.execution_id, action: "stage", paths: ["service.txt"] };
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify(request));
  await assert.rejects(channel.process(ref), /refresh reply lost/);
  await assert.rejects(executions.stop(ref), { code: "STATE_CONFLICT" });
  const paused = await executions.show(ref);
  await assert.rejects(executions.resume({ ...ref, operation_id: paused.pause_id!, attribution: run.attribution }), { code: "STATE_CONFLICT" });
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify({ ...request, request_id: newUUIDv7() }));
  await assert.rejects(channel.process(ref), { code: "STATE_CONFLICT" });
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify(request));
  await assert.rejects(new CodeRouteRequests(x.ledger.store, engine).process(ref), /resume reply lost/);
  await assert.rejects(executions.stop(ref), { code: "STATE_CONFLICT" });
  assert.equal((await new CodeRouteRequests(x.ledger.store, engine).process(ref)).state, "completed");
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "recover exact request");
  assert.equal(engine.state, "running");
  await executions.stop(ref);
});

test("mailboxes reject forged scope, unsafe files, changed replay and requests from a stopped generation", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const executions = new CodeRouteExecutions(x.ledger.store, engine), channel = new CodeRouteRequests(x.ledger.store, engine);
  const start = { ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" as const };
  const run = await executions.start(start), ref = { route_id: run.route_id, execution_id: run.execution_id };
  const transport = await channel.transport(ref), input = join(transport.inbox, "request.json");
  const request = { request_id: newUUIDv7(), execution_id: run.execution_id, action: "stage", paths: ["service.txt"] };
  for (const change of [{ execution_id: newUUIDv7() }, { route_id: newUUIDv7() }, { branch: "main" },
    { attribution: actor().attribution }, { paths: ["../escape"] }, { paths: [".git/config"] }, { action: "reset" }]) {
    writeFileSync(input, JSON.stringify({ ...request, ...change }));
    await assert.rejects(channel.process(ref), { code: "VALIDATION_ERROR" });
    assert.equal(engine.state, "running");
  }
  unlinkSync(input);
  const foreign = join(x.root, "foreign-request");
  writeFileSync(foreign, JSON.stringify(request));
  symlinkSync(foreign, input);
  await assert.rejects(channel.process(ref));
  unlinkSync(input);
  linkSync(foreign, input);
  await assert.rejects(channel.process(ref), { code: "VALIDATION_ERROR" });
  unlinkSync(input);
  execFileSync("mkfifo", [input]);
  await assert.rejects(channel.process(ref), { code: "VALIDATION_ERROR" });
  unlinkSync(input);
  writeFileSync(input, Buffer.alloc(193 * 1024, "x"));
  await assert.rejects(channel.process(ref), { code: "VALIDATION_ERROR" });
  writeFileSync(input, JSON.stringify(request));
  const completed = await channel.process(ref);
  writeFileSync(input, JSON.stringify({ ...request, action: "unstage" }));
  await assert.rejects(channel.process(ref), { code: "STATE_CONFLICT" });
  // Rejecting different bytes for an already completed ID must not reserve the route again.
  await executions.stop(ref);
  const next = await executions.start({ ...start, ...actor() });
  const nextRef = { route_id: next.route_id, execution_id: next.execution_id };
  await assert.rejects(channel.process(ref), { code: "STATE_CONFLICT" });
  writeFileSync(join((await channel.transport(nextRef)).inbox, "request.json"), JSON.stringify(request));
  await assert.rejects(channel.process(nextRef), { code: "VALIDATION_ERROR" });
  assert.equal((await executions.show(nextRef)).state, "running");
  assert.equal(completed.execution_id, run.execution_id);
  await executions.stop(nextRef);
});

test("a lost Git reply recovers from host-pinned input even after the container deletes its request", async t => {
  const x = await executionFixture(t), engine = new Engine();
  const executions = new CodeRouteExecutions(x.ledger.store, engine), channel = new CodeRouteRequests(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, transport = await channel.transport(ref);
  const input = join(transport.inbox, "request.json");
  writeFileSync(join(x.route.path, "service.txt"), "durable request\n");
  writeFileSync(input, JSON.stringify({ request_id: newUUIDv7(), execution_id: run.execution_id, action: "stage", paths: ["service.txt"] }));
  await channel.process(ref);
  const request = { request_id: newUUIDv7(), execution_id: run.execution_id, action: "commit", message: "Recover once",
    author: { name: "Agent", email: "agent@example.invalid" } };
  writeFileSync(input, JSON.stringify(request));
  const restore = x.failAfterGit(`refs/heads/${x.route.development.branch}`);
  try { await assert.rejects(channel.process(ref)); } finally { restore(); }
  const head = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  assert.notEqual(head, x.firstCommit.split(":")[1]);
  unlinkSync(input);
  await assert.rejects(channel.abort(ref), { code: "STATE_CONFLICT" });
  const recovered = await new CodeRouteRequests(x.ledger.store, engine).recover(ref);
  assert.equal(recovered.request_id, request.request_id);
  assert.equal(recovered.state, "completed");
  assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), head);
  assert.equal(git(["rev-list", "--count", `${x.firstCommit.split(":")[1]}..HEAD`], { cwd: x.route.path }), "1");
  await executions.stop(ref);
});

test("mailbox handling cannot take another pause and serializes controllers through cancellation", { timeout: 180_000 }, async t => {
  const x = await executionFixture(t);
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  class Delayed extends Engine {
    hold = false;
    override async pause() {
      await super.pause();
      if (this.hold) { this.hold = false; entered(); await gate; }
    }
  }
  const engine = new Delayed(), executions = new CodeRouteExecutions(x.ledger.store, engine);
  const channel = new CodeRouteRequests(x.ledger.store, engine);
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image, argv: ["sleep", "120"], mode: "development" });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, transport = await channel.transport(ref);
  const window = { ...ref, ...actor() };
  await executions.pause(window);
  writeFileSync(join(transport.inbox, "request.json"), JSON.stringify({ request_id: newUUIDv7(), execution_id: run.execution_id,
    action: "stage", paths: ["service.txt"] }));
  await assert.rejects(channel.process(ref), { code: "STATE_CONFLICT" });
  await executions.resume(window);
  // Introduced after admission, so this is a write-time unsupported conversion.
  writeFileSync(join(x.route.path, ".gitattributes"), "*.txt filter=unsupported\n");
  writeFileSync(join(x.route.path, "service.txt"), "must not be staged\n");
  engine.hold = true;
  const operation = channel.process(ref);
  const rejected = assert.rejects(operation, { code: "VALIDATION_ERROR" });
  await arrived;
  try {
    await assert.rejects(new CodeRouteRequests(x.ledger.store, engine).process(ref), /busy/);
    await assert.rejects(executions.stop(ref), /busy/);
  } finally { release(); await rejected; }
  await assert.rejects(executions.stop(ref), { code: "STATE_CONFLICT" });
  assert.equal((await new CodeRouteRequests(x.ledger.store, engine).abort(ref)).state, "aborted");
  assert.equal((await channel.process(ref)).state, "aborted");
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "first version");
  assert.equal(engine.state, "running");
  await executions.stop(ref);
});
