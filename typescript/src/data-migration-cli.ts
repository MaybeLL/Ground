import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { safeRead } from "./runtime-files.js";
import { DomainError, validation } from "./errors.js";
import { migrateDataLayout, type DataMigrationInput } from "./data-migration.js";
import { planDataMigration } from "./data-migration-plan.js";
import type { Config } from "./config.js";
import type { Store } from "./store-types.js";

export async function executeDataMigration(options: { cwd: string; file?: string; targetRoot?: string; oldConfig?: string; dryRun: boolean }, connect: (config: Config) => Store): Promise<unknown> {
  let supplied: Record<string, unknown> = {};
  if (options.file) {
    try { supplied = JSON.parse(safeRead(resolve(options.cwd, options.file), 256 * 1024).toString()); }
    catch { throw validation("file", "requires a bounded migration input JSON file"); }
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)
      || Object.keys(supplied).some(key => !["oldDataRoot", "oldConfig", "oldRuntime", "oldRegistry", "repositories"].includes(key)))
      throw validation("file", "unknown migration input field");
  }
  const input: DataMigrationInput = { id: "data-layout-v1", repositories: [] };
  for (const field of ["oldDataRoot", "oldConfig", "oldRuntime", "oldRegistry"] as const) {
    if (supplied[field] !== undefined) {
      if (typeof supplied[field] !== "string" || !supplied[field].trim()) throw validation(field, "requires a nonempty path");
      input[field] = resolve(options.cwd, supplied[field]);
    }
  }
  if (supplied.repositories !== undefined) {
    if (!Array.isArray(supplied.repositories) || supplied.repositories.some(path => typeof path !== "string" || !path.trim()))
      throw validation("repositories", "requires an array of repository paths");
    input.repositories = supplied.repositories.map(path => resolve(options.cwd, path));
  } else {
    try { input.repositories = [execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()]; }
    catch { /* Default data and cached worktrees can be migrated outside a clone. */ }
  }
  if (options.targetRoot !== undefined) input.targetRoot = resolve(options.cwd, options.targetRoot);
  if (options.oldConfig !== undefined) input.oldConfig = resolve(options.cwd, options.oldConfig);
  try {
    if (options.dryRun) return { result_type: "grounds.result.data-migration-plan/v1", command: "migrate.data", dry_run: true,
      phase: "planned", plan: planDataMigration(input) };
    return await migrateDataLayout(input, connect);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (!(error instanceof DomainError) && code && ["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS"].includes(code))
      throw new DomainError("STATE_CONFLICT", "Data migration stopped: free disk space or correct filesystem permissions, then resume the same migration", false,
        { reason_code: "migration_filesystem_blocked", filesystem_code: code, originals_retained: true });
    throw error;
  }
}
