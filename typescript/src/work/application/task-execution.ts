import {readArtifact} from "./artifacts.js";
// TaskExecution for work done by the caller's own agent, or by nobody (a person
// supplies the manifest). Managed workers arrive with phase P4.
//
// Every write takes a request identity and is applied once (see requests.ts).
// Expected refusals come back as an Outcome; storage damage is thrown.
import {
  acceptanceOf, addBranch, completeClose, continueWork, createTaskRun, criteriaDigest, declareExternalStop, digestOf, importTranscript, isId, parseTaskContent, refOf, registerExternalWorker,
  requestClose, requestCancel, selectHead, start, startWork, submitManifest, workConclusion,
  isTerminal, type AcceptanceConclusion, type DeliveryItem, type Digest, type Id, type JsonValue, type Result, type Retention, type Revision, type TaskRun, type TaskRunStatus, type Work, type WorkConclusion, type WorkerMode,
  type Decision, type Hasher,
} from "../domain/index.js";
import type { Clock, DeliveryReceiptPort, IdSource, WorkRepositories, WorkUnitOfWork } from "../ports/index.js";
import { fail, failureOf, fromRejection, succeed, type Outcome } from "./outcome.js";
import { inheritedEnvironment, selectRetainedSandbox, transferToRun, type SandboxChoice } from "./sandbox-transfer.js";
import { runEnvironment } from "./environment-definitions.js";
import { once, type RequestContext } from "./requests.js";

import type { AgentDefinitions, AgentSelection } from "./agent-definitions.js";

export interface TaskExecutionDependencies {
  readonly agents?: AgentDefinitions;
  readonly recovery?: import("./sandbox-recovery.js").SandboxRecovery;
  readonly lifecycle?: import("./sandbox-lifecycle.js").SandboxLifecycle;
  readonly units: WorkUnitOfWork;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly receipts: DeliveryReceiptPort;
  readonly hash: Hasher;
}

type Agent = { id: string; name?: string; model?: string };
export type RunMode = WorkerMode;

export type StartedRun = { executionId?: string; workId: Id; runId: Id; taskRevisionId: Id; workerMode: RunMode };
export type ContinuedRun = { executionId?: string; workId: Id; runId: Id; refines: Id; taskRevisionId: Id };
export type Registered = { runId: Id; sessionId: Id };
type SubmissionInput = {requestId:string;runId:Id;sessionId?:Id;items:readonly DeliveryItem[];declaresStop?:boolean};
export type Submitted = { runId: Id; status: TaskRunStatus; outcome: string; blocked: string | null };
export type Cancelled = { runId: Id; status: TaskRunStatus; outcome: string };
export type Closed = { workId: Id; status: "closing" | "closed"; blockedBy: Id[]; conclusion: WorkConclusion | null };
export type WorkView = { work: Work; runs: TaskRun[]; conclusion: WorkConclusion };
export type RunView = { run: TaskRun; acceptance: AcceptanceConclusion | null };

const needId = (name: string, value: unknown) => isId(value) ? undefined : fail("invalid", `${name} is missing or malformed`);

export class TaskExecution {
  private readonly context: RequestContext;

  constructor(private readonly deps: TaskExecutionDependencies) {
    this.context = { units: deps.units, hash: deps.hash, now: () => deps.clock.now(), newId: () => deps.ids.next() };
  }

  // ---- work ----------------------------------------------------------------

