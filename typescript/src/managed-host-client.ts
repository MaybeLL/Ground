import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataLayout } from "./data-layout.js";
import { atomicPrivateWrite, privateDirectory } from "./runtime-files.js";

export type HostJob = {config:string;ledgerId:string;runId:string;executionId:string;allowStart:boolean};
export const queueRoot = () => privateDirectory(join(dataLayout().runtime,"managed-host"));
export const queuePath = () => privateDirectory(join(queueRoot(),"queue"));
export const statusPath = (executionId:string) => join(privateDirectory(join(queueRoot(),"status")),executionId+".json");

export async function notifyManaged(job:HostJob,operationId:string) {
  if(![job.ledgerId,job.runId,job.executionId,operationId].every(id=>/^[a-f0-9-]{36}$/.test(id)))throw new Error("invalid host job identity");
  const path=join(queuePath(),job.executionId+"."+operationId+".json");
  if(!existsSync(path))atomicPrivateWrite(path,JSON.stringify({...job,config:resolve(job.config)}));
  const source=import.meta.url.endsWith(".ts");
  const worker=fileURLToPath(new URL(source?"./managed-host-main.ts":"./managed-host-main.js",import.meta.url));
  const child=spawn(process.execPath,[...(source?["--import","tsx"]:[]),worker],{detached:true,stdio:"ignore"});
  await new Promise<void>((ok,fail)=>{child.once("error",fail);child.once("spawn",ok);});
  child.unref();
}
