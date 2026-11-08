import { acquireLease, authorizeBridge, beginExecution, claimRunner, concludeRound, confirmExecutionStopped, digestOf,
  blockArchive, retryArchive, executionHostLost, interruptExecution, failExecutionInfrastructure, failInfrastructure, isExecutionTerminal, isTerminal, prepareExecution, providerEnded, recordReceipt, registerManagedWorker, requestExecutionCancel,
  returnLease, start, submitManifest, workerStopped, type AgentExecution, type Decision, type FrozenTrace, type Result, type Sandbox, type TaskRun } from "../domain/index.js";
import type { CapturedTrace, EvidenceSource, WorkRepositories } from "../ports/index.js";
import type { AgentSettings, ManagedTask } from "./agent-definitions.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";
import type { SandboxLifecycle } from "./sandbox-lifecycle.js";

type Dispatch = ManagedTask & { trace?:FrozenTrace; observation?:{state:string;detail?:string}; dockerExecId?: string; runnerId?: string; token?: number };
export type ManagedContext = { job:Dispatch; intentId:string; sandbox?:Sandbox; baseline?:string; exec:AgentExecution; run:TaskRun; agent:AgentSettings; task: {summary:string;criteria:{id:string;statement:string}[];context?:string;repository:{baseline:string;remote:string}} };
type ManagedDeps = RequestContext & { lifecycle:SandboxLifecycle };
export type ManagedResult = { runId:string;executionId:string;stage:AgentExecution["stage"];status:TaskRun["status"] };

export class ManagedWorkers {
  constructor(private readonly deps:ManagedDeps) {}

  private async job(r:WorkRepositories,runId:string) {
    return (await r.intents.listForSubject("managed-worker","task_run",runId))[0];
  }

  async context(runId:string): Promise<Outcome<ManagedContext>> {
    return this.deps.units.run("read",async r=>{
      const intent=await this.job(r,runId);
      const run=await r.taskRuns.get(runId);
      if (!intent || !run) return fail("not-found","no managed worker for this run");
      const job=intent.payload as Dispatch, exec=await r.executions.get(job.executionId);
      if (!exec) return fail("conflict","managed worker record is missing");
      const agent=await r.definitions.getRevision(exec.agentRevision.definitionId,exec.agentRevision.revisionId);
      const task=await r.definitions.getRevision(run.taskRevision.definitionId,run.taskRevision.revisionId);
      if (!agent || !task) return fail("conflict","managed definitions are missing");
      const sandbox = run.sandboxId ? await r.sandboxes.get(run.sandboxId) : undefined;
      const reservation = sandbox && (await r.intents.listForSubject("reserve-task-sandbox","task_run",runId))[0];
      const baseline = (reservation?.result as {commit?:string}|undefined)?.commit;
      return succeed({job,intentId:intent.id,run,exec,...(sandbox?{sandbox}:{}),...(baseline?{baseline}:{}),agent:agent.content as AgentSettings,task:task.content as ManagedContext["task"]});
    });
  }

  resume(runId: string, requestId: string) {
    return once(this.deps, {requestId, kind: "resume-managed", input: {runId}, subject: {type: "task_run", id: runId}}, async r => {
      const intent = await this.job(r, runId);
      if (!intent) return fail("not-found", "managed work does not exist");
      return succeed({runId, executionId: (intent.payload as Dispatch).executionId});
    });
  }

  async note(runId:string,state:string,detail?:string) {
    return this.deps.units.run("write",async r=>{
      const intent=await this.job(r,runId);
      if(!intent || intent.state==="completed")return;
      const job=intent.payload as Dispatch;
      if(job.observation?.state===state && job.observation.detail===detail)return;
      await r.intents.save({...intent,payload:{...job,observation:{state,...(detail?{detail}:{})}},updatedAt:this.deps.now(),version:intent.version+1},intent.version);
    });
  }

