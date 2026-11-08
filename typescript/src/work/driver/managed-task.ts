import { isTerminal } from "../domain/index.js";
import type { ManagedProcessPort, ProcessPlan, WorkerTarget } from "../ports/index.js";
import { fail, succeed, type Outcome } from "../application/outcome.js";
import type { ManagedWorkers, ManagedContext } from "../application/managed-workers.js";
import type { SandboxProvisioning } from "../application/sandbox-provisioning.js";
import type { SandboxLifecycle } from "../application/sandbox-lifecycle.js";

export type DriveState = "running" | "blocked" | "awaiting-resume" | "terminal";
type Deps = {workers:ManagedWorkers;sandboxes:SandboxProvisioning;lifecycle:SandboxLifecycle;process:ManagedProcessPort;ledgerId():Promise<string>};

function taskPrompt(context:ManagedContext):string {
  return JSON.stringify({task:context.task.summary,criteria:context.task.criteria,context:context.task.context??"",outputContract:{
    type:"coding",instructions:"Implement the task in the current Git checkout. Commit the delivery locally. Return a final JSON object with candidate.commit equal to its full Git commit ID.",
    example:{candidate:{commit:"<full commit ID>"}},
  }});
}
function declaredCommit(text:string) {
  try {
    const parsed=JSON.parse(text.trim()) as {candidate?:{commit?:unknown}};
    const oid=parsed?.candidate?.commit;
    return typeof oid==="string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ? oid : undefined;
  } catch{return undefined;}
}

export class ManagedTaskDriver {
  constructor(private readonly deps:Deps) {}

  async drive(runId:string,allowStart:boolean):Promise<Outcome<{state:DriveState;detail?:string}>> {
    const result=await this.deps.workers.context(runId);
    if(!result.ok)return result;
    const ctx=result.value;
    if(isTerminal(ctx.run) && ["failed","cancelled","succeeded","interrupted"].includes(ctx.exec.stage)){
      const settled=await this.deps.lifecycle.settleRun(runId);
      return settled.ok ? succeed({state:"terminal"}) : settled;
    }
    if(!ctx.sandbox?.runtime || !ctx.sandbox.location) {
      if(isTerminal(ctx.run) || ctx.run.cancelIntent) {
        const done=await this.deps.workers.infrastructure(runId,"run ended before worker launch",false);
        return done.ok ? succeed({state:"terminal"}) : done;
      }
      const sandbox=allowStart ? await this.deps.sandboxes.prepare("managed-prepare-"+ctx.exec.id,runId,ctx.job.repositoryPath) : await this.deps.sandboxes.reconcile(runId);
      if(!sandbox.ok) {
        const refreshed=await this.deps.workers.context(runId);
        if(refreshed.ok && isTerminal(refreshed.value.run)) {
          const done=await this.deps.workers.infrastructure(runId,refreshed.value.run.failure?.detail??"sandbox preparation failed",false);
          return done.ok ? succeed({state:"terminal"}) : done;
        }
        return succeed({state:allowStart?"blocked":"awaiting-resume",detail:sandbox.error.message});
      }
      return this.drive(runId,allowStart);
    }
    const owner={ledgerId:await this.deps.ledgerId(),sandboxId:ctx.sandbox.id};
    const target:WorkerTarget={owner,location:ctx.sandbox.location,containerId:ctx.sandbox.runtime.instanceId};
    const plan:ProcessPlan={job:ctx.job,target,agent:ctx.agent,prompt:taskPrompt(ctx)};
    if(ctx.run.cancelIntent || isTerminal(ctx.run)) {
      if(ctx.job.dockerExecId)await this.deps.process.stop(plan,true);
      const done=await this.deps.workers.infrastructure(runId,"managed worker cancelled",true);
      return done.ok ? succeed({state:"terminal"}) : done;
    }
    if(!ctx.job.dockerExecId && !allowStart)return succeed({state:"awaiting-resume",detail:"worker has not started"});
    const runner="worker-"+ctx.exec.id;
    const reserved=await this.deps.workers.reserve(runId,runner,owner.ledgerId);
    if(!reserved.ok)return reserved;
    let handle=ctx.job.dockerExecId;
    if(!handle){
      try {handle=await this.deps.process.handle(plan,allowStart);}
      catch {
        // The Engine cannot start an exec until its ID has been persisted
        // and begin() grants the runner permission to start it.
        const done=await this.deps.workers.infrastructure(runId,"worker process could not be created",true);
        return done.ok ? succeed({state:"terminal"}) : done;
      }
      if(!handle)return succeed({state:"awaiting-resume"});
      const begun=await this.deps.workers.begin(runId,runner,handle);
      if(!begun.ok)return begun;
    }
    const observed=await this.deps.process.drive(plan,handle,allowStart);
    if(observed.state==="running" || observed.state==="awaiting-resume")return succeed({state:observed.state,detail:observed.detail});
    if(observed.state==="interrupted"){
      await this.deps.process.stop(plan,true);
      const done=await this.deps.workers.infrastructure(runId,observed.detail,true,true);
      return done.ok ? succeed({state:"terminal"}) : done;
    }
    if(observed.state!=="complete")return fail("unavailable","provider execution has no observable result");
    const captured=await this.deps.process.output(plan);
    try {
      const commit=declaredCommit(captured.message);
      let candidate:{id:string;receipt:string}|undefined,rejected=false;
      if(commit){
        if(!ctx.baseline)return fail("conflict","managed workspace baseline is missing");
        const published=await this.deps.process.candidate(plan,commit,ctx.baseline,ctx.task.repository.remote);
        if(published.status==="unavailable")return succeed({state:"blocked",detail:published.reason});
        if(published.status==="confirmed")candidate={id:published.id,receipt:published.receipt};else rejected=true;
      }
      await this.deps.process.stop(plan,false);
      const ended=await this.deps.workers.finish(runId,handle,captured.trace,captured.output,captured.stderr,observed.exitCode===0 && !captured.providerFailed ? "succeeded" : "failed",candidate,rejected);
      return ended.ok ? succeed({state:"terminal"}) : ended;
    } finally {await captured.trace.dispose();}
  }
}
