import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {portableArtifactPaths} from "../../domain/managed-delivery.js";
import {TestTargetFault,type EvidenceSource,type RuntimeWorkspace,type RuntimeOwner} from "../../ports/index.js";
import { GitTagArchive } from "../git/tag-archive.js";
import { ManagedWorkspaces } from "./workspace.js";

type Material = {executable?:boolean;path:string; digest:string; base64:string};
type Environment = {config:string; lockfile:string | null; imageDigest:string};

/** Materialize only the selected delivery in a new evaluator checkout. The
 * second, read-only mount contains private bytes from the pinned suite. */
export class EvaluatorWorkspaces {
  constructor(private readonly workspaces:ManagedWorkspaces, private readonly archive:GitTagArchive,private readonly artifactFiles:(runId:string,id:string,receipt:string)=>Promise<{path:string;source:EvidenceSource}[]>) {}

  async prepare(owner:RuntimeOwner, target:{runId:string;commit:string|null;archiveId:string;receipt:string;repository:string}, environment:Environment, materials:Material[],role:"agent"|"test"="test") {
    if (target.commit===null) {
      const files=await this.artifactFiles(target.runId,target.archiveId,target.receipt);
      if (!portableArtifactPaths(files.map(f=>f.path))) throw new TestTargetFault("frozen artifact contains incompatible evaluator paths");
      const prepared=await this.workspaces.prepare(owner,target.repository,null,environment,false,[],{receipt:target.receipt,populate:async directory=>{
        try {
          for (const {path,source} of files) {
            const dest=join(directory,path);
            await mkdir(dirname(dest),{recursive:true});
            const output=await open(dest,"wx"), hash=createHash("sha256");
            let size=0;
            try {
              for await (const bytes of source.open()) {await output.writeFile(bytes);hash.update(bytes);size+=bytes.length;}
            } finally {await output.close();}
            if (size!==source.byteLength || "sha256:"+hash.digest("hex")!==source.digest) throw new TestTargetFault("artifact bytes differ from their frozen identity");
          }
        } catch (error) {
          if (["ENAMETOOLONG","ENOTDIR","EEXIST","EILSEQ"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            throw new TestTargetFault("archived paths cannot be materialized on the evaluator filesystem");
          }
          throw error;
        }
      }});
      return this.layout(owner,prepared,materials,role);
    }
    const prepared = await this.archive.withTree(target.repository,{id:target.archiveId,receipt:target.receipt},async (scratch,commit) => {
      if (commit !== target.commit) throw new Error("evaluation target identity changed");
      return this.workspaces.prepare(owner,scratch,commit,environment);
    });
    if ("status" in prepared) throw new Error("the frozen evaluation target is unavailable");
    return this.layout(owner,prepared,materials,role);
  }

  private async layout(owner:RuntimeOwner,prepared:RuntimeWorkspace,materials:Material[],role:"agent"|"test") {
    const graderMaterials=await this.materials(owner,materials);
    if (role==="test") return {...prepared,graderMaterials};
    const path=join(this.workspaces.root(owner),"judge-workspace");
    await mkdir(path,{recursive:true,mode:0o700});
    // The sandbox parent is private; the configured remoteUser needs a
    // writable scratch mount. No submitted files are placed in this directory.
    await chmod(path,0o777);
    return {...prepared,path,graderMaterials,evaluatorDelivery:prepared.path};
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
