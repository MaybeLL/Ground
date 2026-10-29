import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateContextSource } from "../src/projections.js";
import {
  blindContextDigestFor,
  blindContextDigestMatches,
  blindSubjectFor,
  blindVerificationContextFor,
  issueVersionForContext,
  historicalBlindContextDigestFor,
  historicalBlindSubjectFor,
  reconcileVerificationContextFor,
} from "../src/projections.js";
import { historicalBlindContextDigestFor as frozenBlindContextDigestFor } from "./blind-subject-history.js";
import { newUUIDv7 } from "../src/identity.js";
import { sha256Bytes } from "../src/canonical-json.js";
import { testBaseline } from "./fixture.js";

const source = (): CandidateContextSource => {
  const requirementId = newUUIDv7();
  const requirementRevisionId = newUUIDv7();
  const issueId = newUUIDv7();
  const issueRevisionId = newUUIDv7();
  const goalId = newUUIDv7();
  const criterionId = newUUIDv7();
  const patch = Buffer.from("patch");
  return {
    candidate_id: newUUIDv7(),
    repository_id: newUUIDv7(),
    canonical_remote_at_submission: "ssh://git@example.test/team/repo",
    result_tree_oid: "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    patch_digest: sha256Bytes(patch),
    requirement_revision: {
      id: requirementRevisionId,
      requirement_id: requirementId,
      revision_number: 1,
      summary: "Requirement",
      outcomes: ["Outcome"],
      decisions: [],
    },
    issue_revision: {
      id: issueRevisionId,
      issue_id: issueId,
      requirement_id: requirementId,
      requirement_revision_id: requirementRevisionId,
      revision_number: 1,
      baseline: testBaseline,
      summary: "Issue",
      goals: [{ id: goalId, statement: "Goal", guidance: [], criteria: [{ id: criterionId, statement: "Criterion" }] }],
      constraints: [],
    },
    artifact: {
      patch,
      patch_digest: sha256Bytes(patch),
      result_tree_oid: "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      uncompressed_size: patch.length,
      files: [{
        path_bytes: Buffer.from("file").toString("base64"),
        display_path: "file",
        change: "modified",
        old_mode: "100644",
        new_mode: "100644",
      }],
    },
    submission: {
      format: "patchledger.candidate-submission/v1",
      explanation: "Implementation",
      claims: [{
        target_type: "goal",
        target_id: goalId,
        explanation: "Done",
        criteria: [{ criterion_id: criterionId, explanation: "Done", evidence: [] }],
      }],
    },
  };
};

test("blind subject contains immutable artifact identity and excludes display snapshots", () => {
  const candidate = source();
  const subject = blindSubjectFor(candidate);
  assert.equal(subject.candidate_id, candidate.candidate_id);
  assert.equal(subject.repository_id, candidate.repository_id);
  assert.equal(subject.patch_digest, candidate.patch_digest);
  assert.equal(subject.file_manifest[0].path_bytes, candidate.artifact.files[0].path_bytes);
  assert.equal("display_path" in subject.file_manifest[0], false);
  assert.equal("canonical_remote_at_submission" in subject, false);
  assert.equal("baseline" in subject.issue, false);
  assert.equal("requirement_revision_id" in subject.issue, false);
});

test("blind digest is stable across display changes but binds the Candidate artifact", () => {
  const candidate = source();
  const original = blindContextDigestFor(candidate);
  const displayOnly = {
    ...candidate,
    canonical_remote_at_submission: "ssh://git@new.example.test/team/repo",
    artifact: {
      ...candidate.artifact,
      files: candidate.artifact.files.map((file) => ({ ...file, display_path: "renamed-for-display" })),
    },
  };
  assert.equal(blindContextDigestFor(displayOnly), original);
  assert.notEqual(blindContextDigestFor({ ...candidate, candidate_id: newUUIDv7() }), original);
  assert.notEqual(blindContextDigestFor({ ...candidate, patch_digest: sha256Bytes(Buffer.from("other")) }), original);
});

test("blind and reconcile contexts expose disjoint phases", () => {
  const candidate = source();
  const blind_context_digest = blindContextDigestFor(candidate);
  const blind = blindVerificationContextFor({ ...candidate, blind_context_digest });
  const reconcile = reconcileVerificationContextFor({ ...candidate, blind_context_digest });
  assert.equal(blind.phase, "blind");
  assert.equal("claims" in blind, false);
  assert.equal(blind.repository.canonical_remote_at_submission, candidate.canonical_remote_at_submission);
  assert.equal(reconcile.phase, "reconcile");
  assert.equal("artifact" in reconcile, false);
  assert.equal(reconcile.claims.length, 1);
});

