import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeWork } from "../src/work/composition.js";
import type { WorkApplication } from "../src/work/application/index.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { createHash } from "node:crypto";
import { newUUIDv7 } from "../src/identity.js";
import type { SQLStore } from "../src/sql-store.js";
import { GitTagArchive, SqlWorkUnitOfWork } from "../src/work/adapters/index.js";
import { ArchiveRepairs } from "../src/work/application/archive-repairs.js";
import { backends, backendSkip, type Backend, openLedger } from "./backends.js";
import { refused, value } from "./work-application-harness.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

async function scenario(run: (t: { app: WorkApplication; store: SQLStore; repo: string; remote: string; baseline: string; root: string }) => Promise<void>, backend: Backend = "sqlite"): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-delivery-")));
  const fixture = await openLedger(backend);
  try {
    const repo = join(root, "repo"), remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "a.txt"), "a\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
    await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, () => run({ app: composeWork(fixture.store), store: fixture.store, repo, remote, baseline: git(repo, "rev-parse", "HEAD"), root }));
  } finally { await fixture.close(); rmSync(root, { recursive: true, force: true }); }
}

const task = async (app: WorkApplication, repository?: { remote: string; baseline: string }) =>
  value(await app.tasks.createTask({ requestId: `t-${Math.random()}`, summary: "Add export", criteria: [{ statement: "exports CSV" }], ...(repository ? { repository } : {}) }));

test("delivering is refused for what cannot be delivered, before anything is submitted", async () => {
  await scenario(async ({ app, repo, remote, baseline }) => {
    const withRepo = await task(app, { remote, baseline });
    const run = value(await app.exec.startWork({ requestId: "w-1", taskDefinitionId: withRepo.taskId, workerMode: "none" }));
    refused(await app.delivery.deliver({ requestId: "d-0", runId: "no-such-run", repositoryPath: repo, commit: "HEAD" }), "not-found");
    refused(await app.delivery.deliver({ requestId: "d-1", runId: run.runId, repositoryPath: repo, commit: "no-such-commit" }), "invalid", /not a commit/);
    refused(await app.delivery.deliver({ requestId: "d-2", runId: run.runId, repositoryPath: repo, commit: "HEAD", remote: join(repo, "..", "nowhere.git") }), "unavailable");
    assert.equal(value(await app.exec.getRun(run.runId)).run.status, "pending", "nothing was submitted, so the round never started");
    assert.equal(value(await app.exec.getRun(run.runId)).run.manifest, undefined);
    // A task that names no remote needs one from the caller.
    const bare = await task(app);
    const other = value(await app.exec.startWork({ requestId: "w-2", taskDefinitionId: bare.taskId, workerMode: "none" }));
    refused(await app.delivery.deliver({ requestId: "d-3", runId: other.runId, repositoryPath: repo, commit: "HEAD" }), "invalid", /no repository remote/);
    const given = value(await app.delivery.deliver({ requestId: "d-4", runId: other.runId, repositoryPath: repo, commit: "HEAD", remote }));
    assert.equal(given.submitted.status, "delivered");
  });
});

test("a tag already taken by another commit under the same delivery identity is a conflict", async () => {
  await scenario(async ({ app, repo, remote, baseline }) => {
    const created = await task(app, { remote, baseline });
    const run = value(await app.exec.startWork({ requestId: "w-1", taskDefinitionId: created.taskId, workerMode: "none" }));
    writeFileSync(join(repo, "a.txt"), "b\n"); git(repo, "commit", "-qam", "change");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "-q", remote, `${baseline}:refs/tags/grounds/deliveries/d-${run.runId}-${head.slice(0, 12)}`);
    refused(await app.delivery.deliver({ requestId: "d-1", runId: run.runId, repositoryPath: repo, commit: head }), "conflict", /already points at/);
    assert.equal(value(await app.exec.getRun(run.runId)).run.manifest, undefined);
  });
});

test("a workspace is prepared only for a run that can still do work, from what it starts from, and again as the same place", async () => {
  await scenario(async ({ app, repo, remote, baseline, root }) => {
    refused(await app.delivery.prepareWorkspace({ runId: "no-such-run", repositoryPath: repo }), "not-found");
    const noBaseline = await task(app);
    const bare = value(await app.exec.startWork({ requestId: "w-0", taskDefinitionId: noBaseline.taskId, workerMode: "none" }));
    refused(await app.delivery.prepareWorkspace({ runId: bare.runId, repositoryPath: repo }), "invalid", /baseline/);
    const created = await task(app, { remote, baseline: "main" });
    const run = value(await app.exec.startWork({ requestId: "w-1", taskDefinitionId: created.taskId, workerMode: "none" }));
    const first = value(await app.delivery.prepareWorkspace({ runId: run.runId, repositoryPath: repo }));
    assert.deepEqual([first.created, first.base.from, first.base.commit], [true, "baseline", baseline]);
    const again = value(await app.delivery.prepareWorkspace({ runId: run.runId, repositoryPath: repo }));
    assert.deepEqual([again.created, again.path], [false, first.path]);
    // Deliver, then a refinement of a run that delivered nothing, and of a delivery whose tag was removed.
    writeFileSync(join(first.path, "a.txt"), "b\n"); git(first.path, "commit", "-qam", "change");
    const delivered = value(await app.delivery.deliver({ requestId: "d-1", runId: run.runId, repositoryPath: first.path, commit: "HEAD" }));
    refused(await app.delivery.prepareWorkspace({ runId: run.runId, repositoryPath: repo }), "conflict", /already delivered/);
    const refinement = value(await app.exec.continueWork({ requestId: "c-1", workId: run.workId, expectedHead: run.runId, workerMode: "none" }));
    const branch = value(await app.exec.addBranch({ requestId: "b-1", workId: run.workId, refines: run.runId, workerMode: "none" }));
    value(await app.exec.cancel({ requestId: "x-1", runId: branch.runId }));
    const fromCancelled = value(await app.exec.addBranch({ requestId: "b-2", workId: run.workId, refines: branch.runId, workerMode: "none" }));
    refused(await app.delivery.prepareWorkspace({ runId: fromCancelled.runId, repositoryPath: repo }), "conflict", /delivered no code/);
    git(root, "--git-dir", remote, "tag", "-d", `grounds/deliveries/${delivered.delivery.id}`);
    refused(await app.delivery.prepareWorkspace({ runId: refinement.runId, repositoryPath: repo }), "conflict", /no longer shows/);
  });
});

