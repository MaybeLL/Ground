import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";
import { Module } from "../src/module.js";
import { newUUIDv7 } from "../src/identity.js";
import { DomainError } from "../src/errors.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";

const mysqlEnabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every(key => process.env[`GROUNDS_TEST_MYSQL_${key}`]);
const mysql = () => SQLStore.mysql({ host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306), database: process.env.GROUNDS_TEST_MYSQL_DATABASE!, username: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE } : {}) });
const command = (f: LedgerFixture, candidateId: string, version = 0) => ({ operation_id: newUUIDv7(), issue_id: f.issue.issue_id, issue_version: 1, candidate_id: candidateId, expected_version: version, attribution: testAgent, reason: "User chose this Candidate for delivery" });
const errorCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof DomainError); assert.equal(error.code, code); assertContract("error.schema.json", error.toJSON()); return true;
};

for (const backend of ["sqlite", "mysql", "postgres"] as const) {
  const skipped = backend === "mysql" ? !mysqlEnabled : backend === "postgres" ? !postgresEnabled : false;
  const backendTest = (name: string, run: (f: LedgerFixture) => Promise<void>) => test(`${backend}: ${name}`, { skip: skipped }, async () => {
    const pg = backend === "postgres" ? await isolatedPostgres() : undefined;
    const f = pg ? await LedgerFixture.createWithStore(pg.store, pg.cleanup) : backend === "sqlite" ? await LedgerFixture.create() : await LedgerFixture.createWithStore(mysql());
    try { await run(f); } finally { await f.close(); }
  });

  backendTest("Selection lifecycle, audit, replay and projections preserve immutable Candidate facts", async f => {
    const a = await f.submitCandidate(); const b = await f.submitCandidate("two");
    const trace = await f.module.reviewCandidate(a.candidate.candidate_id);
    const empty = await f.module.showSelection(f.issue.issue_id);
    assert.equal(empty.selection.version, 0); assert.equal(empty.selection.state, "unselected"); assertContract("selection.schema.json", empty);
    const input = command(f, a.candidate.candidate_id);
    const chosen = await f.module.setSelection(input);
    assertContract("selection.schema.json", chosen); assertContract("command-results.schema.json", chosen);
    assert.equal(chosen.selection.version, 1); assert.equal(chosen.selection.warnings[0].code, "SELECTION_VERIFICATION_RISK");
    assert.deepEqual(await f.module.setSelection(input), chosen);
    assert.deepEqual(await f.module.reviewCandidate(a.candidate.candidate_id), trace);
    const issue = await f.module.showIssue(f.issue.issue_id);
    assert.equal(issue.board.next_action, "prepare_delivery"); assert.equal(issue.board.selection.candidate_id, a.candidate.candidate_id); assertContract("query-results.schema.json", issue);
    const requirement = await f.module.showRequirement(f.requirement.requirement_id);
    assert.equal(requirement.issues[0].board.selection.id, chosen.selection.id); assertContract("query-results.schema.json", requirement);
    assert.equal((await f.module.showCandidate(a.candidate.candidate_id)).candidate.is_selected, true);
    assertContract("query-results.schema.json", await f.module.showCandidate(a.candidate.candidate_id));
    const compared = await f.module.compareCandidates([a.candidate.candidate_id, b.candidate.candidate_id]);
    assert.equal(compared.candidates.find(c => c.candidate_id === a.candidate.candidate_id)?.is_selected, true); assert.equal(compared.candidates.find(c => c.candidate_id === b.candidate.candidate_id)?.is_selected, false); assertContract("query-results.schema.json", compared);
    assert.equal((await f.module.listCandidates(f.issue.issue_revision_id)).resources.find(r => r.resource_id === a.candidate.candidate_id)?.is_selected, true);
    assertContract("command-results.schema.json", await f.module.listCandidates(f.issue.issue_revision_id));
    const pinned = await f.module.loadSelectionMaterialization(f.issue.issue_id, 1, 1);
    const changed = await f.module.setSelection(command(f, b.candidate.candidate_id, 1));
    assert.equal(pinned.selection.selection.version, 1); assert.equal(pinned.materialization.candidate_id, a.candidate.candidate_id);
    assert.equal(changed.selection.id, chosen.selection.id); assert.equal(changed.selection.version, 2);
    assert.equal((await f.module.showCandidate(a.candidate.candidate_id)).candidate.is_selected, false);
    const clearInput = { operation_id: newUUIDv7(), issue_id: f.issue.issue_id, issue_version: 1, expected_version: 2, attribution: testAgent, reason: "Reconsider delivery" };
    const cleared = await f.module.clearSelection(clearInput);
    assert.equal(cleared.selection.state, "unselected"); assert.equal(cleared.selection.version, 3); assert.equal(cleared.selection.id, chosen.selection.id); assert.equal(cleared.selection.candidate_id, undefined); assertContract("selection.schema.json", cleared);
    assert.deepEqual(await f.module.clearSelection(clearInput), cleared);
    const again = await f.module.setSelection(command(f, a.candidate.candidate_id, 3)); assert.equal(again.selection.version, 4);
    const reaffirmed = await f.module.setSelection(command(f, a.candidate.candidate_id, 4)); assert.equal(reaffirmed.selection.version, 5);
    assert.deepEqual(await f.module.setSelection(input), chosen, "replay must survive later decisions");
    await assert.rejects(f.module.setSelection({ ...input, reason: "different semantic request" }), errorCode("IDEMPOTENCY_CONFLICT"));
    const events = await f.module.listLedger("", "", "selection", chosen.selection.id!);
    assert.equal(events.events.length, 5); assertContract("query-results.schema.json", events);
    assert.ok(events.events.some(e => e.event_type === "selection.cleared"));
    assert.ok(events.events[1].facts.some(fact => fact.name === "previous_candidate_id" && fact.value === a.candidate.candidate_id));
    const integrity = (await f.store.inspectIntegrity()).report; assert.equal(integrity.valid, true, JSON.stringify(integrity.issues));
  });

  backendTest("upgrading timestamp ordering flags a legacy selection digest until reviewed and reselected", async f => {
    const candidate = await f.submitCandidate();
    const id = candidate.candidate.candidate_id;
    const write = f.store.write.bind(f.store);
    let time = "2026-01-01T00:00:00.1Z";
    f.store.write = callback => write(async tx => { tx.now = async () => time; return callback(tx); });
    await f.verify(candidate, "qualified");
    time = "2026-01-01T00:00:00.11Z";
    await f.verify(candidate, "qualified");
    // Reproduce the old reader when recording the selection; retain real reports
    // and let production code calculate the legacy digest rather than forging it.
    f.store.write = callback => write(async tx => {
      const page = tx.readVerificationDirectoryPage.bind(tx);
      tx.readVerificationDirectoryPage = async (...args) => {
        const value = await page(...args);
        value.rows.sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id.localeCompare(b.id));
        return value;
      };
      return callback(tx);
    });
    const before = await f.module.setSelection(command(f, id));
    f.store.write = write;
    const upgraded = (await f.module.showSelection(f.issue.issue_id)).selection;
    assert.equal(upgraded.verification_changed, true);
    assert.ok(upgraded.warnings.some(warning => warning.code === "SELECTION_VERIFICATION_CHANGED"));
    assert.deepEqual(upgraded.verification_at_selection, before.selection.verification_at_selection);
    assert.notEqual(upgraded.current_verification?.digest, upgraded.verification_at_selection?.digest);
    assert.equal(upgraded.current_verification?.count, 2);
    assert.equal(upgraded.current_verification?.standing, "qualified");
    const reaffirmed = await f.module.setSelection(command(f, id, 1));
    assert.equal(reaffirmed.selection.verification_changed, false);
    assert.equal(reaffirmed.selection.verification_at_selection?.digest, upgraded.current_verification?.digest);
  });

  backendTest("Selection validates risk reasons and reports later verification without changing the choice", async f => {
    const a = await f.submitCandidate(); const input = command(f, a.candidate.candidate_id);
    await assert.rejects(f.module.setSelection({ ...input, reason: undefined }), errorCode("VALIDATION_ERROR"));
    assert.equal((await f.module.showSelection(f.issue.issue_id)).selection.version, 0);
    await f.verify(a, "inconclusive");
    await assert.rejects(f.module.setSelection({ ...input, reason: " " }), errorCode("VALIDATION_ERROR"));
    await f.verify(a, "qualified");
    const chosen = await f.module.setSelection({ ...input, reason: undefined });
    assert.equal(chosen.selection.verification_at_selection?.standing, "qualified"); assert.equal(chosen.selection.warnings.length, 0);
    await f.verify(a, "rejected");
    const latest = await f.module.showSelection(f.issue.issue_id);
    assert.equal(latest.selection.candidate_id, a.candidate.candidate_id); assert.equal(latest.selection.version, 1);
    assert.equal(latest.selection.verification_changed, true); assert.equal(latest.selection.current_verification?.standing, "disputed"); assert.equal(latest.selection.warnings.length, 2);
    assert.deepEqual(await f.module.setSelection({ ...input, reason: undefined }), chosen);
    await assert.rejects(f.module.setSelection({ ...command(f, a.candidate.candidate_id, 1), reason: undefined }), errorCode("VALIDATION_ERROR"));
    const rejected = await f.submitCandidate("rejected"); await f.verify(rejected, "rejected");
    await assert.rejects(f.module.setSelection({ ...command(f, rejected.candidate.candidate_id, 1), reason: undefined }), errorCode("VALIDATION_ERROR"));
    assert.equal((await f.module.setSelection(command(f, rejected.candidate.candidate_id, 1))).selection.current_verification?.standing, "rejected");
  });

  backendTest("Selection binds exact Issue Version and refinement never inherits choice or verification", async f => {
    const a = await f.submitCandidate(); await f.module.setSelection(command(f, a.candidate.candidate_id));
    const run = await f.module.startDevRun({ operation_id: newUUIDv7(), issue_id: f.issue.issue_id, issue_revision_id: f.issue.issue_revision_id, issue_revision_explicit: true, repository_remote_snapshot: f.repository.canonical_remote, refines_candidate_id: a.candidate.candidate_id, exploration_brief: "User review: improve the implementation without changing criteria", attribution: testAgent });
    const b = await f.module.submitCandidate({ ...f.gitCandidateFields(a.artifact), operation_id: newUUIDv7(), dev_run_id: run.result.context.dev_run.id, expected_version: 1, submission: a.submission, artifact: a.artifact, attribution: testAgent });
    assert.equal((await f.module.showCandidate(b.candidate_id)).candidate.is_selected, false);
    assert.equal((await f.module.showCandidate(b.candidate_id)).candidate.standing, "unverified");
    assert.equal((await f.module.showSelection(f.issue.issue_id)).selection.candidate_id, a.candidate.candidate_id);
    const revised = await f.module.reviseIssue({ operation_id: newUUIDv7(), issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: testBaseline, input: { format: 1, summary: "Changed contract", goals: [{ statement: "New goal", criteria: ["New criterion"] }] }, attribution: testAgent });
    assert.equal(revised.result.revision_number, 2);
    assert.equal((await f.module.showSelection(f.issue.issue_id)).selection.version, 0);
    assert.equal((await f.module.showSelection(f.issue.issue_id, 1)).selection.candidate_id, a.candidate.candidate_id);
    await assert.rejects(f.module.setSelection({ ...command(f, a.candidate.candidate_id), issue_version: 2 }), errorCode("VALIDATION_ERROR"));
    const foreign = await f.module.createIssue({ operation_id: newUUIDv7(), requirement_id: f.requirement.requirement_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, repository_id: f.repository.repository_id, baseline: testBaseline, input: { format: 1, summary: "Other", goals: [{ statement: "Other", criteria: ["Other"] }] }, attribution: testAgent });
    await assert.rejects(f.module.setSelection({ ...command(f, a.candidate.candidate_id), issue_id: foreign.result.issue_id }), errorCode("VALIDATION_ERROR"));
  });

  backendTest("Selection rejects stale versions and rolls back failed audit writes", async f => {
    const a = await f.submitCandidate(); const input = command(f, a.candidate.candidate_id);
    const original = f.store.write.bind(f.store);
    f.store.write = callback => original(async tx => { tx.appendLedgerEvent = async () => { throw new Error("audit unavailable"); }; return callback(tx); });
    await assert.rejects(f.module.setSelection(input), /audit unavailable/);
    f.store.write = original;
    assert.equal((await f.module.showSelection(f.issue.issue_id)).selection.version, 0);
    assert.equal((await f.module.setSelection(input)).selection.version, 1);
    await assert.rejects(f.module.setSelection(command(f, a.candidate.candidate_id)), errorCode("VERSION_CONFLICT"));
    await assert.rejects(f.module.loadSelectionMaterialization(f.issue.issue_id, 1, 0), errorCode("VERSION_CONFLICT"));
    await assert.rejects(f.module.clearSelection({ ...input, candidate_id: undefined, expected_version: 1.5 }), errorCode("VALIDATION_ERROR"));
  });

  test(`${backend}: independent connections serialize initial and replacement selections`, { skip: skipped }, async () => {
    const root = mkdtempSync(join(tmpdir(), "grounds-selection-concurrency-"));
    const pg = backend === "postgres" ? await isolatedPostgres() : undefined;
    const left = pg ? pg.store : backend === "sqlite" ? SQLStore.sqlite(join(root, "db"), { busyTimeoutMs: 10 }) : mysql();
    const f = await LedgerFixture.createWithStore(left, pg?.cleanup);
    const right = pg ? pg.open() : backend === "sqlite" ? SQLStore.sqlite(join(root, "db"), { busyTimeoutMs: 10 }) : mysql();
    f.installGitArtifactResolver(right);
    try {
      const a = await f.submitCandidate(); const b = await f.submitCandidate("two"); const other = new Module(right);
      for (const version of [0, 1]) {
        const results = await Promise.allSettled([f.module.setSelection(command(f, a.candidate.candidate_id, version)), other.setSelection(command(f, b.candidate.candidate_id, version))]);
        assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
        const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult; assert.equal(failed.reason.code, "VERSION_CONFLICT");
      }
      const value = await f.module.showSelection(f.issue.issue_id); assert.equal(value.selection.version, 2);
      assert.equal((await f.module.listLedger("", "", "selection", value.selection.id!)).events.length, 2);
      const replayInput = command(f, a.candidate.candidate_id, 2);
      const [first, replay] = await Promise.all([f.module.setSelection(replayInput), other.setSelection(replayInput)]);
      assert.deepEqual(first, replay); assert.equal(first.selection.version, 3);
      assert.equal((await f.module.listLedger("", "", "selection", value.selection.id!)).events.length, 3);
    } finally { await right.close(); await f.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("schema 10 migrates to Selection schema without inventing choices or changing Candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-selection-migration-")); const path = join(root, "db");
  const store = SQLStore.sqlite(path); const f = await LedgerFixture.createWithStore(store);
  try {
    const a = await f.submitCandidate(); const original = await f.module.reviewCandidate(a.candidate.candidate_id);
    const raw = new DatabaseSync(path); raw.exec(`DROP TABLE selections; UPDATE schema_metadata SET schema_version = 10; DELETE FROM schema_migrations WHERE schema_version = ${SCHEMA_VERSION}`); raw.close();
    await assert.rejects(store.open(), errorCode("SCHEMA_INCOMPATIBLE"));
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.equal((await f.module.showSelection(f.issue.issue_id)).selection.state, "unselected");
    assert.deepEqual(await f.module.reviewCandidate(a.candidate.candidate_id), original);
    assert.equal((await f.module.setSelection(command(f, a.candidate.candidate_id))).selection.version, 1);
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("MySQL schema 10 migration creates empty Selection state and preserves immutable records", { skip: !mysqlEnabled }, async () => {
  const mysqlDriver = await import("mysql2/promise");
  const { readFileSync } = await import("node:fs");
  const name = `selection_migration_${newUUIDv7().replaceAll("-", "")}`;
  const connection = await mysqlDriver.createConnection({ host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306), user: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, ssl: { rejectUnauthorized: true, ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { ca: readFileSync(process.env.GROUNDS_TEST_MYSQL_CA_FILE) } : {}) } });
  let f: LedgerFixture | undefined;
  try {
    await connection.query(`CREATE DATABASE \`${name}\``);
    const store = SQLStore.mysql({ host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306), database: name, username: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE } : {}) });
    f = await LedgerFixture.createWithStore(store);
    const candidate = await f.submitCandidate(); const original = await f.module.reviewCandidate(candidate.candidate.candidate_id);
    await connection.query(`DROP TABLE \`${name}\`.selections`);
    await connection.query(`UPDATE \`${name}\`.schema_metadata SET schema_version = 10`);
    await connection.query(`DELETE FROM \`${name}\`.schema_migrations WHERE schema_version = ${SCHEMA_VERSION}`);
    await assert.rejects(store.open(), errorCode("SCHEMA_INCOMPATIBLE"));
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.equal((await f.module.showSelection(f.issue.issue_id)).selection.version, 0);
    assert.deepEqual(await f.module.reviewCandidate(candidate.candidate.candidate_id), original);
    assert.equal((await f.module.setSelection(command(f, candidate.candidate.candidate_id))).selection.version, 1);
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.equal((await store.inspectIntegrity()).report.valid, true);
  } finally {
    await f?.close();
    await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await connection.end();
  }
});

