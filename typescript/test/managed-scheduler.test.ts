import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {publishedHostEntries} from "../src/managed-host-client.js";
import { dataLayout } from "../src/data-layout.js";
import { hostProcessIdentity } from "../src/env-process.js";
import { atomicPrivateWrite, privateDirectory } from "../src/runtime-files.js";

test("the scheduler counts unfinished allocations even when no controller is polling them", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "grounds-host-slots-")));
  const root = join(dataLayout(home).runtime, "managed-host");
  const waiting = privateDirectory(join(root, "waiting")), slots = privateDirectory(join(root, "slots"));
  for (const directory of [slots,waiting,privateDirectory(join(root,"batches"))]) writeFileSync(join(directory,"."+randomUUID()),"{");
  const entries = Array.from({length: 21}, () => randomUUID()).sort();
  const ticket = JSON.stringify({pid: process.pid, birth: hostProcessIdentity(process.pid)});
  for (const id of entries) atomicPrivateWrite(join(waiting, id), ticket);
  const child = spawn(process.execPath, ["--import", "tsx", "src/managed-host-main.ts"], {
    env: {...process.env, GROUNDS_DATA_HOME: home}, stdio: "ignore",
  });
  const done = new Promise<void>((ok, fail) => { child.once("error", fail); child.once("exit", () => ok()); });
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!predicate() && child.exitCode === null && Date.now() < deadline) await delay(40);
    assert.ok(predicate());
  };
  try {
    await until(() => publishedHostEntries(slots).length === 20);
    const allocated = publishedHostEntries(slots).sort();
    assert.deepEqual(allocated, entries.slice(0, 20));
    for (const id of allocated) rmSync(join(waiting, id));
    // A later ticket from a dead controller proves the scheduler processed
    // another full sweep with twenty outstanding allocations.
    const orphan = randomUUID();
    atomicPrivateWrite(join(waiting, orphan), JSON.stringify({pid: process.pid, birth: "expired"}));
    await until(() => !existsSync(join(waiting, orphan)));
    assert.deepEqual(publishedHostEntries(slots).sort(), allocated);
    rmSync(join(slots, allocated[0]!));
    await until(() => existsSync(join(slots, entries[20]!)));
    assert.equal(publishedHostEntries(slots).length, 20);
  } finally {
    child.kill();
    await done;
    rmSync(home, {recursive: true, force: true});
  }
});

test("batch observations distinguish outstanding dispatch from fenced recovery, including explicit resumes",async()=>{
  const {batchHostObservation,batchNotificationId}=await import("../src/managed-host-client.js");
  const home=realpathSync(mkdtempSync(join(tmpdir(),"grounds-batch-observe-"))),original=process.env.GROUNDS_DATA_HOME;
  process.env.GROUNDS_DATA_HOME=home;
  try {
    const id=randomUUID(),ledger=randomUUID(),root=join(dataLayout(home).runtime,"managed-host");
    const record=JSON.stringify({kind:"experiment",allowStart:true,ledgerId:ledger,executionId:id});
    const requests=privateDirectory(join(root,"requests")),issued=privateDirectory(join(root,"issued"));
    const initial=id+"."+batchNotificationId("launch",id),resume=id+"."+randomUUID();
    assert.equal(batchHostObservation(id,ledger,{state:"accepted"})?.state,"unknown");
    atomicPrivateWrite(join(requests,initial),record);
    assert.equal(batchHostObservation(id,ledger,{state:"running"})?.state,"unknown");
    atomicPrivateWrite(join(issued,initial),id);
    assert.equal(batchHostObservation(id,ledger,{state:"running"})?.state,"awaiting-resume");
    atomicPrivateWrite(join(requests,resume),record);
    assert.equal(batchHostObservation(id,ledger,{state:"awaiting-resume"})?.state,"unknown");
    const old=id+"."+randomUUID();
    atomicPrivateWrite(join(requests,old),record);
    atomicPrivateWrite(join(requests,resume+".owner"),JSON.stringify({pid:process.pid,birth:hostProcessIdentity(process.pid)}));
    assert.equal(batchHostObservation(id,ledger,{state:"awaiting-resume"})?.state,"starting");
    atomicPrivateWrite(join(issued,old),id);
    atomicPrivateWrite(join(issued,resume),id);
    assert.equal(batchHostObservation(id,ledger,{state:"awaiting-resume"}),undefined);
    const batches=privateDirectory(join(root,"batches"));
    atomicPrivateWrite(join(batches,id),JSON.stringify({name:resume,pid:process.pid,birth:hostProcessIdentity(process.pid)}));
    assert.equal(batchHostObservation(id,ledger,{state:"awaiting-resume"})?.state,"running");
  } finally {
    if(original===undefined) delete process.env.GROUNDS_DATA_HOME;else process.env.GROUNDS_DATA_HOME=original;
    rmSync(home,{recursive:true,force:true});
  }
});
