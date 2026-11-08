import { createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { dataLayout } from "../../../data-layout.js";
import { atomicPrivateWrite, privateDirectory, safeRead, withRuntimeLock } from "../../../runtime-files.js";
import type { ManagedProcessPort, ProcessPlan, ProcessRead, WorkerOutput } from "../../ports/index.js";
import { GitTagArchive } from "../git/tag-archive.js";
import { archiveCandidateBundle } from "../git/managed-candidate.js";
import { commandLineProviders } from "../providers/command-line.js";
import { ProviderTraceCapture } from "../providers/trace-capture.js";
import { EngineProcess } from "./engine-process.js";
import { bridgeStarting, bridgeResult, spawnProviderBridge, type BridgeResult } from "./provider-runner.js";
import { ManagedWorkspaces } from "./workspace.js";
import { DevcontainerRuntime } from "./runtime.js";
import { Readable } from "node:stream";

const providerKeys = {codex:["CODEX_API_KEY","OPENAI_API_KEY"],"claude-code":["ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN"]};
const gitEnvironment = (cwd:string) => ["GIT_CONFIG_COUNT=1","GIT_CONFIG_KEY_0=safe.directory","GIT_CONFIG_VALUE_0="+cwd];
const sourceOf = (bytes:Buffer) => ({digest:"sha256:"+createHash("sha256").update(bytes).digest("hex"),byteLength:bytes.length,open:async function*(){yield bytes;}});

export class ContainerAgentProcess implements ManagedProcessPort {
  private readonly engine:EngineProcess;
  constructor(private readonly runtime:DevcontainerRuntime,private readonly workspaces:ManagedWorkspaces,private readonly archive:GitTagArchive) {
    this.engine=new EngineProcess(runtime);
  }

  private root(plan:ProcessPlan) {
    if(![plan.job.executionId,plan.target.owner.ledgerId].every(id=>/^[a-f0-9-]{36}$/.test(id))) throw new Error("invalid managed identity");
    return privateDirectory(join(dataLayout().runtime,"executions",plan.target.owner.ledgerId,plan.job.executionId));
  }

  private config(plan:ProcessPlan){
    const path=join(this.workspaces.root(plan.target.owner),"prepared",".devcontainer","effective","devcontainer.json");
    return JSON.parse(safeRead(path,1024*1024).toString()) as {workspaceFolder:string;remoteUser?:string};
  }

  async handle(plan:ProcessPlan,allowCreate:boolean) {
    const root=this.root(plan),path=join(root,"handle");
    if(existsSync(path)) return safeRead(path,128).toString();
    if(!allowCreate)return undefined;
    if(existsSync(join(root,"create-attempt")))throw new Error("Docker handle creation was interrupted before start");
    const config=this.config(plan),provider=commandLineProviders[plan.agent.provider];
    const environment=providerKeys[plan.agent.provider].filter(key=>process.env[key]!==undefined).map(key=>key+"="+process.env[key]);
    environment.push(...gitEnvironment(config.workspaceFolder));
    atomicPrivateWrite(join(root,"inventory.json"),JSON.stringify(await this.runtime.processes(plan.target.owner,plan.target.containerId)));
    atomicPrivateWrite(join(root,"create-attempt"),plan.job.executionId);
    const id=await this.engine.create(plan.target,{argv:provider.command(plan.agent.model),cwd:config.workspaceFolder,user:config.remoteUser,environment});
    atomicPrivateWrite(path,id);
    return id;
  }

  private async confirmExit(plan: ProcessPlan, handle: string, result: BridgeResult): Promise<ProcessRead> {
    if (result.handle !== handle) throw new Error("result belongs to a different worker process");
    const actual = await this.engine.observe(plan.target, handle);
    if (actual.running || actual.exitCode !== result.exitCode || !Number.isInteger(result.exitCode)) {
      throw new Error("provider exit is not confirmed");
    }
    return {state: "complete", exitCode: result.exitCode};
  }

  async drive(plan:ProcessPlan,id:string,allowStart:boolean):Promise<ProcessRead> {
    const root=this.root(plan),result=bridgeResult(root);
    if(result) return this.confirmExit(plan, id, result);
    if(!existsSync(join(root,"start-attempt"))){
      if(bridgeStarting(root))return {state:"running",detail:"provider bridge is starting"};
      if(!allowStart)return {state:"awaiting-resume",detail:"provider has not started"};
      await spawnProviderBridge(root,{target:plan.target,handle:id,prompt:plan.prompt});
      return {state:"running",detail:"provider bridge dispatched"};
    }
    try {
      return await withRuntimeLock<ProcessRead>(root,"bridge",async()=>{
        const final=bridgeResult(root);
        if(final) return this.confirmExit(plan, id, final);
        return {state:"interrupted",detail:"provider bridge exited without a complete result"};
      });
    } catch(error) {
      if(String(error).includes("another local controller"))return {state:"running",detail:"provider bridge is active"};
      throw error;
    }
  }

  async output(plan:ProcessPlan):Promise<WorkerOutput> {
    const trace=await new ProviderTraceCapture().capture(plan.agent.provider,join(this.root(plan),"stdout.jsonl"));
    try {
      let message="",providerFailed=false;
      const lines=createInterface({input:Readable.from(trace.events.open()),crlfDelay:Infinity});
      for await(const line of lines){
        const event=JSON.parse(line).event;
        if(event.kind==="message"&&event.role==="assistant")message=event.text;
        if(event.kind==="provider-ended")providerFailed=event.outcome==="failed";
      }
      const stderrPath=join(this.root(plan),"stderr"),hash=createHash("sha256");
      let byteLength=0;
      for await(const bytes of createReadStream(stderrPath)){hash.update(bytes);byteLength+=bytes.length;}
      return {trace,message,output:sourceOf(Buffer.from(message)),stderr:{byteLength,digest:"sha256:"+hash.digest("hex"),open:()=>createReadStream(stderrPath)},providerFailed};
    } catch(error){await trace.dispose();throw error;}
  }

  async candidate(plan:ProcessPlan,commit:string,baseline:string,remote:string) {
    const root=this.root(plan),bundle=join(root,"candidate.bundle");
    const config=this.config(plan);
    if(!existsSync(join(root,"bundle-complete"))) {
      const handle=await this.engine.create(plan.target,{cwd:config.workspaceFolder,user:config.remoteUser,environment:gitEnvironment(config.workspaceFolder),argv:["sh","-c",
        'git -c core.hooksPath=/dev/null update-ref refs/grounds/candidate "$1" && git -c core.hooksPath=/dev/null bundle create - refs/grounds/candidate',"grounds",commit]});
      const file=join(root,"bundle-"+handle);
      const result=await this.engine.start(plan.target,handle,"",file,file+".stderr");
      if(result.running || result.exitCode===null)return {status:"unavailable" as const,reason:"bundle export exit is not confirmed"};
      if(result.exitCode!==0)return {status:"invalid" as const,reason:"claimed commit cannot be exported by the worker checkout"};
      const {rename}=await import("node:fs/promises");await rename(file,bundle);
      atomicPrivateWrite(join(root,"bundle-complete"),commit);
    }
    if(safeRead(join(root,"bundle-complete"),128).toString()!==commit) return {status:"invalid" as const,reason:"exported bundle belongs to a different claim"};
    const id="d-"+plan.job.runId+"-"+commit.slice(0,12);
    const archived=await archiveCandidateBundle(this.archive,{repository:plan.job.repositoryPath,remote,baseline,commit,bundle,id});
    return archived.status==="confirmed" ? {status:"confirmed" as const,id,receipt:archived.receipt} :
      {status:archived.status==="unavailable"?"unavailable" as const:"invalid" as const,reason:archived.reason};
  }

  async stop(plan:ProcessPlan,force:boolean) {
    const {owner,containerId,location}=plan.target;
    const bound=await this.runtime.location();
    if(bound.hostId!==location.hostId||bound.daemonId!==location.daemonId)throw new Error("cannot verify stop on a different Docker daemon");
    const current=await this.runtime.observe(owner);
    if(!current)return;
    if(current.id!==containerId)throw new Error("runtime identity changed before stop");
    if(current.state==="stopped")return;
    if(!force && existsSync(join(this.root(plan),"inventory.json"))){
      const before=new Set<string>(JSON.parse(safeRead(join(this.root(plan),"inventory.json")).toString()));
      const after=await this.runtime.processes(owner,containerId);
      if(after.every(line=>before.has(line)))return;
    }
    await this.runtime.stop(owner,containerId);
  }
}
