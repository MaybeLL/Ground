import { execFileSync } from "node:child_process";

const GIT_ENVIRONMENT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };

export interface GitOptions {
  cwd?: string;
  gitDir?: string;
  workTree?: string;
  input?: string | Buffer;
  env?: Record<string, string>;
  /** Disables hook execution for commands that run against an execution ledger. */
  hooksPath?: string;
}

/** Runs git with an explicit repository, a cleared global configuration and no shell. */
export const git = (args: string[], options: GitOptions = {}): string => {
  const prefix = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
    ...(options.hooksPath ? ["-c", `core.hooksPath=${options.hooksPath}`] : []),
    ...(options.gitDir ? ["--git-dir", options.gitDir] : []),
    ...(options.workTree ? ["--work-tree", options.workTree] : []),
  ];
  return execFileSync("git", [...prefix, ...args], {
    cwd: options.cwd,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_"))), ...GIT_ENVIRONMENT, ...options.env },
    encoding: "utf8",
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).replace(/\n$/, "");
};

/** Like git, but returns undefined when the command fails instead of throwing. */
export const gitTry = (args: string[], options: GitOptions = {}): string | undefined => {
  try {
    return git(args, options);
  } catch {
    return undefined;
  }
};
