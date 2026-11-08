import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicPrivateWrite, safeRead, withRuntimeLock } from "../../../runtime-files.js";
import type { LaunchObservation, RuntimeLocation, RuntimeOwner, RuntimeWorkspace, SandboxLauncher } from "../../ports/index.js";
import { ManagedWorkspaces } from "./workspace.js";
import { DevcontainerRuntime } from "./runtime.js";

type Plan = { owner: RuntimeOwner; location: RuntimeLocation; workspace: RuntimeWorkspace };
const marker = (root: string) => join(root, "launch-state");

export class DurableSandboxLauncher implements SandboxLauncher {
  constructor(private readonly workspaces: ManagedWorkspaces) {}

  async status(owner: RuntimeOwner): Promise<LaunchObservation> {
    const root = this.workspaces.root(owner);
    if (!existsSync(marker(root))) return "not-started";
    const state = safeRead(marker(root),64).toString();
    if (state === "completed" || state === "failed") return state;
    if (state !== "active") throw new Error("unrecognized launch record");
    try {
      return await withRuntimeLock<LaunchObservation>(root, "launch", async () => {
        const current = safeRead(marker(root),64).toString();
        return current === "completed" || current === "failed" ? current : "interrupted";
      });
    } catch (error) {
      if ((error as {details?:{reason?: string}}).details?.reason === "busy" || String(error).includes("another local controller")) return "active";
      throw error;
    }
  }

  async cancelPending(owner: RuntimeOwner): Promise<boolean> {
    const root = this.workspaces.root(owner);
    return withRuntimeLock(root,"launch",async () => {
      if (existsSync(marker(root))) return false;
      atomicPrivateWrite(marker(root),"failed");
      return true;
    });
  }

  async start(owner: RuntimeOwner, workspace: RuntimeWorkspace, location: RuntimeLocation) {
    const root = this.workspaces.root(owner), path = join(root,"launch.json");
    const contents = JSON.stringify({ owner, workspace, location } satisfies Plan);
    if (existsSync(path)) {
      if (safeRead(path,32768).toString() !== contents) throw new Error("conflicting sandbox launch plan");
    } else atomicPrivateWrite(path,contents);
    const source = import.meta.url.endsWith(".ts");
    const worker = fileURLToPath(new URL(source ? "./launch-worker.ts" : "./launch-worker.js", import.meta.url));
    const child = spawn(process.execPath, [...(source ? ["--import","tsx"] : []),worker,path], { detached:true, stdio:"ignore" });
    await new Promise<void>((ok,fail) => {
      child.once("error",fail); child.once("close",code => code === 0 ? ok() : fail(new Error("sandbox helper did not confirm setup")));
    });
  }
}

export async function runLaunchHelper(path: string) {
  const plan = JSON.parse(safeRead(path,32768).toString()) as Plan;
  const workspaces = new ManagedWorkspaces();
  const root = workspaces.root(plan.owner);
  if (path !== join(root,"launch.json")) throw new Error("unexpected sandbox launch plan path");
  await withRuntimeLock(root,"launch",async fd => {
    if (existsSync(marker(root))) return;
    const runtime = new DevcontainerRuntime(undefined,undefined,fd);
    const location = await runtime.location();
    if (location.daemonId !== plan.location.daemonId || location.hostId !== plan.location.hostId) throw new Error("runtime location changed");
    if (await runtime.observe(plan.owner)) throw new Error("launch labels already occupied");
    atomicPrivateWrite(marker(root),"active");
    try {
      const instance = await runtime.up(plan.owner,plan.workspace);
      await workspaces.record(plan.owner,instance.id);
      atomicPrivateWrite(marker(root),"completed");
    } catch {
      atomicPrivateWrite(marker(root),"failed");
      throw new Error("devcontainer launch failed");
    }
  },120_000);
}
