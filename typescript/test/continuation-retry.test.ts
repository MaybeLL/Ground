import { repositoryDataRoot } from "../src/data-layout.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";
import { deriveLocalGitArtifact } from "../src/git-artifact-local.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import { runCLI, parseArgs, commandNeedsOperationID } from "../src/cli.js";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { resolveBaseline } from "../src/git.js";
import { newUUIDv7 } from "../src/identity.js";
import { Module } from "../src/module.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { SQLStore } from "../src/sql-store.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { isolatedPostgres, postgresEnabled, rawConnection } from "./isolated-postgres.js";
import { PreflightService } from "../src/preflight.js";
import { establishPreflight, reviseTargetIssue } from "./preflight-fixture.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
async function fixture(t: { after(f: () => Promise<void>): void }, driver: "sqlite" | "mysql" | "postgres") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-continuation-"))), cwd = join(root, "repo"), remote = join(root, "origin.git");
  git(root, "init", "--bare", "-q", remote); git(root, "init", "-qb", "main", cwd);
  git(cwd, "config", "user.name", "Continuation Test"); git(cwd, "config", "user.email", "continuation@invalid");
  git(cwd, "remote", "add", "origin", "ssh://git@example.test/team/repo"); git(cwd, "config", `url.file://${remote}.insteadOf`, "ssh://git@example.test/team/repo");
  writeFileSync(join(cwd, ".gitignore"), ".grounds/\n"); writeFileSync(join(cwd, "feature"), "base\n"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "base"); git(cwd, "push", remote, "HEAD:refs/heads/main"); git(cwd, "fetch", "origin");
  const base = resolveBaseline(cwd, "HEAD"), path = join(root, "ledger.db");
  const pg = driver === "postgres" ? await isolatedPostgres() : undefined;
  const settings = pg ? { host: pg.connection.host, port: pg.connection.port, database: pg.database, username: pg.connection.username, password: pg.connection.password, caFile: pg.connection.caFile } : { host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306), database: process.env.GROUNDS_TEST_MYSQL_DATABASE!, username: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE };
  const store = pg ? pg.store : driver === "sqlite" ? SQLStore.sqlite(path) : SQLStore.mysql(settings);
  const f = await LedgerFixture.createWithStore(store, pg?.cleanup ?? (() => store.close()), { preflightCoordinator: new PreflightService(store, cwd).coordinator({ refresh: true }) });
  const passwordVariable = driver === "postgres" ? "GROUNDS_POSTGRES_PASSWORD" : "GROUNDS_MYSQL_PASSWORD";
  const previousPassword = process.env[passwordVariable];
  if (driver !== "sqlite") process.env[passwordVariable] = settings.password;
  t.after(async () => { await f.close(); rmSync(root, { recursive: true, force: true }); if (previousPassword === undefined) delete process.env[passwordVariable]; else process.env[passwordVariable] = previousPassword; });
  const revised = await reviseTargetIssue(f.module, f.store, cwd, { operation_id: newUUIDv7(), attribution: testAgent, issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true,
    baseline: { git_oid: base, reachability: "remote_tracking_reachable" }, input: { format: 1, summary: "续作重试夹具", target_branch: { remote: "origin", ref: "refs/heads/main" }, goals: [{ statement: "固定候选", criteria: ["代码可用"] }] } });
  await establishPreflight(f.store, cwd, { issueId: f.issue.issue_id, issueRevisionId: revised.result.issue_revision_id, repositoryId: f.repository.repository_id });
  const database = (await f.store.inspect()).database_id, config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: driver === "sqlite" ? { driver, path, expected_database_id: database } : { driver, host: settings.host, port: settings.port, database: settings.database, username: settings.username, tls: { mode: "verify_identity", ca_file: process.env.GROUNDS_TEST_MYSQL_CA_FILE }, password: { source: "environment", variable: passwordVariable }, expected_database_id: database } }));
  const transport = archiveCLITransport(t, root, remote, f.repository.repository_id), archivePolicy = transport.policy();
  git(cwd, "config", "--unset", `url.file://${remote}.insteadOf`);
  store.setGitArtifactResolver(ref => deriveLocalGitArtifact(cwd, ref.git_artifact!.binding));
  const registry = join(root, "registry");
  const invoke = async (args: string[]) => {
    const op = commandNeedsOperationID(parseArgs(args));
    if (op && !args.includes("--operation-id")) args = [...args, "--operation-id", newUUIDv7()];
    if (op) args = [...args, "--agent-id", "continuation-regression", "--agent-name", "续作回归夹具"];
    const lines: string[] = [];
    const code = await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: registry }, () => runCLI([...args, "--config", config, "--json"], { cwd, stdout: s => lines.push(s), stderr: () => {} }));
    return { code, envelope: JSON.parse(lines.join("\n")) };
  };
  const ok = async (args: string[]) => { const result = await invoke(args); assert.equal(result.code, 0, JSON.stringify(result.envelope)); return result.envelope.data; };
  const plan = await ok(["devrun", "plan", "--issue-slug", "fixture", "--repository", f.repository.repository_id, "--definition-commit", base, "--target-remote", "origin", "--target-branch", "refs/heads/main"]);
  const run = (await ok(["devrun", "start", "--development-mode", "simple", "--issue", f.issue.issue_id, "--plan", plan.plan.workspace_id, "--refresh"])).context.dev_run.id;
  writeFileSync(join(plan.plan.path, "feature"), "candidate\n"); git(plan.plan.path, "add", "."); git(plan.plan.path, "commit", "-qm", "candidate");
  const template = await ok(["candidate", "template", "--dev-run", run]), submission = template.submission;
  submission.explanation = "真实续作重试回归代码";
  for (const c of submission.claims) { c.explanation = "固定回归工件"; for (const q of c.criteria) { q.explanation = "本夹具只验证续作恢复"; q.self_verification = { status: "not_verified", explanation: "不是模型独立验收" }; } }
  for (const r of submission.change_rationales) { r.target_refs = [{ type: "criterion", id: submission.claims[0].criteria[0].criterion_id }]; r.rationale = "固定续作回归代码"; }
  const file = join(root, "submission.json"); writeFileSync(file, JSON.stringify(submission));
  const archiveArgs = ["candidate", "submit", "--dev-run", run, "--expected-version", "1", "--file", file, "--archive-policy", archivePolicy, "--operation-id", newUUIDv7()];
  const statePath = join(repositoryDataRoot(cwd), "devruns", run, "state.json"), initialMarker = readFileSync(statePath);
  chmodSync(dirname(statePath), 0o500);
  try { assert.notEqual((await invoke(archiveArgs)).code, 0); } finally { chmodSync(dirname(statePath), 0o700); }
  const archiveAudit = await f.store.read(tx => tx.getOperation(archiveArgs.at(-1)!)); assert.ok(archiveAudit);
  const archived = JSON.parse(archiveAudit.result_json).data;
  const head = resolveBaseline(plan.plan.path, "HEAD"), trees = new DevWorktreeModule(cwd, database, newUUIDv7, f.store, registry);
  const continueArgs = (policy: string, op: string, version = "2") => ["devrun", "continue", "--dev-run", run, "--expected-version", version, "--expected-head", head, "--policy", policy, "--operation-id", op];
  const context = () => ok(["devrun", "context", "--dev-run", run]);
  return { f, root, cwd, run, head, trees, invoke, ok, continueArgs, context, archiveArgs, archived, archiveAudit, initialMarker, settings, worktree: plan.plan.path, statePath, openOther: () => pg ? pg.open() : driver === "sqlite" ? SQLStore.sqlite(path) : SQLStore.mysql(settings) };
}

