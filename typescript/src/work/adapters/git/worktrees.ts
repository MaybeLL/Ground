import { execFile,spawn } from "node:child_process";
import { constants,existsSync, mkdirSync,realpathSync } from "node:fs";
import {open,readdir,lstat,rmdir} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {atomicPrivateWrite,privateDirectory,safeRead,safeReadOpened,withRuntimeLock} from "../../../runtime-files.js";
import {basename,dirname,join,resolve} from "node:path";
import { promisify } from "node:util";
import { dataLayout,repositoryDataRoot,verifiedDataPath } from "../../../data-layout.js";
import {WorktreeConflict,type WorktreePort} from "../../ports/index.js";

const run = promisify(execFile);

async function pointerText(path:string) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {return safeReadOpened(file.fd,8192).toString().trimEnd();}
  finally {await file.close();}
}

/** One git worktree per run, under the repository's own data directory, on a branch named for the run. */
export class GitWorktrees implements WorktreePort {
  async repositoryIdentity(repositoryPath:string) {
    const {stdout}=await run("git",["-C",repositoryPath,"rev-parse","--path-format=absolute","--git-common-dir"]);
    return realpathSync(stdout.trim());
  }

  private async linkedIdentity(repository:string,dir:string,registeredPath:string,branch:string) {
    const common=await this.repositoryIdentity(repository);
    const file=join(dir,".git");
    const pointer=/^gitdir: (.+)\n?$/.exec(await pointerText(file));
    if (!pointer) throw new WorktreeConflict("invalid task worktree pointer");
    const admin=realpathSync(resolve(dir,pointer[1]!));
    if (dirname(admin)!==join(common,"worktrees")) throw new WorktreeConflict("worktree Git directory belongs to another repository");
    const backlink=resolve(admin,await pointerText(join(admin,"gitdir")));
    const actual=(await run("git",["-C",dir,"rev-parse","--absolute-git-dir"])).stdout.trimEnd();
    const head=(await run("git",["-C",dir,"symbolic-ref","--quiet","HEAD"])).stdout.trimEnd();
    if (realpathSync(actual)!==admin || backlink!==join(registeredPath,".git") ||
        head!=="refs/heads/"+branch || await this.repositoryIdentity(dir)!==common) throw new WorktreeConflict("worktree registration and actual Git directory disagree");
  }

