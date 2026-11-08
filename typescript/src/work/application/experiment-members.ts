import type { WorkRepositories } from "../ports/index.js";
import { createTaskRun, digestOf, mayStartMember, requestExperimentCancel } from "../domain/index.js";
import type { ExperimentGrading } from "./experiment-grading.js";
import type { AgentDefinitions } from "./agent-definitions.js";
import { readExperiment } from "./experiment-plans.js";
import { once, type RequestContext } from "./requests.js";
import { fail, fromRejection, succeed } from "./outcome.js";

/** Batch row ownership serializes new admissions with cancellation and
 * bounds the number of simultaneously nonterminal task runs. */
export class ExperimentMembers {
  constructor(private readonly ctx:RequestContext, private readonly agents:AgentDefinitions,private readonly grading:ExperimentGrading) {}

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

  async measure(batchId:string,key:string,requirement:string,requestId:string) {
    const result = await this.grading.measure({batchId,key,requirement,requestId});
    if (result.ok && !("status" in result.value && result.value.status === "accepted")) await this.note(batchId,"terminal");
    return result;
  }

  finishRule(id:string) { return this.grading.finish(id); }

  async schedule(batchId:string) {
    return this.ctx.units.run("read", r=>this.readSchedule(r,batchId));
  }

  private async readSchedule(r:WorkRepositories,batchId:string) {
      const batch = await r.experiments.get(batchId);
      const plan = batch && await readExperiment(r,batch.experimentId);
      if (!batch || !plan) return fail("not-found","experiment batch does not exist");
      const progress = new Map((await r.experiments.memberProgress(batchId)).map(row=>[row.key,row]));
      const members = [];
      for (const member of batch.members) {
        const row = progress.get(member.key);
        const run = row?.runId && await r.taskRuns.get(row.runId);
        if (!run) continue;
        const [worker] = await r.intents.listForSubject("managed-worker","task_run",run.id);
        if (!worker) return fail("conflict","batch member has no registered worker");
        const job = worker.payload as {executionId:string;observation?:{state:string;detail?:string}};
        const history = await r.gradings.listForMember(batchId,member.caseKey,member.repeatIndex);
        const requirements = plan.cases.find(c=>c.key === member.caseKey)!.requirements.map(requirement=>({
          key:requirement.key, records:history.filter(g=>g.origin.type === "member" && g.origin.requirementKey === requirement.key)
            .map(g=>({id:g.id,status:g.status,strategy:g.strategy})),
        }));
        const waitingRules = history.filter(g=>g.strategy === "rule" && g.status === "running").map(g=>g.id);
        const waitingTests = [];
        for (const grade of history.filter(g=>g.strategy === "test")) {
          const [test] = await r.intents.listForSubject("run-test-grader","grading_record",grade.id);
          if (test && test.state !== "completed") waitingTests.push({id:grade.id,status:grade.status,
            host:(test.payload as {observation?:{state:string;detail?:string}}).observation});
        }
        const sandbox = run.sandboxId ? await r.sandboxes.get(run.sandboxId) : undefined;
        const released = !sandbox || sandbox.phase === "released";
        members.push({key:member.key,runId:run.id,status:run.status,cancel:!!run.cancelIntent,executionId:job.executionId,
          workerDone:worker.state === "completed" && released,host:worker.state === "completed" && !released ? {state:"awaiting-resume",detail:"worker sandbox release pending"} : job.observation,requirements,waitingTests,waitingRules});
      }
      return succeed({cancelled:!!batch.cancelIntent,pending:batch.members.length - members.length,members});
  }

  async resume(batchId:string,requestId:string) {
    return once(this.ctx,{requestId,kind:"resume-experiment",input:{batchId},subject:{type:"experiment_run",id:batchId}},async r=>
      await r.experiments.get(batchId) ? succeed({batchId}) : fail("not-found","experiment batch does not exist"));
  }

  async note(batchId:string,state:string,detail?:string) {
    return this.ctx.units.run("write",async r=>{
      const batch = await r.experiments.get(batchId,{lock:true});
      const [job] = await r.intents.listForSubject("drive-experiment","experiment_run",batchId);
      if (!batch || !job) return "blocked";
      // Only admission of a new grading can reopen a completed batch.
      if (job.state === "completed") return "terminal";
      if (state === "terminal") {
        const current = await this.readSchedule(r,batchId);
        if (!current.ok) throw new Error(current.error.message);
        const {cancelled,pending,members} = current.value;
        const open = members.some(m=> !m.workerDone || !["delivered","failed","cancelled"].includes(m.status) ||
          m.waitingTests.length > 0 || m.waitingRules.length > 0 ||
          (!cancelled && m.status === "delivered" && m.requirements.some(req=>!req.records.length)));
        if (open || pending && !cancelled) state = "running";
      }
      const observation = {state,...(detail ? {detail} : {})};
      const prior = (job.payload as {observation?:{state:string;detail?:string}}).observation;
      if (prior?.state === state && prior.detail === detail) return state;
      const payload = job.payload as {batchId:string;firstTerminalAt?:string;firstTerminalState?:"completed"|"cancelled"};
      const firstTerminalAt = payload.firstTerminalAt ?? (state === "terminal" ? this.ctx.now() : undefined);
      const firstTerminalState = payload.firstTerminalState ?? (batch.cancelIntent ? "cancelled" : "completed");
      await r.intents.save({...job,state:state === "terminal" ? "completed" : "registered",payload:{batchId,observation,...(firstTerminalAt ? {firstTerminalAt,firstTerminalState} : {})},
        updatedAt:this.ctx.now(),version:job.version+1},job.version);
      return state;
    });
  }

  cancel(batchId:string,requestId:string) {
    return once(this.ctx,{requestId,kind:"cancel-experiment",subject:{type:"experiment_run",id:batchId},input:{batchId}},async r=>{
      const batch = await r.experiments.get(batchId,{lock:true});
      if (!batch) return fail("not-found","experiment batch does not exist");
      const [job] = await r.intents.listForSubject("drive-experiment","experiment_run",batchId);
      if (job?.state === "completed") return succeed({batchId});
      const cancelled = requestExperimentCancel(batch,{at:this.ctx.now()});
      if (!cancelled.ok) return fromRejection(cancelled.error);
      if (cancelled.value.state !== batch) await r.experiments.save(cancelled.value.state,batch.version);
      return succeed({batchId});
    });
  }
}
