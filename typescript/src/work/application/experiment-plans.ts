import {parseGraderContent, digestOf, isText, launchExperimentRun, refOf, sameRef, type RevisionRef} from "../domain/index.js";
import type {WorkRepositories} from "../ports/index.js";
import {casesOf} from "./evaluation-suites.js";
import {runEnvironment} from "./environment-definitions.js";
import {once, type RequestContext} from "./requests.js";
import {fail, fromRejection, succeed} from "./outcome.js";
import type {ArchiveRepairs} from "./archive-repairs.js";

type Pinned = {[K in keyof RevisionRef]:RevisionRef[K]};
type ArchiveSource = {runId:string;deliveryId:string;receipt:string;commit:string};
type Requirement = {key:string;grader:Pinned;scale:{form:"numeric";min:number;max:number} | {form:"criteria"} | {form:"category";categories:string[]};materials:{id:string;digest:string}[]};
type CasePlan = {key:string;task:Pinned;environment:Pinned;source:ArchiveSource;materialSources:ArchiveSource[];
  repository:{repositoryPath:string;baseline:string;remote:string};requirements:Requirement[]};
export type ExperimentPlan = {id:string;name:string;suite:Pinned;agent:Pinned;cases:CasePlan[];createdAt:string};
type CaseOverride = {repositoryPath?:string;environmentRevisionId?:string};
type Define = {requestId:string;name:string;suiteId:string;seq:number;agentId:string;agentRevisionId:string;repositoryPath:string;
  overrides?:Record<string,CaseOverride>};
type Dependencies = RequestContext & {repairs:ArchiveRepairs;
  source:{freezeSource(path:string,baseline:string,remote:string):Promise<CasePlan["repository"]>}};

export async function readExperiment(r:WorkRepositories,id:string) {
  const record = await r.intents.get(id);
  return record?.kind === "experiment-plan" && record.state === "completed" ? record.payload as ExperimentPlan : undefined;
}

export class ExperimentPlans {
  constructor(private readonly deps:Dependencies) {}

  define(input:Define) {
    return once(this.deps,{requestId:input.requestId,kind:"define-experiment",input,subject:{type:"suite",id:input.suiteId}},async r => {
      if (!isText(input.name,256)) return fail("invalid","provide an experiment name");
      const suite = await r.definitions.getRevisionBySeq(input.suiteId,input.seq);
      const agent = await r.definitions.getRevision(input.agentId,input.agentRevisionId);
      if (suite?.kind !== "suite" || agent?.kind !== "agent") return fail("not-found","select exact suite and agent revisions");
      const snapshot = casesOf(suite), cases:CasePlan[] = [];
      if (Object.keys(input.overrides ?? {}).some(key => !snapshot.some(c => c.key === key))) return fail("invalid","unknown evaluation case override");
      for (const item of snapshot) {
        const task = await r.definitions.getRevision(item.taskRevision.definitionId,item.taskRevision.revisionId);
        if (!task || !sameRef(refOf(task),item.taskRevision)) return fail("conflict","a frozen case task is missing");
        const override = input.overrides?.[item.key];
        const environment = await runEnvironment(r,task,override?.environmentRevisionId);
        if (!environment.ok) return environment;
        if (!environment.value) return fail("invalid","a managed experiment case requires an environment");
        const source = (task.content as {repository?:{remote:string;baseline:string}}).repository;
        if (!source?.baseline || !source.remote) return fail("invalid","a coding case requires a starting repository and baseline");
        let repository;
        try { repository = await this.deps.source.freezeSource(override?.repositoryPath ?? input.repositoryPath,source.baseline,source.remote); }
        catch { return fail("unavailable","could not pin the starting repository for case " + item.key); }
        const archive = (s:ArchiveSource):ArchiveSource => ({runId:s.runId,deliveryId:s.deliveryId,receipt:s.receipt,commit:s.commit});
        const requirements: Requirement[] = [];
        for (const binding of item.bindings) {
          const revision = await r.definitions.getRevision(binding.graderRevision.definitionId,binding.graderRevision.revisionId);
          if (!revision || !sameRef(refOf(revision),binding.graderRevision)) return fail("conflict","frozen grading requirement is missing");
          const parsed = parseGraderContent(revision.content);
          if (!parsed.ok) return fromRejection(parsed.error);
          const reference = binding.materials.find(m=>m.role === "reference-answer");
          const materials = parsed.value.strategy === "test" ? binding.materials.map((m,ordinal)=>({id:"suite-material-"+ordinal,digest:m.digest})) :
            [...(reference ? [{id:"reference-answer",digest:reference.digest}] : []),{id:"suite-snapshot",digest:suite.digest}];
          requirements.push({key:binding.key,grader:{...binding.graderRevision},scale:parsed.value.scale.form === "category" ? {form:"category",categories:[...parsed.value.scale.categories]} : {...parsed.value.scale},materials});
        }
        cases.push({key:item.key,task:{...item.taskRevision},environment:{...environment.value.revision},source:archive(item.source), repository,
          materialSources:item.bindings.map(b=>archive(b.materialSource)),requirements});
      }
      const at = this.deps.now(), id = this.deps.newId();
      const plan:ExperimentPlan = {id,name:input.name,suite:{...refOf(suite)},agent:{...refOf(agent)},cases,createdAt:at};
      const digest = digestOf(plan,this.deps.hash);
      if (!digest.ok) return fromRejection(digest.error);
      await r.intents.register({id,requestId:"plan-"+id,requestHash:digest.value,kind:"experiment-plan",subject:{type:"experiment",id},
        state:"completed",payload:plan,result:{digest:digest.value},createdAt:at,updatedAt:at,version:1});
      return succeed({experimentId:id,digest:digest.value,caseCount:cases.length});
    });
  }

