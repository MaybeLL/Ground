import type {ArchivedDigest,CodeArchivePort,WorkUnitOfWork} from "../ports/index.js";
import type {Hasher} from "../domain/index.js";
import {verifiedArtifact} from "./artifacts.js";

export type SelectedArchive = {id:string;receipt:string;artifactRunId?:string};
type MaterialFile={blob:string;bytes:Uint8Array;executable?:true};
type MaterialRead={status:"read";files:Map<string,MaterialFile>}|{status:"invalid"|"unavailable"|"missing";reason:string};

/** Evaluation sees only named bytes of a verified archive. Candidate and
 * artifact receipts have different backing stores and integrity checks. */
export class EvaluationFiles {
  constructor(private readonly units:WorkUnitOfWork,private readonly git:CodeArchivePort,private readonly hash:Hasher) {}

  async digest(repo:string,archive:SelectedArchive,path:string):Promise<ArchivedDigest> {
    if (!archive.artifactRunId) return this.git.fileDigest(repo,archive,path);
    return this.units.run("read",async r=>{
      const saved=await verifiedArtifact(r,archive.artifactRunId!,archive.id,archive.receipt,this.hash);
      if (!saved) return {status:"unavailable",reason:"artifact receipt is unavailable"};
      const file=saved.files.find(f=>f.path===path);
      if (!file) return {status:"missing",reason:"file is absent from the archived artifact"};
      return {status:"read",digest:file.content.digest};
    });
  }

  async material(repo:string,archive:SelectedArchive,paths:readonly string[]):Promise<MaterialRead> {
    if (!archive.artifactRunId) return this.git.readFiles(repo,archive,paths);
    return this.units.run("read",async r=>{
      const saved=await verifiedArtifact(r,archive.artifactRunId!,archive.id,archive.receipt,this.hash);
      if (!saved) return {status:"unavailable",reason:"artifact receipt is unavailable"};
      const files=new Map<string,MaterialFile>();
      for (const path of paths) {
        const ref=saved.files.find(f=>f.path===path)?.content;
        if (!ref) return {status:"missing",reason:"material file is absent: "+path};
        if (ref.byteLength>1024*1024) return {status:"invalid",reason:"material exceeds 1 MiB"};
        const bytes=new Uint8Array(ref.byteLength);
        let offset=0;
        for(let i=0;i<ref.chunkCount;i++){
          const chunk=await r.evidence.chunk(ref.digest,i);
          if (!chunk) return {status:"unavailable",reason:"archived artifact chunk is missing"};
          bytes.set(chunk,offset);offset+=chunk.byteLength;
        }
        files.set(path,{blob:ref.digest,bytes});
      }
      return {status:"read",files};
    });
  }
}
