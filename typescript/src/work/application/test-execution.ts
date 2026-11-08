import {
  parseTaskContent,acquireLease, attachGradingSandbox, authorizeBridge, digestOf, isGradingTerminal, markReady, refOf,
  completeRelease, faultGrader, markBlocked, reserve, requestSandbox, returnLease, sameRef, startCommandStep, stepStopped, submitGrade, type ProtocolRecord, type GradingRecord, type Sandbox, type CommandOutput,
} from "../domain/index.js";
import type { RuntimeLocation, WorkRepositories, TestStreams } from "../ports/index.js";
import { once, type RequestContext } from "./requests.js";
import {configuredJudge,type GateJudge,type ManagedGatePlan} from "./managed-gates.js";
import type { EnvironmentContent } from "./environment-definitions.js";
import type { TestPlan } from "./test-measurements.js";
import { agentGrader,testGrader,type TestGrader,type AgentGrader } from "./rule-definitions.js";
import { fail, fromRejection, succeed,type Outcome } from "./outcome.js";

const holder = (gradingRecordId: string, ordinal: number) => ({type: "command_step" as const, gradingRecordId, ordinal});
type Material = {path:string; role:string; digest:string; base64:string};
type Case = {key:string;taskRevision:{definitionId:string;revisionId:string}; bindings:{key:string; materials:Material[]}[]};

export class TestExecution {
  constructor(private readonly ctx: RequestContext) {}

  async context(id: string):Promise<Outcome<{grading:GradingRecord;plan:TestPlan|ManagedGatePlan;grader:TestGrader|AgentGrader|GateJudge;
    task:unknown;taskMaterials?:readonly import("../domain/index.js").MaterialRepository[];protocol?:readonly ProtocolRecord[];environment:EnvironmentContent;materials:Material[];sandbox?:Sandbox;observation?:{state:string;detail?:string}}>> {
    return this.ctx.units.run("read", async r => {
      const grading = await r.gradings.get(id);
      const [intent] = await r.intents.listForSubject(grading?.strategy==="agent" ? "run-agent-grader" : "run-test-grader","grading_record",id);
      if (!grading || !["test","agent"].includes(grading.strategy) || !intent) return fail("not-found", "managed test grading does not exist");
      if (grading.origin.type==="gate" && grading.binding) {
        const plan=intent.payload as unknown as ManagedGatePlan;
        const grader=await configuredJudge(r,grading);
        if (!grader || !("protocol" in grader)) return fail("conflict","managed verification selection changed");
        const task=await r.definitions.getRevision(grading.binding.taskRevision.definitionId,grading.binding.taskRevision.revisionId);
        const env=await r.definitions.getRevision(grader.environment.definitionId,grader.environmentRevisionId);
        if (!task || !sameRef(refOf(task),grading.binding.taskRevision) || !env) return fail("conflict","frozen verification inputs are unavailable");
        const sandbox=grading.sandboxId ? await r.sandboxes.get(grading.sandboxId) : undefined;
        const observation=(intent.payload as {observation?:{state:string;detail?:string}}).observation;
        const content=parseTaskContent(task.content);
        if (!content.ok) return fromRejection(content.error);
        const {kind,summary,criteria,outputs,materialRepositories}=content.value;
        const promptTask={kind,summary,criteria,outputs,context:(task.content as {context?:string}).context,
          materials:materialRepositories?.map(({name,commit})=>({name,commit,path:"/grounds-materials/"+name}))};
        const exec=grading.evaluator?.kind==="agent" ? await r.executions.get(grading.evaluator.executionId) : undefined;
        return succeed({grading,plan,grader,protocol:exec?.protocol ?? [],environment:env.content as EnvironmentContent,materials:[],task:promptTask,taskMaterials:materialRepositories,sandbox,observation});
      }
      const plan = intent.payload as unknown as TestPlan;
      const snapshot = await r.definitions.getRevision(plan.suite.definitionId, plan.suite.revisionId);
      const definition = await r.definitions.getRevision(grading.graderRevision.definitionId, grading.graderRevision.revisionId);
      const grader = definition && (testGrader(definition.content) ?? agentGrader(definition.content));
      if (!snapshot || !sameRef(refOf(snapshot), plan.suite) || !grader || !definition ||
          !sameRef(refOf(definition), grading.graderRevision)) return fail("conflict", "frozen suite or test grader is unavailable");
      const environment = await r.definitions.getRevision(grader.environment.definitionId, grader.environmentRevisionId);
      const item=(snapshot.content as {cases:Case[]}).cases.find(c=>c.key===plan.caseKey);
      const binding=item?.bindings.find(b=>b.key===plan.bindingKey);
      const task=grader.strategy==="agent" && item ? await r.definitions.getRevision(item.taskRevision.definitionId,item.taskRevision.revisionId) : undefined;
      if (grader.strategy==="agent" && !task) return fail("conflict","frozen task revision is missing");
      if (!environment || !sameRef(refOf(environment), grader.environment) || !binding) return fail("conflict", "frozen evaluator environment or binding is unavailable");
      const sandbox = grading.sandboxId ? await r.sandboxes.get(grading.sandboxId) : undefined;
      return succeed({grading, plan,task:task && {summary:(task.content as {summary:string}).summary,criteria:(task.content as {criteria:unknown}).criteria,context:(task.content as {context?:string}).context}, observation:(intent.payload as {observation?:{state:string;detail?:string}}).observation, grader, environment:environment.content as EnvironmentContent, materials:binding.materials, sandbox});
    });
  }

