// TaskExecution for work done by the caller's own agent, or by nobody (a person
// supplies the manifest). Managed workers arrive with phase P4.
//
// Every write takes a request identity and is applied once (see requests.ts).
// Expected refusals come back as an Outcome; storage damage is thrown.
import {
  acceptanceOf, addBranch, completeClose, continueWork, createTaskRun, criteriaDigest, declareExternalStop, digestOf, importTranscript, isId, parseTaskContent, refOf, registerExternalWorker,
  requestClose, requestCancel, selectHead, start, startWork, submitManifest, workConclusion,
  type AcceptanceConclusion, type DeliveryItem, type Digest, type Id, type JsonValue, type Result, type Retention, type Revision, type TaskRun, type TaskRunStatus, type Work, type WorkConclusion, type WorkerMode,
  type Decision, type Hasher,
} from "../domain/index.js";
import type { Clock, DeliveryReceiptPort, IdSource, WorkRepositories, WorkUnitOfWork } from "../ports/index.js";
import { fail, failureOf, fromRejection, succeed, type Outcome } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";

export interface TaskExecutionDependencies {
  readonly units: WorkUnitOfWork;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly receipts: DeliveryReceiptPort;
  readonly hash: Hasher;
}

type Agent = { id: string; name?: string; model?: string };
export type RunMode = Exclude<WorkerMode, "managed">;