  /** Reserve the worker before creating a Docker exec. A replay may inspect
   * the recorded handle but never creates a second provider process. */
  async reserve(runId:string,runnerId:string,ledgerId:string) {
    return this.deps.units.run("write",async r=>{
      const intent=await this.job(r,runId);
      const run=await r.taskRuns.get(runId,{lock:true});
      if (!intent || !run?.sandboxId) return fail("conflict","sandbox must be prepared before the worker starts");
      const sb=await r.sandboxes.get(run.sandboxId,{lock:true}), job=intent.payload as Dispatch;
      const exec=await r.executions.get(job.executionId,{lock:true});
      if (!sb?.runtime || !sb.location || !exec || sb.owner.type!=="task_run" || sb.owner.id!==runId || run.cancelIntent || exec.cancelIntent || isTerminal(run)) return fail("conflict","worker cannot acquire this sandbox");
      const at=this.deps.now(),holder={type:"agent_execution" as const,id:exec.id};
      if (job.runnerId) {
        if (job.runnerId!==runnerId || job.token===undefined || !authorizeBridge(sb,{holder,token:job.token}).ok) return fail("conflict","runner does not own the current lease");
      } else {
        const lease=acquireLease(sb,{holder,at});
        if (!lease.ok) return fromRejection(lease.error);
        const prepared=prepareExecution(exec,{sandboxId:sb.id,at});
        if (!prepared.ok) return fromRejection(prepared.error);
        const claimed=claimRunner(prepared.value.state,{runnerId,at});
        if (!claimed.ok) return fromRejection(claimed.error);
        await r.sandboxes.save(lease.value.state,sb.version);
        await r.executions.save(prepared.value.state,exec.version);
        await r.executions.save(claimed.value.state,prepared.value.state.version);
        job.token=lease.value.state.lease!.token; job.runnerId=runnerId;
        await r.intents.save({...intent,payload:job,updatedAt:at,version:intent.version+1},intent.version);
      }
      return succeed({containerId:sb.runtime.instanceId,location:sb.location,owner:{ledgerId,sandboxId:sb.id},token:job.token!,executionId:exec.id});
    });
  }

  async begin(runId:string,runnerId:string,dockerExecId:string) {
    return this.deps.units.run("write",async r=>{
      const intent=await this.job(r,runId),run=await r.taskRuns.get(runId,{lock:true});
      if (!intent || !run?.sandboxId || isTerminal(run) || run.cancelIntent) return fail("conflict","managed run is closed to process starts");
      const job=intent.payload as Dispatch, sb=await r.sandboxes.get(run.sandboxId,{lock:true});
      const exec=await r.executions.get(job.executionId,{lock:true});
      if (!exec || !sb || job.runnerId!==runnerId || job.token===undefined || !authorizeBridge(sb,{holder:{type:"agent_execution",id:exec.id},token:job.token}).ok) return fail("forbidden","worker lease no longer belongs to the runner");
      if (job.dockerExecId) return job.dockerExecId===dockerExecId ? succeed({executionId:exec.id}) : fail("conflict","a different Docker execution was registered");
      const at=this.deps.now(),begun=beginExecution(exec,{runnerId,at});
      if (!begun.ok) return fromRejection(begun.error);
      const started=start(run,{at}); if(!started.ok) return fromRejection(started.error);
      const registered=registerManagedWorker(started.value.state,{executionId:exec.id,at});
      if(!registered.ok) return fromRejection(registered.error);
      await r.executions.save(begun.value.state,exec.version);
      await r.taskRuns.save(started.value.state,run.version);await r.taskRuns.save(registered.value.state,started.value.state.version);
      await r.intents.save({...intent,payload:{...job,dockerExecId},updatedAt:at,version:intent.version+1},intent.version);
      return succeed({executionId:exec.id});
    });
  }

  /** Commit the original provider result before any remote publication. */
  async freezeOutput(runId: string, handle: string, trace: CapturedTrace, output: EvidenceSource, stderr: EvidenceSource, outcome: "succeeded" | "failed") {
    return this.deps.units.run("write", async r => {
      const intent = await this.job(r, runId);
      if (!intent) return fail("not-found", "managed intent is missing");
      const job = intent.payload as Dispatch;
      const exec = await r.executions.get(job.executionId, {lock: true});
      if (!exec || job.dockerExecId !== handle || exec.cancelIntent) return fail("conflict", "worker identity or cancellation changed");
      if (job.trace) {
        return exec.providerOutcome === outcome && job.trace.raw.digest === trace.raw.digest &&
          exec.receipts.output === "sql-evidence:" + output.digest ? succeed({}) : fail("conflict", "captured worker result changed");
      }
      const at = this.deps.now();
      const ended = providerEnded(exec, {outcome, at});
      if (!ended.ok) return fromRejection(ended.error);
      const message = recordReceipt(ended.value.state, {kind: "output", ref: "sql-evidence:" + output.digest, at});
      if (!message.ok) return fromRejection(message.error);
      const trajectory = recordReceipt(message.value.state, {kind: "trajectory", ref: "sql-evidence:" + trace.raw.digest, at});
      if (!trajectory.ok) return fromRejection(trajectory.error);
      const text = await r.evidence.put(output), errors = await r.evidence.put(stderr);
      await r.evidence.put(trace.raw);
      await r.evidence.put(trace.events);
      await r.executions.save(ended.value.state, exec.version);
      await r.executions.save(message.value.state, ended.value.state.version);
      await r.executions.save(trajectory.value.state, message.value.state.version);
      await r.intents.save({...intent, payload: {...job, trace: trace.descriptor, output: text, stderr: errors},
        updatedAt: at, version: intent.version + 1}, intent.version);
      return succeed({});
    });
  }

