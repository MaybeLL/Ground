import {acceptExecution,acquireLease,authorizeBridge,beginExecution,claimRunner,confirmExecutionStopped,digestOf,evaluatorStopped,
  failExecutionInfrastructure,faultGrader,isGradingTerminal,prepareExecution,providerEnded,recordReceipt,registerAgentEvaluator,
  requestExecutionCancel,returnLease,sameRef,refOf,submitGrade,validateGrade,type AgentExecution,type Decision,type Grade,type Result} from "../domain/index.js";
import type {AgentSettings} from "../domain/managed.js";
import type {AgentProvider,WorkerOutput} from "../ports/index.js";
import {fail,fromRejection,succeed} from "./outcome.js";
import type {RequestContext} from "./requests.js";
import {agentGrader} from "./rule-definitions.js";

export class ManagedEvaluators {
  constructor(private readonly ctx:RequestContext,private readonly providers:Record<string,AgentProvider>) {}

  async evidence(id:string,channel:string,ordinal:number) {
    if (!["raw","events","output","stderr"].includes(channel) || !Number.isSafeInteger(ordinal) || ordinal<0) return fail("invalid","select an evaluator stream and chunk ordinal");
    return this.ctx.units.run("read",async r=>{
      const [intent]=await r.intents.listForSubject("evaluator-output","grading_record",id);
      if (!intent) return fail("not-found","evaluator output has not been frozen");
      const record=intent.payload as {executionId:string;trace:import("../domain/index.js").FrozenTrace;output:import("../ports/index.js").EvidenceRef;stderr:import("../ports/index.js").EvidenceRef};
      const ref=channel==="raw" ? record.trace.raw : channel==="events" ? record.trace.events : channel==="output" ? record.output : record.stderr;
      if (ordinal>=ref.chunkCount) return fail("not-found","chunk is outside this stream");
      const bytes=await r.evidence.chunk(ref.digest,ordinal);
      return bytes ? succeed({gradingId:id,executionId:record.executionId,stream:channel,ordinal,ref,bytes}) : fail("unavailable","evaluator evidence chunk is missing");
    });
  }

  async reserve(id:string,live:boolean) {
    return this.ctx.units.run("write",async r=>{
      const g=await r.gradings.get(id,{lock:true});
      const revision=g && await r.definitions.getRevision(g.graderRevision.definitionId,g.graderRevision.revisionId);
      const config=revision && agentGrader(revision.content);
      const sandbox=g?.sandboxId && await r.sandboxes.get(g.sandboxId,{lock:true});
      if (!g || isGradingTerminal(g) || !config || !sandbox || sandbox.owner.type!=="grading_record" || sandbox.owner.id!==id || !sandbox.runtime) return fail("conflict","evaluator sandbox is not ready");
      const agent=await r.definitions.getRevision(config.agent.definitionId,config.agent.revisionId);
      const settings=agent?.content as AgentSettings|undefined;
      if (!agent || !sameRef(refOf(agent),config.agent) || !settings || !Object.hasOwn(this.providers,settings.provider)) return fail("conflict","evaluator agent revision is unavailable");
      if (g.evaluator?.kind==="agent") {
        const exec=await r.executions.get(g.evaluator.executionId);
        if (!exec || exec.owner.type!=="grading_record" || exec.owner.id!==id || !sandbox.lease || !authorizeBridge(sandbox,{holder:{type:"agent_execution",id:exec.id},token:sandbox.lease.token}).ok) return fail("conflict","evaluator execution no longer owns its sandbox");
        return succeed({exec,settings});
      }
      if (!live || g.cancelIntent) return succeed(null);
      const at=this.ctx.now(),executionId=this.ctx.newId();
      const created=acceptExecution({id:executionId,role:"evaluator",owner:{type:"grading_record",id},agentRevision:config.agent,capabilities:{...this.providers[settings.provider]!.capabilities,verifiableStop:true},at});
      if (!created.ok) return fromRejection(created.error);
      const prepared=prepareExecution(created.value.state,{sandboxId:sandbox.id,at});
      if (!prepared.ok) return fromRejection(prepared.error);
      const claimed=claimRunner(prepared.value.state,{runnerId:"grader-"+executionId,at});
      if (!claimed.ok) return fromRejection(claimed.error);
      const attached=registerAgentEvaluator(g,{executionId,at});
      if (!attached.ok) return fromRejection(attached.error);
      const leased=acquireLease(sandbox,{holder:{type:"agent_execution",id:executionId},at});
      if (!leased.ok) return fromRejection(leased.error);
      await r.executions.create(created.value.state);
      await r.executions.save(prepared.value.state,created.value.state.version);
      await r.executions.save(claimed.value.state,prepared.value.state.version);
      await r.sandboxes.save(leased.value.state,sandbox.version);
      await r.gradings.save(attached.value.state,g.version);
      return succeed({exec:claimed.value.state,settings});
    });
  }

