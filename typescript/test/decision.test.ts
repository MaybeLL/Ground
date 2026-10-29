import { backends, backendSkip, openLedger } from "./backends.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { decodeRequirement, validateDecision, type Decision, type RequirementInput } from "../src/domain.js";
import { parseRequirementMarkdown, renderRequirementMarkdown } from "../src/workspace-markdown.js";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";
import { Module } from "../src/module.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent, testBaseline, testVerifier } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";
import { renderReviewTrace, renderReviewMarkdown } from "../src/review.js";
import { createVerificationHandoff, verifyVerificationHandoff } from "../src/verification-handoff.js";
import { blindContextDigestFor } from "../src/projections.js";

const structuredDecision: Decision = {
  statement: "Use gRPC", rationale: "Contract consistency", context: "Several internal services",
  options: [
    { key: "rest", description: "HTTP JSON", benefits: ["Easy inspection"], costs: ["Maintain types separately"] },
    { key: "grpc", description: "Protobuf", benefits: ["Generated clients"], costs: ["Learn the tooling"] },
  ], chosen_option: "grpc",
  trade_offs: [{ gain: "Typed clients", sacrifice: "Extra tooling", reason: "Reduce interface drift" }],
  consequences: [{ kind: "obligation", statement: "Maintain compatibility rules" }, { kind: "risk", statement: "Breaking protocol changes affect callers" }],
};
const input = (decision: Decision = structuredDecision): RequirementInput => ({ format: 1, summary: "Service communication", outcomes: ["Consistent interfaces"], decisions: [structuredClone(decision)] });

test("Decision authoring supports optional details and rejects invalid nested values", () => {
  for (const decision of [structuredDecision, { statement: "Keep it simple" }, { statement: "Keep it simple", rationale: "" }, { statement: "Accept risk", consequences: [], trade_offs: [] }, { statement: "Choose", options: [{ key: "only", description: "Only known option" }], chosen_option: "only" }] as Decision[]) {
    validateDecision(decision);
    assertContract("requirement.schema.json", input(decision));
    assert.deepEqual(decodeRequirement(Buffer.from(stringify(input(decision)))), input(decision));
    assert.deepEqual(parseRequirementMarkdown(renderRequirementMarkdown(input(decision))).input, input(decision));
  }
  const invalid = [
    { ...structuredDecision, options: [] }, { ...structuredDecision, chosen_option: undefined },
    { ...structuredDecision, chosen_option: "missing" }, { statement: "Missing options", chosen_option: "grpc" },
    { ...structuredDecision, options: [structuredDecision.options![0], structuredDecision.options![0]] },
    { ...structuredDecision, options: [{ key: "BAD", description: "bad key" }] },
    { ...structuredDecision, options: [{ key: "a".repeat(65), description: "long key" }] },
    { ...structuredDecision, options: [{ key: "grpc", description: "x", unknown: true }] },
    { ...structuredDecision, trade_offs: [{ gain: "x", sacrifice: "y" }] },
    { ...structuredDecision, consequences: [{ kind: "completed", statement: "No" }] },
    { ...structuredDecision, consequences: [{ kind: "risk", statement: "No", extra: true }] },
    { ...structuredDecision, context: "x".repeat(16385) },
    { ...structuredDecision, trade_offs: Array(101).fill(structuredDecision.trade_offs![0]) },
    { ...structuredDecision, options: [{ key: "grpc", description: "x", benefits: [42] }] },
    { ...structuredDecision, unknown: "reject" }, { ...structuredDecision, consequences: null },
  ];
  for (const decision of invalid) assert.throws(() => validateDecision(decision as Decision));
  assert.throws(() => assertContract("requirement.schema.json", input({ ...structuredDecision, chosen_option: undefined })));
});

test("Decision Markdown preserves fenced YAML text and rejects ambiguous Details", () => {
  const requirement = input();
  requirement.decisions![0].trade_offs![0].reason = "Intro\n## Outcomes\n### [decision-2] literal\n#### Rationale\n<!-- keep this -->\n```\n<<<<<<< literal\n";
  requirement.decisions![0].context = "Local context <!-- preserve -->\n```text\n## Decisions\n#### Details\n```";
  const markdown = renderRequirementMarkdown(requirement);
  assert.deepEqual(parseRequirementMarkdown(markdown).input, requirement);
  for (const details of ["plain text", "```yaml\noptions: []\n```\nextra", "```yaml\ncontext: misplaced\n```", "```yaml\nchosen_option: a\nchosen_option: b\n```", "```yaml\ntrade_offs: []\n```\n```yaml\nconsequences: []\n```", "<!-- not a YAML block -->", "```yaml\nconsequences: []\n```\n<!-- extra body -->"]) {
    const doc = renderRequirementMarkdown(input({ statement: "Simple" })).replace("## Open Questions", `#### Details\n\n${details}\n\n## Open Questions`);
    assert.throws(() => parseRequirementMarkdown(doc));
  }
  const duplicate = renderRequirementMarkdown(input()).replace("#### Details", "#### Context\n\nDuplicate\n\n#### Details");
  assert.throws(() => parseRequirementMarkdown(duplicate));
});

const mysqlEnabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every((key) => Boolean(process.env[`GROUNDS_TEST_MYSQL_${key}`]));
for (const backend of backends) test(`${backend}: Decision survives publication, historical contexts, review and verification`, { skip: backendSkip(backend) }, async () => {
  const fixture = await openLedger(backend);
  try {
    const command = { operation_id: newUUIDv7(), attribution: testAgent, input: input() };
    const created = await fixture.module.createRequirement(command);
    assert.deepEqual(await fixture.module.createRequirement(command), created);
    await assert.rejects(fixture.module.createRequirement({ ...command, input: input({ ...structuredDecision, context: "Changed" }) }), { code: "IDEMPOTENCY_CONFLICT" });
    const rid = created.result.requirement_id, version = created.result.requirement_revision_id;
    const shown = await fixture.module.showRequirement(rid);
    assert.deepEqual(shown.requirement.decisions, [structuredDecision]);
    assertContract("query-results.schema.json", shown);
    const issue = await fixture.module.createIssue({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: rid, requirement_revision_id: version, requirement_revision_explicit: true, repository_id: fixture.repository.repository_id, baseline: testBaseline, input: { format: 1, summary: "Implement", goals: [{ statement: "Generate client", criteria: ["Client builds"], traces_to: [{ type: "decision", ordinal: 1 }] }] } });
    const candidate = await fixture.submitCandidate("decision", undefined, [], false, undefined, issue.result);
    assert.deepEqual(candidate.run.context.requirement.decisions, [structuredDecision]);
    const before = await fixture.module.verificationContext(candidate.candidate.candidate_id, "blind");
    assert.deepEqual(before.context.requirement.decisions, [structuredDecision]);
    assertContract("verification-context.schema.json", before.context);
    await fixture.module.reviseRequirement({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: rid, expected_predecessor_id: version, input: input({ statement: "Use REST" }) });
    assert.deepEqual((await fixture.module.verificationContext(candidate.candidate.candidate_id, "blind")), before);
    const trace = await fixture.module.reviewCandidate(candidate.candidate.candidate_id);
    assertContract("query-results.schema.json", trace);
    for (const output of [renderReviewTrace(trace), renderReviewMarkdown(trace)]) {
      assert.match(output, /Maintain compatibility rules/); assert.match(output, /Reduce interface drift/); assert.match(output, /grpc.*chosen/);
    }
    // A plan-bearing Issue Version reaches BOTH review exports, under the same
    // non-normative notice the HTML page shows. The trace here carries no plan,
    // so the notice must be absent — proving the section is driven by input.
    assert.doesNotMatch(renderReviewMarkdown(trace), /方案说明/);
    assert.doesNotMatch(renderReviewTrace(trace), /方案说明/);
    const source = await fixture.store.read(async (tx) => ({
      candidate_id: candidate.candidate.candidate_id, repository_id: fixture.repository.repository_id,
      canonical_remote_at_submission: fixture.repository.canonical_remote,
      result_tree_oid: candidate.artifact.result_tree_oid, patch_digest: candidate.artifact.patch_digest,
      requirement_revision: await tx.getRequirementRevision(rid, version),
      issue_revision: await tx.getIssueRevisionById(issue.result.issue_revision_id),
      artifact: candidate.artifact, submission: candidate.submission,
    }));
    const digest = blindContextDigestFor(source);
    source.requirement_revision.decisions[0].context = "Changed context";
    assert.notEqual(blindContextDigestFor(source), digest);
    const template = await fixture.module.verificationReportTemplate(candidate.candidate.candidate_id);
    const handoff = createVerificationHandoff(template.report, testVerifier);
    assert.equal(verifyVerificationHandoff(handoff).report.blind_context_digest, before.context.blind_context_digest);
    await fixture.verify(candidate);
  } finally { await fixture.close(); }
});

