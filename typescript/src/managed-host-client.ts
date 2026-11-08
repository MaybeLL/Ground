import {operation} from "./work/driver/operation-id.js";
import { spawn } from "node:child_process";
import { existsSync,readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostProcessIdentity } from "./env-process.js";
import { dataLayout } from "./data-layout.js";
import { atomicPrivateWrite, privateDirectory, removePrivateFile, safeRead, withRuntimeLock } from "./runtime-files.js";

export type HostJob = {kind?: "test-grading" | "agent-grading" | "experiment"; config: string; ledgerId: string; runId: string; executionId: string; allowStart: boolean};
export const managedId = /^[a-f0-9-]{36}$/;
/** Atomic publication stages records under .<UUID> until rename completes. */
export function publishedHostEntries(directory:string) {
  return readdirSync(directory).filter(name=>!(name.startsWith(".") && managedId.test(name.slice(1))));
}
export const queueRoot = () => privateDirectory(join(dataLayout().runtime, "managed-host"));
export const hostDirectory = (name: string) => privateDirectory(join(queueRoot(), name));

/** The host shares one admission limit across all ledgers in this Grounds data home. */
export function managedAgentCapacity():number {
  const path=join(dataLayout().runtime,"managed-host","agent-capacity");
  if (!existsSync(path)) return 20;
  const capacity=Number(safeRead(path,64).toString());
  if (!Number.isSafeInteger(capacity) || capacity<1) throw new Error("invalid managed Agent capacity");
  return capacity;
}

export async function setManagedAgentCapacity(capacity:number) {
  if (!Number.isSafeInteger(capacity) || capacity<1) throw new Error("expected a positive integer for Agent capacity");
  await withRuntimeLock(queueRoot(),"agent-admission",async()=>atomicPrivateWrite(join(queueRoot(),"agent-capacity"),String(capacity)),10000);
}

/** Older runners did not record the kind in their ticket. Their immutable request still identifies command-only grading. */
export function usesAgentSlot(ticket:{name?:string;kind?:HostJob["kind"]|"worker"}) {
  if (ticket.kind!==undefined) return ticket.kind!=="test-grading";
  const name=ticket.name ?? "";
  const [id,operation]=name.split(".");
  if (!id || !operation || !managedId.test(id) || !managedId.test(operation) || name!==id+"."+operation) return true;
  const path=join(dataLayout().runtime,"managed-host","requests",name);
  if (!existsSync(path)) return true;
  try {
    const request=JSON.parse(safeRead(path,32768).toString()) as HostJob|null;
    return request?.executionId!==id || request?.kind!=="test-grading";
  } catch { return true; }

}

export async function launchManaged(entry: "host" | "job", args: string[] = []) {
  const source = import.meta.url.endsWith(".ts");
  const file = "./managed-" + entry + "-main." + (source ? "ts" : "js");
  const worker = fileURLToPath(new URL(file, import.meta.url));
  // The scheduler only grants local slots. Only the job runner inherits
  // the admitting CLI's database, provider and Docker environment.
  const env = entry === "host" ? {PATH: process.env.PATH, GROUNDS_DATA_HOME: dataLayout().root} : process.env;
  const child = spawn(process.execPath, [...(source ? ["--import", "tsx"] : []), worker, ...args], {
    detached: true, stdio: "ignore", env,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  if (entry === "job" && child.pid) {
    const birth = hostProcessIdentity(child.pid);
    if (birth) return {pid:child.pid,birth};
  }
}

function localRecord(path:string): Record<string,unknown> | undefined {
  if (!existsSync(path)) return;
  try { return JSON.parse(safeRead(path,4096).toString()); }
  catch (error) { if (existsSync(path)) throw error; }
}

export function managedActivityLive(id:string) {
  const root = join(dataLayout().runtime,"managed-host");
  return ["waiting","slots"].some(dir=>{
    const owner = localRecord(join(root,dir,id));
    return typeof owner?.pid === "number" && typeof owner.birth === "string" && hostProcessIdentity(owner.pid) === owner.birth;
  });
}

/** Batch result queries report locally observed recovery state without
 * starting a scheduler, issuing commands or modifying the ledger. */
export function batchHostObservation(id:string,ledgerId:string,saved?:{state?:string}) {
  if (!managedId.test(id) || saved?.state === "terminal") return;
  const root = join(dataLayout().runtime,"managed-host");
  const fallback = localRecord(join(root,"recovery-status",id));
  if (fallback?.ledgerId === ledgerId) return {state:"awaiting-resume",detail:String(fallback.detail)};
  if (saved?.state && !["running","accepted"].includes(saved.state)) return;
  const owner = localRecord(join(root,"batches",id));
  if (typeof owner?.pid !== "number" || typeof owner.birth !== "string" || hostProcessIdentity(owner.pid) !== owner.birth) {
    if (managedRequestRunning(id,batchNotificationId("launch",id))) return {state:"starting",detail:"batch controller is starting"};
    return {state:"awaiting-resume",detail:"no live local batch controller was observed; resume to continue"};
  }
}

export const batchNotificationId = (action:string,id:string) => operation("experiment-host",action,id);

export function managedRequestRunning(executionId:string,operationId:string) {
  const path = join(dataLayout().runtime,"managed-host","requests",executionId + "." + operationId + ".owner");
  if (!existsSync(path)) return false;
  const owner = JSON.parse(safeRead(path,2048).toString());
  return hostProcessIdentity(owner.pid) === owner.birth;
}

export async function notifyManaged(job: HostJob, operationId: string) {
  if (![job.ledgerId, job.runId, job.executionId, operationId].every(id => managedId.test(id))) {
    throw new Error("invalid host job identity");
  }
  const name = job.executionId + "." + operationId;
  const path = join(hostDirectory("requests"), name);
  const record = JSON.stringify({...job, config: resolve(job.config)});
  await withRuntimeLock(queueRoot(), "request-" + name, async () => {
    if (existsSync(path)) {
      if (safeRead(path, 32768).toString() !== record) throw new Error("managed request input changed");
      if (managedRequestRunning(job.executionId,operationId)) return;
      const observer=await launchManaged("job", [name, "observe"]);
      if (observer) atomicPrivateWrite(path+".owner",JSON.stringify(observer));
      return;
    }
    atomicPrivateWrite(path, record);
    try {
      const owner = await launchManaged("job", [name]);
      if (owner) atomicPrivateWrite(path + ".owner",JSON.stringify(owner));
    }
    catch (error) { removePrivateFile(path); throw error; }
  }, 10_000);
}

/** A status query can wake a scheduler lost across a host restart. All
 * orphan reconciliation uses observation authority. */
export async function observeManagedHost(executionId: string, ledgerId: string) {
  const root = join(dataLayout().runtime, "managed-host");
  if (!managedId.test(executionId)) return;
  const fallback = join(root, "recovery-status", executionId);
  if (![join(root, "slots", executionId), join(root, "waiting", executionId), join(root,"batches",executionId), fallback].some(path => existsSync(path))) return;
  try { await withRuntimeLock(root, "host", async () => launchManaged("host")); }
  catch (error) { if (!String(error).includes("another local controller")) throw error; }
  if (existsSync(fallback)) {
    try {
      const record = JSON.parse(safeRead(fallback, 4096).toString());
      if (record.ledgerId === ledgerId) return {state: record.state, detail: record.detail};
    } catch (error) { if (existsSync(fallback)) throw error; }
  }
}
