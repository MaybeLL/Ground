import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { captureFrozen, freezeCheckout } from "./frozen-checkout.js";
import { assertHistoryRepository, historyGit } from "./git-history.js";
import { isGitOID } from "./identity.js";
import { validation } from "./errors.js";
import { atomicPrivateWrite, digestBytes } from "./runtime-files.js";
import { withGroundsExclude } from "./grounds-exclude.js";
import { syncPath } from "./sync-files.js";

/** Private merge inputs are durable recovery material, never a user branch. */
export interface SyncMerge {
  repository: string;
  original_base: string;
  target: string;
  original_tree: string;
  raw_snapshot_digest: string;
  original_index_digest?: string;
  result_tree: string;
  conflicts: { path: string; stages: { mode: string; oid: string; stage: number }[] }[];
}

const raw = (oid: string): string => {
  if (!isGitOID(oid)) throw validation("sync.commit", "requires an algorithm-qualified Git OID");
  return oid.slice(oid.indexOf(":") + 1);
};
const qualify = (oid: string): string => `${oid.length === 64 ? "sha256" : "sha1"}:${oid}`;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const paths = (bytes: Buffer): string[] => utf8.decode(bytes).split("\0").filter(Boolean);
const environment = (sourceConfig: boolean): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: sourceConfig ? process.env.GIT_CONFIG_NOSYSTEM : "1", GIT_CONFIG_GLOBAL: sourceConfig ? process.env.GIT_CONFIG_GLOBAL : "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Grounds sync", GIT_AUTHOR_EMAIL: "sync@grounds.invalid", GIT_COMMITTER_NAME: "Grounds sync", GIT_COMMITTER_EMAIL: "sync@grounds.invalid" };
};
export const syncGit = (cwd: string, args: string[], input?: Buffer, conflictAllowed = false, sourceConfig = false): Buffer => {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "rerere.enabled=false", ...args], { cwd, env: environment(sourceConfig), input, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.signal || (result.status !== 0 && !(conflictAllowed && result.status === 1))) {
    // Do not emit repository configuration or remote URLs in an error.
    throw validation("sync.git", `required Git operation ${args[0]} failed; retain recovery material and inspect locally`);
  }
  return result.stdout;
};
const execute = syncGit;
const text = (cwd: string, args: string[], input?: Buffer): string => execute(cwd, args, input).toString("utf8").trim();

/** Check before taking a snapshot: a target must never overwrite ignored local input. */
export function assertNoIgnoredSyncCollision(cwd: string, target: string): void {
  const tracked = paths(execute(cwd, ["ls-tree", "-rz", "--name-only", raw(target)]));
  const ignored = paths(execute(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], undefined, false, true));
  for (const path of tracked) {
    if (ignored.some(local => local === path || local.startsWith(path + "/") || path.startsWith(local + "/"))) {
      throw validation("sync.target", "target would overwrite ignored local material");
    }
    syncPath(path);
  }
}

/**
 * Prepare a three-way merge in a private, self-contained object store. No HEAD,
 * index or user files are changed. The caller retains the entire directory on
 * failure and journals the result before applying anything to the DevRun.
 * A synthetic commit has exactly `base` as parent, making it the merge base
 * even on Git versions without merge-tree --merge-base. It is never delivered.
 */
