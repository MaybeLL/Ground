import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceOf } from "../src/work/domain/index.js";
import { migrateLegacyLedger, MIGRATION_REQUEST_ID, type MigrationDependencies } from "../src/work/application/index.js";
import { SqlLedgerIntegrityProbe, SqlLegacyReader, SqlWorkUnitOfWork } from "../src/work/adapters/index.js";
import { newUUIDv7 } from "../src/identity.js";
import type { LedgerFixture } from "./fixture.js";
import { testAgent } from "./fixture.js";
import { backends, backendSkip, openLedger } from "./backends.js";
import { VerificationRuns } from "../src/verification-run.js";
import { testVerifier } from "./fixture.js";
import { hash } from "./work-fixtures.js";

const dependencies = (fixture: LedgerFixture): MigrationDependencies => ({
  reader: new SqlLegacyReader(fixture.store), units: new SqlWorkUnitOfWork(fixture.store), integrity: new SqlLedgerIntegrityProbe(fixture.store),
  hash, now: () => new Date().toISOString(), newId: newUUIDv7,
});

/** A ledger as the previous model leaves it: a refinement tree with a branch, a second root, an abandoned run, an open run and two verifications. */
async function legacyLedger(fixture: LedgerFixture) {
  const a = await fixture.submitCandidate("one");
  const verificationA = await fixture.verify(a, "qualified");
  const b = await fixture.submitCandidate("two", undefined, [], false, undefined, undefined, undefined, a.candidate.candidate_id);
  const verificationB = await fixture.verify(b, "rejected");
  const c = await fixture.submitCandidate("three", undefined, [], false, undefined, undefined, undefined, a.candidate.candidate_id);
  const d = await fixture.submitCandidate("four");
  const issue = fixture.issue;
  const start = () => fixture.module.startDevRun({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: issue.issue_id, issue_revision_id: issue.issue_revision_id, issue_revision_explicit: false, repository_remote_snapshot: fixture.repository.canonical_remote });
  const abandoned = await start();
  await fixture.module.abandonDevRun({ operation_id: newUUIDv7(), dev_run_id: abandoned.result.context.dev_run.id, expected_version: 1, reason: "wrong direction", attribution: testAgent });
  const open = await start();
  await fixture.module.setSelection({ operation_id: newUUIDv7(), issue_id: issue.issue_id, issue_version: 1, candidate_id: b.candidate.candidate_id, expected_version: 0, attribution: testAgent, reason: "B reads best" });
  return { a, b, c, d, verificationA, verificationB, abandonedId: abandoned.result.context.dev_run.id, openId: open.result.context.dev_run.id };
}

