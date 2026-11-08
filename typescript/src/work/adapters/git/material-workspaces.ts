import {checkCommit,verifyTree} from "./material-integrity.js";
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
      let published;
      try {published = await lstat(root);} catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
      if (published) {
        if (!published.isDirectory() || !(await lstat(join(root,"output"))).isDirectory()) throw new Error("working output directory is missing or replaced");
        const materialRoot=join(root,"materials"), manifest=join(root,"sources.json");
        if (!(await lstat(materialRoot)).isDirectory() || !(await lstat(manifest)).isFile()) throw new Error("invalid working material layout");
        const record=JSON.parse(await readFile(manifest,"utf8"));
        if (JSON.stringify(record.repositories)!==descriptor || (await readdir(materialRoot)).length!==repositories.length) throw new Error("working material identity conflict");
        for (const [index,repo] of repositories.entries()) {
          const expected=checkCommit(repo.commit,Buffer.from(record.commits[index],"base64"));
          if ((await verifyTree(join(materialRoot,repo.name),repo.commit)).toString("hex")!==expected) throw new Error("material differs from its frozen commit");
        }
        return result(false);
      }
      const stage = await mkdtemp(join(parent,"prepare-"));
      try {
        await mkdir(join(stage,"output"));
        await mkdir(join(stage,"materials"));
        const commits:string[]=[];
        for (const repo of repositories) {
          if (!isAbsolute(repo.repository)) throw new Error("material checkout requires an absolute repository path");
          const destination = join(stage,"materials",repo.name);
          await git(["init","--quiet","--template=","--object-format="+(repo.commit.length===64 ? "sha256" : "sha1"),destination]);
          await git(["-C",destination,"fetch","--depth=1","--no-tags","--",pathToFileURL(repo.repository).href,repo.commit]);
          const object = await exec("git",["-C",destination,"cat-file","commit",repo.commit],{encoding:"buffer",env:inspectionEnvironment(),maxBuffer:32*1024*1024});
          const expected = checkCommit(repo.commit,object.stdout);
          commits.push(object.stdout.toString("base64"));
          await git(["-C",destination,"checkout","--quiet","--detach",repo.commit]);
          await rm(join(destination,".git"),{recursive:true,force:true});
          await protect(await realpath(destination));
          if ((await verifyTree(destination,repo.commit)).toString("hex")!==expected) throw new Error("material checkout differs from its frozen tree");
        }
        await chmod(join(stage,"materials"),0o555);
        await writeFile(join(stage,"sources.json"),JSON.stringify({repositories,commits}),{mode:0o400});
        await rename(stage,root);
      } catch (error) {await discard(stage);throw error;}
      return result(true);
    },120000);
  }
}
