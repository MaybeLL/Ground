import {adoptGrading, digestOf, gradingNotStarted, isTerminal, materialsFingerprint, type Grade} from "../domain/index.js";
import {readExperiment, type ExperimentPlan} from "./experiment-plans.js";
import {fail, succeed} from "./outcome.js";
import type {RequestContext} from "./requests.js";

type Requirement = ExperimentPlan["cases"][number]["requirements"][number];
type Summary = {requirement:string;grader:Requirement["grader"];scale:Requirement["scale"];planned:number;adopted:number;valid:number;
  indeterminate:number;missing:number;errors:number;numericMean:number|null;categories:Map<string,number>};

function add(summary:Summary, grade:Grade | undefined, fault:boolean) {
  summary.planned++;
  if (fault) summary.errors++;
  if (!grade) { summary.missing++; return; }
  summary.adopted++;
  if (grade.form === "indeterminate") { summary.indeterminate++; return; }
  summary.valid++;
  if (grade.form === "numeric") {
    const previous = summary.numericMean ?? 0;
    summary.numericMean = previous * ((summary.valid - 1) / summary.valid) + grade.value / summary.valid;
  } else if (grade.form === "category") {
    summary.categories.set(grade.category,(summary.categories.get(grade.category) ?? 0) + 1);
  }
}

export class ExperimentResults {
  constructor(private readonly ctx:RequestContext) {}

  async inspect(id:string, detailKey?:string) {
    return this.ctx.units.run("read",async r=>{
      const batch = await r.experiments.get(id);
      if (!batch) return fail("not-found","experiment batch does not exist");
      const plan = await readExperiment(r,batch.experimentId);
      if (!plan) return fail("conflict","the frozen experiment plan is missing");
      const definitions = new Map(plan.cases.map(item=>[item.key,item]));
      const progress = new Map((await r.experiments.memberProgress(id)).map(item=>[item.key,item]));
      if (detailKey !== undefined && !progress.has(detailKey)) return fail("not-found","batch member does not exist");
      const groups = new Map<string,Summary>();
      const counts = {planned:batch.members.length, pending:0, active:0, delivered:0, executionErrors:0, failed:0, cancelled:0, fullyGraded:0};
      const members = [], readAt = this.ctx.now();
      for (const member of batch.members) {
        if (detailKey !== undefined && member.key !== detailKey) continue;
        const item = definitions.get(member.caseKey);
        if (!item) return fail("conflict","member is missing its frozen case");
        const runId = progress.get(member.key)?.runId;
        const run = runId ? await r.taskRuns.get(runId) : undefined;
        if (runId && !run) return fail("conflict","member's task run is missing");
        if (!run) counts.pending++;
        else if (!isTerminal(run)) counts.active++;
        else if (run.status === "delivered") counts.delivered++;
        else if (run.status === "cancelled") counts.cancelled++;
        else if (run.failure?.class === "infrastructure") counts.executionErrors++;
        else counts.failed++;
        const history = await r.gradings.listForMember(id,member.caseKey,member.repeatIndex);
        const target = run?.manifest?.items.find(delivery=>delivery.type === "candidate");
        const identity = target && digestOf({...target},this.ctx.hash);
        const targets = target && identity?.ok ? [target.type + ":" + target.id + ":" + identity.value] : [];
        const requirements = [];
        for (const required of item.requirements) {
          const digest = digestOf(required.materials,this.ctx.hash);
          if (!digest.ok) return fail("conflict","invalid frozen materials");
          const slot = {experimentRunId:id,caseKey:member.caseKey,repeatIndex:member.repeatIndex,requirementKey:required.key,
            graderRevisionId:required.grader.revisionId,targets,materialsDigest:digest.value};
          const adoption = adoptGrading(history,slot,materialsFingerprint(required.materials));
          const adopted = history.find(g=>g.id === adoption.adopted);
          requirements.push({key:required.key,...adoption,...(adopted ? {grade:adopted.grade} : {})});
          const groupId = JSON.stringify([required.key,required.grader.revisionId,required.scale]);
          const group = groups.get(groupId) ?? {requirement:required.key,grader:required.grader,scale:required.scale,planned:0,
            adopted:0,valid:0,missing:0,indeterminate:0,errors:0,numericMean:null,
            categories:new Map<string,number>(required.scale.form === "category" ? required.scale.categories.map(c=>[c,0]) : [])};
          add(group,adopted?.grade,!!adoption.latestFault);
          groups.set(groupId,group);
        }
        const complete = requirements.every(req=>req.adopted);
        if (complete) counts.fullyGraded++;
        const why = gradingNotStarted(batch,member,run);
        members.push({key:member.key,caseKey:member.caseKey,repeatIndex:member.repeatIndex,runId:runId ?? null,status:run?.status ?? "not-started",complete,
          ...(why && !history.length ? {gradingNotStarted:why} : {}),requirements,
          ...(detailKey === undefined ? {} : {run,gradings:history,executions:run ? await r.executions.listByOwner({type:"task_run",id:run.id}) : []})});
      }
      const dimensions = [...groups.values()].map(({categories,...dimension})=>({...dimension,categories:Object.fromEntries(categories)}));
      return detailKey === undefined ? succeed({readAt,batch,counts,dimensions,members}) : succeed({readAt,batchId:id,member:members[0]});
    });
  }
}
