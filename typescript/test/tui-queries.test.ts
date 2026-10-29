import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "../src/module.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";

test("comparison summary works without local Git and excludes invented statistics", async () => {
  const f = await LedgerFixture.create();
  try {
    const a = await f.submitCandidate("one");
    const b = await f.submitCandidate("two");
    const m = new Module(f.store, newUUIDv7, async () => { throw new Error("Git must not run"); });
    const result = await m.compareCandidateSummary([a.candidate.candidate_id, b.candidate.candidate_id]);
    assertContract("query-results.schema.json", result);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].changed_files_count, 1);
    assert.equal("diff_from_baseline" in result.candidates[0], false);
    assert.equal("patch_state" in result.candidates[0], false);
    assert.equal("pairwise_diffs" in result, false);
    await assert.rejects(m.compareCandidateSummary([a.candidate.candidate_id, a.candidate.candidate_id]));
    const old = await m.listCandidatesForIssue(f.issue.issue_id, 1);
    assert.equal(old.resources.length, 2);
    const revised = await f.module.reviseIssue({
      operation_id: newUUIDv7(), attribution: testAgent, issue_id: f.issue.issue_id,
      expected_predecessor_id: f.issue.issue_revision_id,
      requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: testBaseline,
      input: { format: 1, summary: "Version two", goals: [{ statement: "New goal", criteria: ["New criterion"] }] },
    });
    const c = await f.submitCandidate("three", undefined, [], false, undefined, revised.result);
    assert.equal((await m.listCandidatesForIssue(f.issue.issue_id)).resources.length, 1);
    assert.deepEqual((await m.listCandidatesForIssue(f.issue.issue_id, 1)).resources, old.resources);
    await assert.rejects(m.listCandidatesForIssue(f.issue.issue_id, 999));
    await assert.rejects(m.compareCandidateSummary([a.candidate.candidate_id, c.candidate.candidate_id]));
  } finally { await f.close(); }
});
