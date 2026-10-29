import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { CodeWorkspaceRoutes } from "../src/code-workspace-route.js";
import { codeWorkspaceFixture } from "./code-workspace-fixture.js";
import { git } from "../src/env-git.js";
import { newUUIDv7 } from "../src/identity.js";
import { testAgent } from "./fixture.js";

test("a Workspace prepares a distinct target route with a fixed base and preserves its baseline", async t => {
  const x = await codeWorkspaceFixture(t);
  const instance = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  const service = new CodeWorkspaceRoutes(x.ledger.store);
  const route = await service.prepare({ instance_id: instance.instance_id, operation_id: newUUIDv7(),
    host_id: x.hostId, data_root: x.dataRoot, issue_slug: "order-change", attribution: testAgent });
  assert.notEqual(route.route_id, instance.instance_id);
  assert.equal(route.instance_id, instance.instance_id);
  assert.equal(route.repository_id, instance.target_repository_id);
  assert.equal(route.base_commit, x.firstCommit);
  assert.equal(route.path, join(x.dataRoot, "workspaces", instance.instance_id, "development", route.route_id));
  assert.equal(route.state, "prepared");
  assert.equal(route.execution_enabled, false);
  assert.equal(git(["symbolic-ref", "HEAD"], { cwd: route.path }), `refs/heads/${route.development.branch}`);
  assert.equal(route.development.workspace_id, route.route_id);
  assert.equal(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: route.path }),
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: instance.baselines[0].path }));
  writeFileSync(join(route.path, "service.txt"), "route draft\n");
  assert.equal(readFileSync(join(instance.baselines[0].path, "service.txt"), "utf8"), "first version\n");
  assert.deepEqual(await service.show(route.route_id), route);
});

test("route preparation survives an unacknowledged checkout without changing its ID or branch", async t => {
  const x = await codeWorkspaceFixture(t);
  const instance = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  const service = new CodeWorkspaceRoutes(x.ledger.store);
  const request = { instance_id: instance.instance_id, operation_id: newUUIDv7(), host_id: x.hostId,
    data_root: x.dataRoot, issue_slug: "order-change", attribution: testAgent };
  const restore = x.failAfterGit("add");
  await assert.rejects(service.prepare(request));
  restore();
  const interrupted = await service.show(request.operation_id);
  assert.equal(interrupted.state, "blocked");
  assert.equal(interrupted.base_commit, x.firstCommit);
  assert.equal(readFileSync(join(interrupted.path, "service.txt"), "utf8"), "first version\n");
  x.publish("new remote content\n");
  const recovered = await service.prepare(request);
  assert.equal(recovered.route_id, interrupted.route_id);
  assert.equal(recovered.base_commit, x.firstCommit);
  writeFileSync(join(recovered.path, "service.txt"), "preserve draft\n");
  assert.deepEqual(await service.prepare(request), recovered);
  assert.equal(readFileSync(join(recovered.path, "service.txt"), "utf8"), "preserve draft\n");
  await assert.rejects(service.prepare({ ...request, issue_slug: "a different request" }), { code: "IDEMPOTENCY_CONFLICT" });
});

test("different routes prepare concurrently while duplicate preparation has one controller", async t => {
  const x = await codeWorkspaceFixture(t);
  const instance = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  const service = new CodeWorkspaceRoutes(x.ledger.store);
  const request = { instance_id: instance.instance_id, operation_id: newUUIDv7(), host_id: x.hostId,
    data_root: x.dataRoot, issue_slug: "order-change", attribution: testAgent };
  const routes = await Promise.all([service.prepare(request), service.prepare({ ...request, operation_id: newUUIDv7() })]);
  assert.notEqual(routes[0].path, routes[1].path);
  assert.notEqual(routes[0].development.branch, routes[1].development.branch);
  const duplicate = { ...request, operation_id: newUUIDv7() };
  const outcomes = await Promise.allSettled([service.prepare(duplicate), service.prepare(duplicate)]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find(outcome => outcome.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "STATE_CONFLICT");
  assert.equal((await service.show(duplicate.operation_id)).state, "prepared");
});

test("a second process cannot take over a route while the first controller is creating its worktree", async t => {
  const { spawn } = await import("node:child_process");
  const { mkdirSync, existsSync } = await import("node:fs");
  const { setTimeout: delay } = await import("node:timers/promises");
  const x = await codeWorkspaceFixture(t);
  const instance = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  const request = { instance_id: instance.instance_id, operation_id: newUUIDv7(), host_id: x.hostId,
    data_root: x.dataRoot, issue_slug: "exclusive-route", attribution: testAgent };
  const shim = join(x.root, "paused-git"), entered = join(x.root, "entered"), release = join(x.root, "release");
  mkdirSync(shim);
  const { execFileSync } = await import("node:child_process");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(shim, "git"), `#!${process.execPath}\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args.includes('worktree')&&args.includes('add')){fs.writeFileSync(${JSON.stringify(entered)},'entered');const end=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)process.exit(99);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}}const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??98);`, { mode: 0o700 });
  const script = `import {SQLStore} from './src/sql-store.ts';import {CodeWorkspaceRoutes} from './src/code-workspace-route.ts';const s=SQLStore.sqlite(${JSON.stringify(x.ledgerPath)});try{console.log(JSON.stringify(await new CodeWorkspaceRoutes(s).prepare(${JSON.stringify(request)})))}finally{await s.close()}`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, PATH: shim + ":" + process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errors += data; });
  const finished = new Promise<number | null>((yes, no) => { child.on("exit", yes); child.on("error", no); });
  let exit: number | null = null;
  try {
    const deadline = Date.now() + 20000;
    while (!existsSync(entered) && child.exitCode === null && Date.now() < deadline) await delay(25);
    assert.ok(existsSync(entered), errors);
    await assert.rejects(new CodeWorkspaceRoutes(x.ledger.store).prepare(request), { code: "STATE_CONFLICT" });
  } finally {
    writeFileSync(release, "release");
    exit = await finished;
  }
  assert.equal(exit, 0, errors);
  assert.equal(JSON.parse(output).state, "prepared");
});