  /** Begin a work on a task: a new work whose first run is pending. */
  startWork(input: { requestId: string; taskDefinitionId: Id; taskRevisionId?: Id; environmentRevisionId?: Id; workerMode: RunMode; agent?:AgentSelection; retention?: Retention }): Promise<Outcome<StartedRun>> {
    const early = needId("requestId", input.requestId) ?? needId("taskDefinitionId", input.taskDefinitionId);
    if (early) return Promise.resolve(early);
    return once<StartedRun>(this.context, { requestId: input.requestId, kind: "start-work", input: input as unknown as JsonValue, subject: { type: "task", id: input.taskDefinitionId } }, async r => {
      const revision = await this.taskRevision(r, input.taskDefinitionId, input.taskRevisionId);
      if (!revision.ok) return revision;
      const at = this.deps.clock.now();
      const environment = await runEnvironment(r, revision.value, input.environmentRevisionId);
      if (!environment.ok) return environment;
      const workId = this.deps.ids.next(), runId = this.deps.ids.next();
      const created = createTaskRun({ id: runId, taskRevision: refOf(revision.value), ...(environment.value ? { environment: environment.value } : {}), workId, workerMode: input.workerMode, retention: input.retention ?? "keep", at });
      if (!created.ok) return fromRejection(created.error);
      const work = startWork({ id: workId, taskDefinitionId: input.taskDefinitionId, firstRunId: runId, at });
      if (!work.ok) return fromRejection(work.error);
      const agent = await this.admitAgent(r,created.value.state,input.agent);
      if (!agent.ok) return agent;
      await r.taskRuns.create(created.value.state);
      await r.works.create(work.value.state);
      return succeed({ workId, runId, taskRevisionId: revision.value.id, workerMode: input.workerMode, ...agent.value });
    });
  }

  private async admitAgent(r:WorkRepositories,run:TaskRun,selection?:AgentSelection, sandbox?:SandboxChoice) {
    if (this.deps.agents) return this.deps.agents.admit(r,run,selection,sandbox);
    return run.workerMode === "managed" || selection ? fail("unsupported","managed execution service is unavailable") : succeed({});
  }

  /** Refine the head of a work: a new run that starts from what the head delivered, and becomes the head if nobody moved it meanwhile. */
  continueWork(input: { requestId: string; workId: Id; expectedHead: Id; workerMode: RunMode; agent?:AgentSelection; taskRevisionId?: Id; environmentRevisionId?: Id; sandbox?: SandboxChoice; retention?: Retention }): Promise<Outcome<ContinuedRun>> {
    const early = needId("requestId", input.requestId) ?? needId("workId", input.workId) ?? needId("expectedHead", input.expectedHead);
    if (early) return Promise.resolve(early);
    return once<ContinuedRun>(this.context, { requestId: input.requestId, kind: "continue-work", input: input as unknown as JsonValue, subject: { type: "work", id: input.workId } }, async r => {
      const work = await r.works.get(input.workId, { lock: true });
      if (!work) return fail("not-found", `work ${input.workId} does not exist`);
      return this.refine(r, work, input.expectedHead, input, true, (w, runId, at) => continueWork(w, { newRunId: runId, expectedHead: input.expectedHead, at }));
    });
  }

  /** Refine any run of the work without moving its head. */
  addBranch(input: { requestId: string; workId: Id; refines: Id; workerMode: RunMode; agent?:AgentSelection; taskRevisionId?: Id; environmentRevisionId?: Id; sandbox?: SandboxChoice; retention?: Retention }): Promise<Outcome<ContinuedRun>> {
    const early = needId("requestId", input.requestId) ?? needId("workId", input.workId) ?? needId("refines", input.refines);
    if (early) return Promise.resolve(early);
    return once<ContinuedRun>(this.context, { requestId: input.requestId, kind: "add-branch", input: input as unknown as JsonValue, subject: { type: "work", id: input.workId } }, async r => {
      const work = await r.works.get(input.workId, { lock: true });
      if (!work) return fail("not-found", `work ${input.workId} does not exist`);
      return this.refine(r, work, input.refines, input, false, (w, runId, at) => addBranch(w, { newRunId: runId, at }));
    });
  }

