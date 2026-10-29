import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { dataRoot, previousDataLocations, repositoryDataRootForCommon } from "./data-layout.js";
import { validation } from "./errors.js";
import { digestBytes, safeRead, directoryRegistryLocation } from "./runtime-files.js";
import { planRelocation, type RelocationJournal } from "./storage-relocation.js";
import { unfinishedOperationPaths } from "./development-branch.js";

export interface DataMigrationPlan {
  format: "grounds.data-migration-plan/v1";
  target_root: string;
  mappings?: Array<{ source: string; target: string }>;
  git_metadata?: Array<{ path: string; bytes_base64: string }>;
  metadata_roots?: string[];
  relocation: RelocationJournal;
  extractions?: RelocationJournal[];
  repositories: string[];
  worktrees: Array<{ source: string; target: string; head: string; status: string; common: string; index_digest?: string }>;
  preserved: string[];
  blockers: string[];
}
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();

/** Discovery is read-only. Fixed moves and snapshots are later consumed by the migration coordinator. */
export function planDataMigration(input: {
  id: string; targetRoot?: string; oldDataRoot?: string; oldConfig?: string;
  oldRuntime?: string; oldRegistry?: string; repositories: string[];
}): DataMigrationPlan {
  const previous = previousDataLocations(), target = dataRoot(input.targetRoot);
  const oldData = resolve(input.oldDataRoot ?? previous.data);
  const moves: Array<{ source: string; target: string }> = [], preserved: string[] = [], blockers: string[] = [];
  const add = (source: string, destination: string) => {
    if (!existsSync(source) || resolve(source) === resolve(destination)) return;
    if (moves.some(move => move.source === source)) return;
    moves.push({ source, target: destination });
  };
  if (existsSync(oldData) && oldData !== target) {
    for (const name of readdirSync(oldData)) {
      if (name === ".DS_Store") continue;
      const source = join(oldData, name);
      if (name === "archive") { preserved.push(source); continue; }
      if (name === "runtime") {
        for (const child of readdirSync(source)) {
          // Old controllers still coordinate through these inode-bound locks.
          // Retain them like the legacy environment/registry lock directories;
          // moving them would break both mutual exclusion and migration replay.
          if (child === "locks") { preserved.push(join(source, child)); continue; }
          add(join(source, child), join(target, "runtime", child));
        }
      } else if (name === "migration") add(source, join(target, "migration", "previous"));
      else if (["config.yaml", "grounds.db", "cache", "workspaces", "backups"].includes(name)) add(source, join(target, name));
      else blockers.push(`Unrecognized old data entry requires classification: ${source}`);
    }
  }
  const config = resolve(input.oldConfig ?? previous.config);
  if (!moves.some(move => move.source === config)) add(config, join(target, "config.yaml"));
  const oldRuntime = resolve(input.oldRuntime ?? previous.runtime), oldRegistry = resolve(input.oldRegistry ?? previous.directoryRegistry);
  const addChildren = (source: string, destination: string): void => {
    if (!existsSync(source) || source === destination) return;
    for (const child of readdirSync(source)) {
      if (child === "locks" || child === ".DS_Store") continue;
      add(join(source, child), join(destination, child));
    }
  };
  addChildren(oldRuntime, join(target, "runtime", "env"));
  // Registry remains user-global even when task data uses an explicit root.
  addChildren(oldRegistry, directoryRegistryLocation());
  const repositories = new Set<string>(), seenCommon = new Set<string>();
  const collectWorktrees = (root: string): void => {
    const common = realpathSync(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    if (seenCommon.has(common)) return;
    seenCommon.add(common);
    for (const record of git(root, ["worktree", "list", "--porcelain", "-z"]).split("\0\0")) {
      const fields = record.split("\0");
      if (fields.includes("bare")) continue;
      const field = fields.find(item => item.startsWith("worktree "));
      if (field && existsSync(field.slice(9))) repositories.add(realpathSync(field.slice(9)));
    }
  };
  for (const requested of input.repositories) collectWorktrees(realpathSync(git(requested, ["rev-parse", "--show-toplevel"])));
  const registryPath = join(oldRegistry, "workspace-registry.json");
  if (existsSync(registryPath)) {
    const leases = JSON.parse(safeRead(registryPath, 1024 * 1024).toString());
    if (!leases || typeof leases !== "object" || Array.isArray(leases)) throw validation("migration", "invalid workspace registry");
    for (const lease of Object.values(leases) as Array<{ directory?: unknown }>) {
      if (!lease || typeof lease.directory !== "string") throw validation("migration", "invalid workspace lease directory");
      if (existsSync(join(lease.directory, ".git"))) collectWorktrees(lease.directory);
    }
  }
  const cache = join(oldData, "cache", "repos");
  if (existsSync(cache)) for (const name of readdirSync(cache)) collectWorktrees(join(cache, name));
  const mapped = (path: string) => {
    const owner = moves.filter(move => path === move.source || path.startsWith(move.source + sep)).sort((a,b) => b.source.length-a.source.length)[0];
    return owner ? owner.target + path.slice(owner.source.length) : path;
  };
  for (const repository of repositories) {
    const reserved = join(repository, ".grounds");
    if (!existsSync(reserved)) continue;
    if (lstatSync(reserved).isSymbolicLink()) { blockers.push(`Repository state root is a symlink: ${reserved}`); continue; }
    for (const name of readdirSync(reserved)) {
      const source = join(reserved, name);
      if (["environments", "archive", "preparation-git-credentials.json"].includes(name)) { preserved.push(source); continue; }
      if (name === ".DS_Store") continue;
      if (name === "authoring") {
        for (const draft of readdirSync(source)) {
          const directory = join(source, draft), manifestPath = join(directory, ".workspace.json");
          if (!existsSync(manifestPath)) { blockers.push(`Unknown draft entry: ${directory}`); continue; }
          const manifest = JSON.parse(safeRead(manifestPath).toString());
          if (typeof manifest.database_id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(manifest.database_id)) throw validation("migration", "draft has invalid ledger identity");
          add(directory, join(target, "drafts", manifest.database_id, draft));
        }
      } else if (["development", "devruns", "reviews", "contract-reviews", "deliveries", "delivery", "release", "releases", "backups"].includes(name)) {
        const destination = join(repositoryDataRootForCommon(mapped(realpathSync(git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))), target), name);
        for (const child of readdirSync(source)) add(join(source, child), join(destination, child));
      } else blockers.push(`Unrecognized repository state requires classification: ${source}`);
    }
  }
  const worktrees: DataMigrationPlan["worktrees"] = [];
  const gitMetadata = new Map<string, string>(), metadataRoots = new Set<string>();
  for (const repository of repositories) {
    const common = git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    metadataRoots.add(join(common, "grounds-deliveries"));
    const destination = mapped(repository);
    if (destination === repository) continue;
    const index = git(repository, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    worktrees.push({ source: repository, target: destination, head: git(repository, ["rev-parse", "HEAD"]),
      status: git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      common,
      index_digest: existsSync(index) ? digestBytes(safeRead(index)) : "absent" });
    const administration = git(repository, ["rev-parse", "--absolute-git-dir"]);
    for (const name of ["gitdir", "commondir"]) {
      const path = join(administration, name);
      if (existsSync(path)) gitMetadata.set(path, safeRead(path, 16 * 1024).toString("base64"));
    }
    if (existsSync(index + ".lock") || git(repository, ["ls-files", "-u"]) || unfinishedOperationPaths(repository).some(path => existsSync(path))) blockers.push(`Unfinished Git operation: ${repository}`);
  }
  for (let a = 0; a < moves.length; a++) for (let b = a + 1; b < moves.length; b++) {
    const x = moves[a].target, y = moves[b].target;
    if (x === y || x.startsWith(y + sep) || y.startsWith(x + sep))
      throw validation("migration", "multiple source entries claim overlapping destinations");
  }
  // Copy outer trees intact first. Nested legacy state is then extracted from the
  // new copy, so the original outer backup remains complete and byte-identical.
  const depth = (move: { source: string }) => moves.filter(parent => move.source.startsWith(parent.source + sep)).length;
  const relocation = planRelocation(input.id, moves.filter(move => depth(move) === 0));
  const extractions: RelocationJournal[] = [];
  for (let level = 1; level <= Math.max(0, ...moves.map(depth)); level++) {
    const nested = moves.filter(move => depth(move) === level);
    const extraction = planRelocation(input.id, nested);
    extraction.entries = extraction.entries.map(entry => {
      const parent = moves.filter(move => entry.source.startsWith(move.source + sep)).sort((a, b) => b.source.length - a.source.length)[0]!;
      const source = parent.target + entry.source.slice(parent.source.length);
      return { ...entry, source, retired: `${source}.retired-${input.id}` };
    });
    extractions.push(extraction);
  }
  const mappings = [{ source: oldData, target }, { source: oldRuntime, target: join(target, "runtime", "env") },
    { source: oldRegistry, target: directoryRegistryLocation() }, ...moves];
  return { format: "grounds.data-migration-plan/v1", target_root: target, mappings, relocation, extractions, repositories: [...repositories], worktrees,
    git_metadata: [...gitMetadata].map(([path, bytes_base64]) => ({ path, bytes_base64 })), metadata_roots: [...metadataRoots], preserved, blockers };
}
