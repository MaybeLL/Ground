import { assertHistoryRepository, historyGit, rawOID } from "./git-history.js";
import { normalizeRemote, repositoryMatchKey } from "./git.js";
import { isGitOID } from "./identity.js";
import { validation } from "./errors.js";
import { validateTargetBranchSpec, type TargetBranch } from "./domain.js";
export type { TargetBranch } from "./domain.js";

/** Resolve the declared branch through actual fetch mappings, not an origin/main convention. */
export function targetTrackingRef(target: TargetBranch, fetchSpecs: string[]): string {
  if (!target.ref.startsWith("refs/heads/")) throw validation("target_branch.ref", "must be a full refs/heads/ branch ref");
  const match = (pattern: string): string | undefined => {
    const pieces = pattern.split("*");
    if (pieces.length === 1) return pattern === target.ref ? "" : undefined;
    if (pieces.length !== 2) throw validation("target_branch", "unsupported fetch refspec");
    return target.ref.startsWith(pieces[0]!) && target.ref.endsWith(pieces[1]!)
      && target.ref.length >= pieces[0]!.length + pieces[1]!.length
      ? target.ref.slice(pieces[0]!.length, target.ref.length - pieces[1]!.length) : undefined;
  };
  const matches = new Set<string>();
  for (const raw of fetchSpecs) {
    if (raw.startsWith("^")) {
      if (match(raw.slice(1)) !== undefined) throw validation("target_branch", "branch is excluded by a negative fetch refspec");
      continue;
    }
    const spec = raw.replace(/^\+/, "").split(":");
    if (spec.length !== 2) continue;
    const [source, destination] = spec as [string, string];
    const captured = match(source);
    if (captured === undefined) continue;
    if ((source.match(/\*/g)?.length ?? 0) !== (destination.match(/\*/g)?.length ?? 0)) {
      throw validation("target_branch", "fetch refspec wildcard mismatch");
    }
    const result = destination.replace("*", captured);
    if (!result.startsWith("refs/remotes/")) throw validation("target_branch", "target must map to a remote-tracking ref");
    matches.add(result);
  }
  if (matches.size !== 1) throw validation("target_branch", "branch must have exactly one unambiguous remote-tracking mapping");
  return [...matches][0]!;
}

/** Only reads local configuration. URLs never appear in the returned descriptor or errors.
 *
 * `repositoryRemotes` is matched exactly (canonical string).  `keyMatchRemotes`
 * defaults to the same list but may be narrowed to the active remotes when a
 * caller passes retired aliases for exact match: retired aliases keep their
 * historical exact-string identity but must not take part in transport-agnostic
 * key matching. */
export function validateTargetBranch(cwd: string, target: TargetBranch, repositoryRemotes: readonly string[], keyMatchRemotes: readonly string[] = repositoryRemotes): string {
  validateTargetBranchSpec(target);
  if (!target || typeof target.remote !== "string" || typeof target.ref !== "string"
    || !target.remote || target.remote.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(target.remote)) {
    throw validation("target_branch", "requires a remote name and full branch ref");
  }
  try {
    historyGit(cwd, ["check-ref-format", target.ref]);
    historyGit(cwd, ["check-ref-format", `refs/remotes/${target.remote}/probe`]);
  } catch { throw validation("target_branch", "invalid branch ref or remote name"); }
  let rawUrl: string, fetchSpecs: string[];
  try {
    rawUrl = historyGit(cwd, ["config", "--get-all", `remote.${target.remote}.url`]);
    fetchSpecs = historyGit(cwd, ["config", "--get-all", `remote.${target.remote}.fetch`]).split("\n");
  } catch { throw validation("target_branch.remote", "remote is missing or has no fetch mapping"); }
  // Multiple fetch URLs are intentionally rejected rather than choosing an identity implicitly.
  if (rawUrl.includes("\n")) throw validation("target_branch.remote", "remote must have one fetch URL");
  let canonical: string;
  try { canonical = normalizeRemote(rawUrl); }
  catch { throw validation("target_branch.remote", "remote URL is not a supported Repository identity"); }
  // Exact canonical match first; otherwise the remote may still denote the same
  // Repository over a different transport, so compare the host-and-path key.
  if (!repositoryRemotes.includes(canonical)) {
    const key = repositoryMatchKey(canonical);
    if (key === undefined || !keyMatchRemotes.some((remote) => repositoryMatchKey(remote) === key)) {
      throw validation("target_branch.remote", "remote does not belong to this Repository");
    }
  }
  const tracking = targetTrackingRef(target, fetchSpecs);
  try { historyGit(cwd, ["check-ref-format", tracking]); }
  catch { throw validation("target_branch", "invalid remote-tracking destination"); }
  return tracking;
}

/** Offline capture/start gate. A rewritten or unavailable target never silently adopts another base. */
export function assertTargetBase(cwd: string, target: TargetBranch, repositoryRemotes: readonly string[], base: string, keyMatchRemotes: readonly string[] = repositoryRemotes): void {
  if (!isGitOID(base)) throw validation("base_commit", "requires a qualified commit OID");
  const tracking = validateTargetBranch(cwd, target, repositoryRemotes, keyMatchRemotes);
  try {
    assertHistoryRepository(cwd);
    historyGit(cwd, ["cat-file", "-e", `${rawOID(base)}^{commit}`]);
    historyGit(cwd, ["merge-base", "--is-ancestor", rawOID(base), tracking]);
  } catch {
    throw validation("base_commit", "base is not confirmed reachable from the declared target; explicitly choose a reachable start for a new DevRun (existing work is preserved)");
  }
}
