import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { assertIndependentTaskSource } from "./development-branch.js";
import { git, gitTry } from "./env-git.js";
export interface RouteReport { pending: string[]; head?: string; branch?: string; preserved: true }
/** Inspect without reset, abort, checkout, stash, branch promotion or rewriting Git configuration. */
export const inspectTaskGit = (workspace: string, selectedCommit?: string, independent = false): RouteReport => {
  const options = { cwd: workspace, hooksPath: "/dev/null" };
  const pending: string[] = [];
  try {
    if (independent) assertIndependentTaskSource(workspace);
    if (existsSync(join(workspace,".git")) && lstatSync(join(workspace,".git")).isSymbolicLink()) return { pending: ["repository_unreadable"], preserved: true };
    const head = git(["rev-parse", "--verify", "HEAD"], options);
    const branch = gitTry(["symbolic-ref", "-q", "HEAD"], options);
    const admin = git(["rev-parse", "--absolute-git-dir"], options);
    if (!branch) pending.push("detached_head");
    if (git(["status", "--porcelain", "--untracked-files=all"], options)) pending.push("uncommitted_changes");
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) if (existsSync(join(admin,name))) pending.push(name);
    if (gitTry(["rev-parse", "--verify", "refs/stash"], options)) pending.push("stash");
    if (selectedCommit) {
      if (head !== selectedCommit) pending.push("head_not_handed_off");
      const unpreserved = git(["rev-list", "--all", "--reflog", "--not", selectedCommit], options);
      if (unpreserved) pending.push("unpreserved_commits");
    }
    return { pending, head, ...(branch ? {branch} : {}), preserved: true };
  } catch { return { pending: ["repository_unreadable"], preserved: true }; }
};