for (const backend of backends) test(`${backend}: repair resumes after a lost push reply and retains both archive facts`, { skip: backendSkip(backend) }, async () => {
  await scenario(async ({ app, store, repo, remote, baseline }) => {
    const task = value(await app.tasks.createTask({ requestId: "task", summary: "repair fixture", criteria: [{ statement: "retain original" }], repository: { remote, baseline } }));
    const run = value(await app.exec.startWork({ requestId: "start", taskDefinitionId: task.taskId, workerMode: "none" }));
    const first = value(await app.delivery.deliver({ requestId: "deliver", runId: run.runId, repositoryPath: repo, commit: baseline }));
    const before = value(await app.exec.getRun(run.runId));
    const originalRef = `refs/tags/grounds/deliveries/${first.delivery.id}`;
    writeFileSync(join(repo, "unrelated.txt"), "unrelated\n");
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "other");
    const moved = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "--force", remote, `${moved}:${originalRef}`);
    const input = { requestId: "recover", runId: run.runId, deliveryId: first.delivery.id, repositoryPath: repo };
    class Interrupted extends GitTagArchive {
      override async repair(action: Parameters<GitTagArchive["repair"]>[0]): ReturnType<GitTagArchive["repair"]> {
        const result = await super.repair(action);
        assert.equal(result.status, "confirmed");
        throw new Error("injected interruption after remote confirmation");
      }
    }
    const units = new SqlWorkUnitOfWork(store);
    const interrupted = new ArchiveRepairs({ units, archive: new Interrupted(), ids: { next: newUUIDv7 }, clock: { now: () => new Date().toISOString() }, hash: text => createHash("sha256").update(text).digest("hex") });
    await assert.rejects(interrupted.repair(input), /injected interruption/);
    assert.equal((await units.run("read", r => r.intents.findByRequest("recover")))!.state, "registered");
    const tags = git(repo, "ls-remote", "--tags", remote);
    const recovered = value(await app.repairs.reconcile(run.runId));
    assert.equal(recovered.confirmed.length, 1);
    assert.deepEqual(recovered.outstanding, []);
    assert.deepEqual(value(await app.repairs.reconcile(run.runId)).confirmed, []);
    const [a, b] = await Promise.all([app.repairs.repair(input), app.repairs.repair(input)]);
    const repaired = value(a);
    assert.deepEqual(recovered.confirmed[0], repaired);
    assert.deepEqual(value(b), repaired);
    assert.deepEqual(value(await app.repairs.repair(input)), repaired);
    assert.equal(git(repo, "ls-remote", "--tags", remote), tags);
    assert.equal(git(remote, "rev-parse", originalRef), moved);
    assert.equal(git(remote, "rev-parse", `refs/tags/grounds/deliveries/${repaired.archiveId}`), baseline);
    assert.deepEqual(value(await app.exec.getRun(run.runId)), before);
    const [view] = await app.repairs.inspectRun(before.run, repo);
    assert.equal(view!.id, first.delivery.id);
    assert.equal(view!.status, "intact");
    assert.ok("repairs" in view!);
    assert.equal(view.repairs.length, 1); assert.equal(view.original.tag, "moved"); assert.equal(view.activeArchiveId, repaired.archiveId);
    const next = value(await app.exec.continueWork({ requestId: "continue", workId: run.workId, expectedHead: run.runId, workerMode: "none" }));
    const workspace = value(await app.delivery.prepareWorkspace({ runId: next.runId, repositoryPath: repo }));
    assert.equal(git(workspace.path, "rev-parse", "HEAD"), baseline);
  }, backend);
});

