import {acceptExecution,acquireLease,authorizeBridge,beginExecution,claimRunner,confirmExecutionStopped,digestOf,evaluatorStopped,
  failExecutionInfrastructure,faultGrader,isExecutionTerminal,isGradingTerminal,prepareExecution,providerEnded,recordReceipt,recordProtocolStage,registerAgentEvaluator,
  requestExecutionCancel,returnLease,sameRef,refOf,submitGrade,validateGrade,validateGradingSubmission,type AgentExecution,type Decision,type Grade,type Result} from "../domain/index.js";
import type {AgentSettings} from "../domain/managed.js";
import type {AgentProvider,EvidenceSource,WorkerOutput} from "../ports/index.js";
import {fail,fromRejection,succeed} from "./outcome.js";
import type {RequestContext} from "./requests.js";
import {gateEvidence} from "./grading.js";
import {blindFindings,configuredJudge,gateVerdict,type ManagedGatePlan,type BlindFinding} from "./managed-gates.js";

type FrozenBlind={executionId:string;spoolId:string;findings:BlindFinding[];blindDigest:string;handle?:string};

export class ManagedEvaluators {
  constructor(private readonly ctx:RequestContext,private readonly providers:Record<string,AgentProvider>) {}

  async evidence(id:string,channel:string,ordinal:number) {
    const blind=channel.startsWith("blind-");
    const stream=blind ? channel.slice("blind-".length) : channel;
    if (!["raw","events","output","stderr"].includes(stream) || !Number.isSafeInteger(ordinal) || ordinal<0) return fail("invalid","select an evaluator stream and chunk ordinal");
    return this.ctx.units.run("read",async r=>{
      const [frozen]=await r.intents.listForSubject(blind ? "gate-blind" : "evaluator-output","grading_record",id);
      const intent=frozen ?? (blind ? (await r.intents.listForSubject("gate-blind-partial","grading_record",id))[0] : undefined);
      if (!intent) return fail("not-found","evaluator output has not been frozen");
      const record=intent.payload as {executionId:string;trace?:import("../domain/index.js").FrozenTrace;output?:import("../ports/index.js").EvidenceRef;stderr?:import("../ports/index.js").EvidenceRef};
      const ref=stream==="raw" ? record.trace?.raw : stream==="events" ? record.trace?.events : stream==="output" ? record.output : record.stderr;
      if (!ref) return fail("not-found","this evaluator stream was not observed");
      if (ordinal>=ref.chunkCount) return fail("not-found","chunk is outside this stream");
      const bytes=await r.evidence.chunk(ref.digest,ordinal);
      return bytes ? succeed({gradingId:id,executionId:record.executionId,stream:channel,ordinal,ref,bytes}) : fail("unavailable","evaluator evidence chunk is missing");
    });
  }