export function prepareSyncMerge(input: { cwd: string; directory: string; base: string; target: string; source_head?: string }): SyncMerge {
  const cwd = realpathSync(input.cwd), directory = join(realpathSync(dirname(resolve(input.directory))), basename(input.directory)), base = raw(input.base), target = raw(input.target);
  assertHistoryRepository(cwd);
  if (text(cwd, ["config", "--bool", "--default", "false", "--get", "core.sparseCheckout"]) === "true") throw validation("sync.worktree", "sparse checkout is not supported");
  if (base === target || historyGit(cwd, ["merge-base", base, target]) !== base) throw validation("sync.target", "must advance from the current base");
  if (input.source_head && !historyGit(cwd, ["rev-list", raw(input.source_head)]).split("\n").includes(base)) throw validation("sync.source", "managed source does not contain the recorded logical base");
  if (historyGit(cwd, ["rev-parse", "HEAD"]) !== (input.source_head ? raw(input.source_head) : base)) throw validation("sync.base", "worktree HEAD differs from the recorded base");
  if (execute(cwd, ["ls-files", "-u", "-z"]).length) throw validation("sync.index", "resolve existing conflicts before starting sync");
  assertNoIgnoredSyncCollision(cwd, input.target);
  if (existsSync(directory)) throw validation("sync.directory", "recovery directory already exists; do not overwrite it");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const index = historyGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const originalIndex = existsSync(index) ? readFileSync(index) : undefined;
  if (originalIndex) atomicPrivateWrite(join(directory, "original-index"), originalIndex);
  const metadata = join(directory, "metadata");
  // Local cloning copies unreferenced capture objects too. No alternates or
  // hardlinks: source GC cannot destroy recovery inputs after preparation.
  execute("/", ["clone", "--no-checkout", "--local", "--no-hardlinks", "--template=", "--", cwd, metadata]);
  // A fresh clone has no user-defined merge drivers. Remove its source URL;
  // recovery is local and must never fetch implicitly.
  execute(metadata, ["remote", "remove", "origin"]);
  execute(metadata, ["read-tree", base]);
  mkdirSync(join(metadata, ".git", "info"), { recursive: true, mode: 0o700 });
  writeFileSync(join(metadata, ".git", "info", "exclude"), withGroundsExclude(""), { mode: 0o600 });
  // Freeze raw bytes (including CRLF), modes and symlinks using pinned directory
  // descriptors. Git-normalized patch bytes alone are not a recovery snapshot.
  const repository = join(directory, "original-files");
  const frozen = freezeCheckout({ directory: cwd, trusted: metadata, baseline: input.source_head ? raw(input.source_head) : base, repository: "" }, repository, true,
    () => paths(execute(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], undefined, false, true)));
  const artifact = captureFrozen(repository, input.base);
  atomicPrivateWrite(join(directory, "original.patch"), artifact.patch);
  const originalTree = raw(artifact.result_tree_oid);
  execute(repository, ["cat-file", "-e", `${originalTree}^{tree}`]);
  const ours = text(repository, ["commit-tree", originalTree, "-p", input.source_head ? raw(input.source_head) : base], Buffer.from("Grounds private sync snapshot\n"));
  execute(repository, ["update-ref", "refs/grounds/snapshot", ours]);
  execute(repository, ["update-ref", "refs/grounds/target", target]);
  const output = paths(execute(repository, ["merge-tree", "--write-tree", "--messages", "-z", ours, target], undefined, true));
  const result = output[0];
  if (!result || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) throw validation("sync.git", "unsupported merge-tree output; recovery inputs retained");
  const conflicts = new Map<string, SyncMerge["conflicts"][number]>();
  for (const entry of output.slice(1)) {
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([123])\t([\s\S]+)$/.exec(entry);
    if (!match) break;
    const [, mode, oid, stage, path] = match;
    const conflict = conflicts.get(path!) ?? { path: path!, stages: [] };
    conflict.stages.push({ mode: mode!, oid: qualify(oid!), stage: Number(stage) });
    conflicts.set(path!, conflict);
  }
  execute(repository, ["update-ref", "refs/grounds/merged-tree", result]);
  const currentIndex = existsSync(index) ? readFileSync(index) : undefined;
  if (historyGit(cwd, ["rev-parse", "HEAD"]) !== (input.source_head ? raw(input.source_head) : base) || (originalIndex ? !currentIndex?.equals(originalIndex) : currentIndex !== undefined)) {
    throw validation("sync.snapshot", "HEAD or index changed during preparation; inputs retained, restart explicitly");
  }
  const plan: SyncMerge = { repository, original_base: input.base, target: input.target, original_tree: artifact.result_tree_oid, raw_snapshot_digest: frozen.manifest,
    ...(originalIndex ? { original_index_digest: digestBytes(originalIndex) } : {}), result_tree: qualify(result), conflicts: [...conflicts.values()] };
  atomicPrivateWrite(join(directory, "merge.json"), JSON.stringify(plan, null, 2) + "\n");
  return plan;
}