  /** Only adopt an existing unbound worktree if Git still records its original base. */
  async existingBase(input:{repositoryPath:string;runId:string}) {
    if ([".",".."].includes(input.runId) || !/^[A-Za-z0-9._-]{1,128}$/.test(input.runId)) throw new WorktreeConflict("invalid worktree identity");
    const path=join(repositoryDataRoot(input.repositoryPath),"work",input.runId,"worktree");
    const repositories=join(dataLayout().root,"repositories");
    if (existsSync(repositories)) {
      for (const entry of await readdir(repositories,{withFileTypes:true})) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const other=join(repositories,entry.name,"work",input.runId,"worktree");
        if (other!==path && (existsSync(other) || existsSync(join(dirname(other),"preparation.json")))) throw new WorktreeConflict("the unbound external run already has a worktree in another clone");
      }
    }
    const receipt=join(dirname(path),"preparation.json");
    if (existsSync(receipt)) {
      const preparing=JSON.parse(safeRead(verifiedDataPath(receipt),2048).toString());
      if (typeof preparing.ready!=="boolean" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(preparing.commit) ||
          !/^prepare-[a-f0-9-]{36}$/.test(preparing.stage)) throw new WorktreeConflict("invalid worktree preparation record");
      if (preparing.ready) {
        const final=verifiedDataPath(path);
        await this.linkedIdentity(input.repositoryPath,final,final,"grounds/work/"+input.runId);
      }
      return preparing.commit as string;
    }
    const first=async(cwd:string,ref:string)=>{
      const {stdout}=await run("git",["-C",cwd,"rev-parse","--path-format=absolute","--git-path","logs/"+ref]);
      const file=await open(stdout.trim(),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) throw new WorktreeConflict("invalid worktree reflog");
        const {buffer,bytesRead}=await file.read(Buffer.alloc(8192),0,8192,0);
        return buffer.subarray(0,bytesRead).toString().split("\n")[0] ?? "";
      } finally {await file.close();}
    };
    const ref="refs/heads/grounds/work/"+input.runId;
    if (!existsSync(path) || (await lstat(path)).isDirectory() && (await readdir(path)).length===0) {
      const {stdout}=await run("git",["-C",input.repositoryPath,"for-each-ref","--format=%(objectname)",ref]);
      const tip=stdout.trim();
      if (!tip) return;
      const birth=(await first(input.repositoryPath,ref));
      if (!birth.startsWith("0".repeat(tip.length)+" "+tip+" ") || !birth.endsWith("\tbranch: Created from "+tip)) throw new WorktreeConflict("cannot identify the interrupted task branch");
      return tip;
    }
    const listing=await run("git",["-C",input.repositoryPath,"worktree","list","--porcelain","-z"]);
    if (!listing.stdout.split("\0").includes("worktree "+verifiedDataPath(path))) throw new WorktreeConflict("external workspace is not registered with this clone");
    const head=/^(0{40}|0{64}) ([a-f0-9]+) /.exec(await first(path,"HEAD"));
    const branch=await first(path,ref);
    if (!head || head[1]!.length!==head[2]!.length || !branch.startsWith(head[0]) || !branch.endsWith("\tbranch: Created from "+head[2])) {
      throw new WorktreeConflict("cannot prove the original external workspace base");
    }
    return head[2];
  }

  async create(input: { repositoryPath: string; runId: string; commit: string }): Promise<{ path: string; branch: string; created: boolean }> {
    if ([".",".."].includes(input.runId) || !/^[A-Za-z0-9._-]{1,128}$/.test(input.runId)) throw new Error("the run identity is not usable in a path");
    const repositoryDirectory=repositoryDataRoot(input.repositoryPath);
    const branch = `grounds/work/${input.runId}`;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.commit)) throw new WorktreeConflict("worktree creation requires a frozen Git commit");
    mkdirSync(dataLayout().root,{recursive:true});
    const dataRoot=realpathSync(dataLayout().root);
    const actualParent=privateDirectory(join(dataRoot,"repositories",basename(repositoryDirectory),"work",input.runId));
    return withRuntimeLock(actualParent,"prepare-worktree",async fd=>{
      const final=join(actualParent,"worktree"),receipt=join(actualParent,"preparation.json");
      const git=async(cwd:string,args:string[])=>(await run("git",args,{cwd,maxBuffer:8*1024*1024})).stdout.trimEnd();
      // The Git child keeps the lock if its CLI parent dies while checking out.
      const mutate=(args:string[],inputBytes?:Buffer)=>new Promise<void>((ok,no)=>{
        const child=spawn("git",args,{cwd:input.repositoryPath,stdio:[inputBytes ? "pipe" : "ignore","ignore","pipe",fd]});
        if (inputBytes) {child.stdin!.on("error",no);child.stdin!.end(inputBytes);}
        let diagnostic="";
        child.stderr!.on("data",chunk=>{if(diagnostic.length<8192) diagnostic+=chunk.toString();});
        child.once("error",no);child.once("close",code=>code===0 ? ok() : no(Error(diagnostic.trim() || "Git worktree operation failed")));
      });
      const records=()=>git(input.repositoryPath,["worktree","list","--porcelain","-z"]).then(text=>text.split("\0\0").map(block=>block.split("\0")));
      const registration=async(dir:string)=>(await records()).find(record=>record[0]==="worktree "+dir);
      const saved=existsSync(receipt) ? JSON.parse(safeRead(receipt,2048).toString()) as {commit:string;stage:string;ready:boolean} : undefined;
      if (saved && (saved.commit!==input.commit || !/^prepare-[a-f0-9-]{36}$/.test(saved.stage))) throw new WorktreeConflict("worktree preparation identity changed");
      let current=await registration(final);
      if (!current && saved && !saved.ready && existsSync(join(final,".git"))) {
        // Git may have renamed the directory before updating its private
        // worktree record. Repair only the registration of our journaled stage.
        verifiedDataPath(final,dataRoot);
        await this.linkedIdentity(input.repositoryPath,final,join(actualParent,saved.stage),branch);
        await mutate(["worktree","repair",final]);
        current=await registration(final);
      }
      if (current) {
        if (!existsSync(final) || verifiedDataPath(final,dataRoot)!==final || await git(final,["rev-parse","--show-toplevel"])!==final ||
            await this.repositoryIdentity(final)!==await this.repositoryIdentity(input.repositoryPath)) throw new WorktreeConflict("registered worktree path changed");
        await this.linkedIdentity(input.repositoryPath,final,final,branch);
        if (!current.includes("branch refs/heads/"+branch)) throw new WorktreeConflict("registered worktree no longer uses its task branch");
        const index=await git(final,["rev-parse","--path-format=absolute","--git-path","index"]);
        if (!existsSync(index) || current.includes("locked initializing")) throw new WorktreeConflict("registered worktree checkout is incomplete");
        if (!saved && await git(final,["rev-parse","HEAD"])!==input.commit && await this.existingBase(input)!==input.commit) throw new WorktreeConflict("worktree base differs from the frozen task base");
        if (saved && !saved.ready) atomicPrivateWrite(receipt,JSON.stringify({...saved,ready:true}));
        return {path:final,branch,created:false};
      }
      if (saved?.ready) throw new WorktreeConflict("the registered task worktree disappeared");
      if (existsSync(final)) {
        verifiedDataPath(final,dataRoot);
        if (!(await lstat(final)).isDirectory() || (await readdir(final)).length) throw new WorktreeConflict("unregistered worktree path contains existing files");
        await rmdir(final);
      }
      const journal=saved ?? {commit:input.commit,stage:"prepare-"+randomUUID(),ready:false};
      const stage=join(actualParent,journal.stage);
      const partial=await registration(stage);
      const ref="refs/heads/"+branch;
      const tip=await git(input.repositoryPath,["for-each-ref","--format=%(objectname)",ref]);
      if (tip && tip!==input.commit) throw new WorktreeConflict("existing task branch has moved away from the reserved base");
      if (tip && !saved && !partial && await this.existingBase(input)!==input.commit)
        throw new WorktreeConflict("cannot verify the origin of the existing task branch");
      if (!saved) atomicPrivateWrite(receipt,JSON.stringify(journal));
      if (partial) {
        if (!partial.includes("branch "+ref) || !existsSync(join(stage,".git")))
          throw new WorktreeConflict("the staging worktree cannot be identified as the task branch");
        verifiedDataPath(stage,dataRoot);
        await this.linkedIdentity(input.repositoryPath,stage,stage,branch);
        const head=await git(stage,["rev-parse","HEAD"]);
        if (head!==input.commit) throw new WorktreeConflict("the staging worktree has an unexpected HEAD");
        const index=await git(stage,["rev-parse","--path-format=absolute","--git-path","index"]);
        if (partial.includes("locked initializing") || !existsSync(index)) {
          // Complete only missing checkout entries. Preserve existing files
          // and reject a divergent index rather than replacing staged work.
          if (!existsSync(index)) await mutate(["-C",stage,"read-tree",head]);
          if (await git(stage,["write-tree"])!==await git(stage,["rev-parse","HEAD^{tree}"]))
            throw new WorktreeConflict("the interrupted checkout contains staged changes");
          const missing=await run("git",["-C",stage,"ls-files","--deleted","-z"],{encoding:"buffer",maxBuffer:64*1024*1024});
          if (missing.stdout.length) await mutate(["-C",stage,"checkout-index","-z","--stdin"],missing.stdout);
          if (partial.includes("locked initializing")) await mutate(["worktree","unlock",stage]);
        }
      } else {
        if (existsSync(stage) && (verifiedDataPath(stage,dataRoot)!==stage || !(await lstat(stage)).isDirectory() || (await readdir(stage)).length))
          throw new WorktreeConflict("unregistered staging path contains existing files");
        await mutate(tip ? ["worktree","add",stage,branch] : ["-c","core.logAllRefUpdates=true","worktree","add","-b",branch,stage,input.commit]);
      }
      await mutate(["worktree","move",stage,final]);
      if (!(await registration(final))?.includes("branch "+ref) || await git(final,["rev-parse","HEAD"])!==input.commit) throw new WorktreeConflict("Git did not publish the expected worktree");
      await this.linkedIdentity(input.repositoryPath,final,final,branch);
      atomicPrivateWrite(receipt,JSON.stringify({...journal,ready:true}));
      return {path:final,branch,created:true};
    },60000);
  }
}
