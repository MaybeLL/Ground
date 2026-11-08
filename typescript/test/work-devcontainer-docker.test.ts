import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DevcontainerRuntime } from "../src/work/adapters/devcontainer/runtime.js";

test("three devcontainers isolate workspace writes and lifecycle operations by ledger and sandbox", { skip: !process.env.GROUNDS_TEST_DEVCONTAINER && "requires Docker and devcontainers CLI" }, async () => {
  const runtime = new DevcontainerRuntime(process.env.GROUNDS_TEST_DEVCONTAINER);
  const image = execFileSync("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", process.env.GROUNDS_TEST_CONTAINER_IMAGE ?? "alpine:latest"], { encoding: "utf8" }).trim();
  assert.match(image, /@sha256:[0-9a-f]{64}$/);
  const base = await mkdtemp(join(process.env.GROUNDS_TEST_CONTAINER_ROOT ?? tmpdir(), "grounds-triple-"));
  const ledgerId = randomUUID();
  const subjects = [0, 1, 2].map(i => ({
    owner: { ledgerId, sandboxId: randomUUID() }, workspace: { path: join(base, "work-" + i), configPath: join(base, "config-" + i, "devcontainer.json") },
  }));
  try {
    for (const [i, subject] of subjects.entries()) {
      await mkdir(subject.workspace.path); await mkdir(join(base, "config-" + i));
      await writeFile(subject.workspace.configPath, JSON.stringify({ image, workspaceFolder: "/work", workspaceMount: "source=${localWorkspaceFolder},target=/work,type=bind" }));
    }
    const results = await Promise.allSettled(subjects.map(async ({ owner, workspace }) => {
      const first = await runtime.up(owner, workspace);
      assert.equal(first.state, "running");
      assert.deepEqual(await runtime.up(owner, workspace), first);
      const executed = await runtime.execute(owner, first.id, workspace, ["sh", "-c", "printf %s \"$1\" > /work/result", "sh", owner.sandboxId]);
      assert.equal(executed.exitCode, 0, executed.stderr);
      assert.equal(await readFile(join(workspace.path, "result"), "utf8"), owner.sandboxId);
      return first;
    }));
    const containers = results.map(result => { if (result.status === "rejected") throw result.reason; return result.value; });
    assert.equal(new Set(containers.map(c => c.id)).size, 3);
    const first = subjects[0]!, second = subjects[1]!;
    await assert.rejects(runtime.pause(first.owner, containers[1]!.id), /identity/);
    await runtime.pause(first.owner, containers[0]!.id);
    assert.equal((await runtime.observe(second.owner))!.state, "running");
    await runtime.resume(first.owner, containers[0]!.id);
    assert.equal((await runtime.observe(first.owner))!.state, "running");
  } finally {
    await Promise.all(subjects.map(async ({owner}) => {
      const current = await runtime.observe(owner);
      if (current) await runtime.remove(owner, current.id);
    }));
    await rm(base, { recursive: true, force: true });
  }
});

test("evaluator runs frozen hidden tests against its own target checkout with a read-only material mount", {skip:!process.env.GROUNDS_TEST_EVALUATOR_DOCKER}, async () => {
  const {createHash} = await import("node:crypto");
  const {GitTagArchive} = await import("../src/work/adapters/git/tag-archive.js");
  const {ManagedWorkspaces} = await import("../src/work/adapters/devcontainer/workspace.js");
  const {EvaluatorWorkspaces} = await import("../src/work/adapters/devcontainer/evaluator-workspace.js");
  const shared = await mkdtemp(join(process.env.GROUNDS_TEST_CONTAINER_ROOT ?? tmpdir(),"grounds-evaluator-"));
  const checkout = join(shared,"source"), remote = join(shared,"target.git");
  const owner = {ledgerId:randomUUID(),sandboxId:randomUUID()};
  const runtime = new DevcontainerRuntime(), archive = new GitTagArchive();
  const git = (cwd:string,...args:string[]) => execFileSync("git",args,{cwd,encoding:"utf8"}).trim();
  const image = execFileSync("docker",["image","inspect","--format","{{index .RepoDigests 0}}","alpine:latest"],{encoding:"utf8"}).trim();
  const bytes = Buffer.from('test "$(cat result)" = original && test ! -e check.sh\n');
  try {
    git(shared,"init","-q",checkout); git(shared,"init","-q","--bare",remote);
    await writeFile(join(checkout,"result"),"original");
    git(checkout,"add","result"); git(checkout,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","target");
    const commit = git(checkout,"rev-parse","HEAD");
    const archived = await archive.archive({repositoryPath:checkout,commit,remote,deliveryId:"target"});
    assert.equal(archived.status,"confirmed");
    if (archived.status !== "confirmed") throw new Error("missing fixture receipt");
    await writeFile(join(checkout,"result"),"different");
    git(remote,"update-ref","-d","refs/tags/grounds/deliveries/target");
    assert.equal((await archive.inspect(checkout,{id:"target",receipt:archived.receipt})).status,"ref-changed");
    const adapter = new EvaluatorWorkspaces(new ManagedWorkspaces(shared),archive);
    const priorMask = process.umask(0o077);
    let workspace;
    try {
      workspace = await adapter.prepare(owner,{commit,archiveId:"target",receipt:archived.receipt,repository:checkout},{
      imageDigest:image.split("@")[1]!,config:JSON.stringify({image,workspaceFolder:"/work"}),lockfile:null,
    },[{path:"private/check.sh", executable:true, digest:"sha256:"+createHash("sha256").update(bytes).digest("hex"), base64:bytes.toString("base64")}]);
    } finally { process.umask(priorMask); }
    assert.equal((await stat(join(workspace.graderMaterials,"private"))).mode & 0o777,0o755);
    assert.equal((await stat(join(workspace.graderMaterials,"private","check.sh"))).mode & 0o777,0o555);
    const instance = await runtime.up(owner,workspace);
    const result = await runtime.execute(owner, instance.id, workspace, ["sh","-c",
      "cd /work && sh /grounds-grader/private/check.sh && ! (echo tamper >> /grounds-grader/private/check.sh)"]);
    assert.equal(result.exitCode,0);
    assert.equal(await readFile(join(checkout,"result"),"utf8"),"different");
  } finally {
    const observed = await runtime.observe(owner);
    if (observed) await runtime.remove(owner,observed.id);
    await rm(shared,{recursive:true,force:true});
  }
});

test("a delayed setup helper cannot recreate a released evaluator directory", async () => {
  const {ManagedWorkspaces} = await import("../src/work/adapters/devcontainer/workspace.js");
  const {runLaunchHelper} = await import("../src/work/adapters/devcontainer/launch.js");
  const {atomicPrivateWrite} = await import("../src/runtime-files.js");
  const {existsSync} = await import("node:fs");
  const files = new ManagedWorkspaces();
  const owner = {ledgerId:randomUUID(),sandboxId:randomUUID(),setupAttempt:randomUUID()};
  const path = join(files.setupRoot(owner),"launch.json");
  atomicPrivateWrite(path,JSON.stringify({owner,location:{hostId:"test",daemonId:"test"},workspace:{path:"unused",configPath:"unused"}}));
  let lost:Promise<void> | undefined;
  try {
    await files.withSetupLifetime(owner,async () => {
      lost = runLaunchHelper(path);
      await rm(files.root(owner),{force:true,recursive:true});
    });
    await assert.rejects(lost!);
    assert.equal(existsSync(files.root(owner)),false);
  } finally { await rm(files.root(owner),{force:true,recursive:true}); }
});
