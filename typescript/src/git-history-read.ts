import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { baselineUnavailable, worktreeMismatch } from "./errors.js";

// Git reads and their budget must not depend on delivery/worktree business modules.
export const rawOID = (value: string): string => value.replace(/^sha(?:1|256):/, "");
export function historyBytes(cwd: string, args: string[], input?: Buffer): Buffer {
  const diffIndex = args.findIndex(arg => arg === "diff" || arg === "diff-tree");
  if (diffIndex >= 0) args = [...args.slice(0, diffIndex + 1), "--no-textconv", "--no-ext-diff", ...args.slice(diffIndex + 1)];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  let bytes: Buffer;
  try {
    bytes = execFileSync("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "diff.algorithm=myers", "-c", "blame.ignoreRevsFile=", ...args], { cwd, input, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  } catch { throw baselineUnavailable("Git history object is unavailable, unsupported, or exceeds the read budget"); }
  return bytes;
}
export const historyGit = (cwd: string, args: string[], input?: Buffer): string => historyBytes(cwd, args, input).toString("utf8").trimEnd();
export function assertHistoryRepository(cwd: string): void {
  if (historyGit(cwd, ["rev-parse", "--is-shallow-repository"]) === "true") throw baselineUnavailable("Shallow history is not supported; provide complete local history explicitly");
  const config = historyGit(cwd, ["config", "--null", "--list", "--local"]);
  if (config.split("\0").some(entry => /^extensions\.partialclone\n/i.test(entry) || /^remote\..+\.promisor\n(?:true|1|yes)$/i.test(entry))) throw baselineUnavailable("Partial clone history is not supported; local inspections require complete objects");
  const grafts = historyGit(cwd, ["rev-parse", "--git-path", "info/grafts"]);
  if (existsSync(resolve(cwd, grafts))) throw baselineUnavailable("Local history inspection does not support Git grafts");
}

export function assertNoHistoryFilters(cwd: string): void {
  const paths = historyGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (!paths) return;
  const attrs = historyGit(cwd, ["check-attr", "-z", "--stdin", "filter", "working-tree-encoding"], Buffer.from(paths)).split("\0");
  for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] !== "unspecified" && attrs[i + 2] !== "unset") throw worktreeMismatch("", "Cannot inspect worktree inputs with clean filters or working-tree encoding conversions");
}
