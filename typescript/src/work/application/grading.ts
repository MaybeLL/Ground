// Gates: the independent acceptance of a delivered run, judged by an external
// evaluator (a fresh session of the caller's own agent). Agent-managed and test
// graders arrive with phase P4; measures with phase P3.
import {
  createGrading, criteriaDigest, declareExternalEvaluatorStop, digestOf, isId, materialsDigest, parseTaskContent, recordEvaluatorCommand, recordEvaluatorStage, registerExternalEvaluator,
  requestGradingCancel, submitGrade, type CommandObservation, type Digest, type GradingRecord, type Grade, type Hasher, type Id, type JsonValue, type ProtocolStage, type TargetRef, type TaskRun, type TraceBlob,
} from "../domain/index.js";
import type { Clock, IdSource, WorkRepositories, WorkUnitOfWork } from "../ports/index.js";
import { GRADING_REQUEST_COUNTER, StorageFailure } from "../ports/index.js";
import { ensureVerificationGrader } from "./builtin-grader.js";
import { fail, failureOf, fromRejection, succeed, type Outcome } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";

export interface GradingDependencies { readonly units: WorkUnitOfWork; readonly clock: Clock; readonly ids: IdSource; readonly hash: Hasher }

export type GateRequested = { gradingId: Id; requestSeq: number; taskRunId: Id; criteria: { id: Id; statement: string }[] };
export type EvaluatorRegistered = { gradingId: Id; sessionId: Id };
export type GradingState = { gradingId: Id; status: GradingRecord["status"]; outcome: string };

const needId = (name: string, value: unknown) => isId(value) ? undefined : fail("invalid", `${name} is missing or malformed`);

async function gateEvidence(r:WorkRepositories,run:TaskRun) {
  const evidence = new Map<string,TraceBlob>();
  if (run.worker?.kind === "external") for (const entry of run.worker.registration.transcripts) {
    const raw=entry.trace?.raw ?? entry.raw;
    if (raw) evidence.set("transcript:" + entry.digest,raw);
    if (entry.trace) evidence.set("events:" + entry.digest,entry.trace.events);
  }
  if(run.worker?.kind==="managed"){
    const job=(await r.intents.listForSubject("managed-worker","task_run",run.id))[0];
    const recorded=job?.payload as {executionId?:string;trace?:import("../domain/index.js").FrozenTrace}|undefined;
    if(recorded?.executionId===run.worker.executionId && recorded.trace){
      evidence.set("transcript:"+recorded.trace.raw.digest,recorded.trace.raw);
      evidence.set("events:"+recorded.trace.raw.digest,recorded.trace.events);
    }
  }
  return evidence;
}

function evidenceFingerprint(evidence:Map<string,TraceBlob>,hash:Hasher) {
  return digestOf([...evidence].sort(([a],[b])=>a.localeCompare(b)).map(([id,ref])=>({id,...ref})),hash);
}

export class Grading {
  private readonly context: RequestContext;

  constructor(private readonly deps: GradingDependencies) {
    this.context = { units: deps.units, hash: deps.hash, now: () => deps.clock.now(), newId: () => deps.ids.next() };
  }

