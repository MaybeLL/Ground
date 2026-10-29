import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { codeWorkspaceFixture } from "./code-workspace-fixture.js";
import { actor, executionFixture } from "./code-route-execution-fixture.js";
import { hostIdentity } from "../src/runtime-files.js";
import { git } from "../src/env-git.js";
import { CodeWorkspaceCleanup } from "../src/code-workspace-cleanup.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";
import { CodeRouteExecutions, type RouteEngine } from "../src/code-route-execution.js";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { newUUIDv7 } from "../src/identity.js";
import { DatabaseSync } from "node:sqlite";

async function fixture(t: Parameters<typeof codeWorkspaceFixture>[0]) {
  const x = await codeWorkspaceFixture(t), hostId = hostIdentity(join(x.dataRoot, "runtime"));
  const instance = await x.service.createInstance({ ...actor(), configuration_id: x.configurationId, configuration_version: 1,
    issue_id: x.ledger.issue.issue_id, issue_version: 1, host_id: hostId });
  const prepared = await x.service.prepareInstance({ instance_id: instance.instance_id, host_id: hostId, data_root: x.dataRoot });
  return { ...x, hostId, instance: prepared, cleanup: new CodeWorkspaceCleanup(x.ledger.store),
    ref: { instance_id: instance.instance_id, host_id: hostId, data_root: x.dataRoot } };
}

test("explicit end preserves the instance and configuration, defaults to seven days and blocks preparation", async t => {
  const x = await fixture(t), request = { ...x.ref, ...actor(), expected_version: 0 };
  const ended = await x.cleanup.end(request);
  assert.equal(ended.lifecycle!.state, "ended");
  assert.equal(Date.parse(ended.lifecycle!.retain_until) - Date.parse(ended.lifecycle!.ended_at), 604800000);
  assert.equal(ended.lifecycle!.pinned, false);
  assert.equal(ended.lifecycle!.version, 1);
  assert.deepEqual(ended.configuration, x.instance.configuration);
  assert.equal(existsSync(x.instance.baselines[0]!.path), true);
  assert.deepEqual(await x.cleanup.end(request), ended);
  await assert.rejects(x.service.prepareInstance(x.ref), { code: "STATE_CONFLICT" });
  await assert.rejects(x.service.inspectPreparedInstance(x.ref), { code: "STATE_CONFLICT" });
  const pinned = await x.cleanup.end({ ...x.ref, ...actor(), expected_version: 1, pinned: true });
  assert.equal(pinned.lifecycle!.ended_at, ended.lifecycle!.ended_at);
  assert.equal(pinned.lifecycle!.pinned, true);
  await assert.rejects(x.cleanup.end({ ...x.ref, ...actor(), expected_version: 1, pinned: false }), { code: "STATE_CONFLICT" });
});

test("cleanup preview preserves ignored and untracked files and enforces retention and pinning", async t => {
  const x = await fixture(t), baseline = x.instance.baselines[0]!.path;
  await assert.rejects(x.cleanup.preview(x.ref), { code: "STATE_CONFLICT" });
  await x.cleanup.end({ ...x.ref, ...actor(), expected_version: 0 });
  const initial = await x.cleanup.preview(x.ref);
  assert.equal(initial.resources[0]!.state, "eligible");
  assert.equal(initial.gate, "retention");
  assert.equal(initial.resources[0]!.estimated_bytes! > 0, true);
  await assert.rejects(x.cleanup.reclaim({ ...x.ref, ...actor(), expected_version: initial.lifecycle_version, plan_digest: initial.plan_digest }), { code: "STATE_CONFLICT" });
  assert.equal(existsSync(baseline), true);
  writeFileSync(join(baseline, "notes.txt"), "unique input\n");
  assert.equal((await x.cleanup.preview({ ...x.ref, early: true })).resources[0]!.reason, "unpreserved_files");
  git(["config", "core.excludesFile", join(x.root, "exclude")], { cwd: baseline });
  writeFileSync(join(x.root, "exclude"), "notes.txt\n");
  assert.equal((await x.cleanup.preview({ ...x.ref, early: true })).resources[0]!.reason, "unpreserved_files");
  assert.equal(readFileSync(join(baseline, "notes.txt"), "utf8"), "unique input\n");
  await x.cleanup.end({ ...x.ref, ...actor(), expected_version: 1, pinned: true });
  const pinned = await x.cleanup.preview({ ...x.ref, early: true });
  assert.equal(pinned.gate, "pinned");
  await assert.rejects(x.cleanup.reclaim({ ...x.ref, ...actor(), early: true, expected_version: pinned.lifecycle_version, plan_digest: pinned.plan_digest }), { code: "STATE_CONFLICT" });
});

