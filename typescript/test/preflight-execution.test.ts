import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LedgerFixture, testAgent } from "./fixture.js";
import { reviseTargetIssueSeeded, ledgerOnlyPreflightCoordinator } from "./preflight-fixture.js";
import { Module } from "../src/module.js";
import { execute, runCLI } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { SQLStore } from "../src/sql-store.js";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { git } from "../src/env-git.js";
import { executeEnvironmentCommand, type EnvironmentCommandContext } from "../src/env-cli.js";
import { environmentDown, listEnvironments } from "../src/env-environment.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
const trustedGit=(cwd:string,args:string[])=>git(args,{cwd});
import { newUUIDv7 } from "../src/identity.js";
import { seedPublishPreflight } from "./preflight-fixture.js";
import { getCurrentAdmission, nextPreflightTransition, assertDevRunAdmitted } from "../src/preflight-admission.js";

async function patchRecord(x: Awaited<ReturnType<typeof fixture>>, id: string, patch: Record<string, unknown>) {
  await x.f.store.write(async tx => {
    const row = (await tx.getRuntimeRecord("runtime_operation", id))!;
    const data = Object.fromEntries(Object.entries({ ...row.data, ...patch }).filter(([, value]) => value !== undefined));
    await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data }, row.version);
  });
}

async function prepare(x: Awaited<ReturnType<typeof fixture>>, seq: number) {
  await x.f.store.write(tx => tx.saveRuntimeRecord({ id: newUUIDv7(), kind: "runtime_operation", parent_id: x.runId, version: 1,
    data: { format: "grounds.preflight-preparation/v1", dev_run_id: x.runId, transition_seq: seq, prepared_at: "2026-10-15T01:00:00Z" } }, 0));
}

async function admit(x: Awaited<ReturnType<typeof fixture>>, seq = 1) {
  const evidence = await seedPublishPreflight(x.f.store, {
    repositoryId: x.f.repository.repository_id, canonicalRemote: x.f.repository.canonical_remote,
    phase: "start", issueId: x.f.issue.issue_id, issueRevisionId: x.revisionId,
    target: { remote: "origin", ref: "refs/heads/main" }, commit: x.base,
  });
  const id = newUUIDv7();
  await x.f.store.write(tx => tx.saveRuntimeRecord({ id, kind: "runtime_operation", parent_id: x.runId, version: 1,
    data: { format: "grounds.preflight-admission/v1", dev_run_id: x.runId, issue_revision_id: x.revisionId,
      assessment_id: evidence.assessmentId, observation_id: evidence.observationId,
      base_commit: x.base, target_commit: x.base, transition_seq: seq, admitted_at: "2026-10-15T00:00:00Z" } }, 0));
  return { id, ...evidence };
}

async function fixture(target = true, publicCLI = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-admission-")));
  const config = join(root, "config.yaml"), db = join(root, "ledger.db");
  if (publicCLI) await execute(["init", "--driver", "sqlite", "--path", db, "--config", config, "--non-interactive", "--json"], { cwd: root });
  const f = publicCLI ? await LedgerFixture.createWithStore(SQLStore.sqlite(db)) : await LedgerFixture.create();
  const project = join(root, "project");
  mkdirSync(project);
  trustedGit(project, ["init", "-q", "-b", "main"]);
  trustedGit(project, ["config", "user.name", "Test"]);
  trustedGit(project, ["config", "user.email", "test@example.test"]);
  trustedGit(project, ["remote", "add", "origin", f.repository.canonical_remote]);
  writeFileSync(join(project, "file.txt"), "baseline\n");
  trustedGit(project, ["add", "."]);
  trustedGit(project, ["commit", "-qm", "baseline"]);
  const base = "sha1:" + trustedGit(project, ["rev-parse", "HEAD"]);
  trustedGit(project, ["update-ref", "refs/remotes/origin/main", base.slice(5)]);
  const predecessor = await f.module.currentIssueRevision(f.issue.issue_id);
  const command = {
    attribution: testAgent, issue_id: f.issue.issue_id,
    expected_predecessor_id: predecessor.id,
    requirement_revision_id: f.requirement.requirement_revision_id,
    requirement_revision_explicit: true,
    baseline: { git_oid: base, reachability: "unconfirmed" as const, warning: "fixture", override_reason: "fixture" },
    input: { format: 1 as const, summary: "Execution admission", ...(target ? { target_branch: { remote: "origin", ref: "refs/heads/main" } } : {}),
      goals: [{ statement: "Protect execution", criteria: ["Admission required"], traces_to: [{ type: "outcome" as const, ordinal: 1 }] }] },
  };
  const publisher = new Module(f.store, newUUIDv7, undefined, undefined, ledgerOnlyPreflightCoordinator(f.store));
  const issue = target ? await reviseTargetIssueSeeded(publisher, f.store, command)
    : await f.module.reviseIssue({ ...command, operation_id: newUUIDv7() });
  const runId = newUUIDv7();
  await f.store.write(async tx => tx.createDevRun({ dev_run: {
    id: runId, issue_revision_id: issue.result.issue_revision_id, version: 1, state: "open",
    ...(target ? { base_commit: base, initial_base_commit: base } : {}), created_at: await tx.now(), attribution: testAgent,
    repository_remote_snapshot: f.repository.canonical_remote,
  } }));
  const directories={runtimeHome:join(root,"runtime"),directoryRegistryHome:join(root,"registry")};
  const scoped=<T>(action:()=>T):T=>withRuntimeDirectories(directories,action);
  const context:EnvironmentCommandContext={resolveRepository:async(_workspace,id)=>{
    assert.equal(id,runId);await f.module.assertDevelopmentAdmission(runId);
    return {taskRepositoryId:f.repository.repository_id,resolvedRepositoryId:f.repository.repository_id,devRunId:runId,inputCommit:base};
  }};
  const up=()=>scoped(()=>executeEnvironmentCommand({positionals:["env","up"],values:{"dev-run":runId}},project,context)) as Promise<any>;
  const run=async(environmentId:string)=>{
    const argv=join(root,"argv.json");writeFileSync(argv,JSON.stringify(["sh","-c","echo dispatched > command-ran"]));
    return scoped(()=>executeEnvironmentCommand({positionals:["env","run",environmentId],values:{"argv-file":argv}},project,context)) as Promise<any>;
  };
  return { f, runId, base, config, revisionId: issue.result.issue_revision_id, project, root, scoped, up, run,
    close: async () => { scoped(()=>{for(const environment of listEnvironments())environmentDown(environment.id);});await f.close();rmSync(root,{recursive:true,force:true}); } };

}