  async archiveUnavailable(runId: string, reason: string) {
    return this.deps.units.run("write", async r => {
      const intent = await this.job(r, runId);
      if (!intent) return fail("not-found", "managed intent is missing");
      const exec = await r.executions.get((intent.payload as Dispatch).executionId, {lock: true});
      if (!exec) return fail("not-found", "execution is missing");
      if (exec.stage === "archive_blocked") return succeed({});
      const at = this.deps.now();
      const blocked = blockArchive(exec, {reason: reason.slice(0, 1024), at});
      if (!blocked.ok) return fromRejection(blocked.error);
      const stopped = confirmExecutionStopped(blocked.value.state, {at});
      if (!stopped.ok) return fromRejection(stopped.error);
      await r.executions.save(blocked.value.state, exec.version);
      await r.executions.save(stopped.value.state, blocked.value.state.version);
      return succeed({});
    });
  }

  async finish(runId:string,dockerExecId:string,trace:CapturedTrace,output:EvidenceSource,stderr:EvidenceSource,outcome:"succeeded"|"failed",candidate?:{id:string;receipt:string},rejected=false):Promise<Outcome<ManagedResult>> {
    const result=await this.deps.units.run("write",async r=>{
      const intent=await this.job(r,runId),run=await r.taskRuns.get(runId,{lock:true});
      if(!intent||!run?.sandboxId) return fail("not-found","managed run is missing");
      if(intent.state==="completed") return succeed(intent.result as ManagedResult);
      const job=intent.payload as Dispatch,exec=await r.executions.get(job.executionId,{lock:true}),sb=await r.sandboxes.get(run.sandboxId,{lock:true});
      if(!exec||!sb||job.dockerExecId!==dockerExecId||job.token===undefined) return fail("conflict","managed completion does not match its process and sandbox");
      const holder={type:"agent_execution" as const,id:exec.id};
      const authorized=authorizeBridge(sb,{holder,token:job.token});
      if(!authorized.ok) return fromRejection(authorized.error);
      const at=this.deps.now();
      const archive={digest:output.digest,byteLength:output.byteLength,chunkCount:Math.ceil(output.byteLength/65536)};
      let state=exec;
      // Returning an unsuccessful decision after a save would commit a
      // partial chain. Compute all decisions before persisting any state.
      const steps:AgentExecution[]=[];
      const step=(decision:Result<Decision<AgentExecution,unknown,unknown>>) => {
        if(!decision.ok) throw new Error(decision.error.message);
        if(decision.value.state!==state){state=decision.value.state;steps.push(state);}
      };
      if (state.stage === "archive_blocked") step(retryArchive(state, {at}));
      step(providerEnded(state,{outcome,at}));
      step(recordReceipt(state,{kind:"output",ref:"sql-evidence:"+archive.digest,at}));
      step(recordReceipt(state,{kind:"trajectory",ref:"sql-evidence:"+trace.descriptor.raw.digest,at}));
      if(candidate) step(recordReceipt(state,{kind:"delivery-claim",ref:candidate.receipt,at}));
      if (!isExecutionTerminal(state)) step(confirmExecutionStopped(state,{at}));
      const lease=returnLease(sb,{holder,token:job.token,stop:"verified",at}); if(!lease.ok)return fromRejection(lease.error);
      const stopped=workerStopped(run,{outcome,at});if(!stopped.ok)return fromRejection(stopped.error);
      let final=stopped.value.state;
      if(!isTerminal(final)){
        if (rejected) {
          const denied=submitManifest(final,{operationId:"managed-delivery-"+exec.id,origin:"contract",check:"rejected",at});
          if (!denied.ok)return fromRejection(denied.error); final=denied.value.state;
        } else if(candidate) {
          const items=[{type:"candidate" as const,...candidate}];
          const digest=digestOf(items,this.deps.hash); if(!digest.ok)return fromRejection(digest.error);
          const manifest=submitManifest(final,{operationId:"managed-delivery-"+exec.id,origin:"contract",check:"accepted",items,digest:digest.value,trajectoryReceipt:state.receipts.trajectory!,at});
          if(!manifest.ok)return fromRejection(manifest.error); final=manifest.value.state;
        } else {
          const concluded=concludeRound(final,{at});if(!concluded.ok)return fromRejection(concluded.error);final=concluded.value.state;
        }
      }
      const errors=await r.evidence.put(stderr);
      await r.evidence.put(output);await r.evidence.put(trace.raw);await r.evidence.put(trace.events);
      let version=exec.version;for(const s of steps){await r.executions.save(s,version);version=s.version;}
      await r.sandboxes.save(lease.value.state,sb.version);
      await r.taskRuns.save(stopped.value.state,run.version);
      if(final!==stopped.value.state)await r.taskRuns.save(final,stopped.value.state.version);
      const completed={runId,executionId:exec.id,stage:state.stage,status:final.status};
      await r.intents.save({...intent,state:"completed",payload:{...job,observation:{state:"terminal"},trace:trace.descriptor,output:archive,stderr:errors},result:completed,updatedAt:at,version:intent.version+1},intent.version);
      await r.events.append({id:"managed-done-"+exec.id,parentIntentId:intent.id,type:"worker-ended",subject:{type:"execution",id:exec.id},payload:completed,createdAt:at,deliveredAt:at});
      return succeed(completed);
    });
    if(result.ok) {
      const settled=await this.deps.lifecycle.settleRun(runId);
      if(!settled.ok)return settled;
    }
    return result;
  }
  async infrastructure(runId:string,detail:string,verifiedStop:boolean,interrupted=false) {
    const result=await this.deps.units.run("write",async r=>{
      const intent=await this.job(r,runId),run=await r.taskRuns.get(runId,{lock:true});
      if(!intent || !run)return fail("not-found","managed work does not exist");
      if(intent.state==="completed")return succeed(intent.result as ManagedResult);
      const job=intent.payload as Dispatch,exec=await r.executions.get(job.executionId,{lock:true});
      if(!exec)return fail("conflict","execution is missing");
      let e=exec,current=run;
      const at=this.deps.now();
      if (interrupted && !isExecutionTerminal(e) && e.runner) {
        const lost = executionHostLost(e, {at});
        if (!lost.ok) return fromRejection(lost.error);
        await r.executions.save(lost.value.state, e.version);
        e = lost.value.state;
      }
      if(e.stop!=="idle" && e.stop!=="verified"){
        if(!verifiedStop)throw new Error("process stop is unknown");
        const stopped=confirmExecutionStopped(e,{at});
        if(!stopped.ok)throw new Error(stopped.error.message);
        await r.executions.save(stopped.value.state,e.version);e=stopped.value.state;
      }
      if(current.worker?.kind==="managed" && current.worker.stop!=="verified" && !isTerminal(current)){
        const stopped=workerStopped(current,{outcome:"failed",at});
        if(!stopped.ok)throw new Error(stopped.error.message);
        await r.taskRuns.save(stopped.value.state,current.version);current=stopped.value.state;
      }
      if(current.sandboxId && job.token!==undefined) {
        const sb=await r.sandboxes.get(current.sandboxId,{lock:true});
        if(sb?.lease) {
          const returned=returnLease(sb,{holder:{type:"agent_execution",id:e.id},token:job.token,stop:"verified",at});
          if(!returned.ok)throw new Error(returned.error.message);
          await r.sandboxes.save(returned.value.state,sb.version);
        }
      }
      if(!isExecutionTerminal(e)){
        const ended=run.cancelIntent || run.status==="cancelled" ? requestExecutionCancel(e,{at}) : interrupted ? interruptExecution(e,{at}) : failExecutionInfrastructure(e,{detail,at});
        if(!ended.ok)throw new Error(ended.error.message);
        await r.executions.save(ended.value.state,e.version);e=ended.value.state;
      }
      if(!isTerminal(current)){
        const failed=failInfrastructure(current,{detail,at});if(!failed.ok)throw new Error(failed.error.message);
        await r.taskRuns.save(failed.value.state,current.version);current=failed.value.state;
      }
      const done={runId,executionId:e.id,status:current.status,stage:e.stage};
      await r.intents.save({...intent,state:"completed",payload:{...job,observation:{state:"terminal",detail}},result:done,updatedAt:at,version:intent.version+1},intent.version);
      await r.events.append({id: "managed-done-" + e.id, parentIntentId: intent.id, type: "worker-ended",
        subject: {type: "execution", id: e.id}, payload: done, createdAt: at, deliveredAt: at});
      return succeed(done);
    });
    if(result.ok){const settled=await this.deps.lifecycle.settleRun(runId);if(!settled.ok)return settled;}
    return result;
  }

}
