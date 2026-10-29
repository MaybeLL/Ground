import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLStore } from "../src/sql-store.js";
import { schemaStatements, SCHEMA_VERSION } from "../src/sql-schema.js";
import { sqliteDialect } from "../src/sql-dialects.js";
import { GIT_CANDIDATE_ARTIFACT_FORMAT, validateGitCommitArtifact, type GitCommitArtifact } from "../src/git-artifact-storage.js";
import { sha256Bytes } from "../src/canonical-json.js";
import { newUUIDv7 } from "../src/identity.js";
import { DomainError } from "../src/errors.js";
import { LedgerFixture, testAgent, testBaseline, testVerifier } from "./fixture.js";
import type { CandidateArtifact } from "../src/domain.js";

const source = { commit: `sha1:${"a".repeat(40)}`, parents: [testBaseline.git_oid] };
function metadata(candidate: string, repository: string, remote: string, tree: string): GitCommitArtifact {
  const binding = { repository_id: repository, canonical_remote: remote, archive_ref: `refs/tags/grounds/candidates/${candidate}`, source_commit: source.commit, ordered_parents: source.parents, result_tree: tree, base_commit: testBaseline.git_oid };
  return {
    format: GIT_CANDIDATE_ARTIFACT_FORMAT, generator_version: "grounds.canonical-git-diff/v1", binding,
    receipt: { format: "grounds.git-archive-observation/v1", status: "confirmed", observed_at: "2026-10-16T00:00:00.000Z", binding, remote_source_commit: source.commit, integrity: "complete", protection: {
      format: "grounds.archive-protection/v1", repository_id: repository, canonical_remote: remote, ref_namespace: "refs/tags/grounds/candidates/",
      source: { kind: "verified-deployment-config", locator: "deployment/policy", revision: "v1", verified_by: "test" },
      observed_at: "2026-10-15T00:00:00.000Z", valid_until: "2026-10-17T00:00:00.000Z", currently_applicable: true,
      archive_identity_can_create: true, ordinary_identity_cannot_update: true, ordinary_identity_cannot_delete: true, team_can_read_by_ref: true,
      repository_backup: "verified", database_backup: "verified",
    } },
  };
}
async function gitFixture(primary = true) {
  const directory = mkdtempSync(join(tmpdir(), "grounds-git-artifact-store-"));
  const path = join(directory, "ledger.db");
  const fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(path));
  const run = await fixture.module.startDevRun({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: fixture.issue.issue_id, issue_revision_id: fixture.issue.issue_revision_id, issue_revision_explicit: true, repository_remote_snapshot: fixture.repository.canonical_remote, development: { format: "grounds.development-branch/v1", workspace_id: newUUIDv7(), branch: "grounds/storage-test" } });
  const patch = Buffer.from("diff --git a/file b/file\n");
  const artifact: CandidateArtifact = { patch, patch_digest: sha256Bytes(patch), result_tree_oid: `sha1:${"b".repeat(40)}`, uncompressed_size: patch.length, files: [{ path_bytes: Buffer.from("file").toString("base64"), display_path: "file", change: "modified", old_mode: "100644", new_mode: "100644" }] };
  const candidateId = newUUIDv7();
  const git = metadata(candidateId, fixture.repository.repository_id, fixture.repository.canonical_remote, artifact.result_tree_oid);
  const goal = run.result.context.issue.goals[0]!;
  const result = await fixture.module.submitCandidate({ operation_id: newUUIDv7(), candidate_id: candidateId, ...(primary ? { git_artifact: git } : {}), dev_run_id: run.result.context.dev_run.id, expected_version: 1, attribution: testAgent, source, artifact, submission: { format: "patchledger.candidate-submission/v1", explanation: "Persist Git artifact", claims: [{ target_type: "goal", target_id: goal.id, explanation: "Implemented", criteria: goal.criteria.map(c => ({ criterion_id: c.id, explanation: "Implemented", evidence: [] })) }] } });
  return { fixture, path, directory, candidateId: result.candidate_id, artifact, git, close: async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const integrity = (error: unknown): boolean => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR";

test("Git artifact receipt preserves historical evidence and rejects incomplete or mismatched bindings", () => {
  const value = metadata(newUUIDv7(), newUUIDv7(), "ssh://git@example.test/team/repo", `sha1:${"b".repeat(40)}`);
  assert.doesNotThrow(() => validateGitCommitArtifact(value));
  for (const change of [(v: GitCommitArtifact) => { v.receipt.integrity = undefined; }, (v: GitCommitArtifact) => { v.receipt.status = "unknown"; }, (v: GitCommitArtifact) => { v.receipt.protection = undefined; }, (v: GitCommitArtifact) => { v.receipt.remote_source_commit = testBaseline.git_oid; }, (v: GitCommitArtifact) => { v.receipt.binding = { ...v.binding, base_commit: source.commit }; }]) {
    const copy = structuredClone(value); change(copy); assert.throws(() => validateGitCommitArtifact(copy), integrity);
  }
});

test("Git Candidates have no SQL patch dependency; metadata queries work without a local resolver", async () => {
  const f = await gitFixture();
  try {
    const database = new DatabaseSync(f.path);
    assert.equal((database.prepare("SELECT count(*) AS count FROM artifact_blobs").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT count(*) AS count FROM artifact_chunks").get() as { count: number }).count, 0);
    database.close();
    const ref = await f.fixture.store.read(tx => tx.findCandidateArtifactRef({ candidate_id: f.candidateId }));
    assert.equal(ref?.artifact_format, GIT_CANDIDATE_ARTIFACT_FORMAT);
    assert.deepEqual(ref?.git_artifact, f.git);
    await assert.rejects(f.fixture.store.read(tx => tx.getCandidate(f.candidateId)), integrity);
    f.fixture.store.setGitArtifactResolver(ref => { assert.equal(ref.source?.commit, source.commit); return f.artifact; });
    const stored = await f.fixture.store.read(tx => tx.getCandidate(f.candidateId));
    assert.deepEqual(stored.artifact.patch, f.artifact.patch);
    assert.deepEqual(stored.candidate.git_artifact, f.git);
    assert.deepEqual(stored.candidate.source, source);
    assert.equal((await f.fixture.store.inspectIntegrity()).report.valid, true);
    const context = await f.fixture.module.verificationContext(f.candidateId, "blind");
    const template = await f.fixture.module.verificationReportTemplate(f.candidateId);
    for (const target of template.report.assessments) for (const criterion of target.criteria) {
      criterion.independent = { verdict: "qualified", explanation: "Independent verification", evidence: [] };
      criterion.reconciliation = { claim_relation: "corroborated", explanation: "Consistent with independent evidence" };
      criterion.final = { verdict: "qualified", explanation: "Meets the Criterion" };
    }
    template.report.blind_context_digest = context.context.blind_context_digest;
    const verification = await f.fixture.module.submitVerification({ operation_id: newUUIDv7(), attribution: testVerifier, report: template.report });
    f.fixture.store.setGitArtifactResolver(() => { throw new Error("Metadata queries must not read Git objects"); });
    assert.equal((await f.fixture.module.listCandidates()).resources[0]?.resource_id, f.candidateId);
    assert.equal((await f.fixture.module.showVerification(verification.verification_id)).overall_verdict, "qualified");
    assert.equal((await f.fixture.module.listVerifications(f.candidateId)).resources[0]?.resource_id, verification.verification_id);
    const digest = stored.candidate.blind_context_digest;
    f.fixture.store.setGitArtifactResolver(() => ({ ...f.artifact, patch: Buffer.from("altered") }));
    await assert.rejects(f.fixture.store.read(tx => tx.getCandidate(f.candidateId)), integrity);
    f.fixture.store.setGitArtifactResolver(() => ({ ...f.artifact, files: [{ ...f.artifact.files[0]!, new_mode: "100755" }] }));
    await assert.rejects(f.fixture.store.read(tx => tx.getCandidate(f.candidateId)), integrity);
    f.fixture.store.setGitArtifactResolver(() => f.artifact);
    assert.equal((await f.fixture.store.read(tx => tx.getCandidate(f.candidateId))).candidate.blind_context_digest, digest);
    const reopened = SQLStore.sqlite(f.path);
    try {
      await reopened.open();
      assert.deepEqual((await reopened.read(tx => tx.findCandidateArtifactRef({ candidate_id: f.candidateId })))?.git_artifact, f.git);
      reopened.setGitArtifactResolver(() => f.artifact);
      assert.deepEqual((await reopened.read(tx => tx.getCandidate(f.candidateId))).artifact, f.artifact);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("Historical patch-only rows are unsupported at every use boundary and are never converted or deleted", async () => {
  const f = await gitFixture();
  try {
    f.fixture.store.setGitArtifactResolver(() => f.artifact);
    const template = await f.fixture.module.verificationReportTemplate(f.candidateId);
    for (const target of template.report.assessments) for (const criterion of target.criteria) {
      criterion.independent = { verdict: "qualified", explanation: "Independent result", evidence: [] };
      criterion.reconciliation = { claim_relation: "corroborated", explanation: "Matches" };
      criterion.final = { verdict: "qualified", explanation: "Meets criterion" };
    }
    const verification = await f.fixture.module.submitVerification({ operation_id: newUUIDv7(), attribution: testVerifier, report: template.report });
    await f.fixture.module.setSelection({ operation_id: newUUIDv7(), issue_id: f.fixture.issue.issue_id, issue_version: 1, candidate_id: f.candidateId, expected_version: 0, attribution: testAgent });
    const database = new DatabaseSync(f.path);
    database.prepare("UPDATE candidates SET artifact_format = ? WHERE id = ?").run("patchledger.git-full-index-binary-patch/v1", f.candidateId);
    const before = database.prepare("SELECT * FROM candidates WHERE id = ?").get(f.candidateId);
    const unsupported = (error: unknown) => error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT";
    await assert.rejects(f.fixture.store.read(tx => tx.readArtifact(f.artifact.patch_digest)), unsupported);
    await assert.rejects(f.fixture.store.write(tx => tx.putArtifact({ patch_digest: f.artifact.patch_digest, codec: "zlib", uncompressed_size: 0, compressed_size: 0, chunks: [] })), unsupported);
    await assert.rejects(f.fixture.store.read(tx => tx.getCandidate(f.candidateId)), unsupported);
    await assert.rejects(f.fixture.store.read(tx => tx.findCandidateArtifactRef({ candidate_id: f.candidateId })), unsupported);
    await assert.rejects(f.fixture.module.showCandidate(f.candidateId), unsupported);
    await assert.rejects(f.fixture.module.loadCandidateMaterialization(f.candidateId), unsupported);
    await assert.rejects(f.fixture.module.verificationContext(f.candidateId), unsupported);
    await assert.rejects(f.fixture.module.showVerification(verification.verification_id), unsupported);
    await assert.rejects(f.fixture.module.showSelection(f.fixture.issue.issue_id), unsupported);
    await assert.rejects(f.fixture.store.write(tx => tx.putCandidateGitArtifact(f.candidateId, f.git)), unsupported);
    assert.equal((await f.fixture.store.inspectIntegrity()).report.valid, true);
    assert.deepEqual(database.prepare("SELECT * FROM candidates WHERE id = ?").get(f.candidateId), before);
    database.close();
  } finally { await f.close(); }
});

test("Schema 22 network dialect migration removes only artifact coupling and is idempotent", async () => {
  const { migrateCandidateArtifacts } = await import("../src/sql-schema.js");
  const { mysqlDialect, postgresDialect } = await import("../src/sql-dialects.js");
  for (const dialect of [mysqlDialect, postgresDialect]) {
    const statements: string[] = [];
    let migrated = false;
    const client = {
      dialect,
      all: async (sql: string) => sql.includes("KEY_COLUMN_USAGE") || sql.includes("contype = 'f'")
        ? migrated ? [] : [{ name: "candidates_artifact_fk" }]
        : [{ name: "candidate_submission_format", definition: "CHECK (submission_format IN ('v1', 'v2'))" }, { name: migrated ? "grounds_candidate_artifact_format" : "candidate_artifact_format", definition: migrated ? "CHECK (artifact_format IN ('patchledger.git-full-index-binary-patch/v1', 'grounds.git-commit-artifact/v1'))" : "CHECK (artifact_format = 'patchledger.git-full-index-binary-patch/v1')" }],
      exec: async (sql: string) => { statements.push(sql); },
    } as unknown as import("../src/sql-client.js").SQLClient;
    await migrateCandidateArtifacts(client, dialect);
    assert.equal(statements.length, 3);
    assert.ok(statements[0]?.includes("candidates_artifact_fk"));
    assert.ok(statements[1]?.includes("candidate_artifact_format"));
    assert.ok(statements[2]?.includes("grounds.git-commit-artifact/v1"));
    assert.equal(statements.some(sql => sql.includes("candidate_submission_format")), false);
    migrated = true; statements.length = 0;
    await migrateCandidateArtifacts(client, dialect);
    assert.deepEqual(statements, []);
  }
});
