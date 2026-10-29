import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, SQLStore } from "../src/sql-store.js";
import { Module } from "../src/module.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { backends, backendSkip, openLedger } from "./backends.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";

const PLAN = "方案：先加列封存，再拆发行版 schema 定义。\n\n```mermaid\nflowchart TD\n  A[加列] --> B[拆定义]\n```";

const createIssueWith = (module: Module, requirementId: string, requirementRevisionId: string, repositoryId: string, plan?: string) =>
  module.createIssue({
    operation_id: newUUIDv7(),
    attribution: testAgent,
    requirement_id: requirementId,
    requirement_revision_id: requirementRevisionId,
    requirement_revision_explicit: true,
    repository_id: repositoryId,
    baseline: testBaseline,
    input: {
      format: 1,
      summary: "Implement the change",
      ...(plan === undefined ? {} : { plan }),
      goals: [{ statement: "Change behavior", criteria: ["The behavior changes"], traces_to: [{ type: "outcome", ordinal: 1 }] }],
    },
  });

for (const backend of backends) test(`${backend}: current schema retains the schema 21 plan field and stores the non-normative plan and reads it back`, { skip: backendSkip(backend) }, async () => {
  const fixture = await openLedger(backend);
  try {
    assert.equal(SCHEMA_VERSION, 23);
    const created = await createIssueWith(fixture.module, fixture.requirement.requirement_id, fixture.requirement.requirement_revision_id, fixture.repository.repository_id, PLAN);
    const show = await fixture.module.showIssue(created.result.issue_id);
    assert.equal(show.issue.plan, PLAN);
  } finally {
    await fixture.close();
  }
});

for (const backend of backends) test(`${backend}: an Issue published without a plan reads back with the field absent, not empty`, { skip: backendSkip(backend) }, async () => {
  const fixture = await openLedger(backend);
  try {
    // The fixture's own Issue was created without a plan.
    const show = await fixture.module.showIssue(fixture.issue.issue_id);
    assert.equal("plan" in show.issue, false);
  } finally {
    await fixture.close();
  }
});

test("migrating a schema-20 database adds the plan column without rewriting existing rows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-plan-migration-"));
  const path = join(directory, "legacy-v20.db");
  let fixture: LedgerFixture | undefined;
  try {
    fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(path));
    const created = await createIssueWith(fixture.module, fixture.requirement.requirement_id, fixture.requirement.requirement_revision_id, fixture.repository.repository_id, PLAN);
    const revisionId = created.result.issue_revision_id;

    // Simulate a database published before schema 21: drop the column and
    // wind the recorded version back, keeping the row exactly as it was.
    const before = new DatabaseSync(path);
    const rowBefore = before.prepare("SELECT id, summary, context, created_at FROM issue_revisions WHERE id = ?").get(revisionId);
    before.exec("ALTER TABLE issue_revisions DROP COLUMN plan");
    before.exec("UPDATE schema_metadata SET schema_version = 20 WHERE singleton = 1");
    before.close();

    const metadata = await fixture.store.migrate();
    assert.equal(metadata.schema_version, SCHEMA_VERSION);

    const after = new DatabaseSync(path);
    const rowAfter = after.prepare("SELECT id, summary, context, created_at, plan FROM issue_revisions WHERE id = ?").get(revisionId) as Record<string, unknown>;
    after.close();

    // The pre-existing row is untouched apart from the new column, which is null.
    assert.equal(rowAfter.id, (rowBefore as Record<string, unknown>).id);
    assert.equal(rowAfter.summary, (rowBefore as Record<string, unknown>).summary);
    assert.equal(rowAfter.context, (rowBefore as Record<string, unknown>).context);
    assert.equal(rowAfter.created_at, (rowBefore as Record<string, unknown>).created_at);
    assert.equal(rowAfter.plan, null);

    // And it reads back as absent rather than as an empty string.
    const show = await fixture.module.showIssue(created.result.issue_id);
    assert.equal("plan" in show.issue, false);
  } finally {
    if (fixture) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("postgres: migrating a schema-20 database adds the plan column without rewriting existing rows", { skip: !postgresEnabled }, async () => {
  const pg = await isolatedPostgres();
  const fixture = await LedgerFixture.createWithStore(pg.store, pg.cleanup);
  try {
    const created = await createIssueWith(fixture.module, fixture.requirement.requirement_id, fixture.requirement.requirement_revision_id, fixture.repository.repository_id, PLAN);
    const revisionId = created.result.issue_revision_id;
    const raw = await pg.raw();
    let rowBefore: Record<string, unknown>, rowAfter: Record<string, unknown>;
    try {
      rowBefore = (await raw.query("SELECT id, summary, context, created_at FROM issue_revisions WHERE id = $1", [revisionId])).rows[0];
      // A database published before schema 21: no plan column and the recorded version wound back.
      await raw.query("ALTER TABLE issue_revisions DROP COLUMN plan");
      await raw.query("UPDATE schema_metadata SET schema_version = 20 WHERE singleton = 1");
      await raw.query("DELETE FROM schema_migrations WHERE schema_version = 21");
      assert.equal((await pg.store.migrate()).schema_version, 21);
      assert.equal((await pg.store.migrate()).schema_version, 21, "migration is repeatable");
      rowAfter = (await raw.query("SELECT id, summary, context, created_at, plan FROM issue_revisions WHERE id = $1", [revisionId])).rows[0];
    } finally { await raw.end(); }
    for (const column of ["id", "summary", "context", "created_at"]) assert.equal(rowAfter[column], rowBefore[column], column);
    assert.equal(rowAfter.plan, null);
    assert.equal("plan" in (await fixture.module.showIssue(created.result.issue_id)).issue, false, "an old row reads back with the plan absent");
    assert.equal((await pg.store.inspectIntegrity()).report.valid, true);
  } finally { await fixture.close(); }
});
