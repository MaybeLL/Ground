import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
const mysqlEnabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every(
  (k) => process.env["GROUNDS_TEST_MYSQL_" + k],
);
test("schema 17 migration preserves ledger identity and adds empty runtime storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-runtime-migrate-")),
    path = join(root, "test.db");
  let store = SQLStore.sqlite(path);
  try {
    await store.initialize("warn");
    const before = await store.inspect();
    await store.close();
    const db = new DatabaseSync(path);
    db.exec(
      "DROP TABLE runtime_records; UPDATE schema_metadata SET schema_version=17; DELETE FROM schema_migrations WHERE schema_version=20",
    );
    db.close();
    store = SQLStore.sqlite(path);
    const after = await store.migrate();
    assert.equal(after.schema_version, SCHEMA_VERSION);
    assert.equal(after.database_id, before.database_id);
    assert.deepEqual(
      await store.read((tx) => tx.listRuntimeRecords("runtime_operation")),
      [],
    );
    assert.equal((await store.inspectIntegrity()).report.valid, true);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retired rows are unread and unchanged; business runtime operations survive", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-runtime-retired-")), path = join(root, "test.db");
  let store = SQLStore.sqlite(path);
  const retiredId = newUUIDv7(), operationId = newUUIDv7(), activeId = newUUIDv7();
  const active = { id: activeId, kind: "runtime_operation" as const, version: 1, data: { description: "business operation retained" } };
  try {
    await store.initialize("warn");
    await store.write(tx => tx.saveRuntimeRecord(active, 0)); await store.close();
    const raw = new DatabaseSync(path);
    const insert = raw.prepare("INSERT INTO runtime_records(id,kind,parent_id,version,record_digest,record_json) VALUES(?,?,?,?,?,?)");
    insert.run(retiredId, "sandbox", null, 1, "old-digest", "not-json");
    insert.run(operationId, "runtime_operation", retiredId, 1, "old-digest", "not-json");
    const before = raw.prepare("SELECT * FROM runtime_records WHERE id IN (?,?) ORDER BY id").all(retiredId, operationId); raw.close();
    store = SQLStore.sqlite(path); await store.open();
    assert.equal(await store.read(tx => tx.getRuntimeRecord("sandbox", retiredId)), undefined);
    assert.equal(await store.read(tx => tx.getRuntimeRecord("runtime_operation", operationId)), undefined);
    assert.deepEqual(await store.read(tx => tx.listRuntimeRecords("sandbox")), []);
    assert.deepEqual(await store.read(tx => tx.listRuntimeRecords("runtime_operation")), [active]);
    await assert.rejects(store.write(tx => tx.saveRuntimeRecord({ id: newUUIDv7(), kind: "runtime_operation", parent_id: retiredId, version: 1, data: {} }, 0)), (error: unknown) => JSON.stringify(error).includes("retired"));
    assert.equal((await store.inspectIntegrity()).report.valid, true); await store.close();
    const check = new DatabaseSync(path);
    assert.deepEqual(check.prepare("SELECT * FROM runtime_records WHERE id IN (?,?) ORDER BY id").all(retiredId, operationId), before); check.close();
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});