  async begin(id:string,executionId:string,handle:string) {
    return this.ctx.units.run("write",async r=>{
      const grading=await r.gradings.get(id,{lock:true}),exec=await r.executions.get(executionId,{lock:true});
      if (!exec?.runner || grading?.evaluator?.kind!=="agent" || grading.evaluator.executionId!==exec.id || grading.cancelIntent) return fail("conflict","evaluator start authority changed");
      if (exec.sessionRef) return exec.sessionRef===handle ? succeed({}) : fail("conflict","evaluator process identity changed");
      const started=beginExecution(exec,{runnerId:exec.runner.id,sessionRef:handle,at:this.ctx.now()});
      if (!started.ok) return fromRejection(started.error);
      await r.executions.save(started.value.state,exec.version);
      return succeed({});
    });
  }

  /** Called after process stop has been observed. Record bytes, result,
   * runner stop and returned lease together, including on cancellation. */
  async finish(id:string,executionId:string,output?:WorkerOutput,exitCode?:number,infrastructure?:string) {
    return this.ctx.units.run("write",async r=>{
      const g=await r.gradings.get(id,{lock:true}),exec=await r.executions.get(executionId,{lock:true});
      if (!exec || g?.evaluator?.kind!=="agent" || g.evaluator.executionId!==exec.id) return fail("conflict","evaluator identity changed");
      if (isGradingTerminal(g)) return succeed({});
      const sb=g.sandboxId && await r.sandboxes.get(g.sandboxId,{lock:true});
      const holder={type:"agent_execution" as const,id:exec.id};
      if (!sb || !sb.lease || !authorizeBridge(sb,{holder,token:sb.lease.token}).ok) return fail("conflict","evaluator lease changed");
      const at=this.ctx.now(),states:AgentExecution[]=[];
      let state=exec, grade:Grade|undefined;
      const advance=(result:Result<Decision<AgentExecution,unknown,unknown>>)=>{
        if (!result.ok) throw new Error(result.error.message);
        if (state!==result.value.state) {state=result.value.state;states.push(state);}
      };
      if (output) {
        advance(providerEnded(state,{at,outcome:exitCode===0 && !output.providerFailed ? "succeeded" : "failed"}));
        advance(recordReceipt(state,{kind:"output",ref:"sql-evidence:"+output.output.digest,at}));
        advance(recordReceipt(state,{kind:"trajectory",ref:"sql-evidence:"+output.trace.raw.digest,at}));
        if (state.providerOutcome==="succeeded") try {
          const value=JSON.parse(output.message)?.grade;
          if (value && typeof value==="object" && validateGrade(value,g.scale).ok) {
            if (value.form==="numeric") grade={form:"numeric",value:value.value};
            else if (value.form==="category") grade={form:"category",category:value.category};
            else if (value.form==="indeterminate") grade={form:"indeterminate",reason:value.reason};
          }
        } catch { /* Invalid provider output is a grader fault. */ }
      }
      if (g.cancelIntent) advance(requestExecutionCancel(state,{at}));
      else if (infrastructure) advance(failExecutionInfrastructure(state,{detail:infrastructure,at}));
      advance(confirmExecutionStopped(state,{at}));
      const stopped=evaluatorStopped(g,{at});
      if (!stopped.ok) return fromRejection(stopped.error);
      const next=stopped.value.state;
      const ended=isGradingTerminal(next) ? undefined : grade ? submitGrade(next,{grade,at}) : faultGrader(next,{detail:infrastructure ?? "evaluator did not return a valid grade",at});
      if (ended && !ended.ok) return fromRejection(ended.error);
      const released=returnLease(sb,{holder,token:sb.lease.token,stop:"verified",at});
      if (!released.ok) return fromRejection(released.error);
      if (output) {
        const body=await r.evidence.put(output.output),stderr=await r.evidence.put(output.stderr);
        await r.evidence.put(output.trace.raw);await r.evidence.put(output.trace.events);
        const payload={executionId:exec.id,trace:output.trace.descriptor,output:body,stderr};
        const digest=digestOf(payload,this.ctx.hash);
        if (!digest.ok) throw new Error(digest.error.message);
        await r.intents.register({kind:"evaluator-output",id:this.ctx.newId(),requestId:"evaluator-output-"+exec.id,requestHash:digest.value,subject:{type:"grading_record",id},payload,state:"completed",result:{},version:1,createdAt:at,updatedAt:at});
      }
      let version=exec.version;
      for(const step of states){await r.executions.save(step,version);version=step.version;}
      await r.sandboxes.save(released.value.state,sb.version);
      await r.gradings.save(next,g.version);
      if (ended?.ok) await r.gradings.save(ended.value.state,next.version);
      return succeed({});
    });
  }
}