for (const backend of backends) test(`${backend}: evaluation snapshots recover by operation and refuse unavailable new sources`, { skip: backendSkip(backend) }, async () => {
  await scenario(async ({ app, repo, remote, baseline, root }) => {
    const created = await task(app, { remote, baseline });
    const run = value(await app.exec.startWork({ requestId: "start", taskDefinitionId: created.taskId, workerMode: "none" }));
    const { delivery } = value(await app.delivery.deliver({ requestId: "deliver", runId: run.runId, repositoryPath: repo, commit: baseline }));
    const entry = { key: "fixture", runId: run.runId, deliveryId: delivery.id, bindings: [{ key: "compare", referencePath: "a.txt", answerPath: "absent.txt" }] };
    const rule = value(await app.rules.publish({ requestId: "rule", name: "Required answer", operation: "file-exists", pass: "yes", fail: "no", expectedSeq: 0 }));
    const directInput = { requestId: "direct", runId: run.runId, deliveryId: delivery.id, answerPath: "absent.txt", grader: { definitionId: rule.graderId, revisionId: rule.revisionId } };
    const direct = value(await app.suites.measureDirect(directInput, repo));
    assert.equal(direct.result, "no");
    assert.deepEqual(value(await app.grading.listGates(run.runId)), []);
    const input = { requestId: "snapshot", name: "suite", expectedSeq: 0, cases: [entry] };
    const failed = await app.suites.publish({ ...input, cases: [entry, { ...entry, key: "bad", bindings: [{ key: "compare", answerPath: "a.txt", referencePath: "not-present.txt" }] }] }, repo);
    refused(failed, "not-found");
    assert.deepEqual(value(await app.suites.list()).suites, []);
    const snapshot = value(await app.suites.publish(input, repo));
    const measure = { requestId: "measure", suiteId: snapshot.suiteId, seq: 1, caseKey: entry.key, runId: run.runId, deliveryId: delivery.id };
    const measured = value(await app.suites.measure(measure, repo));
    assert.equal(measured.result, "mismatch");
    assert.equal(measured.actualDigest, null);
    const shown = value(await app.suites.show(snapshot.suiteId, 1));
    assert.equal(shown.cases[0]!.source.commit, baseline);
    assert.equal(shown.cases[0]!.bindings[0]!.graderRevision.kind, "grader");
    const grading = value(await app.grading.getGrading(measured.gradingId));
    assert.equal(grading.origin.type, "standalone");
    rmSync(remote, { recursive: true, force: true });
    assert.deepEqual(value(await app.suites.measureDirect(directInput, root)), direct);
    assert.deepEqual(value(await app.suites.publish(input, root)), snapshot);
    assert.deepEqual(value(await app.suites.measure(measure, root)), measured);
    refused(await app.suites.publish({ ...input, requestId: "repeat" }, root), "unavailable");
    refused(await app.suites.measure({ ...measure, requestId: "repeat-measure" }, root), "unavailable");
    assert.deepEqual(value(await app.suites.show(snapshot.suiteId, 1)), shown);
  }, backend);
});

for (const backend of backends) test(`${backend}: reconcile a sandbox launch without repeating its external action`, { skip: backendSkip(backend) }, async () => {
  await scenario(async ({ app, store, repo, remote, baseline, root }) => {
    const { SandboxProvisioning } = await import("../src/work/application/sandbox-provisioning.js");
    const { SandboxLifecycle } = await import("../src/work/application/sandbox-lifecycle.js");
    const { ManagedWorkspaces } = await import("../src/work/adapters/devcontainer/workspace.js");
    const { DevcontainerRuntime } = await import("../src/work/adapters/devcontainer/runtime.js");
    const imageDigest = "sha256:" + "f".repeat(64);
    const env = value(await app.environments.publish({ requestId:"env", name:"environment", config:JSON.stringify({image:"example@"+imageDigest}), imageDigest, expectedSeq:0 }));
    const task = value(await app.tasks.createTask({ requestId:"task", summary:"isolation", criteria:[{statement:"isolated"}], environmentDefinitionId:env.environmentId, repository:{ remote, baseline } }));
    const run = value(await app.exec.startWork({ requestId:"run", taskDefinitionId:task.taskId, workerMode:"external" }));
    const id = "a".repeat(64);
    let launches = 0, removals = 0, daemonId = "test";
    let current: { id: string; state: "running" } | null = null;
    class Runtime extends DevcontainerRuntime {
      override async location() { return {hostId:"test",daemonId}; }
      override async exclusive<T>(_owner: unknown, fn: () => Promise<T>) { return fn(); }
      override async up() { launches++; return current = { id, state:"running" as const }; }
      override async observe() { return current; }
      override async remove() { current = null; removals++; throw new Error("lost release reply"); }
    }
    const runtime = new Runtime();
    const ctx = { units:new SqlWorkUnitOfWork(store), hash:(s: string) => createHash("sha256").update(s).digest("hex"), newId:newUUIDv7, now:() => new Date().toISOString(), ledgerId:async () => (await store.inspect()).database_id, runtime };
    const workspaces = new ManagedWorkspaces(root);
    let status: "not-started" | "active" | "failed" | "completed" = "not-started";
    const launcher = { cancelPending:async () => false, status: async () => status, start: async (owner: Parameters<ManagedWorkspaces["record"]>[0]) => {
      status = "active"; await runtime.up();
      setComplete = async () => { await workspaces.record(owner,id); status = "completed"; };
    } };
    let setComplete: () => Promise<void>;
    const lifecycle = new SandboxLifecycle(ctx);
    const provisioner = new SandboxProvisioning({ ...ctx, lifecycle, delivery:app.delivery, workspaces, launcher });
    refused(await provisioner.prepare("prepare",run.runId,repo),"unavailable");
    await setComplete!();
    const recovered = value(await provisioner.reconcile(run.runId));
    assert.equal(recovered.instanceId,id);
    assert.equal(value(await provisioner.prepare("prepare",run.runId,repo)).sandboxId,recovered.sandboxId);
    assert.equal(launches,1);
    // End the owner before releasing its sandbox. Use the fixture's runtime.
    const { TaskExecution } = await import("../src/work/application/task-execution.js");
    const taskExec = new TaskExecution({units:ctx.units, hash:ctx.hash, clock:{now:ctx.now}, ids:{next:newUUIDv7}, receipts:new GitTagArchive()});
    value(await taskExec.cancel({requestId:"end",runId:run.runId}));
    daemonId = "other"; refused(await lifecycle.lifecycle("foreign",run.runId,"release"),"conflict");
    assert.equal(removals,0); daemonId = "test";
    refused(await lifecycle.lifecycle("release",run.runId,"release"),"unavailable");
    assert.equal(value(await lifecycle.lifecycle("release",run.runId,"release")).phase,"released");
    assert.equal(removals,1);
  },backend);
});

