import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {execute} from "../src/cli.js";
import {hostProcessIdentity} from "../src/env-process.js";
import {newUUIDv7} from "../src/identity.js";
import {hostDirectory,queueRoot} from "../src/managed-host-client.js";
import {atomicPrivateWrite,withRuntimeLock} from "../src/runtime-files.js";
import {assertContract} from "./schema-fixture.js";

test("the scheduler shares configurable Agent slots and admits legacy and new command graders independently",async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"grounds-agent-capacity-")));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const previous=process.env.GROUNDS_DATA_HOME;
  process.env.GROUNDS_DATA_HOME=root;
  t.after(()=>{if (previous===undefined) delete process.env.GROUNDS_DATA_HOME;else process.env.GROUNDS_DATA_HOME=previous;});
  const configure=async(...args:string[])=>await execute(["work","host-capacity",...args]) as {agentSlots:number};
  const defaults=await configure();
  assertContract("work-results.schema.json",defaults);
  assert.equal(defaults.agentSlots,20);
  await assert.rejects(configure("--slots","0"));
  await assert.rejects(configure("--slot","1"));
  assert.equal((await configure("--slots","1")).agentSlots,1);
  const waiting=hostDirectory("waiting"),slots=hostDirectory("slots"),requests=hostDirectory("requests");
  const birth=hostProcessIdentity(process.pid);
  assert.ok(birth);
  const queue=(kind:"worker"|"test-grading"|"agent-grading",legacy=false,id=newUUIDv7())=>{
    const name=id+"."+newUUIDv7();
    atomicPrivateWrite(join(requests,name),JSON.stringify({executionId:id,...(kind==="worker"?{}:{kind})}));
    atomicPrivateWrite(join(waiting,id),JSON.stringify({name,pid:process.pid,birth,...(legacy?{}:{kind})}));
    return id;
  };
  const commands=Array.from({length:20},(_,i)=>queue("test-grading",i%2===0));
  const worker=queue("worker",true);
  const host=spawn(process.execPath,["--import","tsx","src/managed-host-main.ts"],{env:process.env,stdio:"ignore"});
  const stopped=once(host,"exit");
  try {
    const awaitSlot=async(id:string)=>{
      const deadline=Date.now()+15000;
      while (!existsSync(join(slots,id)) && Date.now()<deadline && host.exitCode===null) await delay(25);
      assert.ok(existsSync(join(slots,id)),"scheduler should admit "+id);
    };
    await Promise.all([...commands,worker].map(awaitSlot));
    const evaluator=queue("agent-grading");
    const extraCommand=queue("test-grading");
    await awaitSlot(extraCommand);
    assert.equal(existsSync(join(slots,evaluator)),false);
    assert.equal((await configure("--slots","2")).agentSlots,2);
    await awaitSlot(evaluator);
    await configure("--slots","1");
    const other=queue("worker");
    for (const path of [join(waiting,worker),join(slots,worker)]) rmSync(path,{force:true});
    await awaitSlot(queue("test-grading"));
    assert.equal(existsSync(join(slots,other)),false);
    for (const path of [join(waiting,evaluator),join(slots,evaluator)]) rmSync(path,{force:true});
    await awaitSlot(other);
    // Pause an agent admission at its ticket until a lower setting has committed.
    await configure("--slots","2");
    const paused=newUUIDv7();
    await withRuntimeLock(queueRoot(),"ticket-"+paused,async()=>{
      queue("worker",false,paused);
      await delay(350);
      await configure("--slots","1");
    });
    await awaitSlot(queue("test-grading"));
    assert.equal(existsSync(join(slots,paused)),false);
    const legacy=queue("worker",true);
    const legacyTicket=JSON.parse((await import("node:fs")).readFileSync(join(waiting,legacy),"utf8"));
    atomicPrivateWrite(join(requests,legacyTicket.name),"null");
    await awaitSlot(queue("test-grading"));
    assert.equal(existsSync(join(slots,legacy)),false);
  } finally {host.kill();await stopped;}
});
