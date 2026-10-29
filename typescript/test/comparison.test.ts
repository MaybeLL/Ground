import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLStore } from "../src/sql-store.js";
import { enforceComparisonSize, inlinePatch, MAX_COMPARISON_BYTES } from "../src/comparison.js";
import { newUUIDv7 } from "../src/identity.js";
import { Module } from "../src/module.js";
import { LedgerFixture, testAgent, testVerifier, testBaseline } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";

test("Candidate comparison uses real tree stats and contract patch states", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const first = await fixture.submitCandidate("one");
    const second = await fixture.submitCandidate("two");
    const calls: [string, string][] = [];
    const module = new Module(fixture.store, newUUIDv7, async (left, right) => {
      calls.push([left, right]);
      const pairwise = left === first.artifact.result_tree_oid || left === second.artifact.result_tree_oid;
      return {
        patch: Buffer.from(pairwise ? "pairwise diff\n" : "baseline diff\n"),
        files: pairwise ? 2 : 1,
        insertions: pairwise ? 7 : 3,
        deletions: pairwise ? 4 : 1,
        binary: false,
        too_large: false,
      };
    });

    const comparison = await module.compareCandidates(
      [second.candidate.candidate_id, first.candidate.candidate_id],
      {
        include_patch_ids: [first.candidate.candidate_id],
        pairwise_pairs: [[first.candidate.candidate_id, second.candidate.candidate_id]],
      },
    );

    assert.equal(comparison.candidates.length, 2);
    assert.deepEqual(comparison.candidates.map((item) => item.patch_state).sort(), ["inline", "not_requested"]);
    assert.deepEqual(comparison.candidates.map((item) => item.diff_from_baseline), [
      { files: 1, insertions: 3, deletions: 1 },
      { files: 1, insertions: 3, deletions: 1 },
    ]);
    assert.equal(comparison.pairwise_diffs[0].diff_state, "inline");
    assert.equal(comparison.pairwise_diffs[0].unified_diff, "pairwise diff\n");
    assert.equal(calls.length, 3);
    assertContract("query-results.schema.json", comparison);
  } finally {
    await fixture.close();
  }
});

test("inline patch and total comparison gates omit bytes without losing digests", () => {
  assert.deepEqual(inlinePatch(Buffer.alloc(1024 * 1024 + 1, 0x61), true), { patch_state: "omitted_size" });
  assert.deepEqual(inlinePatch(Buffer.from("GIT binary patch\n"), true), { patch_state: "binary" });
  assert.equal(inlinePatch(Buffer.from("literal replacement: \ufffd\n"), true).patch_state, "inline");
  assert.equal(inlinePatch(Buffer.from([0xff, 0xfe]), true).patch_state, "binary");

  const huge = "x".repeat(1024 * 1024);
  const id = newUUIDv7();
  const candidate = {
    candidate_id: id,
    dev_run_id: newUUIDv7(),
    submission_explanation: { digest: `sha256:${"0".repeat(64)}`, preview: "ok", truncated: false },
    attribution: { kind: "agent" as const, agent_id: "test", display_name: "Test" },
    created_at: "2026-01-01T00:00:00.000Z",
    standing: "unverified",
    result_tree_oid: `sha1:${"1".repeat(40)}`,
    equivalence_group: `sha1:${"1".repeat(40)}`,
    patch_digest: `sha256:${"2".repeat(64)}`,
    patch_state: "inline" as const,
    patch: huge,
    diff_from_baseline: { files: 0, insertions: 0, deletions: 0 },
    manifest_digest: `sha256:${"3".repeat(64)}`,
    changed_files_count: 0,
    changed_files: [],
    changed_files_omitted: false,
    claims: [],
    verification_count: 0,
    verification_digest: `sha256:${"4".repeat(64)}`,
    verification_summaries: [],
    verification_summaries_omitted: false,
  };
  const result = enforceComparisonSize({
    result_type: "patchledger.result.candidate-comparison/v1",
    command: "candidate.compare",
    issue_revision_id: newUUIDv7(),
    baseline_oid: `sha1:${"5".repeat(40)}`,
    candidates: Array.from({ length: 9 }, (_, index) => ({ ...candidate, candidate_id: newUUIDv7(), patch: `${index}${huge}` })),
    pairwise_diffs: [],
  });
  const encodedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.ok(encodedBytes <= MAX_COMPARISON_BYTES);
  assert.ok(result.candidates.some((item) => item.patch_state === "omitted_size"));
  assert.ok(result.candidates.every((item) => item.patch_digest === candidate.patch_digest));
});