  async launch(input:{requestId:string;experimentId:string;repeatCount?:number;taskConcurrency?:number}) {
    const request = {requestId:input.requestId,kind:"launch-experiment",input,subject:{type:"experiment",id:input.experimentId}};
    const expected = digestOf({kind:request.kind,input},this.deps.hash);
    if (!expected.ok) return fromRejection(expected.error);
    const known = await this.deps.units.run("read",async r => ({
      plan:await readExperiment(r,input.experimentId), prior:await r.intents.findByRequest(input.requestId),
    }));
    type Launched = {experimentId:string;batchId:string;memberCount:number};
    if (known.prior) return known.prior.requestHash === expected.value ? succeed(known.prior.result as Launched) : fail("request-conflict","operation was already used");
    const plan = known.plan;
    if (!plan) return fail("not-found","experiment does not exist");
    const checked = new Set<string>();
    for (const item of plan.cases) {
      for (const source of [item.source,...item.materialSources]) {
        const key = JSON.stringify([item.repository.repositoryPath,source]);
        if (checked.has(key)) continue;
        const {observation} = await this.deps.repairs.current(source.runId,{id:source.deliveryId,receipt:source.receipt},item.repository.repositoryPath);
        if (observation.recordedCommit !== source.commit || !["intact","ref-changed"].includes(observation.status ?? "")) {
          return fail("unavailable","the evaluation source for case " + item.key + " is unavailable");
        }
        checked.add(key);
      }
    }
    return once<Launched>(this.deps,request,async r => {
      const id = this.deps.newId();
      const batch = launchExperimentRun({id,experimentId:plan.id,suite:plan.suite,agent:plan.agent,caseKeys:plan.cases.map(c=>c.key),
        repeatCount:input.repeatCount ?? 1, taskConcurrency:input.taskConcurrency ?? 5,at:this.deps.now()},this.deps.hash);
      if (!batch.ok) return fromRejection(batch.error);
      await r.experiments.create(batch.value.state);
      return succeed({experimentId:plan.id,batchId:id,memberCount:batch.value.state.members.length});
    });
  }

  async show(id:string) {
    return this.deps.units.run("read",async r => {
      const plan = await readExperiment(r,id);
      if (!plan) return fail("not-found","experiment does not exist");
      const launches = await r.intents.listForSubject("launch-experiment","experiment",id);
      return succeed({plan,batches:launches.map(row=>row.result as {batchId:string;memberCount:number})});
    });
  }
}
