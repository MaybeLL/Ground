import { digestOf, importTranscript, isDigest, isId, type FrozenTrace } from "../domain/index.js";
import type { CapturedTrace, ProviderName, TraceCapturePort } from "../ports/index.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";

export class ProviderTraces {
  constructor(private readonly ctx: RequestContext, private readonly capture: TraceCapturePort) {}

  async import(input: { requestId: string; runId: string; sessionId: string; provider: ProviderName; digest: string }, path: string): Promise<Outcome<{runId:string;trace:FrozenTrace}>> {
    if (![input.requestId,input.runId,input.sessionId].every(isId) || !isDigest(input.digest) || !["codex","claude-code"].includes(input.provider)) return fail("invalid","expected a provider, run, external session and SHA-256 digest");
    const request = {requestId:input.requestId,subject:{type:"task_run",id:input.runId},kind:"import-provider-trace",input};
    const prior = await this.ctx.units.run("read",r=>r.intents.findByRequest(input.requestId));
    if (prior) {
      const hash = digestOf({kind:request.kind,input},this.ctx.hash);
      return hash.ok && hash.value === prior.requestHash && prior.state === "completed" ? succeed(prior.result as {runId:string;trace:FrozenTrace}) : fail("request-conflict","operation identity already used");
    }
    const target = await this.ctx.units.run("read",r=>r.taskRuns.get(input.runId));
    if (!target) return fail("not-found","run does not exist");
    if (target.worker?.kind !== "external" || target.worker.registration.sessionId !== input.sessionId) return fail("forbidden","the external worker session must match before importing a transcript");
    let trace: CapturedTrace;
    try { trace = await this.capture.capture(input.provider,path); }
    catch { return fail("invalid","provider transcript could not be captured from the selected file"); }
    try {
      if (trace.raw.digest !== input.digest) return fail("invalid","transcript bytes differ from the supplied digest");
      return await once(this.ctx,request,async r => {
        const run = await r.taskRuns.get(input.runId,{lock:true});
        if (!run) return fail("not-found","run does not exist");
        const updated = importTranscript(run,{sessionId:input.sessionId,ref:"sql-evidence:"+input.digest,digest:input.digest,coverage:"partial",trace:trace.descriptor,at:this.ctx.now()});
        if (!updated.ok) return fromRejection(updated.error);
        await r.evidence.put(trace.raw);
        await r.evidence.put(trace.events);
        if (updated.value.state !== run) await r.taskRuns.save(updated.value.state,run.version);
        return succeed({runId:input.runId,trace:trace.descriptor});
      });
    } finally { await trace.dispose(); }
  }

  async read(runId: string, digest: string, stream: string, ordinal: number) {
    if (!isId(runId) || !isDigest(digest) || !["raw","events"].includes(stream) || !Number.isSafeInteger(ordinal) || ordinal < 0) return fail("invalid","invalid trace or chunk selection");
    return this.ctx.units.run("read",async r => {
      const run = await r.taskRuns.get(runId);
      let trace: FrozenTrace | undefined;
      if(run?.worker?.kind==="external") trace=run.worker.registration.transcripts.find(t=>t.digest===digest && t.trace)?.trace;
      if(run?.worker?.kind==="managed"){
        const job=(await r.intents.listForSubject("managed-worker","task_run",run.id))[0];
        const payload=job?.payload as {executionId?:string;trace?:FrozenTrace}|undefined;
        if(payload?.executionId===run.worker.executionId && payload.trace?.raw.digest===digest) trace=payload.trace;
      }
      if (!trace) return fail("not-found","run has no archived trace with this digest");
      const ref = stream === "raw" ? trace.raw : trace.events;
      if (ordinal >= ref.chunkCount) return fail("not-found","chunk is outside the archived stream");
      const data = await r.evidence.chunk(ref.digest,ordinal);
      if (!data) return fail("unavailable","archived evidence chunk is missing");
      return succeed({runId,stream,ordinal,ref,data});
    });
  }
}
