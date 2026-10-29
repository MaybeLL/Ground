import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execute, runCLI } from "../src/cli.js";
import type { CandidateFile, EvidenceInput } from "../src/domain.js";
import { newUUIDv7 } from "../src/identity.js";
import { SQLStore } from "../src/sql-store.js";
import { assertContract } from "./schema-fixture.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";

type ReviewTrace = {
  trace: {
    candidate: { candidate_id: string; standing: string };
    contract: {
      requirement: { outcomes: string[]; decisions: unknown[] };
      issue: { goals: Array<{ traces_to?: Array<{ type: string; ordinal: number }>; criteria: Array<{ id: string; statement: string }> }> };
    };
    location?: {
      match: string;
      line_status?: string;
      file?: { display_path: string };
      change_units: Array<{
        change_unit_id: string;
        kind: string;
        old_range?: { start: number; lines: number };
        new_range?: { start: number; lines: number };
      }>;
      rationales: Array<{
        relation: string;
        target_refs: Array<{ type: string; id: string }>;
        alternatives: Array<{ approach: string; rejected_because: string }>;
        risks: string[];
      }>;
      rationale_coverage: { status: string; reason?: string };
    };
    submission: {
      format: string;
      claims: Array<{
        criteria: Array<{ criterion_id: string; evidence: EvidenceInput[] }>;
      }>;
    };
    verification_set: {
      count: number;
      complete: true;
      standing: string;
      verifications: Array<{ overall_verdict: string }>;
    };
    explanation_coverage: { status: string; explained_change_units: number };
  };
};

