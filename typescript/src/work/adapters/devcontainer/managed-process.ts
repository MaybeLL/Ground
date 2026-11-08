import {chmod,lstat,mkdtemp,open,readdir,rename,rm,writeFile} from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { dataLayout } from "../../../data-layout.js";
import { atomicPrivateWrite, privateDirectory, safeRead, withRuntimeLock } from "../../../runtime-files.js";
import type { AgentProcessPlan,ManagedProcessPort, ProcessPlan, ProcessRead, WorkerOutput } from "../../ports/index.js";
import { GitTagArchive } from "../git/tag-archive.js";
import { archiveCandidateBundle } from "../git/managed-candidate.js";
import { commandLineProviders } from "../providers/command-line.js";
import { ProviderTraceCapture } from "../providers/trace-capture.js";
import {captureWorkspaceFile} from "../file-spool.js";
import type {ArtifactDeclaration} from "../../domain/managed-delivery.js";
import { EngineProcess } from "./engine-process.js";
import { pendingBridge,revokeBridge, bridgeResult, spawnProviderBridge, type BridgeResult } from "./provider-runner.js";
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

  private root(plan:AgentProcessPlan) {
    if(![plan.job.executionId,plan.target.owner.ledgerId].every(id=>/^[a-f0-9-]{36}$/.test(id))) throw new Error("invalid managed identity");
    return privateDirectory(join(dataLayout().runtime,"executions",plan.target.owner.ledgerId,plan.job.executionId));
  }

  private config(plan:AgentProcessPlan){
    const path=join(this.workspaces.root(plan.target.owner),"prepared",".devcontainer","effective","devcontainer.json");
    return JSON.parse(safeRead(path,1024*1024).toString()) as {workspaceFolder:string;remoteUser?:string};
  }

  async handle(plan:AgentProcessPlan,allowCreate:boolean) {
    const root=this.root(plan),path=join(root,"handle");
    if(existsSync(path)) return safeRead(path,128).toString();
    if(!allowCreate)return undefined;
    if(existsSync(join(root,"create-attempt")))throw new Error("Docker handle creation was interrupted before start");
    const config=this.config(plan),provider=commandLineProviders[plan.agent.provider];
    const environment=providerKeys[plan.agent.provider].filter(key=>process.env[key]!==undefined).map(key=>key+"="+process.env[key]);
    environment.push(...gitEnvironment(config.workspaceFolder));
    atomicPrivateWrite(join(root,"inventory.json"),JSON.stringify(await this.runtime.processes(plan.target.owner,plan.target.containerId)));
    atomicPrivateWrite(join(root,"create-attempt"),plan.job.executionId);
    const id=await this.engine.create(plan.target,{argv:provider.command(plan.agent.model,plan.role),cwd:config.workspaceFolder,user:config.remoteUser,environment});
    atomicPrivateWrite(path,id);
    return id;
  }

  private async confirmExit(plan: AgentProcessPlan, handle: string, result: BridgeResult): Promise<ProcessRead> {
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

  async drive(plan:AgentProcessPlan,id:string,allowStart:boolean,authorizeStart?:()=>Promise<boolean>):Promise<ProcessRead> {
    const root=this.root(plan),result=bridgeResult(root);
    if(result) return this.confirmExit(plan, id, result);
    if(!existsSync(join(root,"start-attempt"))){
      const pending=await pendingBridge(root,id);
      if (pending) return {state:pending,detail:pending==="running" ? "provider bridge is starting" : "legacy provider dispatch was interrupted"};
      if(!allowStart)return {state:"awaiting-resume",detail:"provider has not started"};
      if (authorizeStart && !await authorizeStart()) return {state:"running",detail:"evaluator start authority changed"};
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

  private async stderrSource(plan:AgentProcessPlan) {
    const path=join(this.root(plan),"stderr"),hash=createHash("sha256");
    let byteLength=0;
    for await(const bytes of createReadStream(path)){hash.update(bytes);byteLength+=bytes.length;}
    return {byteLength,digest:"sha256:"+hash.digest("hex"),open:()=>createReadStream(path)};
  }

  private async messages(plan:AgentProcessPlan) {
    const trace=await new ProviderTraceCapture().capture(plan.agent.provider,join(this.root(plan),"stdout.jsonl"));
    try {
      let message="",providerFailed=false;
      const lines=createInterface({input:Readable.from(trace.events.open()),crlfDelay:Infinity});
      for await(const line of lines){
        const event=JSON.parse(line).event;
        if(event.kind==="message"&&event.role==="assistant")message=event.text;
        if(event.kind==="provider-ended")providerFailed=event.outcome==="failed";
      }
      if (plan.role==="evaluator") message=trace.finalMessage ?? "";
      return {trace,message,output:sourceOf(Buffer.from(message)),providerFailed};
    } catch(error){await trace.dispose();throw error;}
  }

  async availableOutput(plan:AgentProcessPlan) {
    const root=this.root(plan);
    const stderr=existsSync(join(root,"stderr")) ? await this.stderrSource(plan) : undefined;
    const messages=existsSync(join(root,"stdout.jsonl")) ? await this.messages(plan) : undefined;
    if (stderr || messages) return {...messages,...(stderr ? {stderr} : {})};
  }

  async output(plan:AgentProcessPlan):Promise<WorkerOutput> {
    const stderr=await this.stderrSource(plan);
    return {...await this.messages(plan),stderr};
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
    const pending=await pendingBridge(root,handle);
    if (pending) return pending;
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
    const archived=await archiveCandidateBundle(this.archive,{repository:plan.job.repositoryPath,remote,baseline,commit,bundle,publicationPath:join(root,"publication.json"),id,allowPublish,parentReceipt:plan.job.parentReceipt});
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

  async revealGate(target:Parameters<ManagedProcessPort["revealGate"]>[0],author:Parameters<ManagedProcessPort["revealGate"]>[1]) {
    const {materials}=author;
    const {owner,location,containerId}=target;
    const current=await this.runtime.location(),instance=await this.runtime.observe(owner);
    if (location.hostId!==current.hostId || location.daemonId!==current.daemonId || instance?.id!==containerId || instance.setupAttempt!==owner.setupAttempt) throw Error("gate sandbox identity changed before reconciliation");
    const root=this.workspaces.root(owner),dest=join(root,"evaluator-materials","author");
    await this.workspaces.withSetupLifetime(owner,async()=>{
      const stage=await mkdtemp(join(root,"gate-author-"));
      try {
        const index=JSON.stringify({manifest:author.manifest,materials:materials.map(({id,digest,file})=>({id,digest,...(file ? {file} : {availability:"reference-only"})}))});
        await writeFile(join(stage,"index.json"),index,{mode:0o444});
        for (const input of materials) {
          if (!input.source || !input.file) continue;
          if (!/^material-[1-9][0-9]*$/.test(input.file)) throw Error("invalid gate material path");
          const out=await open(join(stage,input.file),"wx",0o444),hash=createHash("sha256");
          let size=0;
          try {
            for await (const bytes of input.source.open()) {await out.writeFile(bytes);hash.update(bytes);size+=bytes.length;}
          } finally {await out.close();}
          if (size!==input.source.byteLength || "sha256:"+hash.digest("hex")!==input.digest) throw Error("gate evidence differs from its frozen digest");
        }
        await chmod(stage,0o755);
        try {await rename(stage,dest);}
        catch(error) {
          if (!["ENOTEMPTY","EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "") || !(await lstat(dest)).isDirectory()) throw error;
          const files=(await readdir(stage)).sort();
          if (JSON.stringify(files)!==JSON.stringify((await readdir(dest)).sort())) throw Error("gate reconciliation files changed");
          for (const name of files) {
            const path=join(dest,name);
            if (!(await lstat(path)).isFile()) throw Error("gate reconciliation file replaced");
            const hash=createHash("sha256");
            for await(const bytes of createReadStream(path)) hash.update(bytes);
            const expected=name==="index.json" ? "sha256:"+createHash("sha256").update(index).digest("hex") : materials.find(m=>m.file===name)?.digest;
            if ("sha256:"+hash.digest("hex")!==expected) throw Error("gate reconciliation bytes changed");
          }
        }
      } finally {await rm(stage,{recursive:true,force:true});}
    });
    if (instance.state!=="running") await this.runtime.resume(owner,containerId);
  }

  async quiescent(plan: AgentProcessPlan) {
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

  async stop(plan:AgentProcessPlan,force:boolean) {
    const {owner,containerId,location}=plan.target;
    const bound=await this.runtime.location();
    if(bound.hostId!==location.hostId||bound.daemonId!==location.daemonId)throw new Error("cannot verify stop on a different Docker daemon");
    const current=await this.runtime.observe(owner);
    if(current && current.id!==containerId)throw new Error("runtime identity changed before stop");
    if(current && current.state!=="stopped" && (force || !await this.quiescent(plan))) await this.runtime.stop(owner,containerId);
    if (force) {
      const root=this.root(plan);
      await revokeBridge(root);
      await revokeBridge(join(root,"export"));
    }
  }
}
