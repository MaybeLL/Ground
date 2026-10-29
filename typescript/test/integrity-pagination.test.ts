import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../src/errors.js";
import { SQLStore } from "../src/sql-store.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = mkdtempSync(join(tmpdir(), "grounds-integrity-pages-"));
  const path = join(directory, "ledger.db");
  const f = await LedgerFixture.createWithStore(SQLStore.sqlite(path));
  const db = new DatabaseSync(path);
  t.after(async () => { db.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); });
  return { f, db };
}

for (const count of [10, 11, 13, 200]) test(`Intent Links round trip in numeric order at ${count} entries and still reject a gap`, async t => {
  const { f, db } = await fixture(t);
  const outcomes = Array.from({ length: Math.min(count, 100) }, (_, i) => `Outcome ${i + 1}`);
  const decisions = Array.from({ length: Math.max(0, count - 100) }, (_, i) => ({ statement: `Decision ${i + 1}` }));
  const requirement = await f.module.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent,
    input: { format: 1, summary: "Many intent links", outcomes, decisions } });
  const links = [...outcomes.map((_, i) => ({ type: "outcome" as const, ordinal: i + 1 })),
    ...decisions.map((_, i) => ({ type: "decision" as const, ordinal: i + 1 }))];
  const issue = await f.module.createIssue({ operation_id: newUUIDv7(), attribution: testAgent,
    requirement_id: requirement.result.requirement_id, requirement_revision_id: requirement.result.requirement_revision_id,
    requirement_revision_explicit: true, repository_id: f.repository.repository_id, baseline: testBaseline,
    input: { format: 1, summary: "Round trip", goals: [{ statement: "Numeric order", criteria: ["All links survive"], traces_to: links }] } });
  const read = await f.store.read(tx => tx.getIssueRevisionById(issue.result.issue_revision_id));
  assert.deepEqual(read.goals[0].traces_to, links);
  assert.equal((await f.store.inspectIntegrity()).report.valid, true);
  db.prepare("DELETE FROM intent_links WHERE issue_revision_id = ? AND ordinal = 2").run(issue.result.issue_revision_id);
  const bad = await f.store.inspectIntegrity();
  assert.ok(bad.report.issues.some(i => i.resource_id === issue.result.issue_revision_id && i.reason.includes("not contiguous")));
});

test("integrity scans aggregate roots beyond an exact full page", async t => {
  const { f, db } = await fixture(t);
  const repository = db.prepare("SELECT * FROM repositories WHERE id = ?").get(f.repository.repository_id)!;
  const alias = db.prepare("SELECT * FROM repository_remotes WHERE repository_id = ?").get(f.repository.repository_id)!;
  let last = "";
  db.exec("BEGIN");
  for (let i = 1; i < 1000; i++) {
    last = newUUIDv7();
    const remote = `ssh://git@example.test/team/pagination-${i}`;
    copyRow(db, "repositories", repository, { id: last, canonical_remote: remote });
    copyRow(db, "repository_remotes", alias, { repository_id: last, remote });
  }
  db.exec("COMMIT");
  assert.deepEqual((await f.store.inspectIntegrity()).report, { valid: true, issues: [] });
  last = newUUIDv7();
  copyRow(db, "repositories", repository, { id: last, canonical_remote: "ssh://git@example.test/team/tail", created_at: "invalid" });
  copyRow(db, "repository_remotes", alias, { repository_id: last, remote: "ssh://git@example.test/team/tail" });
  const bad = (await f.store.inspectIntegrity()).report;
  assert.ok(bad.issues.some(i => i.check === "repository_graph" && i.resource_id === last));
});

// Duplicate only synthetic public fixture records; no real ledger is used.
function copyRow(db: DatabaseSync, table: string, row: Record<string, any>, changes: Record<string, any>, omit: string[] = []) {
  const value = { ...row, ...changes };
  const keys = Object.keys(value).filter(k => !omit.includes(k));
  db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => value[k]));
}

test("integrity traverses multiple operation/event pages and detects corrupt tail records", async t => {
  const { f, db } = await fixture(t);
  const op = db.prepare("SELECT * FROM idempotency_records ORDER BY operation_id LIMIT 1").get()!;
  const event = db.prepare("SELECT * FROM ledger_events WHERE operation_id = ?").get(op.operation_id)!;
  db.exec("BEGIN");
  let lastOperation = "", lastEvent = "";
  for (let i = 0; i < 2001; i++) {
    lastOperation = newUUIDv7(); lastEvent = newUUIDv7();
    copyRow(db, "idempotency_records", op, { operation_id: lastOperation });
    copyRow(db, "ledger_events", event, { event_id: lastEvent, operation_id: lastOperation }, ["event_seq"]);
  }
  db.exec("COMMIT");
  const before = db.prepare("SELECT count(*) AS n FROM ledger_events").get();
  const good = await f.store.inspectIntegrity();
  assert.deepEqual(good.report, { valid: true, issues: [] });
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM ledger_events").get(), before);
  const { database_id, schema_version, protocol_version, remote_normalization_version, baseline_reachability_policy, migration_state } = good.metadata;
  assertContract("command-results.schema.json", { result_type: "patchledger.result.database/v1", command: "db.status", database_id, schema_version, protocol_version, remote_normalization_version, baseline_reachability_policy, migration_state, integrity: good.report });
  db.prepare("UPDATE idempotency_records SET result_json = ? WHERE operation_id = ?").run(Buffer.from('{}'), lastOperation);
  db.prepare("UPDATE ledger_events SET subject_id = ? WHERE event_id = ?").run(newUUIDv7(), lastEvent);
  const bad = await f.store.inspectIntegrity();
  assert.equal(bad.report.valid, false);
  assert.ok(bad.report.issues.some(i => i.check === "idempotency" && i.resource_id === lastOperation));
  assert.ok(bad.report.issues.some(i => i.check === "ledger_graph" && i.resource_id === lastEvent));
  assert.ok(!bad.report.issues.some(i => i.check === "bounded_scan"));
  db.prepare("UPDATE idempotency_records SET result_json = ?").run(Buffer.from('{}'));
  const capped = await f.store.inspectIntegrity();
  assert.equal(capped.report.valid, false);
  assert.equal(capped.report.issues.length, 1000, "report remains bounded, without limiting scan coverage");
});


test("verification page cursors reject impossible calendar dates as input errors", async t => {
  const { f } = await fixture(t);
  const candidate = await f.submitCandidate("one");
  const candidateId = candidate.candidate.candidate_id;
  for (const method of ["readVerificationDirectoryPage", "listVerificationSummariesPage"] as const) {
    const cursor = Buffer.from(`2025-02-30T00:00:00Z\0${newUUIDv7()}`).toString("base64url");
    await assert.rejects(f.store.read(tx => tx[method](candidateId, cursor, 1)), error => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.equal(error.details.field, "verifications_cursor");
      return true;
    });
    const valid = Buffer.from(`2025-02-28T00:00:00.100000001Z\0${newUUIDv7()}`).toString("base64url");
    assert.deepEqual(await f.store.read(tx => tx[method](candidateId, valid, 1)), { rows: [], more: false });
  }
});