  resume(id:string,requestId:string) {
    return once(this.ctx,{requestId,kind:"resume-test-grading",input:{id},subject:{type:"grading_record",id}},async r => {
      const [job] = await r.intents.listForSubject((await r.gradings.get(id))?.strategy==="agent" ? "run-agent-grader" : "run-test-grader","grading_record",id);
      if (!job) return fail("not-found","managed test grading is missing");
      return succeed({gradingId:id});
    });
  }

  async allocate(id: string, location: RuntimeLocation) {
    return this.ctx.units.run("write", async r => {
      const grading = await r.gradings.get(id, {lock:true});
      if (!grading || !["test","agent"].includes(grading.strategy) || isGradingTerminal(grading) || grading.cancelIntent) return fail("conflict", "grading cannot acquire a sandbox");
      if (grading.sandboxId) return succeed({sandboxId:grading.sandboxId});
      const sandboxId = this.ctx.newId();
      const created = requestSandbox({id:sandboxId, owner:{type:"grading_record",id}, retention:"release", location, at:this.ctx.now()});
      if (!created.ok) return fromRejection(created.error);
      const attached = attachGradingSandbox(grading, {sandboxId});
      if (!attached.ok) return fromRejection(attached.error);
      await r.sandboxes.create(created.value.state);
      await r.gradings.save(attached.value.state, grading.version);
      return succeed({sandboxId});
    });
  }

  private async owned(r: WorkRepositories, grading: GradingRecord) {
    const sb = grading.sandboxId && await r.sandboxes.get(grading.sandboxId, {lock:true});
    return sb && sb.owner.type === "grading_record" && sb.owner.id === grading.id ? sb : undefined;
  }

  async ready(id: string, instanceId: string) {
    return this.ctx.units.run("write", async r => {
      const grading = await r.gradings.get(id, {lock:true});
      if (!grading || !["test","agent"].includes(grading.strategy) || !grading.sandboxId) return fail("conflict", "grading has no sandbox");
      const sandbox = await this.owned(r,grading);
      const revision = await r.definitions.getRevision(grading.graderRevision.definitionId, grading.graderRevision.revisionId);
      const grader = revision && (testGrader(revision.content) ?? await configuredJudge(r,grading));
      if (!sandbox || !grader) return fail("conflict", "grading setup identity changed");
      if (sandbox.runtime) return sandbox.runtime.instanceId === instanceId ? succeed({}) : fail("conflict", "grading runtime changed");
      const ready = markReady(sandbox, {workspace:{ref:sandbox.id,origin:"own"}, runtime:{instanceId,environmentRevisionId:grader.environmentRevisionId}, at:this.ctx.now()});
      if (!ready.ok) return fromRejection(ready.error);
      await r.sandboxes.save(ready.value.state,sandbox.version);
      return succeed({});
    });
  }

