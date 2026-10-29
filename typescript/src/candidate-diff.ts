import { execFileSync } from "node:child_process";
import { captureCommittedArtifact, discoverRepository, matchingRemoteNames } from "./git.js";
import { withGitRunner } from "./git-command.js";
import { validateGitArchiveBinding, type GitArchiveBinding } from "./candidate-git-archive.js";
import { isGitOID } from "./identity.js";
import { DomainError, validation } from "./errors.js";

export type CandidateDiffPurpose = "candidate_changes" | "original_changes" | "upstream_changes" | "candidate_evolution" | "cumulative_changes" | "landing_changes" | "target_observation";
export interface CandidateDiffOptions { repositoryPath: string; binding: GitArchiveBinding; left_commit: string; right_commit: string; purpose: CandidateDiffPurpose; observed_at?: string }
export interface CandidateDiffResult {
  repository_id: string; left_commit: string; right_commit: string; purpose: CandidateDiffPurpose;
  generator_version: "grounds.canonical-git-diff/v1"; observed_at?: string; delivery_ready?: false;
  diff_state: "available" | "too_large" | "unavailable"; binary: boolean; patch?: string; patch_digest?: string; reason?: string;
}
const purposes: CandidateDiffPurpose[] = ["candidate_changes", "original_changes", "upstream_changes", "candidate_evolution", "cumulative_changes", "landing_changes", "target_observation"];
const raw = (oid: string): string => oid.slice(oid.indexOf(":") + 1);

/** No fetch, checkout, active index, replace objects, attributes filters or external diff. */
function localGit(cwd: string, args: string[], indexPath?: string, input?: Buffer): Buffer {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}) });
  const diff = args.indexOf("diff");
  const safeArgs = diff < 0 ? args : [...args.slice(0, diff + 1), "--no-textconv", "--no-ext-diff", ...args.slice(diff + 1)];
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", ...safeArgs], { cwd, env, input, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
}

/** Compare explicit commits without changing any Candidate binding, digest or historical Review. */
export function candidateDiff(options: CandidateDiffOptions): CandidateDiffResult {
  if (!isGitOID(options.left_commit) || !isGitOID(options.right_commit)) throw validation("comparison", "requires complete algorithm-prefixed commit OIDs");
  if (!purposes.includes(options.purpose)) throw validation("purpose", "unsupported fixed comparison purpose");
  if (options.observed_at !== undefined && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(options.observed_at) || !Number.isFinite(Date.parse(options.observed_at)))) throw validation("observed_at", "requires an ISO timestamp with timezone");
  if (options.purpose === "target_observation" && options.observed_at === undefined) throw validation("observed_at", "target comparison requires its observation time");
  validateGitArchiveBinding(options.binding);
  const fixed = { repository_id: options.binding.repository_id, left_commit: options.left_commit, right_commit: options.right_commit, purpose: options.purpose, generator_version: "grounds.canonical-git-diff/v1" as const, ...(options.observed_at ? { observed_at: options.observed_at } : {}), ...(options.purpose === "target_observation" ? { delivery_ready: false as const } : {}) };
  return withGitRunner(localGit, () => {
    const repository = discoverRepository(options.repositoryPath);
    if (!matchingRemoteNames(repository, [options.binding.canonical_remote]).length) throw new DomainError("WORKTREE_MISMATCH", "Comparison clone does not match the archived Repository");
    try {
      for (const oid of [options.left_commit, options.right_commit]) if (localGit(repository.root, ["cat-file", "-t", raw(oid)]).toString("utf8").trim() !== "commit") throw new Error("not a commit");
      const artifact = captureCommittedArtifact(repository.root, options.left_commit, options.right_commit, localGit);
      const binary = artifact.patch.includes(Buffer.from("GIT binary patch"));
      if (artifact.patch.length > 1024 * 1024) return { ...fixed, diff_state: "too_large", binary, patch_digest: artifact.patch_digest, reason: "inline_diff_exceeds_1_mib" };
      const patch = artifact.patch.toString("utf8");
      if (!Buffer.from(patch, "utf8").equals(artifact.patch)) return { ...fixed, diff_state: "unavailable", binary: true, patch_digest: artifact.patch_digest, reason: "canonical_patch_is_not_utf8" };
      return { ...fixed, diff_state: "available", binary, patch, patch_digest: artifact.patch_digest };
    } catch (error) {
      if (error instanceof DomainError && error.code === "ARTIFACT_TOO_LARGE") return { ...fixed, diff_state: "too_large", binary: false, reason: "canonical_diff_exceeds_resource_limit" };
      return { ...fixed, diff_state: "unavailable", binary: false, reason: "fixed_commit_objects_unavailable_or_comparison_failed" };
    }
  });
}
