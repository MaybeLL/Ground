import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostProcessIdentity } from "./env-process.js";
import { dataLayout } from "./data-layout.js";
import { atomicPrivateWrite, privateDirectory, removePrivateFile, safeRead, withRuntimeLock } from "./runtime-files.js";

export type HostJob = {kind?: "test-grading" | "experiment"; config: string; ledgerId: string; runId: string; executionId: string; allowStart: boolean};
export const managedId = /^[a-f0-9-]{36}$/;
export const queueRoot = () => privateDirectory(join(dataLayout().runtime, "managed-host"));
export const hostDirectory = (name: string) => privateDirectory(join(queueRoot(), name));

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
  if (saved?.state !== "running") return;
  const owner = localRecord(join(root,"batches",id));
  if (typeof owner?.pid !== "number" || typeof owner.birth !== "string" || hostProcessIdentity(owner.pid) !== owner.birth) {
    return {state:"awaiting-resume",detail:"batch controller is not running; resume to continue"};
  }
}

export function managedRequestRunning(executionId:string,operationId:string) {
  const path = join(hostDirectory("requests"),executionId + "." + operationId + ".owner");
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
      await launchManaged("job", [name, "observe"]);
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