  async beginStep(id: string, ordinal: number) {
    return this.ctx.units.run("write", async r => {
      const grading = await r.gradings.get(id,{lock:true});
      if (!grading || grading.strategy !== "test" || grading.cancelIntent || isGradingTerminal(grading)) return fail("conflict","grading cannot start a test command");
      const sandbox = await this.owned(r,grading);
      const revision = await r.definitions.getRevision(grading.graderRevision.definitionId, grading.graderRevision.revisionId);
      const grader = revision && testGrader(revision.content);
      const argv = grader?.commands[ordinal];
      if (!sandbox?.runtime || !argv) return fail("conflict","grading sandbox or command specification is missing");
      const spec = digestOf(argv, this.ctx.hash);
      if (!spec.ok) return fromRejection(spec.error);
      const current = grading.commandSteps[ordinal];
      if (current && sandbox.lease && current.state === "running" && current.specDigest === spec.value &&
          authorizeBridge(sandbox,{holder:holder(id,ordinal),token:sandbox.lease.token}).ok) return succeed({token:sandbox.lease.token,argv});
      const at = this.ctx.now();
      const lease = acquireLease(sandbox,{holder:holder(id,ordinal),at});
      if (!lease.ok) return fromRejection(lease.error);
      const step = startCommandStep(grading,{ordinal,specDigest:spec.value,at});
      if (!step.ok) return fromRejection(step.error);
      await r.sandboxes.save(lease.value.state,sandbox.version);
      await r.gradings.save(step.value.state,grading.version);
      return succeed({token:lease.value.state.lease!.token,argv});
    });
  }

  async stopped(id: string, ordinal: number, token: number, exitCode?: number, streams?:TestStreams) {
    return this.ctx.units.run("write", async r => {
      const grading = await r.gradings.get(id,{lock:true});
      if (!grading || grading.strategy !== "test") return fail("not-found","test grading is missing");
      const sandbox = await this.owned(r,grading);
      if (!sandbox) return fail("conflict","evaluator sandbox identity changed");
      const at = this.ctx.now();
      const lease = returnLease(sandbox,{holder:holder(id,ordinal),token,stop:"verified",at});
      if (!lease.ok) return fromRejection(lease.error);
      const output:CommandOutput = {};
      for (const channel of ["stdout","stderr"] as const) {
        const stream = streams?.[channel];
        if (!stream) continue;
        const ref = {digest:stream.source.digest,byteLength:stream.source.byteLength,chunkCount:Math.ceil(stream.source.byteLength / 65536)};
        output[channel] = {...ref,complete:stream.observedBytes === ref.byteLength,
          ...(stream.observedBytes === undefined ? {} : {observedBytes:stream.observedBytes})};
      }
      const step = stepStopped(grading,{ordinal,exitCode,...(streams ? {output} : {}),at});
      if (!step.ok) return fromRejection(step.error);
      let final = step.value.state;
      if (!isGradingTerminal(final)) {
        const revision = await r.definitions.getRevision(grading.graderRevision.definitionId, grading.graderRevision.revisionId);
        const grader = revision && testGrader(revision.content);
        if (!grader) return fail("conflict","test grader revision is missing");
        if (final.commandSteps.length === grader.commands.length) {
          const passes = final.commandSteps.every(item => item.exitCode === 0);
          const grade = submitGrade(final,{grade:{form:"category",category:grader.scale.categories[passes ? 0 : 1]!},at});
          if (!grade.ok) return fromRejection(grade.error);
          final = grade.value.state;
        }
      }
      for (const stream of Object.values(streams ?? {})) await r.evidence.put(stream.source);
      await r.sandboxes.save(lease.value.state,sandbox.version);
      await r.gradings.save(step.value.state,grading.version);
      if (final !== step.value.state) await r.gradings.save(final,step.value.state.version);
      return succeed({status:final.status});
    });
  }
  async readOutput(id:string,ordinal:number,channel:string,chunk:number) {
    return this.ctx.units.run("read",async r => {
      if (channel !== "stdout" && channel !== "stderr") return fail("invalid","select stdout or stderr");
      const grading = await r.gradings.get(id);
      const ref = grading?.commandSteps[ordinal]?.output?.[channel];
      if (grading?.strategy !== "test" || !ref) return fail("not-found","no output for this grading, ordinal and stream");
      if (chunk >= ref.chunkCount) return fail("not-found","no such evaluator output chunk");
      const bytes = await r.evidence.chunk(ref.digest,chunk);
      if (!bytes) return fail("unavailable","evaluator output is missing");
      return succeed({gradingId:id,ordinal,stream:channel,chunk,...ref,bytes});
    });
  }

