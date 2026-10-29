import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../src/errors.js";
import { sha256Bytes } from "../src/canonical-json.js";
import { newUUIDv7 } from "../src/identity.js";
import type { CandidateArtifact } from "../src/domain.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";
import { indexCandidateChanges } from "../src/change-index.js";

test("Issue revision rejects a stale expected predecessor", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const input = { format: 1 as const, summary: "Revision", goals: [{ statement: "Goal", criteria: ["Criterion"] }] };
    await fixture.module.reviseIssue({
      operation_id: newUUIDv7(),
      issue_id: fixture.issue.issue_id,
      expected_predecessor_id: fixture.issue.issue_revision_id,
      requirement_revision_id: "",
      requirement_revision_explicit: false,
      baseline: testBaseline,
      input,
      attribution: testAgent,
    });
    await assert.rejects(
      fixture.module.reviseIssue({
        operation_id: newUUIDv7(),
        issue_id: fixture.issue.issue_id,
        expected_predecessor_id: fixture.issue.issue_revision_id,
        requirement_revision_id: "",
        requirement_revision_explicit: false,
        baseline: testBaseline,
        input,
        attribution: testAgent,
      }),
      (error: unknown) => error instanceof DomainError && error.code === "PREDECESSOR_CONFLICT",
    );
  } finally {
    await fixture.close();
  }
});

test("an operation ID cannot replay a different canonical request", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const operation = newUUIDv7();
    await fixture.module.createRequirement({
      operation_id: operation,
      attribution: testAgent,
      input: { format: 1, summary: "First request", outcomes: ["First"] },
    });
    await assert.rejects(
      fixture.module.createRequirement({
        operation_id: operation,
        attribution: testAgent,
        input: { format: 1, summary: "Different request", outcomes: ["Second"] },
      }),
      (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await fixture.close();
  }
});

test("malformed requirement cursors return validation errors", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const cursor = Buffer.from("null", "utf8").toString("base64url");
    await assert.rejects(
      fixture.module.showRequirement(fixture.requirement.requirement_id, "", cursor),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "issues_cursor",
    );
  } finally {
    await fixture.close();
  }
});

test("Issue creation rejects contracts that cannot produce a bounded DevRun context", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const statement = "x".repeat(4096);
    await assert.rejects(
      fixture.module.createIssue({
        operation_id: newUUIDv7(),
        attribution: testAgent,
        requirement_id: fixture.requirement.requirement_id,
        requirement_revision_id: fixture.requirement.requirement_revision_id,
        requirement_revision_explicit: true,
        repository_id: fixture.repository.repository_id,
        baseline: testBaseline,
        input: {
          format: 1,
          summary: "Oversized contract",
          goals: Array.from({ length: 45 }, () => ({
            statement: "Goal",
            criteria: Array.from({ length: 50 }, () => statement),
          })),
        },
      }),
      (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_TOO_LARGE",
    );
  } finally {
    await fixture.close();
  }
});

test("Issue constraints may omit the optional rationale", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const created = await fixture.module.createIssue({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      requirement_id: fixture.requirement.requirement_id,
      requirement_revision_id: fixture.requirement.requirement_revision_id,
      requirement_revision_explicit: true,
      repository_id: fixture.repository.repository_id,
      baseline: testBaseline,
      input: {
        format: 1,
        summary: "Constraint without rationale",
        goals: [{ statement: "Goal", criteria: ["Criterion"] }],
        constraints: [{ statement: "Constraint", criteria: ["Constraint criterion"] }],
      },
    });
    const detail = await fixture.module.showIssue(created.result.issue_id);
    assert.equal(detail.issue.constraints[0]?.rationale, undefined);
    const run = await fixture.module.startDevRun({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      issue_id: created.result.issue_id,
      issue_revision_id: created.result.issue_revision_id,
      issue_revision_explicit: true,
      repository_remote_snapshot: fixture.repository.canonical_remote,
    });
    assert.equal(run.result.context.issue.constraints[0]?.rationale, undefined);
  } finally {
    await fixture.close();
  }
});

