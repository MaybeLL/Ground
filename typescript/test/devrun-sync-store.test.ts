import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerFixture, testAgent } from "./fixture.js";
import { SQLStore } from "../src/sql-store.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";
import { newUUIDv7 } from "../src/identity.js";
import { type RuntimeRecord } from "../src/runtime-record.js";
import { syncData } from "../src/devrun-sync-record.js";
import { contentDigestFor, issueWriteBinding } from "../src/preflight.js";
import { seedPublishPreflight, seedStartPreflight, ledgerOnlyPreflightCoordinator } from "./preflight-fixture.js";

const original = `sha1:${"1".repeat(40)}`, target = `sha1:${"2".repeat(40)}`, digest = `sha256:${"3".repeat(64)}`;
const mysqlEnabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every(k => process.env["GROUNDS_TEST_MYSQL_" + k]);
async function fixture(t: { after: (fn: () => Promise<void>) => void }, targetFlow = true, engine: "sqlite" | "mysql" | "postgres" = "sqlite") {
  const root = mkdtempSync(join(tmpdir(), "grounds-sync-store-")), path = join(root, "ledger.db");
  const pg = engine === "postgres" ? await isolatedPostgres() : undefined;
  const makeStore = () => pg ? pg.open() : engine === "mysql" ? SQLStore.mysql({ host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT || 3306), database: process.env.GROUNDS_TEST_MYSQL_DATABASE!, username: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE } : {}) }) : SQLStore.sqlite(path, { busyTimeoutMs: 10 });
  const store = makeStore();
  const f = await LedgerFixture.createWithStore(store, () => store.close(), { preflightCoordinator: ledgerOnlyPreflightCoordinator(store) });
  t.after(async () => { await f.close(); if (pg) await pg.cleanup(); rmSync(root, { recursive: true, force: true }); });
  const selectionInput = { format: 1 as const, summary: "Sync fixture", ...(targetFlow ? { target_branch: { remote: "origin", ref: "refs/heads/main" } } : {}), goals: [{ statement: "Feature", criteria: ["Feature works"] }] };
  if (targetFlow) await seedPublishPreflight(store, { repositoryId: f.repository.repository_id, canonicalRemote: f.repository.canonical_remote, target: { remote: "origin", ref: "refs/heads/main" }, commit: original, contentDigest: contentDigestFor(issueWriteBinding({ requirement_revision_id: f.requirement.requirement_revision_id, predecessor_requirement_revision_id: f.requirement.requirement_revision_id, issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, baseline_oid: original, target_branch: { remote: "origin", ref: "refs/heads/main" }, issue_input: selectionInput })) });
  const revision = await f.module.reviseIssue({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id,
    requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true,
    baseline: { git_oid: original, reachability: "remote_tracking_reachable" },
    input: selectionInput });
  if (targetFlow) await seedStartPreflight(store, { repositoryId: f.repository.repository_id, canonicalRemote: f.repository.canonical_remote, issueId: f.issue.issue_id, issueRevisionId: revision.result.issue_revision_id, target: { remote: "origin", ref: "refs/heads/main" }, commit: original });
  const started = await f.module.startDevRun({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: f.issue.issue_id, issue_revision_id: revision.result.issue_revision_id,
    issue_revision_explicit: true, repository_remote_snapshot: f.repository.canonical_remote });
  const runId = started.result.context.dev_run.id;
  const record = (): RuntimeRecord => ({ id: newUUIDv7(), kind: "runtime_operation", parent_id: runId, version: 1, data: {
    format: "grounds.devrun-sync/v1", dev_run_id: runId, original_base: original, target, run_version: 2, phase: "reserved", created_at: "2026-10-12T00:00:00.000Z", attribution: testAgent,
    recovery: { host_id: "test-host", directory: join(root, "recovery") },
  } });
  const advance = (row: RuntimeRecord, phase: string, extra = {}) => store.write(async tx => {
    await tx.lockDevRun(runId);
    const current = (await tx.getRuntimeRecord("runtime_operation", row.id))!;
    const next = { ...current, version: current.version + 1, data: { ...current.data, ...extra, phase } };
    await tx.saveRuntimeRecord(next, current.version); return next;
  });
  return { f, store, path, runId, record, advance, makeStore };
}

