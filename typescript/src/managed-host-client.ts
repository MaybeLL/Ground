import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataLayout } from "./data-layout.js";
import { atomicPrivateWrite, privateDirectory, removePrivateFile, safeRead, withRuntimeLock } from "./runtime-files.js";

export type HostJob = {config: string; ledgerId: string; runId: string; executionId: string; allowStart: boolean};
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
      await launchManaged("job", [name, "observe"]);
      return;
    }
    atomicPrivateWrite(path, record);
    try { await launchManaged("job", [name]); }
    catch (error) { removePrivateFile(path); throw error; }
  }, 10_000);
}