for (const driver of ["sqlite", "mysql", "postgres"] as const) test(`${driver}: continuation preserves latest decisions and recoverable SQL receipts`, { skip: driver === "mysql" ? !process.env.GROUNDS_TEST_MYSQL_DATABASE : driver === "postgres" ? !postgresEnabled : false }, async t => {
  const x = await fixture(t, driver);
  await t.test("first archive SQL success with active marker safely restores the default pause", async () => {
    assert.equal(JSON.parse(readFileSync(x.statePath, "utf8")).lifecycle, "active");
    assert.equal((await x.context()).local_worktree.status, "invalid");
    await assert.rejects(x.trees.capture(x.run, async () => "unsafe"), (e: any) => /archive.*ahead/.test(e.details?.reason));
    assert.deepEqual(await x.ok(x.archiveArgs), x.archived);
    assert.equal((await x.context()).local_worktree.continuation, "paused"); assert.equal(await x.f.store.read(tx => tx.getDevelopmentContinuation(x.run)), undefined);
    assert.deepEqual(await x.f.store.read(tx => tx.getOperation(x.archiveArgs.at(-1)!)), x.archiveAudit);
  });
  await t.test("parallel then paused then old parallel replay", async () => {
    const a = newUUIDv7(), b = newUUIDv7(), first = await x.ok(x.continueArgs("parallel", a));
    const audit = await x.f.store.read(tx => tx.getOperation(a)); await x.ok(x.continueArgs("paused", b));
    const highWater = await x.f.store.read(tx => tx.ledgerHighWater());
    assert.deepEqual(await x.ok(x.continueArgs("parallel", a)), first); assert.equal((await x.context()).local_worktree.continuation, "paused");
    assert.deepEqual(await x.f.store.read(tx => tx.getOperation(a)), audit); assert.equal(await x.f.store.read(tx => tx.ledgerHighWater()), highWater);
  });
  await t.test("paused then parallel then old paused replay", async () => {
    const a = newUUIDv7(), b = newUUIDv7(), first = await x.ok(x.continueArgs("paused", a)); await x.ok(x.continueArgs("parallel", b));
    assert.deepEqual(await x.ok(x.continueArgs("paused", a)), first); assert.equal((await x.context()).local_worktree.continuation, "parallel");
  });
  await t.test("old Candidate archive receipt retains the current explicit parallel policy", async () => {
    await x.ok(x.continueArgs("parallel", newUUIDv7())); const state = readFileSync(x.statePath);
    assert.deepEqual(await x.ok(x.archiveArgs), x.archived); assert.deepEqual(JSON.parse(readFileSync(x.statePath, "utf8")), JSON.parse(state.toString()));
    assert.equal((await x.context()).local_worktree.continuation, "parallel");
  });
  await t.test("lagging original active archive marker applies a later authoritative policy", async () => {
    await x.ok(x.continueArgs("parallel", newUUIDv7()));
    // The exact bytes retained by the real first SQL-success/filesystem-denial
    // window recreate a lagging local marker; no SQL history is edited.
    writeFileSync(x.statePath, x.initialMarker); assert.equal((await x.context()).local_worktree.status, "invalid");
    assert.deepEqual(await x.ok(x.archiveArgs), x.archived); assert.equal((await x.context()).local_worktree.continuation, "parallel");
  });
  await t.test("SQL success and real filesystem denial recover with the same operation", async () => {
    await x.ok(x.continueArgs("parallel", newUUIDv7())); const op = newUUIDv7();
    chmodSync(dirname(x.statePath), 0o500);
    try { assert.notEqual((await x.invoke(x.continueArgs("paused", op))).code, 0); }
    finally { chmodSync(dirname(x.statePath), 0o700); }
    const audit = await x.f.store.read(tx => tx.getOperation(op)); assert.ok(audit);
    assert.equal((await x.context()).local_worktree.status, "invalid");
    await assert.rejects(x.trees.capture(x.run, async () => "unsafe"), (error: any) => /continuation differs/.test(error.details?.reason));
    await x.ok(x.continueArgs("paused", op)); assert.equal((await x.context()).local_worktree.continuation, "paused"); assert.deepEqual(await x.f.store.read(tx => tx.getOperation(op)), audit);
  });
  await t.test("failed filesystem receipt cannot supersede a later decision", async () => {
    const old = newUUIDv7(); chmodSync(dirname(x.statePath), 0o500);
    try { assert.notEqual((await x.invoke(x.continueArgs("parallel", old))).code, 0); }
    finally { chmodSync(dirname(x.statePath), 0o700); }
    assert.ok(await x.f.store.read(tx => tx.getOperation(old))); await x.ok(x.continueArgs("paused", newUUIDv7()));
    await x.ok(x.continueArgs("parallel", old)); assert.equal((await x.context()).local_worktree.continuation, "paused");
  });
  await t.test("changed request hash and stale version retain the current pause", async () => {
    const op = newUUIDv7(); await x.ok(x.continueArgs("paused", op)); const audit = await x.f.store.read(tx => tx.getOperation(op));
    assert.notEqual((await x.invoke(x.continueArgs("parallel", op))).code, 0);
    const stale = newUUIDv7(); assert.notEqual((await x.invoke(x.continueArgs("parallel", stale, "1"))).code, 0);
    assert.equal(await x.f.store.read(tx => tx.getOperation(stale)), undefined); assert.deepEqual(await x.f.store.read(tx => tx.getOperation(op)), audit); assert.equal((await x.context()).local_worktree.continuation, "paused");
  });
  await t.test("changed HEAD does not apply an old decision", async () => {
    const op = newUUIDv7(); await x.ok(x.continueArgs("parallel", op));
    writeFileSync(join(x.worktree, "later"), "later\n"); git(x.worktree, "add", "."); git(x.worktree, "commit", "-qm", "later checkpoint");
    const marker = readFileSync(x.statePath); assert.notEqual((await x.invoke(x.continueArgs("parallel", op))).code, 0); assert.deepEqual(readFileSync(x.statePath), marker);
    git(x.worktree, "reset", "--hard", x.head.slice(5));
    git(x.worktree, "commit", "--allow-empty", "-qm", "same tree different source");
    assert.notEqual((await x.invoke(x.archiveArgs)).code, 0); assert.deepEqual(readFileSync(x.statePath), marker);
    git(x.worktree, "reset", "--hard", x.head.slice(5));
  });
  await t.test("later route owner and marker order cannot be overwritten", async () => {
    const op = newUUIDv7(); await x.ok(x.continueArgs("paused", op));
    const ownerPath = join(dirname(x.worktree), "owner.json"), owner = readFileSync(ownerPath), marker = readFileSync(x.statePath);
    writeFileSync(ownerPath, JSON.stringify({ ...JSON.parse(owner.toString()), dev_run_id: newUUIDv7() }));
    try { assert.notEqual((await x.invoke(x.continueArgs("paused", op))).code, 0); assert.deepEqual(readFileSync(x.statePath), marker); } finally { writeFileSync(ownerPath, owner); }
    const raw = JSON.parse(marker.toString()); raw.continuation_decision.event_seq += 100;
    writeFileSync(x.statePath, JSON.stringify(raw));
    try { assert.notEqual((await x.invoke(x.continueArgs("paused", op))).code, 0); } finally { writeFileSync(x.statePath, marker); }
    const wrongRoute = JSON.parse(marker.toString()); wrongRoute.development.branch += "-different"; writeFileSync(x.statePath, JSON.stringify(wrongRoute));
    try { assert.notEqual((await x.invoke(x.continueArgs("paused", op))).code, 0); } finally { writeFileSync(x.statePath, marker); }
  });
  await t.test("archive completion reinspects a marker changed after its SQL callback", async () => {
    const original = readFileSync(x.statePath), changed = JSON.parse(original.toString()); changed.continuation_decision.event_seq += 100;
    try {
      await assert.rejects(x.trees.submit(x.run, async () => { writeFileSync(x.statePath, JSON.stringify(changed)); return x.archived; }), (e: any) => /order regressed/.test(e.details?.reason));
      assert.deepEqual(JSON.parse(readFileSync(x.statePath, "utf8")), changed);
    } finally { writeFileSync(x.statePath, original); }
  });
  await t.test("independent SQL connections serialize competing policies; old public replay applies latest", async () => {
    const other = x.openOther(); const actor = { kind: "agent" as const, agent_id: "continuation-regression", display_name: "续作回归夹具" };
    const a = { operation_id: newUUIDv7(), dev_run_id: x.run, expected_version: 2, expected_head: x.head, policy: "parallel" as const, attribution: actor }, b = { ...a, operation_id: newUUIDv7(), policy: "paused" as const };
    try { await Promise.all([x.f.module.recordDevelopmentContinuation(a), new Module(other).recordDevelopmentContinuation(b)]); } finally { await other.close(); }
    const latest = await x.f.store.read(tx => tx.getDevelopmentContinuation(x.run)); assert.ok(latest);
    assert.equal((await x.context()).local_worktree.status, "invalid");
    await x.ok(x.continueArgs("parallel", a.operation_id)); assert.equal((await x.context()).local_worktree.continuation, latest.policy);
    await x.ok(x.continueArgs("paused", b.operation_id)); assert.equal((await x.context()).local_worktree.continuation, latest.policy);
  });
  await t.test("new policy competing with current completed-operation replay does not reverse locks or facts", async () => {
    const old = newUUIDv7(); await x.ok(x.continueArgs("paused", old)); const audit = await x.f.store.read(tx => tx.getOperation(old));
    const other = x.openOther(), attribution = { kind: "agent" as const, agent_id: "continuation-regression", display_name: "续作回归夹具" };
    const replay = { operation_id: old, dev_run_id: x.run, expected_version: 2, expected_head: x.head, policy: "paused" as const, attribution };
    const next = { ...replay, operation_id: newUUIDv7(), policy: "parallel" as const };
    try { await Promise.all([x.f.module.recordDevelopmentContinuation(next), new Module(other).recordDevelopmentContinuation(replay)]); } finally { await other.close(); }
    assert.deepEqual(await x.f.store.read(tx => tx.getOperation(old)), audit);
    assert.equal((await x.f.store.read(tx => tx.getDevelopmentContinuation(x.run)))?.operation_id, next.operation_id);
    await x.ok(x.continueArgs("paused", old)); assert.equal((await x.context()).local_worktree.continuation, "parallel");
  });
});