  private async refine(r: WorkRepositories, work: Work, refines: Id, input: { workerMode: RunMode; agent?:AgentSelection; taskRevisionId?: Id; environmentRevisionId?: Id; sandbox?: SandboxChoice; retention?: Retention }, onHead: boolean, moveWork: (work: Work, runId: Id, at: string) => Result<Decision<Work, unknown, unknown>>): Promise<Outcome<ContinuedRun>> {
    const parent = await r.taskRuns.get(refines, { lock: true });
    if (!parent || parent.workId !== work.id) return fail("not-found", `run ${refines} is not a run of work ${work.id}`);
    const revision = await this.taskRevision(r, work.taskDefinitionId, input.taskRevisionId);
    if (!revision.ok) return revision;
    const at = this.deps.clock.now();
    const retained = await selectRetainedSandbox(r, parent, input.workerMode, input.sandbox, onHead);
    if (!retained.ok) return retained;
    const environment = retained.value ? await inheritedEnvironment(r,parent, revision.value, input.environmentRevisionId) :
      await runEnvironment(r, revision.value, input.environmentRevisionId);
    if (!environment.ok) return environment;
    const runId = this.deps.ids.next();
    const created = createTaskRun({ id: runId, taskRevision: refOf(revision.value), ...(environment.value ? { environment: environment.value } : {}), workId: work.id, refines, workerMode: input.workerMode, retention: input.retention ?? "keep", at },
      { refines: { id: parent.id, status: parent.status, taskDefinitionId: parent.taskRevision.definitionId, workId: parent.workId } });
    if (!created.ok) return fromRejection(created.error);
    const moved = moveWork(work, runId, at);
    if (!moved.ok) return fromRejection(moved.error);
    const agent = await this.admitAgent(r,created.value.state,input.agent,input.sandbox);
    if (!agent.ok) return agent;
    await r.works.save(moved.value.state, work.version);
    await r.taskRuns.create(created.value.state);
    if (retained.value) {
      const transferred = await transferToRun(r, retained.value, parent, created.value.state, runId, at);
      if (!transferred.ok) return transferred;
    }
    return succeed({ workId: work.id, runId, refines, taskRevisionId: revision.value.id, ...agent.value });
  }

  /** Put the head on another run of the work; the choice is the caller's and is never inferred. */
  selectHead(input: { requestId: string; workId: Id; runId: Id; expectedHead?: Id }): Promise<Outcome<{ workId: Id; head: Id }>> {
    const early = needId("requestId", input.requestId) ?? needId("workId", input.workId) ?? needId("runId", input.runId);
    if (early) return Promise.resolve(early);
    return once(this.context, { requestId: input.requestId, kind: "select-head", input: input as unknown as JsonValue, subject: { type: "work", id: input.workId } }, async r => {
      const work = await r.works.get(input.workId, { lock: true });
      if (!work) return fail("not-found", `work ${input.workId} does not exist`);
      const moved = selectHead(work, { runId: input.runId, ...(input.expectedHead ? { expectedHead: input.expectedHead } : {}), at: this.deps.clock.now() });
      if (!moved.ok) return fromRejection(moved.error);
      if (moved.value.state !== work) await r.works.save(moved.value.state, work.version);
      return succeed({ workId: work.id, head: input.runId });
    });
  }

