import assert from "node:assert/strict";
import { createDefinition, publishRevision, type ReceiptCheck } from "../src/work/domain/index.js";
import { Grading, TaskExecution, type Outcome } from "../src/work/application/index.js";
import type { SqlWorkUnitOfWork } from "../src/work/adapters/index.js";
import type { WorkRepositories } from "../src/work/ports/index.js";
import { clock, hash, ids } from "./work-fixtures.js";

export const taskContent = { kind: "coding", schemaVersion: 1, summary: "Add export", criteria: [{ id: "c1", statement: "exports CSV" }, { id: "c2", statement: "keeps headers" }] };

export function value<T>(outcome: Outcome<T>): T {
  assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}
export function refused<T>(outcome: Outcome<T>, code: string, pattern?: RegExp): void {
  assert.ok(!outcome.ok, "expected the use case to refuse");
  if (!outcome.ok) { assert.equal(outcome.error.code, code, outcome.error.message); if (pattern) assert.match(outcome.error.message, pattern); }
}

export interface Application {
  readonly exec: TaskExecution;
  readonly grading: Grading;
  readonly receipts: { result: ReceiptCheck };
  readonly units: SqlWorkUnitOfWork;
}

/** The use cases over a ledger, with one published task, a deterministic clock and identifiers, and a controllable archive check. */
export async function application(units: SqlWorkUnitOfWork): Promise<Application> {
  const receipts = { result: "accepted" as ReceiptCheck };
  const shared = { units, clock: { now: clock() }, ids: { next: ids("id") }, hash };
  await units.run("write", async (r: WorkRepositories) => {
    const created = createDefinition({ id: "task-1", kind: "task", name: "task-1", at: "2026-01-01T00:00:00.000Z" });
    assert.ok(created.ok);
    await r.definitions.create(created.value.state);
    const published = publishRevision(created.value.state, { revisionId: "task-1-rev-1", expectedSeq: 0, content: taskContent, at: "2026-01-01T00:00:01.000Z" }, hash);
    assert.ok(published.ok);
    await r.definitions.save(published.value.state, created.value.state.version);
    await r.definitions.addRevision(published.value.outcome);
  });
  return { exec: new TaskExecution({ ...shared, receipts: { check: async () => receipts.result } }), grading: new Grading(shared), receipts, units };
}