test("admitted target and historical no-target runs reach unified trusted-host dispatch", async () => {
  for (const target of [true, false]) {
    const x=await fixture(target);
    try { if(target)await admit(x);const prepared=await x.up();const executed=await x.run(prepared.environment.id);assert.equal(executed.run.state,"succeeded");assert.ok(existsSync(join(x.project,"command-ran"))); }
    finally {await x.close();}
  }
});

test("new preparation revokes a grant and older/later-written grants cannot override its sequence", async () => {
  const x = await fixture();
  try {
    await admit(x, 5);
    await prepare(x, 6);
    await admit(x, 4);
    assert.equal(await x.f.store.read(tx => getCurrentAdmission(tx, x.runId)), undefined);
    await assert.rejects(x.up(), /requires preflight admission/);
    assert.equal(x.scoped(()=>listEnvironments().length),0);
  } finally { await x.close(); }
});

test("active sync revokes admission without a read-side SQL write lock", async () => {
  const x = await fixture();
  try {
    await admit(x);
    await x.f.store.write(tx => tx.reserveDevRunSync({ id: newUUIDv7(), kind: "runtime_operation", parent_id: x.runId,
      version: 1, data: { format: "grounds.devrun-sync/v1", phase: "reserved", dev_run_id: x.runId,
        original_base: x.base, target: "sha1:1111111111111111111111111111111111111111", run_version: 2,
        created_at: "2026-10-15T01:00:00Z", attribution: testAgent, recovery: { host_id: "fixture", directory: x.project } } }, 1));
    assert.equal(await x.f.store.read(tx => getCurrentAdmission(tx, x.runId)), undefined);
  } finally { await x.close(); }
});

test("transition allocation ignores unrelated records; legacy timestamps never override sequenced transitions", async () => {
  const x = await fixture();
  try {
    assert.equal(await x.f.store.read(tx => nextPreflightTransition(tx, x.runId)), 1);
    const grant = await admit(x, 8);
    await x.f.store.write(tx => tx.saveRuntimeRecord({ id: newUUIDv7(), kind: "runtime_operation", parent_id: x.runId,
      version: 1, data: { format: "unrelated", transition_seq: 1000 } }, 0));
    const legacy = await admit(x, 0);
    await patchRecord(x, legacy.id, { transition_seq: undefined, admitted_at: "2099-01-01T00:00:00Z" });
    assert.equal((await x.f.store.read(tx => getCurrentAdmission(tx, x.runId)))?.id, grant.id);
    assert.equal(await x.f.store.read(tx => nextPreflightTransition(tx, x.runId)), 9);
    await patchRecord(x, grant.id, { transition_seq: undefined, admitted_at: "2100-01-01T00:00:00Z" });
    assert.equal((await x.f.store.read(tx => getCurrentAdmission(tx, x.runId)))?.id, grant.id);
    await patchRecord(x, legacy.id, { admitted_at: "2100-01-01T00:00:00Z" });
    assert.equal((await x.f.store.read(tx => getCurrentAdmission(tx, x.runId)))?.id, [grant.id, legacy.id].sort().at(-1));
    await patchRecord(x, grant.id, { transition_seq: Number.MAX_SAFE_INTEGER });
    await assert.rejects(x.f.store.read(tx => nextPreflightTransition(tx, x.runId)), /exhausted/);
  } finally { await x.close(); }
});

