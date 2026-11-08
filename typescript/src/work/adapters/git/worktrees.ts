import { execFile } from "node:child_process";
import { constants,existsSync, mkdirSync,realpathSync } from "node:fs";
import {open,readdir} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { dataLayout,repositoryDataRoot } from "../../../data-layout.js";
import type { WorktreePort } from "../../ports/index.js";

const run = promisify(execFile);

/** One git worktree per run, under the repository's own data directory, on a branch named for the run. */
export class GitWorktrees implements WorktreePort {
  async repositoryIdentity(repositoryPath:string) {
    const {stdout}=await run("git",["-C",repositoryPath,"rev-parse","--path-format=absolute","--git-common-dir"]);
    return realpathSync(stdout.trim());
  }

  /** Only adopt an existing unbound worktree if Git still records its original base. */
  async existingBase(input:{repositoryPath:string;runId:string}) {
    if ([".",".."].includes(input.runId) || !/^[A-Za-z0-9._-]{1,128}$/.test(input.runId)) throw Error("invalid worktree identity");
    const path=join(repositoryDataRoot(input.repositoryPath),"work",input.runId,"worktree");
    const repositories=join(dataLayout().root,"repositories");
    if (existsSync(repositories)) {
      for (const entry of await readdir(repositories,{withFileTypes:true})) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const other=join(repositories,entry.name,"work",input.runId,"worktree");
        if (other!==path && existsSync(other)) throw Error("the unbound external run already has a worktree in another clone");
      }
    }
    if (!existsSync(path)) return;
    const listing=await run("git",["-C",input.repositoryPath,"worktree","list","--porcelain","-z"]);
    if (realpathSync(path)!==path || !listing.stdout.split("\0").includes("worktree "+path)) throw Error("external workspace is not registered with this clone");
    const first=async(ref:string)=>{
      const {stdout}=await run("git",["-C",path,"rev-parse","--path-format=absolute","--git-path","logs/"+ref]);
      const file=await open(stdout.trim(),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) throw Error("invalid worktree reflog");
        const {buffer,bytesRead}=await file.read(Buffer.alloc(8192),0,8192,0);
        return buffer.subarray(0,bytesRead).toString().split("\n")[0] ?? "";
      } finally {await file.close();}
    };
    const head=/^(0{40}|0{64}) ([a-f0-9]+) /.exec(await first("HEAD"));
    const branch=await first("refs/heads/grounds/work/"+input.runId);
    if (!head || head[1]!.length!==head[2]!.length || !branch.startsWith(head[0]) || !branch.endsWith("\tbranch: Created from "+head[2])) {
      throw Error("cannot prove the original external workspace base");
    }
    return head[2];
  }

  async create(input: { repositoryPath: string; runId: string; commit: string }): Promise<{ path: string; branch: string; created: boolean }> {
    if ([".",".."].includes(input.runId) || !/^[A-Za-z0-9._-]{1,128}$/.test(input.runId)) throw new Error("the run identity is not usable in a path");
    const parent = join(repositoryDataRoot(input.repositoryPath), "work", input.runId);
    const path = join(parent, "worktree"), branch = `grounds/work/${input.runId}`;
    if (existsSync(path)) return { path, branch, created: false };
    mkdirSync(parent, { recursive: true });
    await run("git", ["worktree", "add", "-b", branch, path, input.commit], { cwd: input.repositoryPath, maxBuffer: 8 * 1024 * 1024 });
    return { path, branch, created: true };
  }
}
