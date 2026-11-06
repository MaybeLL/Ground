import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { RepositoryArchiveAccess } from "../src/repository-archive-access.js";
import { GitLabClient } from "../src/gitlab-api.js";
import { normalizeRemote } from "../src/git.js";
import { gitLabAPIFixture } from "./gitlab-api-fixture.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";

async function setup(t: TestContext) {
  const ledger = await LedgerFixture.create(), api = await gitLabAPIFixture();
  t.after(async () => { await api.close(); await ledger.close(); });
  const repository = await ledger.module.registerRepository({ operation_id: newUUIDv7(),
    canonical_remote: normalizeRemote(`${api.instance}/team/repo.git`), attribution: testAgent });
  const id = repository.result.repository_id;
  const access = new RepositoryArchiveAccess(ledger.store, instance => new GitLabClient(instance,
    () => ({ token: "fixture-maintainer", source: "environment" })));
  const binding = { operation_id: newUUIDv7(), attribution: testAgent, repository_id: id, instance: api.instance, expected_version: 0 };
  return { ledger, api, id, access, binding };
}

test("archive setting retains independent versions, replay and concurrent CAS", async t => {
  const x = await setup(t);
  const first = await x.access.bind(x.binding);
  assert.deepEqual(await x.access.bind(x.binding), first);
  const outcomes = await Promise.allSettled([1, 2].map(() => x.access.bind({ ...x.binding,
    operation_id: newUUIDv7(), expected_version: 1 })));
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  const rejected = outcomes.find(value => value.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "VERSION_CONFLICT");
  assert.equal((await x.access.status(x.id)).binding_version, 2);
  assert.deepEqual(await x.access.bind(x.binding), first);
});

for (const bad of ["format", "owner"] as const) test(`archive setting rejects corrupted ${bad} before reads or writes`, async t => {
  const x = await setup(t);
  await x.access.bind(x.binding);
  const rows = await x.ledger.store.read(tx => tx.listRuntimeRecords("runtime_operation", x.id));
  const row = rows.find(row => row.data.format === "grounds.repository-archive-binding/v1")!;
  assert.ok(row);
  await x.ledger.store.write(tx => tx.saveRuntimeRecord({ ...row, version: row.version + 1,
    data: { ...row.data, ...(bad === "format" ? { format: "unexpected/v1" } : {}),
      ...(bad === "owner" ? { repository_id: newUUIDv7() } : {}) } }, row.version));
  await assert.rejects(x.access.status(x.id), { code: "ARTIFACT_INTEGRITY_ERROR" });
  await assert.rejects(x.access.bind({ ...x.binding, operation_id: newUUIDv7(), expected_version: 1 }), { code: "ARTIFACT_INTEGRITY_ERROR" });
});

test("storage refuses to reassign the archive setting parent", async t => {
  const x = await setup(t);
  const first = await x.access.bind(x.binding);
  const rows = await x.ledger.store.read(tx => tx.listRuntimeRecords("runtime_operation", x.id));
  const row = rows.find(row => row.data.format === "grounds.repository-archive-binding/v1")!;
  await assert.rejects(x.ledger.store.write(tx => tx.saveRuntimeRecord({ ...row,
    version: row.version + 1, parent_id: newUUIDv7() }, row.version)), { code: "VALIDATION_ERROR" });
  assert.deepEqual((await x.access.status(x.id)).binding, first.binding);
});

test("archive setting rejects conflicting persisted identities", async t => {
  const x = await setup(t), first = await x.access.bind(x.binding);
  await x.ledger.store.write(tx => tx.saveRuntimeRecord({ id: x.id, kind: "runtime_operation", version: 1,
    parent_id: x.id, data: { ...first.binding } }, 0));
  await assert.rejects(x.access.status(x.id), { code: "ARTIFACT_INTEGRITY_ERROR" });
  await assert.rejects(x.access.bind({ ...x.binding, operation_id: newUUIDv7(), expected_version: 1 }), { code: "ARTIFACT_INTEGRITY_ERROR" });
});
