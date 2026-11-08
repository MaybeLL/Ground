import {portableArtifactPaths} from "../domain/managed-delivery.js";
import {TestTargetFault} from "../ports/index.js";
import {digestOf,isId,isTerminal,parseTaskContent,type DeliveryItem,type Hasher,type TaskRun} from "../domain/index.js";
import {StorageFailure} from "../ports/index.js";
import type {EvidenceRef,EvidenceSource,WorkRepositories} from "../ports/index.js";
import {fail,succeed} from "./outcome.js";
import {once,type RequestContext} from "./requests.js";

export type SavedArtifact = {
  id:string; runId:string; slot:string; receipt:string; sessionId?:string; executionId?:string;
  files:{path:string;content:EvidenceRef}[];
};
export type ArtifactSource = EvidenceSource;
export type InputFile = {path:string;source:EvidenceSource};

function matchesReceipt(saved:SavedArtifact,runId:string,receipt:string,hash:Hasher) {
  if (saved.runId!==runId || saved.receipt!==receipt) return false;
  const files=saved.files.map(({path,content})=>({path,digest:content.digest,byteLength:content.byteLength}));
  const digest=digestOf({runId,slot:saved.slot,files},hash);
  return digest.ok && receipt==="artifact:"+digest.value;
}

export async function selectCaseTarget(r:WorkRepositories,run:TaskRun|undefined,slot:string|undefined,hash:Hasher) {
  let unknown=false;
  for (const item of run?.manifest?.items ?? []) {
    if (slot===undefined) {
      if (item.type==="candidate") return {item,unknown:false};
    } else if (item.type==="artifact") {
      const saved=await readArtifact(r,item.id);
      if (!saved || !matchesReceipt(saved,run!.id,item.receipt,hash)) unknown=true;
      else if (saved.slot===slot) return {item,unknown:false};
    }
  }
  return {item:undefined,unknown};
}

export async function archiveFiles(r:WorkRepositories,ctx:RequestContext,owner:{runId:string;slot:string;id:string;sessionId?:string;executionId?:string},files:InputFile[]) {
  const ordered=[...files].sort((a,b)=>a.path<b.path ? -1 : a.path>b.path ? 1 : 0);
  const described=ordered.map(({path,source})=>({path,digest:source.digest,byteLength:source.byteLength}));
  const digest=digestOf({runId:owner.runId,slot:owner.slot,files:described},ctx.hash);
  if (!digest.ok) throw new Error(digest.error.message);
  const stored:SavedArtifact["files"]=[];
  for (const {path,source} of ordered) stored.push({path,content:await r.evidence.put(source)});
  return {...owner,receipt:"artifact:"+digest.value,files:stored};
}

export async function readArtifact(r:WorkRepositories,id:string):Promise<SavedArtifact|undefined> {
  const intent = await r.intents.findByRequest(id);
  if (intent?.kind === "save-artifact" && intent.state === "completed") return intent.result as SavedArtifact;
}

export async function verifiedArtifact(r:WorkRepositories,runId:string,id:string,receipt:string,hash:Hasher) {
  const saved=await readArtifact(r,id);
  if (!saved || !matchesReceipt(saved,runId,receipt,hash)) return;
  try {
    for (const file of saved.files) {
      const actual=await r.evidence.describe(file.content.digest);
      if (!actual || actual.byteLength!==file.content.byteLength || actual.chunkCount!==file.content.chunkCount) return;
      await r.evidence.verify(file.content.digest);
    }
  } catch(error) {if(error instanceof StorageFailure && error.reason==="integrity") return; throw error;}
  return saved;
}

export class Artifacts {
  constructor(private readonly ctx:RequestContext) {}

  save(input:{requestId:string;runId:string;slot:string;sessionId?:string}, files:InputFile[]) {
    const ordered = [...files].sort((a,b)=>a.path<b.path ? -1 : a.path>b.path ? 1 : 0);
    const listed = ordered.map(({path,source})=>({path,digest:source.digest,byteLength:source.byteLength}));
    return once<SavedArtifact>(this.ctx,{requestId:input.requestId,kind:"save-artifact",input:{...input,files:listed},
      subject:{type:"task_run",id:input.runId}},async r=>{
      if (!isId(input.slot) || !ordered.length) return fail("invalid","an artifact needs an output key and at least one file");
      if (!portableArtifactPaths(ordered.map(file=>file.path))) return fail("invalid","artifact paths must be distinct portable relative file names");
      const run = await r.taskRuns.get(input.runId,{lock:true});
      if (!run) return fail("not-found","task run does not exist");
      if (isTerminal(run) || run.cancelIntent) return fail("conflict","the run no longer accepts new artifacts");
      if (run.workerMode === "managed" || (run.workerMode === "external" &&
          (run.worker?.kind !== "external" || run.worker.registration.sessionId !== input.sessionId))) return fail("forbidden","artifact submission requires the owning worker");
      const revision = await r.definitions.getRevision(run.taskRevision.definitionId,run.taskRevision.revisionId);
      const task = parseTaskContent(revision?.content);
      if (!task.ok || !task.value.outputs?.some(slot=>slot.key === input.slot)) return fail("invalid","output key is absent from the frozen task");
      return succeed(await archiveFiles(r,this.ctx,{id:input.requestId,runId:run.id,slot:input.slot,...(input.sessionId ? {sessionId:input.sessionId} : {})},ordered));
    });
  }

  async get(runId:string,id:string) {
    return this.ctx.units.run("read",async r=>{
      const saved = await readArtifact(r,id);
      return saved?.runId === runId ? succeed(saved) : fail("not-found","artifact does not belong to this run");
    });
  }

  async streams(runId:string,id:string,receipt:string) {
    const saved=await this.ctx.units.run("read",r=>verifiedArtifact(r,runId,id,receipt,this.ctx.hash));
    if (!saved) throw new TestTargetFault("selected artifact is unavailable");
    const units=this.ctx.units;
    return saved.files.map(({path,content})=>({path,source:{digest:content.digest,byteLength:content.byteLength,
      async *open(){
        for (let i=0;i<content.chunkCount;i++) {
          const chunk=await units.run("read",r=>r.evidence.chunk(content.digest,i));
          if (!chunk) throw new TestTargetFault("archived artifact chunk is missing");
          yield chunk;
        }
      }}}));
  }

  async chunk(runId:string,id:string,path:string,ordinal:number) {
    return this.ctx.units.run("read",async r=>{
      const saved = await readArtifact(r,id);
      const ref = saved?.runId === runId && saved.files.find(file=>file.path===path)?.content;
      if (!ref || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= ref.chunkCount) return fail("not-found","artifact file or chunk is missing");
      const data = await r.evidence.chunk(ref.digest,ordinal);
      return data ? succeed({id,runId,path,ordinal,ref,data}) : fail("unavailable","archived artifact chunk is missing");
    });
  }

  async check(items:readonly DeliveryItem[]) {
    return this.ctx.units.run("read",async r=>{
      for (const item of items) {
        const saved = await readArtifact(r,item.id);
        if (!saved || saved.receipt !== item.receipt) return "rejected" as const;
        for (const file of saved.files) await r.evidence.verify(file.content.digest);
      }
      return "accepted" as const;
    });
  }
}