  /**
   * Ask for an independent acceptance of a delivered run. The gate is bound to
   * the exact task revision, criteria, manifest, grader and materials, and is
   * numbered by the ledger so the latest request is the one that counts.
   */
  async requestGate(input: { requestId: string; taskRunId: Id; materials?: { id: Id; digest: Digest }[] }): Promise<Outcome<GateRequested>> {
    const early = needId("requestId", input.requestId) ?? needId("taskRunId", input.taskRunId);
    if (early) return Promise.resolve(early);
    const snapshot=await this.deps.units.run("read",async r=>{
      if (await r.intents.findByRequest(input.requestId)) return succeed(null);
      const run=await r.taskRuns.get(input.taskRunId);
      if (!run) return fail("not-found","task run does not exist");
      if (run.status!=="delivered") return fail("conflict","only a delivered run can be accepted");
      const evidence=await gateEvidence(r,run);
      return succeed(evidence);
    });
    if (!snapshot.ok) return snapshot;
    const checked=snapshot.value ?? new Map<string,TraceBlob>();
    try {
      for (const ref of checked.values()) await this.deps.units.verifyEvidence(ref);
    } catch (error) {
      if (error instanceof StorageFailure && error.reason==="integrity") return fail("unavailable","archived transcript evidence is incomplete");
      throw error;
    }
    const checkedFingerprint=evidenceFingerprint(checked,this.deps.hash);
    if (!checkedFingerprint.ok) return fromRejection(checkedFingerprint.error);
    return once<GateRequested>(this.context, { requestId: input.requestId, kind: "request-gate", input: input as unknown as JsonValue, subject: { type: "task_run", id: input.taskRunId } }, async r => {
      const run = await r.taskRuns.get(input.taskRunId);
      if (!run) return fail("not-found", `run ${input.taskRunId} does not exist`);
      if (run.status !== "delivered" || !run.manifest) return fail("conflict", `run ${run.id} is ${run.status}; only a delivered run can be accepted`);
      const revision = await r.definitions.getRevision(run.taskRevision.definitionId, run.taskRevision.revisionId);
      const task = revision && parseTaskContent(revision.content);
      if (!task?.ok) return fail("conflict", "the run's task revision cannot be read");
      const criteria = criteriaDigest(task.value, this.deps.hash);
      if (!criteria.ok) return fromRejection(criteria.error);
      if (task.value.criteria.length === 0) return fail("conflict", "the task has no criteria to judge");
      const materials = [...(input.materials ?? [])];
      if (new Set(materials.map(m=>m.id)).size !== materials.length) return fail("invalid","grading material identities must be unique");
      const evidence=await gateEvidence(r,run);
      const fingerprint=evidenceFingerprint(evidence,this.deps.hash);
      if (!fingerprint.ok) return fromRejection(fingerprint.error);
      if (fingerprint.value!==checkedFingerprint.value) return fail("stale","the run's transcript evidence changed during verification");
      if (materials.some(m=>/^(transcript|events):/.test(m.id) && !evidence.has(m.id))) return fail("invalid","transcript materials must refer to evidence archived for this run");
      for (const [id,ref] of evidence) {
        const digest=ref.digest;
        const supplied = materials.find(m=>m.id === id);
        if (supplied && supplied.digest !== digest) return fail("invalid","explicit material conflicts with frozen transcript evidence");
        if (!supplied) materials.push({id,digest});
      }
      const materialsFingerprint = materialsDigest(materials, this.deps.hash);
      if (!materialsFingerprint.ok) return fromRejection(materialsFingerprint.error);
      const targets: TargetRef[] = [];
      for (const item of run.manifest.items) {
        const digest = digestOf({ type: item.type, id: item.id, receipt: item.receipt }, this.deps.hash);
        if (!digest.ok) return fromRejection(digest.error);
        targets.push({ type: item.type, id: item.id, digest: digest.value });
      }
      const at = this.deps.clock.now();
      const grader = await ensureVerificationGrader(r, this.deps.hash, at);
      if (!grader.ok) return grader;
      const requestSeq = await r.sequences.next(GRADING_REQUEST_COUNTER);
      const gradingId = this.deps.ids.next();
      const created = createGrading({
        id: gradingId, purpose: "gate", origin: { type: "gate", taskRunId: run.id }, requestSeq, targets, graderRevision: grader.value, grader: { strategy: "agent", scale: { form: "criteria" } }, materials,
        binding: { taskRevision: run.taskRevision, criteriaDigest: criteria.value, manifestDigest: run.manifest.digest, graderRevision: grader.value, materialsDigest: materialsFingerprint.value, ...(evidence.size ? {archivedEvidenceDigest:fingerprint.value} : {}), expectedCriteria: task.value.criteria.map(c => c.id) }, at,
      });
      if (!created.ok) return fromRejection(created.error);
      await r.gradings.create(created.value.state);
      return succeed({ gradingId, requestSeq, taskRunId: run.id, criteria: task.value.criteria.map(c => ({ id: c.id, statement: c.statement })) });
    });
  }

  /**
   * A fresh session of the caller's agent takes the evaluation. The session is
   * issued now, which is after the delivery was frozen, and it must not be the
   * session that did the work.
   */
  registerExternalEvaluator(input: { requestId: string; gradingId: Id; agent: { id: string } }): Promise<Outcome<EvaluatorRegistered>> {
    const early = needId("requestId", input.requestId) ?? needId("gradingId", input.gradingId);
    if (early) return Promise.resolve(early);
    return once<EvaluatorRegistered>(this.context, { requestId: input.requestId, kind: "register-external-evaluator", input: input as unknown as JsonValue, subject: { type: "grading", id: input.gradingId } }, async r => {
      const grading = await r.gradings.get(input.gradingId, { lock: true });
      if (!grading) return fail("not-found", `grading ${input.gradingId} does not exist`);
      const run = grading.origin.type === "gate" ? await r.taskRuns.get(grading.origin.taskRunId) : undefined;
      if (!run?.manifest) return fail("conflict", "the graded run has no frozen delivery");
      const at = this.deps.clock.now();
      const sessionId = this.deps.ids.next();
      const next = registerExternalEvaluator(grading, {
        sessionId, agentId: input.agent.id, ...(run.worker?.kind === "external" ? { workerSessionId: run.worker.registration.sessionId } : {}), sessionIssuedAt: at, targetsFrozenAt: run.manifest.frozenAt, at,
      });
      if (!next.ok) return fromRejection(next.error);
      await r.gradings.save(next.value.state, grading.version);
      return succeed({ gradingId: grading.id, sessionId });
    });
  }

  /** Record that the evaluator reached a stage of the protocol (blind, freeze, reconcile, handoff, submit). */
  recordStage(input: { requestId: string; gradingId: Id; sessionId: Id; stage: ProtocolStage; blindDigest?: Digest }): Promise<Outcome<GradingState>> {
    return this.mutate(input.requestId, input.gradingId, "record-stage", input, grading => recordEvaluatorStage(grading, {
      sessionId: input.sessionId, stage: input.stage, ...(input.blindDigest ? { blindDigest: input.blindDigest } : {}), at: this.deps.clock.now() }));
  }

