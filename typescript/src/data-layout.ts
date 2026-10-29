import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { validation } from "./errors.js";

/** One user data root on both macOS and Linux. Resolution does not create files. */
export function dataRoot(override?: string, cwd = process.cwd()): string {
  const selected = override ?? process.env.GROUNDS_DATA_HOME;
  if (selected !== undefined) {
    if (!selected.trim()) throw validation("data-root", "must not be empty");
    return resolve(cwd, selected);
  }
  return join(homedir(), ".grounds");
}

export interface DataLayout {
  root: string;
  config: string;
  database: string;
  drafts: string;
  workspaces: string;
  runtime: string;
  cache: string;
  directoryRegistry: string;
}

export function dataLayout(root = dataRoot()): DataLayout {
  if (!isAbsolute(root)) throw validation("data-root", "must be an absolute path");
  return {
    root, config: join(root, "config.yaml"), database: join(root, "grounds.db"),
    drafts: join(root, "drafts"), workspaces: join(root, "workspaces"),
    runtime: join(root, "runtime"), cache: join(root, "cache"),
    directoryRegistry: join(homedir(), ".grounds", "directory-registry"),
  };
}

/** Legacy locations are discovery inputs for migration, never fallback writes. */
export function previousDataLocations(
  system = process.platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): { config: string; data: string; runtime: string; directoryRegistry: string } {
  const data = system === "darwin" ? join(home, "Library", "Application Support", "Grounds")
    : system === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Grounds")
    : join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "grounds");
  const config = system === "darwin" || system === "win32" ? join(data, "config.yaml")
    : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "grounds", "config.yaml");
  return { config, data, runtime: env.GROUNDS_RUNTIME_HOME ?? join(home, ".local", "share", "grounds-runtime"),
    directoryRegistry: join(home, ".local", "share", "grounds-directory-registry") };
}

/** Different clones retain separate local state; linked worktrees share their Git owner. */
export function repositoryDataRoot(repository: string, root = dataRoot()): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return repositoryDataRootForCommon(realpathSync(common), root);
}

/** Migration can calculate an owner after relocation before that directory exists. */
export function repositoryDataRootForCommon(common: string, root = dataRoot()): string {
  if (!isAbsolute(common)) throw validation("repository", "common directory must be absolute");
  const key = createHash("sha256").update(resolve(common)).digest("hex");
  return join(root, "repositories", key);
}

/** Read-only counterpart to private directory creation; missing roots stay missing. */
export function assertManagedAncestors(path: string): void {
  let current: string = sep;
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw validation("path", "symlink/non-directory in managed path");
  }
}

/** Names are local to the configured ledger; this is storage isolation, not a connection manager. */
export function draftsRoot(databaseId: string): string {
  if (typeof databaseId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(databaseId)) throw validation("database_id", "invalid draft namespace");
  const root = join(dataLayout().drafts, databaseId);
  assertManagedAncestors(root);
  return root;
}
