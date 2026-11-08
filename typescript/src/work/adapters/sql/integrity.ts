import type { SQLClient } from "../../../sql-client.js";
import type { IntegrityReport } from "../../../store-types.js";
import { GRADING_REQUEST_COUNTER, StorageFailure } from "../../ports/index.js";
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
    ["work_completion_events", async key => {
      const row = await client.get<Record<string, unknown>>("SELECT * FROM work_completion_events WHERE id = ?", [key.id]);
      if (row) decodeCompletionEvent(row);
    }],
  ];
  for (const [table, decode] of scans) {
    const keys = table === "work_revisions" ? "id, definition_id" : "id";
    for (let offset = 0; ; offset += 256) {
      const rows = await client.all<Record<string, unknown>>(`SELECT ${keys} FROM ${table} ORDER BY id LIMIT 256 OFFSET ?`, [offset]);
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
  const orphan = await client.get("SELECT m.experiment_run_id FROM work_experiment_members m LEFT JOIN work_experiment_runs e ON e.id = m.experiment_run_id WHERE e.id IS NULL LIMIT 1");
  if (orphan) report.issues.push({ check: "experiment_members", reason: "A member refers to a missing experiment run" });
  const invalidCounter = await client.get("SELECT name FROM work_counters WHERE value < 0 LIMIT 1");
  if (invalidCounter) report.issues.push({ check: "work_counters", reason: "A stored sequence is negative" });
  const highWater = await client.get("SELECT MAX(request_seq) AS latest FROM work_gradings");
  if (highWater?.latest != null) {
    const counter = await client.get("SELECT value FROM work_counters WHERE name = ?", [GRADING_REQUEST_COUNTER]);
    if (!counter || BigInt(String(counter.value)) < BigInt(String(highWater.latest))) {
      report.issues.push({ check: "grading_sequence", reason: "The grading request counter is behind an existing grading" });
    }
  }
  report.issues = report.issues.slice(0, 1000);
  report.valid = report.issues.length === 0;
  return report;
}
