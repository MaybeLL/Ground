import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {existsSync,lstatSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {EngineProcess} from "../src/work/adapters/devcontainer/engine-process.js";
import {bridgeStarting,collectProvider,pendingBridge,spawnProviderBridge} from "../src/work/adapters/devcontainer/provider-runner.js";
import {ContainerAgentProcess} from "../src/work/adapters/devcontainer/managed-process.js";
import {DurableSandboxLauncher} from "../src/work/adapters/devcontainer/launch.js";
import {TestGradingDriver} from "../src/work/driver/test-grading.js";
import {ContainerTestProcess} from "../src/work/adapters/devcontainer/test-process.js";
import {DevcontainerRuntime} from "../src/work/adapters/devcontainer/runtime.js";
import {GitTagArchive} from "../src/work/adapters/git/tag-archive.js";
import {withRuntimeLock} from "../src/runtime-files.js";
import {ManagedWorkspaces} from "../src/work/adapters/devcontainer/workspace.js";

test("a dispatched collector remains observable without its PID receipt and cannot resurrect a disposed sandbox",async()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),"grounds-delayed-collector-")));
  const previous=process.env.GROUNDS_DATA_HOME;
  process.env.GROUNDS_DATA_HOME=directory;
  try {
    const owner={ledgerId:randomUUID(),sandboxId:randomUUID()},workspaces=new ManagedWorkspaces();
    const sandbox=workspaces.root(owner),root=join(sandbox,"test-commands","0-1");
    mkdirSync(root,{recursive:true});
    await workspaces.withSetupLifetime(owner,async()=>{
      await spawnProviderBridge(root,{target:{owner,location:{hostId:"fixture",daemonId:"fixture"},containerId:"fixture"},handle:"fixture",prompt:""});
      rmSync(join(root,"bridge-owner"),{force:true});
      assert.equal(await pendingBridge(root,"fixture"),"running");
      assert.equal(existsSync(join(root,"start-attempt")),false);
      rmSync(sandbox,{recursive:true});
    });
    const deadline=Date.now()+15000;
    while (bridgeStarting(root) && Date.now()<deadline) await delay(25);
    assert.equal(bridgeStarting(root),false);
    assert.equal(existsSync(sandbox),false);
    await collectProvider(root);
    assert.equal(existsSync(sandbox),false);
  } finally {
    if (previous===undefined) delete process.env.GROUNDS_DATA_HOME;else process.env.GROUNDS_DATA_HOME=previous;
    rmSync(directory,{recursive:true,force:true});
  }
});

test("an interrupted legacy dispatch cannot start after observation fences its missing owner",async t=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),"grounds-legacy-collector-")));
  const previous=process.env.GROUNDS_DATA_HOME;
  process.env.GROUNDS_DATA_HOME=directory;
  try {
    const owner={ledgerId:randomUUID(),sandboxId:randomUUID()},root=join(directory,"old-spool");
    mkdirSync(root);
    writeFileSync(join(root,"bridge.json"),JSON.stringify({target:{owner},handle:"old-handle",prompt:"fixture"}),{mode:0o600});
    const start=t.mock.method(EngineProcess.prototype,"start",async()=>{throw Error("unexpected model launch");});
    assert.equal(await pendingBridge(root,"old-handle"),"interrupted");
    await collectProvider(root);
    assert.equal(start.mock.callCount(),0);
  } finally {
    if (previous===undefined) delete process.env.GROUNDS_DATA_HOME;else process.env.GROUNDS_DATA_HOME=previous;
    rmSync(directory,{recursive:true,force:true});
  }
});

