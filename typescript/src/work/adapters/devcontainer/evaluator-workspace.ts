import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RuntimeOwner } from "../../ports/index.js";
import { GitTagArchive } from "../git/tag-archive.js";
import { inspectionEnvironment } from "../git/inspection-environment.js";
import { ManagedWorkspaces } from "./workspace.js";

const run = promisify(execFile);
type Material = {path:string; digest:string; base64:string};
type Environment = {config:string; lockfile:string | null; imageDigest:string};

/** Materialize only the selected delivery in a new evaluator checkout. The
 * second, read-only mount contains private bytes from the pinned suite. */
export class EvaluatorWorkspaces {
  constructor(private readonly workspaces:ManagedWorkspaces, private readonly archive:GitTagArchive) {}

  async prepare(owner:RuntimeOwner, target:{commit:string;receipt:string}, environment:Environment, materials:Material[]) {
    const scratch = await mkdtemp(join(tmpdir(),"grounds-grading-target-"));
    try {
      await run("git", ["init","--quiet","--bare","--template=","--object-format=" + (target.commit.length === 64 ? "sha256" : "sha1")],
        {cwd:scratch, env:inspectionEnvironment()});
      const fetched = await this.archive.fetch({repositoryPath:scratch, receipt:target.receipt});
      if (fetched.status !== "fetched" || fetched.commit !== target.commit) throw new Error("the selected evaluation target is unavailable");
      const workspace = await this.workspaces.prepare(owner, scratch, target.commit, environment);
      const graderMaterials = await this.materials(owner, materials);
      return {...workspace, graderMaterials};
    } finally { await rm(scratch,{recursive:true,force:true}); }
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
        await writeFile(path,bytes,{mode:0o444,flag:"wx"});
      }
      // The sandbox's private parent is only traversable by its host owner.
      // The mount itself must also be traversable by its container remoteUser.
      const {chmod} = await import("node:fs/promises");
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
