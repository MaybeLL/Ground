import { test } from "node:test";
import assert from "node:assert/strict";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";

const candidate = newUUIDv7(), repository = newUUIDv7(), operationId = newUUIDv7(), owner = newUUIDv7();
const oid = `sha1:${"a".repeat(40)}`, tree = `sha1:${"b".repeat(40)}`, at = "2026-10-16T04:00:00.000Z";
const binding = { repository_id: repository, canonical_remote: "ssh://git@example.test/team/repo", archive_ref: `refs/tags/grounds/candidates/${candidate}`, source_commit: oid, ordered_parents: [oid], result_tree: tree, base_commit: oid };
const protection = { format: "grounds.archive-protection/v1", repository_id: repository, canonical_remote: binding.canonical_remote, ref_namespace: "refs/tags/grounds/candidates/", source: { kind: "verified-deployment-config", locator: "deployment/settings", revision: "revision1", verified_by: "operator" }, observed_at: at, valid_until: "2026-10-17T00:00:00.000Z", currently_applicable: true, archive_identity_can_create: true, ordinary_identity_cannot_update: true, ordinary_identity_cannot_delete: true, team_can_read_by_ref: true, repository_backup: "unknown", database_backup: "unknown" };
const receipt = { format: "grounds.git-archive-observation/v1", status: "confirmed", observed_at: at, binding, remote_source_commit: oid, integrity: "complete", protection };
const artifact = { format: "grounds.git-commit-artifact/v1", generator_version: "grounds.canonical-git-diff/v1", binding, receipt };
const operationData = { format: "grounds.candidate-archive-operation/v1", purpose: "candidate_submit", operation_id: operationId, candidate_id: candidate, owner_id: owner, request_digest: `sha256:${"c".repeat(64)}`, binding, phase: "unknown", attribution: { kind: "human", git_name: "Reader", git_email: "reader@example.test" }, created_at: at, updated_at: at, reason: "push_unconfirmed" };
const operation = { id: operationId, kind: "runtime_operation", parent_id: owner, version: 1, data: operationData };

test("versioned archive outputs separate historical receipt, current observation and pending operation", () => {
  assertContract("candidate-archive.schema.json", artifact);
  const values = [
    { result_type: "grounds.result.candidate-archive-status/v1", command: "candidate.archive-status", candidate_id: candidate, artifact, remote_check: "observed", remote_observation: { format: receipt.format, observed_at: at, status: "missing", binding, reason: "remote_ref_absent" }, archive_history: [operationData] },
    { result_type: "grounds.result.candidate-archive-status/v1", command: "candidate.archive-status", candidate_id: candidate, remote_check: "not_requested", archive_history: [] },
    { result_type: "grounds.result.candidate-lineage/v1", command: "candidate.lineage", lineage: { candidate_id: candidate, successor_candidate_ids: [newUUIDv7(), newUUIDv7()], successors_omitted: false, initial_base_commit: oid } },
    { result_type: "grounds.result.candidate-archive-operation/v1", command: "candidate.archive-operation", operation },
    { result_type: "grounds.result.candidate-fetch/v1", command: "candidate.fetch", candidate_id: candidate, observation: receipt },
    { result_type: "grounds.result.candidate-restore/v1", command: "candidate.restore", candidate_id: candidate, observation: receipt, source_commit: oid, target_path: "/new/caller/path" },
    { result_type: "grounds.result.candidate-archive/v1", command: "candidate.archive", candidate_id: candidate, dry_run: true, eligible: false, reason: "source_history_not_recorded" },
    { result_type: "grounds.result.candidate-archive/v1", command: "candidate.archive", candidate_id: candidate, dry_run: true, eligible: true, binding },
    { result_type: "grounds.result.candidate-archive/v1", command: "candidate.archive", candidate_id: candidate, dry_run: false, eligible: true, artifact, operation },
  ];
  for (const value of values) assertContract("command-results.schema.json", value);
});

test("archive contracts reject unknown versions, movable refs and incomplete receipts", () => {
  assert.throws(() => assertContract("candidate-archive.schema.json", { ...artifact, format: "grounds.git-commit-artifact/v2" }));
  assert.throws(() => assertContract("candidate-archive.schema.json", { ...artifact, binding: { ...binding, archive_ref: "refs/heads/main" } }));
  assert.throws(() => assertContract("candidate-archive.schema.json", { ...artifact, receipt: { ...receipt, status: "unknown" } }));
  assert.throws(() => assertContract("candidate-archive.schema.json", { ...artifact, receipt: { ...receipt, protection: undefined } }));
  assert.throws(() => assertContract("candidate-archive.schema.json", { ...artifact, receipt: { ...receipt, protection: { ...protection, ordinary_identity_cannot_delete: false } } }));
  assert.throws(() => assertContract("command-results.schema.json", { result_type: "grounds.result.candidate-archive/v1", command: "candidate.archive", candidate_id: candidate, dry_run: false, eligible: true }));
});

test("target predecessor schema preserves old adoption records and distinguishes confirmed evidence", () => {
  const adoption = { format: "grounds.adoption-binding/v1", repository_id: repository, candidate_id: candidate, source_commit: oid, landed_commit: oid, target: { remote: "origin", ref: "refs/heads/main" }, method: "ff", source: { kind: "user_confirmation", reference: "reviewed target update" } };
  const adoptionSchema = "development-collaboration.schema.json#/$defs/adoptionBinding";
  const predecessorSchema = "integration.schema.json#/$defs/targetPredecessor";
  assertContract(adoptionSchema, adoption);
  assertContract(adoptionSchema, { ...adoption, target_predecessor: oid });
  assert.throws(() => assertContract(adoptionSchema, { ...adoption, target_predecessor: "main" }));
  for (const source of ["adoption_binding", "landing_first_parent"]) assertContract(predecessorSchema, { state: "confirmed", commit: { oid, parents: [], tree_oid: tree }, source });
  for (const state of ["unknown", "conflict"]) assertContract(predecessorSchema, { state, reason: "actual_target_predecessor_unknown" });
  assert.throws(() => assertContract(predecessorSchema, { state: "confirmed", source: "adoption_binding" }));
  assert.throws(() => assertContract(predecessorSchema, { state: "confirmed", commit: { oid, parents: [], tree_oid: tree }, source: "gate_target" }));
});

test("archive recovery errors expose the original operation identity through the CLI contract", () => {
  const envelope = { format: "patchledger.cli/v1", ok: false, operation_id: operationId,
    error: { code: "STATE_CONFLICT", message: "Archive remains unconfirmed", retryable: false,
      details: { operation_id: operationId, reason: "remote_ref_check_failed", phase: "unknown" } } };
  assertContract("cli-envelope.schema.json", envelope);
  assert.throws(() => assertContract("cli-envelope.schema.json", { ...envelope,
    error: { ...envelope.error, details: { operation_id: "arbitrary-path" } } }));
});