test("forced stop fences delayed worker and export collectors before returning",async()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),"grounds-cancel-bridge-")));
  const previous=process.env.GROUNDS_DATA_HOME;
  process.env.GROUNDS_DATA_HOME=directory;
  try {
    const workspaces=new ManagedWorkspaces(),owner={ledgerId:randomUUID(),sandboxId:randomUUID()},executionId=randomUUID();
    const location={hostId:"host",daemonId:"daemon"},target={owner,location,containerId:"owned"};
    class Runtime extends DevcontainerRuntime {
      override async location(){return location;}
      override async observe(){return {id:"owned",state:"running" as const};}
      override async stop(){}
    }
    const port=new ContainerAgentProcess(new Runtime(),workspaces,new GitTagArchive());
    const root=join(directory,"runtime","executions",owner.ledgerId,executionId),roots=[root,join(root,"export")];
    await workspaces.withSetupLifetime(owner,async()=>{
      for (const spool of roots) await spawnProviderBridge(spool,{target,handle:"handle",prompt:"fixture"});
      await port.stop({target,job:{executionId},role:"evaluator",agent:{provider:"codex"},prompt:"fixture"},true);
      for (const spool of roots) assert.equal(existsSync(join(spool,"dispatch-revoked")),true);
    });
    const deadline=Date.now()+15000;
    while (roots.some(bridgeStarting) && Date.now()<deadline) await delay(25);
    for (const spool of roots) {
      assert.equal(bridgeStarting(spool),false);
      assert.equal(existsSync(join(spool,"start-attempt")),false);
      assert.equal(existsSync(join(spool,"bridge-failed")),false);
    }
  } finally {
    if (previous===undefined) delete process.env.GROUNDS_DATA_HOME;else process.env.GROUNDS_DATA_HOME=previous;
    rmSync(directory,{recursive:true,force:true});
  }
});

test("a released legacy command sandbox blocks the pre-upgrade collector's directory creation",async()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),"grounds-old-command-")));
  const previous=process.env.GROUNDS_DATA_HOME;
  process.env.GROUNDS_DATA_HOME=directory;
  try {
    const owner={ledgerId:randomUUID(),sandboxId:randomUUID()},ws=new ManagedWorkspaces();
    const sandbox=ws.root(owner),spool=join(sandbox,"test-commands","0-1");
    mkdirSync(spool,{recursive:true});
    writeFileSync(join(spool,"bridge.json"),"{}",{mode:0o600});
    const commands=new ContainerTestProcess(new DevcontainerRuntime(),ws,{prepare:async()=>{throw Error("not used");}} as never);
    await commands.dispose(owner);
    assert.ok(lstatSync(sandbox).isFile());
    // The old binary acquires this lock before its first read of bridge.json.
    await assert.rejects(withRuntimeLock(spool,"bridge",async()=>{}));
    const location={hostId:"host",daemonId:"daemon"},id=randomUUID();
    let observed=0,released=0;
    const driver=new TestGradingDriver({
      tests:{
        context:async()=>({ok:true,value:{grading:{status:"failed"},sandbox:{id:owner.sandboxId,phase:"releasing",location}}}),
        reserveRelease:async()=>({ok:true,value:{operationId:"release-"+id}}),
        released:async(record:string,operation:string)=>{
          assert.equal(record,id);assert.equal(operation,"release-"+id);released++;return {ok:true};
        },
      },
      runtime:{location:async()=>location,exclusive:async(_:unknown,action:()=>Promise<unknown>)=>action(),observe:async()=>{observed++;return undefined;}},
      ledgerId:async()=>owner.ledgerId,launcher:new DurableSandboxLauncher(ws),process:commands,
    } as unknown as ConstructorParameters<typeof TestGradingDriver>[0]);
    assert.deepEqual(await driver.drive(id,false),{ok:true,value:{state:"terminal",providerStopped:true}});
    assert.equal(observed,1);assert.equal(released,1);
    assert.ok(lstatSync(sandbox).isFile());
    assert.equal(existsSync(spool),false);
  } finally {
    if (previous===undefined) delete process.env.GROUNDS_DATA_HOME;else process.env.GROUNDS_DATA_HOME=previous;
    rmSync(directory,{recursive:true,force:true});
  }
});