test("failed setup can close and cancellation racing setup pauses the actual owned instance", async () => {
  await scenario(async ({app,store,repo,remote,baseline,root}) => {
    const { SandboxProvisioning } = await import("../src/work/application/sandbox-provisioning.js");
    const { SandboxLifecycle } = await import("../src/work/application/sandbox-lifecycle.js");
    const { TaskExecution } = await import("../src/work/application/task-execution.js");
    const { DevcontainerRuntime } = await import("../src/work/adapters/devcontainer/runtime.js");
    const { ManagedWorkspaces } = await import("../src/work/adapters/devcontainer/workspace.js");
    const units = new SqlWorkUnitOfWork(store);
    const imageDigest = "sha256:"+"3".repeat(64);
    const env = value(await app.environments.publish({requestId:"e",name:"test",config:'{"image":"alpine"}',imageDigest,expectedSeq:0}));
    const task = value(await app.tasks.createTask({requestId:"t",summary:"fixture",criteria:[{statement:"works"}],repository:{remote,baseline},environmentDefinitionId:env.environmentId}));
    const id = "a".repeat(64), workspaces = new ManagedWorkspaces(root);
    let phase: "running" | "paused" | "stopped" | null = null;
    let daemonDown = true, failPause = true;
    class Runtime extends DevcontainerRuntime {
      override async location() { if (daemonDown) throw Error("offline"); return {hostId:"local",daemonId:"same"}; }
      override async exclusive<T>(_owner: unknown,fn: () => Promise<T>) { return fn(); }
      override async observe() { return phase ? {id,state:phase} : null; }
      override async pause() { if (failPause) { failPause = false; throw Error("before Docker command"); } phase = "paused"; }
      override async remove() { phase = null; }
    }
    const runtime = new Runtime();
    const ctx = { units, runtime, hash:(s:string)=>createHash("sha256").update(s).digest("hex"), newId:newUUIDv7, now:()=>new Date().toISOString(), ledgerId:async ()=>(await store.inspect()).database_id };
    const lifecycle = new SandboxLifecycle(ctx);
    const taskExec = new TaskExecution({units,hash:ctx.hash,clock:{now:ctx.now},ids:{next:newUUIDv7},receipts:new GitTagArchive(),lifecycle});
    let failed = true, stopOnFailure = false, vanishAfterReceipt = false;
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(r=>{entered=r;}), gate = new Promise<void>(r=>{finish=r;});
    const launcher = { cancelPending:async()=>false, status:async()=>failed ? "failed" as const : "completed" as const,
      start:async(owner: Parameters<ManagedWorkspaces["record"]>[0]) => {
        if (failed) { if (stopOnFailure) phase = "stopped"; throw Error("build failed"); }
        phase = "running"; entered(); await gate; await workspaces.record(owner,id); if (vanishAfterReceipt) phase = null;
      } };
    const provision = new SandboxProvisioning({...ctx,workspaces,launcher,lifecycle,delivery:app.delivery});
    const first = value(await taskExec.startWork({requestId:"one",workerMode:"external",taskDefinitionId:task.taskId}));
    refused(await provision.prepare("prepare-one",first.runId,repo),"unavailable");
    assert.equal(value(await taskExec.getRun(first.runId)).run.sandboxId,undefined);
    daemonDown = false;
    refused(await provision.prepare("prepare-one",first.runId,repo),"conflict");
    assert.equal(value(await taskExec.getRun(first.runId)).run.failure?.class,"infrastructure");
    assert.equal(value(await taskExec.closeWork({requestId:"close-one",workId:first.workId})).status,"closed");
    const second = value(await taskExec.startWork({requestId:"two",workerMode:"external",taskDefinitionId:task.taskId}));
    failed = false;
    const preparing = provision.prepare("prepare-two",second.runId,repo);
    await started;
    value(await taskExec.cancel({requestId:"cancel-two",runId:second.runId}));
    finish();
    refused(await preparing,"unavailable"); // first pause failed before Docker changed
    assert.equal(phase,"running");
    value(await taskExec.cancel({requestId:"cancel-two",runId:second.runId}));
    assert.equal(phase,"paused");
    assert.equal(value(await taskExec.closeWork({requestId:"close-two",workId:second.workId})).status,"closed");
    assert.equal(phase,null);
    failed = true; stopOnFailure = true;
    const third = value(await taskExec.startWork({requestId:"three",workerMode:"external",taskDefinitionId:task.taskId}));
    refused(await provision.prepare("prepare-three",third.runId,repo),"conflict");
    const blocked = await units.run("read",async r => r.sandboxes.get((await r.taskRuns.get(third.runId))!.sandboxId!));
    assert.equal(blocked!.phase,"blocked"); assert.equal(blocked!.blockedRuntimeQuiescent,true);
    assert.equal(value(await taskExec.closeWork({requestId:"close-three",workId:third.workId})).status,"closed");
    assert.equal(phase,null);
    failed = false; vanishAfterReceipt = true;
    const fourth = value(await taskExec.startWork({requestId:"four",workerMode:"external",taskDefinitionId:task.taskId}));
    refused(await provision.prepare("prepare-four",fourth.runId,repo),"conflict");
    assert.equal(value(await taskExec.getRun(fourth.runId)).run.failure?.class,"infrastructure");
    assert.equal(value(await taskExec.closeWork({requestId:"close-four",workId:fourth.workId})).status,"closed");
  });
});

