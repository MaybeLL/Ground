import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepository, matchingRemoteNames } from "./git.js";
import { runGit, runGitWithEnv, withIsolatedGitObjects } from "./git-command.js";
import { sha256Bytes } from "./canonical-json.js";
import { qualifiedOID } from "./identity.js";
import type { ReplaySubject } from "./module.js";

export type ArtifactIntegrity = "consistent" | "inconsistent" | "unknown";
export type LocalRebuild = "yes" | "no" | "unknown";
export type RemoteReachability = "reachable" | "unreachable" | "unknown";
export type ReplayReason =
  | "ok" | "patch_missing" | "patch_digest_mismatch" | "local_repository_incomplete" | "base_commit_missing"
  | "check_error" | "patch_apply_failed" | "result_tree_mismatch";
export type RemoteReason =
  | "none" | "base_commit_missing_locally" | "remote_undetermined" | "no_remote_tracking_refs" | "repository_incomplete" | "refresh_failed" | "check_error";

export interface CheckedRef { ref: string; tip: string; contains_base_commit: boolean }
export interface ReplayCheck {
  artifact_integrity: ArtifactIntegrity;
  local_rebuild: LocalRebuild;
  reason: ReplayReason;
  remote_reachability: RemoteReachability;
  remote_reason: RemoteReason;
  /** Present only for `unreachable`: possible cause and impact, worded so as not to claim the remote lacks the object. */
  remote_hint?: string;
  checked_refs: CheckedRef[];
  checked_refs_total: number;
  checked_refs_truncated: boolean;
  checked_at: string;
  refs_may_be_stale: boolean;
  refresh: { requested: boolean; outcome: "not_requested" | "succeeded" | "failed"; error?: string };
}

const REF_LIMIT = 200;
export const UNREACHABLE_HINT = "No known remote-tracking ref of the registered remote contains the base commit; a likely cause is that the target branch was rewritten. Other environments may be unable to obtain the base commit from the registered remote alone, while a clone that still has it can replay the Candidate. This does not prove the remote lacks the object; run with --refresh to re-check against the remote.";
const FETCH_TIMEOUT_MS = 120_000;
const message = (error: unknown): string => [...(error instanceof Error ? error.message : String(error))].slice(0, 1024).join("");
const text = (cwd: string, ...args: string[]): string => runGit(cwd, args).toString("utf8").trim();

const readable = (root: string): boolean => { try { text(root, "rev-parse", "--git-dir"); return true; } catch { return false; } };
const incompleteHistory = (root: string): boolean => {
  try { if (text(root, "rev-parse", "--is-shallow-repository") === "true") return true; } catch { return true; }
  try { if (text(root, "config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$")) return true; } catch { /* config --get-regexp exits 1 when nothing matches */ }
  return false;
};

interface Local { integrity: ArtifactIntegrity; rebuild: LocalRebuild; reason: ReplayReason; baseAvailable: boolean }

