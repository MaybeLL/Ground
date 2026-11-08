import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openStore } from "./cli.js";
import { atomicPrivateWrite, privateDirectory, removePrivateFile, safeRead, withRuntimeLock } from "./runtime-files.js";
import { queueRoot, queuePath, statusPath, type HostJob } from "./managed-host-client.js";
import { composeWork } from "./work/composition.js";

async function processJob(name:string) {
  const path=join(queuePath(),name),root=queueRoot();
  const job=JSON.parse(safeRead(path,32768).toString()) as HostJob;
  if(!/^[a-f0-9-]{36}$/.test(job.executionId) || !name.startsWith(job.executionId+"."))throw new Error("invalid managed queue identity");
  const issued=join(privateDirectory(join(root,"issued")),name);
  let state="blocked",detail:string|undefined;
  try {
    const opened=await openStore(job.config);
    try {
      if(opened.config.database.expected_database_id!==job.ledgerId)throw new Error("job ledger identity changed");
      const app=composeWork(opened.store);
      const current=await app.workers.context(job.runId);
      if(!current.ok || current.value.exec.id!==job.executionId)throw new Error("job does not belong to this ledger");
      const allowStart=job.allowStart && !existsSync(issued);
      if(allowStart) atomicPrivateWrite(issued,job.executionId);
      const outcome=await app.driver.drive(job.runId,allowStart);
      if(outcome.ok){state=outcome.value.state;detail=outcome.value.detail;}
      else detail=outcome.error.message;
      await app.workers.note(job.runId,state,detail);
    } finally {await opened.store.close();}
  } catch {detail="the host could not verify or drive this execution; inspect the run and resume explicitly";}
  atomicPrivateWrite(statusPath(job.executionId),JSON.stringify({state,...(detail?{detail}:{}),at:new Date().toISOString()}));
  if(state!=="running")removePrivateFile(path);
}

async function host() {
  const root=queueRoot();
  await withRuntimeLock(root,"host",async()=>{
    for(;;) {
      const names=readdirSync(queuePath()).filter(name=>/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.json$/.test(name)).sort();
      if(!names.length)return;
      // Each execution gets one driver. Poll active workers as well as newly
      // admitted jobs; waiting for a provider never holds a SQL transaction.
      const selected=new Map<string,string>();
      for(const name of names) if(!selected.has(name.slice(0,36))) selected.set(name.slice(0,36),name);
      await Promise.all([...selected.values()].slice(0,20).map(processJob));
      await delay(150);
    }
  },10_000);
}
try {await host();}
catch {process.exitCode=1;}
