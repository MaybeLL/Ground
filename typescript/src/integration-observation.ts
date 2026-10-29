import type { TargetBranch } from "./domain.js";
import type { CommitIdentity, TargetRelation } from "./integration-gate.js";
import { assertHistoryRepository, historyGit, rawOID } from "./git-history.js";
import { runGitWithEnv } from "./git-command.js";
import { readCommit } from "./integration-history.js";
import { validateTargetBranch } from "./target-branch.js";

export interface BranchObservation {
  branch: TargetBranch;
  refreshed: boolean;
  observed_at: string;
  commit?: CommitIdentity;
  failure?: "refresh_failed" | "history_unavailable";
}

/** Resolve identity before network access. Neither transport errors nor URLs are persisted.
 * `keyMatchRemotes` narrows which remotes take part in transport-agnostic key
 * matching (callers that pass retired aliases keep them for exact match only). */
export function observeBranch(cwd: string, branch: TargetBranch, repositoryRemotes: string[], refresh: boolean, keyMatchRemotes: readonly string[] = repositoryRemotes): BranchObservation {
  const tracking = validateTargetBranch(cwd, branch, repositoryRemotes, keyMatchRemotes);
  let failure: BranchObservation["failure"];
  if (refresh) {
    try {
      assertHistoryRepository(cwd);
      const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith("GIT_")).map(key => [key, undefined])), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" };
      runGitWithEnv(cwd, ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "fetch", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance", "--", branch.remote, `+${branch.ref}:${tracking}`], env, 120_000);
    } catch { failure = "refresh_failed"; }
  }
  let commit: CommitIdentity | undefined;
  if (!failure) {
    try {
      assertHistoryRepository(cwd);
      const oid = historyGit(cwd, ["rev-parse", "--verify", `${tracking}^{commit}`]);
      commit = readCommit(cwd, oid);
    } catch { failure = "history_unavailable"; }
  }
  return { branch: { ...branch }, refreshed: refresh && !failure, observed_at: new Date().toISOString(), ...(commit ? { commit } : {}), ...(failure ? { failure } : {}) };
}

export function targetRelation(cwd: string, base: string, target: string): TargetRelation {
  try {
    assertHistoryRepository(cwd);
    const left = rawOID(base), right = rawOID(target);
    historyGit(cwd, ["cat-file", "-e", `${left}^{commit}`]);
    historyGit(cwd, ["cat-file", "-e", `${right}^{commit}`]);
    if (left === right) return "equal";
    // A successfully enumerated ancestry distinguishes rewriting from read errors.
    return historyGit(cwd, ["rev-list", right]).split("\n").includes(left) ? "advanced" : "rewritten";
  } catch { return "unknown"; }
}
