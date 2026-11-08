import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DevcontainerRuntime } from "../src/work/adapters/devcontainer/runtime.js";
import { demultiplex, EngineProcess } from "../src/work/adapters/devcontainer/engine-process.js";

test("Docker frame boundaries preserve arbitrary binary output and reject truncation",async()=>{
  const frame=Buffer.concat([Buffer.from([1,0,0,0,0,0,0,3,255,0,42]),Buffer.from([2,0,0,0,0,0,0,1,65])]);
  async function* split(bytes:Buffer) { for (const byte of bytes) yield Buffer.from([byte]); }
  const out:number[]=[],err:number[]=[];
  await demultiplex(split(frame),async(s,b)=>{(s===1?out:err).push(...b);});
  assert.deepEqual(out,[255,0,42]); assert.deepEqual(err,[65]);
  await assert.rejects(demultiplex(split(frame.subarray(0,-1)),async()=>{}),/incomplete/);
});

test("Engine exec records its identity before starting and captures private stdout and stderr exactly",{skip:!process.env.GROUNDS_TEST_DEVCONTAINER && "requires a local Docker daemon"},async()=>{
  const runtime=new DevcontainerRuntime(),processes=new EngineProcess(runtime),dir=await mkdtemp(join(tmpdir(),"grounds-engine-exec-"));
  const owner={ledgerId:randomUUID(),sandboxId:randomUUID()};
  const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8"}).trim();
  let id:string|undefined;
  try {
    id=docker("run","--detach","--label","dev.grounds.ledger="+owner.ledgerId,"--label","dev.grounds.sandbox="+owner.sandboxId,process.env.GROUNDS_TEST_CONTAINER_IMAGE??"alpine:latest","sleep","120");
    const target={owner,containerId:id,location:await runtime.location()};
    const execution=await processes.create(target,{argv:["sh","-c","cat; printf err >&2; exit 7"],cwd:"/tmp"});
    assert.equal((await processes.observe(target,execution)).running,false);
    const out=join(dir,"out"),err=join(dir,"err");
    assert.deepEqual(await processes.start(target,execution,"message\n",out,err),{running:false,exitCode:7});
    assert.equal(await readFile(out,"utf8"),"message\n");assert.equal(await readFile(err,"utf8"),"err");
    assert.equal((await processes.observe(target,execution)).exitCode,7);
  } finally {if(id) docker("rm","-f",id);await rm(dir,{recursive:true,force:true});}
});