test("Intent Links persist on the Issue Version and cannot escape its bound Requirement Version", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const detail = await fixture.module.showIssue(fixture.issue.issue_id);
    assert.deepEqual(detail.issue.goals[0].traces_to, [{ type: "outcome", ordinal: 1 }]);

    await assert.rejects(
      fixture.module.createIssue({
        operation_id: newUUIDv7(),
        attribution: testAgent,
        requirement_id: fixture.requirement.requirement_id,
        requirement_revision_id: fixture.requirement.requirement_revision_id,
        requirement_revision_explicit: true,
        repository_id: fixture.repository.repository_id,
        baseline: testBaseline,
        input: { format: 1, summary: "Bad outcome link", goals: [{ statement: "Goal", criteria: ["Criterion"], traces_to: [{ type: "outcome", ordinal: 2 }] }] },
      }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.field).endsWith("traces_to[0].ordinal"),
    );
    await assert.rejects(
      fixture.module.createIssue({
        operation_id: newUUIDv7(),
        attribution: testAgent,
        requirement_id: fixture.requirement.requirement_id,
        requirement_revision_id: fixture.requirement.requirement_revision_id,
        requirement_revision_explicit: true,
        repository_id: fixture.repository.repository_id,
        baseline: testBaseline,
        input: { format: 1, summary: "Bad decision link", goals: [{ statement: "Goal", criteria: ["Criterion"], traces_to: [{ type: "decision", ordinal: 1 }] }] },
      }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.field).endsWith("traces_to[0].ordinal"),
    );
  } finally {
    await fixture.close();
  }
});

test("replay treats malformed stored results as an integrity error", async () => {
  const operationID = newUUIDv7();
  const fakeStore = {
    read: async (callback: (tx: { getOperation: (id: string) => Promise<unknown> }) => Promise<unknown>) => callback({
      getOperation: async (id: string) => id === operationID
        ? { command: "candidate.submit", request_hash: "sha256:" + "a".repeat(64), result_json: "{" }
        : undefined,
    }),
  };
  const module = new (await import("../src/module.js")).Module(fakeStore as never);
  await assert.rejects(
    module.replayCandidateSubmit(operationID),
    (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR",
  );
});

test("DevRun optional text rejects lone UTF-16 surrogates", async () => {
  const fixture = await LedgerFixture.create();
  try {
    await assert.rejects(
      fixture.module.startDevRun({
        operation_id: newUUIDv7(),
        attribution: testAgent,
        issue_id: fixture.issue.issue_id,
        issue_revision_id: fixture.issue.issue_revision_id,
        issue_revision_explicit: false,
        repository_remote_snapshot: fixture.repository.canonical_remote,
        exploration_brief: "\ud800",
      }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "exploration_brief",
    );
  } finally {
    await fixture.close();
  }
});

test("Candidate submission rejects malformed artifact runtime values", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const run = await fixture.module.startDevRun({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      issue_id: fixture.issue.issue_id,
      issue_revision_id: fixture.issue.issue_revision_id,
      issue_revision_explicit: false,
      repository_remote_snapshot: fixture.repository.canonical_remote,
    });
    const goal = run.result.context.issue.goals[0];
    const criterion = goal.criteria[0];
    const patch = Buffer.from("diff --git a/file b/file\n");
    const artifact = {
      patch: "not-a-buffer",
      patch_digest: sha256Bytes(patch),
      result_tree_oid: "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      uncompressed_size: patch.length,
      files: [{ path_bytes: Buffer.from("file").toString("base64"), display_path: "file", change: "modified", old_mode: "100644", new_mode: "100644" }],
    };
    await assert.rejects(
      fixture.module.submitCandidate({
        ...fixture.gitCandidateFields(artifact as unknown as CandidateArtifact),
        operation_id: newUUIDv7(),
        attribution: testAgent,
        dev_run_id: run.result.context.dev_run.id,
        expected_version: 1,
        artifact: artifact as unknown as CandidateArtifact,
        submission: {
          format: "patchledger.candidate-submission/v1",
          explanation: "Malformed artifact",
          claims: [{ target_type: "goal", target_id: goal.id, explanation: "Done", criteria: [{ criterion_id: criterion.id, explanation: "Verified", evidence: [] }] }],
        },
      }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "patch",
    );
  } finally {
    await fixture.close();
  }
});

test("CandidateSubmission v2 hard-gates Change Index drift and incomplete rationale coverage", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const run = await fixture.module.startDevRun({
      operation_id: newUUIDv7(), attribution: testAgent,
      issue_id: fixture.issue.issue_id, issue_revision_id: fixture.issue.issue_revision_id, issue_revision_explicit: false,
      repository_remote_snapshot: fixture.repository.canonical_remote,
    });
    const goal = run.result.context.issue.goals[0];
    const criterion = goal.criteria[0];
    const patch = Buffer.from("diff --git a/a.ts b/a.ts\ndiff --git a/b.ts b/b.ts\n");
    const artifact: CandidateArtifact = {
      patch, patch_digest: sha256Bytes(patch), result_tree_oid: "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd", uncompressed_size: patch.length,
      files: ["a.ts", "b.ts"].map((path) => ({ path_bytes: Buffer.from(path).toString("base64"), display_path: path, change: "modified", old_mode: "100644", new_mode: "100644" })),
    };
    const changeIndex = indexCandidateChanges(artifact);
    const common = {
      explanation: "Implemented",
      claims: [{ target_type: "goal" as const, target_id: goal.id, explanation: "Done", criteria: [{ criterion_id: criterion.id, explanation: "Done", evidence: [] }] }],
    };
    const rationale = (changeRefs: string[]) => ({
      change_refs: changeRefs, relation: "implements" as const, target_refs: [{ type: "criterion" as const, id: criterion.id }],
      rationale: "The code implements the Criterion", alternatives: [], risks: [],
    });

    await assert.rejects(
      fixture.module.submitCandidate({
        ...fixture.gitCandidateFields(artifact as unknown as CandidateArtifact),
        operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: run.result.context.dev_run.id, expected_version: 1, artifact,
        submission: {
          format: "patchledger.candidate-submission/v2", ...common,
          change_index: { format: changeIndex.format, patch_digest: changeIndex.patch_digest, units_digest: "sha256:" + "0".repeat(64) },
          change_rationales: [rationale(changeIndex.change_units.map((unit) => unit.change_unit_id))],
        },
      }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.reason).includes("units_digest"),
    );
    await assert.rejects(
      fixture.module.submitCandidate({
        ...fixture.gitCandidateFields(artifact as unknown as CandidateArtifact),
        operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: run.result.context.dev_run.id, expected_version: 1, artifact,
        submission: {
          format: "patchledger.candidate-submission/v2", ...common,
          change_index: { format: changeIndex.format, patch_digest: changeIndex.patch_digest, units_digest: changeIndex.units_digest },
          change_rationales: [rationale([changeIndex.change_units[0].change_unit_id])],
        },
      }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.reason).includes("do not explain 1 Change Unit"),
    );
    assert.equal((await fixture.module.showDevRun(run.result.context.dev_run.id)).state, "open");
  } finally {
    await fixture.close();
  }
});

