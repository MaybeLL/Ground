import { existsSync, lstatSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { sha256 } from "./canonical-json.js";
import { validation } from "./errors.js";
import { atomicPrivateWrite, digestBytes, safeRead } from "./runtime-files.js";
import { relocateLocalBinding, relocatePath, type PathMapping } from "./storage-bindings.js";

export interface LocalBindingChange {
  source: string;
  target: string;
  replacement_target: string;
  original_digest: string;
  replacement: string;
}

/** Sync merge inputs contain arbitrary user code, including unresolved JSON conflicts. */
function isSyncCodeSnapshot(path: string): boolean {
  if (!["desired-worktree", "merge"].includes(basename(path)) || basename(dirname(dirname(path))) !== "sync") return false;
  const journalPath = join(dirname(path), "journal.json");
  if (!existsSync(journalPath)) return false;
  let saved: { journal?: { format?: string }; digest?: string };
  try { saved = JSON.parse(safeRead(journalPath, 16 * 1024 * 1024).toString()); }
  catch { throw validation("migration", `invalid sync recovery metadata: ${journalPath}`); }
  if (!saved?.journal || saved.journal.format !== "grounds.local-sync/v1") return false;
  if (saved.digest !== sha256(saved.journal)) throw validation("migration", `invalid sync recovery digest: ${journalPath}`);
  return true;
}

/** Only scan managed metadata, excluding Git checkouts and immutable review/archive material. */
export function inspectLocalBindings(roots: string[], worktrees: string[], mappings: PathMapping[]): LocalBindingChange[] {
  const changes: LocalBindingChange[] = [];
  const visited = new Set<string>();
  function visit(path: string): void {
    if (visited.has(path) || worktrees.includes(path)) return;
    visited.add(path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if ([".git", "archive", "backups", "reviews", "locks", "content", "capture", "private", "credentials"].includes(basename(path))) return;
      if (isSyncCodeSnapshot(path)) return;
      for (const name of readdirSync(path)) visit(join(path, name));
      return;
    }
    if (!stat.isFile() || !path.endsWith(".json")) return;
    if (["pending.json", ".pending-publication.json"].includes(basename(path)))
      throw validation("migration", `finish or recover pending operation before migration: ${path}`);
    const bytes = safeRead(path, 32 * 1024 * 1024);
    let value: Record<string, unknown>;
    try { value = JSON.parse(bytes.toString()); } catch { throw validation("migration", `invalid managed metadata: ${path}`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.format === "grounds.code-route-execution/v1" && value.state !== "stopped")
      throw validation("migration", `route execution is not proven stopped: ${path}`);
    if (value.format === "grounds.environment/v1" && value.state !== "released")
      throw validation("migration", `environment still owns its resources; finalize it before migration: ${path}`);
    if (value.format === "grounds.environment-run/v1" && (value.state === "running" || value.termination !== "confirmed"))
      throw validation("migration", `environment command termination is not confirmed: ${path}`);
    const updated = relocateLocalBinding(value, mappings);
    if (!updated) return;
    const target = relocatePath(path, mappings);
    const replacementTarget = value.format === "patchledger.local-delivery/v1"
      ? join(target.slice(0, target.lastIndexOf(sep)), createHash("sha256").update(String(updated.target_path)).digest("hex") + ".json")
      : target;
    changes.push({ source: path, target, replacement_target: replacementTarget,
      original_digest: digestBytes(bytes), replacement: JSON.stringify(updated) });
  }
  for (const root of roots) if (existsSync(root)) visit(root);
  return changes;
}

/** Caller owns the migration lock and has retained originals before changing a live binding. */
export function applyLocalBindings(changes: LocalBindingChange[]): void {
  // Check the complete set before the first write. Replays accept only exact replacements.
  for (const change of changes) {
    const replacement = Buffer.from(change.replacement);
    if (existsSync(change.replacement_target) && safeRead(change.replacement_target).equals(replacement)) continue;
    if (!existsSync(change.target) || digestBytes(safeRead(change.target)) !== change.original_digest)
      throw validation("migration", "local routing changed after planning; retain migration journal and reconcile");
    if (change.replacement_target !== change.target && existsSync(change.replacement_target))
      throw validation("migration", "relocated delivery metadata destination is occupied");
  }
  for (const change of changes) {
    const replacement = Buffer.from(change.replacement);
    if (!existsSync(change.replacement_target) || !safeRead(change.replacement_target).equals(replacement))
      atomicPrivateWrite(change.replacement_target, replacement);
    if (change.target !== change.replacement_target && existsSync(change.target)) {
      if (digestBytes(safeRead(change.target)) !== change.original_digest)
        throw validation("migration", "old delivery metadata changed during cutover");
      const retired = change.target + ".retired-data-migration";
      if (existsSync(retired)) throw validation("migration", "delivery metadata recovery path is occupied");
      renameSync(change.target, retired);
    }
  }
}