test("reclaim rechecks its plan, removes only Git worktrees and retains baseline objects and history", async t => {
  const x = await fixture(t), path = x.instance.baselines[0]!.path;
  await x.cleanup.end({ ...x.ref, ...actor(), expected_version: 0 });
  const plan = await x.cleanup.preview({ ...x.ref, early: true });
  const request = { ...x.ref, ...actor(), expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest, early: true };
  writeFileSync(join(path, "new-input"), "preserve me");
  await assert.rejects(x.cleanup.reclaim(request), { code: "STATE_CONFLICT" });
  assert.equal(readFileSync(join(path, "new-input"), "utf8"), "preserve me");
  unlinkSync(join(path, "new-input"));
  const result = await x.cleanup.reclaim(request);
  assert.equal(result.resources[0]!.state, "removed");
  assert.equal(existsSync(path), false);
  assert.equal((await x.service.instance(x.instance.instance_id)).lifecycle!.state, "code_reclaimed");
  assert.deepEqual(await x.cleanup.reclaim(request), result);
  const cache = join(x.dataRoot, "cache", "repos", x.instance.target_repository_id);
  assert.equal(git(["rev-parse", `refs/grounds/workspace-baselines/${x.instance.instance_id}/${x.instance.target_repository_id}`], { gitDir: cache }), x.firstCommit.slice(5));
  assert.deepEqual((await x.service.instance(x.instance.instance_id)).configuration, x.instance.configuration);
  assert.equal((await x.cleanup.preview({ ...x.ref, early: true })).resources[0]!.state, "removed");
  mkdirSync(path);
  writeFileSync(join(path, "later-owner"), "do not remove");
  await x.cleanup.reclaim(request);
  assert.equal(readFileSync(join(path, "later-owner"), "utf8"), "do not remove");
  assert.equal((await x.cleanup.preview({ ...x.ref, early: true })).resources[0]!.reason, "resource_replaced_after_cleanup");
  assert.deepEqual((await x.ledger.store.inspectIntegrity()).report, { valid: true, issues: [] });
});

test("cleanup recovers a lost Git removal reply and preserves a replacement directory on retry", async t => {
  const x = await fixture(t), path = x.instance.baselines[0]!.path;
  await x.cleanup.end({ ...x.ref, ...actor(), expected_version: 0, retention_days: 0 });
  const plan = await x.cleanup.preview(x.ref);
  const request = { ...x.ref, ...actor(), expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest };
  const restore = x.failAfterGit("remove");
  try { await assert.rejects(x.cleanup.reclaim(request), { code: "STATE_CONFLICT" }); } finally { restore(); }
  assert.equal(existsSync(path), false);
  assert.equal((await x.service.instance(x.instance.instance_id)).lifecycle!.cleanup_operation_id, request.operation_id);
  mkdirSync(path); writeFileSync(join(path, "replacement"), "new owner");
  await assert.rejects(x.cleanup.reclaim(request), { code: "STATE_CONFLICT" });
  assert.equal(readFileSync(join(path, "replacement"), "utf8"), "new owner");
  // Move the new owner's directory aside explicitly; the collector must never do this itself.
  const { renameSync } = await import("node:fs");
  renameSync(path, join(x.root, "replacement-preserved"));
  const recovered = await x.cleanup.reclaim(request);
  assert.equal(recovered.resources[0]!.state, "removed");
  assert.equal(readFileSync(join(x.root, "replacement-preserved", "replacement"), "utf8"), "new owner");
  assert.deepEqual(await x.cleanup.reclaim(request), recovered);
});

