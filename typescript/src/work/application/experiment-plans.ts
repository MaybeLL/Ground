import {verifiedArtifact} from "./artifacts.js";
import {parseTaskContent} from "../domain/index.js";
import {parseGraderContent, digestOf, isText, launchExperimentRun, refOf, sameRef, type RevisionRef} from "../domain/index.js";
import type {WorkRepositories} from "../ports/index.js";
import {casesOf} from "./evaluation-suites.js";
import {runEnvironment} from "./environment-definitions.js";
import {once, type RequestContext} from "./requests.js";
import {fail, fromRejection, succeed} from "./outcome.js";
import type {ArchiveRepairs} from "./archive-repairs.js";

type Pinned = {[K in keyof RevisionRef]:RevisionRef[K]};
type ArchiveSource = {runId:string;deliveryId:string;receipt:string;commit:string|null;artifactSlot?:string};
type Requirement = {key:string;grader:Pinned;scale:{form:"numeric";min:number;max:number} | {form:"criteria"} | {form:"category";categories:string[]};materials:{id:string;digest:string}[]};
type CasePlan = {key:string;task:Pinned;environment:Pinned;source:ArchiveSource;materialSources:ArchiveSource[];
  repository:{repositoryPath:string;baseline:string;remote:string}|{repositoryPath:string;baseline:null;remote:null};requirements:Requirement[]};
export type ExperimentPlan = {id:string;name:string;suite:Pinned;agent:Pinned;cases:CasePlan[];createdAt:string};
type CaseOverride = {repositoryPath:string};
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

  async define(input:Define) {
    if (Object.values(input.overrides ?? {}).some(v=>!v || Object.keys(v).some(key=>key !== "repositoryPath") || !isText(v.repositoryPath,4096))) {
      return fail("invalid","experiment cases can select a repository path; environment revisions are resolved from task requirements");
    }
    const request = {requestId:input.requestId,kind:"define-experiment",input,subject:{type:"suite",id:input.suiteId}};
    const expected = digestOf({kind:request.kind,input},this.deps.hash);
    if (!expected.ok) return fromRejection(expected.error);
    const prior = await this.deps.units.run("read",r=>r.intents.findByRequest(input.requestId));
    if (prior) return prior.requestHash === expected.value ? succeed(prior.result as {experimentId:string;digest:string;caseCount:number}) :
      fail("request-conflict","operation was already used");
    const inputs = await this.deps.units.run("read",async r => {
      const suite = await r.definitions.getRevisionBySeq(input.suiteId,input.seq);
      if (suite?.kind !== "suite") return fail("not-found","suite revision is missing");
      const entries = [];
      for (const item of casesOf(suite)) {
        const task = await r.definitions.getRevision(item.taskRevision.definitionId,item.taskRevision.revisionId);
        const contract=parseTaskContent(task?.content);
        if (!contract.ok) return fromRejection(contract.error);
        if (contract.value.kind==="working") {
          entries.push({key:item.key,path:input.overrides?.[item.key]?.repositoryPath ?? input.repositoryPath,source:null});
          continue;
        }
        const source = (task?.content as {repository?:{remote:string;baseline:string}} | undefined)?.repository;
        if (!source?.baseline || !source.remote) return fail("invalid","a coding case requires a starting repository and baseline");
        entries.push({key:item.key,path:input.overrides?.[item.key]?.repositoryPath ?? input.repositoryPath,source});
      }
      return succeed(entries);
    });
    if (!inputs.ok) return inputs;
    const pinned = new Map<string,CasePlan["repository"]>();
    const repositories = new Map<string,CasePlan["repository"]>();
    for (const entry of inputs.value) {
      if (!entry.source) {pinned.set(entry.key,{repositoryPath:entry.path,baseline:null,remote:null});continue;}
      const identity = JSON.stringify([entry.path,entry.source.baseline,entry.source.remote]);
      try {
        const repository = repositories.get(identity) ?? await this.deps.source.freezeSource(entry.path,entry.source.baseline,entry.source.remote);
        repositories.set(identity,repository);
        pinned.set(entry.key,repository);
      }
      catch { return fail("unavailable","could not pin the starting repository for case " + entry.key); }
    }
    return once(this.deps,request,async r => {
      if (!isText(input.name,256)) return fail("invalid","provide an experiment name");
      const suite = await r.definitions.getRevisionBySeq(input.suiteId,input.seq);
      const agent = await r.definitions.getRevision(input.agentId,input.agentRevisionId);
      if (suite?.kind !== "suite" || agent?.kind !== "agent") return fail("not-found","select exact suite and agent revisions");
      const snapshot = casesOf(suite), cases:CasePlan[] = [];
      if (Object.keys(input.overrides ?? {}).some(key => !snapshot.some(c => c.key === key))) return fail("invalid","unknown evaluation case override");
      for (const item of snapshot) {
        const task = await r.definitions.getRevision(item.taskRevision.definitionId,item.taskRevision.revisionId);
        if (!task || !sameRef(refOf(task),item.taskRevision)) return fail("conflict","a frozen case task is missing");
        const environment = await runEnvironment(r,task);
        if (!environment.ok) return environment;
        if (!environment.value) return fail("invalid","a managed experiment case requires an environment");
        const repository = pinned.get(item.key)!;
        const archive = (s:ArchiveSource):ArchiveSource => ({runId:s.runId,deliveryId:s.deliveryId,receipt:s.receipt,commit:s.commit,...(s.artifactSlot ? {artifactSlot:s.artifactSlot} : {})});
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
        if (source.artifactSlot !== undefined) {
          const saved=await this.deps.units.run("read",r=>verifiedArtifact(r,source.runId,source.deliveryId,source.receipt,this.deps.hash));
          if (!saved || saved.slot!==source.artifactSlot) return fail("unavailable","the frozen artifact is unavailable");
          checked.add(key);continue;
        }
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
      const at = this.deps.now();
      await r.intents.register({id:this.deps.newId(),requestId:"drive-"+id,kind:"drive-experiment",requestHash:expected.value,
        subject:{type:"experiment_run",id},state:"registered",payload:{batchId:id},createdAt:at,updatedAt:at,version:1});
      return succeed({experimentId:plan.id,batchId:id,memberCount:batch.value.state.members.length});
    });
  }

  async show(id:string) {
    return this.deps.units.run("read",async r => {
      const plan = await readExperiment(r,id);
      if (!plan) return fail("not-found","experiment does not exist");
      const launches = await r.intents.listForSubject("launch-experiment","experiment",id);
      const batches = [];
      for (const launch of launches) {
        const result = launch.result as {experimentId:string;batchId:string;memberCount:number};
        const batch = await r.experiments.get(result.batchId);
        if (!batch) return fail("conflict","experiment launch refers to a missing batch");
        const progress = await r.experiments.memberProgress(batch.id);
        const [job] = await r.intents.listForSubject("drive-experiment","experiment_run",batch.id);
        const observation = (job?.payload as {observation?:{state:string}} | undefined)?.observation;
        batches.push({...result,createdAt:batch.createdAt,cancelRequested:!!batch.cancelIntent,state:observation?.state ?? "accepted",
          admitted:progress.filter(m=>m.runId !== null).length, delivered:progress.filter(m=>m.status === "delivered").length});
      }
      return succeed({plan,batches});
    });
  }
}

export function completionAt(at:string,state:"completed"|"cancelled"|undefined,cancelIntent?:{at:string}) {
  return {at,state:state ?? (cancelIntent && cancelIntent.at <= at ? "cancelled" : "completed")};
}
