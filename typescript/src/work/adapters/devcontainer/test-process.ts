import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {lstat,readdir,rename,rm} from "node:fs/promises";
import {join} from "node:path";
import {atomicPrivateWrite, privateDirectory, safeRead, withRuntimeLock} from "../../../runtime-files.js";
import type {EvaluatorTarget, StepRead, TestProcessPort, TestStreams} from "../../ports/index.js";
import {EngineProcess} from "./engine-process.js";
import {bridgeResult, pendingBridge, revokeBridge, spawnProviderBridge} from "./provider-runner.js";
import type {DevcontainerRuntime} from "./runtime.js";
import type {ManagedWorkspaces} from "./workspace.js";
import type {EvaluatorWorkspaces} from "./evaluator-workspace.js";

export class ContainerTestProcess implements TestProcessPort {
  private readonly engine:EngineProcess;
  readonly prepare:TestProcessPort["prepare"];
  constructor(private readonly runtime:DevcontainerRuntime, private readonly workspaces:ManagedWorkspaces, evaluator:EvaluatorWorkspaces) {
    this.engine = new EngineProcess(runtime);
    this.prepare = evaluator.prepare.bind(evaluator);
  }

  async command(target:EvaluatorTarget,ordinal:number,token:number,argv:string[],allowStart:boolean,cancel:boolean):Promise<StepRead> {
    const {owner,containerId} = target;
    const parent = this.workspaces.root(owner);
    const root = privateDirectory(join(parent,"test-commands",ordinal + "-" + token));
    const exitPath = join(root,"stopped.json"), handlePath = join(root,"handle");
    if (existsSync(exitPath)) return JSON.parse(safeRead(exitPath,4096).toString()) as StepRead;
    const bound = await this.runtime.location();
    if (bound.daemonId !== target.location.daemonId || bound.hostId !== target.location.hostId) throw new Error("evaluator runtime location changed");
    const observed = await this.runtime.observe(owner);
    if (observed && observed.id !== containerId) throw new Error("evaluator container identity changed");
    const stop = async (exitCode?:number):Promise<StepRead> => {
      if (observed && observed.state !== "stopped") await this.runtime.stop(owner,containerId);
      if (cancel || !observed) await revokeBridge(root);
      const result = {state:"stopped" as const,...(exitCode === undefined ? {} : {exitCode})};
      atomicPrivateWrite(exitPath,JSON.stringify(result));
      return result;
    };
    if (cancel || !observed) return stop();
    if (!existsSync(handlePath)) {
      if (existsSync(join(root,"create-attempt"))) return stop();
      if (!allowStart) {
        if (observed.state !== "stopped") await this.runtime.stop(owner,containerId);
        return {state:"awaiting-resume",providerStopped:true};
      }
      if (observed.state !== "running") await this.runtime.resume(owner,containerId);
      const config = JSON.parse(safeRead(join(parent,"prepared",".devcontainer","effective","devcontainer.json"),1024*1024).toString());
      const effective = await this.runtime.evaluatorEnvironment(owner,containerId,join(parent,"prepared","workspace"),
        join(parent,"prepared",".devcontainer","effective","devcontainer.json"));
      atomicPrivateWrite(join(root,"create-attempt"),String(token));
      const handle = await this.engine.create(target,{argv,cwd:config.workspaceFolder,user:effective.user,
        environment:[...effective.env,"GROUNDS_GRADER_MATERIALS=/grounds-grader","GIT_CONFIG_COUNT=1","GIT_CONFIG_KEY_0=safe.directory","GIT_CONFIG_VALUE_0="+config.workspaceFolder]});
      atomicPrivateWrite(handlePath,handle);
    }
    const handle = safeRead(handlePath,128).toString();
    const result = bridgeResult(root);
    if (result) {
      if (result.handle !== handle) throw new Error("evaluator result has a different Docker handle");
      // The collector already validated Docker's handle, container and exit
      // status. Stop the whole owned container to account for descendants.
      return stop(result.exitCode);
    }
    const pending=await pendingBridge(root,handle);
    if (pending==="running") return {state:"running"};
    if (pending==="interrupted") return stop();
    if (existsSync(join(root,"start-attempt"))) {
      try {
        return await withRuntimeLock<StepRead>(root,"bridge", async () => stop(bridgeResult(root)?.exitCode));
      } catch (error) {
        if (String(error).includes("another local controller")) return {state:"running"};
        throw error;
      }
    }
    if (!allowStart) {
      try {
        return await withRuntimeLock<StepRead>(root,"bridge",async () => {
          // A delayed collector must see the fence before touching Engine.
          atomicPrivateWrite(join(root,"start-attempt"),handle);
          return stop(bridgeResult(root)?.exitCode);
        });
      } catch (error) {
        if (String(error).includes("another local controller")) return {state:"running"};
        throw error;
      }
    }
    await spawnProviderBridge(root,{target,handle,prompt:"",boundedTestOutput:true});
    return {state:"running"};
  }

  async output(owner:EvaluatorTarget["owner"],ordinal:number,token:number) {
    const root = join(this.workspaces.root(owner),"test-commands",ordinal + "-" + token);
    const counts = bridgeResult(root)?.byteCounts;
    const streams:TestStreams = {};
    for (const channel of ["stdout","stderr"] as const) {
      const path = join(root,channel === "stdout" ? "stdout.jsonl" : "stderr");
      if (!existsSync(path)) continue;
      const bytes = safeRead(path,1024*1024);
      streams[channel] = {source:{byteLength:bytes.length, digest:"sha256:"+createHash("sha256").update(bytes).digest("hex"),
        open:async function*(){yield bytes;}},observedBytes:counts?.[channel]};
    }
    return streams;
  }

  async dispose(owner:EvaluatorTarget["owner"]) {
    await this.workspaces.withSetupLifetime(owner,async()=>{
      const root=this.workspaces.root(owner),retiring=root+".retiring";
      const tombstone=this.workspaces.releaseMarker(owner);
      if (await this.workspaces.hasReleaseMarker(owner)) {
        await rm(retiring,{recursive:true,force:true});
        return;
      }
      if (!existsSync(retiring)) {
        const commands=join(root,"test-commands");
        const legacy=existsSync(commands) && (await readdir(commands,{withFileTypes:true})).some(entry=>{
          const spool=join(commands,entry.name);
          return entry.isDirectory() && existsSync(join(spool,"bridge.json")) && !existsSync(join(spool,"dispatch-protocol"));
        });
        if (!legacy) {await rm(root,{recursive:true,force:true});return;}
        // Old binaries can create locks before reading a plan. Move every plan
        // away atomically, then block the retired path with a regular file.
        await rename(root,retiring);
      }
      const marker=join(retiring,"legacy-release-fence");
      atomicPrivateWrite(marker,tombstone);
      for (;;) {
        try {await rename(marker,root);break;}
        catch (error) {
          if (!["EISDIR","ENOTEMPTY","EEXIST","ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") || !(await lstat(root)).isDirectory()) throw error;
          // An old helper raced the rename. Its plan is already unreachable.
          await rm(root,{recursive:true,force:true});
        }
      }
      await rm(retiring,{recursive:true,force:true});
    });
  }
}