  async fault(id:string, detail:string) {
    return this.ctx.units.run("write", async r => {
      const grading = await r.gradings.get(id,{lock:true});
      if (!grading) return fail("not-found","grading is missing");
      if (isGradingTerminal(grading)) return succeed({});
      const sandbox = await this.owned(r,grading);
      if (sandbox?.lease) return fail("conflict","a test command still holds its sandbox");
      const ended = faultGrader(grading,{detail,at:this.ctx.now()});
      if (!ended.ok) return fromRejection(ended.error);
      await r.gradings.save(ended.value.state,grading.version);
      return succeed({});
    });
  }

  async reserveRelease(id:string) {
    return this.ctx.units.run("write",async r => {
      const grading = await r.gradings.get(id,{lock:true});
      if (!grading || !isGradingTerminal(grading)) return fail("conflict","only an ended grading releases its sandbox");
      let sandbox = await this.owned(r,grading);
      if (!sandbox || sandbox.phase === "released") return succeed(null);
      const operationId = "release-grading-" + id, at = this.ctx.now();
      if (sandbox.phase === "preparing") {
        const blocked = markBlocked(sandbox,{reason:"evaluator ended during setup",at});
        if (!blocked.ok) return fromRejection(blocked.error);
        await r.sandboxes.save(blocked.value.state,sandbox.version);
        sandbox = blocked.value.state;
      }
      const reserved = reserve(sandbox,{kind:"release",by:{type:"grading_record",id},operationId,at});
      if (!reserved.ok) throw new Error(reserved.error.message);
      if (reserved.value.state !== sandbox) await r.sandboxes.save(reserved.value.state,sandbox.version);
      return succeed({operationId});
    });
  }

  async released(id:string, operationId:string) {
    return this.ctx.units.run("write",async r => {
      const grading = await r.gradings.get(id,{lock:true});
      const sandbox = grading && await this.owned(r,grading);
      if (!sandbox || sandbox.phase === "released") return succeed({});
      const done = completeRelease(sandbox,{operationId,workspace:"removed",at:this.ctx.now()});
      if (!done.ok) return fromRejection(done.error);
      await r.sandboxes.save(done.value.state,sandbox.version);
      return succeed({});
    });
  }

  async note(id:string,state:string,detail?:string) {
    await this.ctx.units.run("write",async r => {
      const [intent] = await r.intents.listForSubject((await r.gradings.get(id))?.strategy==="agent" ? "run-agent-grader" : "run-test-grader","grading_record",id);
      if (!intent) return;
      const observation = {state,...(detail ? {detail} : {})};
      const payload = intent.payload as Record<string,import("../domain/index.js").JsonValue>;
      if (JSON.stringify(payload.observation) === JSON.stringify(observation) || intent.state === "completed") return;
      await r.intents.save({...intent,payload:{...payload,observation},state:state === "terminal" ? "completed" : intent.state,
        updatedAt:this.ctx.now(),version:intent.version+1},intent.version);
    });
  }

}