for (const [label, owner, patch] of [
  ["foreign revision", "id", { issue_revision_id: "foreign" }],
  ["foreign run", "id", { dev_run_id: "foreign" }],
  ["changed base", "id", { base_commit: "other" }],
  ["changed target", "id", { target_commit: "other" }],
  ["missing assessment", "id", { assessment_id: newUUIDv7() }],
  ["inapplicable assessment", "assessmentId", { assessment: "unknown" }],
  ["foreign assessment binding", "assessmentId", { binds: { issue_revision_id: "foreign" } }],
  ["mismatched observation", "assessmentId", { observation_id: newUUIDv7() }],
  ["publish observation", "observationId", { phase: "publish" }],
  ["failed observation", "observationId", { observation: { refreshed: false } }],
  ["foreign observation binding", "observationId", { binds: { issue_revision_id: "foreign" } }],
] as const) {
  test(`admission rejects ${label}`, async () => {
    const x = await fixture();
    try {
      const grant = await admit(x);
      await patchRecord(x, grant[owner], patch);
      assert.equal(await x.f.store.read(tx => getCurrentAdmission(tx, x.runId)), undefined);
      await assert.rejects(x.f.store.read(tx => assertDevRunAdmitted(tx, x.runId)), /requires preflight admission/);
    } finally { await x.close(); }
  });
}

test("new preparation blocks dispatch of an already prepared environment; safe release remains available", async () => {
  const x=await fixture();
  try {
    await prepare(x,1);await assert.rejects(x.up(),/requires preflight admission/);
    await admit(x,2);const prepared=await x.up();await prepare(x,3);
    await assert.rejects(x.run(prepared.environment.id),/requires preflight admission/);
    assert.equal(existsSync(join(x.project,"command-ran")),false);
    x.scoped(()=>environmentDown(prepared.environment.id));
    await assert.rejects(x.up(),/requires preflight admission/);
  } finally {await x.close();}
});

test("target missing admission rejects environment preparation before side effects", async () => {
  const x = await fixture();
  try {
    const denied = (error: unknown) => error instanceof Error && /admi|preflight/i.test(error.message)
      && "code" in error && error.code === "STATE_CONFLICT" && error.message.includes(x.runId);
    await assert.rejects(x.up(), denied);
    assert.equal(x.scoped(()=>listEnvironments().length),0);
    assert.equal(existsSync(join(x.project,"command-ran")),false);
  } finally { await x.close(); }
});


test("public env up/run honors explicit --config and real DevRun admission before dispatch", async () => {
  const x = await fixture(true, true);
  try {
    const local = new DevWorktreeModule(x.project, loadConfig(x.config).database.expected_database_id, () => x.runId, x.f.store);
    const started = await x.scoped(() => local.start({ operation_id: newUUIDv7(), repository_id: x.f.repository.repository_id, issue_revision_id: x.revisionId, baseline_oid: x.base }, async id => ({ dev_run_id: id, value: id })));
    assert.equal(started.local_worktree.status, "available");
    if (started.local_worktree.status !== "available") throw new Error("fixture worktree unavailable");
    const workspace = started.local_worktree.path;
    const invoke = async (args: string[]) => {
      const lines: string[] = [];
      const code = await x.scoped(() => runCLI([...args, "--config", x.config, "--json"], { cwd: x.project, stdout: line => lines.push(line), stderr: () => {} }));
      return { code, envelope: JSON.parse(lines[0]) };
    };
    const up = () => invoke(["env", "up", "--workspace", workspace, "--dev-run", x.runId]);
    const refused = await up();
    assert.equal(refused.code, 4, JSON.stringify(refused.envelope));assert.equal(refused.envelope.error.code, "STATE_CONFLICT");
    assert.equal(x.scoped(() => listEnvironments().length), 0);
    await admit(x, 1);
    const prepared = await up();assert.equal(prepared.code, 0, JSON.stringify(prepared.envelope));
    const argv = join(x.root, "public-argv.json");writeFileSync(argv, JSON.stringify(["sh", "-c", "echo dispatched >> public-command-ran"]));
    const run = () => invoke(["env", "run", prepared.envelope.data.environment.id, "--dev-run", x.runId, "--argv-file", argv]);
    const completed = await run();assert.equal(completed.code, 0, JSON.stringify(completed.envelope));assert.equal(completed.envelope.data.run.state, "succeeded");
    assert.equal(readFileSync(join(workspace, "public-command-ran"), "utf8"), "dispatched\n");
    await prepare(x, 2);
    const revoked = await run();assert.equal(revoked.code, 4, JSON.stringify(revoked.envelope));assert.equal(revoked.envelope.error.code, "STATE_CONFLICT");
    assert.equal(readFileSync(join(workspace, "public-command-ran"), "utf8"), "dispatched\n", "revoked admission must not dispatch another command");
    assert.equal((await up()).code, 4);
    assert.equal((await invoke(["env", "down", prepared.envelope.data.environment.id])).code, 0);
  } finally { await x.close(); }
});