for (const backend of backends) {
  const rehearsal = (name: string, run: (fixture: LedgerFixture) => Promise<void>) => test(`${backend}: migration rehearsal ${name}`, { skip: backendSkip(backend) }, async () => {
    const fixture = await openLedger(backend);
    try { await run(fixture); } finally { await fixture.close(); }
  });

  rehearsal("migrates a real ledger, verifies it, and leaves the old tables untouched", async fixture => {
    const legacy = await legacyLedger(fixture);
    const deps = dependencies(fixture);
    const dry = await migrateLegacyLedger(deps, { dryRun: true });
    assert.equal(dry.status, "dry-run");
    assert.equal((await deps.units.run("read", r => r.taskRuns.get(legacy.a.run.context.dev_run.id))), undefined, "a dry run writes nothing");

    const result = await migrateLegacyLedger(deps);
    assert.equal(result.status, "migrated", JSON.stringify(result));
    if (result.status !== "migrated") return;
    assert.deepEqual(result.checks, { integrityBefore: true, integrityAfter: true, legacyUnchanged: true, aggregatesVerified: result.checks.aggregatesVerified });
    assert.ok(result.checks.aggregatesVerified >= 6 + 6 + 2 + 2);
    assert.equal(result.planDigest, dry.status === "dry-run" ? dry.planDigest : "", "a rehearsal predicts the real run");
    const r = result.report;
    assert.equal(r.issues, 1);
    assert.deepEqual(r.taskRuns, { delivered: 4, abandoned: 1, stillOpen: 1 });
    assert.equal(r.works, 4, "the tree of A, B and C; D; the abandoned run; the open run");
    assert.equal(r.worksWithoutHead.length, 0, "A has two refinements, but the user chose B in the old ledger");
    assert.equal(r.worksWithSelectedHead, 1);
    assert.equal(r.gradings, 2);
    assert.equal(r.gradingsWithoutSession, 2, "the service-level verification keeps no review session");
    assert.deepEqual(r.skippedVerifications, []);

    await deps.units.run("read", async repositories => {
      const runA = (await repositories.taskRuns.get(legacy.a.run.context.dev_run.id))!;
      assert.equal(runA.id, legacy.a.run.context.dev_run.id, "identifiers are kept");
      assert.equal(runA.status, "delivered");
      const runB = (await repositories.taskRuns.get(legacy.b.run.context.dev_run.id))!;
      assert.equal(runB.refines, runA.id);
      assert.equal(runB.workId, runA.workId);
      const tree = (await repositories.works.get(runA.workId!))!;
      assert.equal(tree.head, legacy.b.run.context.dev_run.id, "the user's choice in the old ledger is the head");
      assert.equal(tree.headHistory[0].reason, "migration-selection");
      assert.deepEqual([...tree.runIds].sort(), [runA.id, runB.id, (await repositories.taskRuns.get(legacy.c.run.context.dev_run.id))!.id].sort());
      const solo = (await repositories.works.get((await repositories.taskRuns.get(legacy.d.run.context.dev_run.id))!.workId!))!;
      assert.equal(solo.head, legacy.d.run.context.dev_run.id);
      assert.equal(solo.headHistory[0].reason, "migration-default");
      const abandoned = (await repositories.taskRuns.get(legacy.abandonedId))!;
      assert.equal(abandoned.status, "cancelled");
      assert.match(abandoned.cancelIntent!.reason!, /wrong direction/);
      assert.match((await repositories.taskRuns.get(legacy.openId))!.cancelIntent!.reason!, /still open/);
      const gateA = (await repositories.gradings.get(legacy.verificationA.verification_id))!;
      assert.equal(gateA.status, "completed");
      assert.equal(gateA.binding!.manifestDigest, runA.manifest!.digest);
      const subjectOf = (g: typeof gateA) => ({ taskRevisionId: g.binding!.taskRevision.revisionId, criteriaDigest: g.binding!.criteriaDigest, manifestDigest: g.binding!.manifestDigest });
      assert.equal(acceptanceOf(await repositories.gradings.listForTaskRun(runA.id), subjectOf(gateA)).conclusion, "accepted");
      const gateB = (await repositories.gradings.get(legacy.verificationB.verification_id))!;
      assert.equal(acceptanceOf(await repositories.gradings.listForTaskRun(runB.id), subjectOf(gateB)).conclusion, "rejected");
    });
    assert.equal(await deps.units.run("write", r => r.sequences.next("grading-request")), 3, "the next request continues after the migrated ones");
    const intent = await deps.units.run("read", r => r.intents.findByRequest(MIGRATION_REQUEST_ID));
    assert.equal(intent?.state, "completed");
  });

  rehearsal("keeps the session, protocol stages and observed commands of a verification that has its run record", async fixture => {
    const candidate = await fixture.submitCandidate("one");
    const context = await fixture.module.verificationContext(candidate.candidate.candidate_id, "blind");
    const runs = new VerificationRuns(fixture.store);
    const sessionId = newUUIDv7();
    const run = await runs.begin({ candidate_id: candidate.candidate.candidate_id, result_tree_oid: candidate.artifact.result_tree_oid, blind_context_digest: context.context.blind_context_digest,
      role: "contract", review_session_id: sessionId, review_worktree: "/tmp/review", attribution: testVerifier });
    await runs.stage(run.id, "prepare", "succeeded");
    await runs.stage(run.id, "blind", "running");
    await runs.command(run.id, "blind", { entry: "candidate-context", argv_digest: `sha256:${"a".repeat(64)}`, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), state: "succeeded", exit_code: 0 });
    await runs.stage(run.id, "blind", "succeeded");
    await runs.freeze(run.id, `sha256:${"b".repeat(64)}`);
    const verification = await fixture.verify(candidate, "qualified");
    await runs.recordSubmit(run.id, "confirmed", newUUIDv7(), verification.verification_id);
    // A quality-role run for the same candidate must not be taken for the contract run.
    await runs.begin({ candidate_id: candidate.candidate.candidate_id, result_tree_oid: candidate.artifact.result_tree_oid, blind_context_digest: context.context.blind_context_digest,
      role: "quality", review_session_id: newUUIDv7(), review_worktree: "/tmp/quality", attribution: testVerifier });

    const deps = dependencies(fixture);
    const result = await migrateLegacyLedger(deps);
    assert.equal(result.status, "migrated", JSON.stringify(result));
    if (result.status !== "migrated") return;
    assert.equal(result.report.gradingsWithoutSession, 0);
    assert.equal(result.report.observationsOutsideProtocol, 0);
    const gate = (await deps.units.run("read", r => r.gradings.get(verification.verification_id)))!;
    const evaluator = gate.evaluator;
    assert.equal(evaluator?.kind, "external");
    if (evaluator?.kind !== "external") return;
    assert.equal(evaluator.sessionId, sessionId);
    assert.equal(evaluator.migrated, true);
    assert.deepEqual(evaluator.protocol?.map(p => p.stage), ["blind", "freeze", "submit"]);
    assert.equal(evaluator.protocol?.[1].blindDigest, `sha256:${"b".repeat(64)}`);
    assert.deepEqual(evaluator.commandObservations?.map(o => [o.stage, o.entry, o.state, o.exitCode]), [["blind", "candidate-context", "succeeded", 0]]);
  });

  rehearsal("is a no-op when repeated, and refuses once the old data has changed", async fixture => {
    const legacy = await legacyLedger(fixture);
    const deps = dependencies(fixture);
    const first = await migrateLegacyLedger(deps);
    assert.equal(first.status, "migrated");
    const again = await migrateLegacyLedger(deps);
    assert.equal(again.status, "already-migrated");
    assert.equal(again.status === "already-migrated" && again.planDigest, first.status === "migrated" ? first.planDigest : "");
    assert.equal(again.status === "already-migrated" && again.checks.integrityAfter, true);
    // Another verification arrives in the old tables afterwards.
    await fixture.verify(legacy.c, "qualified");
    const changed = await migrateLegacyLedger(deps);
    assert.equal(changed.status, "changed", JSON.stringify(changed));
    assert.equal(await deps.units.run("read", async r => (await r.gradings.listForTaskRun(legacy.c.run.context.dev_run.id)).length), 0, "nothing of the new data was written");
  });

  rehearsal("an empty old ledger migrates to nothing but the built-in grader", async fixture => {
    const empty = dependencies(fixture);
    const result = await migrateLegacyLedger(empty);
    assert.equal(result.status, "migrated", JSON.stringify(result));
    if (result.status === "migrated") assert.deepEqual([result.report.works, result.report.gradings, result.report.taskRuns.delivered], [0, 0, 0]);
  });
}