export type StartedRun = { workId: Id; runId: Id; taskRevisionId: Id; workerMode: RunMode };
export type ContinuedRun = { workId: Id; runId: Id; refines: Id; taskRevisionId: Id };
export type Registered = { runId: Id; sessionId: Id };
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
  startWork(input: { requestId: string; taskDefinitionId: Id; taskRevisionId?: Id; workerMode: RunMode; retention?: Retention }): Promise<Outcome<StartedRun>> {
    const early = needId("requestId", input.requestId) ?? needId("taskDefinitionId", input.taskDefinitionId);
    if (early) return Promise.resolve(early);
    return once<StartedRun>(this.context, { requestId: input.requestId, kind: "start-work", input: input as unknown as JsonValue, subject: { type: "task", id: input.taskDefinitionId } }, async r => {
      const revision = await this.taskRevision(r, input.taskDefinitionId, input.taskRevisionId);
      if (!revision.ok) return revision;
      const at = this.deps.clock.now();
      const workId = this.deps.ids.next(), runId = this.deps.ids.next();
      const created = createTaskRun({ id: runId, taskRevision: refOf(revision.value), workId, workerMode: input.workerMode, retention: input.retention ?? "keep", at });
      if (!created.ok) return fromRejection(created.error);
      const work = startWork({ id: workId, taskDefinitionId: input.taskDefinitionId, firstRunId: runId, at });
      if (!work.ok) return fromRejection(work.error);
      await r.taskRuns.create(created.value.state);
      await r.works.create(work.value.state);
      return succeed({ workId, runId, taskRevisionId: revision.value.id, workerMode: input.workerMode });
    });
  }

  /** Refine the head of a work: a new run that starts from what the head delivered, and becomes the head if nobody moved it meanwhile. */
  continueWork(input: { requestId: string; workId: Id; expectedHead: Id; workerMode: RunMode; taskRevisionId?: Id; retention?: Retention }): Promise<Outcome<ContinuedRun>> {
    const early = needId("requestId", input.requestId) ?? needId("workId", input.workId) ?? needId("expectedHead", input.expectedHead);
    if (early) return Promise.resolve(early);
    return once<ContinuedRun>(this.context, { requestId: input.requestId, kind: "continue-work", input: input as unknown as JsonValue, subject: { type: "work", id: input.workId } }, async r => {
      const work = await r.works.get(input.workId, { lock: true });
      if (!work) return fail("not-found", `work ${input.workId} does not exist`);
      return this.refine(r, work, input.expectedHead, input, (w, runId, at) => continueWork(w, { newRunId: runId, expectedHead: input.expectedHead, at }));
    });
  }

  /** Refine any run of the work without moving its head. */
  addBranch(input: { requestId: string; workId: Id; refines: Id; workerMode: RunMode; taskRevisionId?: Id; retention?: Retention }): Promise<Outcome<ContinuedRun>> {
    const early = needId("requestId", input.requestId) ?? needId("workId", input.workId) ?? needId("refines", input.refines);
    if (early) return Promise.resolve(early);
    return once<ContinuedRun>(this.context, { requestId: input.requestId, kind: "add-branch", input: input as unknown as JsonValue, subject: { type: "work", id: input.workId } }, async r => {
      const work = await r.works.get(input.workId, { lock: true });
      if (!work) return fail("not-found", `work ${input.workId} does not exist`);
      return this.refine(r, work, input.refines, input, (w, runId, at) => addBranch(w, { newRunId: runId, at }));
    });
  }

  private async refine(r: WorkRepositories, work: Work, refines: Id, input: { workerMode: RunMode; taskRevisionId?: Id; retention?: Retention }, moveWork: (work: Work, runId: Id, at: string) => Result<Decision<Work, unknown, unknown>>): Promise<Outcome<ContinuedRun>> {
    const parent = await r.taskRuns.get(refines, { lock: true });
    if (!parent || parent.workId !== work.id) return fail("not-found", `run ${refines} is not a run of work ${work.id}`);
    const revision = await this.taskRevision(r, work.taskDefinitionId, input.taskRevisionId);
    if (!revision.ok) return revision;
    const at = this.deps.clock.now();
    const runId = this.deps.ids.next();
    const created = createTaskRun({ id: runId, taskRevision: refOf(revision.value), workId: work.id, refines, workerMode: input.workerMode, retention: input.retention ?? "keep", at },
      { refines: { id: parent.id, status: parent.status, taskDefinitionId: parent.taskRevision.definitionId, workId: parent.workId } });
    if (!created.ok) return fromRejection(created.error);
    const moved = moveWork(work, runId, at);
    if (!moved.ok) return fromRejection(moved.error);
    await r.works.save(moved.value.state, work.version);
    await r.taskRuns.create(created.value.state);
    return succeed({ workId: work.id, runId, refines, taskRevisionId: revision.value.id });
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
  closeWork(input: { requestId: string; workId: Id }): Promise<Outcome<Closed>> {
    const early = needId("requestId", input.requestId) ?? needId("workId", input.workId);
    if (early) return Promise.resolve(early);
    return once<Closed>(this.context, { requestId: input.requestId, kind: "close-work", input: input as unknown as JsonValue, subject: { type: "work", id: input.workId } }, async r => {
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
      const closed = completeClose(state, { at, conclusion, releasesReserved: true }, statuses);
      if (!closed.ok) return fromRejection(closed.error);
      if (state !== work) { await r.works.save(state, work.version); }
      if (closed.value.state !== state) await r.works.save(closed.value.state, state.version);
      state = closed.value.state;
      return succeed({ workId: work.id, status: "closed", blockedBy: [], conclusion });
    });
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

  /**
   * Hand in what the round delivered. The archive is checked first, outside
   * any transaction; the manifest is then frozen, refused or held in a single
   * step against whatever the run looks like at that moment, so a cancellation
   * that won the race is honoured.
   */
  async submit(input: { requestId: string; runId: Id; sessionId?: Id; items: readonly DeliveryItem[]; declaresStop?: boolean }): Promise<Outcome<Submitted>> {
    const early = needId("requestId", input.requestId) ?? needId("runId", input.runId);
    if (early) return early;
    if (input.items.length === 0) return fail("invalid", "a manifest lists at least one delivery");
    const known = await this.deps.units.run("read", r => r.taskRuns.get(input.runId));
    if (!known) return fail("not-found", `run ${input.runId} does not exist`);
    if (known.workerMode === "managed") return fail("unsupported", "a managed round delivers through its own execution");
    const check = await this.deps.receipts.check(input.items);
    return once<Submitted>(this.context, { requestId: input.requestId, kind: "submit", input: input as unknown as JsonValue, subject: { type: "task_run", id: input.runId } }, async r => {
      const run = await r.taskRuns.get(input.runId, { lock: true });
      if (!run) return fail("not-found", `run ${input.runId} does not exist`);
      const at = this.deps.clock.now();
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
      return succeed({ runId: run.id, status: final.status, outcome: String(submitted.value.outcome), blocked: final.blocked?.reason ?? null });
    });
  }

  /** The external agent says it has stopped (or the human did); a cancellation waiting on it can now complete. */
  declareStop(input: { requestId: string; runId: Id; reason: "human" | "abandoned"; sessionId?: Id }): Promise<Outcome<Cancelled>> {
    const early = needId("requestId", input.requestId) ?? needId("runId", input.runId);
    if (early) return Promise.resolve(early);
    return once<Cancelled>(this.context, { requestId: input.requestId, kind: "declare-stop", input: input as unknown as JsonValue, subject: { type: "task_run", id: input.runId } }, async r => {
      const run = await r.taskRuns.get(input.runId, { lock: true });
      if (!run) return fail("not-found", `run ${input.runId} does not exist`);
      const next = declareExternalStop(run, { at: this.deps.clock.now(), reason: input.reason, ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
      if (!next.ok) return fromRejection(next.error);
      if (next.value.state !== run) await r.taskRuns.save(next.value.state, run.version);
      return succeed({ runId: run.id, status: next.value.state.status, outcome: String(next.value.outcome) });
    });
  }

  /** Ask for the run to be cancelled. It ends cancelled once nothing of it can still be running. */
  cancel(input: { requestId: string; runId: Id; reason?: string }): Promise<Outcome<Cancelled>> {
    const early = needId("requestId", input.requestId) ?? needId("runId", input.runId);
    if (early) return Promise.resolve(early);
    return once<Cancelled>(this.context, { requestId: input.requestId, kind: "cancel-run", input: input as unknown as JsonValue, subject: { type: "task_run", id: input.runId } }, async r => {
      const run = await r.taskRuns.get(input.runId, { lock: true });
      if (!run) return fail("not-found", `run ${input.runId} does not exist`);
      const next = requestCancel(run, { at: this.deps.clock.now(), ...(input.reason ? { reason: input.reason } : {}) });
      if (!next.ok) return fromRejection(next.error);
      if (next.value.state !== run) await r.taskRuns.save(next.value.state, run.version);
      return succeed({ runId: run.id, status: next.value.state.status, outcome: String(next.value.outcome) });
    });
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
