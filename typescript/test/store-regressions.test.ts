import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../src/errors.js";
import { Module } from "../src/module.js";
import { artifactChunks, SCHEMA_VERSION, SQLStore } from "../src/sql-store.js";
import { sha256Bytes } from "../src/canonical-json.js";
import type { EvidenceInput } from "../src/domain.js";
import { testAgent, testVerifier } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture } from "./fixture.js";
import { historicalBlindContextDigestFor } from "./blind-subject-history.js";
import { assertContract } from "./schema-fixture.js";

test("typed Evidence round trips through Candidate and Verification storage", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const evidence: EvidenceInput[] = [
      { type: "command", command: "npm test", exit_code: 0, output: "ok" },
      { type: "command", command: "@patchledger-evidence:artifact", exit_code: 0, output: "reserved-prefix command" },
      { type: "artifact", name: "screenshot.txt", media_type: "text/plain", content_base64: Buffer.from("artifact").toString("base64") },
      { type: "observation", statement: "The behavior was observed", attribution: testAgent },
      { type: "external_reference", url: "https://example.test/evidence", content_digest: sha256Bytes(Buffer.from("remote content")), title: "External result" },
    ];
    const candidate = await fixture.submitCandidate("typed", undefined, evidence);
    const shownCandidate = await fixture.module.showCandidate(candidate.candidate.candidate_id);
    assertContract("query-results.schema.json", shownCandidate);
    const storedCandidateEvidence = shownCandidate.candidate.claims[0].criteria[0].evidence;
    assert.deepEqual(storedCandidateEvidence.map((item) => item.type), evidence.map((item) => item.type));
    assert.ok(storedCandidateEvidence.every((item) => item.digest.startsWith("sha256:")));

    const context = await fixture.module.verificationContext(candidate.candidate.candidate_id, "blind");
    const report = await fixture.module.verificationReportTemplate(candidate.candidate.candidate_id);
    const assessment = report.report.assessments[0].criteria[0];
    assessment.independent = { verdict: "qualified", explanation: "Independent", evidence };
    assessment.reconciliation = { claim_relation: "corroborated", explanation: "Matches" };
    assessment.final = { verdict: "qualified", explanation: "Qualified" };
    const submitted = await fixture.module.submitVerification({ operation_id: newUUIDv7(), attribution: testVerifier, report: { ...report.report, blind_context_digest: context.context.blind_context_digest } });
    const shownVerification = await fixture.module.showVerification(submitted.verification_id);
    assertContract("query-results.schema.json", shownVerification);
    assert.deepEqual(shownVerification.report.assessments[0].criteria[0].independent.evidence, evidence);
  } finally { await fixture.close(); }
});