  /**
   * Close the work. While runs are still active it stays "closing" and says
   * which; asking again after they ended closes it with the conclusion its head
   * showed at that moment.
   */
  async closeWork(input: { requestId: string; workId: Id }): Promise<Outcome<Closed>> {
    const early = needId("requestId", input.requestId) ?? needId("workId", input.workId);
    if (early) return Promise.resolve(early);
    if (this.deps.recovery) {
      const prepared = await this.deps.recovery.beforeClose(input.workId);
      if (!prepared.ok) return prepared;
    }
    const outcome = await once<Closed>(this.context, { requestId: input.requestId, kind: "close-work", input: input as unknown as JsonValue, subject: { type: "work", id: input.workId } }, async r => {
      const work = await r.works.get(input.workId, { lock: true });
      if (!work) return fail("not-found", `work ${input.workId} does not exist`);
      const runs = await r.taskRuns.listByWork(work.id);
      const statuses = new Map(runs.map(run => [run.id, run.status] as const));
      const at = this.deps.clock.now();
      const requested = requestClose(work, { at }, statuses);
      if (!requested.ok) return fromRejection(requested.error);
      let state = requested.value.state;
      const blockedBy = [...requested.value.outcome.blockedBy];
      if (blockedBy.length > 0) {
        if (state !== work) await r.works.save(state, work.version);
        return succeed({ workId: work.id, status: "closing", blockedBy, conclusion: null });
      }
      const conclusion = await this.conclusionOf(r, work, runs);
      for (const run of runs) {
        if (!run.sandboxId) continue;
        if (!this.deps.lifecycle) return fail("unsupported", "sandbox lifecycle service is required to close this work");
        const reserved = await this.deps.lifecycle.reserveForClose(r, run.id, run.sandboxId);
        if (!reserved.ok) return reserved;
      }
      const closed = completeClose(state, { at, conclusion, releasesReserved: true }, statuses);
      if (!closed.ok) return fromRejection(closed.error);
      if (state !== work) { await r.works.save(state, work.version); }
      if (closed.value.state !== state) await r.works.save(closed.value.state, state.version);
      state = closed.value.state;
      return succeed({ workId: work.id, status: "closed", blockedBy: [], conclusion });
    });
    if (outcome.ok && outcome.value.status === "closed" && this.deps.lifecycle) {
      const released = await this.deps.lifecycle.finishClose(input.workId);
      if (!released.ok) return released;
    }
    return outcome;
  }

  // ---- runs ----------------------------------------------------------------

  /** The caller's agent announces itself for a run; the session identity issued here must accompany what it submits. */
  registerExternalWorker(input: { requestId: string; runId: Id; agent: Agent }): Promise<Outcome<Registered>> {
    const early = needId("requestId", input.requestId) ?? needId("runId", input.runId);
    if (early) return Promise.resolve(early);
    return once<Registered>(this.context, { requestId: input.requestId, kind: "register-external-worker", input: input as unknown as JsonValue, subject: { type: "task_run", id: input.runId } }, async r => {
      const run = await r.taskRuns.get(input.runId, { lock: true });
      if (!run) return fail("not-found", `run ${input.runId} does not exist`);
      const at = this.deps.clock.now();
      const sessionId = this.deps.ids.next();
      const steps: TaskRun[] = [];
      let current = run;
      if (current.status === "pending") {
        const started = start(current, { at });
        if (!started.ok) return fromRejection(started.error);
        steps.push(started.value.state); current = started.value.state;
      }
      const registered = registerExternalWorker(current, { sessionId, agent: input.agent, at });
      if (!registered.ok) return fromRejection(registered.error);
      steps.push(registered.value.state);
      await this.saveChain(r, run, steps);
      return succeed({ runId: run.id, sessionId });
    });
  }

  /** Keep a reference to the agent's own session record. Coverage says how much of the session it holds. */
  importTranscript(input: { requestId: string; runId: Id; sessionId: Id; ref: string; digest: Digest; coverage: "full" | "partial" | "unknown" }): Promise<Outcome<{ runId: Id }>> {
    const early = needId("requestId", input.requestId) ?? needId("runId", input.runId);
    if (early) return Promise.resolve(early);
    return once(this.context, { requestId: input.requestId, kind: "import-transcript", input: input as unknown as JsonValue, subject: { type: "task_run", id: input.runId } }, async r => {
      const run = await r.taskRuns.get(input.runId, { lock: true });
      if (!run) return fail("not-found", `run ${input.runId} does not exist`);
      const next = importTranscript(run, { sessionId: input.sessionId, ref: input.ref, digest: input.digest, coverage: input.coverage, at: this.deps.clock.now() });
      if (!next.ok) return fromRejection(next.error);
      await r.taskRuns.save(next.value.state, run.version);
      return succeed({ runId: run.id });
    });
  }