// Deterministic counterpart of `source()` so the payload revisions can be pinned
// to literal digests. Any edit here changes those golden values.
const stableSource = (): CandidateContextSource => {
  const id = (n: number) => `019c0000-0000-7000-8000-00000000000${n}`;
  const patch = Buffer.from("patch");
  return {
    candidate_id: id(1),
    repository_id: id(2),
    canonical_remote_at_submission: "ssh://git@example.test/team/repo",
    result_tree_oid: "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    patch_digest: sha256Bytes(patch),
    requirement_revision: {
      id: id(4),
      requirement_id: id(3),
      revision_number: 1,
      summary: "Requirement",
      outcomes: ["Outcome"],
      decisions: [{ statement: "Decision" }],
    },
    issue_revision: {
      id: id(6),
      issue_id: id(5),
      requirement_id: id(3),
      requirement_revision_id: id(4),
      revision_number: 1,
      baseline: { git_oid: "sha1:0123456789abcdef0123456789abcdef01234567", reachability: "unconfirmed" },
      summary: "Issue",
      goals: [{ id: id(7), statement: "Goal", guidance: [], criteria: [{ id: id(8), statement: "Criterion" }] }],
      constraints: [],
    },
    artifact: {
      patch,
      patch_digest: sha256Bytes(patch),
      result_tree_oid: "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      uncompressed_size: patch.length,
      files: [{ path_bytes: Buffer.from("file").toString("base64"), display_path: "file", change: "modified", old_mode: "100644", new_mode: "100644" }],
    },
    submission: {
      format: "patchledger.candidate-submission/v1",
      explanation: "Implementation",
      claims: [{ target_type: "goal", target_id: id(7), explanation: "Done", criteria: [{ criterion_id: id(8), explanation: "Done", evidence: [] }] }],
    },
  };
};

test("stored digests from the superseded payload revision stay verifiable", () => {
  const candidate = stableSource();
  // Literal goldens: the current payload and the payload that commit 81cb751 replaced.
  assert.equal(blindContextDigestFor(candidate), "sha256:77b4a043a585b9abfa77b238d1aae58e55afa3418dcf4cc587e1530856328338");
  assert.equal(historicalBlindContextDigestFor(candidate), "sha256:c33639d07ea97f96837354411c6122dec0970bef2a5ecb96677f60b69fa8d4d2");
  assert.equal(historicalBlindContextDigestFor(candidate), frozenBlindContextDigestFor(candidate));
});

test("digest verification accepts either payload revision and rejects anything else", () => {
  const candidate = stableSource();
  const current = blindContextDigestFor(candidate);
  const historical = historicalBlindContextDigestFor(candidate);
  assert.equal(blindContextDigestMatches(current, candidate), true);
  assert.equal(blindContextDigestMatches(historical, candidate), true);
  assert.equal(blindContextDigestMatches(`sha256:${"0".repeat(64)}`, candidate), false);
  // A display-only change keeps both revisions stable, so acceptance cannot hide tampering.
  const displayOnly = { ...candidate, artifact: { ...candidate.artifact, files: candidate.artifact.files.map((file) => ({ ...file, display_path: "renamed" })) } };
  assert.equal(blindContextDigestMatches(current, displayOnly), true);
  assert.equal(blindContextDigestMatches(current, { ...candidate, patch_digest: sha256Bytes(Buffer.from("other")) }), false);
  assert.equal(blindContextDigestMatches(historical, { ...candidate, patch_digest: sha256Bytes(Buffer.from("other")) }), false);
});

test("the historical payload revision binds the RequirementRevision and Issue binding", () => {
  const candidate = stableSource();
  const subject = historicalBlindSubjectFor(candidate);
  assert.equal(subject.requirement_revision.id, candidate.requirement_revision.id);
  assert.equal(subject.issue_revision.requirement_revision_id, candidate.requirement_revision.id);
  assert.equal(subject.issue_revision.revision_number, candidate.issue_revision.revision_number);
  assert.equal("baseline" in subject.issue_revision, false);
  assert.equal(subject.baseline_oid, candidate.issue_revision.baseline.git_oid);
});

test("plan reaches the public read model but never the blind subject", () => {
  const candidate = source();
  const plan = "方案：先加列，再拆 schema 定义。\n\n```mermaid\nflowchart TD\n  A-->B\n```";
  const withPlan = { ...candidate, issue_revision: { ...candidate.issue_revision, plan } };

  // Public projection carries it.
  assert.equal(issueVersionForContext(withPlan.issue_revision, withPlan.requirement_revision).plan, plan);

  // Blind projections never do.
  assert.equal("plan" in blindSubjectFor(withPlan).issue, false);
  assert.equal("plan" in blindVerificationContextFor(withPlan).issue, false);
});

test("plan does not move any digest: blind and hashable stay byte-identical", () => {
  const candidate = source();
  const plan = "作者方案：任意内容，包含 ```mermaid 代码块``` 与中文说明。";
  const withPlan = { ...candidate, issue_revision: { ...candidate.issue_revision, plan } };

  // A Candidate established before the change must still recompute to the same
  // digest, and adding a plan to a new Candidate must not move it either.
  assert.equal(blindContextDigestFor(withPlan), blindContextDigestFor(candidate));
  assert.equal(blindContextDigestMatches(blindContextDigestFor(candidate), withPlan), true);
});

test("plan is omitted, not nulled, when absent so no-plan output is unchanged", () => {
  const candidate = source();
  const projected = issueVersionForContext(candidate.issue_revision, candidate.requirement_revision);
  assert.equal("plan" in projected, false);
  // An empty or whitespace-only plan is absent, never an empty string.
  const empty = { ...candidate.issue_revision, plan: "" };
  assert.equal("plan" in issueVersionForContext(empty, candidate.requirement_revision), false);
});
