import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validation } from "./errors.js";

const LEGACY_RULE = "/.grounds/";
const GROUNDS_RULES = ["/.grounds/*", "!/.grounds/environments/", "/.grounds/environments/*", "!/.grounds/environments/*.yaml"];
/** Only direct YAML declarations are versioned; nested files and runtime material remain private. */
export const isEnvironmentDefinitionPath = (path: string): boolean => /^\.grounds\/environments\/[^/]+\.yaml$/.test(path);
export const isPrivateGroundsPath = (path: string): boolean => (path === ".grounds" || path.startsWith(".grounds/")) && !isEnvironmentDefinitionPath(path);
export const assertNoTrackedGroundsRuntime = (repositoryRoot: string): void => {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ".grounds"], { cwd: repositoryRoot, encoding: "utf8" }).split("\0").filter(isPrivateGroundsPath);
  if (tracked.length) throw validation("worktree", ".grounds contains tracked private runtime files");
};

/**
 * Returns the local exclude text with the Grounds rules present. The legacy whole-directory rule is
 * replaced: an excluded directory cannot have a child re-included, so environment definitions would stay ignored.
 */
export const withGroundsExclude = (current: string): string => {
  const lines = current.split(/\r?\n/);
  const kept = lines.filter((line) => line !== LEGACY_RULE);
  const missing = GROUNDS_RULES.filter((rule) => !kept.includes(rule));
  if (missing.length === 0 && kept.length === lines.length) return current;
  const body = kept.join("\n").replace(/\n+$/, "");
  return [body, ...missing].filter((part) => part !== "").join("\n") + "\n";
};

/** Refuses repositories that track Grounds state other than environment definitions, then writes the rules. */
export const ensureGroundsExcluded = (repositoryRoot: string): void => {
  assertNoTrackedGroundsRuntime(repositoryRoot);
  const raw = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const exclude = resolve(repositoryRoot, raw);
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const next = withGroundsExclude(current);
  if (next === current) return;
  mkdirSync(dirname(exclude), { recursive: true });
  const temporary = `${exclude}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, next, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, exclude);
};