test("opening a database without schema metadata returns a schema error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "uninitialized.db");
  const store = SQLStore.sqlite(path);
  try {
    await assert.rejects(
      store.open(),
      (error: unknown) => error instanceof DomainError && error.code === "SCHEMA_INCOMPATIBLE" && error.details.actual_version_text === "missing schema_metadata table",
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupted schema metadata fails closed as schema incompatibility", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  const store = SQLStore.sqlite(path);
  try {
    await store.initialize("warn");
    await store.close();
    const database = new DatabaseSync(path);
    database.prepare("UPDATE schema_metadata SET database_id = 'not-a-uuid' WHERE singleton = 1").run();
    database.close();

    const reopened = SQLStore.sqlite(path);
    try {
      await assert.rejects(
        reopened.open(),
        (error: unknown) => error instanceof DomainError && error.code === "SCHEMA_INCOMPATIBLE",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema metadata with missing columns fails closed as schema incompatibility", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "malformed-schema.db");
  try {
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        database_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        minimum_cli_version TEXT NOT NULL,
        remote_normalization_version INTEGER NOT NULL,
        baseline_reachability_policy TEXT NOT NULL,
        migration_state TEXT NOT NULL
      );
      INSERT INTO schema_metadata VALUES
        (1, '019c0000-0000-7000-8000-000000000001', 7, '0.1.0', 1, 'warn', 'clean');
    `);
    database.close();

    const store = SQLStore.sqlite(path);
    try {
      await assert.rejects(
        store.open(),
        (error: unknown) => error instanceof DomainError && error.code === "SCHEMA_INCOMPATIBLE" && error.details.actual_version_text === "schema_metadata table has incompatible columns",
      );
    } finally {
      await store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("business commands distinguish a dirty migration from schema incompatibility", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  const initialized = SQLStore.sqlite(path);
  try {
    await initialized.initialize("warn");
    await initialized.close();
    const database = new DatabaseSync(path);
    database.prepare("UPDATE schema_metadata SET migration_state = 'dirty' WHERE singleton = 1").run();
    database.close();

    const reopened = SQLStore.sqlite(path);
    try {
      await assert.rejects(
        reopened.open(),
        (error: unknown) => error instanceof DomainError && error.code === "MIGRATION_DIRTY",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("db migrate refuses a dirty metadata gate until it is explicitly recovered", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  const store = SQLStore.sqlite(path);
  try {
    await store.initialize("warn");
    const database = new DatabaseSync(path);
    database.prepare("UPDATE schema_metadata SET migration_state = 'dirty' WHERE singleton = 1").run();
    database.close();

    await assert.rejects(
      store.migrate(),
      (error: unknown) => error instanceof DomainError && error.code === "MIGRATION_DIRTY",
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("db migrate creates missing legacy tables before applying additive columns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "legacy-v1.db");
  try {
    // The earliest schema only contained metadata.  Migration must create the
    // current tables before probing candidates/dev_runs for v5/v7 columns.
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        database_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        protocol_version INTEGER NOT NULL,
        minimum_cli_version TEXT NOT NULL,
        remote_normalization_version INTEGER NOT NULL,
        baseline_reachability_policy TEXT NOT NULL,
        migration_state TEXT NOT NULL
      );
      INSERT INTO schema_metadata VALUES
        (1, '019c0000-0000-7000-8000-000000000001', 1, 1, '0.1.0', 1, 'warn', 'clean');
    `);
    database.close();

    const store = SQLStore.sqlite(path);
    try {
      const metadata = await store.migrate();
      assert.equal(metadata.schema_version, SCHEMA_VERSION);
      assert.equal(metadata.migration_state, "clean");
      const check = new DatabaseSync(path);
      const tables = check.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('candidates', 'dev_runs', 'candidate_change_rationales', 'intent_links')").get() as { count: number };
      const candidateColumns = check.prepare("SELECT count(*) AS count FROM pragma_table_info('candidates') WHERE name = 'blind_context_digest'").get() as { count: number };
      const submissionFormatColumns = check.prepare("SELECT count(*) AS count FROM pragma_table_info('candidates') WHERE name = 'submission_format'").get() as { count: number };
      const devRunColumns = check.prepare("SELECT count(*) AS count FROM pragma_table_info('dev_runs') WHERE name = 'refines_candidate_id'").get() as { count: number };
      check.close();
      assert.equal(tables.count, 4);
      assert.equal(candidateColumns.count, 1);
      assert.equal(submissionFormatColumns.count, 1);
      assert.equal(devRunColumns.count, 1);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v8 Candidate rows migrate as CandidateSubmission v1 without invented rationales", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "legacy-v8.db");
  let fixture: LedgerFixture | undefined;
  try {
    fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(path));
    const submitted = await fixture.submitCandidate();
    const database = new DatabaseSync(path);
    database.exec(`
      DROP TABLE candidate_change_rationales;
      ALTER TABLE candidates DROP COLUMN submission_format;
      UPDATE schema_metadata SET schema_version = 8 WHERE singleton = 1;
    `);
    database.close();

    const metadata = await fixture.store.migrate();
    assert.equal(metadata.schema_version, SCHEMA_VERSION);
    const review = await fixture.module.reviewCandidate(submitted.candidate.candidate_id);
    assert.equal(review.trace.submission.format, "patchledger.candidate-submission/v1");
    assert.equal(review.trace.submission.change_rationales.length, 0);
    assert.equal(review.trace.explanation_coverage.status, "not_recorded");
  } finally {
    if (fixture) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v9 Issue rows migrate without inventing Intent Links or changing blind history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "legacy-v9.db");
  let fixture: LedgerFixture | undefined;
  try {
    fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(path));
    const legacy = new DatabaseSync(path);
    legacy.prepare("DELETE FROM intent_links WHERE issue_revision_id = ?").run(fixture.issue.issue_revision_id);
    legacy.close();
    const submitted = await fixture.submitCandidate();

    const beforeMigration = new DatabaseSync(path);
    beforeMigration.exec(`
      DROP TABLE intent_links;
      UPDATE schema_metadata SET schema_version = 9 WHERE singleton = 1;
    `);
    beforeMigration.close();

    const metadata = await fixture.store.migrate();
    assert.equal(metadata.schema_version, SCHEMA_VERSION);
    const review = await fixture.module.reviewCandidate(submitted.candidate.candidate_id);
    assert.equal(review.trace.contract.issue.goals[0].traces_to, undefined);
    assert.equal(review.trace.verification_set.complete, true);
  } finally {
    if (fixture) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupted persisted Change Rationales fail closed as artifact integrity errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "rationale-corruption.db");
  const fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(path));
  try {
    const submitted = await fixture.submitCandidate("one", undefined, [], true);
    const database = new DatabaseSync(path);
    database.prepare("UPDATE candidate_change_rationales SET rationale_json = ? WHERE candidate_id = ? AND ordinal = 0").run("{}", submitted.candidate.candidate_id);
    database.close();

    await assert.rejects(
      fixture.module.reviewCandidate(submitted.candidate.candidate_id),
      (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR",
    );
  } finally {
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Intent Links outside the bound Requirement Version fail closed as integrity errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-intent-link-corruption-"));
  const path = join(directory, "ledger.db");
  const fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(path));
  try {
    const database = new DatabaseSync(path);
    database.prepare("UPDATE intent_links SET intent_ordinal = 2 WHERE issue_revision_id = ?").run(fixture.issue.issue_revision_id);
    database.close();
    await assert.rejects(
      fixture.module.showIssue(fixture.issue.issue_id),
      (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR",
    );
  } finally {
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("init attaches to an existing ledger but refuses an unrelated non-empty database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  try {
    const ledgerPath = join(directory, "ledger.db");
    const ledger = SQLStore.sqlite(ledgerPath);
    const first = await ledger.initialize("warn");
    const second = await ledger.initialize("require_override");
    assert.equal(second.action, "attached");
    assert.equal(second.metadata.database_id, first.metadata.database_id);
    assert.equal(second.metadata.baseline_reachability_policy, "warn");
    await ledger.close();

    const unrelatedPath = join(directory, "unrelated.db");
    const database = new DatabaseSync(unrelatedPath);
    database.exec("CREATE TABLE user_data (id INTEGER PRIMARY KEY)");
    database.close();
    const unrelated = SQLStore.sqlite(unrelatedPath);
    try {
      await assert.rejects(
        unrelated.initialize("warn"),
        (error: unknown) => error instanceof DomainError && error.code === "SCHEMA_INCOMPATIBLE",
      );
    } finally {
      await unrelated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupted database timestamps fail with an integrity error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  try {
    const store = SQLStore.sqlite(path);
    await store.initialize("warn");
    await store.close();

    const database = new DatabaseSync(path);
    database.prepare("INSERT INTO repositories (id, canonical_remote, version, created_at, attribution_json) VALUES (?, ?, ?, ?, ?)").run("019c0000-0000-7000-8000-000000000001", "https://example.com/org/repo", 1, "not-a-timestamp", "{}");
    database.close();

    const reopened = SQLStore.sqlite(path);
    try {
      await assert.rejects(
        reopened.read((tx) => tx.listRepositories()),
        (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupted attribution fails closed instead of leaking an invalid shape", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  try {
    const store = SQLStore.sqlite(path);
    await store.initialize("warn");
    await store.close();

    const database = new DatabaseSync(path);
    database.prepare("INSERT INTO repositories (id, canonical_remote, version, created_at, attribution_json) VALUES (?, ?, ?, ?, ?)").run(
      "019c0000-0000-7000-8000-000000000001",
      "https://example.com/org/repo",
      1,
      "2026-01-01T00:00:00Z",
      JSON.stringify({ kind: "agent", agent_id: "agent", display_name: "Agent", unexpected: true }),
    );
    database.close();

    const reopened = SQLStore.sqlite(path);
    try {
      await assert.rejects(
        reopened.read((tx) => tx.listRepositories()),
        (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Candidate remote snapshots must remain bound to Repository aliases", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "candidate-remote.db");
  let store: SQLStore | undefined;
  try {
    store = SQLStore.sqlite(path);
    const fixture = await LedgerFixture.createWithStore(store, async () => undefined);
    const candidate = await fixture.submitCandidate();
    await store.close();

    const database = new DatabaseSync(path);
    const unrelatedRemote = "ssh://git@example.test/other/repository";
    database.prepare("UPDATE candidates SET repository_remote_snapshot = ? WHERE id = ?").run(unrelatedRemote, candidate.candidate.candidate_id);
    database.prepare("UPDATE dev_runs SET repository_remote_snapshot = ? WHERE id = ?").run(unrelatedRemote, candidate.candidate.dev_run_id);
    database.close();

    const reopened = SQLStore.sqlite(path);
    try {
      await assert.rejects(
        reopened.read((tx) => tx.getCandidate(candidate.candidate.candidate_id)),
        (error: unknown) => { assert.ok(error instanceof DomainError); assert.equal(error.code, "ARTIFACT_INTEGRITY_ERROR"); assert.equal(error.details.resource_id, candidate.candidate.candidate_id); assert.match(String(error.details.reason), /Candidate remote snapshot|immutable source, base, tree or archive identity/); return true; },
      );
    } finally {
      await reopened.close();
    }
  } finally {
    try { await store?.close(); } catch { /* the store may already be closed before direct SQL inspection */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupted verification assessments fail closed instead of producing an empty report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  const store = SQLStore.sqlite(path);
  try {
    const fixture = await LedgerFixture.createWithStore(store, async () => undefined);
    const candidate = await fixture.submitCandidate();
    const verification = await fixture.verify(candidate);
    await store.close();

    const database = new DatabaseSync(path);
    database.prepare("DELETE FROM verification_assessments WHERE verification_id = ?").run(verification.verification_id);
    database.close();

    const reopened = SQLStore.sqlite(path);
    try {
      await assert.rejects(
        reopened.read((tx) => tx.getVerification(verification.verification_id)),
        (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR" && error.details.resource_id === verification.verification_id,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupted verification target bindings fail closed instead of changing standings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  const store = SQLStore.sqlite(path);
  try {
    const fixture = await LedgerFixture.createWithStore(store, async () => undefined);
    const candidate = await fixture.submitCandidate();
    const verification = await fixture.verify(candidate);
    await store.close();

    const database = new DatabaseSync(path);
    database.prepare("UPDATE verification_assessments SET target_id = ? WHERE verification_id = ?").run(newUUIDv7(), verification.verification_id);
    database.close();

    const reopened = SQLStore.sqlite(path);
    try {
      await assert.rejects(
        reopened.read((tx) => tx.getVerification(verification.verification_id)),
        (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR" && error.details.resource_id === verification.verification_id,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retired SQL patch storage cannot create or decode artifacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-retired-artifact-"));
  const store = SQLStore.sqlite(join(directory,"ledger.db"));
  try {
    await store.initialize("warn");
    const patch = Buffer.from("diff --git a/file b/file\n"), chunks = artifactChunks(patch), digest = sha256Bytes(patch);
    await assert.rejects(store.write(tx => tx.putArtifact({patch_digest:digest,codec:"zlib",uncompressed_size:patch.length,compressed_size:chunks.reduce((n,b)=>n+b.length,0),chunks})), {code:"UNSUPPORTED_CANDIDATE_ARTIFACT"});
    await assert.rejects(store.read(tx => tx.readArtifact(digest)), {code:"UNSUPPORTED_CANDIDATE_ARTIFACT"});
  } finally { await store.close(); rmSync(directory,{recursive:true,force:true}); }
});

test("corrupted revision numbers fail closed instead of being rounded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  const requirementID = "019c0000-0000-7000-8000-000000000001";
  const revisionID = "019c0000-0000-7000-8000-000000000002";
  try {
    const store = SQLStore.sqlite(path);
    await store.initialize("warn");
    await store.close();

    const database = new DatabaseSync(path);
    database.prepare("INSERT INTO requirements (id, created_at, attribution_json) VALUES (?, ?, ?)").run(requirementID, "2026-01-01T00:00:00Z", "{}");
    database.prepare("INSERT INTO requirement_revisions (id, requirement_id, revision_number, summary, created_at, attribution_json) VALUES (?, ?, ?, ?, ?, ?)").run(revisionID, requirementID, 1, "summary", "2026-01-01T00:00:00Z", "{}");
    database.prepare("UPDATE requirement_revisions SET revision_number = '9007199254740992' WHERE id = ?").run(revisionID);
    database.close();

    const reopened = SQLStore.sqlite(path);
    try {
      await assert.rejects(
        reopened.read((tx) => tx.getRequirementRevision(requirementID, revisionID)),
        (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupted ledger facts fail closed instead of being coerced", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  const operationID = newUUIDv7();
  const eventID = newUUIDv7();
  try {
    const store = SQLStore.sqlite(path);
    await store.initialize("warn");
    await store.close();

    const database = new DatabaseSync(path);
    database.prepare("INSERT INTO idempotency_records (operation_id, command, request_hash, status, result_json, created_at) VALUES (?, ?, ?, 'completed', ?, ?)").run(operationID, "test", sha256Bytes(Buffer.from("test")), Buffer.from("{}"), "2026-01-01T00:00:00Z");
    database.prepare("INSERT INTO ledger_events (event_id, event_type, event_version, operation_id, subject_type, subject_id, occurred_at, attribution_json, facts_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(eventID, "test.event", 1, operationID, "requirement", newUUIDv7(), "2026-01-01T00:00:00Z", JSON.stringify({ kind: "agent", agent_id: "test-agent", display_name: "Test Agent" }), "null");
    database.close();

    const reopened = SQLStore.sqlite(path);
    try {
      await assert.rejects(
        reopened.read((tx) => tx.getLedgerEvent(eventID)),
        (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("superseded blind-subject payloads still verify stored Candidates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  let store: SQLStore | undefined;
  try {
    store = SQLStore.sqlite(path);
    const fixture = await LedgerFixture.createWithStore(store, async () => undefined);
    const candidate = await fixture.submitCandidate();
    // Rebuild the exact source the CLI verifies, so the historical digest covers
    // the same immutable facts as the stored current-payload digest.
    const source = await store.read(async (tx) => {
      const record = await tx.getCandidate(candidate.candidate.candidate_id);
      const issueRevision = await tx.getIssueRevisionById(record.candidate.issue_revision_id);
      const issue = await tx.getIssue(issueRevision.issue_id);
      return {
        candidate_id: record.candidate.id,
        repository_id: issue.repository_id,
        canonical_remote_at_submission: record.candidate.repository_remote_snapshot,
        result_tree_oid: record.candidate.result_tree_oid,
        patch_digest: record.candidate.patch_digest,
        requirement_revision: await tx.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id),
        issue_revision: issueRevision,
        artifact: record.artifact,
        submission: record.candidate.submission,
        stored_digest: record.candidate.blind_context_digest,
      };
    });
    const historical = historicalBlindContextDigestFor(source);
    assert.notEqual(historical, source.stored_digest);
    await store.close();
    store = undefined;

    const database = new DatabaseSync(path);
    database.prepare("UPDATE candidates SET blind_context_digest = ? WHERE id = ?").run(historical, candidate.candidate.candidate_id);
    database.close();

    const reopened = SQLStore.sqlite(path);
    fixture.installGitArtifactResolver(reopened);
    try {
      const record = await reopened.read((tx) => tx.getCandidate(candidate.candidate.candidate_id));
      assert.equal(record.candidate.blind_context_digest, historical);
      const context = await new Module(reopened).verificationContext(candidate.candidate.candidate_id, "blind");
      assert.equal(context.context.blind_context_digest, historical);
    } finally {
      await reopened.close();
    }
  } finally {
    try { await store?.close(); } catch { /* the store may already be closed before direct SQL inspection */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("digests matching no known payload revision still fail closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-store-test-"));
  const path = join(directory, "ledger.db");
  let store: SQLStore | undefined;
  try {
    store = SQLStore.sqlite(path);
    const fixture = await LedgerFixture.createWithStore(store, async () => undefined);
    const candidate = await fixture.submitCandidate();
    await store.close();
    store = undefined;

    const database = new DatabaseSync(path);
    database.prepare("UPDATE candidates SET blind_context_digest = ? WHERE id = ?").run(`sha256:${"0".repeat(64)}`, candidate.candidate.candidate_id);
    database.close();

    const reopened = SQLStore.sqlite(path);
    fixture.installGitArtifactResolver(reopened);
    try {
      await assert.rejects(
        reopened.read((tx) => tx.getCandidate(candidate.candidate.candidate_id)),
        (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR" && String(error.details.reason).includes("blind context digest"),
      );
    } finally {
      await reopened.close();
    }
  } finally {
    try { await store?.close(); } catch { /* the store may already be closed before direct SQL inspection */ }
    rmSync(directory, { recursive: true, force: true });
  }
});