test("reserved sync durably blocks abandonment and submission until explicit recovery", async t => {
  const x = await fixture(t), sync = x.record();
  const run = await x.store.write(tx => tx.reserveDevRunSync(sync, 1));
  assert.equal(run.version, 2); assert.equal(run.base_commit, original);
  await assert.rejects(x.store.write(tx => tx.abandonDevRun(x.runId, 2)));
  await assert.rejects(x.store.write(tx => tx.submitDevRun(x.runId, 2)));
  const second = SQLStore.sqlite(x.path); await second.open();
  try {
    assert.equal(syncData((await second.read(tx => tx.getRuntimeRecord("runtime_operation", sync.id)))!).phase, "reserved");
    await assert.rejects(second.write(tx => tx.assertDevRunNotSyncing(x.runId)));
  } finally { await second.close(); }
  await assert.rejects(x.store.write(tx => tx.finishDevRunSync(sync.id, 1, digest, [], "completed")));
  assert.equal((await x.store.read(tx => tx.getDevRun(x.runId))).base_commit, original);
});

test("completion atomically advances base and version, retaining zero-diff conflict decisions", async t => {
  const x = await fixture(t), sync = x.record(); await x.store.write(tx => tx.reserveDevRunSync(sync, 1));
  const prepared = await x.advance(sync, "prepared", { material_digest: digest, conflicts: ["file"] });
  const applying = await x.advance(prepared, "applying");
  const resolving = await x.advance(applying, "resolving");
  const completing = await x.advance(resolving, "completing");
  await assert.rejects(x.store.write(tx => tx.finishDevRunSync(sync.id, completing.version, digest, [], "completed")));
  assert.equal((await x.store.read(tx => tx.getDevRun(x.runId))).version, 2, "failed validation rolls back the preceding version/base writes");
  await assert.rejects(x.store.write(async tx => {
    await tx.finishDevRunSync(sync.id, completing.version, digest, [{ path: "file", explanation: "完全采用上游" }], "completed");
    throw new Error("injected failure before SQL commit");
  }), /injected failure/);
  assert.equal((await x.store.read(tx => tx.getDevRun(x.runId))).base_commit, original);
  assert.equal(syncData((await x.store.read(tx => tx.getRuntimeRecord("runtime_operation", sync.id)))!).phase, "completing");
  assert.equal((await x.store.inspectIntegrity()).report.valid, true);
  const run = await x.store.write(tx => tx.finishDevRunSync(sync.id, completing.version, digest, [{ path: "file", explanation: "完全采用上游，候选中不产生差异" }], "completed"));
  assert.equal(run.version, 3); assert.equal(run.base_commit, target);
  const saved = syncData((await x.store.read(tx => tx.getRuntimeRecord("runtime_operation", sync.id)))!);
  assert.equal(saved.phase, "completed"); assert.equal(saved.decisions![0]!.path, "file");
  await x.store.write(tx => tx.assertDevRunNotSyncing(x.runId));
  await assert.rejects(x.store.write(tx => tx.finishDevRunSync(sync.id, completing.version, digest, [], "completed")));
  assert.equal((await x.store.inspectIntegrity()).report.valid, true);
});

