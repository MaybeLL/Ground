// Per-execution bridge, independent of the CLI and host's lifetime. No model
// invocation is replayed once start-attempt exists.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {dataLayout} from "../../../data-layout.js";
import {ManagedWorkspaces} from "./workspace.js";
import { hostProcessIdentity } from "../../../env-process.js";
import { atomicPrivateWrite, safeRead, withRuntimeLock,withRuntimeLockSync } from "../../../runtime-files.js";
import { EngineProcess, type ProcessTarget } from "./engine-process.js";
import { DevcontainerRuntime } from "./runtime.js";

export type BridgePlan = {target:ProcessTarget;handle:string;prompt:string;boundedTestOutput?:boolean};
export type BridgeResult = {exitCode:number;handle:string;byteCounts?:{stdout:number;stderr:number}};
export const resultFile = (root:string) => join(root,"result.json");
export function bridgeResult(root:string):BridgeResult|undefined {
  if (!existsSync(resultFile(root))) return;
  return JSON.parse(safeRead(resultFile(root),2048).toString()) as BridgeResult;
}
export async function spawnProviderBridge(root:string,plan:BridgePlan) {
  await withRuntimeLock(dataLayout().runtime,"provider-dispatch-"+root,async fd=>{
    if (existsSync(join(root,"dispatch-revoked"))) throw Error("collector dispatch was revoked");
    const path=join(root,"bridge.json");
    const data=JSON.stringify(plan);
    if (existsSync(path)) {
      if(safeRead(path,1024*1024).toString()!==data) throw new Error("provider bridge plan changed");
    } else {
      atomicPrivateWrite(join(root,"dispatch-protocol"),"inherited-lock/v2");
      atomicPrivateWrite(path,data);
    }
    const source=import.meta.url.endsWith(".ts");
    const entry=fileURLToPath(new URL(source?"./provider-runner-main.ts":"./provider-runner-main.js",import.meta.url));
    const child=spawn(process.execPath,[...(source?["--import","tsx"]:[]),entry,root],{detached:true,stdio:["ignore","ignore","ignore",fd]});
    await new Promise<void>((ok,fail)=>{child.once("error",fail);child.once("spawn",ok);});
    const birth=child.pid && hostProcessIdentity(child.pid);
    if(birth) atomicPrivateWrite(join(root,"bridge-owner"),JSON.stringify({pid:child.pid,birth}));
    child.unref();
  });
}
export async function collectProvider(root:string) {
  const path=join(root,"bridge.json");
  if (!existsSync(path)) return;
  const original=safeRead(path,1024*1024).toString(),plan=JSON.parse(original) as BridgePlan;
  // Disposal holds this same lock outside the sandbox. A delayed collector
  // has to re-read its plan before it can create anything inside the spool.
  await new ManagedWorkspaces().withSetupLifetime(plan.target.owner,async()=>{
    if (!existsSync(path) || safeRead(path,1024*1024).toString()!==original) return;
    await withRuntimeLock(root,"bridge",async()=>{
      if(existsSync(join(root,"start-attempt")) || existsSync(join(root,"dispatch-revoked")))return;
      atomicPrivateWrite(join(root,"start-attempt"),plan.handle);
      try {
        const engine=new EngineProcess(new DevcontainerRuntime());
        const observed=await engine.start(plan.target,plan.handle,plan.prompt,join(root,"stdout.jsonl"),join(root,"stderr"),plan.boundedTestOutput ? 1024*1024 : undefined);
        if(observed.running || observed.exitCode===null) throw new Error("exit not confirmed");
        atomicPrivateWrite(resultFile(root),JSON.stringify({handle:plan.handle,exitCode:observed.exitCode,...(observed.byteCounts ? {byteCounts:observed.byteCounts} : {})} satisfies BridgeResult));
      } catch { atomicPrivateWrite(join(root,"bridge-failed"),plan.handle); }
    });
  });
}

export function bridgeStarting(root:string):boolean {
  try {withRuntimeLockSync(dataLayout().runtime,"provider-dispatch-"+root,()=>{});}
  catch(error) {if (String(error).includes("another local controller")) return true;throw error;}
  const path=join(root,"bridge-owner");
  if(!existsSync(path))return false;
  const info=JSON.parse(safeRead(path,1024).toString()) as {pid:number;birth:string};
  return hostProcessIdentity(info.pid)===info.birth;
}

/** The caller stops the container first so a collector already inside Engine.start can finish. */
export async function revokeBridge(root:string) {
  const path=join(root,"bridge.json");
  if (!existsSync(path)) return;
  await withRuntimeLock(root,"bridge",async()=>{
    if (!existsSync(path) || bridgeResult(root)) return;
    const plan=JSON.parse(safeRead(path,1024*1024).toString()) as BridgePlan;
    atomicPrivateWrite(join(root,"dispatch-revoked"),plan.handle);
    const protocol=join(root,"dispatch-protocol");
    const understandsRevocation=existsSync(protocol) && safeRead(protocol,64).toString()==="inherited-lock/v2";
    if (!understandsRevocation && !existsSync(join(root,"start-attempt"))) atomicPrivateWrite(join(root,"start-attempt"),plan.handle);
  },30000);
}

/** Older helpers could be in flight without either an owner receipt or an inherited lock. */
export async function pendingBridge(root:string,handle:string):Promise<"running"|"interrupted"|undefined> {
  if (existsSync(join(root,"dispatch-revoked"))) return "interrupted";
  if (bridgeStarting(root)) return "running";
  if (!existsSync(join(root,"bridge.json")) || existsSync(join(root,"dispatch-protocol")) || existsSync(join(root,"start-attempt"))) return;
  try {
    return await withRuntimeLock(root,"bridge",async()=>{
      if (!existsSync(join(root,"start-attempt"))) atomicPrivateWrite(join(root,"start-attempt"),handle);
      return "interrupted" as const;
    });
  } catch(error) {if (String(error).includes("another local controller")) return "running";throw error;}
}
