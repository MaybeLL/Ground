import type {ManagedProcessPort,WorkerTarget} from "../ports/index.js";
import type {ManagedEvaluators} from "../application/managed-evaluators.js";
import type {AgentGrader} from "../application/rule-definitions.js";
import {succeed} from "../application/outcome.js";

export class AgentGradingDriver {
  constructor(private readonly evaluators:ManagedEvaluators,private readonly process:ManagedProcessPort) {}

  async drive(id:string,target:WorkerTarget,grader:AgentGrader,task:unknown,live:boolean,cancelled:boolean) {
    const reserved=await this.evaluators.reserve(id,live);
    if (!reserved.ok) return reserved;
    if (!reserved.value) return succeed({state:"awaiting-resume" as const,providerStopped:true});
    const {exec,settings}=reserved.value;
    const plan={role:"evaluator" as const,target,agent:settings,job:{executionId:exec.id},prompt:JSON.stringify({
      role:"evaluator",task,rubric:grader.rubric,scale:grader.scale,
      instructions:"Evaluate the read-only delivery under /grounds-delivery. Use the empty current directory as scratch. Frozen evaluator materials are available in /grounds-grader. Return a JSON object with grade in the declared scale, or an indeterminate grade with a reason."
    })};
    const next=async(output?:Awaited<ReturnType<ManagedProcessPort["output"]>>,exitCode?:number,reason?:string)=>{
      const ended=await this.evaluators.finish(id,exec.id,output,exitCode,reason);
      return ended.ok ? succeed({state:"running" as const}) : ended;
    };
    if (cancelled || reserved.value.cancelled) {
      await this.process.stop(plan,true);
      if (!exec.sessionRef) return next();
      const observed=await this.process.drive(plan,exec.sessionRef,false);
      if (observed.state==="running") return succeed({state:"running" as const});
      const output=await this.process.availableOutput(plan);
      try {return await next(output,observed.state==="complete" ? observed.exitCode : undefined);}
      finally {await output?.trace.dispose();}
    }
    let handle=exec.sessionRef;
    if (!handle) {
      if (!live) return succeed({state:"awaiting-resume" as const,providerStopped:true});
      try {handle=await this.process.handle(plan,true);} catch {
        await this.process.stop(plan,true);
        return next(undefined,undefined,"evaluator process creation was interrupted");
      }
      if (!handle) return succeed({state:"awaiting-resume" as const});
      const begun=await this.evaluators.begin(id,exec.id,handle);
      if (!begun.ok) return begun;
    }
    const observed=await this.process.drive(plan,handle,live,()=>this.evaluators.authorizeStart(id,exec.id,handle));
    if (observed.state==="interrupted") {
      await this.process.stop(plan,true);
      return next(undefined,undefined,observed.detail);
    }
    if (observed.state!=="complete") return succeed({state:observed.state,detail:observed.detail,...(observed.state==="awaiting-resume" ? {providerStopped:await this.process.quiescent(plan)} : {})});
    const output=await this.process.output(plan);
    try {await this.process.stop(plan,false);return await next(output,observed.exitCode);}
    finally {await output.trace.dispose();}
  }
}