test("abandonment requires a local restore receipt, retains the old base and releases only after SQL commit", async t => {
  const x = await fixture(t), sync = x.record(); await x.store.write(tx => tx.reserveDevRunSync(sync, 1));
  const abandoning = await x.advance(sync, "abandoning");
  await assert.rejects(x.store.write(tx => tx.finishDevRunSync(sync.id, abandoning.version, "missing", [], "abandoned")));
  await assert.rejects(x.store.write(tx => tx.assertDevRunNotSyncing(x.runId)));
  const run = await x.store.write(tx => tx.finishDevRunSync(sync.id, abandoning.version, digest, [], "abandoned"));
  assert.equal(run.version, 3); assert.equal(run.base_commit, original);
  await x.store.write(tx => tx.assertDevRunNotSyncing(x.runId));
});

test("concurrent sync reservations share a cross-connection serialization fence", async t => {
  const x = await fixture(t), second = SQLStore.sqlite(x.path, { busyTimeoutMs: 10 }); await second.open();
  try {
    const results = await Promise.allSettled([
      x.store.write(tx => tx.reserveDevRunSync(x.record(), 1)),
      second.write(tx => tx.reserveDevRunSync(x.record(), 1)),
    ]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
  } finally { await second.close(); }
});

test("recovery identity, phase order and terminal receipts cannot be overwritten", async t => {
  const x = await fixture(t), sync = x.record(); await x.store.write(tx => tx.reserveDevRunSync(sync, 1));
  await assert.rejects(x.advance(sync, "completing", { material_digest: digest, conflicts: [] }));
  await assert.rejects(x.advance(sync, "prepared", { material_digest: digest, conflicts: [], target: `sha1:${"4".repeat(40)}` }));
  await assert.rejects(x.store.write(tx => tx.saveRuntimeRecord({ ...sync, version: 2, data: { format: "not-sync" } }, 1)));
  const abandoning = await x.advance(sync, "abandoning");
  await x.store.write(tx => tx.finishDevRunSync(sync.id, abandoning.version, digest, [], "abandoned"));
  await assert.rejects(x.advance(sync, "reserved"));
});

// One scenario for every networked engine: two independent connections must serialize sync and binding.
const serializeSyncScenario = async (t: Parameters<typeof fixture>[0], engine: "mysql" | "postgres"): Promise<void> => {
  const x = await fixture(t, true, engine), second = x.makeStore(); await second.open();
  try {
    const sync = x.record(), competing = x.record();
    const race = await Promise.allSettled([
      x.store.write(tx => tx.reserveDevRunSync(sync, 1)),
      second.write(tx => tx.reserveDevRunSync(competing, 1)),
    ]);
    assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
    const winner = race[0]!.status === "fulfilled" ? sync : competing;
    await assert.rejects(second.write(tx => tx.reserveDevRunSync(x.record(), 1)));
    const abandoning = await x.advance(winner, "abandoning");
    await assert.rejects(second.write(async tx => {
      await tx.finishDevRunSync(winner.id, abandoning.version, digest, [], "abandoned");
      throw new Error("injected rollback");
    }), /injected rollback/);
    await assert.rejects(second.write(tx => tx.assertDevRunNotSyncing(x.runId)));
    const run = await second.write(tx => tx.finishDevRunSync(winner.id, abandoning.version, digest, [], "abandoned"));
    assert.equal(run.version, 3); assert.equal(run.base_commit, original);
    await x.store.write(tx => tx.assertDevRunNotSyncing(x.runId));
  } finally { await second.close(); }
};

test("mysql: independent connections serialize sync/binding and restore terminal state atomically", { skip: !mysqlEnabled }, async t => serializeSyncScenario(t, "mysql"));
test("postgres: independent connections serialize sync/binding and restore terminal state atomically", { skip: !postgresEnabled }, async t => serializeSyncScenario(t, "postgres"));

test("historical flows and stale versions cannot reserve sync", async t => {
  const legacy = await fixture(t, false); await assert.rejects(legacy.store.write(tx => tx.reserveDevRunSync(legacy.record(), 1)));
  const x = await fixture(t), sync = x.record(); await x.store.write(tx => tx.reserveDevRunSync(sync, 1));
  await assert.rejects(x.store.write(tx => tx.reserveDevRunSync(x.record(), 1)));
});
