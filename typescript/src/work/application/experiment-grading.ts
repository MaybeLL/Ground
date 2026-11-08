import {createGrading, digestOf, faultGrader, refOf, sameRef, submitGrade, requestGradingCancel, type GradingOrigin} from "../domain/index.js";
import {GRADING_REQUEST_COUNTER, type CodeArchivePort, type WorkRepositories} from "../ports/index.js";
import type {ArchiveRepairs} from "./archive-repairs.js";
import {casesOf} from "./evaluation-suites.js";
import {readExperiment} from "./experiment-plans.js";
import {once,type RequestContext} from "./requests.js";
import {fileRule,testGrader} from "./rule-definitions.js";
import {admitTestMeasurement,markGradingActive,type AcceptedTest} from "./test-measurements.js";
import {fail,fromRejection,succeed} from "./outcome.js";

type Input = {batchId:string;key:string;requirement:string;requestId:string};
type RuleTicket = Omit<AcceptedTest,"status"> & {path:string;repo:string;receipt:string;expectedDigest:string|null};
type Admission = {kind:"rule";ticket:RuleTicket} | {kind:"test";ticket:AcceptedTest};
type Evaluated = Omit<AcceptedTest,"status"> & ({result:string;actualDigest:string|null;expectedDigest:string|null} | {status:"grader_fault"|"cancelled"});

/** Assign request order while holding the batch lock. Archive reads happen
 * after admission, so a slow or failed read cannot change adoption order. */
export class ExperimentGrading {
  constructor(private readonly ctx:RequestContext,private readonly archive:CodeArchivePort,private readonly repairs:ArchiveRepairs) {}

  async measure(input:Input) {
    const admitted = await once<Admission>(this.ctx,{requestId:input.requestId,kind:"grade-experiment-member",input,
      subject:{type:"experiment_run",id:input.batchId}},r=>this.admit(r,input));
    if (!admitted.ok) return admitted;
    if (admitted.value.kind === "test") return succeed(admitted.value.ticket);
    return this.finish(admitted.value.ticket.gradingId);
  }

  private async admit(r:WorkRepositories,input:Input):Promise<import("./outcome.js").Outcome<Admission>> {
    const batch = await r.experiments.get(input.batchId,{lock:true});
    const member = batch?.members.find(m=>m.key === input.key);
    if (!batch || !member) return fail("not-found","batch member does not exist");
    if (batch.cancelIntent) return fail("conflict","cancelled batch cannot admit another measurement");
    const plan = await readExperiment(r,batch.experimentId);
    const item = plan?.cases.find(c=>c.key === member.caseKey);
    const requirement = item?.requirements.find(req=>req.key === input.requirement);
    const suite = await r.definitions.getRevision(batch.suite.definitionId,batch.suite.revisionId);
    if (!item || !requirement || !suite || !sameRef(refOf(suite),batch.suite)) return fail("not-found","frozen member requirement is missing");
    const binding = casesOf(suite).find(c=>c.key === member.caseKey)?.bindings.find(b=>b.key === requirement.key);
    const revision = await r.definitions.getRevision(requirement.grader.definitionId,requirement.grader.revisionId);
    if (!binding || !revision || !sameRef(refOf(revision),binding.graderRevision)) return fail("conflict","frozen grader identity changed");
    const admission = await r.intents.findByRequest(member.taskRunRequestId);
    const run = admission?.kind === "start-experiment-member" && await r.taskRuns.get(admission.subject.id);
    const target = run && run.status === "delivered" && run.manifest?.items.find(i=>i.type === "candidate");
    if (!run || !target || !sameRef(run.taskRevision,item.task)) return fail("conflict","member has no matching delivery");
    const origin:GradingOrigin = {type:"member",experimentRunId:batch.id,caseKey:member.caseKey,repeatIndex:member.repeatIndex,requirementKey:requirement.key};
    const test = testGrader(revision.content), rule = fileRule(revision.content);
    if (test) {
      const commit = this.archive.recordedCommit(target);
      if (!commit) return fail("invalid","member has no Git receipt");
      const job = await admitTestMeasurement(this.ctx,r,{suite:batch.suite,caseKey:item.key,bindingKey:binding.key,
        runId:run.id,deliveryId:target.id,commit,archiveId:target.id,receipt:target.receipt,repository:item.repository.repositoryPath},
        target,test,requirement.grader,requirement.materials,origin);
      return job.ok ? succeed({kind:"test",ticket:job.value}) : job;
    }
    if (!rule || !binding.answerPath) return fail("unsupported","member grading strategy is unavailable");
    const digest = digestOf({...target},this.ctx.hash);
    if (!digest.ok) return fromRejection(digest.error);
    const at = this.ctx.now(), gradingId = this.ctx.newId();
    const created = createGrading({id:gradingId,purpose:"measure",origin,graderRevision:requirement.grader,grader:rule,
      requestSeq:await r.sequences.next(GRADING_REQUEST_COUNTER), targets:[{type:"candidate",id:target.id,digest:digest.value}], materials:requirement.materials,at});
    if (!created.ok) return fromRejection(created.error);
    const ticket:RuleTicket = {gradingId,suiteId:suite.definitionId,revisionId:suite.id,caseKey:item.key,bindingKey:binding.key,runId:run.id,deliveryId:target.id,
      repo:item.repository.repositoryPath,receipt:target.receipt,path:binding.answerPath,expectedDigest:binding.materials.find(m=>m.role === "reference-answer")?.digest ?? null};
    await r.gradings.create(created.value.state);
    await markGradingActive(r,batch.id,at);
    await r.intents.register({id:this.ctx.newId(),requestId:"rule-"+gradingId,kind:"score-member-rule",subject:{type:"grading_record",id:gradingId},
      requestHash:digest.value,state:"registered",payload:ticket,createdAt:at,updatedAt:at,version:1});
    return succeed({kind:"rule",ticket});
  }

