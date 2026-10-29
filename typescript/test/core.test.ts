import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalStringify } from "../src/canonical-json.js";
import { decodeIssue, decodeQuickstart, decodeRequirement } from "../src/domain.js";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";
import { normalizeRemote, validateCanonicalRemote } from "../src/git.js";
import { parseArgs } from "../src/cli.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";

test("canonical JSON sorts object keys deterministically", () => {
  assert.equal(canonicalStringify({ b: 2, a: 1 }), "{\"a\":1,\"b\":2}");
  assert.equal(canonicalStringify({ a: [true, null, "x"] }), "{\"a\":[true,null,\"x\"]}");
  assert.throws(() => canonicalStringify(1n), /bigint/);
  assert.throws(() => canonicalStringify("\ud800"), /surrogate/);
});

test("remote normalization strips HTTP credentials and parser keeps boolean flags", () => {
  assert.equal(normalizeRemote("https://user:token@Example.test/acme/ledger.git"), "https://example.test/acme/ledger");
  assert.throws(() => normalizeRemote("https://example.test/acme/%ZZ/ledger"), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
  assert.throws(() => validateCanonicalRemote("https://example.test/acme/%ZZ/ledger"), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
  assert.throws(() => normalizeRemote(null as unknown as string), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
  assert.throws(() => validateCanonicalRemote(null as unknown as string), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
  const parsed = parseArgs(["--json", "requirement", "list", "--config", "/tmp/config.yaml"]);
  assert.deepEqual(parsed.positionals, ["requirement", "list"]);
  assert.equal(parsed.values.json, true);
  assert.equal(parsed.values.config, "/tmp/config.yaml");
});

test("strict requirement YAML rejects unknown fields and null", () => {
  assert.throws(() => decodeRequirement(Buffer.from("format: 1\nsummary: x\noutcomes: [ok]\nunknown: nope\n")), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
  assert.throws(() => decodeRequirement(Buffer.from("format: 1\nsummary: x\noutcomes: [ok]\ncontext: null\n")), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
});

test("shape validation errors report the expected kind and the actual kind", () => {
  assert.throws(() => decodeRequirement(Buffer.from("format: 1\nsummary: x\noutcomes: notalist\n")), (error: unknown) => {
    assert.ok(error instanceof DomainError && error.code === "VALIDATION_ERROR");
    assert.match(String(error.details.reason), /must be an array, got a string/);
    return true;
  });
  assert.throws(() => decodeIssue(Buffer.from("format: 1\nsummary: x\ngoals: nope\n")), (error: unknown) => {
    assert.ok(error instanceof DomainError && error.code === "VALIDATION_ERROR");
    assert.match(String(error.details.reason), /must be an array, got a string/);
    return true;
  });
});

test("strict quickstart validation reports nested contract errors", () => {
  const valid = [
    "format: patchledger.quickstart/v1",
    "requirement:",
    "  format: 1",
    "  summary: r",
    "  outcomes: [o]",
    "issue:",
    "  format: 1",
    "  summary: i",
    "  goals:",
    "    - statement: g",
    "      criteria: [c]",
  ];
  assert.throws(() => decodeQuickstart(Buffer.from([...valid, "unknown: x"].join("\n"))), (error: unknown) => error instanceof DomainError && error.details.field === "file.unknown");
  assert.throws(() => decodeQuickstart(Buffer.from(valid.filter((line) => line.trim() !== "criteria: [c]").join("\n"))), (error: unknown) => error instanceof DomainError && String(error.details.field).startsWith("issue."));
  assert.throws(
    () => decodeQuickstart(Buffer.from(JSON.stringify({
      format: "patchledger.quickstart/v1",
      requirement: "wrong",
      issue: { format: 1, summary: "i", goals: [{ statement: "g", criteria: ["c"] }] },
    }))),
    (error: unknown) => error instanceof DomainError && String(error.details.field).startsWith("file.requirement"),
  );
});

test("a bare string containing ': ' is reported as a quoteable YAML mapping", () => {
  const parsed = Buffer.from("format: 1\nsummary: x\noutcomes:\n  - first\n  - non-destructive: repeat runs succeed\n");
  assert.throws(() => decodeRequirement(parsed), (error: unknown) => {
    assert.ok(error instanceof DomainError && error.code === "VALIDATION_ERROR");
    assert.equal(error.details.field, "outcomes[1]");
    const reason = String(error.details.reason);
    assert.match(reason, /non-destructive/);
    assert.match(reason, /": "/);
    assert.match(reason, /quote/);
    return true;
  });
});

test("SQLite module completes Requirement → Issue → DevRun → Candidate → Verification", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const operation = newUUIDv7();
    const input = { format: 1 as const, summary: "Another requirement", outcomes: ["Replay is stable"] };
    const first = await fixture.module.createRequirement({ operation_id: operation, attribution: testAgent, input });
    const replay = await fixture.module.createRequirement({ operation_id: operation, attribution: testAgent, input });
    assert.equal(replay.result.requirement_id, first.result.requirement_id);

    const candidate = await fixture.submitCandidate();
    const verification = await fixture.verify(candidate);
    assert.equal(verification.overall_verdict, "qualified");
    assert.equal((await fixture.module.showCandidate(candidate.candidate.candidate_id)).candidate.standing, "qualified");
    const listed = await fixture.module.listCandidates(fixture.issue.issue_revision_id);
    assert.equal(listed.resources[0].label, "Candidate: Implemented one");
  } finally { await fixture.close(); }
});

test("candidate and verification templates emit contract-valid skeletons", async () => {
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
    const runId = run.result.context.dev_run.id;

    const submission = await fixture.module.candidateSubmissionTemplate(runId);
    assert.equal(submission.command, "candidate.template");
    assert.equal(submission.submission.format, "patchledger.candidate-submission/v1");
    assert.equal(submission.submission.claims.length, 1);
    assert.equal(submission.submission.claims[0].target_type, "goal");
    assert.equal(submission.submission.claims[0].explanation, "");
    assertContract("command-results.schema.json", submission);

    const candidate = await fixture.submitCandidate();
    const report = await fixture.module.verificationReportTemplate(candidate.candidate.candidate_id);
    assert.equal(report.command, "verification.template");
    assert.equal(report.report.format, "patchledger.verification-report/v1");
    assert.equal(report.report.assessments.length, 1);
    assert.equal(report.report.assessments[0].criteria[0].independent.verdict, "inconclusive");
    assertContract("command-results.schema.json", report);
  } finally { await fixture.close(); }
});

test("issue board exposes the next resumable workflow action", async () => {
  const fixture = await LedgerFixture.create();
  try {
    assert.equal((await fixture.module.showIssue(fixture.issue.issue_id)).board.next_action, "start_devrun");
    await fixture.module.startDevRun({
      operation_id: newUUIDv7(), attribution: testAgent,
      issue_id: fixture.issue.issue_id, issue_revision_id: fixture.issue.issue_revision_id,
      issue_revision_explicit: false, repository_remote_snapshot: fixture.repository.canonical_remote,
    });
    assert.equal((await fixture.module.showIssue(fixture.issue.issue_id)).board.next_action, "resume_devrun");
    await fixture.submitCandidate();
    assert.equal((await fixture.module.showIssue(fixture.issue.issue_id)).board.next_action, "review_candidates");
  } finally { await fixture.close(); }
});

test("a Candidate developer cannot verify their own Candidate", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const candidate = await fixture.submitCandidate();
    const context = await fixture.module.verificationContext(candidate.candidate.candidate_id, "blind");
    const report = {
      format: "patchledger.verification-report/v1" as const,
      candidate_id: candidate.candidate.candidate_id,
      result_tree_oid: candidate.artifact.result_tree_oid,
      blind_context_digest: context.context.blind_context_digest,
      assessments: [{
        target_type: "goal" as const,
        target_id: candidate.goal_id,
        criteria: [{
          criterion_id: candidate.criterion_id,
          independent: { verdict: "qualified" as const, explanation: "x", evidence: [] },
          reconciliation: { claim_relation: "corroborated" as const, explanation: "y" },
          final: { verdict: "qualified" as const, explanation: "z" },
        }],
      }],
    };
    await assert.rejects(
      fixture.module.submitVerification({ operation_id: newUUIDv7(), attribution: testAgent, report }),
      (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "attribution",
    );
  } finally { await fixture.close(); }
});
