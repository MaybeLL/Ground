// Composition root: reads configuration, creates adapters and injects them
// into the application services and drivers. The only place allowed to import
// every layer.
import { createHash } from "node:crypto";
import { newUUIDv7 } from "../identity.js";
import type { SQLStore } from "../sql-store.js";
import { GitTagArchive, GitWorktrees, SqlWorkUnitOfWork } from "./adapters/index.js";
import { RuleDefinitions } from "./application/rule-definitions.js";
import { EvaluationSuites } from "./application/evaluation-suites.js";
import { ArchiveRepairs } from "./application/archive-repairs.js";
import { CodeDelivery, Grading, TaskDefinitions, TaskExecution, type WorkApplication } from "./application/index.js";

/** The work model over a ledger, with the real clock, identifiers, hash and git. */
export function composeWork(store: SQLStore): WorkApplication {
  const units = new SqlWorkUnitOfWork(store);
  const archive = new GitTagArchive();
  const shared = { units, clock: { now: () => new Date().toISOString() }, ids: { next: newUUIDv7 }, hash: (text: string) => createHash("sha256").update(text).digest("hex") };
  const exec = new TaskExecution({ ...shared, receipts: archive });
  const repairs = new ArchiveRepairs({ ...shared, archive });
  const suites = new EvaluationSuites({ units, repairs, archive, hash: shared.hash, now: shared.clock.now, newId: newUUIDv7,
    capture: bytes => ({ digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"), base64: Buffer.from(bytes).toString("base64") }) });
  const rules = new RuleDefinitions({ units, hash: shared.hash, now: shared.clock.now, newId: newUUIDv7 });
  return { rules, suites, repairs, tasks: new TaskDefinitions(shared), exec, grading: new Grading(shared), delivery: new CodeDelivery({ units, exec, archive, repairs, worktrees: new GitWorktrees() }) };
}