  /** Reserve the exact candidate and attachments before publishing a remote tag. */
  async reservePublication(input:SubmissionInput,observeOnly=false) {
    const hash=digestOf({kind:"submit",input:input as unknown as JsonValue},this.deps.hash);
    if (!hash.ok) return false;
    return this.deps.units.run("write",async r=>{
      const run=await r.taskRuns.get(input.runId,{lock:true});
      if (!run || run.cancelIntent || run.workerMode==="managed") return false;
      if (run.workerMode==="external" && (run.worker?.kind!=="external" || run.worker.registration.sessionId!==input.sessionId)) return false;
      if (isTerminal(run)) {
        const recorded=run.manifest?.items;
        return observeOnly && !!recorded && recorded.length===input.items.length && recorded.every((item,i)=>
          item.type===input.items[i]?.type && item.id===input.items[i]?.id && item.receipt===input.items[i]?.receipt);
      }
      if (run.pendingManifest && run.pendingManifest.operationId!==input.requestId) return false;
      const prior=await r.intents.findByRequest(input.requestId);
      if (prior && prior.requestHash!==hash.value) return false;
      const owner=(await r.intents.listForSubject("submit","task_run",run.id)).find(intent=>intent.state==="registered");
      if (owner) return owner.requestHash===hash.value;
      if (prior) return false;
      const id=this.context.newId(),at=this.context.now();
      await r.intents.register({id,requestId:input.requestId,requestHash:hash.value,kind:"submit",subject:{type:"task_run",id:run.id},
        payload:input as unknown as JsonValue,state:"registered",version:1,createdAt:at,updatedAt:at,
        result:{runId:run.id,status:run.status,outcome:"awaiting-publication",blocked:null}});
      return true;
    });
  }