  async reserve(id:string,live:boolean) {
    return this.ctx.units.run("write",async r=>{
      const g=await r.gradings.get(id,{lock:true});
      const config=g && await configuredJudge(r,g);
      const sandbox=g?.sandboxId && await r.sandboxes.get(g.sandboxId,{lock:true});
      if (!g || isGradingTerminal(g) || !config || !sandbox || sandbox.owner.type!=="grading_record" || sandbox.owner.id!==id || !sandbox.runtime) return fail("conflict","evaluator sandbox is not ready");
      const agent=await r.definitions.getRevision(config.agent.definitionId,config.agent.revisionId);
      const settings=agent?.content as AgentSettings|undefined;
      if (!agent || !sameRef(refOf(agent),config.agent) || !settings || !Object.hasOwn(this.providers,settings.provider)) return fail("conflict","evaluator agent revision is unavailable");
      if (g.evaluator?.kind==="agent") {
        const exec=await r.executions.get(g.evaluator.executionId);
        if (!exec || exec.owner.type!=="grading_record" || exec.owner.id!==id || !sandbox.lease || !authorizeBridge(sandbox,{holder:{type:"agent_execution",id:exec.id},token:sandbox.lease.token}).ok) return fail("conflict","evaluator execution no longer owns its sandbox");
        return succeed({exec,settings,cancelled:!!g.cancelIntent});
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
      return succeed({exec:claimed.value.state,settings,cancelled:false});
    });
  }

  async gatePhase(id:string) {
    return this.ctx.units.run("read",async r=>{
      const [frozen]=await r.intents.listForSubject("gate-blind","grading_record",id);
      return frozen?.payload as unknown as FrozenBlind|undefined;
    });
  }

  async freeze(id:string,executionId:string,output:WorkerOutput) {
    return this.ctx.units.run("write",async r=>{
      const g=await r.gradings.get(id,{lock:true}),exec=await r.executions.get(executionId,{lock:true});
      if (!g?.binding || g.purpose!=="gate" || g.status!=="running" || g.cancelIntent || g.evaluator?.kind!=="agent" ||
          g.evaluator.executionId!==executionId || exec?.stage!=="running" || exec.cancelIntent) return fail("conflict","gate can no longer freeze findings");
      const findings=blindFindings(output.message,g.binding.expectedCriteria);
      if (output.output.digest!=="sha256:"+this.ctx.hash(output.message)) return fail("invalid","blind evidence differs from the provider message");
      if (!findings) return fail("invalid","blind evaluation must provide one independent finding per frozen criterion");
      const prior=await r.intents.findByRequest("gate-blind-"+executionId);
      if (prior) return (prior.payload as {blindDigest:string}).blindDigest===output.output.digest ? succeed({}) : fail("conflict","blind output has already been frozen");
      const body=await r.evidence.put(output.output),stderr=await r.evidence.put(output.stderr);
      await r.evidence.put(output.trace.raw);await r.evidence.put(output.trace.events);
      const at=this.ctx.now(),frozen=recordProtocolStage(exec,{stage:"freeze",blindDigest:body.digest,at});
      if (!frozen.ok) return fromRejection(frozen.error);
      const reconcile=recordProtocolStage(frozen.value.state,{stage:"reconcile",at});
      if (!reconcile.ok) return fromRejection(reconcile.error);
      await r.executions.save(frozen.value.state,exec.version);
      await r.executions.save(reconcile.value.state,frozen.value.state.version);
      const payload={executionId,spoolId:this.ctx.newId(),blindDigest:body.digest,findings,trace:output.trace.descriptor,output:body,stderr};
      const hash=digestOf(payload,this.ctx.hash);
      if (!hash.ok) throw Error(hash.error.message);
      await r.intents.register({id:this.ctx.newId(),kind:"gate-blind",requestId:"gate-blind-"+executionId,subject:{type:"grading_record",id},
        payload,requestHash:hash.value,result:{},state:"completed",createdAt:at,updatedAt:at,version:1});
      return succeed({});
    });
  }

  async gateMaterials(id:string,executionId:string) {
    const refs=await this.ctx.units.run("read",async r=>{
      const g=await r.gradings.get(id),exec=await r.executions.get(executionId);
      if (g?.origin.type!=="gate" || g.cancelIntent || g.status!=="running" || g.evaluator?.kind!=="agent" || g.evaluator.executionId!==executionId ||
          !exec?.protocol.some(p=>p.stage==="freeze")) throw Error("blind findings are not frozen for this evaluator");
      const run=await r.taskRuns.get(g.origin.taskRunId);
      if (!run?.manifest || run.manifest.digest!==g.binding?.manifestDigest) throw Error("gate manifest changed");
      const archived=await gateEvidence(r,run);
      const materials=g.materials.map(material=>{
        const ref=archived.get(material.id);
        if (/^(transcript|events):/.test(material.id) && ref?.digest!==material.digest) throw Error("bound author evidence is unavailable");
        return {...material,ref};
      });
      const [job]=await r.intents.listForSubject("run-agent-grader","grading_record",id);
      const plan=job?.payload as unknown as ManagedGatePlan;
      const manifest={digest:run.manifest.digest,origin:run.manifest.origin,
        items:plan.items.map((item,n)=>({id:item.id,type:item.type,path:item.type+"-"+(n+1),...(item.slot ? {slot:item.slot} : {})})),
        ...(run.manifest.trajectoryReceipt ? {trajectoryReceipt:run.manifest.trajectoryReceipt} : {})};
      return {manifest,materials};
    });
    const materials=refs.materials.map(({id,digest,ref},index)=>{
      if (!ref) return {id,digest};
      const units=this.ctx.units;
      const source:EvidenceSource={digest,byteLength:ref.byteLength,async *open(){
        for (let n=0;n<ref.chunkCount;n++) {
          const data=await units.run("read",r=>r.evidence.chunk(digest,n));
          if (!data) throw Error("bound author evidence chunk is missing");
          yield data;
        }
      }};
      return {id,digest,file:"material-"+(index+1),source};
    });
    return {manifest:refs.manifest,materials};
  }

  async begin(id:string,executionId:string,handle:string,second=false) {
    return this.ctx.units.run("write",async r=>{
      const grading=await r.gradings.get(id,{lock:true}),exec=await r.executions.get(executionId,{lock:true});
      if (!exec?.runner || grading?.evaluator?.kind!=="agent" || grading.evaluator.executionId!==exec.id || grading.cancelIntent) return fail("conflict","evaluator start authority changed");
      if (second) {
        const [record]=await r.intents.listForSubject("gate-blind","grading_record",id);
        if (!record || exec.protocol.at(-1)?.stage!=="reconcile") return fail("conflict","gate reconciliation has not begun");
        const frozen=record.payload as unknown as FrozenBlind;
        if (frozen.executionId!==executionId || frozen.handle && frozen.handle!==handle) return fail("conflict","gate reconciliation identity changed");
        if (!frozen.handle) await r.intents.save({...record,payload:{...record.payload as object,handle},version:record.version+1,updatedAt:this.ctx.now()},record.version);
        return succeed({});
      }
      if (exec.sessionRef) return exec.sessionRef===handle ? succeed({}) : fail("conflict","evaluator process identity changed");
      const started=beginExecution(exec,{runnerId:exec.runner.id,sessionRef:handle,at:this.ctx.now()});
      if (!started.ok) return fromRejection(started.error);
      await r.executions.save(started.value.state,exec.version);
      if (grading.purpose==="gate") {
        const blind=recordProtocolStage(started.value.state,{stage:"blind",at:this.ctx.now()});
        if (!blind.ok) throw Error(blind.error.message);
        await r.executions.save(blind.value.state,started.value.state.version);
      }
      return succeed({});
    });
  }

  async authorizeStart(id:string,executionId:string,handle:string,second=false) {
    return this.ctx.units.run("write",async r=>{
      const grading=await r.gradings.get(id,{lock:true});
      if (!grading || grading.cancelIntent || isGradingTerminal(grading) || grading.evaluator?.kind!=="agent" || grading.evaluator.executionId!==executionId) return false;
      const exec=await r.executions.get(executionId),sb=grading.sandboxId && await r.sandboxes.get(grading.sandboxId);
      if (!exec || exec.cancelIntent || !sb || !sb.lease || !authorizeBridge(sb,{holder:{type:"agent_execution",id:executionId},token:sb.lease.token}).ok) return false;
      if (second) {
        const [frozen]=await r.intents.listForSubject("gate-blind","grading_record",id);
        const record=frozen?.payload as unknown as FrozenBlind|undefined;
        if (record?.executionId!==executionId || record.handle!==handle || exec.protocol.at(-1)?.stage!=="reconcile") return false;
      } else if (exec.sessionRef!==handle || grading.purpose==="gate" && exec.protocol.at(-1)?.stage!=="blind") return false;
      const key=(second ? "dispatch-gate-reconcile-" : "dispatch-evaluator-")+executionId,prior=await r.intents.findByRequest(key);
      if (prior) return prior.subject.id===id && (prior.payload as {handle:string}).handle===handle;
      const at=this.ctx.now(),payload={executionId,handle,token:sb.lease.token},hash=digestOf(payload,this.ctx.hash);
      if (!hash.ok) throw new Error(hash.error.message);
      await r.intents.register({id:this.ctx.newId(),requestId:key,requestHash:hash.value,kind:"dispatch-evaluator",subject:{type:"grading_record",id},
        payload,state:"completed",result:{},createdAt:at,updatedAt:at,version:1});
      return true;
    });
  }

  /** Called after process stop has been observed. Record bytes, result,
   * runner stop and returned lease together, including on cancellation. */
  async finish(id:string,executionId:string,output?:Partial<WorkerOutput>,exitCode?:number,infrastructure?:string) {
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
      const priorGates=g.origin.type==="gate" ? (await r.gradings.listForTaskRun(g.origin.taskRunId)).filter(p=>p.id!==id) : [];
      if (g.purpose==="gate" && !g.cancelIntent && !infrastructure && exitCode===0 && output && !output.providerFailed) {
        const [blind]=await r.intents.listForSubject("gate-blind","grading_record",id);
        const frozen=blind?.payload as unknown as FrozenBlind|undefined;
        if (frozen?.executionId===executionId && frozen.blindDigest===exec.protocol.find(p=>p.stage==="freeze")?.blindDigest) {
          const candidate=gateVerdict(output.message,frozen.findings);
          if (candidate && validateGradingSubmission(candidate,g,priorGates).ok) {
            grade=candidate;
            advance(recordProtocolStage(state,{stage:"handoff",at}));
            advance(recordProtocolStage(state,{stage:"submit",at}));
          }
        }
      }
      if (output) {
        if (exitCode!==undefined) advance(providerEnded(state,{at,outcome:exitCode===0 && !output.providerFailed ? "succeeded" : "failed"}));
        if (output.output) advance(recordReceipt(state,{kind:"output",ref:"sql-evidence:"+output.output.digest,at}));
        if (output.trace) advance(recordReceipt(state,{kind:"trajectory",ref:"sql-evidence:"+output.trace.raw.digest,at}));
        if (g.purpose!=="gate" && state.providerOutcome==="succeeded") try {
          const value=JSON.parse(output.message ?? "")?.grade;
          if (value && typeof value==="object" && validateGrade(value,g.scale).ok) {
            if (value.form==="numeric") grade={form:"numeric",value:value.value};
            else if (value.form==="category") grade={form:"category",category:value.category};
            else if (value.form==="indeterminate") grade={form:"indeterminate",reason:value.reason};
          }
        } catch { /* Invalid provider output is a grader fault. */ }
      }
      if (g.cancelIntent) advance(requestExecutionCancel(state,{at}));
      if (state.stop!=="idle" && !isExecutionTerminal(state)) advance(confirmExecutionStopped(state,{at}));
      if (!g.cancelIntent && infrastructure) advance(failExecutionInfrastructure(state,{detail:infrastructure,at}));
      const stopped=evaluatorStopped(g,{at});
      if (!stopped.ok) return fromRejection(stopped.error);
      const next=stopped.value.state;
      const ended=grade ? submitGrade(next,{grade,at},{priorGates}) : isGradingTerminal(next) ? undefined : faultGrader(next,{detail:infrastructure ?? "evaluator did not return a valid grade",at});
      if (ended && !ended.ok) return fromRejection(ended.error);
      const released=returnLease(sb,{holder,token:sb.lease.token,stop:"verified",at});
      if (!released.ok) return fromRejection(released.error);
      if (output) {
        const body=output.output && await r.evidence.put(output.output),stderr=output.stderr && await r.evidence.put(output.stderr);
        if(output.trace){await r.evidence.put(output.trace.raw);await r.evidence.put(output.trace.events);}
        const payload={executionId:exec.id,coverage:{stdout:!!output.trace,stderr:!!stderr},...(output.trace ? {trace:output.trace.descriptor} : {}),...(body ? {output:body} : {}),...(stderr ? {stderr} : {})};
        const digest=digestOf(payload,this.ctx.hash);
        if (!digest.ok) throw new Error(digest.error.message);
        const kind=g.purpose==="gate" && !exec.protocol.some(p=>p.stage==="freeze") ? "gate-blind-partial" : "evaluator-output";
        await r.intents.register({kind,id:this.ctx.newId(),requestId:kind+"-"+exec.id,requestHash:digest.value,subject:{type:"grading_record",id},payload,state:"completed",result:{},version:1,createdAt:at,updatedAt:at});
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
