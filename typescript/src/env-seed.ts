import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { git, gitTry } from "./env-git.js";
import { assertNoTrackedGroundsRuntime, isPrivateGroundsPath } from "./grounds-exclude.js";
import { validation } from "./errors.js";
import { privateDirectory } from "./runtime-files.js";
export type MaterialScope = "development" | "blind";
/** A fresh ordinary Git repository, with copied objects through a fixed explicit ref. Never alternates or caller configuration. */
export const initializeTaskRepository = (input: { source: string; commit: string; destination: string; branch: string; scope: MaterialScope }): { commit: string; tree: string; source_commit: string } => {
  const sourceCommit = input.commit.replace(/^sha(?:1|256):/, "");
  const algorithm = git(["rev-parse", "--show-object-format"], { cwd: input.source });
  if (!["sha1", "sha256"].includes(algorithm) || !(new RegExp(`^[0-9a-f]{${algorithm === "sha256" ? 64 : 40}}$`)).test(sourceCommit) || (input.commit.includes(":") && !input.commit.startsWith(algorithm + ":"))) throw validation("input_commit", "requires an exact commit matching the repository object format");
  if (git(["rev-parse", "--verify", `${sourceCommit}^{commit}`], { cwd: input.source }) !== sourceCommit) throw validation("input_commit", "fixed commit unavailable");
  if (git(["ls-tree", "-r", "--name-only", "-z", sourceCommit, "--", ".grounds"], { cwd: input.source }).split("\0").some(isPrivateGroundsPath)) throw validation("input_commit", "fixed input tracks private Grounds runtime files");
  git(["check-ref-format", `refs/heads/${input.branch}`]);
  privateDirectory(input.destination);
  git(["init", "-q", `--object-format=${algorithm}`, input.destination]);
  const target = { cwd: input.destination };
  git(["config", "user.name", "Grounds task"], target);
  git(["config", "user.email", "task@grounds.local"], target);
  git(["fetch", "--no-tags", "--no-write-fetch-head", input.source, sourceCommit], target);
  const tree = git(["rev-parse", `${sourceCommit}^{tree}`], target);
  let commit = sourceCommit;
  if (input.scope === "blind") {
    // Preserve every candidate file byte. The synthetic input commit removes author history only in this disposable view.
    commit = git(["commit-tree", tree, "-m", "Fixed verification input"], { ...target, env: { GIT_AUTHOR_NAME: "Grounds", GIT_AUTHOR_EMAIL: "input@grounds.local", GIT_COMMITTER_NAME: "Grounds", GIT_COMMITTER_EMAIL: "input@grounds.local", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" } });
  }
  git(["checkout", "-q", "-b", input.branch, commit], target);
  assertNoTrackedGroundsRuntime(input.destination);
  if (input.scope === "blind") { git(["reflog", "expire", "--expire=now", "--all"], target); git(["gc", "--prune=now"], target); }
  if (!lstatSync(join(input.destination,".git")).isDirectory() || existsSync(join(input.destination,".git/objects/info/alternates"))) throw validation("workspace", "ordinary independent Git initialization failed");
  return { commit, tree, source_commit: sourceCommit };
};