const checkLocal = (root: string, subject: ReplaySubject, incomplete: boolean): Local => {
  const stop = (integrity: ArtifactIntegrity, rebuild: LocalRebuild, reason: ReplayReason, baseAvailable = false): Local => ({ integrity, rebuild, reason, baseAvailable });
  const base = subject.base_commit.slice(subject.base_commit.indexOf(":") + 1);
  // Existence of the base commit is needed by the remote check even when the artifact is already known to be damaged.
  let baseAvailable = false;
  if (readable(root)) { try { runGit(root, ["cat-file", "-e", `${base}^{commit}`]); baseAvailable = true; } catch { baseAvailable = false; } }
  if (subject.patch.state === "unavailable") return baseAvailable ? stop("unknown", "unknown", "local_repository_incomplete", true) : stop("unknown", "no", "base_commit_missing");
  if (subject.patch.state === "missing") return stop("inconsistent", "no", "patch_missing", baseAvailable);
  if (subject.patch.state === "corrupt" || sha256Bytes(subject.patch.bytes) !== subject.patch_digest) return stop("inconsistent", "no", "patch_digest_mismatch", baseAvailable);
  if (!readable(root)) return stop("unknown", "unknown", "local_repository_incomplete");
  if (!baseAvailable) return stop("unknown", "no", "base_commit_missing");
  const temporary = mkdtempSync(join(tmpdir(), "grounds-replay-"));
  const index = join(temporary, "index");
  try {
    try { runGit(root, ["read-tree", base], index); }
    catch { return stop("unknown", "unknown", "local_repository_incomplete", true); }
    if (subject.patch.bytes.length) {
      try { runGit(root, ["apply", "--cached", "--binary", "--whitespace=nowarn"], index, subject.patch.bytes); }
      catch {
        // Without full history or objects an apply failure cannot be pinned on the patch itself.
        return incomplete ? stop("unknown", "unknown", "local_repository_incomplete", true) : stop("inconsistent", "no", "patch_apply_failed", true);
      }
    }
    let tree: string;
    try { tree = qualifiedOID(text(root, "rev-parse", "--show-object-format"), runGit(root, ["write-tree"], index).toString("utf8").trim()); }
    catch { return stop("unknown", "unknown", incomplete ? "local_repository_incomplete" : "check_error", true); }
    return tree === subject.result_tree_oid ? stop("consistent", "yes", "ok", true) : stop("inconsistent", "no", "result_tree_mismatch", true);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
};

/**
 * Check whether a Candidate can be replayed from this clone.  The default path
 * is read-only: object writes go to a scratch store.  Only an explicit refresh
 * fetches the registered remotes, which may update remote-tracking refs,
 * FETCH_HEAD and the clone's object database.
 */
export const replayCheck = (repositoryPath: string, subject: ReplaySubject, options: { refresh: boolean; now?: () => Date }): ReplayCheck => {
  const root = discoverRepository(repositoryPath).root;
  const remoteNames = matchingRemoteNames(discoverRepository(repositoryPath), subject.registered_remotes);
  const refresh: ReplayCheck["refresh"] = { requested: options.refresh, outcome: "not_requested" };
  if (options.refresh) {
    if (remoteNames.length === 0) { refresh.outcome = "failed"; refresh.error = "no remote of this clone matches the registered Repository"; }
    else {
      const failures: string[] = [];
      for (const name of remoteNames) {
        try { runGitWithEnv(root, ["fetch", "--quiet", name], { GIT_TERMINAL_PROMPT: "0" }, FETCH_TIMEOUT_MS); }
        catch (error) { failures.push(message(error)); }
      }
      if (failures.length) { refresh.outcome = "failed"; refresh.error = failures.join("; ").slice(0, 2048); } else refresh.outcome = "succeeded";
    }
  }
  return withIsolatedGitObjects(root, () => {
    const incomplete = readable(root) && incompleteHistory(root);
    const local = checkLocal(root, subject, incomplete);
    let remote: RemoteReachability = "unknown";
    let remoteReason: RemoteReason = "none";
    let refs: CheckedRef[] = [];
    let total = 0;
    const base = subject.base_commit.slice(subject.base_commit.indexOf(":") + 1);
    if (refresh.requested && refresh.outcome === "failed") remoteReason = "refresh_failed";
    else if (remoteNames.length === 0) remoteReason = "remote_undetermined";
    else if (!local.baseAvailable) remoteReason = "base_commit_missing_locally";
    else {
      try {
        const all: Array<{ ref: string; tip: string }> = [];
        for (const name of remoteNames) {
          const out = text(root, "for-each-ref", "--format=%(refname) %(objectname)", `refs/remotes/${name}`);
          for (const line of out.split("\n").filter(Boolean)) { const [ref, tip] = line.split(" "); all.push({ ref, tip }); }
        }
        const containing = new Set<string>();
        for (const name of remoteNames) {
          const out = text(root, "for-each-ref", "--format=%(refname)", "--contains", base, `refs/remotes/${name}`);
          for (const ref of out.split("\n").filter(Boolean)) containing.add(ref);
        }
        total = all.length;
        refs = all.slice(0, REF_LIMIT).map((entry) => ({ ...entry, contains_base_commit: containing.has(entry.ref) }));
        if (total === 0) remoteReason = "no_remote_tracking_refs";
        else if (containing.size > 0) remote = "reachable";
        else if (incomplete) remoteReason = "repository_incomplete";
        else remote = "unreachable";
      } catch { remoteReason = "check_error"; remote = "unknown"; }
    }
    return {
      artifact_integrity: local.integrity,
      local_rebuild: local.rebuild,
      reason: local.reason,
      remote_reachability: remote,
      remote_reason: remoteReason,
      ...(remote === "unreachable" ? { remote_hint: UNREACHABLE_HINT } : {}),
      checked_refs: refs,
      checked_refs_total: total,
      checked_refs_truncated: total > refs.length,
      checked_at: (options.now ? options.now() : new Date()).toISOString(),
      refs_may_be_stale: !(refresh.requested && refresh.outcome === "succeeded"),
      refresh,
    };
  });
};