for (const backend of backends) test(backend + ": managed admission, archive outage and evidence recovery", {skip: backendSkip(backend)}, async () => {
  await scenario(async ({ app, store, repo, remote, baseline, root }) => {
    const environment = value(await app.environments.publish({ requestId: "env", name: "fixture", expectedSeq: 0,
      config: '{"image":"fixture","workspaceFolder":"/work"}', imageDigest: "sha256:" + "1".repeat(64) }));
    const agent = value(await app.agents.publish({ requestId: "agent", name: "worker", provider: "codex", expectedSeq: 0 }));
    const task = value(await app.tasks.createTask({ requestId: "task", summary: "managed", criteria: [{statement: "committed"}],
      environmentDefinitionId: environment.environmentId, repository: {remote, baseline: "HEAD"} }));
    const selected = join(root, "selected");
    symlinkSync(repo, selected);
    const run = value(await app.exec.startWork({requestId: "start", taskDefinitionId: task.taskId, workerMode: "managed",
      agent: {definitionId: agent.agentId, repositoryPath: selected}}));
    rmSync(selected);
    symlinkSync(remote, selected);
    writeFileSync(join(repo, "a.txt"), "advanced after admission");
    git(repo, "commit", "-qam", "Move HEAD");
    const admitted = value(await app.workers.context(run.runId));
    assert.equal(admitted.job.repositoryPath, repo);
    assert.equal(admitted.job.baseline, baseline);
    refused(await app.sandboxes.prepare("retarget", run.runId, selected), "forbidden");
    refused(await app.sandboxes.prepare("override", run.runId, root), "forbidden");
    refused(await app.delivery.deliver({requestId: "publish", runId: run.runId, repositoryPath: repo, commit: baseline}), "unsupported");
    assert.equal(git(repo, "ls-remote", "--tags", remote), "");
    git(repo, "branch", "temporary-base", baseline);
    const earlier = value(await app.tasks.createTask({requestId: "parent-task", summary: "refine",
      criteria: [{statement: "committed"}], environmentDefinitionId: environment.environmentId, repository: {remote, baseline: "temporary-base"}}));
    const first = value(await app.exec.startWork({requestId: "parent-start", taskDefinitionId: earlier.taskId, workerMode: "none"}));
    const delivered = value(await app.delivery.deliver({requestId: "parent-deliver", runId: first.runId, repositoryPath: repo, commit: "HEAD"}));
    git(repo, "branch", "-d", "temporary-base");
    const child = value(await app.exec.continueWork({requestId: "refine", workId: first.workId, expectedHead: first.runId,
      workerMode: "managed", agent: {definitionId: agent.agentId, repositoryPath: repo}}));
    assert.equal(value(await app.workers.context(child.runId)).job.baseline, delivered.delivery.commit);
    const {requestSandbox, attachSandbox, markReady} = await import("../src/work/domain/index.js");
    const {ProviderTraceCapture} = await import("../src/work/adapters/providers/trace-capture.js");
    const startedAt = new Date().toISOString(), sandboxId = newUUIDv7();
    const ledger = (await store.inspect()).database_id;
    const units = new SqlWorkUnitOfWork(store);
    await units.run("write", async r => {
      const owner = await r.taskRuns.get(run.runId);
      assert.ok(owner?.environment);
      const allocated = requestSandbox({id: sandboxId, owner: {type: "task_run", id: owner.id}, retention: "keep",
        location: {hostId: "fixture", daemonId: "fixture"}, at: startedAt});
      assert.ok(allocated.ok);
      const ready = markReady(allocated.value.state, {workspace: {ref: "workspace", origin: "own"},
        runtime: {instanceId: "fixture", environmentRevisionId: owner.environment.revision.revisionId}, at: startedAt});
      const attached = attachSandbox(owner, {sandboxId});
      assert.ok(ready.ok && attached.ok);
      await r.sandboxes.create(allocated.value.state);
      await r.sandboxes.save(ready.value.state, allocated.value.state.version);
      await r.taskRuns.save(attached.value.state, owner.version);
    });
    const runner = "test-runner", handle = "1".repeat(64);
    value(await app.workers.reserve(run.runId, runner, ledger));
    value(await app.workers.begin(run.runId, runner, handle));
    const evidence = join(root, "output.jsonl");
    writeFileSync(evidence, '{"type":"turn.completed"}\n');
    const trace = await new ProviderTraceCapture().capture("codex", evidence);
    try {
      value(await app.workers.freezeOutput(run.runId, handle, trace, trace.raw, trace.events, "succeeded"));
      value(await app.workers.archiveUnavailable(run.runId, "remote unavailable"));
      const blocked = value(await app.workers.context(run.runId));
      assert.equal(blocked.exec.stage, "archive_blocked");
      assert.equal(blocked.exec.stop, "verified");
      assert.equal(blocked.job.trace?.raw.digest, trace.raw.digest);
      const checked = await store.inspectIntegrity();
      assert.equal(checked.report.valid, true);
    } finally { await trace.dispose(); }
  }, backend);
});