test("comparison reads each immutable report once for summaries and criterion standings", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const first = await fixture.submitCandidate("one"), second = await fixture.submitCandidate("two");
    await fixture.verify(first, "qualified"); await fixture.verify(first, "rejected");
    const read = fixture.store.read.bind(fixture.store);
    let reads = new Map<string, number>();
    fixture.store.read = callback => read(async tx => {
      const get = tx.getVerification.bind(tx);
      tx.getVerification = async id => { reads.set(id, (reads.get(id) ?? 0) + 1); return get(id); };
      return callback(tx);
    });
    for (const summary of [true, false]) {
      reads = new Map();
      const ids = [first.candidate.candidate_id, second.candidate.candidate_id];
      const result = summary ? await fixture.module.compareCandidateSummary(ids) : await fixture.module.compareCandidates(ids);
      assertContract("query-results.schema.json", result);
      assert.equal(result.candidates.find(item => item.candidate_id === ids[0])!.standing, "disputed");
      assert.equal(result.candidates.find(item => item.candidate_id === ids[0])!.verification_count, 2);
      assert.equal(result.candidates.find(item => item.candidate_id === ids[1])!.standing, "unverified");
      assert.equal(reads.size, 2);
      assert.deepEqual([...reads.values()], [1, 1], "one validation pass must supply all comparison projections");
    }
  } finally { await fixture.close(); }
});

