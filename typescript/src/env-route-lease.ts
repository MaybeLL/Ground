import { isWithinCodeRoute } from "./code-route-fence.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { directoryRegistryRoot, directoryRegistryLocation, privateDirectory, safeRead, overlaps, withRuntimeLockSync } from "./runtime-files.js";
import { readRecord } from "./env-store.js";
import { stateConflict } from "./errors.js";
import { gitTry } from "./env-git.js";
export const LEDGER_JOURNAL = "grounds-route.json";
export interface RouteLease { runId: string; route: string; environmentId: string; runDirectory: string; acquiredAt: string; file: string }
const leaseFile = (route: string): string => join(privateDirectory(join(directoryRegistryRoot(), "environment-occupancy")), createHash("sha256").update(realpathSync(route)).digest("hex") + ".json");
const legacyUnresolved = (route: string): boolean => {
  const dotgit = join(route, ".git");
  let entry;
  try { entry = lstatSync(dotgit); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (entry.isDirectory()) return false;
  if (!entry.isFile()) return true;
  const text = readFileSync(dotgit,"utf8").trim();
  if (!text.startsWith("gitdir: ")) return true;
  const target = resolve(route, text.slice(8));
  return !existsSync(join(target,"HEAD")) || existsSync(join(target,LEDGER_JOURNAL)) || existsSync(join(target,"objects/info/alternates"));
};
/** Retired ownership is only a refusal signal. Never repair or release it here. */
export const assertIndependentWorkspace = (workspace: string): void => {
  const route = realpathSync(workspace);
  for (let current = route; ; current = dirname(current)) {
    if (legacyUnresolved(current) || isWithinCodeRoute(current)) throw stateConflict("environment", "workspace", "retired route or damaged private Git remains reserved");
    // DevRun owners live beside their worktree. Presence (even a broken symlink)
    // is sufficient; parsing a corrupt marker must not grant execution.
    for (const name of ["owner.json", "state.json"]) {
      try { lstatSync(join(dirname(current), name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      throw stateConflict("environment", "workspace", "retired managed workspace remains reserved");
    }
    if (dirname(current) === current) break;
  }
  const registry = join(directoryRegistryLocation(), "workspace-registry.json");
  let entries: unknown;
  try { entries = JSON.parse(safeRead(registry, 1024 * 1024).toString()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw stateConflict("environment", "workspace", "unreadable retired workspace registry; retained unchanged"); }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw stateConflict("environment", "workspace", "invalid retired workspace registry");
  for (const [key, value] of Object.entries(entries)) {
    // Mirror the retained WorkspaceLease record's required identity fields.
    // Never call workspaceLeases here: that old API can prune and rewrite rows.
    if (!value || typeof value !== "object" || Array.isArray(value) || value.run !== key
      || typeof value.database !== "string" || typeof value.identity !== "string" || typeof value.input_digest !== "string"
      || (value.ownership !== undefined && !["managed", "external"].includes(value.ownership))
      || (value.initial_changes !== undefined && (!Array.isArray(value.initial_changes) || value.initial_changes.some((path: unknown) => typeof path !== "string")))
      || (value.result_tree_oid !== undefined && typeof value.result_tree_oid !== "string")
      || typeof value.directory !== "string" || !value.directory.startsWith("/")) throw stateConflict("environment", "workspace", "invalid retired workspace reservation");
    if (overlaps(value.directory, route) || (existsSync(value.directory) && overlaps(realpathSync(value.directory), route))) throw stateConflict("environment", "workspace", "retired DevRun workspace remains reserved");
  }
};
/** Persistent occupancy is outside execution mounts; no PID or stale lock heuristic grants release. */
export const isRouteLeased = (route: string): boolean => existsSync(route) && (isWithinCodeRoute(realpathSync(route)) || legacyUnresolved(route) || existsSync(leaseFile(route)));
export const isRouteWorkspace = (workspace: string): boolean => existsSync(join(workspace,".git")) && lstatSync(join(workspace,".git")).isFile() && gitTry(["rev-parse", "--is-inside-work-tree"], { cwd: workspace }) === "true";
export const acquireRouteLease = (input: { route: string; environmentId: string; runDirectory: string; seedRoot?: string; runId?: string }): RouteLease =>
  withRuntimeLockSync(directoryRegistryLocation(), "directory-registry", () => {
  const route = realpathSync(input.route);
  assertIndependentWorkspace(route);
  if (legacyUnresolved(route)) throw stateConflict("environment", input.environmentId, "legacy private Git or damaged pointer requires explicit recovery; retained unchanged");
  if (isWithinCodeRoute(route)) throw stateConflict("environment", input.environmentId, "code Workspace route remains reserved; legacy execution cannot acquire it");
  const file = leaseFile(route);
  const lease = { runId: input.runId ?? basename(input.runDirectory), route, environmentId: input.environmentId, runDirectory: input.runDirectory, acquiredAt: new Date().toISOString(), file };
  try { writeFileSync(file, JSON.stringify(lease), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    const existing = readRecord<RouteLease>(file);
    // The environment owns the workspace through all its stopped command phases,
    // until explicit finalization has saved artifacts and released its resources.
    if (existing.environmentId === input.environmentId && existing.route === route) return existing;
    throw stateConflict("environment", input.environmentId, "workspace remains occupied; finalize the owning environment");
  } throw error; }
  return lease;
});
export const releaseRouteLease = (lease: RouteLease, finalizedEnvironment = false): void => {
  if (!existsSync(lease.file)) return;
  const current = readRecord<RouteLease>(lease.file);
  if (current.runId !== lease.runId || current.environmentId !== lease.environmentId || current.route !== lease.route) {
    // A completed environment may be replaying after the prior unlink succeeded.
    // Never disturb the later owner's lease; its existence does not undo finalization.
    if (finalizedEnvironment) return;
    throw stateConflict("environment", lease.environmentId, "occupancy identity changed");
  }
  unlinkSync(lease.file);
};
/** Legacy private ledgers are deliberately not auto-imported, reset, normalized or deleted. */
export const recoverAbandonedRoute = (runDirectory: string): void => {
  if (existsSync(join(runDirectory, "ledger", LEDGER_JOURNAL))) throw stateConflict("environment", basename(runDirectory), "legacy private Git requires explicit recovery; retained unchanged");
};