for (const backend of backends) test(backend + ": one refinement inherits the retained sandbox and conflicts roll back", {skip: backendSkip(backend)}, async () => {
  await scenario(async ({app, store, repo, remote, baseline, root}) => {
    const env = value(await app.environments.publish({requestId:"env", name:"inherited", expectedSeq:0,
      config:'{"image":"fixture","workspaceFolder":"/work"}', imageDigest:"sha256:" + "1".repeat(64)}));
    const task = value(await app.tasks.createTask({requestId:"task", summary:"handoff", criteria:[{statement:"isolated"}],
      environmentDefinitionId:env.environmentId, repository:{remote,baseline}}));
    const agent = value(await app.agents.publish({requestId:"agent", name:"fixture", provider:"codex", expectedSeq:0}));
    const selection = {workerMode:"managed" as const, agent:{definitionId:agent.agentId, repositoryPath:repo}};
    const parent = value(await app.exec.startWork({requestId:"start", taskDefinitionId:task.taskId, ...selection}));
    const {requestSandbox, attachSandbox, markBlocked, failInfrastructure} = await import("../src/work/domain/index.js");
    const at = new Date().toISOString(), sandboxId = newUUIDv7();
    const units = new SqlWorkUnitOfWork(store);
    await units.run("write", async r => {
      const run = await r.taskRuns.get(parent.runId);
      assert.ok(run);
      const allocated = requestSandbox({id:sandboxId,owner:{type:"task_run",id:run.id},location:{hostId:"test",daemonId:"test"},retention:"keep",at});
      assert.ok(allocated.ok);
      const blocked = markBlocked(allocated.value.state,{reason:"setup failed",at});
      const attached = attachSandbox(run,{sandboxId});
      assert.ok(blocked.ok && attached.ok);
      const failed = failInfrastructure(attached.value.state,{detail:"setup failed",at});
      assert.ok(failed.ok);
      await r.sandboxes.create(allocated.value.state);
      await r.sandboxes.save(blocked.value.state,allocated.value.state.version);
      await r.taskRuns.save(attached.value.state,run.version);
      await r.taskRuns.save(failed.value.state,attached.value.state.version);
    });
    const branch = {workId:parent.workId, refines:parent.runId, sandbox:"inherit" as const, ...selection};
    const competing = await Promise.all(["first","second"].map(requestId => app.exec.addBranch({...branch, requestId})));
    const winner = competing.find(result => result.ok);
    assert.ok(winner?.ok);
    assert.equal(competing.filter(result => !result.ok && result.error.code === "conflict").length, 1);
    const facts = await units.run("read", async r => ({
      runs:await r.taskRuns.listByWork(parent.workId), sandbox:await r.sandboxes.get(sandboxId), work:await r.works.get(parent.workId),
    }));
    assert.equal(facts.runs.length, 2);
    assert.equal(facts.work?.head, parent.runId);
    assert.equal(facts.sandbox?.owner.id, winner.value.runId);
    assert.equal(facts.sandbox?.reservation?.receiver, winner.value.runId);
    assert.equal(facts.runs.find(run => run.id === winner.value.runId)?.environment?.source, "inherited");
    const fresh = value(await app.exec.addBranch({...branch, requestId:"fresh", sandbox:"fresh"}));
    assert.equal(value(await app.exec.getRun(fresh.runId)).run.sandboxId, undefined);
    // The previous runner disappeared with a detached setup helper in
    // flight, before Docker returned an instance. A cancelling receiver
    // keeps the transfer reservation until that helper is stopped.
    const {requestCancel} = await import("../src/work/domain/index.js");
    await units.run("write", async r => {
      const run = await r.taskRuns.get(winner.value.runId);
      assert.ok(run);
      const cancelled = requestCancel(run, {at});
      assert.ok(cancelled.ok);
      await r.taskRuns.save(cancelled.value.state, run.version);
    });
    const {DevcontainerRuntime} = await import("../src/work/adapters/devcontainer/runtime.js");
    const {ManagedWorkspaces} = await import("../src/work/adapters/devcontainer/workspace.js");
    const {RetainedSetup} = await import("../src/work/application/retained-setup.js");
    const {SandboxLifecycle} = await import("../src/work/application/sandbox-lifecycle.js");
    const runtime = new class extends DevcontainerRuntime {
      override async location() {return {hostId:"test",daemonId:"test"};}
      override async observe() {return null;}
      override async exclusive<T>(_owner: unknown, fn: () => Promise<T>) {return fn();}
    }();
    let active = true;
    const launcher = {status:async () => active ? "active" as const : "failed" as const,
      start:async () => assert.fail("cancel must not dispatch"), cancelPending:async () => false};
    const setup = new RetainedSetup({units,runtime,launcher,workspaces:new ManagedWorkspaces(root)});
    const lifecycle = new SandboxLifecycle({units,runtime,setup,ledgerId:async () => "test", now:() => at,newId:newUUIDv7,
      hash:(s:string) => createHash("sha256").update(s).digest("hex")});
    assert.equal(value(await lifecycle.completeTransfer(winner.value.runId,false)), "preparing");
    assert.equal((await units.run("read", r => r.sandboxes.get(sandboxId)))?.reservation?.kind, "transfer");
    active = false;
    value(await lifecycle.settleRun(winner.value.runId));
    assert.equal((await units.run("read", r => r.sandboxes.get(sandboxId)))?.reservation, undefined);
  }, backend);
});