test("mysql: current completed receipt remains readable while an independent connection holds its row", { skip: !process.env.GROUNDS_TEST_MYSQL_DATABASE }, async t => {
    const x = await fixture(t, "mysql"); await x.ok(x.archiveArgs);
    const old = newUUIDv7(); await x.ok(x.continueArgs("paused", old));
    const connection = await mysql.createConnection({ host: x.settings.host, port: x.settings.port, database: x.settings.database, user: x.settings.username, password: x.settings.password, ssl: { ca: readFileSync(x.settings.caFile!, "utf8"), rejectUnauthorized: true } });
    let action: Promise<unknown> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await connection.beginTransaction(); await connection.execute("SELECT operation_id FROM idempotency_records WHERE operation_id = ? FOR UPDATE", [old]);
      action = x.f.module.recordDevelopmentContinuation({ operation_id: newUUIDv7(), dev_run_id: x.run, expected_version: 2, expected_head: x.head, policy: "parallel", attribution: { kind: "agent", agent_id: "continuation-regression", display_name: "续作回归夹具" } });
      await Promise.race([action, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("current receipt lookup waited on a completed-operation row lock")), 15000); })]);
    } finally {
      if (timer) clearTimeout(timer); await connection.rollback(); await connection.end(); if (action) await action;
    }
    await x.ok(x.continueArgs("paused", old)); assert.equal((await x.context()).local_worktree.continuation, "parallel");
});

test("postgres: current completed receipt remains readable while an independent connection holds its row", { skip: !postgresEnabled }, async t => {
  const x = await fixture(t, "postgres"); await x.ok(x.archiveArgs);
  const old = newUUIDv7(); await x.ok(x.continueArgs("paused", old));
  const connection = await rawConnection(x.settings.database);
  let action: Promise<unknown> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await connection.query("BEGIN"); await connection.query("SELECT operation_id FROM idempotency_records WHERE operation_id = $1 FOR UPDATE", [old]);
    action = x.f.module.recordDevelopmentContinuation({ operation_id: newUUIDv7(), dev_run_id: x.run, expected_version: 2, expected_head: x.head, policy: "parallel", attribution: { kind: "agent", agent_id: "continuation-regression", display_name: "续作回归夹具" } });
    await Promise.race([action, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("current receipt lookup waited on a completed-operation row lock")), 15000); })]);
  } finally {
    if (timer) clearTimeout(timer); await connection.query("ROLLBACK"); await connection.end(); if (action) await action;
  }
  await x.ok(x.continueArgs("paused", old)); assert.equal((await x.context()).local_worktree.continuation, "parallel");
});
