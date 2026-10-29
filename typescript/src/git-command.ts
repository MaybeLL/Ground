import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type GitRunner = (cwd: string, args: string[], indexPath?: string, input?: Buffer) => Buffer;
const scopedRunner = new AsyncLocalStorage<GitRunner>();
/** Let a read workflow enforce its own environment and cumulative budget. */
export const withGitRunner = <T>(runner: GitRunner, run: () => T): T => scopedRunner.run(runner, run);

const executeGit = (cwd: string, args: string[], indexPath?: string, input?: Buffer, timeoutMs = 120_000, extraEnv?: NodeJS.ProcessEnv): Buffer => {
  let temporary: string | undefined;
  let inputFd: number | undefined;
  try {
    if (input !== undefined) {
      temporary = mkdtempSync(join(tmpdir(), "grounds-git-input-"));
      const path = join(temporary, "stdin");
      writeFileSync(path, input, { mode: 0o600, flag: "wx" });
      inputFd = openSync(path, "r");
    }
    return execFileSync("git", args, {
      cwd: cwd || undefined,
      env: { ...process.env, ...(extraEnv ?? {}), ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}) },
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      stdio: [inputFd ?? "ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
    const timedOut = error && typeof error === "object" && "code" in error && error.code === "ETIMEDOUT";
    throw new Error(`git ${args.join(" ")} ${timedOut ? `timed out after ${timeoutMs}ms` : "failed"}${stderr ? `: ${stderr.trim()}` : ""}`);
  } finally {
    try { if (inputFd !== undefined) closeSync(inputFd); }
    finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
  }
};

/** Bound local Git operations and give patch readers a finite, binary-safe input. */
export const runGit = (cwd: string, args: string[], indexPath?: string, input?: Buffer, timeoutMs = 120_000): Buffer => {
  const runner = scopedRunner.getStore();
  if (runner) return runner(cwd, args, indexPath, input);
  return executeGit(cwd, args, indexPath, input, timeoutMs);
};

/**
 * Run read-only inspections so that nothing they do can add Git objects, take
 * optional index locks, or fetch lazily in the user's clone.  Objects written
 * by the capture/rebuild helpers go to a throw-away object directory while the
 * clone's own object store is attached as a read-only alternate.
 */
export const withIsolatedGitObjects = <T>(repositoryPath: string, run: () => T): T => {
  const common = executeGit(repositoryPath, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]).toString("utf8").trim();
  const scratch = mkdtempSync(join(tmpdir(), "grounds-objects-"));
  const env: NodeJS.ProcessEnv = {
    GIT_OBJECT_DIRECTORY: scratch,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: common,
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  try { return scopedRunner.run((cwd, args, indexPath, input) => executeGit(cwd, args, indexPath, input, 120_000, env), run); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
};

/** Run one Git command with extra environment, bypassing any scoped runner (used only for the explicit network refresh). */
export const runGitWithEnv = (cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Buffer => executeGit(cwd, args, undefined, undefined, timeoutMs, env);