test("comparison validates reports beyond its summary page and sees later changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-comparison-"));
  const path = join(root, "ledger.db"), store = SQLStore.sqlite(path);
  try {
    const fixture = await LedgerFixture.createWithStore(store, async () => undefined);
    const first = await fixture.submitCandidate("one"), second = await fixture.submitCandidate("two");
    // Fixed times reproduce the fractional-prefix boundary: text order puts
    // .11Z before .1Z although the rejected report is chronologically later.
    const write = store.write.bind(store);
    let verificationTime = "2026-01-01T00:00:00.1Z";
    store.write = callback => write(async tx => { tx.now = async () => verificationTime; return callback(tx); });
    const seed = await fixture.verify(first, "qualified");
    // Synthetic valid copies exercise the 256/257 boundary without repeated CLI setup.
    await store.write(async tx => {
      const record = await tx.getVerification(seed.verification_id);
      for (let i = 0; i < 255; i++) await tx.createVerification({ verification: { ...record.verification, id: newUUIDv7() }, report: record.report });
    });
    const ids = [first.candidate.candidate_id, second.candidate.candidate_id];
    const before = await fixture.module.compareCandidateSummary(ids);
    const beforeValue = before.candidates.find(item => item.candidate_id === ids[0])!;
    assert.equal(beforeValue.standing, "qualified");
    assert.equal(beforeValue.verification_summaries_omitted, false);
    verificationTime = "2026-01-01T00:00:00.11Z";
    const last = await fixture.verify(first, "rejected");
    const read = store.read.bind(store); const reads = new Map<string, number>();
    store.read = callback => read(async tx => {
      const get = tx.getVerification.bind(tx);
      tx.getVerification = async id => { reads.set(id, (reads.get(id) ?? 0) + 1); return get(id); };
      return callback(tx);
    });
    const result = await fixture.module.compareCandidateSummary(ids); const value = result.candidates.find(item => item.candidate_id === ids[0])!;
    assertContract("query-results.schema.json", result);
    assert.equal(value.verification_count, 257); assert.equal(value.verification_summaries.length, 256);
    assert.equal(value.verification_summaries_omitted, true); assert.equal(value.standing, "disputed");
    assert.ok(value.verification_summaries.every(row => row.overall_verdict === "qualified"));
    assert.equal((value.claims[0] as { criteria: { verification_standing: string }[] }).criteria[0].verification_standing, "disputed");
    assert.notEqual(value.verification_digest, beforeValue.verification_digest);
    assert.equal(reads.size, 257); assert.ok([...reads.values()].every(count => count === 1));
    assert.equal(value.verification_digest, (await fixture.module.reviewSummary(ids[0])).trace.verification_set.digest);
    const raw = new DatabaseSync(path);
    try { raw.prepare("UPDATE verification_assessments SET target_id = ? WHERE verification_id = ?").run(newUUIDv7(), last.verification_id); }
    finally { raw.close(); }
    for (const summary of [true, false]) await assert.rejects(
      summary ? fixture.module.compareCandidateSummary(ids) : fixture.module.compareCandidates(ids),
      { code: "ARTIFACT_INTEGRITY_ERROR" },
    );
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("comparison keeps per-criterion verdicts distinct from the overall report verdict", async () => {
  const f = await LedgerFixture.create();
  try {
    const original = await f.submitCandidate();
    const revised = await f.module.reviseIssue({ operation_id: newUUIDv7(), attribution: testAgent,
      issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id,
      requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: testBaseline,
      input: { format: 1, summary: "Two criteria", goals: [{ statement: "Observable behavior", criteria: ["First passes", "Second varies"] }] } });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const run = await f.module.startDevRun({ operation_id: newUUIDv7(), attribution: testAgent,
        issue_id: f.issue.issue_id, issue_revision_id: revised.result.issue_revision_id, issue_revision_explicit: true,
        repository_remote_snapshot: f.repository.canonical_remote });
      const submitted = await f.module.submitCandidate({ ...f.gitCandidateFields(original.artifact), operation_id: newUUIDv7(), attribution: testAgent,
        dev_run_id: run.result.context.dev_run.id, expected_version: 1, artifact: original.artifact,
        submission: { format: "patchledger.candidate-submission/v1", explanation: "Synthetic comparison",
          claims: run.result.context.issue.goals.map(goal => ({ target_type: "goal", target_id: goal.id, explanation: "Implemented",
            criteria: goal.criteria.map(criterion => ({ criterion_id: criterion.id, explanation: "Observed", evidence: [] })) })) } });
      ids.push(submitted.candidate_id);
    }
    let qualifiedCriterionId = "";
    for (const verdict of ["rejected", "inconclusive"] as const) {
      const template = await f.module.verificationReportTemplate(ids[0]);
      qualifiedCriterionId ||= template.report.assessments[0].criteria[0].criterion_id;
      template.report.assessments[0].criteria.forEach((criterion) => {
        const value = criterion.criterion_id === qualifiedCriterionId ? "qualified" : verdict;
        criterion.independent = { verdict: value, explanation: "Observed", evidence: [] };
        criterion.reconciliation = { claim_relation: "corroborated", explanation: "Compared" };
        criterion.final = { verdict: value, explanation: "Conclusion" };
      });
      await f.module.submitVerification({ operation_id: newUUIDv7(), attribution: testVerifier, report: template.report });
    }
    for (const summary of [true, false]) {
      const result = summary ? await f.module.compareCandidateSummary(ids) : await f.module.compareCandidates(ids);
      const candidate = result.candidates.find(item => item.candidate_id === ids[0])!;
      assert.equal(candidate.standing, "rejected");
      const criteria = (candidate.claims[0] as { criteria: { criterion_id: string; verification_standing: string }[] }).criteria;
      assert.equal(criteria.length, 2);
      for (const criterion of criteria) assert.equal(criterion.verification_standing, criterion.criterion_id === qualifiedCriterionId ? "qualified" : "rejected");
      assertContract("query-results.schema.json", result);
    }
  } finally { await f.close(); }
});

