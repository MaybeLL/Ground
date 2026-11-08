import { digestOf, importTranscript, isDigest, isId, type TranscriptImport, type FrozenTrace } from "../domain/index.js";
import type { CapturedTrace, EvidenceSource, ProviderName, TraceCapturePort } from "../ports/index.js";
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

  async importRaw(input:{requestId:string;runId:string;sessionId:string;digest:string;coverage:TranscriptImport["coverage"]},capture:()=>Promise<{source:EvidenceSource;dispose():Promise<void>}>) {
    if (![input.requestId,input.runId,input.sessionId].every(isId) || !isDigest(input.digest) || !["full","partial","unknown"].includes(input.coverage)) {
      return fail("invalid","expected a run, external session, coverage and SHA-256 digest");
    }
    const request={kind:"archive-transcript",requestId:input.requestId,subject:{type:"task_run",id:input.runId},input};
    const known=await this.ctx.units.run("read",async r=>({prior:await r.intents.findByRequest(input.requestId),run:await r.taskRuns.get(input.runId)}));
    if (known.prior) {
      const hash=digestOf({kind:request.kind,input},this.ctx.hash);
      return hash.ok && known.prior.requestHash===hash.value && known.prior.state==="completed" ? succeed({runId:input.runId}) : fail("request-conflict","operation identity already used");
    }
    if (!known.run) return fail("not-found","run does not exist");
    if (known.run.worker?.kind!=="external" || known.run.worker.registration.sessionId!==input.sessionId) return fail("forbidden","the external worker session must match before importing a transcript");
    let file:Awaited<ReturnType<typeof capture>>;
    try {file=await capture();} catch {return fail("invalid","transcript file could not be captured");}
    try {
      if (file.source.digest!==input.digest) return fail("invalid","transcript bytes differ from the supplied digest");
      return await once(this.ctx,request,async r=>{
        const run=await r.taskRuns.get(input.runId,{lock:true});
        if (!run) return fail("not-found","run does not exist");
        const raw=await r.evidence.put(file.source);
        const next=importTranscript(run,{sessionId:input.sessionId,digest:raw.digest,ref:"sql-evidence:"+raw.digest,coverage:input.coverage,raw,at:this.ctx.now()});
        if (!next.ok) return fromRejection(next.error);
        if (next.value.state!==run) await r.taskRuns.save(next.value.state,run.version);
        return succeed({runId:input.runId});
      });
    } finally {await file.dispose();}
  }

  async read(runId: string, digest: string, stream: string, ordinal: number) {
    if (!isId(runId) || !isDigest(digest) || !["raw","events"].includes(stream) || !Number.isSafeInteger(ordinal) || ordinal < 0) return fail("invalid","invalid trace or chunk selection");
    return this.ctx.units.run("read",async r => {
      const run = await r.taskRuns.get(runId);
      let trace: FrozenTrace | undefined;
      let raw:FrozenTrace["raw"]|undefined;
      if(run?.worker?.kind==="external") {
        const entries=run.worker.registration.transcripts.filter(t=>t.digest===digest);
        trace=entries.find(t=>t.trace)?.trace;
        raw=entries.find(t=>t.raw)?.raw;
      }
      if(run?.worker?.kind==="managed"){
        const job=(await r.intents.listForSubject("managed-worker","task_run",run.id))[0];
        const payload=job?.payload as {executionId?:string;trace?:FrozenTrace}|undefined;
        if(payload?.executionId===run.worker.executionId && payload.trace?.raw.digest===digest) trace=payload.trace;
      }
      const ref = stream === "raw" ? trace?.raw ?? raw : trace?.events;
      if (!ref) return fail("not-found","run has no archived trace with this digest and stream");
      if (ordinal >= ref.chunkCount) return fail("not-found","chunk is outside the archived stream");
      const data = await r.evidence.chunk(ref.digest,ordinal);
      if (!data) return fail("unavailable","archived evidence chunk is missing");
      return succeed({runId,stream,ordinal,ref,data});
    });
  }
}