test("a second CLI resumes only the original cleanup after Git removal and process termination", { timeout: 120_000 }, async t => {
  const x = await fixture(t), baseline = x.instance.baselines[0]!.path;
  await x.cleanup.end({ ...x.ref, ...actor(), expected_version: 0, retention_days: 0 });
  const plan = await x.cleanup.preview(x.ref), operation = newUUIDv7();
  const config = join(x.root, "process-config.json"), marker = join(x.root, "removed-marker");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const entry = ["--import", "tsx", fileURLToPath(new URL("../src/main.ts", import.meta.url)), "code-workspace"];
  const request = (id: string, digest = plan.plan_digest) => ["cleanup", x.instance.instance_id,
    "--expected-version", String(plan.lifecycle_version), "--plan-digest", digest, "--operation-id", id,
    "--agent-id", "fixture", "--agent-name", "Fixture", "--config", config, "--json"];
  const call = (args: string[], expected = 0) => {
    const reply = spawnSync(process.execPath, [...entry, ...args], { encoding: "utf8", timeout: 30_000 });
    assert.equal(reply.error, undefined, reply.stderr);
    const envelope = JSON.parse(reply.stdout); assertContract("cli-envelope.schema.json", envelope);
    assert.equal(reply.status, expected, reply.stdout + reply.stderr);
    if (expected) assert.equal(envelope.error.code, "STATE_CONFLICT");
    return expected ? envelope.error : envelope.data;
  };
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shim = join(x.root, "git-reply-gate"); mkdirSync(shim);
  writeFileSync(join(shim, "git"), `#!${process.execPath}\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');const a=process.argv.slice(2);const r=spawnSync(${JSON.stringify(realGit)},a,{encoding:'utf8'});if(r.status===0&&a.includes('worktree')&&a.includes('remove')&&a.includes(${JSON.stringify(baseline)})){fs.writeFileSync(${JSON.stringify(marker)},'removed');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}fs.writeFileSync(1,r.stdout||'');fs.writeFileSync(2,r.stderr||'');process.exitCode=r.status??98;\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [...entry, ...request(operation)], { detached: true,
    env: { ...process.env, PATH: shim + ":" + process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let output = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(marker) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
    assert.ok(existsSync(marker), output);
    assert.equal(existsSync(baseline), false);
    call(request(operation), 4); call(request(newUUIDv7()), 4);
    process.kill(-child.pid!, "SIGKILL"); assert.equal((await closed)[1], "SIGKILL");
    const fresh = call(["cleanup-preview", x.instance.instance_id, "--config", config, "--json"]).plan;
    // Git removal is real, but its durable receipt is still pending. A preview
    // must not turn that unknown window into a completed cleanup claim.
    assert.equal(fresh.resources[0].state, "blocked");
    assert.equal(fresh.resources[0].reason, "inspection_unconfirmed");
    assert.match(call(request(newUUIDv7(), fresh.plan_digest), 4).message, /Recover the original cleanup operation/);
    const result = call(request(operation)).cleanup;
    assert.equal(result.resources[0].state, "removed");
    assert.deepEqual(call(request(operation)).cleanup, result);
    assert.equal((await x.service.instance(x.instance.instance_id)).lifecycle!.state, "code_reclaimed");
    const cache = join(x.dataRoot, "cache", "repos", x.instance.target_repository_id);
    assert.equal(git(["rev-parse", `refs/grounds/workspace-baselines/${x.instance.instance_id}/${x.instance.target_repository_id}`], { gitDir: cache }), x.firstCommit.slice(5));
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
    await closed;
  }
});

test("cleanup completion SQL failure rolls back lifecycle and resumes without deleting a later directory", async t => {
  const x = await fixture(t), baseline = x.instance.baselines[0]!.path;
  await x.cleanup.end({ ...x.ref, ...actor(), expected_version: 0, retention_days: 0 });
  const plan = await x.cleanup.preview(x.ref);
  const request = { ...x.ref, ...actor(), expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest };
  // A real SQLite transaction failure at the final journal update, after the
  // lifecycle update in that transaction and after Git removal has succeeded.
  const db = new DatabaseSync(x.ledgerPath);
  try {
    db.exec(`CREATE TRIGGER fail_workspace_cleanup_completion BEFORE UPDATE ON runtime_records
      WHEN json_extract(NEW.record_json, '$.data.format') = 'grounds.code-workspace-cleanup/v1'
        AND json_extract(NEW.record_json, '$.data.phase') = 'completed'
      BEGIN SELECT RAISE(ABORT, 'injected cleanup completion failure'); END`);
    await assert.rejects(x.cleanup.reclaim(request));
    assert.equal(existsSync(baseline), false);
    const interrupted = await x.service.instance(x.instance.instance_id);
    assert.equal(interrupted.lifecycle!.state, "ended");
    assert.equal(interrupted.lifecycle!.cleanup_operation_id, request.operation_id);
    assert.equal(interrupted.lifecycle!.version, plan.lifecycle_version + 1);
    await assert.rejects(x.cleanup.reclaim({ ...request, operation_id: newUUIDv7() }), { code: "STATE_CONFLICT" });
    db.exec("DROP TRIGGER fail_workspace_cleanup_completion");
    mkdirSync(baseline); writeFileSync(join(baseline, "new-owner"), "preserve later content");
    const completed = await x.cleanup.reclaim(request);
    assert.equal(completed.resources[0]!.state, "removed", "original resource receipt, not current path availability");
    assert.equal(readFileSync(join(baseline, "new-owner"), "utf8"), "preserve later content");
    assert.equal((await x.service.instance(x.instance.instance_id)).lifecycle!.state, "code_reclaimed");
    assert.equal((await x.cleanup.preview(x.ref)).resources[0]!.reason, "resource_replaced_after_cleanup");
    assert.deepEqual(await x.cleanup.reclaim(request), completed);
  } finally { db.close(); }
});

test("CLI ends, previews and reclaims an instance with explicit version, digest and replay identity", async t => {
  const x = await fixture(t), config = join(x.root, "cli.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const run = async (...args: string[]) => {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", ...args, "--config", config, "--json"],
      { cwd: x.root, stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n"));
    assertContract("cli-envelope.schema.json", envelope);
    return { code, envelope };
  };
  const who = ["--agent-id", "fixture", "--agent-name", "Fixture"];
  const ended = await run("end", x.instance.instance_id, "--expected-version", "0", ...who);
  assert.equal(ended.code, 0, JSON.stringify(ended.envelope));
  assert.equal(ended.envelope.data.instance.lifecycle.state, "ended");
  const invalid = await run("cleanup-preview", x.instance.instance_id, "--early=perhaps");
  assert.equal(invalid.code, 2);
  const preview = await run("cleanup-preview", x.instance.instance_id, "--early");
  assert.equal(preview.code, 0, JSON.stringify(preview.envelope));
  const plan = preview.envelope.data.plan;
  const args = ["cleanup", x.instance.instance_id, "--expected-version", String(plan.lifecycle_version),
    "--plan-digest", plan.plan_digest, "--early", "--operation-id", actor().operation_id, ...who];
  const result = await run(...args);
  assert.equal(result.code, 0, JSON.stringify(result.envelope));
  assert.equal(result.envelope.data.cleanup.resources[0].state, "removed");
  assert.deepEqual((await run(...args)).envelope.data, result.envelope.data);
  assert.equal((await run("show", x.instance.instance_id)).envelope.data.instance.lifecycle.state, "code_reclaimed");
});

test("a cancelled unchanged route needs no Candidate but active or paused execution prevents abandonment and ending", async t => {
  const x = await executionFixture(t), config = join(x.root, "cli.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const operation = actor().operation_id;
  const abandon = async () => {
    const lines: string[] = [];
    const code = await runCLI(["devrun", "abandon", "--dev-run", x.route.dev_run_id!, "--expected-version", "1",
      "--operation-id", operation, "--agent-id", "fixture", "--agent-name", "Fixture", "--config", config, "--json"],
      { cwd: x.route.path, stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n")); assertContract("cli-envelope.schema.json", envelope);
    return { code, envelope };
  };
  let container: string | undefined;
  const engine: RouteEngine = { identity: async () => "isolated-engine", create: async run => (container = run.execution_id), start: async () => {},
    find: async () => container, removeStopped: async () => { container = undefined; }, pause: async () => {}, assertPaused: async () => {}, resume: async () => {} };
  const executions = new CodeRouteExecutions(x.ledger.store, engine), cleanup = new CodeWorkspaceCleanup(x.ledger.store);
  const location = { instance_id: x.instance.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image: `sha256:${"1".repeat(64)}`, argv: ["true"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id };
  assert.notEqual((await abandon()).code, 0);
  await assert.rejects(cleanup.end({ ...location, ...actor(), expected_version: 0 }), { code: "STATE_CONFLICT" });
  await executions.pause({ ...ref, ...actor() });
  assert.notEqual((await abandon()).code, 0);
  await assert.rejects(cleanup.end({ ...location, ...actor(), expected_version: 0 }), { code: "STATE_CONFLICT" });
  await executions.stop(ref);
  const result = await abandon();
  assert.equal(result.code, 0, JSON.stringify(result.envelope));
  assert.deepEqual((await abandon()).envelope.data, result.envelope.data);
  await cleanup.end({ ...location, ...actor(), expected_version: 0, retention_days: 0 });
  const plan = await cleanup.preview(location);
  assert.equal(plan.resources.length, 2);
  assert.equal(plan.resources.every(resource => resource.state === "eligible"), true);
  const reclaimed = await cleanup.reclaim({ ...location, ...actor(), expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest });
  assert.equal(reclaimed.resources.every(resource => resource.state === "removed"), true);
});
