import { lstatSync } from "node:fs";
import { atomicPrivateWrite, safeRead } from "./runtime-files.js";
import { validation } from "./errors.js";
import { durableRenameNoReplace } from "./storage-relocation.js";
import type { DataMigrationPlan } from "./data-migration-plan.js";

export function retiredMarkers(plan: DataMigrationPlan): Map<string, string> {
  return new Map([plan.relocation, ...(plan.extractions ?? [])].flatMap(stage => stage.entries.map(entry => [entry.source,
    JSON.stringify({ format: "grounds.retired-data-location/v1", source: entry.source, target: entry.target,
      message: "This location was migrated. Use the current Grounds version and its unified data root." })] as [string, string])));
}

/** A file in place of each old directory, and invalid legacy config, prevents old
 * clients from silently recreating their former writable layout. Originals are
 * retained at the journal's retired paths. Explicit manual replacement is outside
 * this cooperative CLI boundary and is detected by the new client's layout guard. */
export function installRetiredMarkers(plan: DataMigrationPlan): void {
  const markers = retiredMarkers(plan);
  for (const [path, bytes] of markers) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || safeRead(path, 64 * 1024).toString() !== bytes))
      throw validation("migration", "an old location was recreated during cutover; retain both copies and reconcile");
  }
  for (const [path, bytes] of markers) if (!lstatSync(path, { throwIfNoEntry: false })) {
    // This deterministic staging file belongs to the existing migration journal;
    // an interrupted marker write can be regenerated, but never overwrite a new source.
    const pending = path + ".migration-marker-pending";
    const stat = lstatSync(pending, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw validation("migration", "invalid pending retirement marker");
    atomicPrivateWrite(pending, bytes);
    durableRenameNoReplace(pending, path);
  }
}
