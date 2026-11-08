import assert from "node:assert/strict";
import { test } from "node:test";
import { assertContract } from "./schema-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { DomainError } from "../src/errors.js";
import { backendSkip, openLedger } from "./backends.js";

for (const backend of ["sqlite", "mysql", "postgres"] as const) test(`${backend}: Verification directory pagination, fixed set and no report reads`, { skip: backendSkip(backend) }, async () => {
    const fixture = await openLedger(backend);
    try {
      const candidate = await fixture.submitCandidate();
      const id = candidate.candidate.candidate_id;
      const empty = await fixture.module.verificationPage(id);
      assert.equal(empty.verification_set.count, 0);
      assertContract("query-results.schema.json", empty);
      for (let index = 0; index < 257; index++) await fixture.verify(candidate, index % 3 === 0 ? "rejected" : index % 3 === 1 ? "qualified" : "inconclusive");
      const originalRead = fixture.store.read.bind(fixture.store);
      fixture.store.read = callback => originalRead(async tx => {
        tx.getVerification = async () => { throw new Error("summary path read a report"); };
        return callback(tx);
      });
      const first = await fixture.module.verificationPage(id);
      assert.equal(first.verifications.length, 256);
      assert.equal(first.verification_set.standing, "disputed");
      assert.equal("complete" in first.verification_set, false);
      assert.equal("verifications" in first.verification_set, false);
      assertContract("query-results.schema.json", first);
      const last = await fixture.module.verificationPage(id, first.next_cursor!);
      assert.equal(last.verifications.length, 1);
      assert.equal(last.verification_set.digest, first.verification_set.digest);
      assert.equal(last.next_cursor, undefined);
      await assert.rejects(fixture.module.verificationPage(newUUIDv7(), first.next_cursor!), { code: "VALIDATION_ERROR" });
      await assert.rejects(fixture.module.verificationPage(id, "invalid"), { code: "VALIDATION_ERROR" });
      await assert.rejects(fixture.module.verificationPage(newUUIDv7()), { code: "NOT_FOUND" });
      const oldEnvelope = JSON.parse(Buffer.from(first.next_cursor!, "base64url").toString("utf8"));
      const inner = Buffer.from(oldEnvelope.after, "base64url").toString("utf8");
      assert.ok(inner.startsWith("v2\0"));
      const oldCursor = Buffer.from(inner.slice(3)).toString("base64url");
      const restart = (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.equal(error.details.field, "verifications_cursor");
        assert.match(String(error.details.reason), /restart from the first page/);
        return true;
      };
      await assert.rejects(fixture.module.verificationPage(id, Buffer.from(JSON.stringify({ ...oldEnvelope, after: oldCursor })).toString("base64url")), restart);
      fixture.store.read = originalRead;
      await assert.rejects(fixture.module.showCandidate(id, "", oldCursor), restart);
      const detail = (await fixture.module.showCandidate(id)).candidate;
      assert.equal(detail.verifications.length, 256);
      assert.ok(detail.verifications_next_cursor);
      const detailLast = (await fixture.module.showCandidate(id, "", detail.verifications_next_cursor)).candidate;
      assert.equal(detailLast.verifications.length, 1);
      assert.equal(detailLast.verifications_next_cursor, undefined);
      assert.deepEqual([...detail.verifications, ...detailLast.verifications], [...first.verifications, ...last.verifications].map(({ candidate_id, ...row }) => row));
      await fixture.verify(candidate);
      await assert.rejects(fixture.module.verificationPage(id, first.next_cursor!), error => {
        assertContract("error.schema.json", (error as DomainError).toJSON());
        return error instanceof DomainError && error.code === "VERIFICATION_SET_CHANGED" && error.retryable;
      });
    } finally { await fixture.close(); }
});
