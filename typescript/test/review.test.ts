import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReviewMarkdown, renderReviewTrace } from "../src/review.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";
import { LedgerFixture, testAgent } from "./fixture.js";

test("review trace connects a code location to the exact contract, claims, and complete verifier findings", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const oldPath = "src/old-name.ts";
    const newPath = "src/new-name.ts";
    const candidate = await fixture.submitCandidate("one", [{
      path_bytes: Buffer.from(newPath).toString("base64"),
      display_path: newPath,
      change: "renamed",
      old_path_bytes: Buffer.from(oldPath).toString("base64"),
      old_mode: "100644",
      new_mode: "100644",
    }]);
    const first = await fixture.verify(candidate, "qualified");
    const second = await fixture.verify(candidate, "inconclusive");
    await fixture.module.reviseRequirement({
      operation_id: newUUIDv7(),
      requirement_id: fixture.requirement.requirement_id,
      expected_predecessor_id: fixture.requirement.requirement_revision_id,
      attribution: testAgent,
      input: { format: 1, summary: "A later requirement", outcomes: ["A later outcome"] },
    });

    const result = await fixture.module.reviewCandidate(candidate.candidate.candidate_id, {
      include_patch: true,
      location: { path: oldPath, line: 17, side: "old" },
    });

    assertContract("query-results.schema.json", result);
    assert.equal(result.trace.contract.requirement.id, fixture.requirement.requirement_id);
    assert.equal(result.trace.contract.requirement.version, 1);
    assert.equal(result.trace.contract.issue.id, fixture.issue.issue_id);
    assert.equal(result.trace.contract.issue.version, 1);
    assert.equal(result.trace.location?.match, "file");
    assert.equal(result.trace.location?.line_status, "unavailable");
    assert.equal(result.trace.location?.file?.display_path, newPath);
    const wrongSide = await fixture.module.reviewCandidate(candidate.candidate.candidate_id, { location: { path: newPath, side: "old" } });
    assert.equal(wrongSide.trace.location?.match, "none");
    assert.deepEqual(result.trace.location?.rationale_coverage, {
      source: "derived_relation",
      status: "not_applicable",
      reason: "line_precision_unavailable",
    });
    assert.equal(result.trace.artifact.patch_state, "inline");
    assert.equal(result.trace.verification_set.complete, true);
    assert.equal(result.trace.verification_set.count, 2);
    assert.deepEqual(new Set(result.trace.verification_set.verifications.map((item) => item.verification_id)), new Set([first.verification_id, second.verification_id]));
    assert.equal(result.trace.verification_set.verifications.every((item) => item.report.assessments.length === 1), true);

    const human = renderReviewTrace(result);
    assert.match(human, /Author's stated purpose \[author claim\]/);
    assert.match(human, /Historical contract \[ledger fact\]/);
    assert.match(human, /outcome-1: The change is observable \[derived relation\]/);
    assert.match(human, /line precision unavailable/);
    assert.match(human, /Verification \[complete set/);
  } finally {
    await fixture.close();
  }
});

