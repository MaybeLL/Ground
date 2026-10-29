import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCandidateSubmission, summarizeSelfVerification, type SelfVerification } from "../src/domain.js";
import { LedgerFixture } from "./fixture.js";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";
import { renderReviewMarkdown, renderReviewTrace } from "../src/review.js";
import { assertContract } from "./schema-fixture.js";

test("self verification survives persistence and Review but is withheld from blind verification", async () => {
  const f = await LedgerFixture.create();
  try {
    const legacy = await f.submitCandidate("legacy");
    for (const status of ["satisfied", "partially_satisfied", "not_satisfied", "inconclusive", "not_verified"] as const) {
      const check: SelfVerification = { status, explanation: "Recorded result", ...(status === "not_verified" ? {} : { method: "Run focused unit tests" }) };
      const c = await f.submitCandidate(status, undefined, [{ type: "command", command: "go test ./...", exit_code: 0 }], true, undefined, f.issue, check);
      assertContract("candidate-submission.schema.json", c.submission);
      const stored = await f.store.read(tx => tx.getCandidate(c.candidate.candidate_id));
      assert.deepEqual(stored.candidate.submission.claims[0].criteria[0].self_verification, check);
      const trace = await f.module.reviewCandidate(c.candidate.candidate_id);
      assertContract("query-results.schema.json", trace);
      assertContract("query-results.schema.json", await f.module.reviewSummary(c.candidate.candidate_id));
      assertContract("query-results.schema.json", await f.module.compareCandidates([legacy.candidate.candidate_id, c.candidate.candidate_id]));
      assert.equal(trace.trace.submission.claims[0].self_verification_summary?.[status], 1);
      for (const output of [renderReviewTrace(trace), renderReviewMarkdown(trace)]) assert.match(output, new RegExp(`Self-verification.*${status}`));
      const blind = await f.module.verificationContext(c.candidate.candidate_id, "blind");
      assert.equal(JSON.stringify(blind).includes('"self_verification"'), false);
      const reconcile = await f.module.verificationContext(c.candidate.candidate_id, "reconcile");
      assertContract("verification-context.schema.json", reconcile.context);
      assert.match(JSON.stringify(reconcile), /self_verification/);
      assert.equal(trace.trace.verification_set.standing, "unverified");
    }
  } finally { await f.close(); }
});

test("self verification rejects unsupported, ungrounded and contradictory checks", async () => {
  const f = await LedgerFixture.create();
  try {
    const c = await f.submitCandidate();
    const samples = [null, { status: "passed", explanation: "x" }, { status: "satisfied", explanation: "x" },
      { status: "satisfied", explanation: "x", method: "test" },
      { status: "not_verified", explanation: "x", method: "test" },
      { status: "not_verified", explanation: "x", typo: true }];
    for (const check of samples) {
      const draft = structuredClone(c.submission);
      Object.assign(draft.claims[0].criteria[0], { self_verification: check });
      assert.throws(() => decodeCandidateSubmission(Buffer.from(JSON.stringify(draft))), { code: "VALIDATION_ERROR" });
      assert.throws(() => assertContract("candidate-submission.schema.json", draft));
    }
    assert.deepEqual(decodeCandidateSubmission(Buffer.from(JSON.stringify(c.submission))), c.submission);
    assert.equal(summarizeSelfVerification([{},{ self_verification: { status: "not_verified", explanation: "No environment" } }]).not_recorded, 1);
    assert.match(renderReviewMarkdown(await f.module.reviewCandidate(c.candidate.candidate_id)), /未记录/);
  } finally { await f.close(); }
});

test("schema 14 migration keeps historical submission and blind context unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grounds-self-check-")), path = join(dir, "ledger.db");
  const store = SQLStore.sqlite(path);
  try {
    const f = await LedgerFixture.createWithStore(store);
    const c = await f.submitCandidate();
    const before = await f.module.verificationContext(c.candidate.candidate_id, "blind");
    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE candidate_claim_criteria DROP COLUMN self_verification_json; UPDATE schema_metadata SET schema_version=14; DELETE FROM schema_migrations WHERE schema_version=20");
    raw.close();
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.deepEqual((await store.read(tx => tx.getCandidate(c.candidate.candidate_id))).candidate.submission, c.submission);
    assert.deepEqual(await f.module.verificationContext(c.candidate.candidate_id, "blind"), before);
    const corrupt = new DatabaseSync(path);
    corrupt.prepare("UPDATE candidate_claim_criteria SET self_verification_json = ? WHERE candidate_id = ?").run('{"status":"satisfied","explanation":"No check"}', c.candidate.candidate_id);
    corrupt.close();
    await assert.rejects(f.store.read(tx => tx.getCandidate(c.candidate.candidate_id)), { code: "ARTIFACT_INTEGRITY_ERROR" });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
