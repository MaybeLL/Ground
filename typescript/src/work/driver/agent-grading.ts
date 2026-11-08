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
    const plan={target,agent:settings,job:{executionId:exec.id},prompt:JSON.stringify({
      role:"evaluator",task,rubric:grader.rubric,scale:grader.scale,
      instructions:"Evaluate the delivery in the current directory. Frozen evaluator materials are available in /grounds-grader. Return a JSON object with grade in the declared scale, or an indeterminate grade with a reason."
    })};
    const next=async(output?:Awaited<ReturnType<ManagedProcessPort["output"]>>,exitCode?:number,reason?:string)=>{
      const ended=await this.evaluators.finish(id,exec.id,output,exitCode,reason);
      return ended.ok ? succeed({state:"running" as const}) : ended;
    };
    if (cancelled) {await this.process.stop(plan,true);return next();}
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
    const observed=await this.process.drive(plan,handle,live);
    if (observed.state==="interrupted") {
      await this.process.stop(plan,true);
      return next(undefined,undefined,observed.detail);
    }
    if (observed.state!=="complete") return succeed({state:observed.state,detail:observed.detail});
    const output=await this.process.output(plan);
    try {await this.process.stop(plan,false);return await next(output,observed.exitCode);}
    finally {await output.trace.dispose();}
  }
}
