import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";
import { decodeIssue, validateTargetBranchSpec } from "../src/domain.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";
import { reviseTargetIssueSeeded } from "./preflight-fixture.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), "grounds-target-storage-"));
  const path = join(root, "ledger.db");
  const store = SQLStore.sqlite(path);
  const f = await LedgerFixture.createWithStore(store);
  t.after(async () => { await f.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, store, work: f.module, issue: f.issue, requirement: f.requirement };
}

test("schema18 migration is additive and preserves a historical Issue with no target", async t => {
  const f = await fixture(t);
  const id = f.issue.issue_id;
  const before = await f.work.showIssue(id);
  const raw = new DatabaseSync(f.path);
  raw.exec(`DROP TABLE issue_target_branches; DROP TABLE candidate_bases; DROP TABLE dev_run_bases; UPDATE schema_metadata SET schema_version=18; DELETE FROM schema_migrations WHERE schema_version=${SCHEMA_VERSION}`);
  raw.close();
  assert.equal((await f.store.inspectIntegrity()).report.valid, true);
  assert.equal((await f.store.migrate()).schema_version, SCHEMA_VERSION);
  assert.deepEqual(await f.work.showIssue(id), before);
  assert.equal((await f.store.migrate()).schema_version, SCHEMA_VERSION);
});

test("failed target schema migration rolls back the new table and can be retried", async t => {
  const f = await fixture(t);
  const raw = new DatabaseSync(f.path);
  try {
    raw.exec(`DROP TABLE issue_target_branches; DROP TABLE candidate_bases; DROP TABLE dev_run_bases; UPDATE schema_metadata SET schema_version=18;
      DELETE FROM schema_migrations WHERE schema_version=${SCHEMA_VERSION};
      CREATE TRIGGER fail_target_migration BEFORE UPDATE OF schema_version ON schema_metadata
      WHEN NEW.schema_version=${SCHEMA_VERSION} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    await assert.rejects(f.store.migrate());
    assert.equal(raw.prepare("SELECT schema_version FROM schema_metadata").get()!.schema_version, 18);
    assert.equal(raw.prepare("SELECT migration_state FROM schema_metadata").get()!.migration_state, "clean");
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='issue_target_branches'").get(), undefined);
    raw.exec("DROP TRIGGER fail_target_migration");
    assert.equal((await f.store.migrate()).schema_version, SCHEMA_VERSION);
  } finally { raw.close(); }
});

test("persisted malformed target is rejected instead of being treated as a historical Issue", async t => {
  const f = await fixture(t);
  await reviseTargetIssueSeeded(f.work, f.store, {
    attribution: testAgent, issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id,
    requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true,
    baseline: { git_oid: `sha1:${"a".repeat(40)}`, reachability: "remote_tracking_reachable" },
    input: { format: 1, summary: "Target", target_branch: { remote: "origin", ref: "refs/heads/main" },
      goals: [{ statement: "Change", criteria: ["Works"] }] },
  });
  const raw = new DatabaseSync(f.path);
  try { raw.exec("UPDATE issue_target_branches SET branch_ref='HEAD'"); } finally { raw.close(); }
  await assert.rejects(f.work.showIssue(f.issue.issue_id), { code: "ARTIFACT_INTEGRITY_ERROR" });
  assert.equal((await f.store.inspectIntegrity()).report.valid, false);
});

test("domain and YAML boundaries validate target shape without Git", () => {
  const valid = { remote: "origin", ref: "refs/heads/release/stable" };
  validateTargetBranchSpec(valid);
  for (const ref of ["main", "refs/heads/a..b", "refs/heads/a.lock", "refs/heads/a b", "refs/heads/a\\b", "refs/heads/a@{b", "refs/heads/.hidden"]) {
    assert.throws(() => validateTargetBranchSpec({ ...valid, ref }));
  }
  const value = decodeIssue(Buffer.from("format: 1\nsummary: test\ntarget_branch:\n  remote: origin\n  ref: refs/heads/main\ngoals:\n  - statement: implement\n    criteria: [works]\n"));
  assert.equal(value.target_branch?.ref, "refs/heads/main");
  assertContract("issue.schema.json", value);
});
