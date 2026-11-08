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
import {captureWorkspaceFile} from "../file-spool.js";
import type {ArtifactDeclaration} from "../../domain/managed-delivery.js";
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
    const receiptPath = join(this.root(plan), "confirmed-exit");
    const receipt = JSON.stringify({target: plan.target, handle, exitCode: result.exitCode});
    if (existsSync(receiptPath)) {
      if (safeRead(receiptPath, 4096).toString() !== receipt) throw new Error("recorded exit identity changed");
      return {state: "complete", exitCode: result.exitCode};
    }
    const actual = await this.engine.observe(plan.target, handle);
    if (actual.running || actual.exitCode !== result.exitCode || !Number.isInteger(result.exitCode)) {
      throw new Error("provider exit is not confirmed");
    }
    atomicPrivateWrite(receiptPath, receipt);
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

  async exportCandidate(plan: ProcessPlan, commit: string, allowStart: boolean) {
    const root = privateDirectory(join(this.root(plan), "export"));
    const handlePath = join(root, "handle"), claimPath = join(root, "commit");
    if (existsSync(claimPath) && safeRead(claimPath, 128).toString() !== commit) return "invalid" as const;
    if (!existsSync(handlePath)) {
      if (!allowStart) return "awaiting-resume" as const;
      if (existsSync(claimPath)) return "interrupted" as const;
      atomicPrivateWrite(claimPath, commit);
      const config = this.config(plan);
      const handle = await this.engine.create(plan.target, {
        cwd: config.workspaceFolder, user: config.remoteUser, environment: gitEnvironment(config.workspaceFolder),
        argv: ["sh", "-c", 'git -c core.hooksPath=/dev/null update-ref refs/grounds/candidate "$1" && git -c core.hooksPath=/dev/null bundle create - refs/grounds/candidate', "grounds", commit],
      });
      atomicPrivateWrite(handlePath, handle);
    }
    const handle = safeRead(handlePath, 128).toString();
    const result = bridgeResult(root);
    if (result) {
      if (result.handle !== handle) throw new Error("bundle result belongs to a different exec");
      return result.exitCode === 0 ? "ready" as const : "invalid" as const;
    }
    if (bridgeStarting(root)) return "running" as const;
    if (existsSync(join(root, "start-attempt"))) return "interrupted" as const;
    if (!allowStart) return "awaiting-resume" as const;
    await spawnProviderBridge(root, {target: plan.target, handle, prompt: ""});
    return "running" as const;
  }

  async candidate(plan:ProcessPlan,commit:string,baseline:string,remote:string,allowPublish:boolean) {
    const root = join(this.root(plan), "export");
    const bundle = join(root, "stdout.jsonl");
    if (safeRead(join(root, "commit"), 128).toString() !== commit) throw new Error("bundle claim changed");
    const id="d-"+plan.job.runId+"-"+commit.slice(0,12);
    const archived=await archiveCandidateBundle(this.archive,{repository:plan.job.repositoryPath,remote,baseline,commit,bundle,id,allowPublish,parentReceipt:plan.job.parentReceipt});
    return archived.status==="confirmed" ? {status:"confirmed" as const,id,receipt:archived.receipt} :
      {status:archived.status==="unavailable"?"unavailable" as const:"invalid" as const,reason:archived.reason};
  }

  async artifacts(plan:ProcessPlan,declared:readonly ArtifactDeclaration[]) {
    const root=join(this.workspaces.root(plan.target.owner),"prepared","workspace");
    const cleanups:(()=>Promise<void>)[]=[];
    const dispose=async()=>{await Promise.all(cleanups.map(clean=>clean()));};
    try {
      const entries=[];
      for (const item of declared) {
        const files=[];
        for (const file of item.files) {
          const captured=await captureWorkspaceFile(root,file.source);
          cleanups.push(captured.dispose);
          files.push({path:file.path,source:captured.source});
        }
        entries.push({slot:item.slot,files});
      }
      return {entries,dispose};
    } catch (error) {await dispose();throw error;}
  }

  async quiescent(plan: ProcessPlan) {
    const {owner, containerId, location} = plan.target;
    const bound = await this.runtime.location();
    if (bound.hostId !== location.hostId || bound.daemonId !== location.daemonId) throw new Error("runtime location changed");
    const current = await this.runtime.observe(owner);
    if (!current) return true;
    if (current.id !== containerId) throw new Error("execution container identity changed");
    if (current.state === "stopped") return true;
    const inventory = join(this.root(plan), "inventory.json");
    if (!existsSync(inventory)) return false;
    const before = new Set<string>(JSON.parse(safeRead(inventory).toString()));
    return (await this.runtime.processes(owner, containerId)).every(line => before.has(line));
  }

  async stop(plan:ProcessPlan,force:boolean) {
    const {owner,containerId,location}=plan.target;
    const bound=await this.runtime.location();
    if(bound.hostId!==location.hostId||bound.daemonId!==location.daemonId)throw new Error("cannot verify stop on a different Docker daemon");
    const current=await this.runtime.observe(owner);
    if(!current)return;
    if(current.id!==containerId)throw new Error("runtime identity changed before stop");
    if(current.state==="stopped")return;
    if (!force && await this.quiescent(plan)) return;
    await this.runtime.stop(owner,containerId);
  }
}
