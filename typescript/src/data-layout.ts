import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  workspaces: string;
  runtime: string;
  cache: string;
  directoryRegistry: string;
}

export function dataLayout(root = dataRoot()): DataLayout {
  if (!isAbsolute(root)) throw validation("data-root", "must be an absolute path");
  return {
    root, config: join(root, "config.yaml"), database: join(root, "grounds.db"),
    workspaces: join(root, "workspaces"),
    runtime: join(root, "runtime"), cache: join(root, "cache"),
    directoryRegistry: join(homedir(), ".grounds", "directory-registry"),
  };
}

/** Different clones retain separate local state; linked worktrees share their Git owner. */
export function repositoryDataRoot(repository: string, root = dataRoot()): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const key = createHash("sha256").update(realpathSync(common)).digest("hex");
  return join(root, "repositories", key);
}