test("a missing retained checkout cannot be initialized from the original allocation", async () => {
  await scenario(async ({repo, baseline, root}) => {
    const {ManagedWorkspaces} = await import("../src/work/adapters/devcontainer/workspace.js");
    const workspaces = new ManagedWorkspaces(root);
    const owner = {ledgerId:newUUIDv7(), sandboxId:newUUIDv7()};
    const config = {config:'{"image":"fixture"}',lockfile:null,imageDigest:"sha256:"+"1".repeat(64)};
    const prepared = await workspaces.prepare(owner,repo,baseline,config);
    rmSync(prepared.path,{recursive:true,force:true});
    await assert.rejects(workspaces.prepare(owner,repo,baseline,config,true));
  });
});

for (const backend of backends) test(backend + ": test grader admission freezes a separate evaluation plan and hidden files", {skip:backendSkip(backend)}, async () => {
  await scenario(async ({app,store,repo,remote,baseline}) => {
    const env = value(await app.environments.publish({requestId:"env", name:"evaluator", expectedSeq:0,
      config:'{"image":"fixture"}', imageDigest:"sha256:" + "1".repeat(64)}));
    const grader = value(await app.rules.publishTest({requestId:"test-grader", name:"check result", expectedSeq:0,
      environmentId:env.environmentId, environmentRevisionId:env.revisionId, pass:"pass", fail:"fail", commands:[["sh", "/grounds-grader/check.sh"], ["sh","-c","exit 3"]]}));
    const task = value(await app.tasks.createTask({requestId:"task",summary:"produce a result",criteria:[{statement:"correct result"}],repository:{remote,baseline}}));
    const worker = value(await app.exec.startWork({requestId:"work",taskDefinitionId:task.taskId,workerMode:"none"}));
    const hiddenPath = "a".repeat(129) + ".sh";
    writeFileSync(join(repo,hiddenPath), "test -e result.txt\n");
    git(repo,"add",hiddenPath); git(repo,"commit","-qm","private check");
    const delivered = value(await app.delivery.deliver({requestId:"deliver",runId:worker.runId,repositoryPath:repo,commit:"HEAD"}));
    const source = {runId:worker.runId,deliveryId:delivered.delivery.id};
    const suite = value(await app.suites.publish({requestId:"suite",name:"cases",expectedSeq:0,cases:[{...source,key:"case",bindings:[{
      key:"private",grader:{definitionId:grader.graderId,revisionId:grader.revisionId},hiddenTestPaths:[hiddenPath],
    }]}]},repo));
    const input = {requestId:"measure",suiteId:suite.suiteId,seq:1,caseKey:"case",...source};
    const accepted = value(await app.suites.measure(input,repo));
    assert.ok("status" in accepted && accepted.status === "accepted");
    assert.deepEqual(value(await app.suites.measure(input,repo)), accepted);
    const units = new SqlWorkUnitOfWork(store);
    const record = await units.run("read",r => r.gradings.get(accepted.gradingId));
    assert.equal(record?.strategy,"test");
    assert.equal(record?.graderRevision.revisionId,grader.revisionId);
    assert.equal(record?.materials.length,1);
    const snapshot = value(await app.suites.show(suite.suiteId,1));
    assert.equal(JSON.stringify(snapshot).includes("base64"),false);
    const {TestExecution} = await import("../src/work/application/test-execution.js");
    const execution = new TestExecution({units,newId:newUUIDv7,now:()=>new Date().toISOString(),hash:s=>createHash("sha256").update(s).digest("hex")});
    const id = accepted.gradingId;
    const allocated = value(await execution.allocate(id,{hostId:"host",daemonId:"daemon"}));
    assert.equal(value(await execution.allocate(id,{hostId:"host",daemonId:"daemon"})).sandboxId, allocated.sandboxId);
    value(await execution.ready(id, "container"));
    const first = value(await execution.beginStep(id,0));
    assert.deepEqual(value(await execution.beginStep(id,0)),first);
    assert.equal((await execution.beginStep(id,1)).ok,false);
    assert.equal((await execution.stopped(id,0,first.token + 1,0)).ok,false);
    assert.equal(value(await execution.stopped(id,0,first.token,0)).status,"running");
    assert.equal((await app.grading.submitGrade({requestId:"fabricate",gradingId:id,sessionId:"foreign",grade:{form:"category",category:"pass"}})).ok,false);
    const second = value(await execution.beginStep(id,1));
    assert.ok(second.token > first.token);
    assert.equal(value(await execution.stopped(id,1,second.token,3)).status,"completed");
    assert.deepEqual(value(await execution.context(id)).grading.grade,{form:"category",category:"fail"});
    assert.equal(value(await app.exec.getRun(worker.runId)).run.status,"delivered");
  },backend);
});