test("a prepared code route stays reserved and cannot be acquired by the legacy environment writer", async t => {
  const { acquireRouteLease, isRouteLeased } = await import("../src/env-route-lease.js");
  const { withRuntimeDirectories } = await import("../src/runtime-files.js");
  const x = await codeWorkspaceFixture(t);
  const instance = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  const service = new CodeWorkspaceRoutes(x.ledger.store);
  const request = { instance_id: instance.instance_id, operation_id: newUUIDv7(), host_id: x.hostId,
    data_root: x.dataRoot, issue_slug: "order-change", attribution: testAgent };
  const route = await service.prepare(request);
  await withRuntimeDirectories({ runtimeHome: join(x.root, "runtime"), directoryRegistryHome: join(x.root, "registry") }, async () => {
    assert.throws(() => acquireRouteLease({ route: route.path, environmentId: newUUIDv7(), runDirectory: join(x.root, "legacy-run") }), { code: "STATE_CONFLICT" });
    assert.equal(isRouteLeased(route.path), true);
    const { mkdirSync } = await import("node:fs");
    const nested = join(route.path, "subdirectory"); mkdirSync(nested);
    assert.equal(isRouteLeased(nested), true, "using a subdirectory must not bypass preparation ownership");
    assert.throws(() => acquireRouteLease({ route: nested, environmentId: newUUIDv7(), runDirectory: join(x.root, "nested-run") }), { code: "STATE_CONFLICT" });
  });
  assert.deepEqual(await new CodeWorkspaceRoutes(x.ledger.store).prepare(request), route);
});

test("new preparation never adopts an unowned pre-existing route even when branch and commit match", async t => {
  const { mkdirSync } = await import("node:fs");
  const x = await codeWorkspaceFixture(t);
  const instance = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  const request = { instance_id: instance.instance_id, operation_id: newUUIDv7(), host_id: x.hostId,
    data_root: x.dataRoot, issue_slug: "order-change", attribution: testAgent };
  const parent = join(x.dataRoot, "workspaces", instance.instance_id, "development"); mkdirSync(parent);
  const path = join(parent, request.operation_id);
  git(["worktree", "add", "-b", `grounds/order-change/${request.operation_id}`, "--", path, x.firstCommit.split(":")[1]!],
    { gitDir: join(x.dataRoot, "cache", "repos", instance.target_repository_id) });
  writeFileSync(join(path, "service.txt"), "unowned draft\n");
  const service = new CodeWorkspaceRoutes(x.ledger.store);
  await assert.rejects(service.prepare(request), { code: "WORKTREE_MISMATCH" });
  await assert.rejects(service.show(request.operation_id), { code: "NOT_FOUND" });
  assert.equal(readFileSync(join(path, "service.txt"), "utf8"), "unowned draft\n");
});

test("missing persistent ownership is not silently recreated over a prepared route", async t => {
  const { readdirSync, unlinkSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const x = await codeWorkspaceFixture(t);
  const instance = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  const service = new CodeWorkspaceRoutes(x.ledger.store);
  const request = { instance_id: instance.instance_id, operation_id: newUUIDv7(), host_id: x.hostId,
    data_root: x.dataRoot, issue_slug: "order-change", attribution: testAgent };
  const route = await service.prepare(request);
  const reservation = readdirSync(dirname(route.path)).find(name => name.endsWith(".grounds-route.json"))!;
  unlinkSync(join(dirname(route.path), reservation));
  await assert.rejects(service.prepare(request), { code: "WORKTREE_MISMATCH" });
  assert.equal((await service.show(route.route_id)).state, "blocked");
  assert.equal(readFileSync(join(route.path, "service.txt"), "utf8"), "first version\n");
});
