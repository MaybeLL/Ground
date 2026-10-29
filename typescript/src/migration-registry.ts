import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validation } from "./errors.js";
import { atomicPrivateWrite, safeRead } from "./runtime-files.js";
import { workspaceIdentity, type WorkspaceLease } from "./workspace-provider.js";
import { relocatePath, type PathMapping } from "./storage-bindings.js";

function readLeases(bytes: string, mappings: PathMapping[]): Record<string, WorkspaceLease> {
  const value = JSON.parse(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation("migration", "invalid workspace registry");
  for (const [key, lease] of Object.entries(value) as Array<[string, WorkspaceLease]>) {
    if (!lease || lease.run !== key || typeof lease.directory !== "string" || typeof lease.identity !== "string"
      || typeof lease.database !== "string" || typeof lease.input_digest !== "string"
      || (lease.ownership !== undefined && !["managed", "external"].includes(lease.ownership)))
      throw validation("migration", "invalid workspace reservation");
    if (lease.ownership === "external" && relocatePath(lease.directory, mappings) !== lease.directory)
      throw validation("migration", "external directory reservation cannot be moved as managed data");
  }
  return value;
}

export function inspectWorkspaceRegistry(path: string, mappings: PathMapping[]): string | undefined {
  if (!existsSync(path)) return undefined;
  const bytes = safeRead(path, 1024 * 1024).toString();
  readLeases(bytes, mappings);
  return bytes;
}

/** Rebind copied managed directories while retaining absent and unrelated reservations. */
export function repairWorkspaceRegistry(path: string, original: string, mappings: PathMapping[]): void {
  const leases = readLeases(original, mappings);
  for (const lease of Object.values(leases)) {
    const directory = relocatePath(lease.directory, mappings);
    if (directory === lease.directory) continue;
    lease.directory = directory;
    if (existsSync(directory)) lease.identity = workspaceIdentity(directory);
  }
  const replacement = JSON.stringify(leases), current = safeRead(path, 1024 * 1024).toString();
  if (current === replacement) return;
  if (current !== original) throw validation("migration", "workspace registry changed during migration");
  atomicPrivateWrite(path, replacement);
}

/** A stopped command can still have an owning environment; never orphan that lease. */
export function requireIdleEnvironmentLeases(root: string, mappings: PathMapping[]): void {
  const directory = join(root, "environment-occupancy");
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (name === ".DS_Store") continue;
    const lease = JSON.parse(safeRead(join(directory, name), 16 * 1024).toString());
    if (!lease || typeof lease.route !== "string" || typeof lease.runDirectory !== "string")
      throw validation("migration", "invalid environment occupancy record");
    if ([lease.route, lease.runDirectory].some(path => relocatePath(path, mappings) !== path))
      throw validation("migration", "finalize the environment before migrating its reserved directory");
  }
}
