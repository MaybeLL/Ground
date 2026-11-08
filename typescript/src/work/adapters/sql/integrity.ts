import type { SQLClient } from "../../../sql-client.js";
import type { IntegrityReport } from "../../../store-types.js";
import { GRADING_REQUEST_COUNTER, StorageFailure, type EvidenceRef } from "../../ports/index.js";
import { decodeCompletionEvent, repositoriesOver } from "./repositories.js";

/** Walk the same snapshot through the same decoders used by business reads. */
export async function inspectWorkIntegrity(client: SQLClient): Promise<IntegrityReport> {
  const r = repositoriesOver(client, false);
  const report: IntegrityReport = { valid: true, issues: [] };
  async function verifyRef(ref: EvidenceRef | undefined) {
    const stored = ref && await r.evidence.describe(ref.digest);
    if (!stored || stored.byteLength !== ref?.byteLength || stored.chunkCount !== ref.chunkCount) {
      throw new StorageFailure("integrity", "archived transcript refers to missing or conflicting evidence");
    }
  }
  const scans: [string, (row: Record<string, unknown>) => Promise<unknown> | unknown][] = [
    ["work_evidence",row => r.evidence.verify(String(row.digest))],
    ["work_definitions", row => r.definitions.get(String(row.id))],
    ["work_revisions", row => r.definitions.getRevision(String(row.definition_id), String(row.id))],
    ["work_works", row => r.works.get(String(row.id))],
    ["work_task_runs", async row => {
      const run = await r.taskRuns.get(String(row.id));
      if (run?.worker?.kind !== "external") return;
      for (const {trace,raw} of run.worker.registration.transcripts) {
        if (raw) await verifyRef(raw);
        if (!trace) continue;
        for (const ref of [trace.raw, trace.events]) await verifyRef(ref);
      }
    }],
    ["work_sandboxes", row => r.sandboxes.get(String(row.id))],
    ["work_executions", row => r.executions.get(String(row.id))],
    ["work_gradings", async row => {
      const grading = await r.gradings.get(String(row.id));
      for (const step of grading?.commandSteps ?? []) {
        for (const ref of Object.values(step.output ?? {})) await verifyRef(ref);
      }
    }],
    ["work_experiment_runs", row => r.experiments.get(String(row.id))],
    ["work_intents", async row => {
      const intent = await r.intents.get(String(row.id));
      if (intent?.kind !== "managed-worker") return;
      const job = intent.payload as {executionId: string; trace?: {raw: EvidenceRef; events: EvidenceRef}; output?: EvidenceRef; stderr?: EvidenceRef};
      const execution = await r.executions.get(job.executionId);
      if (!execution || execution.owner.id !== intent.subject.id) throw new StorageFailure("integrity", "managed intent refers to an unrelated execution");
      if (!job.trace && !job.output && !job.stderr && !execution.receipts.trajectory && !execution.receipts.output) return;
      for (const ref of [job.trace?.raw, job.trace?.events, job.output, job.stderr]) await verifyRef(ref);
      if (execution.receipts.output !== "sql-evidence:" + job.output?.digest ||
          execution.receipts.trajectory !== "sql-evidence:" + job.trace?.raw.digest) {
        throw new StorageFailure("integrity", "managed execution receipts disagree with its archived evidence");
      }
    }],
    ["work_completion_events", async key => {
      const row = await client.get<Record<string, unknown>>("SELECT * FROM work_completion_events WHERE id = ?", [key.id]);
      if (row) decodeCompletionEvent(row);
    }],
  ];
  for (const [table, decode] of scans) {
    const keys = table === "work_evidence" ? "digest" : table === "work_revisions" ? "id, definition_id" : "id";
    for (let offset = 0; ; offset += 256) {
      const rows = await client.all<Record<string, unknown>>(`SELECT ${keys} FROM ${table} ORDER BY ${table === "work_evidence" ? "digest" : "id"} LIMIT 256 OFFSET ?`, [offset]);
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
  const orphanChunk = await client.get("SELECT c.digest FROM work_evidence_chunks c LEFT JOIN work_evidence e ON e.digest = c.digest WHERE e.digest IS NULL LIMIT 1");
  if (orphanChunk) report.issues.push({ check:"evidence_manifest", reason:"An evidence chunk refers to a missing manifest" });
  const orphanRevision = await client.get("SELECT r.id FROM work_revisions r LEFT JOIN work_definitions d ON d.id = r.definition_id WHERE d.id IS NULL LIMIT 1");
  if (orphanRevision) report.issues.push({ check: "revision_definition", reason: "A revision refers to a missing definition" });
  const orphan = await client.get("SELECT m.experiment_run_id FROM work_experiment_members m LEFT JOIN work_experiment_runs e ON e.id = m.experiment_run_id WHERE e.id IS NULL LIMIT 1");
  if (orphan) report.issues.push({ check: "experiment_members", reason: "A member refers to a missing experiment run" });
  let gradingCounter = 0n;
  for (let offset = 0; ; offset += 256) {
    const counters = await client.all(`SELECT name, ${client.dialect.integerText("value")} AS counter_value FROM work_counters ORDER BY name LIMIT 256 OFFSET ?`, [offset]);
    for (const counter of counters) {
      const value = String(counter.counter_value);
      if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
        report.issues.push({ check: "work_counters", reason: "A stored sequence is not a nonnegative safe integer" });
        if (report.issues.length >= 1000) return { valid: false, issues: report.issues.slice(0, 1000) };
      } else if (counter.name === GRADING_REQUEST_COUNTER) gradingCounter = BigInt(value);
    }
    if (counters.length < 256) break;
  }
  const row = await client.get(`SELECT ${client.dialect.integerText("MAX(request_seq)")} AS latest FROM work_gradings`);
  const latest = String(row?.latest ?? "0");
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(latest) || BigInt(latest) > gradingCounter) {
    report.issues.push({ check: "grading_sequence", reason: "The grading request counter is behind an existing grading or its high-water value is invalid" });
  }
  report.issues = report.issues.slice(0, 1000);
  report.valid = report.issues.length === 0;
  return report;
}
