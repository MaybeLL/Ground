import {digestOf,isId,isTerminal,parseTaskContent,type DeliveryItem} from "../domain/index.js";
import type {EvidenceRef,EvidenceSource,WorkRepositories} from "../ports/index.js";
import {fail,succeed} from "./outcome.js";
import {once,type RequestContext} from "./requests.js";

export type SavedArtifact = {
  id:string; runId:string; slot:string; receipt:string; sessionId?:string;
  files:{path:string;content:EvidenceRef}[];
};
export type ArtifactSource = EvidenceSource;
type InputFile = {path:string;source:EvidenceSource};

export async function readArtifact(r:WorkRepositories,id:string):Promise<SavedArtifact|undefined> {
  const intent = await r.intents.findByRequest(id);
  if (intent?.kind === "save-artifact" && intent.state === "completed") return intent.result as SavedArtifact;
}

export class Artifacts {
  constructor(private readonly ctx:RequestContext) {}

  save(input:{requestId:string;runId:string;slot:string;sessionId?:string}, files:InputFile[]) {
    const ordered = [...files].sort((a,b)=>a.path<b.path ? -1 : a.path>b.path ? 1 : 0);
    const listed = ordered.map(({path,source})=>({path,digest:source.digest,byteLength:source.byteLength}));
    return once<SavedArtifact>(this.ctx,{requestId:input.requestId,kind:"save-artifact",input:{...input,files:listed},
      subject:{type:"task_run",id:input.runId}},async r=>{
      if (!isId(input.slot) || !ordered.length) return fail("invalid","an artifact needs an output key and at least one file");
      const paths = new Set<string>();
      for (const {path} of ordered) {
        if (path.includes("\\") || /[\u0000-\u001f]/u.test(path) || path.split("/").some(p=>!p || p==="." || p==="..") ||
            paths.has(path) || path.split("/").some((_,i,parts)=>paths.has(parts.slice(0,i).join("/")))) return fail("invalid","artifact file paths must be distinct relative file names");
        paths.add(path);
      }
      const run = await r.taskRuns.get(input.runId,{lock:true});
      if (!run) return fail("not-found","task run does not exist");
      if (isTerminal(run) || run.cancelIntent) return fail("conflict","the run no longer accepts new artifacts");
      if (run.workerMode === "managed" || (run.workerMode === "external" &&
          (run.worker?.kind !== "external" || run.worker.registration.sessionId !== input.sessionId))) return fail("forbidden","artifact submission requires the owning worker");
      const revision = await r.definitions.getRevision(run.taskRevision.definitionId,run.taskRevision.revisionId);
      const task = parseTaskContent(revision?.content);
      if (!task.ok || !task.value.outputs?.some(slot=>slot.key === input.slot)) return fail("invalid","output key is absent from the frozen task");
      const digest = digestOf({runId:run.id,slot:input.slot,files:listed},this.ctx.hash);
      if (!digest.ok) return fail("invalid",digest.error.message);
      const stored:SavedArtifact["files"] = [];
      for (const {path,source} of ordered) stored.push({path,content:await r.evidence.put(source)});
      return succeed({id:input.requestId,runId:run.id,slot:input.slot,receipt:"artifact:"+digest.value,files:stored,...(input.sessionId ? {sessionId:input.sessionId} : {})});
    });
  }

  async get(runId:string,id:string) {
    return this.ctx.units.run("read",async r=>{
      const saved = await readArtifact(r,id);
      return saved?.runId === runId ? succeed(saved) : fail("not-found","artifact does not belong to this run");
    });
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