test("mutable commands reject concurrency versions outside the safe integer range", async () => {
  const fixture = await LedgerFixture.create();
  try {
    await assert.rejects(
      fixture.module.moveRepository({
        operation_id: newUUIDv7(),
        repository_id: fixture.repository.repository_id,
        expected_version: Number.MAX_SAFE_INTEGER + 1,
        canonical_remote: fixture.repository.canonical_remote,
        attribution: testAgent,
      }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "expected_version",
    );
  } finally {
    await fixture.close();
  }
});

test("refinement context stays frozen and reports are opt-in", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const parent = await fixture.submitCandidate();
    const firstVerification = await fixture.verify(parent, "qualified");
    const refinement = await fixture.module.startDevRun({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      issue_id: fixture.issue.issue_id,
      issue_revision_id: fixture.issue.issue_revision_id,
      issue_revision_explicit: false,
      repository_remote_snapshot: fixture.repository.canonical_remote,
      refines_candidate_id: parent.candidate.candidate_id,
    });
    const secondVerification = await fixture.verify(parent, "rejected");

    const defaultContext = await fixture.module.devRunContext(refinement.result.context.dev_run.id);
    assert.deepEqual(
      defaultContext.context.refinement?.frozen_verifications.map((item) => item.verification_id),
      [firstVerification.verification_id],
    );
    assert.deepEqual(defaultContext.context.refinement?.included_verification_reports, []);
    assert.equal(defaultContext.context.refinement?.standing_at_start, "qualified");

    const expanded = await fixture.module.devRunContext(
      refinement.result.context.dev_run.id,
      false,
      [firstVerification.verification_id],
    );
    assert.equal(expanded.context.refinement?.included_verification_reports.length, 1);

    await assert.rejects(
      fixture.module.devRunContext(
        refinement.result.context.dev_run.id,
        false,
        [secondVerification.verification_id],
      ),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR",
    );
  } finally {
    await fixture.close();
  }
});