  /** Persist the proposal and external stop before checking its receipts outside SQL. */
  async submit(input: SubmissionInput): Promise<Outcome<Submitted>> {
    const early = needId("requestId", input.requestId) ?? needId("runId", input.runId);
    if (early) return early;
    if (input.items.length === 0) return fail("invalid", "a manifest lists at least one delivery");
    const request={requestId:input.requestId,kind:"submit",input:input as unknown as JsonValue,subject:{type:"task_run",id:input.runId}};
    const apply=async(r:WorkRepositories,run:TaskRun,check:"pending"|"accepted"|"rejected"|"unavailable"):Promise<Outcome<Submitted>>=>{
      if (run.workerMode==="managed") return fail("unsupported","a managed round delivers through its own execution");
      const at = this.deps.clock.now();
      const taskRevision = await r.definitions.getRevision(run.taskRevision.definitionId,run.taskRevision.revisionId);
      const task = parseTaskContent(taskRevision?.content);
      if (!task.ok) return fromRejection(task.error);
      const publication=(await r.intents.listForSubject("submit","task_run",run.id)).find(intent=>intent.state==="registered");
      if (publication) {
        const hash=digestOf({kind:"submit",input:input as unknown as JsonValue},this.deps.hash);
        if (!hash.ok || hash.value!==publication.requestHash) return fail("conflict","another submission owns the reserved publication");
      }
      if (check==="pending" && !publication && (task.value.outputs || task.value.kind === "working" || input.items.some(item=>item.type === "artifact")) && !run.cancelIntent) {
        if (task.value.kind === "coding" && !input.items.some(item=>item.type === "candidate")) return fail("invalid","coding tasks require a candidate");
        const slots = new Set<string>();
        for (const item of input.items) {
          if (item.type !== "artifact") {
            if (task.value.kind === "working") return fail("invalid","working tasks deliver artifacts");
            continue;
          }
          const saved = await readArtifact(r,item.id);
          if (!saved || saved.runId !== run.id || saved.receipt !== item.receipt || slots.has(saved.slot)) return fail("invalid","a selected artifact is missing, duplicated or belongs to another run");
          slots.add(saved.slot);
        }
        if (task.value.outputs?.some(slot=>slot.required && !slots.has(slot.key))) return fail("invalid","the manifest is missing a required output");
      }
      const steps: TaskRun[] = [];
      let current = run;
      if (current.status === "pending" && current.workerMode === "none") {
        const started = start(current, { at });
        if (!started.ok) return fromRejection(started.error);
        steps.push(started.value.state); current = started.value.state;
      }
      const digest = digestOf([...input.items].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)).map(i => ({ type: i.type, id: i.id, receipt: i.receipt })), this.deps.hash);
      if (!digest.ok) return fromRejection(digest.error);
      const submitted = submitManifest(current, {
        origin: current.workerMode === "external" ? "external" : "caller", operationId: input.requestId, check, at, items: input.items, digest: digest.value,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.declaresStop ? { declaresStop: true } : {}),
      });
      if (!submitted.ok) return fromRejection(submitted.error);
      steps.push(submitted.value.state);
      await this.saveChain(r, run, steps);
      const final = submitted.value.state;
      return succeed({ runId: run.id, status: final.status, outcome: check==="pending" && final.pendingManifest ? "pending-receipt" : String(submitted.value.outcome), blocked: final.blocked?.reason ?? null });
    };
    let changed=await once<Submitted>(this.context,request,async r=>{
      const run=await r.taskRuns.get(input.runId,{lock:true});
      return run ? apply(r,run,"pending") : fail("not-found","task run does not exist");
    });
    if (changed.ok && changed.value.outcome==="awaiting-publication") {
      changed=await this.deps.units.run("write",async r=>{
        const run=await r.taskRuns.get(input.runId,{lock:true});
        const intent=await r.intents.findByRequest(input.requestId);
        if (!run || !intent) return fail("conflict","publication reservation is missing");
        if (intent.state!=="registered") return succeed(intent.result as Submitted);
        const next=await apply(r,run,"pending");
        if (!next.ok) return next;
        await r.intents.save({...intent,state:"completed",result:next.value,updatedAt:this.deps.clock.now(),version:intent.version+1},intent.version);
        return next;
      });
    }
    const awaitingReceipt=(result:Submitted)=>result.outcome==="pending-receipt" || result.blocked==="receipt-unavailable";
    if (changed.ok && awaitingReceipt(changed.value)) {
      const run=await this.deps.units.run("read",r=>r.taskRuns.get(input.runId));
      const check=run && isTerminal(run) ? "unavailable" : await this.deps.receipts.check(input.items);
      changed=await this.deps.units.run("write",async r=>{
        const run=await r.taskRuns.get(input.runId,{lock:true}),intent=await r.intents.findByRequest(input.requestId);
        if (!run || !intent) return fail("conflict","pending submission is missing");
        const previous=intent.result as Submitted;
        if (!awaitingReceipt(previous)) return succeed(previous);
        if (!isTerminal(run) && run.pendingManifest?.operationId!==input.requestId) return fail("conflict","another submission owns the pending manifest");
        if (!isTerminal(run) && check==="unavailable" && previous.blocked==="receipt-unavailable") return succeed(previous);
        const next=isTerminal(run) ? succeed({runId:run.id,status:run.status,outcome:run.status==="cancelled" ? "cancel-wins" : "already-terminal",blocked:null}) : await apply(r,run,check);
        if (!next.ok) return next;
        await r.intents.save({...intent,result:next.value,updatedAt:this.deps.clock.now(),version:intent.version+1},intent.version);
        return next;
      });
    }
    return this.afterTerminal(changed);
  }

  async reconcileSubmission(runId:Id):Promise<Outcome<Submitted|null>> {
    const found=await this.deps.units.run("write",async r=>{
      const run=await r.taskRuns.get(runId,{lock:true});
      if (!run) return fail("not-found","task run does not exist");
      if (!run.pendingManifest) {
        const submissions=await r.intents.listForSubject("submit","task_run",runId);
        const publication=submissions.find(intent=>intent.state==="registered");
        if (publication) {
          if (!isTerminal(run)) return succeed({publication:publication.payload as unknown as SubmissionInput});
          const terminal={runId,status:run.status,outcome:run.status==="cancelled" ? "cancel-wins" : "already-terminal",blocked:null};
          await r.intents.save({...publication,state:"completed",result:terminal,updatedAt:this.deps.clock.now(),version:publication.version+1},publication.version);
          return succeed({terminal});
        }
        if (isTerminal(run) && (run.sandboxId || submissions.length || run.manifest)) return succeed({settle:true});
        return succeed(null);
      }
      const intent=await r.intents.findByRequest(run.pendingManifest.operationId);
      if (intent?.kind!=="submit" || intent.subject.id!==runId) return fail("conflict","pending submission is missing");
      return succeed({submission:intent.payload as unknown as SubmissionInput});
    });
    if (!found.ok) return found;
    if (found.value && "terminal" in found.value) return this.afterTerminal(succeed(found.value.terminal));
    if (found.value && "settle" in found.value && this.deps.lifecycle) {
      const settled=await this.deps.lifecycle.settleRun(runId);
      if (!settled.ok) return settled;
    }
    if (found.value && "publication" in found.value) {
      const input=found.value.publication;
      if (await this.deps.receipts.check(input.items.filter(item=>item.type==="candidate"))!=="accepted") return fail("unavailable","publication is unconfirmed; retry delivery with its original operation ID");
      return this.submit(input);
    }
    return found.value && "submission" in found.value ? this.submit(found.value.submission) : succeed(null);
  }

  /** The external agent says it has stopped (or the human did); a cancellation waiting on it can now complete. */
  async declareStop(input: { requestId: string; runId: Id; reason: "human" | "abandoned"; sessionId?: Id }): Promise<Outcome<Cancelled>> {
    const early = needId("requestId", input.requestId) ?? needId("runId", input.runId);
    if (early) return Promise.resolve(early);
    const changed = await once<Cancelled>(this.context, { requestId: input.requestId, kind: "declare-stop", input: input as unknown as JsonValue, subject: { type: "task_run", id: input.runId } }, async r => {
      const run = await r.taskRuns.get(input.runId, { lock: true });
      if (!run) return fail("not-found", `run ${input.runId} does not exist`);
      const next = declareExternalStop(run, { at: this.deps.clock.now(), reason: input.reason, ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
      if (!next.ok) return fromRejection(next.error);
      if (next.value.state !== run) await r.taskRuns.save(next.value.state, run.version);
      return succeed({ runId: run.id, status: next.value.state.status, outcome: String(next.value.outcome) });
    });
    return this.afterTerminal(changed);
  }

  /** Ask for the run to be cancelled. It ends cancelled once nothing of it can still be running. */
  async cancel(input: { requestId: string; runId: Id; reason?: string }): Promise<Outcome<Cancelled>> {
    const early = needId("requestId", input.requestId) ?? needId("runId", input.runId);
    if (early) return Promise.resolve(early);
    const changed = await once<Cancelled>(this.context, { requestId: input.requestId, kind: "cancel-run", input: input as unknown as JsonValue, subject: { type: "task_run", id: input.runId } }, async r => {
      const run = await r.taskRuns.get(input.runId, { lock: true });
      if (!run) return fail("not-found", `run ${input.runId} does not exist`);
      const next = requestCancel(run, { at: this.deps.clock.now(), ...(input.reason ? { reason: input.reason } : {}) });
      if (!next.ok) return fromRejection(next.error);
      if (next.value.state !== run) await r.taskRuns.save(next.value.state, run.version);
      return succeed({ runId: run.id, status: next.value.state.status, outcome: String(next.value.outcome) });
    });
    return this.afterTerminal(changed);
  }

  private async afterTerminal<T extends {runId:string; status:TaskRunStatus}>(result: Outcome<T>): Promise<Outcome<T>> {
    if (result.ok && this.deps.lifecycle && ["cancelled","delivered","failed"].includes(result.value.status)) {
      const settled = await this.deps.lifecycle.settleRun(result.value.runId);
      if (!settled.ok) return settled;
    }
    return result;
  }

  // ---- queries -------------------------------------------------------------

  async getRun(runId: Id): Promise<Outcome<RunView>> {
    try {
      return await this.deps.units.run("read", async r => {
        const run = await r.taskRuns.get(runId);
        if (!run) return fail("not-found", `run ${runId} does not exist`);
        const acceptance = await this.acceptance(r, run);
        return succeed({ run, acceptance: acceptance ?? null });
      });
    } catch (error) { const failure = failureOf(error); if (failure) return { ok: false, error: failure }; throw error; }
  }

  async getWork(workId: Id): Promise<Outcome<WorkView>> {
    try {
      return await this.deps.units.run("read", async r => {
        const work = await r.works.get(workId);
        if (!work) return fail("not-found", `work ${workId} does not exist`);
        const runs = await r.taskRuns.listByWork(workId);
        const conclusion = work.closedFact?.conclusion ?? await this.conclusionOf(r, work, runs);
        return succeed({ work, runs, conclusion });
      });
    } catch (error) { const failure = failureOf(error); if (failure) return { ok: false, error: failure }; throw error; }
  }

  // ---- helpers -------------------------------------------------------------

  private async taskRevision(r: WorkRepositories, definitionId: Id, revisionId: Id | undefined): Promise<Outcome<Revision>> {
    const definition = await r.definitions.get(definitionId);
    if (!definition || definition.kind !== "task") return fail("not-found", `task ${definitionId} does not exist`);
    const revision = revisionId ? await r.definitions.getRevision(definitionId, revisionId) : await r.definitions.latestRevision(definitionId);
    if (!revision) return fail(revisionId ? "not-found" : "conflict", revisionId ? `revision ${revisionId} does not exist` : `task ${definitionId} has no published revision`);
    return succeed(revision);
  }

  /** What the gates recorded for this run's delivery say, read over the exact subject; undefined until it was delivered. */
  private async acceptance(r: WorkRepositories, run: TaskRun): Promise<AcceptanceConclusion | undefined> {
    if (run.status !== "delivered" || !run.manifest) return undefined;
    const revision = await r.definitions.getRevision(run.taskRevision.definitionId, run.taskRevision.revisionId);
    const task = revision && parseTaskContent(revision.content);
    const criteria = task?.ok ? criteriaDigest(task.value, this.deps.hash) : undefined;
    if (!criteria?.ok) return "pending";
    return acceptanceOf(await r.gradings.listForTaskRun(run.id), { taskRevisionId: run.taskRevision.revisionId, criteriaDigest: criteria.value, manifestDigest: run.manifest.digest }).conclusion;
  }

  /** What the work shows now: its head run's state and that run's acceptance. A head that is not among the work's runs is damaged data. */
  private async conclusionOf(r: WorkRepositories, work: Work, runs: readonly TaskRun[]): Promise<WorkConclusion> {
    const head = runs.find(run => run.id === work.head);
    if (!head) throw new Error(`work ${work.id} stands on run ${work.head}, which does not belong to it`);
    return workConclusion(head.status, await this.acceptance(r, head));
  }

  private async saveChain(r: WorkRepositories, original: TaskRun, states: readonly TaskRun[]): Promise<void> {
    let expected = original.version;
    for (const state of states) { await r.taskRuns.save(state, expected); expected = state.version; }
  }
}
