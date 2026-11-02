// Composition root: reads configuration, creates adapters and injects them
// into the application services and drivers. The only place allowed to import
// every layer.
import { createHash } from "node:crypto";
import { newUUIDv7 } from "../identity.js";
import type { SQLStore } from "../sql-store.js";
import { GitTagArchive, GitWorktrees, SqlWorkUnitOfWork } from "./adapters/index.js";
import { CodeDelivery, Grading, TaskDefinitions, TaskExecution, type WorkApplication } from "./application/index.js";

/** The work model over a ledger, with the real clock, identifiers, hash and git. */
export function composeWork(store: SQLStore): WorkApplication {
  const units = new SqlWorkUnitOfWork(store);
  const archive = new GitTagArchive();
  const shared = { units, clock: { now: () => new Date().toISOString() }, ids: { next: newUUIDv7 }, hash: (text: string) => createHash("sha256").update(text).digest("hex") };
  const exec = new TaskExecution({ ...shared, receipts: archive });
  return { tasks: new TaskDefinitions(shared), exec, grading: new Grading(shared), delivery: new CodeDelivery({ units, exec, archive, worktrees: new GitWorktrees() }) };
}
