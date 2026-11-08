import {execFile} from "node:child_process";
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,writeFile} from "node:fs/promises";
import {isAbsolute,join,relative} from "node:path";
import {pathToFileURL} from "node:url";
import {promisify} from "node:util";
import {dataLayout} from "../../../data-layout.js";
import {withRuntimeLock} from "../../../runtime-files.js";
import type {MaterialRepository} from "../../domain/index.js";
import {inspectionEnvironment} from "./inspection-environment.js";

const exec = promisify(execFile);
const git = (args:string[])=>exec("git",["-c","core.hooksPath=/dev/null","-c","protocol.ext.allow=never",...args],
  {env:inspectionEnvironment(),timeout:120000});

async function protect(root:string,dir=root):Promise<void> {
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const path = join(dir,entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = relative(root,await realpath(path));
      if (resolved === ".." || resolved.startsWith("../") || isAbsolute(resolved)) throw new Error("material symlink points outside its repository");
    } else if (entry.isDirectory()) await protect(root,path);
    else if (entry.isFile()) await chmod(path,(await lstat(path)).mode & 0o555);
    else throw new Error("unsupported material file type");
  }
  await chmod(dir,0o555);
}

// A partial snapshot may already contain read-only directories. Restore write
// permission only on real directories inside this unpublished staging tree.
async function discard(dir:string) {
  await chmod(dir,0o700);
  for (const entry of await readdir(dir,{withFileTypes:true})) if(entry.isDirectory()) await discard(join(dir,entry.name));
  await rm(dir,{recursive:true,force:true});
}

export class MaterialWorkspaces {
  async prepare(ledgerId:string,runId:string,repositories:readonly MaterialRepository[]) {
    if (![ledgerId,runId].every(id=>/^[a-f0-9-]{36}$/.test(id))) throw new Error("invalid workspace owner");
    const parent = join(dataLayout().workspaces,"working",ledgerId);
    await mkdir(parent,{recursive:true,mode:0o700});
    const root = join(parent,runId), descriptor = JSON.stringify(repositories);
    const result = (created:boolean)=>({kind:"working" as const,runId,path:join(root,"output"),created,
      materials:repositories.map(({name,commit})=>({name,commit,path:join(root,"materials",name)}))});
    return withRuntimeLock(parent,runId,async()=>{
      try {
        if (await readFile(join(root,"sources.json"),"utf8") !== descriptor) throw new Error("working material identity conflict");
        return result(false);
      } catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
      const stage = await mkdtemp(join(parent,"prepare-"));
      try {
        await mkdir(join(stage,"output"));
        await mkdir(join(stage,"materials"));
        for (const repo of repositories) {
          if (!isAbsolute(repo.repository)) throw new Error("material checkout requires an absolute repository path");
          const destination = join(stage,"materials",repo.name);
          await git(["init","--quiet","--template=","--object-format="+(repo.commit.length===64 ? "sha256" : "sha1"),destination]);
          await git(["-C",destination,"fetch","--depth=1","--no-tags","--",pathToFileURL(repo.repository).href,repo.commit]);
          await git(["-C",destination,"checkout","--quiet","--detach",repo.commit]);
          await rm(join(destination,".git"),{recursive:true,force:true});
          await protect(await realpath(destination));
        }
        await chmod(join(stage,"materials"),0o555);
        await writeFile(join(stage,"sources.json"),descriptor,{mode:0o400});
        await rename(stage,root);
      } catch (error) {await discard(stage);throw error;}
      return result(true);
    },120000);
  }
}