test("review trace resolves a changed location to persisted author rationale and Criterion refs", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const patch = Buffer.from([
      "diff --git a/file-one b/file-one",
      "index 1111111..2222222 100644",
      "--- a/file-one",
      "+++ b/file-one",
      "@@ -11,3 +11,3 @@",
      " before",
      "-old",
      "+new",
      " after",
      "",
    ].join("\n"));
    const candidate = await fixture.submitCandidate("one", undefined, [
      { type: "command", command: "npm test", exit_code: 0, output: "line one\nline two" },
      { type: "artifact", name: "report.txt", media_type: "text/plain", content_base64: Buffer.from("artifact body").toString("base64") },
      { type: "observation", statement: "Observed behavior", attribution: testAgent },
      { type: "external_reference", url: "https://example.test/evidence", title: "Evidence page", content_digest: `sha256:${"1".repeat(64)}` },
    ], true, patch);
    assertContract("candidate-submission.schema.json", candidate.submission);
    const result = await fixture.module.reviewCandidate(candidate.candidate.candidate_id, {
      location: { path: "file-one", line: 12, side: "new" },
    });

    assertContract("query-results.schema.json", result);
    assert.equal(result.trace.submission.format, "patchledger.candidate-submission/v2");
    assert.equal(result.trace.change_index.change_units.length, 1);
    assert.equal(result.trace.location?.match, "change_unit");
    assert.equal(result.trace.location?.line_status, "added");
    assert.equal(result.trace.location?.rationales.length, 1);
    assert.equal(result.trace.location?.rationales[0].relation, "implements");
    assert.deepEqual(result.trace.location?.rationales[0].target_refs, [{ type: "criterion", id: candidate.criterion_id }]);
    assert.match(result.trace.location?.rationales[0].rationale ?? "", /implements/);
    assert.equal(result.trace.location?.rationale_coverage.status, "complete");
    assert.deepEqual(result.trace.explanation_coverage, {
      source: "derived_relation",
      status: "complete",
      total_change_units: 1,
      explained_change_units: 1,
      unexplained_change_unit_ids: [],
    });
    const human = renderReviewTrace(result);
    assert.match(human, /Change rationale \[author claim, implements\]/);
    assert.match(human, /Coverage: 1\/1 Change Units explained \(complete\)/);
    const markdown = renderReviewMarkdown(result);
    assert.match(markdown, /# Grounds Review/);
    const firstDetails = markdown.indexOf("<details>");
    assert.ok(firstDetails > 0);
    const reviewerFirst = markdown.slice(0, firstDetails);
    assert.match(reviewerFirst, /Purpose \| Implemented one \| author claim/);
    assert.match(reviewerFirst, /Standing \| \*\*unverified\*\*/);
    assert.match(reviewerFirst, /Verification \| none recorded/);
    assert.match(reviewerFirst, /Changed areas \| `file-one` \| ledger fact/);
    assert.match(reviewerFirst, /Rationale coverage \| 1\/1 \(\*\*complete\*\*\)/);
    assert.match(reviewerFirst, /Recorded risks \| 1 recorded; see details/);
    assert.match(reviewerFirst, /Risks: The changed behavior may affect callers/);
    assert.match(reviewerFirst, /Upstream intent .*outcome-1: The change is observable/);
    assert.match(reviewerFirst, /`file-one:11-13` \(hunk\) — This change implements The behavior changes \*\(implements; author claim\)\*/);
    assert.match(reviewerFirst, /Serves: The behavior changes/);
    assert.match(markdown, /No independent Verification is recorded/);
    assert.match(markdown, /<summary>Full Change Rationale records<\/summary>/);
    assert.match(markdown, /<summary>Full historical contract<\/summary>/);
    assert.match(markdown, new RegExp(candidate.criterion_id));
    assert.match(markdown, new RegExp(candidate.candidate.candidate_id));
    assert.match(markdown, /Output:\n    > line one\n    > line two/);
    assert.match(markdown, new RegExp(Buffer.from("artifact body").toString("base64")));
    assert.match(markdown, /Evidence page; URL `https:\/\/example\.test\/evidence`/);
    assert.match(markdown, /Change Index units digest: `sha256:/);

    const withDiff = await fixture.module.reviewCandidate(candidate.candidate.candidate_id, { include_patch: true });
    const diffMarkdown = renderReviewMarkdown(withDiff);
    assert.match(diffMarkdown, /<summary>Unified diff<\/summary>/);
    assert.match(diffMarkdown, /```diff\ndiff --git a\/file-one b\/file-one/);
    const omitted = structuredClone(withDiff);
    omitted.trace.artifact.patch_state = "omitted_size";
    delete omitted.trace.artifact.patch;
    assert.match(renderReviewMarkdown(omitted), /Unified diff is \*\*omitted_size\*\*/);
    const binary = structuredClone(withDiff);
    binary.trace.artifact.patch_state = "binary";
    delete binary.trace.artifact.patch;
    assert.match(renderReviewMarkdown(binary), /Unified diff is \*\*binary\*\*/);

    const escaped = structuredClone(result);
    escaped.trace.submission.explanation = "Purpose | <unsafe> _text_";
    escaped.trace.artifact.file_manifest[0].display_path = "src/a|b.ts";
    assert.match(renderReviewMarkdown(escaped), /Purpose \\| \\<unsafe\\> \\_text\\_/);
    assert.match(renderReviewMarkdown(escaped), /Changed areas \| `src\/a\\\|b\.ts` \| ledger fact/);

    const missingIntent = structuredClone(result);
    missingIntent.trace.contract.issue.goals[0].traces_to = [];
    const missingIntentMarkdown = renderReviewMarkdown(missingIntent);
    assert.match(missingIntentMarkdown, /no recorded Intent Link/);
    assert.match(missingIntentMarkdown, /At least one change-linked Goal or Constraint has no recorded Intent Link/);

    const richContract = structuredClone(result);
    richContract.trace.contract.requirement.context = "Requirement context";
    richContract.trace.contract.requirement.open_questions = [{ question: "A historical question?", blocking: false, assumption: "Historical assumption" }];
    richContract.trace.contract.requirement.decisions.push({ statement: "Historical decision", rationale: "Decision rationale" });
    richContract.trace.contract.issue.context = "Issue context";
    richContract.trace.contract.issue.goals[0].guidance = ["Goal guidance"];
    richContract.trace.contract.issue.constraints.push({
      id: newUUIDv7(),
      statement: "Historical constraint",
      criteria: [{ id: newUUIDv7(), statement: "Constraint criterion" }],
      guidance: ["Constraint guidance"],
      rationale: "Constraint rationale",
      traces_to: [{ type: "decision", ordinal: 1 }],
    });
    const richContractMarkdown = renderReviewMarkdown(richContract);
    assert.match(richContractMarkdown, /Requirement context/);
    assert.match(richContractMarkdown, /A historical question\?/);
    assert.match(richContractMarkdown, /Historical assumption/);
    assert.match(richContractMarkdown, /Issue context/);
    assert.match(richContractMarkdown, /Goal guidance/);
    assert.match(richContractMarkdown, /Constraint rationale/);
    assert.match(richContractMarkdown, /Constraint guidance/);

    const context = await fixture.module.reviewCandidate(candidate.candidate.candidate_id, {
      location: { path: "file-one", line: 11, side: "new" },
    });
    assertContract("query-results.schema.json", context);
    assert.equal(context.trace.location?.match, "file");
    assert.equal(context.trace.location?.line_status, "context");
    assert.deepEqual(context.trace.location?.change_units, []);
    assert.deepEqual(context.trace.location?.rationales, []);
    assert.equal(context.trace.location?.rationale_coverage.reason, "line_is_unchanged_context");
    assert.match(renderReviewTrace(context), /unchanged context inside a changed hunk/);
    const contextMarkdown = renderReviewMarkdown(context);
    assert.match(contextMarkdown, /Line status: \*\*context — this line is unchanged inside a changed hunk\*\*/);
    assert.match(contextMarkdown, /requested line itself did not change/);
    assert.doesNotMatch(contextMarkdown.slice(0, contextMarkdown.indexOf("<details>")), /This change implements/);
  } finally {
    await fixture.close();
  }
});