test("PostgreSQL schema 10 migration creates empty Selection state and preserves immutable records", { skip: !postgresEnabled }, async () => {
  const pg = await isolatedPostgres();
  let f: LedgerFixture | undefined;
  try {
    f = await LedgerFixture.createWithStore(pg.store, pg.cleanup);
    const candidate = await f.submitCandidate(); const original = await f.module.reviewCandidate(candidate.candidate.candidate_id);
    const raw = await pg.raw();
    try {
      await raw.query("DROP TABLE selections");
      await raw.query("UPDATE schema_metadata SET schema_version = 10");
      await raw.query("DELETE FROM schema_migrations WHERE schema_version = 20");
    } finally { await raw.end(); }
    await assert.rejects(pg.store.open(), errorCode("SCHEMA_INCOMPATIBLE"));
    assert.equal((await pg.store.migrate()).schema_version, SCHEMA_VERSION);
    assert.equal((await f.module.showSelection(f.issue.issue_id)).selection.version, 0);
    assert.deepEqual(await f.module.reviewCandidate(candidate.candidate.candidate_id), original);
    assert.equal((await f.module.setSelection(command(f, candidate.candidate.candidate_id))).selection.version, 1);
    assert.equal((await pg.store.migrate()).schema_version, SCHEMA_VERSION);
    assert.equal((await pg.store.inspectIntegrity()).report.valid, true);
  } finally { if (f) await f.close(); else await pg.cleanup(); }
});

test("corrupt Selection evidence cannot be projected as valid decision-time evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-selection-corruption-")); const path = join(root, "db");
  const store = SQLStore.sqlite(path); const f = await LedgerFixture.createWithStore(store);
  try {
    const a = await f.submitCandidate(); await f.module.setSelection(command(f, a.candidate.candidate_id));
    const raw = new DatabaseSync(path);
    const snapshot = JSON.parse(String((raw.prepare("SELECT verification_json FROM selections").get() as { verification_json: string }).verification_json));
    snapshot.count = 999;
    raw.prepare("UPDATE selections SET verification_json = ?").run(JSON.stringify(snapshot)); raw.close();
    await assert.rejects(f.module.showSelection(f.issue.issue_id), errorCode("ARTIFACT_INTEGRITY_ERROR"));
    assert.equal((await store.inspectIntegrity()).report.valid, false);
    const invalidId = new DatabaseSync(path); invalidId.exec("UPDATE selections SET id = 'invalid-id'"); invalidId.close();
    await assert.rejects(f.module.showSelection(f.issue.issue_id), errorCode("ARTIFACT_INTEGRITY_ERROR"));
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});
