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

  dispatched(owner:RuntimeOwner) { return existsSync(join(this.workspaces.setupRoot(owner),"launch.json")); }

  async status(owner: RuntimeOwner): Promise<LaunchObservation> {
    if (await this.workspaces.hasReleaseMarker(owner)) return "interrupted";
    const root = this.workspaces.setupRoot(owner);
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
    const root = this.workspaces.setupRoot(owner);
    return withRuntimeLock(root,"launch",async () => {
      if (existsSync(marker(root))) return false;
      atomicPrivateWrite(marker(root),"failed");
      return true;
    });
  }

  async workspace(owner:RuntimeOwner,location:RuntimeLocation,expectedPath:string) {
    const plan=JSON.parse(safeRead(join(this.workspaces.setupRoot(owner),"launch.json"),32768).toString()) as Plan;
    if (plan.owner.ledgerId!==owner.ledgerId || plan.owner.sandboxId!==owner.sandboxId || plan.owner.setupAttempt!==owner.setupAttempt ||
        plan.location.hostId!==location.hostId || plan.location.daemonId!==location.daemonId || plan.workspace.path!==expectedPath ||
        plan.workspace.configPath!==join(this.workspaces.root(owner),"prepared",".devcontainer","devcontainer.json")) throw Error("sandbox launch plan identity changed");
    return plan.workspace;
  }

  async start(owner: RuntimeOwner, workspace: RuntimeWorkspace, location: RuntimeLocation) {
    const root = this.workspaces.setupRoot(owner), path = join(root,"launch.json");
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
  const contents = safeRead(path,32768).toString();
  const plan = JSON.parse(contents) as Plan;
  const workspaces = new ManagedWorkspaces();
  await workspaces.withSetupLifetime(plan.owner,async () => {
    // Reading the plan cannot recreate the sandbox. A releaser may have
    // removed it while this helper waited for the stable lifetime lock.
    if (safeRead(path,32768).toString() !== contents) throw new Error("sandbox setup plan changed");
    const root = workspaces.setupRoot(plan.owner);
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
  });
}
