import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {EngineProcess} from "../src/work/adapters/devcontainer/engine-process.js";
import {bridgeStarting,collectProvider,pendingBridge,spawnProviderBridge} from "../src/work/adapters/devcontainer/provider-runner.js";
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
