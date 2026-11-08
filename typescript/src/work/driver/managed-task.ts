import {parseManagedDeclaration} from "../domain/managed-delivery.js";
import type {CapturedArtifacts} from "../ports/index.js";
import { isTerminal } from "../domain/index.js";
import type { ManagedProcessPort, ProcessPlan, WorkerTarget } from "../ports/index.js";
import { fail, succeed, type Outcome } from "../application/outcome.js";
import type { ManagedWorkers, ManagedContext } from "../application/managed-workers.js";
import type { SandboxProvisioning } from "../application/sandbox-provisioning.js";
import type { ArchiveRepairs } from "../application/archive-repairs.js";
import type { SandboxLifecycle } from "../application/sandbox-lifecycle.js";

type DriveObservation = {state: DriveState; detail?: string; providerStopped?: boolean};
export type DriveState = "running" | "blocked" | "awaiting-resume" | "terminal";
type Deps = {repairs: ArchiveRepairs; workers:ManagedWorkers;sandboxes:SandboxProvisioning;lifecycle:SandboxLifecycle;process:ManagedProcessPort;ledgerId():Promise<string>};

function taskPrompt(context:ManagedContext):string {
  return JSON.stringify({task:context.task.summary,criteria:context.task.criteria,...(context.task.materialRepositories?.length ? {materials:context.task.materialRepositories.map(({name,commit})=>({name,commit,path:"/grounds-materials/"+name}))} : {}),...(context.run.refines ? {refinement:{parentRunId:context.run.refines,baseCommit:context.job.baseline,workspace:context.run.environment?.source==="inherited"?"retained":"fresh"}} : {}),context:context.task.context??"",outputContract:{
    ...(context.task.outputs?.length ? {slots:context.task.outputs,artifacts:"Return artifacts as an array of {slot,files:[{path,source}]}. Source files must be regular files relative to this workspace; path is the name inside the archived artifact."} : {}),
    ...(context.task.kind==="working" ? {type:"working",instructions:"Write files in the current output directory. Declare the artifact slots and relative files in a final JSON object. Read selected material repositories under /grounds-materials."} :
      {type:"coding",instructions:"Implement the task in the current Git checkout. Commit the delivery locally. Return a final JSON object with candidate.commit equal to its full Git commit ID.",example:{candidate:{commit:"<full commit ID>"}}}),

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

  async drive(runId:string,allowStart:boolean):Promise<Outcome<DriveObservation>> {
    const result=await this.deps.workers.context(runId);
    if(!result.ok)return result;
    const ctx=result.value;
    if(isTerminal(ctx.run) && ["failed","cancelled","succeeded","interrupted"].includes(ctx.exec.stage)){
      const settled=await this.deps.lifecycle.settleRun(runId);
      return settled.ok ? succeed({state:"terminal"}) : settled;
    }
    if (ctx.sandbox?.reservation?.kind === "transfer") {
      const done = await this.deps.lifecycle.completeTransfer(runId, allowStart && !ctx.run.cancelIntent);
      if (!done.ok) return succeed({state: allowStart ? "blocked" : "awaiting-resume", detail: done.error.message});
      return done.value === "preparing" ? succeed({state: "running", detail: "awaiting retained setup shutdown"}) : this.drive(runId, allowStart);
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
      const done=await this.deps.workers.infrastructure(runId,ctx.run.failure?.detail ?? "managed worker cancelled",true);
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
    if (ctx.job.trace) return this.publish(ctx, plan, handle, allowStart);
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
      const declaration=parseManagedDeclaration(captured.message,ctx.task.kind,ctx.task.outputs ?? []);
      const commit=declaration?.commit ?? (!ctx.task.outputs?.length && ctx.task.kind==="coding" ? declaredCommit(captured.message) : undefined);
      let rejected = !!ctx.task.outputs?.length && !declaration;
      const outcome = observed.exitCode === 0 && !captured.providerFailed ? "succeeded" : "failed";
      if (commit) {
        if (!ctx.baseline) return fail("conflict", "managed workspace baseline is missing");
        const exported = await this.deps.process.exportCandidate(plan, commit, allowStart);
        if (exported === "running") return succeed({state: exported});
        if (exported === "awaiting-resume") {
          return succeed({state: exported, providerStopped: await this.deps.process.quiescent(plan), detail: "candidate export requires an explicit resume"});
        }
        if (exported === "interrupted") {
          await this.deps.process.stop(plan, true);
          const ended = await this.deps.workers.infrastructure(runId, "bundle export was interrupted without a verified result", true);
          return ended.ok ? succeed({state: "terminal"}) : ended;
        }
        rejected = exported === "invalid";
      }
      await this.deps.process.stop(plan, false);
      let artifacts:CapturedArtifacts|undefined;
      try {
        if (!rejected && declaration?.artifacts.length) {
          try {artifacts=await this.deps.process.artifacts(plan,declaration.artifacts);}
          catch (error) {
            const code=(error as NodeJS.ErrnoException).code;
            if (!["ENOENT","ENOTDIR","ELOOP","EINVAL","ENXIO","ENAMETOOLONG","VALIDATION_ERROR","EACCES"].includes(code ?? "")) throw error;
            rejected=true;
          }
        }
        const frozen = await this.deps.workers.freezeOutput(runId, handle, captured.trace, captured.output, captured.stderr, outcome, commit, rejected,artifacts?.entries);
        if (!frozen.ok) return frozen;
      } finally {await artifacts?.dispose();}
      return this.drive(runId, allowStart);
    } finally {await captured.trace.dispose();}
  }

  private async publish(ctx: ManagedContext, plan: ProcessPlan, handle: string, allowPublish: boolean): Promise<Outcome<DriveObservation>> {
    const commit = ctx.job.claim;
    let candidate: {id:string;receipt:string} | undefined;
    let rejected = ctx.job.rejected === true;
    if (commit && !rejected) {
      if (!ctx.baseline || !ctx.job.remote) return fail("conflict", "managed baseline or remote is missing");
      let published;
      try {
        const parent = ctx.job.parentCandidate;
        const current = parent && await this.deps.repairs.current(parent.runId, parent, ctx.job.repositoryPath);
        const source = current ? {...plan, job: {...plan.job, parentReceipt: current.receipt}} : plan;
        published = await this.deps.process.candidate(source, commit, ctx.baseline, ctx.job.remote, allowPublish);
      }
      catch { published = {status: "unavailable" as const, reason: "the frozen candidate archive is temporarily unavailable"}; }
      if (published.status === "unavailable") {
        const blocked = await this.deps.workers.archiveUnavailable(ctx.run.id, published.reason);
        return blocked.ok ? succeed({state: "blocked", detail: published.reason}) : blocked;
      }
      if (published.status === "confirmed") candidate = {id: published.id, receipt: published.receipt};
      else rejected = true;
    }
    const ended = await this.deps.workers.finish(ctx.run.id, handle, candidate, rejected);
    return ended.ok ? succeed({state: "terminal"}) : ended;
  }

}
