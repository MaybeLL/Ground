import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReviewMarkdown, renderReviewTrace } from "../src/review.js";
import type { IntegrationRecord } from "../src/integration-service.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";

test("Review separates actual target predecessor evidence from adoption and Git first parent without rewriting old records", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const candidate = await fixture.submitCandidate("review-predecessor");
    const original = await fixture.module.reviewCandidate(candidate.candidate.candidate_id);
    const p = `sha1:${"1".repeat(40)}`, parent = `sha1:${"2".repeat(40)}`, landed = `sha1:${"3".repeat(40)}`, source = `sha1:${"4".repeat(40)}`;
    const tree = original.trace.artifact.result_tree_oid, at = "2026-10-16T04:00:00.000Z";
    const current = { source: "derived_relation" as const, count: 0, digest: `sha256:${"0".repeat(64)}`, standing: "unverified", verdict_counts: { qualified: 0, rejected: 0, inconclusive: 0 }, reports_included: false as const };
    const cases: NonNullable<IntegrationRecord["landing"]>["target_predecessor"][] = [
      { state: "confirmed", commit: { oid: p, parents: [], tree_oid: tree }, source: "adoption_binding" },
      undefined,
      { state: "unknown", reason: "actual_target_predecessor_unknown" },
      { state: "conflict", reason: "actual_target_predecessor_conflict" },
    ];
    for (const predecessor of cases) {
      const result = structuredClone(original);
      const record: IntegrationRecord = { id: newUUIDv7(), kind: "landing", candidate_id: candidate.candidate.candidate_id, created_at: at, attribution: testAgent, based_on: newUUIDv7(), landing: {
        target_observation: { branch: { remote: "origin", ref: "refs/heads/main" }, refreshed: false, observed_at: at },
        decision: { identity: "trusted", shape: "single_parent", parent_matches: false, tree_matches: true, outcome: "same_content_different_history" },
        verification: { candidate_id: candidate.candidate.candidate_id, selection: { version: 0 }, current_verification: current, verification_changed: false },
        delivery_link_eligibility: "not_exact_artifact", actual_landing: { oid: landed, parents: [parent], tree_oid: tree },
        adoption: { format: "grounds.adoption-binding/v1", repository_id: original.trace.repository.id, candidate_id: candidate.candidate.candidate_id, source_commit: source, landed_commit: landed, target: { remote: "origin", ref: "refs/heads/main" }, method: "ff", target_predecessor: p, source: { kind: "user_confirmation", reference: "actual target update" } },
        ...(predecessor ? { target_predecessor: predecessor } : {}),
      } };
      assertContract("integration.schema.json#/$defs/record", record);
      result.trace.adoption = [record];
      const before = structuredClone(result);
      for (const rendered of [renderReviewTrace(result), renderReviewMarkdown(result)]) {
        assert.ok(rendered.includes(`Git first parent of L: ${parent}`));
        assert.ok(rendered.includes(`landed L ${landed}`));
        assert.ok(rendered.includes(`Actual target predecessor P: ${predecessor?.state === "confirmed" ? p : "unknown"}`));
        assert.ok(!rendered.includes(`Actual target predecessor P: ${parent}`));
      }
      assert.deepEqual(result, before);
    }
  } finally { await fixture.close(); }
});