test("schema 11 migration preserves legacy Decision bytes and rejects corrupted details", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-decision-"));
  const path = join(directory, "ledger.db");
  const store = SQLStore.sqlite(path);
  try {
    const fixture = await LedgerFixture.createWithStore(store);
    const legacyCandidate = await fixture.submitCandidate();
    const legacyBlind = await fixture.module.verificationContext(legacyCandidate.candidate.candidate_id, "blind");
    const module = fixture.module;
    const created = await module.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent, input: input({ statement: "Legacy", rationale: "Existing reason" }) });
    const rid = created.result.requirement_id;
    const before = await module.showRequirement(rid);
    const raw = new DatabaseSync(path);
    raw.exec(`ALTER TABLE requirement_decisions DROP COLUMN details_json; UPDATE schema_metadata SET schema_version = 11; DELETE FROM schema_migrations WHERE schema_version = ${SCHEMA_VERSION}`);
    await assert.rejects(module.showRequirement(rid), { code: "SCHEMA_INCOMPATIBLE" });
    // SQLite DDL and the metadata transition must roll back together on failure.
    // The trigger must fire on the version migrate() actually targets, so it
    // tracks SCHEMA_VERSION rather than a frozen number.
    raw.exec(`CREATE TRIGGER fail_decision_migration BEFORE UPDATE OF schema_version ON schema_metadata WHEN NEW.schema_version = ${SCHEMA_VERSION} BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
    await assert.rejects(store.migrate());
    assert.equal(raw.prepare("SELECT migration_state FROM schema_metadata").get()!.migration_state, "clean");
    assert.ok(!(raw.prepare("PRAGMA table_info(requirement_decisions)").all() as { name: string }[]).some((column) => column.name === "details_json"));
    raw.exec("DROP TRIGGER fail_decision_migration");
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.deepEqual(await module.showRequirement(rid), before);
    assert.deepEqual(await module.verificationContext(legacyCandidate.candidate.candidate_id, "blind"), legacyBlind);
    await fixture.verify(legacyCandidate);
    assert.equal(raw.prepare("SELECT details_json FROM requirement_decisions").get()!.details_json, null);
    for (const broken of ["{bad", "null", "[]", '{"statement":"overwrite"}', '{"consequences":[{"kind":"bad","statement":"x"}]}']) {
      raw.prepare("UPDATE requirement_decisions SET details_json = ?").run(broken);
      await assert.rejects(module.showRequirement(rid), { code: "ARTIFACT_INTEGRITY_ERROR" });
    }
    raw.close();
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("MySQL schema 11 migration preserves Decisions and is repeatable", { skip: !mysqlEnabled }, async () => {
  const mysql = await import("mysql2/promise");
  const { readFileSync } = await import("node:fs");
  const name = `decision_migration_${newUUIDv7().replaceAll("-", "")}`;
  const connection = await mysql.createConnection({ host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306), user: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, ssl: { rejectUnauthorized: true, ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { ca: readFileSync(process.env.GROUNDS_TEST_MYSQL_CA_FILE) } : {}) } });
  let store: SQLStore | undefined;
  try {
    await connection.query(`CREATE DATABASE \`${name}\``);
    store = SQLStore.mysql({ host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306), database: name, username: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE } : {}) });
    await store.initialize("warn"); const module = new Module(store);
    const created = await module.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent, input: input({ statement: "Legacy", rationale: "Preserve history" }) });
    const before = await module.showRequirement(created.result.requirement_id);
    await connection.query(`ALTER TABLE \`${name}\`.requirement_decisions DROP COLUMN details_json`);
    await connection.query(`UPDATE \`${name}\`.schema_metadata SET schema_version = 11`);
    await connection.query(`DELETE FROM \`${name}\`.schema_migrations WHERE schema_version = ${SCHEMA_VERSION}`);
    await assert.rejects(store.open(), { code: "SCHEMA_INCOMPATIBLE" });
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
    assert.deepEqual(await module.showRequirement(created.result.requirement_id), before);
    await module.reviseRequirement({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: created.result.requirement_id, expected_predecessor_id: created.result.requirement_revision_id, input: input() });
    assert.deepEqual((await module.showRequirement(created.result.requirement_id)).requirement.decisions, [structuredDecision]);
    assert.equal((await store.inspectIntegrity()).report.valid, true);
  } finally { await store?.close(); await connection.query(`DROP DATABASE IF EXISTS \`${name}\``); await connection.end(); }
});

test("a plan-bearing Issue Version reaches both review exports under the non-normative notice", async () => {
  const fixture = await LedgerFixture.create();
  try {
    const PLAN = "PLANMARK 方案：先加列，再拆定义。";
    const created = await fixture.module.createIssue({
      operation_id: newUUIDv7(), attribution: testAgent,
      requirement_id: fixture.requirement.requirement_id,
      requirement_revision_id: fixture.requirement.requirement_revision_id,
      requirement_revision_explicit: true,
      repository_id: fixture.repository.repository_id,
      baseline: testBaseline,
      input: { format: 1, summary: "Implement", plan: PLAN, goals: [{ statement: "Deliver", criteria: ["Observable"], traces_to: [{ type: "outcome", ordinal: 1 }] }] },
    });
    const candidate = await fixture.submitCandidate("plan", undefined, [], false, undefined, created.result);
    // Both renderers take the whole review result (they read `result.trace`
    // internally), matching the existing call above.
    const review = await fixture.module.reviewCandidate(candidate.candidate.candidate_id);
    assert.equal((review.trace.contract.issue as { plan?: string }).plan, PLAN);
    for (const output of [renderReviewTrace(review), renderReviewMarkdown(review)]) {
      assert.match(output, /PLANMARK/, "plan text must appear in the export");
      assert.match(output, /方案说明（非约束）/, "the non-normative label must appear");
    }
  } finally {
    await fixture.close();
  }
});