  async finish(id:string) {
    const read = await this.ctx.units.run("read",async r=>{
      const [job] = await r.intents.listForSubject("score-member-rule","grading_record",id);
      const grading = await r.gradings.get(id);
      const definition = grading && await r.definitions.getRevision(grading.graderRevision.definitionId,grading.graderRevision.revisionId);
      const batchId = grading?.origin.type === "member" ? grading.origin.experimentRunId : undefined;
      const batch = batchId && await r.experiments.get(batchId);
      return {job,batchId, cancelled:grading?.status === "cancelled" || !!(batch && batch.cancelIntent),rule:definition && fileRule(definition.content)};
    });
    if (!read.job || !read.rule) return fail("not-found","member rule admission is missing");
    if (read.job.state === "completed") return succeed(read.job.result as Evaluated);
    const {repo,path,receipt,expectedDigest,...base} = read.job.payload as RuleTicket;
    let actualDigest:string|null = null, result:string | undefined, error:string | undefined;
    if (!read.cancelled) try {
      const current = await this.repairs.current(base.runId,{id:base.deliveryId,receipt},repo);
      const active = current.observation;
      if (!["intact","ref-changed"].includes(active.status ?? "")) error = "member archive could not be verified";
      else {
        const file = await this.archive.fileDigest(repo,{id:"activeArchiveId" in active ? active.activeArchiveId : base.deliveryId,receipt:current.receipt},path);
        if (file.status !== "read" && file.status !== "missing") error = file.reason;
        else {
          actualDigest = file.status === "read" ? file.digest : null;
          const pass = read.rule.operation === "file-exists" ? actualDigest !== null : actualDigest !== null && actualDigest === expectedDigest;
          result = read.rule.scale.categories[pass ? 0 : 1]!;
        }
      }
    } catch { error = "member archive read failed"; }
    return this.ctx.units.run("write",async r=>{
      const batch = read.batchId && await r.experiments.get(read.batchId,{lock:true});
      const job = await r.intents.get(read.job!.id,{lock:true}), grade = await r.gradings.get(id,{lock:true});
      if (!job || !grade) return fail("conflict","member rule admission disappeared");
      if (job.state === "completed") return succeed(job.result as Evaluated);
      const at = this.ctx.now();
      let answer:Evaluated;
      if (grade.status === "cancelled" || batch && batch.cancelIntent) {
        if (grade.status === "running") {
          const ended = requestGradingCancel(grade,{at});
          if (!ended.ok) return fromRejection(ended.error);
          await r.gradings.save(ended.value.state,grade.version);
        }
        answer = {...base,status:"cancelled"};
      }
      else {
        const decision = result === undefined ? faultGrader(grade,{detail:error || "no trustworthy rule result",at}) :
          submitGrade(grade,{grade:{form:"category",category:result},at});
        if (!decision.ok) return fromRejection(decision.error);
        await r.gradings.save(decision.value.state,grade.version);
        answer = result === undefined ? {...base,status:"grader_fault"} : {...base,result,actualDigest,expectedDigest};
      }
      await r.intents.save({...job,state:"completed",result:answer,updatedAt:at,version:job.version+1},job.version);
      return succeed(answer);
    });
  }
}