test("provider recovery never creates a second exec or replays a confirmed exit",async t=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),"grounds-exec-replay-")));
  const previous=process.env.GROUNDS_DATA_HOME;
  process.env.GROUNDS_DATA_HOME=directory;
  try {
    const owner={ledgerId:randomUUID(),sandboxId:randomUUID()},workspaces=new ManagedWorkspaces();
    const configDir=join(workspaces.root(owner),"prepared",".devcontainer","effective");
    mkdirSync(configDir,{recursive:true});
    writeFileSync(join(configDir,"devcontainer.json"),JSON.stringify({workspaceFolder:"/workspace"}),{mode:0o600});
    const runtime=new DevcontainerRuntime();
    t.mock.method(runtime,"processes",async()=>[]);
    const target={owner,location:{hostId:"host",daemonId:"daemon"},containerId:"owned"};
    const adapter=()=>new ContainerAgentProcess(runtime,workspaces,new GitTagArchive());
    const create=t.mock.method(EngineProcess.prototype,"create",async()=>{throw Error("lost create reply");});
    const inspect=t.mock.method(EngineProcess.prototype,"observe",async()=>({running:false,exitCode:17}));
    const plan={target,role:"evaluator" as const,agent:{provider:"codex" as const},prompt:"fixture",job:{executionId:randomUUID()}};
    assert.equal(await adapter().handle(plan,false),undefined);
    assert.equal(create.mock.callCount(),0);
    await assert.rejects(adapter().handle(plan,true),/lost create reply/);
    assert.equal(await adapter().handle(plan,false),undefined);
    await assert.rejects(adapter().handle(plan,true),/creation was interrupted/);
    assert.equal(create.mock.callCount(),1);

    const next={...plan,job:{executionId:randomUUID()}};
    create.mock.mockImplementation(async()=>"handle");
    assert.equal(await adapter().handle(next,true),"handle");
    assert.equal(await adapter().handle(next,false),"handle");
    assert.equal(await adapter().handle(next,true),"handle");
    assert.equal(create.mock.callCount(),2);
    assert.equal((await adapter().drive(next,"handle",false)).state,"awaiting-resume");
    const root=join(directory,"runtime","executions",owner.ledgerId,next.job.executionId);
    const assertUndispatched=()=>{
      for (const receipt of ["dispatch-protocol","bridge.json"]) assert.equal(existsSync(join(root,receipt)),false);
    };
    assertUndispatched();
    writeFileSync(join(root,"result.json"),JSON.stringify({handle:"handle",exitCode:17}),{mode:0o600});
    const ended={state:"complete",exitCode:17};
    assert.deepEqual(await adapter().drive(next,"handle",false),ended);
    assert.deepEqual(await adapter().drive(next,"handle",true),ended);
    assert.equal(inspect.mock.callCount(),1);
    assertUndispatched();
  } finally {
    if (previous===undefined) delete process.env.GROUNDS_DATA_HOME;else process.env.GROUNDS_DATA_HOME=previous;
    rmSync(directory,{recursive:true,force:true});
  }
});

test("managed worker reconciles a real Docker exit after its collector dies before the result receipt",{skip:!process.env.GROUNDS_TEST_MANAGED_AGENT},async()=>{
  const {execFileSync,spawnSync}=await import("node:child_process");
  const {readFileSync}=await import("node:fs");
  const {dataLayout}=await import("../src/data-layout.js");
  const runtime=new DevcontainerRuntime(),engine=new EngineProcess(runtime);
  const owner={ledgerId:randomUUID(),sandboxId:randomUUID()},executionId=randomUUID();
  const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8",timeout:60_000}).trim();
  const id=docker("run","--detach","--network","none","--label","dev.grounds.ledger="+owner.ledgerId,
    "--label","dev.grounds.sandbox="+owner.sandboxId,process.env.GROUNDS_TEST_MANAGED_AGENT!);
  const root=join(dataLayout().runtime,"executions",owner.ledgerId,executionId);
  try {
    const target={owner,location:await runtime.location(),containerId:id};
    const handle=await engine.create(target,{cwd:"/tmp",argv:["sh","-c","echo started >> /tmp/calls; echo evidence; exit 17"]});
    mkdirSync(root,{recursive:true,mode:0o700});
    writeFileSync(join(root,"bridge.json"),JSON.stringify({target,handle,prompt:""}),{mode:0o600});
    const interrupted=spawnSync(process.execPath,["--import","tsx","test/fixtures/interrupt-after-engine-exit.ts",root],{encoding:"utf8",timeout:60_000});
    assert.ifError(interrupted.error);
    assert.equal(interrupted.signal,"SIGKILL",interrupted.stderr);
    assert.deepEqual(await engine.observe(target,handle),{running:false,exitCode:17});
    assert.equal(existsSync(join(root,"result.json")),false);
    assert.equal(readFileSync(join(root,"stdout.jsonl"),"utf8"),"evidence\n");
    const plan={target,role:"evaluator" as const,agent:{provider:"codex" as const},prompt:"",job:{executionId}};
    for(const live of [false,true]) {
      const port=new ContainerAgentProcess(runtime,new ManagedWorkspaces(),new GitTagArchive());
      assert.equal((await port.drive(plan,handle,live)).state,"interrupted");
    }
    await collectProvider(root);
    assert.equal(existsSync(join(root,"bridge-failed")),false);
    assert.equal(existsSync(join(root,"result.json")),false);
    assert.equal(docker("exec",id,"cat","/tmp/calls"),"started");
  } finally {
    docker("rm","--force",id);
    rmSync(root,{recursive:true,force:true});
  }
});
