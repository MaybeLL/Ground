import type { SQLClient } from "../../../sql-client.js";
import type { IntegrityReport } from "../../../store-types.js";
import { StorageFailure } from "../../ports/index.js";
import { decodeCompletionEvent, repositoriesOver } from "./repositories.js";

/** Walk the same snapshot through the same decoders used by business reads. */
export async function inspectWorkIntegrity(client: SQLClient): Promise<IntegrityReport> {
  const r = repositoriesOver(client, false);
  const report: IntegrityReport = { valid: true, issues: [] };
  const scans: [string, (row: Record<string, unknown>) => Promise<unknown> | unknown][] = [
    ["work_definitions", row => r.definitions.get(String(row.id))],
    ["work_revisions", row => r.definitions.getRevision(String(row.definition_id), String(row.id))],
    ["work_works", row => r.works.get(String(row.id))],
    ["work_task_runs", row => r.taskRuns.get(String(row.id))],
    ["work_sandboxes", row => r.sandboxes.get(String(row.id))],
    ["work_executions", row => r.executions.get(String(row.id))],
    ["work_gradings", row => r.gradings.get(String(row.id))],
    ["work_experiment_runs", row => r.experiments.get(String(row.id))],
    ["work_intents", row => r.intents.get(String(row.id))],
    ["work_completion_events", decodeCompletionEvent],
  ];
  for (const [table, decode] of scans) {
    for (let offset = 0; ; offset += 256) {
      const rows = await client.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY id LIMIT 256 OFFSET ?`, [offset]);
      for (const row of rows) {
        try { await decode(row); }
        catch (error) {
          if (!(error instanceof StorageFailure && error.reason === "integrity")) throw error;
          report.valid = false;
          report.issues.push({ check: "work_record", resource_type: table, reason: error.message.slice(0, 4096) });
          if (report.issues.length === 1000) return report;
        }
      }
      if (rows.length < 256) break;
    }
  }
  return report;
}
