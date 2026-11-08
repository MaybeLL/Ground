import {checkCommit,verifyTree} from "./material-integrity.js";
import {execFile,spawn} from "node:child_process";
import {chmod,lstat,mkdir,mkdtemp,open,symlink,readFile,readdir,realpath,rename,rm,writeFile} from "node:fs/promises";
import {isAbsolute,join,relative} from "node:path";
import {promisify} from "node:util";
import {dataLayout} from "../../../data-layout.js";
import {atomicPrivateWrite,privateDirectory,withRuntimeLock} from "../../../runtime-files.js";
import type {MaterialRepository} from "../../domain/index.js";
import {inspectionEnvironment} from "./inspection-environment.js";

const exec = promisify(execFile);
/** Export the pinned blobs without checkout filters, EOL conversion or
 * repository-configured smudge commands. The staging directory is private. */
async function exportTree(repository:string,tree:string,dir:string,mode=0o700) {
  const {stdout}=await exec("git",["-C",repository,"ls-tree","-z",tree],{env:inspectionEnvironment(),maxBuffer:64*1024*1024,encoding:"buffer"});
  const records=new TextDecoder("utf-8",{fatal:true}).decode(stdout).split("\0");
  await mkdir(dir,{mode});
  for (const record of records.slice(0,-1)) {
    const match=/^(100644|100755|120000|040000) (blob|tree) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match || [".","..",".git"].includes(match[4]!.toLowerCase()) || match[4]!.includes("/")) throw new Error("unsupported material tree entry");
    const [,entryMode,,oid,name]=match, path=join(dir,name!);
    if (entryMode==="040000") {await exportTree(repository,oid!,path,mode);continue;}
    if (entryMode==="120000") {
      const link=await exec("git",["-C",repository,"cat-file","blob",oid!],{encoding:"buffer",env:inspectionEnvironment()});
      await symlink(link.stdout,path);
      continue;
    }
    const output=await open(path,"wx",entryMode==="100755"?0o755:0o644);
    try {
      const child=spawn("git",["-C",repository,"cat-file","blob",oid!],{env:inspectionEnvironment(),stdio:["ignore",output.fd,"ignore"]});
      await new Promise<void>((resolve,reject)=>{
        child.once("error",reject);
        child.once("close",code=>code===0 ? resolve() : reject(new Error("could not read pinned Git blob")));
      });
    } finally {await output.close();}
  }
}

/** A blind verifier receives the Git tree without commit messages, authors or repository metadata. */
export async function exportVerificationTree(repository:string,commit:string,directory:string) {
  const proof=await commitObject(repository,commit);
  const expected=checkCommit(commit,Buffer.from(proof,"base64"));
  await exportTree(repository,expected,directory,0o755);
  if ((await verifyTree(directory,commit,directory,false)).toString("hex")!==expected) throw Error("verification checkout differs from its frozen commit");
}

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

async function commitObject(repository:string,commit:string) {
  const object=await exec("git",["-C",repository,"cat-file","commit",commit],{encoding:"buffer",env:inspectionEnvironment(),maxBuffer:32*1024*1024});
  checkCommit(commit,object.stdout);
  return object.stdout.toString("base64");
}

async function writeMaterials(directory:string,repositories:readonly MaterialRepository[]) {

  const commits:string[]=[];
  for (const repo of repositories) {
    if (!isAbsolute(repo.repository)) throw new Error("material checkout requires an absolute repository path");
    const destination = join(directory,repo.name);
    const proof = await commitObject(repo.repository,repo.commit);
    const expected = checkCommit(repo.commit,Buffer.from(proof,"base64"));
    commits.push(proof);
    await exportTree(repo.repository,expected,destination);
    await protect(await realpath(destination));
    if ((await verifyTree(destination,repo.commit)).toString("hex")!==expected) throw new Error("material checkout differs from its frozen tree");
  }
  await chmod(directory,0o555);
  return commits;
}

export class MaterialWorkspaces {
  async prepare(ledgerId:string,runId:string,repositories:readonly MaterialRepository[]) {
    if (![ledgerId,runId].every(id=>/^[a-f0-9-]{36}$/.test(id))) throw new Error("invalid workspace owner");
    const parent = join(dataLayout().workspaces,"working",ledgerId);
    privateDirectory(parent);
    const root = join(parent,runId), descriptor = JSON.stringify(repositories);
    const result = (created:boolean,folder="materials")=>({kind:"working" as const,runId,path:join(root,"output"),created,
      materials:repositories.map(({name,commit})=>({name,commit,path:join(root,folder,name)}))});
    return withRuntimeLock(parent,runId,async()=>{
      let published;
      try {published = await lstat(root);} catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
      if (published) {
        if (!published.isDirectory() || !(await lstat(join(root,"output"))).isDirectory()) throw new Error("working output directory is missing or replaced");
        const manifest=join(root,"sources.json");
        if (!(await lstat(manifest)).isFile()) throw new Error("invalid working material manifest");
        const record=JSON.parse(await readFile(manifest,"utf8"));
        const legacy=Array.isArray(record);
        if (JSON.stringify(legacy ? record : record.repositories)!==descriptor) throw new Error("working material identity conflict");
        // Old workspaces contain filtered Git checkouts. Export the trusted
        // blobs separately, then publish their location atomically. Existing
        // readers and the user's output remain available during the upgrade.
        const folder=legacy || record.rawMaterials === true ? "raw-materials" : "materials";
        const materialRoot=join(root,folder);
        let commits=legacy ? undefined : record.commits;
        if (legacy) {
          let existing;
          try {existing=await lstat(materialRoot);} catch (error) {if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
          if (!existing) {
            const stage=await mkdtemp(join(root,"export-"));
            try {commits=await writeMaterials(stage,repositories);await chmod(stage,0o700);await rename(stage,materialRoot);}
            catch (error) {await discard(stage);throw error;}
          } else {
            if (!existing.isDirectory()) throw new Error("invalid raw material directory");
            commits=await Promise.all(repositories.map(repo=>commitObject(repo.repository,repo.commit)));
          }
          await chmod(materialRoot,0o555);
        }
        const materialStat=await lstat(materialRoot);
        if (!materialStat.isDirectory() || materialStat.mode & 0o222 || (await readdir(materialRoot)).length!==repositories.length) throw new Error("invalid working material layout");
        for (const [index,repo] of repositories.entries()) {
          const expected=checkCommit(repo.commit,Buffer.from(commits[index],"base64"));
          if ((await verifyTree(join(materialRoot,repo.name),repo.commit)).toString("hex")!==expected) throw new Error("material differs from its frozen commit");
        }
        if (legacy) atomicPrivateWrite(manifest,JSON.stringify({repositories,commits,rawMaterials:true}));
        return result(false,folder);
      }
      const stage = await mkdtemp(join(parent,"prepare-"));
      try {
        await mkdir(join(stage,"output"));
        const directory=join(stage,"materials");
        await mkdir(directory);
        const commits=await writeMaterials(directory,repositories);
        await writeFile(join(stage,"sources.json"),JSON.stringify({repositories,commits}),{mode:0o400});
        await rename(stage,root);
      } catch (error) {await discard(stage);throw error;}
      return result(true);
    },120000);
  }
}
