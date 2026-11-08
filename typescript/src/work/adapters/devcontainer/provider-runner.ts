// Per-execution bridge, independent of the CLI and host's lifetime. No model
// invocation is replayed once start-attempt exists.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { hostProcessIdentity } from "../../../env-process.js";
import { atomicPrivateWrite, safeRead, withRuntimeLock } from "../../../runtime-files.js";
import { EngineProcess, type ProcessTarget } from "./engine-process.js";
import { DevcontainerRuntime } from "./runtime.js";

export type BridgePlan = {target:ProcessTarget;handle:string;prompt:string};
export type BridgeResult = {exitCode:number;handle:string};
export const resultFile = (root:string) => join(root,"result.json");
export function bridgeResult(root:string):BridgeResult|undefined {
  if (!existsSync(resultFile(root))) return;
  return JSON.parse(safeRead(resultFile(root),2048).toString()) as BridgeResult;
}
export async function spawnProviderBridge(root:string,plan:BridgePlan) {
  const path=join(root,"bridge.json");
  const data=JSON.stringify(plan);
  if (existsSync(path)) {
    if(safeRead(path,1024*1024).toString()!==data) throw new Error("provider bridge plan changed");
  } else atomicPrivateWrite(path,data);
  const source=import.meta.url.endsWith(".ts");
  const entry=fileURLToPath(new URL(source?"./provider-runner-main.ts":"./provider-runner-main.js",import.meta.url));
  const child=spawn(process.execPath,[...(source?["--import","tsx"]:[]),entry,root],{detached:true,stdio:"ignore"});
  await new Promise<void>((ok,fail)=>{child.once("error",fail);child.once("spawn",ok);});
  const birth=child.pid && hostProcessIdentity(child.pid);
  if(birth) atomicPrivateWrite(join(root,"bridge-owner"),JSON.stringify({pid:child.pid,birth}));
  child.unref();
}
export async function collectProvider(root:string) {
  await withRuntimeLock(root,"bridge",async()=>{
    if(existsSync(join(root,"start-attempt")))return;
    const plan=JSON.parse(safeRead(join(root,"bridge.json"),1024*1024).toString()) as BridgePlan;
    atomicPrivateWrite(join(root,"start-attempt"),plan.handle);
    try {
      const engine=new EngineProcess(new DevcontainerRuntime());
      const observed=await engine.start(plan.target,plan.handle,plan.prompt,join(root,"stdout.jsonl"),join(root,"stderr"));
      if(observed.running || observed.exitCode===null) throw new Error("exit not confirmed");
      atomicPrivateWrite(resultFile(root),JSON.stringify({handle:plan.handle,exitCode:observed.exitCode} satisfies BridgeResult));
    } catch { atomicPrivateWrite(join(root,"bridge-failed"),plan.handle); }
  });
}

export function bridgeStarting(root:string):boolean {
  const path=join(root,"bridge-owner");
  if(!existsSync(path))return false;
  const info=JSON.parse(safeRead(path,1024).toString()) as {pid:number;birth:string};
  return hostProcessIdentity(info.pid)===info.birth;
}
