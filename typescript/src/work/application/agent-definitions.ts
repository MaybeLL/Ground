import { acceptExecution, createDefinition, digestOf, isId, isText, publishRevision, refOf, type TaskRun } from "../domain/index.js";
import type { AgentProvider, ProviderName, WorkRepositories } from "../ports/index.js";
import { fail, fromRejection, succeed } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";

export type AgentSelection = {definitionId:string; revisionId?:string; repositoryPath:string};
export type {AgentSettings,ManagedTask} from "../domain/managed.js";
import type {AgentSettings,ManagedTask} from "../domain/managed.js";

export class AgentDefinitions {
  constructor(private readonly ctx:RequestContext,private readonly providers:Record<ProviderName,AgentProvider>, private readonly source: {freezeSource(path:string, baseline:string, remote:string):Promise<{repositoryPath:string;baseline:string;remote:string}>}) {}

  publish(input:{requestId:string;name:string;provider:ProviderName;model?:string;definitionId?:string;expectedSeq:number}) {
    return once(this.ctx,{requestId:input.requestId,kind:"publish-agent",input,subject:{type:"agent",id:input.definitionId??input.requestId}},async r=>{
      if (!isId(input.requestId) || !isText(input.name,256) || !Object.hasOwn(this.providers,input.provider) ||
          (input.model!==undefined && !isText(input.model,256))) return fail("invalid","supply an agent name, supported provider and optional model");
      const id=input.definitionId??this.ctx.newId(), at=this.ctx.now();
      let definition=await r.definitions.get(id,{lock:true});
      if (!input.definitionId) {
        const created=createDefinition({id,kind:"agent",name:input.name,at});
        if (!created.ok) return fromRejection(created.error);
        definition=created.value.state; await r.definitions.create(definition);
      }
      if (definition?.kind!=="agent") return fail("not-found","agent definition does not exist");
      const content:AgentSettings={provider:input.provider,...(input.model?{model:input.model}:{})};
      const revision=publishRevision(definition,{at,expectedSeq:input.expectedSeq,content,revisionId:this.ctx.newId()},this.ctx.hash);
      if (!revision.ok) return fromRejection(revision.error);
      await r.definitions.save({...revision.value.state,name:input.name},definition.version);
      await r.definitions.addRevision(revision.value.outcome);
      return succeed({agentId:id,revisionId:revision.value.outcome.id,seq:revision.value.outcome.seq,digest:revision.value.outcome.digest});
    });
  }

  async admit(r:WorkRepositories,run:TaskRun,selection?:AgentSelection) {
    if (run.workerMode!=="managed") return selection ? fail("invalid","agent selection requires managed mode") : succeed({});
    if (!selection || !isId(selection.definitionId) || !run.environment) return fail("invalid","a managed run requires an agent and a resolved task environment");
    const revision=selection.revisionId ? await r.definitions.getRevision(selection.definitionId,selection.revisionId) : await r.definitions.latestRevision(selection.definitionId);
    if (revision?.kind!=="agent") return fail("not-found","agent revision does not exist");
    const settings=revision.content as AgentSettings;
    if (!Object.hasOwn(this.providers,settings.provider)) return fail("unsupported","agent provider is not installed");
    const at=this.ctx.now(),executionId=this.ctx.newId();
    const accepted=acceptExecution({id:executionId,owner:{type:"task_run",id:run.id},role:"worker",agentRevision:refOf(revision),
      capabilities:{...this.providers[settings.provider].capabilities,verifiableStop:true},at});
    if (!accepted.ok) return fromRejection(accepted.error);
    const task = await r.definitions.getRevision(run.taskRevision.definitionId, run.taskRevision.revisionId);
    const repository = (task?.content as {repository?: {baseline?: string; remote?: string}})?.repository;
    if (!repository?.baseline || !repository.remote) return fail("invalid", "managed coding requires a baseline and a publication remote");
    let source;
    try { source = await this.source.freezeSource(selection.repositoryPath, repository.baseline, repository.remote); }
    catch { return fail("invalid", "the managed repository, baseline or publication endpoint could not be resolved"); }
    const payload: ManagedTask = {runId: run.id, executionId, ...source};
    const hash=digestOf(payload,this.ctx.hash);
    if (!hash.ok) return fromRejection(hash.error);
    await r.executions.create(accepted.value.state);
    await r.intents.register({id:this.ctx.newId(),requestId:"managed-"+executionId,requestHash:hash.value,kind:"managed-worker",
      subject:{type:"task_run",id:run.id},state:"registered",payload,createdAt:at,updatedAt:at,version:1});
    return succeed({executionId});
  }
}
