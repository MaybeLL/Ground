import { withGitRunner } from "./git-command.js";
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { baselineUnavailable } from "./errors.js";

// Git reads and their budget must not depend on delivery/worktree business modules.
export const rawOID = (value: string): string => value.replace(/^sha(?:1|256):/, "");
interface HistoryRead { deadline: number; bytes: number; cache: Map<string, Buffer> }
const reads = new AsyncLocalStorage<HistoryRead>();
export const withHistoryRead = <T>(run: () => Promise<T>): Promise<T> => reads.run({ deadline: Date.now() + 30_000, bytes: 0, cache: new Map() }, () => withGitRunner((cwd, args, index, input) => historyBytes(cwd, args, input, index), run));
export function assertHistoryBudget(): void {
  const state = reads.getStore();
  if (state && Date.now() >= state.deadline) throw baselineUnavailable("history_time_budget exhausted");
}
export function historyBytes(cwd: string, args: string[], input?: Buffer, indexFile?: string): Buffer {
  assertHistoryBudget();
  const state = reads.getStore();
  const cacheable = !indexFile && ["cat-file", "ls-tree", "rev-list", "diff-tree"].includes(args[0]);
  const key = JSON.stringify([cwd, args, input?.toString("base64"), indexFile]);
  const cached = cacheable ? state?.cache.get(key) : undefined;
  if (cached) return cached;
  const remaining = (state?.deadline ?? Date.now() + 30_000) - Date.now();
  if (remaining <= 0) throw baselineUnavailable("history_time_budget exhausted");
  const diffIndex = args.findIndex(arg => arg === "diff" || arg === "diff-tree");
  if (diffIndex >= 0) args = [...args.slice(0, diffIndex + 1), "--no-textconv", "--no-ext-diff", ...args.slice(diffIndex + 1)];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  let bytes: Buffer;
  try {
    bytes = execFileSync("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "diff.algorithm=myers", "-c", "blame.ignoreRevsFile=", ...args], { cwd, input, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) }, timeout: remaining, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  } catch { throw baselineUnavailable("Git history object is unavailable, unsupported, or exceeds the read budget"); }
  if (state) {
    state.bytes += bytes.length;
    if (state.bytes > 128 * 1024 * 1024) throw baselineUnavailable("history_byte_budget exhausted");
    if (cacheable) state.cache.set(key, bytes);
  }
  return bytes;
}
export const historyGit = (cwd: string, args: string[], input?: Buffer): string => historyBytes(cwd, args, input).toString("utf8").trimEnd();
export function assertHistoryRepository(cwd: string): void {
  if (historyGit(cwd, ["rev-parse", "--is-shallow-repository"]) === "true") throw baselineUnavailable("Shallow history is not supported; provide complete local history explicitly");
  const config = historyGit(cwd, ["config", "--null", "--list", "--local"]);
  if (config.split("\0").some(entry => /^extensions\.partialclone\n/i.test(entry) || /^remote\..+\.promisor\n(?:true|1|yes)$/i.test(entry))) throw baselineUnavailable("Partial clone history is not supported; trace never fetches objects implicitly");
  const grafts = historyGit(cwd, ["rev-parse", "--git-path", "info/grafts"]);
  if (existsSync(resolve(cwd, grafts))) throw baselineUnavailable("Git grafts are not supported by history tracing");
}