  /** Record a command the evaluator ran through a supported entry. */
  recordCommand(input: { requestId: string; gradingId: Id; sessionId: Id; observation: CommandObservation }): Promise<Outcome<GradingState>> {
    return this.mutate(input.requestId, input.gradingId, "record-command", input, grading => recordEvaluatorCommand(grading, { sessionId: input.sessionId, observation: input.observation }));
  }

  /**
   * The evaluator's verdict for every criterion. The blind result must have
   * been frozen first: what the evaluator found on its own is fixed before it
   * sees the claims, and cannot be rewritten afterwards.
   */
  submitGrade(input: { requestId: string; gradingId: Id; sessionId: Id; grade: Grade }): Promise<Outcome<GradingState>> {
    const early = needId("requestId", input.requestId) ?? needId("gradingId", input.gradingId);
    if (early) return Promise.resolve(early);
    return once<GradingState>(this.context, { requestId: input.requestId, kind: "submit-grade", input: input as unknown as JsonValue, subject: { type: "grading", id: input.gradingId } }, async r => {
      const grading = await r.gradings.get(input.gradingId, { lock: true });
      if (!grading) return fail("not-found", `grading ${input.gradingId} does not exist`);
      if (grading.strategy === "test") return fail("forbidden","a test grade is computed from its frozen commands");
      const evaluator = grading.evaluator;
      if (grading.status === "running" && grading.purpose === "gate" && evaluator?.kind === "external" && evaluator.sessionId === input.sessionId
        && !(evaluator.protocol ?? []).some(p => p.stage === "freeze")) return fail("conflict", "freeze the blind assessment before submitting the verdict");
      const prior = grading.origin.type === "gate" ? await r.gradings.listForTaskRun(grading.origin.taskRunId) : [];
      const next = submitGrade(grading, { grade: input.grade, sessionId: input.sessionId, at: this.deps.clock.now() }, { priorGates: prior.filter(g => g.id !== grading.id) });
      if (!next.ok) return fromRejection(next.error);
      if (next.value.state !== grading) await r.gradings.save(next.value.state, grading.version);
      return succeed({ gradingId: grading.id, status: next.value.state.status, outcome: String(next.value.outcome) });
    });
  }

  /** The evaluator says it has stopped (or the human did); a cancellation waiting on it can now complete. */
  declareEvaluatorStop(input: { requestId: string; gradingId: Id; sessionId?: Id }): Promise<Outcome<GradingState>> {
    return this.mutate(input.requestId, input.gradingId, "declare-evaluator-stop", input, grading => declareExternalEvaluatorStop(grading, { at: this.deps.clock.now(), ...(input.sessionId ? { sessionId: input.sessionId } : {}) }));
  }

  cancel(input: { requestId: string; gradingId: Id }): Promise<Outcome<GradingState>> {
    return this.mutate(input.requestId, input.gradingId, "cancel-grading", input, grading => requestGradingCancel(grading, { at: this.deps.clock.now() }));
  }

  // ---- queries -------------------------------------------------------------

  async getGrading(gradingId: Id): Promise<Outcome<GradingRecord>> {
    try {
      return await this.deps.units.run("read", async r => {
        const grading = await r.gradings.get(gradingId);
        return grading ? succeed(grading) : fail("not-found", `grading ${gradingId} does not exist`);
      });
    } catch (error) { const failure = failureOf(error); if (failure) return { ok: false, error: failure }; throw error; }
  }

  /** Every gate of a run, oldest request first. */
  async listGates(taskRunId: Id): Promise<Outcome<GradingRecord[]>> {
    try {
      return await this.deps.units.run("read", async r => succeed((await r.gradings.listForTaskRun(taskRunId)).filter(g => g.purpose === "gate")));
    } catch (error) { const failure = failureOf(error); if (failure) return { ok: false, error: failure }; throw error; }
  }

  private mutate(requestId: string, gradingId: Id, kind: string, input: object, change: (grading: GradingRecord) => ReturnType<typeof submitGrade>): Promise<Outcome<GradingState>> {
    const early = needId("requestId", requestId) ?? needId("gradingId", gradingId);
    if (early) return Promise.resolve(early);
    return once<GradingState>(this.context, { requestId, kind, input: input as unknown as JsonValue, subject: { type: "grading", id: gradingId } }, async (r: WorkRepositories) => {
      const grading = await r.gradings.get(gradingId, { lock: true });
      if (!grading) return fail("not-found", `grading ${gradingId} does not exist`);
      const next = change(grading);
      if (!next.ok) return fromRejection(next.error);
      if (next.value.state !== grading) await r.gradings.save(next.value.state, grading.version);
      return succeed({ gradingId, status: next.value.state.status, outcome: String(next.value.outcome) });
    });
  }
}
