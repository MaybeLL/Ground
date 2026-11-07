import { backends, backendSkip, openLedger } from "./backends.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { indexCandidateChanges } from "../src/change-index.js";

for (const backend of backends) test(`${backend}: historical delivery links retain withdrawn and original versions`, { skip: backendSkip(backend) }, async () => {
  const dir = backend === "sqlite" ? mkdtempSync(join(tmpdir(), "grounds-stored-delivery-")) : undefined;
  const path = dir && join(dir, "ledger.db");
  const f = path ? await LedgerFixture.createWithStore(SQLStore.sqlite(path)) : await openLedger(backend);
  try {
    const patch = Buffer.from("diff --git a/rule.ts b/rule.ts\n--- a/rule.ts\n+++ b/rule.ts\n@@ -1 +1 @@\n-old();\n+newRule();\n");
    const c = await f.submitCandidate("rule", [{ path_bytes: Buffer.from("rule.ts").toString("base64"), display_path: "rule.ts", change: "modified", old_mode: "100644", new_mode: "100644" }], [], true, patch);
    const blind = await f.module.verificationContext(c.candidate.candidate_id, "blind");
    const unit = indexCandidateChanges(c.artifact).change_units[0];
    const id = newUUIDv7();
    await f.store.write(async tx => {
      const recorded = {
        id, version: 1, state: "recorded" as const, updated_at: await tx.now(), attribution: testAgent,
        candidate_id: c.candidate.candidate_id, repository_id: f.repository.repository_id,
        commit_oid: "a".repeat(40), parent_oid: "b".repeat(40), patch_digest: c.artifact.patch_digest,
        method: "raw-double-sided/v1" as const, content: "exact_scope" as const,
        units: [{ change_unit_id: unit.change_unit_id, path: "rule.ts", candidate_start: 1, commit_start: 4, lines: 1 }],
      };
      await tx.saveDeliveryLink(recorded, 0);
      await tx.saveDeliveryLink({ ...recorded, state: "withdrawn", version: 2, reason: "Incorrect attribution" }, 1);
    });
    assert.equal((await f.store.read(tx => tx.getDeliveryLink(id))).state, "withdrawn");
    assert.equal((await f.store.read(tx => tx.getDeliveryLink(id, 1))).state, "recorded");
    assert.deepEqual(await f.module.verificationContext(c.candidate.candidate_id, "blind"), blind);
    assert.equal((await f.store.inspectIntegrity()).report.valid, true);
    if (path) {
      const db = new DatabaseSync(path);
      try {
        db.prepare("UPDATE delivery_links SET version=1 WHERE id=?").run(id);
        assert.equal((await f.store.inspectIntegrity()).report.valid, false);
        await assert.rejects(f.store.read(tx => tx.getDeliveryLink(id)), { code: "ARTIFACT_INTEGRITY_ERROR" });
        assert.equal((await f.store.read(tx => tx.getDeliveryLink(id, 1))).state, "recorded");
        db.prepare("UPDATE delivery_links SET version=2 WHERE id=?").run(id);
        db.prepare("UPDATE delivery_link_versions SET record_json='{}' WHERE link_id=? AND version=1").run(id);
        assert.equal((await f.store.inspectIntegrity()).report.valid, false);
        await assert.rejects(f.store.read(tx => tx.getDeliveryLink(id, 1)), { code: "ARTIFACT_INTEGRITY_ERROR" });
      } finally { db.close(); }
    }
  } finally {
    await f.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("schema 13 upgrades additively without changing immutable Candidate context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grounds-history-migration-"));
  const path = join(dir, "ledger.db"), store = SQLStore.sqlite(path);
  const f = await LedgerFixture.createWithStore(store);
  try {
    const c = await f.submitCandidate();
    const before = await f.module.verificationContext(c.candidate.candidate_id, "blind");
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE delivery_link_versions; DROP TABLE delivery_links; UPDATE schema_metadata SET schema_version=13; DELETE FROM schema_migrations WHERE schema_version=20"); raw.close();
    await assert.rejects(store.open(), { code: "SCHEMA_INCOMPATIBLE" });
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.deepEqual(await f.module.verificationContext(c.candidate.candidate_id, "blind"), before);
    const migrated = new DatabaseSync(path);
    try { assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM delivery_links").get()!.n, 0); }
    finally { migrated.close(); }
    assert.equal((await store.inspectIntegrity()).report.valid, true);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});