for (const backend of backends) test(backend + ": immutable experiment plans bind starts, repetitions and concurrent admissions", {skip:backendSkip(backend)}, async () => {
  await scenario(async ({app,store,repo,remote,baseline}) => {
    const environment = value(await app.environments.publish({requestId:"env",name:"worker",expectedSeq:0,
      config:'{"image":"fixture"}',imageDigest:"sha256:" + "1".repeat(64)}));
    const agent = value(await app.agents.publish({requestId:"agent",name:"candidate",expectedSeq:0,provider:"codex"}));
    const rule = value(await app.rules.publish({requestId:"rule",name:"presence",operation:"file-exists",pass:"present",fail:"missing",expectedSeq:0}));
    const task = value(await app.tasks.createTask({requestId:"task",summary:"edit a file",criteria:[{statement:"file is present"}],
      environmentDefinitionId:environment.environmentId,repository:{remote,baseline:"HEAD"}}));
    const historical = value(await app.exec.startWork({requestId:"work",taskDefinitionId:task.taskId,workerMode:"none"}));
    const delivery = value(await app.delivery.deliver({requestId:"deliver",runId:historical.runId,commit:baseline,repositoryPath:repo}));
    const suite = value(await app.suites.publish({requestId:"suite",name:"cases",expectedSeq:0,cases:[{
      key:"case-a",runId:historical.runId,deliveryId:delivery.delivery.id,bindings:[{key:"presence",answerPath:"a.txt",grader:{definitionId:rule.graderId,revisionId:rule.revisionId}}],
    }]},repo));
    const experiment = value(await app.experiments.define({requestId:"define",name:"trial",suiteId:suite.suiteId,seq:1,agentId:agent.agentId,
      agentRevisionId:agent.revisionId,repositoryPath:repo}));
    value(await app.environments.publish({requestId:"change-env",name:"worker",definitionId:environment.environmentId,expectedSeq:1,
      config:'{"image":"updated"}',imageDigest:"sha256:" + "2".repeat(64)}));
    writeFileSync(join(repo,"a.txt"),"after definition");git(repo,"commit","-qam","advance baseline");
    const launch = {requestId:"launch",experimentId:experiment.experimentId,repeatCount:3,taskConcurrency:1};
    const batch = value(await app.experiments.launch(launch));
    assert.equal(batch.memberCount,3);
    const contenders = await Promise.all([app.members.next(batch.batchId),app.members.next(batch.batchId)]);
    const admitted = contenders.map(value).find(result=>result.state === "started");
    assert.ok(admitted?.state === "started");
    assert.ok(contenders.some(result=>result.ok && result.value.state === "at-capacity"));
    const facts = value(await app.workers.context(admitted.runId));
    assert.equal(facts.job.baseline,baseline);
    assert.equal(facts.run.environment?.source,"specified");
    assert.equal(facts.run.environment?.revision.revisionId,environment.revisionId);
    assert.equal(facts.run.workId,undefined);
    assert.equal(facts.run.retention,"release");
    value(await app.exec.cancel({requestId:"cancel-member",runId:admitted.runId}));
    const next = value(await app.members.next(batch.batchId));
    assert.ok(next.state === "started" && next.key !== admitted.key);
    value(await app.members.cancel(batch.batchId,"cancel-batch"));
    assert.equal(value(await app.members.next(batch.batchId)).state,"cancelled");
    const records = await new SqlWorkUnitOfWork(store).run("read",r=>r.experiments.memberProgress(batch.batchId));
    assert.equal(records.filter(member=>member.runId).length,2);
    const {renameSync} = await import("node:fs");
    renameSync(remote,remote+"-offline");
    assert.deepEqual(value(await app.experiments.launch(launch)),batch);
    refused(await app.experiments.launch({...launch,requestId:"new-batch"}),"unavailable");
    assert.equal(value(await app.experiments.show(experiment.experimentId)).batches.length,1);
    const view = value(await app.experimentResults.inspect(batch.batchId));
    assert.ok("dimensions" in view && view.dimensions);
    assert.equal(view.counts!.planned,3);
    assert.equal(view.counts!.cancelled,1);
    assert.equal(view.counts!.active,1);
    assert.equal(view.counts!.pending,1);
    assert.deepEqual(view.dimensions.map(d=>[d.planned,d.missing,d.valid]),[[3,3,0]]);
  },backend);
});

for (const backend of backends) test(backend + ": working runs freeze selected artifact files and enforce required output ownership", {skip:backendSkip(backend)}, async () => {
  await scenario(async ({app}) => {
    const task = value(await app.tasks.createTask({requestId:"working",kind:"working",summary:"Submit a report",criteria:[{statement:"cite evidence"}],
      outputs:[{key:"report",required:true},{key:"data",required:true},{key:"chart",required:false}]}));
    const start = async (requestId:string) => value(await app.exec.startWork({requestId,taskDefinitionId:task.taskId,workerMode:"none"})).runId;
    const runId = await start("first"), other = await start("second");
    const file = (path:string, data:string) => {
      const bytes = Buffer.from(data);
      return {path,source:{digest:"sha256:"+createHash("sha256").update(bytes).digest("hex"),byteLength:bytes.length,async *open(){yield bytes;}}};
    };
    const inputs = [file("report.txt","answer"),file("assets/plot.bin","bytes")];
    const args = {runId,requestId:"save-report",slot:"report"};
    const saved = value(await app.artifacts.save(args,inputs));
    assert.deepEqual(value(await app.artifacts.save(args,[...inputs].reverse())),saved);
    refused(await app.artifacts.save(args,[file("report.txt","modified")]),"request-conflict");
    const selected = {id:saved.id,type:"artifact" as const,receipt:saved.receipt};
    refused(await app.exec.submit({requestId:"incomplete",runId,items:[selected]}),"invalid");
    refused(await app.exec.submit({requestId:"foreign",runId:other,items:[selected]}),"invalid");
    const data = value(await app.artifacts.save({runId,requestId:"save-table",slot:"data"},[file("data.csv","a,b")]));
    const result = value(await app.exec.submit({requestId:"submit",runId,items:[selected,{id:data.id,type:"artifact",receipt:data.receipt}]}));
    assert.equal(result.status,"delivered");
    assert.equal(value(await app.exec.getRun(runId)).run.manifest?.items.length,2);
  },backend);
});
