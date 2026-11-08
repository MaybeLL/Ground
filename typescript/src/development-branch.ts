import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveBaseline } from "./git.js";
import { historyGit, historyBytes, assertHistoryRepository, rawOID } from "./git-history-read.js";
import { readCommit } from "./integration-history.js";
import { runGitWithEnv } from "./git-command.js";
import { isGitOID, isUUIDv7 } from "./identity.js";
import { assertNoTrackedGroundsRuntime, isPrivateGroundsPath } from "./grounds-exclude.js";
import { validation, worktreeMismatch } from "./errors.js";
export const branchGit = (cwd: string, args: string[]): Buffer => runGitWithEnv(cwd,
  ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
  { ...Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith("GIT_")).map(k => [k, undefined])),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, 120_000);

/** Reject active configuration before any Git command discovers an untrusted task repo. */
export function assertIndependentTaskSource(source: string): void {
  const metadata = join(resolve(source), ".git");
  if (!lstatSync(metadata).isDirectory() || lstatSync(metadata).isSymbolicLink()) throw worktreeMismatch("", "task source must have ordinary Git metadata");
  const inspect = (path: string): void => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw worktreeMismatch("", "task Git metadata must not contain symlinks or special files");
    if (entry.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
  };
  inspect(metadata);
  if (existsSync(join(metadata, "commondir")) || existsSync(join(metadata, "objects", "info", "alternates"))) throw worktreeMismatch("", "task Git metadata must not reference external storage");
  const config = branchGit(dirname(resolve(source)), ["config", "--file", join(metadata, "config"), "--no-includes", "--null", "--list"]).toString("utf8");
  const passive = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|autocrlf|safecrlf)|extensions\.objectformat|user\.(?:name|email)|remote\.[^.]+\.(?:url|fetch|tagopt)|branch\.[^.]+\.(?:remote|merge))$/;
  for (const entry of config.split("\0").filter(Boolean)) {
    const key = entry.slice(0, entry.indexOf("\n"));
    if (!passive.test(key)) throw worktreeMismatch("", `task Git configuration is unsupported at the handoff boundary: ${key}`);
  }
}
const safeSourceFetch = (target: string, source: string, commit: string): void => {
  branchGit(target, ["fetch", "--no-tags", "--no-write-fetch-head", "--upload-pack=git -c core.hooksPath=/dev/null -c 'uploadpack.packObjectsHook=exec ' upload-pack", "--", resolve(source), rawOID(commit)]);
};

/** Persist the exact output outside the task repository, without changing any checked-out branch. */
export function receiveDevelopmentObjects(input: { target_path: string; source_path: string; source_commit: string; environment_id: string }): { source_commit: string; tree: string; parents: string[]; ref: string } {
  const { target_path: target, source_path: source, source_commit: commit, environment_id: id } = input;
  if (!isGitOID(commit) || !isUUIDv7(id)) throw validation("source", "fixed source commit and environment UUIDv7 required");
  assertIndependentTaskSource(source);
  assertHistoryRepository(source); assertHistoryRepository(target);
  if (resolve(source) === resolve(target) || !lstatSync(join(source, ".git")).isDirectory() || lstatSync(join(source, ".git")).isSymbolicLink() ||
      resolve(historyGit(source, ["rev-parse", "--absolute-git-dir"])) !== resolve(source, ".git") ||
      resolve(historyGit(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== resolve(source, ".git") ||
      lstatSync(join(source, ".git", "objects")).isSymbolicLink() || existsSync(join(source, ".git", "objects", "info", "alternates"))) throw worktreeMismatch("", "task source must be an independent ordinary Git repository");
  assertNoTrackedGroundsRuntime(source);
  if (historyBytes(source, ["ls-tree", "-r", "--name-only", "-z", rawOID(commit), "--", ".grounds"]).toString("utf8").split("\0").some(isPrivateGroundsPath)) throw worktreeMismatch("", "fixed task source tracks private Grounds runtime files");
  const fixed = readCommit(source, commit), ref = `refs/grounds/environment/${id}`;
  const prior = historyGit(target, ["for-each-ref", "--format=%(refname) %(objectname)", ref]).split("\n").find(line => line.startsWith(ref + " "));
  if (prior && prior !== `${ref} ${rawOID(commit)}`) throw worktreeMismatch("", "environment output retention identity already belongs to another commit");
  safeSourceFetch(target, source, commit);
  const received = readCommit(target, commit);
  if (received.tree_oid !== fixed.tree_oid || JSON.stringify(received.parents) !== JSON.stringify(fixed.parents)) throw worktreeMismatch("", "received source identity differs from fixed task output");
  if (!prior) branchGit(target, ["update-ref", ref, rawOID(commit), "0".repeat(rawOID(commit).length)]);
  if (resolveBaseline(target, ref) !== commit) throw worktreeMismatch("", "environment output retention changed during handoff");
  return { source_commit: commit, tree: fixed.tree_oid, parents: fixed.parents, ref };
}