test("comparison reuses validated report dependencies within one read snapshot", async (t) => {
  const fixture = await LedgerFixture.create();
  try {
    const first = await fixture.submitCandidate("one"), second = await fixture.submitCandidate("two");
    await fixture.verify(first, "qualified");
    const prepare = DatabaseSync.prototype.prepare;
    let queries: string[] = [];
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (/^SELECT/i.test(sql.trim())) queries.push(sql);
      return prepare.call(this, sql);
    });
    const ids = [first.candidate.candidate_id, second.candidate.candidate_id];
    const baseline = new Map<boolean, number>();
    for (const summary of [true, false]) {
      queries = [];
      if (summary) await fixture.module.compareCandidateSummary(ids);
      else await fixture.module.compareCandidates(ids);
      baseline.set(summary, queries.length);
    }
    await fixture.verify(first, "rejected");
    for (const summary of [true, false]) {
      queries = [];
      const result = summary ? await fixture.module.compareCandidateSummary(ids) : await fixture.module.compareCandidates(ids);
      assert.equal(result.candidates.find(item => item.candidate_id === ids[0])!.standing, "disputed");
      // Extra report needs its own row, assessments and evidence, not another
      // Candidate artifact / sealed contract graph. This fixture has one criterion.
      const extra = queries.length - baseline.get(summary)!;
      assert.ok(extra <= 3, `extra report added ${extra} SELECTs`);
    }
  } finally { await fixture.close(); }
});

test("comparison bounds upstream payloads without mutating caller evidence", () => {
  const patch = "u".repeat(1024 * 1024);
  const input: import("../src/comparison.js").CandidateComparisonResult = {
    result_type: "patchledger.result.candidate-comparison/v1", command: "candidate.compare", issue: { id: newUUIDv7(), version: 1 },
    baseline_oid: `sha1:${"1".repeat(40)}`, candidates: [],
    pairwise_diffs: Array.from({ length: 9 }, () => ({
      left_candidate_id: newUUIDv7(), right_candidate_id: newUUIDv7(), equivalent: false,
      diff_digest: `sha256:${"2".repeat(64)}`, stats: { files: 1, insertions: 1, deletions: 0 }, diff_state: "inline", unified_diff: "",
      upstream_changes: { source: "derived_relation", role: "base_changes_not_candidate_changes", left_base_commit: `sha1:${"1".repeat(40)}`, right_base_commit: `sha1:${"3".repeat(40)}`, status: "available", diff: { diff_digest: `sha256:${"4".repeat(64)}`, stats: { files: 1, insertions: 1, deletions: 0 }, diff_state: "inline", unified_diff: patch } },
    })),
  };
  const result = enforceComparisonSize(input);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_COMPARISON_BYTES);
  assert.ok(result.pairwise_diffs.some(pair => pair.upstream_changes!.diff!.diff_state === "omitted_size"));
  assert.ok(input.pairwise_diffs.every(pair => pair.upstream_changes!.diff!.unified_diff === patch));
});


test("Candidate comparison sorts fractional timestamps by instant rather than text", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const write = fixture.store.write.bind(fixture.store);
    let time = "2026-01-01T00:00:00.1Z";
    fixture.store.write = callback => write(async tx => { tx.now = async () => time; return callback(tx); });
    const first = await fixture.submitCandidate("one");
    time = "2026-01-01T00:00:00.11Z";
    const second = await fixture.submitCandidate("two");
    const ids = [first.candidate.candidate_id, second.candidate.candidate_id];
    for (const result of [await fixture.module.compareCandidateSummary([...ids].reverse()), await fixture.module.compareCandidates([...ids].reverse())]) {
      assert.deepEqual(result.candidates.map(item => item.candidate_id), ids);
    }
  } finally { await fixture.close(); }
});
