import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {outputPath} from "../../domain/managed-delivery.js";
import type {EvidenceSource,RuntimeOwner} from "../../ports/index.js";
import { GitTagArchive } from "../git/tag-archive.js";
import { ManagedWorkspaces } from "./workspace.js";

type Material = {executable?:boolean;path:string; digest:string; base64:string};
type Environment = {config:string; lockfile:string | null; imageDigest:string};

/** Materialize only the selected delivery in a new evaluator checkout. The
 * second, read-only mount contains private bytes from the pinned suite. */
export class EvaluatorWorkspaces {
  constructor(private readonly workspaces:ManagedWorkspaces, private readonly archive:GitTagArchive,private readonly artifactFiles:(runId:string,id:string,receipt:string)=>Promise<{path:string;source:EvidenceSource}[]>) {}

  async prepare(owner:RuntimeOwner, target:{runId:string;commit:string|null;archiveId:string;receipt:string;repository:string}, environment:Environment, materials:Material[]) {
    if (target.commit===null) {
      const files=await this.artifactFiles(target.runId,target.archiveId,target.receipt);
      const prepared=await this.workspaces.prepare(owner,target.repository,null,environment,false,[],{receipt:target.receipt,populate:async directory=>{
        for (const {path,source} of files) {
          if (!outputPath(path)) throw new Error("invalid archived output path");
          const dest=join(directory,path);
          await mkdir(dirname(dest),{recursive:true});
          const output=await open(dest,"wx"), hash=createHash("sha256");
          let size=0;
          try {
            for await (const bytes of source.open()) {await output.writeFile(bytes);hash.update(bytes);size+=bytes.length;}
          } finally {await output.close();}
          if (size!==source.byteLength || "sha256:"+hash.digest("hex")!==source.digest) throw new Error("artifact bytes differ from their frozen identity");
        }
      }});
      return {...prepared,graderMaterials:await this.materials(owner,materials)};
    }
    const prepared = await this.archive.withTree(target.repository,{id:target.archiveId,receipt:target.receipt},async (scratch,commit) => {
      if (commit !== target.commit) throw new Error("evaluation target identity changed");
      return this.workspaces.prepare(owner,scratch,commit,environment);
    });
    if ("status" in prepared) throw new Error("the frozen evaluation target is unavailable");
    return {...prepared,graderMaterials:await this.materials(owner, materials)};
  }

  private async materials(owner:RuntimeOwner, materials:Material[]) {
    const root = this.workspaces.root(owner), dest = join(root,"evaluator-materials");
    const stage = await mkdtemp(join(root,"materials-"));
    try {
      for (const material of materials) {
        if (!material.path || /[\\\\\x00-\x1f]/.test(material.path) || material.path.split("/").some(part => !part || part === "." || part === "..")) {
          throw new Error("invalid private material path");
        }
        const bytes = Buffer.from(material.base64,"base64");
        if ("sha256:" + createHash("sha256").update(bytes).digest("hex") !== material.digest) throw new Error("private grading material digest changed");
        const path = join(stage,material.path);
        await mkdir(dirname(path), {recursive:true});
        for (let dir = dirname(path); dir !== stage; dir = dirname(dir)) await chmod(dir,0o755);
        await writeFile(path,bytes,{flag:"wx"});
        await chmod(path,material.executable ? 0o555 : 0o444);
      }
      // The sandbox's private parent is only traversable by its host owner.
      // The mount itself must also be traversable by its container remoteUser.
      await chmod(stage,0o755);
      try { await rename(stage,dest); }
      catch (error) {
        if (!["ENOTEMPTY","EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        for (const m of materials) {
          if ("sha256:" + createHash("sha256").update(await readFile(join(dest,m.path))).digest("hex") !== m.digest) throw new Error("private material changed after preparation");
        }
      }
      return dest;
    } finally { await rm(stage,{recursive:true,force:true}); }
  }
}