test("Review Conversation projection exercises the user-facing causal interface", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-review-dogfood-"));
  let fixture: LedgerFixture | undefined;
  try {
    const config = join(directory, "config.yaml");
    const database = join(directory, "ledger.db");
    await execute(["init", "--driver", "sqlite", "--non-interactive", "--config", config, "--path", database]);
    fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(database));

    const evidence: EvidenceInput[] = [{
      type: "command",
      command: "npm test -- review",
      exit_code: 0,
      output: "review checks passed",
    }];
    const orderPath = "src/order.ts";
    const orderFiles: CandidateFile[] = [{
      path_bytes: Buffer.from(orderPath).toString("base64"),
      display_path: orderPath,
      change: "modified",
      old_mode: "100644",
      new_mode: "100644",
    }];
    const orderPatch = Buffer.from([
      `diff --git a/${orderPath} b/${orderPath}`,
      "index 1111111..2222222 100644",
      `--- a/${orderPath}`,
      `+++ b/${orderPath}`,
      "@@ -41,2 +41,3 @@ async function placeOrder() {",
      " const order = await validate(input);",
      "+await transaction(async () => persist(order));",
      " return order;",
      "",
    ].join("\n"));
    const explained = await fixture.submitCandidate("conversation", orderFiles, evidence, true, orderPatch);
    await fixture.verify(explained, "qualified");
    await fixture.verify(explained, "rejected");

    const review = async (args: string[]): Promise<ReviewTrace> => {
      const at = args.indexOf("--at"), side = args.includes("old") ? "old" as const : "new" as const;
      const spec = at >= 0 ? args[at + 1]! : undefined;
      const split = spec?.lastIndexOf(":") ?? -1;
      const data = await fixture!.module.reviewCandidate(args[0]!, { ...(spec ? { location: { path: spec.slice(0, split), line: Number(spec.slice(split + 1)), side } } : {}) });
      assertContract("query-results.schema.json", data);
      return data as unknown as ReviewTrace;
    };

    // “Why did this line change?” and “why this approach?” share one trace;
    // the Skill only changes which fields it renders from this result.
    const explainedTrace = await review([
      explained.candidate.candidate_id,
      "--at",
      `${orderPath}:42`,
    ]);
    const explainedLocation = explainedTrace.trace.location;
    assert.equal(explainedTrace.trace.submission.format, "patchledger.candidate-submission/v2");
    assert.equal(explainedLocation?.match, "change_unit");
    assert.equal(explainedLocation?.line_status, "added");
    assert.equal(explainedLocation?.change_units[0].kind, "hunk");
    assert.deepEqual(explainedLocation?.change_units[0].new_range, { start: 41, lines: 3 });
    assert.equal(explainedLocation?.rationale_coverage.status, "complete");
    assert.equal(explainedLocation?.rationales.length, 1);
    assert.equal(explainedLocation?.rationales[0].relation, "implements");
    assert.equal(explainedLocation?.rationales[0].target_refs[0].id, explained.criterion_id);
    assert.equal(explainedLocation?.rationales[0].alternatives.length, 1);
    assert.equal(explainedLocation?.rationales[0].risks.length, 1);
    assert.equal(explainedTrace.trace.submission.claims[0].criteria[0].criterion_id, explained.criterion_id);
    assert.equal(explainedTrace.trace.submission.claims[0].criteria[0].evidence[0].type, "command");

    // A context line sits inside the hunk's broad range but did not itself
    // change. It must not inherit the surrounding hunk's rationale.
    const contextTrace = await review([explained.candidate.candidate_id, "--at", `${orderPath}:41`]);
    assert.equal(contextTrace.trace.location?.match, "file");
    assert.equal(contextTrace.trace.location?.line_status, "context");
    assert.deepEqual(contextTrace.trace.location?.change_units, []);
    assert.deepEqual(contextTrace.trace.location?.rationales, []);
    assert.equal(contextTrace.trace.location?.rationale_coverage.status, "not_applicable");
    assert.equal(contextTrace.trace.location?.rationale_coverage.reason, "line_is_unchanged_context");

    // A path match is not a line match: line 99 belongs to the changed file,
    // but it is outside every changed hunk and has no line-specific rationale.
    const outsideTrace = await review([explained.candidate.candidate_id, "--at", `${orderPath}:99`]);
    assert.equal(outsideTrace.trace.location?.match, "file");
    assert.equal(outsideTrace.trace.location?.line_status, "outside_hunks");
    assert.equal(outsideTrace.trace.location?.change_units.length, 0);
    assert.equal(outsideTrace.trace.location?.rationale_coverage.status, "not_applicable");
    assert.equal(outsideTrace.trace.location?.rationale_coverage.reason, "line_is_outside_changed_ranges");

    // “Was it verified?” must see the complete historical set, not only the
    // latest report; contradictory reports remain a disputed standing.
    assert.equal(explainedTrace.trace.verification_set.complete, true);
    assert.equal(explainedTrace.trace.verification_set.count, 2);
    assert.deepEqual(
      explainedTrace.trace.verification_set.verifications.map((item) => item.overall_verdict).sort(),
      ["qualified", "rejected"],
    );
    assert.equal(explainedTrace.trace.verification_set.standing, "disputed");

    // A Candidate-wide question has no location and therefore cannot be
    // rendered as a line-specific explanation.
    const wholeTrace = await review([explained.candidate.candidate_id]);
    assert.equal(wholeTrace.trace.location, undefined);
    assert.equal(wholeTrace.trace.explanation_coverage.explained_change_units, 1);
    assert.equal(wholeTrace.trace.contract.requirement.outcomes.length, 1);
    assert.deepEqual(wholeTrace.trace.contract.issue.goals[0].traces_to, [{ type: "outcome", ordinal: 1 }]);

    // Historical v1 is a real explanation gap: the global submission text is
    // not allowed to answer a line-specific “why?” question.
    const legacyPath = "src/legacy.ts";
    const legacyFiles: CandidateFile[] = [{
      path_bytes: Buffer.from(legacyPath).toString("base64"),
      display_path: legacyPath,
      change: "modified",
      old_mode: "100644",
      new_mode: "100644",
    }];
    const legacyPatch = Buffer.from([
      `diff --git a/${legacyPath} b/${legacyPath}`,
      "index 1111111..2222222 100644",
      `--- a/${legacyPath}`,
      `+++ b/${legacyPath}`,
      "@@ -7,2 +7,2 @@ function legacyPath() {",
      " const value = load();",
      "-return value;",
      "+return normalize(value);",
      "",
    ].join("\n"));
    const legacyIssue = await fixture.module.createIssue({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      requirement_id: fixture.requirement.requirement_id,
      requirement_revision_id: fixture.requirement.requirement_revision_id,
      requirement_revision_explicit: true,
      repository_id: fixture.repository.repository_id,
      baseline: testBaseline,
      input: {
        format: 1,
        summary: "Historical issue without an Intent Link",
        goals: [{ statement: "Change legacy behavior", criteria: ["The legacy behavior changes"] }],
      },
    });
    const legacy = await fixture.submitCandidate(
      "legacy",
      legacyFiles,
      [],
      false,
      legacyPatch,
      legacyIssue.result,
    );
    const legacyTrace = await review([legacy.candidate.candidate_id, "--at", `${legacyPath}:8`]);
    assert.equal(legacyTrace.trace.submission.format, "patchledger.candidate-submission/v1");
    assert.equal(legacyTrace.trace.location?.rationales.length, 0);
    assert.equal(legacyTrace.trace.location?.rationale_coverage.status, "not_recorded");
    assert.equal(legacyTrace.trace.explanation_coverage.status, "not_recorded");
    assert.equal(legacyTrace.trace.contract.issue.goals[0].traces_to, undefined);

    // A Candidate with no Verification must not be described as accepted or
    // rejected merely because its author supplied a Claim.
    const unverified = await fixture.submitCandidate("unverified", undefined, [], true);
    const unverifiedTrace = await review([unverified.candidate.candidate_id]);
    assert.equal(unverifiedTrace.trace.verification_set.complete, true);
    assert.equal(unverifiedTrace.trace.verification_set.count, 0);
    assert.equal(unverifiedTrace.trace.verification_set.standing, "unverified");
    assert.deepEqual(unverifiedTrace.trace.verification_set.verifications, []);

    // Old-side lookup is required for a question about a deleted or renamed
    // line; asking for the new side with the old path must not cross the seam.
    const oldPath = "src/old-name.ts";
    const newPath = "src/new-name.ts";
    const renamedFiles: CandidateFile[] = [{
      path_bytes: Buffer.from(newPath).toString("base64"),
      display_path: newPath,
      change: "renamed",
      old_path_bytes: Buffer.from(oldPath).toString("base64"),
      old_mode: "100644",
      new_mode: "100644",
    }];
    const renamedPatch = Buffer.from([
      `diff --git a/${oldPath} b/${newPath}`,
      "similarity index 80%",
      `rename from ${oldPath}`,
      `rename to ${newPath}`,
      "index 1111111..2222222 100644",
      `--- a/${oldPath}`,
      `+++ b/${newPath}`,
      "@@ -3 +3 @@",
      "-return oldValue;",
      "+return newValue;",
      "",
    ].join("\n"));
    const renamed = await fixture.submitCandidate("renamed", renamedFiles, [], true, renamedPatch);
    const oldSide = await review([renamed.candidate.candidate_id, "--at", `${oldPath}:3`, "--side", "old"]);
    assert.equal(oldSide.trace.location?.match, "change_unit");
    assert.equal(oldSide.trace.location?.line_status, "deleted");
    assert.equal(oldSide.trace.location?.file?.display_path, newPath);
    const wrongSide = await review([renamed.candidate.candidate_id, "--at", `${oldPath}:3`]);
    assert.equal(wrongSide.trace.location?.match, "none");
  } finally {
    if (fixture) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