test("review trace reports an unmatched location without inventing a rationale", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const candidate = await fixture.submitCandidate();
    const result = await fixture.module.reviewCandidate(candidate.candidate.candidate_id, {
      location: { path: "src/not-changed.ts", side: "new" },
    });
    assert.equal(result.trace.location?.match, "none");
    assert.equal(result.trace.location?.file, undefined);
    assert.equal(result.trace.explanation_coverage.status, "not_recorded");
    assert.equal(result.trace.artifact.patch_state, "not_requested");
    assertContract("query-results.schema.json", result);
    const markdown = renderReviewMarkdown(result);
    assert.match(markdown, /No exact Change Unit is attached to this scope/);
    assert.match(markdown, /upstream intent is \*\*unknown\*\*/);
  } finally {
    await fixture.close();
  }
});

test("Markdown renders an old-side changed location with its old path and range", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const patch = Buffer.from([
      "diff --git a/old-name.ts b/new-name.ts",
      "similarity index 80%",
      "rename from old-name.ts",
      "rename to new-name.ts",
      "--- a/old-name.ts",
      "+++ b/new-name.ts",
      "@@ -100 +200 @@",
      "-old value",
      "+new value",
      "",
    ].join("\n"));
    const candidate = await fixture.submitCandidate("old-side", [{
      path_bytes: Buffer.from("new-name.ts").toString("base64"),
      display_path: "new-name.ts",
      change: "renamed",
      old_path_bytes: Buffer.from("old-name.ts").toString("base64"),
      old_mode: "100644",
      new_mode: "100644",
    }], [], true, patch);
    const result = await fixture.module.reviewCandidate(candidate.candidate.candidate_id, {
      location: { path: "old-name.ts", line: 100, side: "old" },
    });

    assert.equal(result.trace.location?.line_status, "deleted");
    const markdown = renderReviewMarkdown(result);
    assert.match(markdown, /Location: `old-name\.ts:100` \(old side\)/);
    assert.match(markdown, /`old-name\.ts:100-100` \(hunk\) —/);
    assert.doesNotMatch(markdown, /`new-name\.ts:200-200` \(hunk\)/);
  } finally {
    await fixture.close();
  }
});

