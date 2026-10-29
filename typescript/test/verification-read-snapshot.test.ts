import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLStore } from "../src/sql-store.js";
import type { Tx } from "../src/store-types.js";
import { LedgerFixture } from "./fixture.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";

const mysqlEnabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every(key => process.env[`GROUNDS_TEST_MYSQL_${key}`]);
const corrupt = (tx: Tx, sql: string, params: unknown[]) =>
  // Deliberate persisted corruption at the adapter seam; never a production API.
  (tx as unknown as { client: { run(sql: string, params: unknown[]): Promise<unknown> } }).client.run(sql, params);

for (const backend of ["sqlite", "mysql", "postgres"] as const) test(`${backend}: report dependency reuse preserves snapshot and integrity boundaries`, { skip: backend === "mysql" ? !mysqlEnabled : backend === "postgres" ? !postgresEnabled : false }, async () => {
  const pg = backend === "postgres" ? await isolatedPostgres() : undefined;
  const fixture = pg ? await LedgerFixture.createWithStore(pg.store, pg.cleanup) : backend === "sqlite" ? await LedgerFixture.create() : await LedgerFixture.createWithStore(SQLStore.mysql({
    host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? "3306"),
    database: process.env.GROUNDS_TEST_MYSQL_DATABASE!, username: process.env.GROUNDS_TEST_MYSQL_USERNAME!,
    password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE,
  }));
  try {
    const first = await fixture.submitCandidate("first"), second = await fixture.submitCandidate("second");
    const a = await fixture.verify(first, "qualified"), b = await fixture.verify(first, "rejected"), c = await fixture.verify(second, "qualified");
    // Switching candidates and mutable public return values must not poison the
    // private dependency projection used by later reports in the same snapshot.
    await fixture.store.read(async tx => {
      await tx.getVerification(a.verification_id);
      const candidate = await tx.getCandidate(first.candidate.candidate_id);
      candidate.candidate.result_tree_oid = "broken";
      candidate.artifact.patch.fill(0);
      const issue = await tx.getIssueRevisionById(candidate.candidate.issue_revision_id);
      issue.goals.length = 0;
      const report = await tx.getVerification(b.verification_id);
      assert.equal(report.verification.overall_verdict, "rejected");
      report.report.assessments.length = 0;
      assert.equal((await tx.getVerification(c.verification_id)).verification.candidate_id, second.candidate.candidate_id);
      assert.equal((await tx.getVerification(a.verification_id)).verification.overall_verdict, "qualified");
    });
    // A corrupt second report must be rejected even after the first warms reuse.
    await fixture.store.write(tx => corrupt(tx, "UPDATE verifications SET result_tree_oid = ? WHERE id = ?", [`sha1:${"f".repeat(40)}`, b.verification_id]));
    await fixture.store.read(async tx => {
      await tx.getVerification(a.verification_id);
      await assert.rejects(tx.getVerification(b.verification_id), { code: "ARTIFACT_INTEGRITY_ERROR" });
    });
    await fixture.store.write(tx => corrupt(tx, "UPDATE verifications SET result_tree_oid = ? WHERE id = ?", [first.artifact.result_tree_oid, b.verification_id]));
    // Later transactions must see changed Candidate and Issue dependency graphs.
    for (const [sql, bad, good, id] of [
      ["UPDATE candidates SET result_tree_oid = ? WHERE id = ?", `sha1:${"f".repeat(40)}`, first.artifact.result_tree_oid, first.candidate.candidate_id],
      ["UPDATE goals SET statement = ? WHERE id = ?", "corrupted", first.run.context.issue.goals[0].statement, first.goal_id],
    ] as const) {
      await fixture.store.read(tx => tx.getVerification(a.verification_id));
      await fixture.store.write(tx => corrupt(tx, sql, [bad, id]));
      try {
        await assert.rejects(fixture.store.read(tx => tx.getVerification(a.verification_id)), { code: "ARTIFACT_INTEGRITY_ERROR" });
      } finally { await fixture.store.write(tx => corrupt(tx, sql, [good, id])); }
      await fixture.store.read(tx => tx.getVerification(a.verification_id));
    }
    // Write transactions must observe their own writes, even after reading a report.
    const rollback = new Error("rollback deliberate test corruption");
    await assert.rejects(fixture.store.write(async tx => {
      await tx.getVerification(a.verification_id);
      await corrupt(tx, "UPDATE candidates SET result_tree_oid = ? WHERE id = ?", [`sha1:${"f".repeat(40)}`, first.candidate.candidate_id]);
      await assert.rejects(tx.getVerification(b.verification_id), { code: "ARTIFACT_INTEGRITY_ERROR" });
      throw rollback;
    }), error => error === rollback);
    await fixture.store.read(tx => tx.getVerification(b.verification_id));
  } finally { await fixture.close(); }
});
