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
import { assertContract } from "./schema-fixture.js";

for (const backend of backends) test(`${backend}: competing delivery records serialize, preserve historical reads and replay after withdrawal`, { skip: backendSkip(backend) }, async () => {
  const f = await openLedger(backend);
  try {
    const patch = Buffer.from("diff --git a/rule.ts b/rule.ts\n--- a/rule.ts\n+++ b/rule.ts\n@@ -1 +1 @@\n-old();\n+newRule();\n");
    const c = await f.submitCandidate("rule", [{ path_bytes: Buffer.from("rule.ts").toString("base64"), display_path: "rule.ts", change: "modified", old_mode: "100644", new_mode: "100644" }], [], true, patch);
    const blind = await f.module.verificationContext(c.candidate.candidate_id, "blind");
    const unit = indexCandidateChanges(c.artifact).change_units[0];
    const input = { operation_id: newUUIDv7(), attribution: testAgent, expected_version: 0, proof: { candidate_id: c.candidate.candidate_id, repository_id: f.repository.repository_id, commit_oid: "a".repeat(40), parent_oid: "b".repeat(40), patch_digest: c.artifact.patch_digest, method: "raw-double-sided/v1" as const, content: "exact_scope" as const, units: [{ change_unit_id: unit.change_unit_id, path: "rule.ts", candidate_start: 1, commit_start: 4, lines: 1 }] } };
    const requests = [input, { ...input, operation_id: newUUIDv7() }];
    const outcomes = await Promise.allSettled(requests.map(request => f.module.recordDeliveryLink(request)));
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    const winnerIndex = outcomes.findIndex(r => r.status === "fulfilled");
    const recorded = (outcomes[winnerIndex] as PromiseFulfilledResult<any>).value;
    assertContract("code-history.schema.json", recorded);
    assert.equal((outcomes[1 - winnerIndex] as PromiseRejectedResult).reason.code, "VERSION_CONFLICT");
    const withdrawn = await f.module.withdrawDeliveryLink({ operation_id: newUUIDv7(), attribution: testAgent, link_id: recorded.link.id, expected_version: 1, reason: "Correct the mistaken attribution" });
    assert.equal(withdrawn.link.version, 2);
    assert.equal((await f.module.showDeliveryLink(recorded.link.id, 1)).link.state, "recorded");
    assert.deepEqual(await f.module.recordDeliveryLink(requests[winnerIndex]), recorded);
    assert.deepEqual(await f.module.completedDeliveryLinkOperation({ operation_id: requests[winnerIndex].operation_id, repository_id: f.repository.repository_id, candidate_id: c.candidate.candidate_id, commit_oid: input.proof.commit_oid, expected_version: 0, attribution: testAgent }), recorded);
    assert.deepEqual(await f.module.verificationContext(c.candidate.candidate_id, "blind"), blind);
    assert.equal((await f.store.inspectIntegrity()).report.valid, true);
  } finally { await f.close(); }
});

test("schema 13 upgrades additively to 15 without changing immutable Candidate context", async () => {
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
    assert.deepEqual(await f.module.deliveryLinks(f.repository.repository_id), []);
    assert.equal((await store.inspectIntegrity()).report.valid, true);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});