test("Markdown bounds escaped Unicode previews while preserving complete records and warnings", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const candidate = await fixture.submitCandidate("one", undefined, [], true);
    const original = await fixture.module.reviewCandidate(candidate.candidate.candidate_id);
    for (const text of ["界😀", "|_*`<>", "a\nb\r\nc"]) {
      const result = structuredClone(original);
      const long = text.repeat(1000) + "END-OF-ORIGINAL";
      result.trace.contract.issue.summary = long;
      result.trace.submission.explanation = long;
      result.trace.contract.issue.goals[0].statement = long;
      result.trace.contract.requirement.outcomes[0] = long;
      result.trace.artifact.file_manifest = Array.from({ length: 100 }, (_, i) => ({ ...original.trace.artifact.file_manifest[0], display_path: `${long}-${i}` }));
      result.trace.submission.change_rationales = Array.from({ length: 100 }, () => ({ ...original.trace.submission.change_rationales[0], rationale: long, risks: [long] }));
      result.trace.verification_set.standing = "disputed";
      result.trace.explanation_coverage.status = "not_recorded";
      result.trace.explanation_coverage.unexplained_change_unit_ids = ["missing"];
      result.trace.contract.issue.goals[0].traces_to = [];
      const before = structuredClone(result);
      const markdown = renderReviewMarkdown(result);
      const preview = markdown.slice(0, markdown.indexOf("<details>"));
      assert.ok([...preview].length <= 4000, `characters: ${[...preview].length}`);
      assert.ok(preview.split("\n").length <= 50, `lines: ${preview.split("\n").length}`);
      assert.match(preview, /原文节选，完整内容见详情/);
      assert.match(preview, /No independent Verification/);
      assert.match(preview, /Verification standing is disputed/);
      assert.match(preview, /no recorded Intent Link/);
      assert.match(preview, /no recorded rationale/);
      assert.match(markdown.slice(markdown.indexOf("<details>")), /END-OF-ORIGINAL/);
      assert.deepEqual(result, before);
      const counts = /Remaining in details: (\d+) paths; (\d+) intent groups; (\d+) rationale records/.exec(preview)!;
      assert.ok(Number(counts[1]) >= 97);
      assert.ok(Number(counts[3]) >= 97);
      result.trace.location = {
        source: "derived_relation", requested_path: long, side: "new", line: 42,
        match: "file", line_status: "context", change_units: [], rationales: [],
        rationale_coverage: { source: "derived_relation", status: "not_applicable", reason: "line_is_unchanged_context" },
      };
      const located = renderReviewMarkdown(result);
      const locatedPreview = located.slice(0, located.indexOf("<details>"));
      assert.ok([...locatedPreview].length <= 4000);
      assert.ok(locatedPreview.split("\n").length <= 50);
      assert.match(locatedPreview, /path preview/);
      assert.match(locatedPreview, /context — this line is unchanged/);
      assert.doesNotMatch(locatedPreview, /\*\(implements; author claim\)\*/);
    }
  } finally { await fixture.close(); }
});