test("Candidate availability takes priority over concurrent exploration", async () => {
  const fixture = await LedgerFixture.create();
  try {
    await fixture.submitCandidate();
    await fixture.module.startDevRun({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      issue_id: fixture.issue.issue_id,
      issue_revision_id: fixture.issue.issue_revision_id,
      issue_revision_explicit: false,
      repository_remote_snapshot: fixture.repository.canonical_remote,
    });
    assert.equal((await fixture.module.showIssue(fixture.issue.issue_id)).board.status, "candidates_available");
  } finally {
    await fixture.close();
  }
});

test("Verification contexts retain Candidate-time remote after Repository move", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const candidate = await fixture.submitCandidate();
    const before = await fixture.module.verificationContext(candidate.candidate.candidate_id, "blind");
    await fixture.module.moveRepository({
      operation_id: newUUIDv7(),
      repository_id: fixture.repository.repository_id,
      expected_version: 1,
      canonical_remote: "ssh://git@example.test/team/moved",
      attribution: testAgent,
    });
    const after = await fixture.module.verificationContext(candidate.candidate.candidate_id, "blind");
    assert.equal(after.context.blind_context_digest, before.context.blind_context_digest);
    assert.equal(after.context.phase, "blind");
    if (after.context.phase === "blind") {
      assert.equal(after.context.repository.canonical_remote_at_submission, fixture.repository.canonical_remote);
    }
  } finally {
    await fixture.close();
  }
});

test("public Ledger events use stable identities and hide internal Revision IDs", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const candidate = await fixture.submitCandidate();
    await fixture.verify(candidate);
    const events = (await fixture.module.listLedger()).events;
    const requirement = events.find((item) => item.event_type === "requirement.created");
    const issue = events.find((item) => item.event_type === "issue.created");
    const candidateEvent = events.find((item) => item.event_type === "candidate.submitted");
    const verification = events.find((item) => item.event_type === "verification.submitted");

    assert.equal(requirement?.subject_type, "requirement");
    assert.equal(requirement?.subject_id, fixture.requirement.requirement_id);
    assert.equal(requirement?.subject_version, 1);
    assert.equal(requirement?.repository_id, undefined);
    assert.equal(issue?.subject_type, "issue");
    assert.equal(issue?.subject_id, fixture.issue.issue_id);
    assert.equal(issue?.repository_id, fixture.repository.repository_id);
    assert.equal(candidateEvent?.subject_version, undefined);
    assert.equal(verification?.subject_version, undefined);
    assert.ok(Array.isArray(candidateEvent?.facts));
    assert.deepEqual(candidateEvent?.facts.map((fact) => fact.name), ["dev_run_id", "development_source", "patch_digest", "result_tree_oid"]);
    assert.deepEqual((await fixture.module.listLedger("", "", "requirement", fixture.requirement.requirement_id)).events.map((event) => event.event_type), ["requirement.created"]);
    assert.deepEqual((await fixture.module.listLedger("", "", "issue", fixture.issue.issue_id)).events.map((event) => event.event_type), ["issue.created"]);
  } finally {
    await fixture.close();
  }
});

test("Candidate manifest pagination is bounded and cursor-bound", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const files = Array.from({ length: 2001 }, (_, index) => ({
      path_bytes: Buffer.from(`file-${String(index).padStart(4, "0")}`).toString("base64"),
      display_path: `file-${String(index).padStart(4, "0")}`,
      change: "modified" as const,
      old_mode: "100644",
      new_mode: "100644",
    }));
    const submitted = await fixture.submitCandidate("paged", files);
    const first = await fixture.module.showCandidate(submitted.candidate.candidate_id);
    assert.equal(first.candidate.file_manifest.length, 2000);
    assert.equal(first.candidate.file_manifest_omitted, true);
    assert.ok(first.candidate.manifest_next_cursor);

    const second = await fixture.module.showCandidate(
      submitted.candidate.candidate_id,
      first.candidate.manifest_next_cursor,
    );
    assert.equal(second.candidate.file_manifest.length, 1);
    assert.equal(second.candidate.file_manifest_omitted, false);
    assert.equal(second.candidate.manifest_next_cursor, undefined);
  } finally {
    await fixture.close();
  }
});
