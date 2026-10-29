import { existsSync, lstatSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { dataRoot, previousDataLocations } from "./data-layout.js";
import { directoryRegistryRoot, safeRead } from "./runtime-files.js";
import { retiredMarkers } from "./migration-retired.js";
import { DomainError } from "./errors.js";

const activeEntries = (path: string, retired: Set<string>): boolean => {
  if (!existsSync(path)) return false;
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return true;
  return readdirSync(path).some(name => !["locks", ".DS_Store"].includes(name) && !retired.has(join(path, name)));
};

/** Never silently fall back to an old layout or initialize a second ledger over it. */
export function requireCurrentDataLayout(cwd: string): void {
  const active = join(directoryRegistryRoot(), "migration-active.json");
  if (existsSync(active)) {
    const marker = JSON.parse(safeRead(active, 16 * 1024).toString());
    throw new DomainError("MIGRATION_DIRTY", "Finish the interrupted data migration before using Grounds", false,
      { journal_path: marker.journal_path, migrate_argv: ["grounds", "migrate", "data", "--data-root", marker.data_root] });
  }
  const root = dataRoot(), migrations = join(root, "migration");
  const retired = new Set<string>();
  if (existsSync(migrations)) {
    for (const name of readdirSync(migrations)) {
      const path = join(migrations, name, "journal.json");
      if (!existsSync(path)) continue;
      const journal = JSON.parse(safeRead(path).toString());
      if (journal.format === "grounds.data-migration/v1" && journal.phase !== "complete")
        throw new DomainError("MIGRATION_DIRTY", "Finish the interrupted data migration before using Grounds", false,
          { journal_path: path, migrate_argv: ["grounds", "migrate", "data"] });
      if (journal.format === "grounds.data-migration/v1" && journal.phase === "complete") {
        for (const entry of [journal.plan?.relocation, ...(journal.plan?.extractions ?? [])].flatMap(stage => stage?.entries ?? [])) if (typeof entry.retired === "string") retired.add(entry.retired);
        for (const [source, marker] of retiredMarkers(journal.plan)) {
          const stat = lstatSync(source, { throwIfNoEntry: false });
          if (stat?.isFile() && !stat.isSymbolicLink() && safeRead(source, 64 * 1024).toString() === marker) retired.add(source);
        }
      }
    }
  }
  const previous = previousDataLocations(), reasons: string[] = [];
  if (resolve(previous.config) !== join(root, "config.yaml") && existsSync(previous.config) && !retired.has(previous.config)) reasons.push("previous default configuration");
  if (resolve(previous.runtime) !== join(root, "runtime", "env") && !process.env.GROUNDS_RUNTIME_HOME && activeEntries(previous.runtime, retired)) reasons.push("previous environment runtime");
  if (activeEntries(previous.directoryRegistry, retired)) reasons.push("previous directory registry");
  let repository: string | undefined;
  try { repository = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { /* Non-Git commands and drafts are supported. */ }
  if (repository && ["authoring", "development", "devruns", "reviews", "contract-reviews", "deliveries", "delivery", "release", "releases", "backups"].some(name => activeEntries(join(repository!, ".grounds", name), retired))) reasons.push("repository managed data");
  if (reasons.length) throw new DomainError("STATE_CONFLICT", "Existing Grounds data requires the one-time data migration", false,
    { reason_code: "data_migration_required", sources: reasons, migrate_argv: ["grounds", "migrate", "data"] });
}
