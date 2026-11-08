import { execFile } from "node:child_process";
import { existsSync, mkdirSync,realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { repositoryDataRoot } from "../../../data-layout.js";
import type { WorktreePort } from "../../ports/index.js";

const run = promisify(execFile);

/** One git worktree per run, under the repository's own data directory, on a branch named for the run. */
export class GitWorktrees implements WorktreePort {
  async repositoryIdentity(repositoryPath:string) {
    const {stdout}=await run("git",["-C",repositoryPath,"rev-parse","--path-format=absolute","--git-common-dir"]);
    return realpathSync(stdout.trim());
  }

  async create(input: { repositoryPath: string; runId: string; commit: string }): Promise<{ path: string; branch: string; created: boolean }> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.runId)) throw new Error("the run identity is not usable in a path");
    const parent = join(repositoryDataRoot(input.repositoryPath), "work", input.runId);
    const path = join(parent, "worktree"), branch = `grounds/work/${input.runId}`;
    if (existsSync(path)) return { path, branch, created: false };
    mkdirSync(parent, { recursive: true });
    await run("git", ["worktree", "add", "-b", branch, path, input.commit], { cwd: input.repositoryPath, maxBuffer: 8 * 1024 * 1024 });
    return { path, branch, created: true };
  }
}
