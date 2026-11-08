import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {rm} from "node:fs/promises";
import {join} from "node:path";
import {atomicPrivateWrite, privateDirectory, safeRead, withRuntimeLock} from "../../../runtime-files.js";
import type {EvaluatorTarget, StepRead, TestProcessPort, TestStreams} from "../../ports/index.js";
import {EngineProcess} from "./engine-process.js";
import {bridgeResult, bridgeStarting, spawnProviderBridge} from "./provider-runner.js";
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
    if (bridgeStarting(root)) return {state:"running"};
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
    await rm(this.workspaces.root(owner),{recursive:true,force:true});
  }
}
