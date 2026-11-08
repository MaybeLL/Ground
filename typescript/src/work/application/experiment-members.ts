import { createTaskRun, digestOf, mayStartMember, requestExperimentCancel } from "../domain/index.js";
import type { EvaluationSuites } from "./evaluation-suites.js";
import type { AgentDefinitions } from "./agent-definitions.js";
import { readExperiment } from "./experiment-plans.js";
import { once, type RequestContext } from "./requests.js";
import { fail, fromRejection, succeed } from "./outcome.js";

/** Batch row ownership serializes new admissions with cancellation and
 * bounds the number of simultaneously nonterminal task runs. */
export class ExperimentMembers {
  constructor(private readonly ctx:RequestContext, private readonly agents:AgentDefinitions,private readonly suites:EvaluationSuites) {}

  async next(batchId:string) {
    return this.ctx.units.run("write",async r => {
      const batch = await r.experiments.get(batchId,{lock:true});
      if (!batch) return fail("not-found","experiment batch does not exist");
      if (batch.cancelIntent) return succeed({state:"cancelled" as const});
      const progress = await r.experiments.memberProgress(batchId);
      if (progress.filter(p => p.status !== null && !["delivered","failed","cancelled"].includes(p.status)).length >= batch.taskConcurrency) {
        return succeed({state:"at-capacity" as const});
      }
      const pending = progress.find(p=>p.runId === null);
      if (!pending) return succeed({state:"all-admitted" as const});
      const member = mayStartMember(batch,pending.key);
      if (!member.ok) return fromRejection(member.error);
      const plan = await readExperiment(r,batch.experimentId);
      const item = plan?.cases.find(c=>c.key === member.value.caseKey);
      if (!plan || !item) return fail("conflict","batch member has no frozen case plan");
      const at = this.ctx.now(), runId = this.ctx.newId();
      const created = createTaskRun({id:runId, taskRevision:item.task, environment:{revision:item.environment,source:"specified"},
        workerMode:"managed", retention:"release", at});
      if (!created.ok) return fromRejection(created.error);
      const admitted = await this.agents.admit(r,created.value.state,{definitionId:plan.agent.definitionId,revisionId:plan.agent.revisionId,
        repositoryPath:item.repository.repositoryPath}, undefined, item.repository);
      if (!admitted.ok) return admitted;
      if (!("executionId" in admitted.value) || typeof admitted.value.executionId !== "string") throw new Error("missing managed member execution");
      await r.taskRuns.create(created.value.state);
      const key = member.value.key, executionId = admitted.value.executionId;
      const result = {batchId,key,runId,executionId};
      const payload = {batchId,key};
      const digest = digestOf(payload,this.ctx.hash);
      if (!digest.ok) throw new Error(digest.error.message);
      await r.intents.register({id:this.ctx.newId(), requestId:member.value.taskRunRequestId, kind:"start-experiment-member",requestHash:digest.value,
        subject:{type:"task_run",id:runId},state:"completed",payload,result,createdAt:at,updatedAt:at,version:1});
      return succeed({state:"started" as const,...result});
    });
  }

  async measure(batchId:string, key:string, requirement:string, requestId:string) {
    const selected = await this.ctx.units.run("read",async r=>{
      const batch = await r.experiments.get(batchId);
      const member = batch?.members.find(candidate=>candidate.key === key);
      if (!batch || !member) return fail("not-found","batch member does not exist");
      const plan = await readExperiment(r,batch.experimentId);
      const item = plan?.cases.find(c=>c.key === member.caseKey);
      if (!item?.requirements.some(g=>g.key === requirement)) return fail("not-found","member has no such grading requirement");
      const admission = await r.intents.findByRequest(member.taskRunRequestId);
      const run = admission?.kind === "start-experiment-member" && await r.taskRuns.get(admission.subject.id);
      const target = run && run.status === "delivered" && run.manifest?.items.find(i=>i.type === "candidate");
      if (!run || !target) return fail("conflict","the member has no frozen delivery");
      return succeed({repository:item.repository.repositoryPath,input:{requestId,suiteId:batch.suite.definitionId,seq:batch.suite.seq,
        caseKey:member.caseKey,bindingKey:requirement,runId:run.id,deliveryId:target.id,member:{batchId,repeatIndex:member.repeatIndex}}});
    });
    return selected.ok ? this.suites.measure(selected.value.input,selected.value.repository) : selected;
  }

  cancel(batchId:string,requestId:string) {
    return once(this.ctx,{requestId,kind:"cancel-experiment",subject:{type:"experiment_run",id:batchId},input:{batchId}},async r=>{
      const batch = await r.experiments.get(batchId,{lock:true});
      if (!batch) return fail("not-found","experiment batch does not exist");
      const cancelled = requestExperimentCancel(batch,{at:this.ctx.now()});
      if (!cancelled.ok) return fromRejection(cancelled.error);
      if (cancelled.value.state !== batch) await r.experiments.save(cancelled.value.state,batch.version);
      return succeed({batchId});
    });
  }
}
