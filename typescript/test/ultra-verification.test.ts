import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCLICandidate } from "./git-cli-ledger-fixture.js";
import { deriveLocalGitArtifact } from "../src/git-artifact-local.js";
import { execute, runCLI } from "../src/cli.js";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";
import type { Attribution, VerificationReportInput } from "../src/domain.js";
import {
  createQualityHandoff,
  independentDigestOfQuality,
  QUALITY_DIMENSIONS,
  validateQualityLocations,
  validateQualityReviewReport,
  verifyQualityHandoff,
  type QualityFinding,
  type QualityReviewReportInput,
  type Verdict,
} from "../src/quality-review.js";
import { createVerificationHandoff, independentDigestOfContract } from "../src/verification-handoff.js";
import { Module } from "../src/module.js";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";
import { LedgerFixture, testAgent, testVerifier, type CandidateFixture } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";
import { isolatedPostgres, postgresEnabled, rawConnection } from "./isolated-postgres.js";

type Backend = "sqlite" | "mysql" | "postgres";
const backendSkipped = (backend: Backend): boolean => backend === "mysql" ? !mysqlEnabled : backend === "postgres" ? !postgresEnabled : false;
const mysqlEnabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every((key) => Boolean(process.env[`GROUNDS_TEST_MYSQL_${key}`]));
const mysqlConnection = (database: string) => ({ host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306), database, username: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE } : {}) });

/** Ledger-level behaviour must hold on SQLite and on the dedicated MySQL and PostgreSQL test servers (skipped, and reported as skipped, when they are not configured).
 * Each MySQL run gets its own temporary database so the shared test database is left untouched. */
const backendTest = (name: string, run: (fixture: LedgerFixture) => Promise<void>): void => {
  for (const backend of ["sqlite", "mysql", "postgres"] as const) {
    test(`${backend}: ${name}`, { skip: backendSkipped(backend) }, async () => {
      await isolatedLedger(backend, async ({ store }) => {
        const fixture = await LedgerFixture.createWithStore(store, async () => undefined);
        try { await run(fixture); } finally { await store.close(); }
      });
    });
  }
};

const qualityReviewer: Attribution = { kind: "agent", agent_id: "test-quality-reviewer", display_name: "Test Quality Reviewer" };

const blocking = (path = "file-one"): QualityFinding => ({ severity: "blocking", explanation: "Duplicated branch makes the change hard to test", location: { path, line: 3 } });

/** Build a complete quality report where every dimension is qualified unless overridden. */
const qualityReport = async (fixture: LedgerFixture, candidate: CandidateFixture, overrides: Record<string, { verdict: Verdict; findings?: QualityFinding[] }> = {}): Promise<QualityReviewReportInput> => {
  const template = await fixture.module.verificationReportTemplate(candidate.candidate.candidate_id, undefined, "quality");
  const report = template.report as QualityReviewReportInput;
  for (const dimension of report.dimensions) {
    const override = overrides[dimension.dimension_id] ?? { verdict: "qualified" as Verdict };
    const findings = override.findings ?? [];
    dimension.independent = { verdict: override.verdict, explanation: `Blind judgement of ${dimension.dimension_id}`, findings, evidence: [] };
    dimension.reconciliation = { explanation: "Author explanation does not change the judgement" };
    dimension.final = { verdict: override.verdict, explanation: `Final judgement of ${dimension.dimension_id}`, findings };
  }
  return report;
};

const contractReport = async (fixture: LedgerFixture, candidate: CandidateFixture, verdict: Verdict = "qualified"): Promise<VerificationReportInput> => {
  const report = (await fixture.module.verificationReportTemplate(candidate.candidate.candidate_id)).report as VerificationReportInput;
  const criterion = report.assessments[0].criteria[0];
  criterion.independent = { verdict, explanation: "Independent contract result", evidence: [] };
  criterion.reconciliation = { claim_relation: "corroborated", explanation: "Compared with the claim" };
  criterion.final = { verdict, explanation: "Final contract result" };
  return report;
};

const submitUltra = async (fixture: LedgerFixture, candidate: CandidateFixture, quality: QualityReviewReportInput, contractVerdict: Verdict = "qualified", qualityAttribution: Attribution = qualityReviewer, contractAttribution: Attribution = testVerifier) =>
  fixture.module.submitVerification({ operation_id: newUUIDv7(), attribution: contractAttribution, report: await contractReport(fixture, candidate, contractVerdict), quality: { report: quality, attribution: qualityAttribution } });

backendTest("quality report validation covers every dimension and ties blocking findings to rejection", async (fixture) => {
  const candidate = await fixture.submitCandidate();
  const valid = await qualityReport(fixture, candidate);
  validateQualityReviewReport(valid);
  assertContract("quality-review-report.schema.json", valid);

  const field = (mutate: (report: QualityReviewReportInput) => void): string | undefined => {
    const copy = structuredClone(valid);
    mutate(copy);
    try { validateQualityReviewReport(copy); } catch (error) { return error instanceof DomainError ? String(error.details.field) : String(error); }
    return undefined;
  };
  assert.equal(field((report) => { report.dimensions.pop(); }), "dimensions");
  assert.equal(field((report) => { report.dimensions[1].dimension_id = report.dimensions[0].dimension_id; }), "dimensions[1].dimension_id");
  assert.equal(field((report) => { report.dimensions[0].dimension_id = "style"; }), "dimensions[0].dimension_id");
  assert.equal(field((report) => { report.rubric_version = "grounds.quality-rubric/v0"; }), "rubric_version");
  // A blocking finding forces rejection in the stage that records it.
  assert.equal(field((report) => { report.dimensions[0].independent.findings = [blocking()]; }), "dimensions[0].independent.verdict");
  assert.equal(field((report) => { report.dimensions[0].final.findings = [blocking()]; }), "dimensions[0].final.verdict");
  // Rejection without a blocking finding is refused.
  assert.equal(field((report) => { report.dimensions[2].final.verdict = "rejected"; }), "dimensions[2].final.verdict");
  // A blocking finding must carry a code location.
  assert.equal(field((report) => { report.dimensions[0].independent.findings = [{ severity: "blocking", explanation: "no location" }]; report.dimensions[0].independent.verdict = "rejected"; }), "dimensions[0].independent.findings[0].location");
  assert.equal(field((report) => { report.dimensions[0].independent.findings = Array.from({ length: 21 }, () => ({ severity: "non_blocking" as const, explanation: "note" })); }), "dimensions[0].independent.findings");

  const rejected = await qualityReport(fixture, candidate, { conciseness: { verdict: "rejected", findings: [blocking()] }, abstraction: { verdict: "inconclusive" } });
  validateQualityReviewReport(rejected);
  assertContract("quality-review-report.schema.json", rejected);
  // Non-blocking findings never reject.
  const advisory = await qualityReport(fixture, candidate, { readability: { verdict: "qualified", findings: [{ severity: "non_blocking", explanation: "Prefer a clearer name" }] } });
  validateQualityReviewReport(advisory);
  assert.equal(QUALITY_DIMENSIONS.length, 6);
});

backendTest("normal verification is unchanged and reads back as normal mode", async (fixture) => {
  const candidate = await fixture.submitCandidate();
  const submitted = await fixture.verify(candidate, "qualified");
  assert.equal(submitted.mode, "normal");
  const shown = await fixture.module.showVerification(submitted.verification_id);
  assert.equal(shown.mode, "normal");
  assert.equal(shown.quality, undefined);
  assertContract("query-results.schema.json", shown);
  const list = await fixture.module.listVerifications(candidate.candidate.candidate_id);
  assert.equal(list.resources[0].mode, "normal");
  assert.equal(list.resources[0].quality_verdict, undefined);
  const page = await fixture.module.verificationPage(candidate.candidate.candidate_id);
  assert.equal(page.verifications[0].mode, "normal");
  assertContract("query-results.schema.json", page);
});

backendTest("ultra verification stores both signed parts as one report and takes the most conservative verdict", async (fixture) => {
  const candidate = await fixture.submitCandidate();
  const qualified = await submitUltra(fixture, candidate, await qualityReport(fixture, candidate));
  assert.equal(qualified.mode, "ultra");
  assert.equal(qualified.overall_verdict, "qualified");
  assert.equal(qualified.standing, "qualified");
  assertContract("command-results.schema.json", qualified);

  const shown = await fixture.module.showVerification(qualified.verification_id);
  assert.equal(shown.mode, "ultra");
  assert.deepEqual(shown.attribution, testVerifier, "attribution keeps meaning the contract verifier");
  assert.deepEqual(shown.quality?.attribution, qualityReviewer);
  assert.equal(shown.quality?.overall_verdict, "qualified");
  assert.equal(shown.quality?.report.dimensions.length, 6);
  assertContract("query-results.schema.json", shown);

  // Contract qualified, quality rejected: the single ultra report is rejected.
  const second = await fixture.submitCandidate("two");
  const rejected = await submitUltra(fixture, second, await qualityReport(fixture, second, { testability: { verdict: "rejected", findings: [blocking("file-two")] } }));
  assert.equal(rejected.overall_verdict, "rejected");
  assert.equal(rejected.standing, "rejected");
  assert.equal((await fixture.module.showVerification(rejected.verification_id)).quality?.overall_verdict, "rejected");

  // Contract rejected, quality qualified: still rejected.
  const third = await fixture.submitCandidate("three");
  assert.equal((await submitUltra(fixture, third, await qualityReport(fixture, third), "rejected")).overall_verdict, "rejected");

  // Quality inconclusive keeps the report inconclusive rather than qualified.
  const fourth = await fixture.submitCandidate("four");
  assert.equal((await submitUltra(fixture, fourth, await qualityReport(fixture, fourth, { abstraction: { verdict: "inconclusive" } }))).overall_verdict, "inconclusive");

  const list = await fixture.module.listVerifications(second.candidate.candidate_id);
  assert.equal(list.resources[0].mode, "ultra");
  assert.equal(list.resources[0].quality_verdict, "rejected");
  assert.deepEqual(list.resources[0].quality_attribution, qualityReviewer);
  assertContract("command-results.schema.json", list);
  const page = await fixture.module.verificationPage(second.candidate.candidate_id);
  assert.equal(page.verifications[0].mode, "ultra");
  assert.equal(page.verifications[0].quality_verdict, "rejected");
  assertContract("query-results.schema.json", page);

  const review = await fixture.module.reviewCandidate(second.candidate.candidate_id, {});
  const entry = review.trace.verification_set.verifications[0];
  assert.equal(entry.mode, "ultra");
  assert.equal(entry.quality?.overall_verdict, "rejected");
  assertContract("query-results.schema.json", review);
});

backendTest("an ultra rejection beside an earlier normal pass makes the Candidate disputed", async (fixture) => {
  const candidate = await fixture.submitCandidate();
  assert.equal((await fixture.verify(candidate, "qualified")).standing, "qualified");
  const ultra = await submitUltra(fixture, candidate, await qualityReport(fixture, candidate, { conventions: { verdict: "rejected", findings: [blocking()] } }));
  assert.equal(ultra.standing, "disputed");
  const standings = await fixture.module.listCandidates(fixture.issue.issue_revision_id, { standing: "disputed" });
  assert.equal(standings.resources.length, 1);
});

backendTest("ultra submission rejects identity conflicts, mismatched bindings and foreign blocking locations without writing", async (fixture) => {
  const candidate = await fixture.submitCandidate();
  const count = async () => (await fixture.module.listVerifications(candidate.candidate.candidate_id)).resources.length;
  const field = async (action: () => Promise<unknown>): Promise<string> => {
    try { await action(); } catch (error) { if (error instanceof DomainError) return String(error.details.field); throw error; }
    return "accepted";
  };
  const good = await qualityReport(fixture, candidate);
  assert.equal(await field(() => submitUltra(fixture, candidate, good, "qualified", testAgent)), "quality.attribution", "quality reviewer is the developer");
  assert.equal(await field(() => submitUltra(fixture, candidate, good, "qualified", testVerifier)), "quality.attribution", "quality reviewer is the contract verifier");
  assert.equal(await field(() => submitUltra(fixture, candidate, good, "qualified", qualityReviewer, testAgent)), "attribution", "contract verifier is the developer");
  const wrongTree = structuredClone(good); wrongTree.result_tree_oid = `sha1:${"9".repeat(40)}`;
  assert.equal(await field(() => submitUltra(fixture, candidate, wrongTree)), "quality");
  const wrongDigest = structuredClone(good); wrongDigest.blind_context_digest = `sha256:${"8".repeat(64)}`;
  assert.equal(await field(() => submitUltra(fixture, candidate, wrongDigest)), "quality");
  const foreign = await qualityReport(fixture, candidate, { conciseness: { verdict: "rejected", findings: [blocking("src/not-changed.ts")] } });
  assert.equal(await field(() => submitUltra(fixture, candidate, foreign)), "quality.dimensions[0].independent.findings[0].location.path");
  assert.equal(await count(), 0, "failed ultra attempts leave no Verification behind");
  assert.equal((await fixture.module.listCandidates(fixture.issue.issue_revision_id, { standing: "unverified" })).resources.length, 1);
});

backendTest("ultra submission is idempotent per operation and conflicts on changed content", async (fixture) => {
  const candidate = await fixture.submitCandidate();
  const quality = await qualityReport(fixture, candidate);
  const contract = await contractReport(fixture, candidate);
  const operation = newUUIDv7();
  const submit = (report = quality) => fixture.module.submitVerification({ operation_id: operation, attribution: testVerifier, report: contract, quality: { report, attribution: qualityReviewer } });
  const first = await submit();
  assert.deepEqual(await submit(), first);
  const changed = structuredClone(quality); changed.dimensions[0].final.explanation = "Changed after the fact";
  await assert.rejects(() => submit(changed), (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal((await fixture.module.listVerifications(candidate.candidate.candidate_id)).resources.length, 1);
});

backendTest("the integrity inspection derives every stored verdict from both parts, including a rejection that only the quality part explains", async (fixture) => {
  const inspect = async () => (await fixture.store.inspectIntegrity()).report;
  const normal = await fixture.submitCandidate("normal");
  await fixture.verify(normal, "qualified");
  assert.equal((await inspect()).valid, true);

  // Contract qualified, quality rejected: the stored verdict is rejected only because of the quality part.
  const qualityRejects = await fixture.submitCandidate("quality-rejects");
  const first = await submitUltra(fixture, qualityRejects, await qualityReport(fixture, qualityRejects, { abstraction: { verdict: "rejected", findings: [blocking("file-quality-rejects")] } }));
  assert.equal(first.overall_verdict, "rejected");
  const afterQuality = await inspect();
  assert.deepEqual(afterQuality.issues, [], JSON.stringify(afterQuality.issues));
  assert.equal(afterQuality.valid, true);

  // Contract rejected, quality qualified: rejected because of the contract part.
  const contractRejects = await fixture.submitCandidate("contract-rejects");
  assert.equal((await submitUltra(fixture, contractRejects, await qualityReport(fixture, contractRejects), "rejected")).overall_verdict, "rejected");
  // Both parts qualified, and an inconclusive quality part (the more conservative of the two decides).
  const bothPass = await fixture.submitCandidate("both-pass");
  assert.equal((await submitUltra(fixture, bothPass, await qualityReport(fixture, bothPass))).overall_verdict, "qualified");
  const inconclusive = await fixture.submitCandidate("inconclusive");
  assert.equal((await submitUltra(fixture, inconclusive, await qualityReport(fixture, inconclusive, { readability: { verdict: "inconclusive" } }))).overall_verdict, "inconclusive");
  const final = await inspect();
  assert.deepEqual(final.issues, [], JSON.stringify(final.issues));
  assert.equal(final.valid, true);
});

backendTest("quality contexts hide author claims and verifier results and expose only the permitted material", async (fixture) => {
  const candidate = await fixture.submitCandidate("one", undefined, [], true);
  const blind = (await fixture.module.verificationContext(candidate.candidate.candidate_id, "blind", "quality")).context as unknown as Record<string, unknown>;
  assertContract("quality-context.schema.json", blind);
  assert.equal(blind.format, "patchledger.quality-context/v1");
  assert.equal((blind.rubric as { version: string }).version, "grounds.quality-rubric/v1");
  assert.equal((blind.rubric as { dimensions: unknown[] }).dimensions.length, 6);
  for (const hidden of ["claims", "submission_explanation", "change_rationales", "self_verification"]) assert.equal(hidden in blind, false, hidden);
  const contract = (await fixture.module.verificationContext(candidate.candidate.candidate_id, "blind")).context;
  assert.equal(blind.blind_context_digest, contract.blind_context_digest, "both parts bind the same anchor");

  const reconcile = (await fixture.module.verificationContext(candidate.candidate.candidate_id, "reconcile", "quality")).context as unknown as Record<string, unknown>;
  assertContract("quality-context.schema.json", reconcile);
  assert.equal(reconcile.change_rationales_status, "recorded");
  assert.equal((reconcile.change_rationales as unknown[]).length, 1);
  assert.equal(reconcile.submission_explanation, "Implemented one");
  for (const hidden of ["claims", "rubric", "issue", "artifact"]) assert.equal(hidden in reconcile, false, hidden);

  // A v1 Candidate has no Change Rationales; the context says so instead of implying none exist.
  const legacy = await fixture.submitCandidate("two");
  const legacyReconcile = (await fixture.module.verificationContext(legacy.candidate.candidate_id, "reconcile", "quality")).context as unknown as { change_rationales_status: string; change_rationales: unknown[] };
  assert.equal(legacyReconcile.change_rationales_status, "not_recorded");
  assert.deepEqual(legacyReconcile.change_rationales, []);

  await assert.rejects(() => fixture.module.verificationContext(candidate.candidate.candidate_id, "blind", "auditor" as "quality"), (error: unknown) => error instanceof DomainError && error.details.field === "role");
});

backendTest("quality handoff detects edits and the independent digest ignores later stages", async (fixture) => {
  const candidate = await fixture.submitCandidate();
  const report = await qualityReport(fixture, candidate);
  const handoff = createQualityHandoff(report, qualityReviewer);
  assert.deepEqual(verifyQualityHandoff(handoff).attribution, qualityReviewer);
  assertContract("quality-review-handoff.schema.json", handoff);
  const edited = structuredClone(handoff); edited.report.dimensions[0].final.explanation = "edited later";
  assert.throws(() => verifyQualityHandoff(edited), (error: unknown) => error instanceof DomainError && error.details.field === "handoff.report_digest");

  const digest = independentDigestOfQuality(report);
  const reconciled = structuredClone(report); reconciled.dimensions[0].final.explanation = "Changed during reconciliation"; reconciled.dimensions[0].reconciliation.explanation = "New information";
  assert.equal(independentDigestOfQuality(reconciled), digest);
  const rewritten = structuredClone(report); rewritten.dimensions[0].independent.explanation = "Rewritten blind judgement";
  assert.notEqual(independentDigestOfQuality(rewritten), digest);

  // The contract part is fixed the same way: only its independent stage is covered.
  const contract = await contractReport(fixture, candidate);
  const contractDigest = independentDigestOfContract(contract);
  const laterStages = structuredClone(contract); laterStages.assessments[0].criteria[0].final.explanation = "Changed later"; laterStages.assessments[0].criteria[0].reconciliation.explanation = "New information";
  assert.equal(independentDigestOfContract(laterStages), contractDigest);
  const blindEdit = structuredClone(contract); blindEdit.assessments[0].criteria[0].independent.explanation = "Rewritten blind judgement";
  assert.notEqual(independentDigestOfContract(blindEdit), contractDigest);
});

test("CLI selects the mode explicitly and refuses to downgrade or half-submit ultra", async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "grounds-ultra-cli-")));
  let fixture: LedgerFixture | undefined;
  try {
    const config = join(directory, "config.yaml");
    const database = join(directory, "ledger.db");
    await execute(["init", "--driver", "sqlite", "--non-interactive", "--config", config, "--path", database]);
    fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(database));
    const candidate = await gitCLICandidate(t, directory, config, fixture);
    const id = candidate.candidate.candidate_id;
    let cliRepository = candidate.repository;
    const invoke = async (args: string[]) => {
      const lines: string[] = [];
      // Offline commands (template --context, handoff, independent-digest) take no ledger configuration.
      const offline = args[1] === "handoff" || args[1] === "independent-digest" || (args[1] === "template" && args.includes("--context") && !args.includes("--role"));
      const code = await runCLI([...args, ...(offline ? [] : ["--config", config]), "--json"], { cwd: cliRepository, stdout: (line) => lines.push(line), stderr: () => undefined });
      return { code, envelope: JSON.parse(lines.join("\n")) };
    };
    const write = (name: string, value: unknown): string => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value)); return path; };

    // The mode and quality options are discoverable from the CLI help.
    const helpLines: string[] = [];
    assert.equal(await runCLI(["verification", "submit", "--help", "--json"], { cwd: directory, stdout: (line) => helpLines.push(line), stderr: () => undefined }), 0);
    const help = { envelope: JSON.parse(helpLines.join("\n")) };
    assert.match(help.envelope.data.usage, /--mode\s.*verification submit: normal \(default\) or ultra/);
    assert.match(help.envelope.data.usage, /--quality-handoff/);

    // Offline template for the quality role works from a saved quality context, and the template is schema-valid.
    const blindContext = (await fixture.module.verificationContext(id, "blind", "quality")).context;
    const template = await invoke(["verification", "template", "--context", write("quality-context.json", blindContext)]);
    assert.equal(template.code, 0, JSON.stringify(template.envelope));
    assertContract("command-results.schema.json", template.envelope.data);
    assert.equal(template.envelope.data.report.dimensions.length, 6);

    // The ledger template with --role quality emits the same shape; an unknown role is refused.
    const ledgerTemplate = await invoke(["verification", "template", id, "--role", "quality"]);
    assert.equal(ledgerTemplate.code, 0, JSON.stringify(ledgerTemplate.envelope));
    assert.equal(ledgerTemplate.envelope.data.result_type, "patchledger.result.quality-template/v1");
    assert.equal((await invoke(["verification", "context", id, "--role", "auditor"])).code, 2);
    const roleContext = await invoke(["verification", "context", id, "--phase", "reconcile", "--role", "quality"]);
    assert.equal(roleContext.code, 0, JSON.stringify(roleContext.envelope));
    assertContract("command-results.schema.json", roleContext.envelope.data);

    // Sign both parts offline.
    const contract = await contractReport(fixture, candidate);
    const quality = await qualityReport(fixture, candidate);
    const contractFile = write("contract-report.json", contract);
    const qualityFile = write("quality-report.json", quality);
    const digestResult = await invoke(["verification", "independent-digest", "--file", qualityFile]);
    assert.equal(digestResult.code, 0, JSON.stringify(digestResult.envelope));
    assertContract("command-results.schema.json", digestResult.envelope.data);
    const digest = digestResult.envelope.data.independent_digest as string;
    assert.equal((await invoke(["verification", "handoff", "--file", qualityFile, "--agent-id", qualityReviewer.agent_id!, "--agent-name", "QR", "--independent-digest", `sha256:${"0".repeat(64)}`])).code, 2, "a changed blind part is refused");
    const qualityHandoff = await invoke(["verification", "handoff", "--file", qualityFile, "--agent-id", qualityReviewer.agent_id!, "--agent-name", "QR", "--independent-digest", digest]);
    assert.equal(qualityHandoff.code, 0, JSON.stringify(qualityHandoff.envelope));
    assertContract("command-results.schema.json", qualityHandoff.envelope.data);
    const contractHandoff = await invoke(["verification", "handoff", "--file", contractFile, "--agent-id", testVerifier.agent_id!, "--agent-name", "V"]);
    assert.equal(contractHandoff.code, 0, JSON.stringify(contractHandoff.envelope));
    const contractPath = write("contract-handoff.json", contractHandoff.envelope.data.handoff);
    const qualityPath = write("quality-handoff.json", qualityHandoff.envelope.data.handoff);

    const count = async () => (await fixture!.module.listVerifications(id)).resources.length;
    assert.equal((await invoke(["verification", "submit", id, "--handoff", contractPath, "--mode", "ultra"])).code, 2, "ultra without a quality part");
    assert.equal((await invoke(["verification", "submit", id, "--handoff", contractPath, "--quality-handoff", qualityPath])).code, 2, "a quality part without --mode ultra is not silently dropped");
    assert.equal((await invoke(["verification", "submit", id, "--handoff", contractPath, "--quality-handoff", qualityPath, "--mode", "extreme"])).code, 2, "unknown mode");
    assert.equal((await invoke(["verification", "submit", id, "--file", contractFile, "--quality-handoff", qualityPath, "--mode", "ultra"])).code, 2, "ultra needs signed handoffs");
    assert.equal(await count(), 0);

    const submitted = await invoke(["verification", "submit", id, "--handoff", contractPath, "--quality-handoff", qualityPath, "--mode", "ultra"]);
    assert.equal(submitted.code, 0, JSON.stringify(submitted.envelope));
    assert.equal(submitted.envelope.data.mode, "ultra");
    assertContract("command-results.schema.json", submitted.envelope.data);
    const shown = await invoke(["verification", "show", submitted.envelope.data.verification_id]);
    assert.equal(shown.envelope.data.mode, "ultra");
    assert.equal(shown.envelope.data.quality.attribution.agent_id, qualityReviewer.agent_id);

    // Default mode stays normal.
    const secondRoot = join(directory, "second"); mkdirSync(secondRoot);
    const second = await gitCLICandidate(t, secondRoot, config, fixture);
    fixture.store.setGitArtifactResolver(ref => deriveLocalGitArtifact(ref.candidate_id === candidate.candidate.candidate_id ? candidate.repository : second.repository, ref.git_artifact!.binding));
    cliRepository = second.repository;
    const normalReport = await contractReport(fixture, second);
    const normalPath = write("normal-handoff.json", createVerificationHandoff(normalReport, testVerifier));
    const normal = await invoke(["verification", "submit", second.candidate.candidate_id, "--handoff", normalPath]);
    assert.equal(normal.code, 0, JSON.stringify(normal.envelope));
    assert.equal(normal.envelope.data.mode, "normal");
  } finally {
    if (fixture) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

backendTest("a refinement sees the mode, the quality verdict and, on request, every quality finding of the frozen ultra report", async (fixture) => {
  const parent = await fixture.submitCandidate();
  const findings = [blocking(), { severity: "non_blocking" as const, explanation: "Consider a smaller helper" }];
  const ultra = await submitUltra(fixture, parent, await qualityReport(fixture, parent, { abstraction: { verdict: "rejected", findings } }));
  const refinement = await fixture.module.startDevRun({
    operation_id: newUUIDv7(), attribution: testAgent, issue_id: fixture.issue.issue_id, issue_revision_id: fixture.issue.issue_revision_id, issue_revision_explicit: false,
    repository_remote_snapshot: fixture.repository.canonical_remote, refines_candidate_id: parent.candidate.candidate_id,
  });
  const runId = refinement.result.context.dev_run.id;
  const summary = (await fixture.module.devRunContext(runId)).context.refinement?.frozen_verifications[0];
  assert.equal(summary?.mode, "ultra");
  assert.equal(summary?.quality_verdict, "rejected");
  assert.deepEqual(summary?.quality_attribution, qualityReviewer);
  const expanded = await fixture.module.devRunContext(runId, false, [ultra.verification_id]);
  assertContract("devrun-context.schema.json", expanded.context);
  const included = expanded.context.refinement?.included_verification_reports[0];
  assert.equal(included?.mode, "ultra");
  const abstraction = included?.quality?.report.dimensions.find((dimension) => dimension.dimension_id === "abstraction");
  assert.deepEqual(abstraction?.final.findings, findings);
});

backendTest("a new ultra report changes the Selection's verification snapshot just like a normal report", async (fixture) => {
  const candidate = await fixture.submitCandidate();
  await fixture.verify(candidate, "qualified");
  const selected = await fixture.module.setSelection({ operation_id: newUUIDv7(), issue_id: fixture.issue.issue_id, issue_version: 1, candidate_id: candidate.candidate.candidate_id, expected_version: 0, attribution: testAgent, reason: "Reviewed" });
  assert.equal(selected.selection.verification_changed, false);
  const ultra = await submitUltra(fixture, candidate, await qualityReport(fixture, candidate, { conciseness: { verdict: "rejected", findings: [blocking()] } }));
  const after = await fixture.module.showSelection(fixture.issue.issue_id);
  assert.equal(after.selection.verification_changed, true);
  assert.ok(after.selection.warnings.some((warning) => warning.code === "SELECTION_VERIFICATION_CHANGED"));
  assert.equal(after.selection.current_verification?.count, 2);
  assert.equal(after.selection.current_verification?.standing, ultra.standing);
});

test("the Chinese content check also covers the quality part before signing", async () => {
  const fixture = await LedgerFixture.create();
  const directory = mkdtempSync(join(tmpdir(), "grounds-ultra-language-"));
  try {
    const candidate = await fixture.submitCandidate();
    const report = await qualityReport(fixture, candidate);
    report.dimensions[0].final.findings = [];
    report.dimensions[0].independent.explanation = "The rendered home preserves the existing search and navigation behavior";
    const file = join(directory, "quality.json");
    writeFileSync(file, JSON.stringify(report));
    const run = async (extra: string[]) => {
      const lines: string[] = [];
      const code = await runCLI(["verification", "handoff", "--file", file, "--agent-id", "quality", "--agent-name", "Q", "--content-language", "zh-CN", ...extra, "--json"], { cwd: directory, stdout: (line) => lines.push(line), stderr: () => undefined });
      return { code, envelope: JSON.parse(lines.join("\n")) };
    };
    const blocked = await run([]);
    assert.equal(blocked.code, 2);
    assert.equal(blocked.envelope.error.details.field, "content_language");
    const overridden = await run(["--language-override-reason", "保留上游英文判断"]);
    assert.equal(overridden.code, 0, JSON.stringify(overridden.envelope));
    assert.equal(overridden.envelope.warnings[0].code, "CONTENT_LANGUAGE_OVERRIDE");
  } finally { await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
});

/** Direct row access for tests that tamper with or downgrade stored records, on either backend. */
interface RawLedger { exec(sql: string): Promise<void>; close(): Promise<void> }
const rawLedger = async (backend: Backend, target: string): Promise<RawLedger> => {
  if (backend === "sqlite") {
    const raw = new DatabaseSync(target);
    return { exec: async (sql) => { raw.exec(sql); }, close: async () => { raw.close(); } };
  }
  if (backend === "postgres") {
    const connection = await rawConnection(target);
    return { exec: async (sql) => { await connection.query(sql); }, close: async () => { await connection.end(); } };
  }
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection({
    host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306), user: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, database: target,
    ssl: { rejectUnauthorized: true, ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { ca: readFileSync(process.env.GROUNDS_TEST_MYSQL_CA_FILE) } : {}) },
  });
  return { exec: async (sql) => { await connection.query(sql); }, close: async () => { await connection.end(); } };
};

/** A fresh, isolated ledger per backend; MySQL gets its own temporary database inside the dedicated test server. */
const isolatedLedger = async (backend: Backend, run: (context: { store: SQLStore; target: string; open: () => SQLStore }) => Promise<void>): Promise<void> => {
  if (backend === "sqlite") {
    const directory = mkdtempSync(join(tmpdir(), "grounds-ultra-ledger-"));
    const target = join(directory, "ledger.db");
    try { await run({ store: SQLStore.sqlite(target), target, open: () => SQLStore.sqlite(target) }); } finally { rmSync(directory, { recursive: true, force: true }); }
    return;
  }
  if (backend === "postgres") {
    const pg = await isolatedPostgres();
    try { await run({ store: pg.store, target: pg.database, open: () => pg.open() }); } finally { await pg.cleanup(); }
    return;
  }
  const name = `ultra_ledger_${newUUIDv7().replaceAll("-", "")}`;
  const admin = await rawLedger("mysql", process.env.GROUNDS_TEST_MYSQL_DATABASE!);
  await admin.exec(`CREATE DATABASE \`${name}\``);
  try { await run({ store: SQLStore.mysql(mysqlConnection(name)), target: name, open: () => SQLStore.mysql(mysqlConnection(name)) }); } finally { await admin.exec(`DROP DATABASE IF EXISTS \`${name}\``); await admin.close(); }
};

for (const backend of ["sqlite", "mysql", "postgres"] as const) {
  for (const previousVersion of [18, 19]) test(`${backend}: migrating published schema ${previousVersion} preserves Verifications and adds target/base storage`, { skip: backendSkipped(backend) }, async () => {
    await isolatedLedger(backend, async ({ store, target, open }) => {
      const fixture = await LedgerFixture.createWithStore(store, async () => undefined);
      const candidate = await fixture.submitCandidate();
      const normal = previousVersion === 19
        ? await submitUltra(fixture, candidate, await qualityReport(fixture, candidate))
        : await fixture.verify(candidate, "qualified");
      const before = await fixture.module.showVerification(normal.verification_id);
      const setBefore = (await fixture.module.verificationPage(candidate.candidate.candidate_id)).verification_set;
      await store.close();

      const raw = await rawLedger(backend, target);
      if (previousVersion === 18) await raw.exec("DROP TABLE verification_quality_reviews");
      for (const table of ["issue_target_branches", "candidate_bases", "dev_run_bases"]) await raw.exec(`DROP TABLE ${table}`);
      await raw.exec(`UPDATE schema_metadata SET schema_version = ${previousVersion}`);
      await raw.exec(`DELETE FROM schema_migrations WHERE schema_version > ${previousVersion}`);
      await raw.exec(`INSERT INTO schema_migrations (schema_version, applied_at) VALUES (${previousVersion}, CURRENT_TIMESTAMP)`);
      await raw.close();

      const migrating = open();
      fixture.installGitArtifactResolver(migrating);
      await assert.rejects(() => migrating.open(), (error: unknown) => error instanceof DomainError && error.code === "SCHEMA_INCOMPATIBLE");
      assert.equal((await migrating.inspectIntegrity()).report.valid, true, "published schema is readable before migration");
      assert.equal((await migrating.migrate()).schema_version, SCHEMA_VERSION);
      assert.equal((await migrating.migrate()).schema_version, SCHEMA_VERSION, "migration is repeatable");
      const module = new Module(migrating);
      const after = await module.showVerification(normal.verification_id);
      assert.deepEqual(after, before);
      assert.equal(after.mode, previousVersion === 19 ? "ultra" : "normal");
      assert.deepEqual((await module.verificationPage(candidate.candidate.candidate_id)).verification_set, setBefore, "Standing and the Verification set digest are unchanged");
      assert.equal((await migrating.inspectIntegrity()).report.valid, true);
      await migrating.close();

      // The migrated ledger accepts an ultra Verification: the new table is usable, not just present.
      const reopened = open();
      const reopenedFixture = await LedgerFixture.createWithStore(reopened, async () => undefined);
      const second = await reopenedFixture.submitCandidate("two");
      assert.equal((await submitUltra(reopenedFixture, second, await qualityReport(reopenedFixture, second))).mode, "ultra");
      reopened.setGitArtifactResolver(ref => ref.candidate_id === candidate.candidate.candidate_id ? candidate.artifact : second.artifact);
      assert.equal((await reopened.inspectIntegrity()).report.valid, true, "the migrated ledger stays valid after an ultra submission");
      await reopened.close();
    });
  });

  test(`${backend}: a stored quality part that no longer matches its Verification is reported as corruption`, { skip: backendSkipped(backend) }, async () => {
    await isolatedLedger(backend, async ({ store, target }) => {
      const fixture = await LedgerFixture.createWithStore(store, async () => undefined);
      const candidate = await fixture.submitCandidate();
      const ultra = await submitUltra(fixture, candidate, await qualityReport(fixture, candidate));
      assert.equal((await fixture.module.showVerification(ultra.verification_id)).quality?.overall_verdict, "qualified");
      const raw = await rawLedger(backend, target);
      const integrity = async () => (await fixture.store.inspectIntegrity()).report;
      assert.equal((await integrity()).valid, true);
      const corrupted = async (sql: string, restore: string): Promise<void> => {
        await raw.exec(sql);
        await assert.rejects(() => fixture.module.showVerification(ultra.verification_id), (error: unknown) => error instanceof DomainError && error.code === "ARTIFACT_INTEGRITY_ERROR");
        assert.equal((await integrity()).valid, false, "the integrity inspection also sees the corruption");
        await raw.exec(restore);
        assert.equal((await fixture.module.showVerification(ultra.verification_id)).mode, "ultra");
        assert.equal((await integrity()).valid, true);
      };
      const id = ultra.verification_id;
      // The stored quality verdict no longer follows from the stored dimensions.
      await corrupted(`UPDATE verification_quality_reviews SET overall_verdict = 'rejected' WHERE verification_id = '${id}'`, `UPDATE verification_quality_reviews SET overall_verdict = 'qualified' WHERE verification_id = '${id}'`);
      // The stored rubric version differs from the report it summarises.
      await corrupted(`UPDATE verification_quality_reviews SET rubric_version = 'grounds.quality-rubric/v0' WHERE verification_id = '${id}'`, `UPDATE verification_quality_reviews SET rubric_version = 'grounds.quality-rubric/v1' WHERE verification_id = '${id}'`);
      // The Verification's own verdict no longer equals the more conservative of its two parts.
      await corrupted(`UPDATE verifications SET overall_verdict = 'rejected' WHERE id = '${id}'`, `UPDATE verifications SET overall_verdict = 'qualified' WHERE id = '${id}'`);
      await raw.close();
      await store.close();
    });
  });
}

for (const backend of ["sqlite", "mysql", "postgres"] as const) {
  test(`${backend}: a ledger without the quality table still reads its normal Verifications`, { skip: backendSkipped(backend) }, async () => {
    await isolatedLedger(backend, async ({ store, target }) => {
      const fixture = await LedgerFixture.createWithStore(store, async () => undefined);
      const candidate = await fixture.submitCandidate();
      const normal = await fixture.verify(candidate, "qualified");
      const raw = await rawLedger(backend, target);
      await raw.exec("DROP TABLE verification_quality_reviews");
      await raw.close();
      const shown = await fixture.module.showVerification(normal.verification_id);
      assert.equal(shown.mode, "normal");
      assert.equal(shown.overall_verdict, "qualified");
      await store.close();
    });
  });
}

test("blocking finding locations must name a path the Candidate changed, including the old path of a rename", () => {
  const report = (path: string): QualityReviewReportInput => {
    const dimensions = QUALITY_DIMENSIONS.map((dimension) => ({
      dimension_id: dimension.id,
      independent: { verdict: "qualified" as Verdict, explanation: "ok", findings: [] as QualityFinding[], evidence: [] },
      reconciliation: { explanation: "ok" },
      final: { verdict: "qualified" as Verdict, explanation: "ok", findings: [] as QualityFinding[] },
    }));
    dimensions[0].final = { verdict: "rejected", explanation: "duplicate branch", findings: [blocking(path)] };
    return { format: "patchledger.quality-review-report/v1", candidate_id: "018f0000-0000-7000-8000-000000000001", result_tree_oid: `sha1:${"1".repeat(40)}`, blind_context_digest: `sha256:${"2".repeat(64)}`, rubric_version: "grounds.quality-rubric/v1", dimensions };
  };
  const files = [
    { path_bytes: Buffer.from("src/new-name.ts").toString("base64"), display_path: "src/new-name.ts", change: "renamed", old_path_bytes: Buffer.from("src/old-name.ts").toString("base64") },
    { path_bytes: Buffer.from("README.md").toString("base64"), display_path: "README.md", change: "modified" },
  ];
  validateQualityLocations(report("src/new-name.ts"), files);
  validateQualityLocations(report("src/old-name.ts"), files);
  validateQualityLocations(report("README.md"), files);
  assert.throws(() => validateQualityLocations(report("src/untouched.ts"), files), (error: unknown) => error instanceof DomainError && error.details.field === "quality.dimensions[0].final.findings[0].location.path");
  // A non-blocking finding may point anywhere, including at code the Candidate did not touch.
  const advisory = report("README.md");
  advisory.dimensions[1].final.findings = [{ severity: "non_blocking", explanation: "Pre-existing helper could be simpler", location: { path: "src/untouched.ts" } }];
  validateQualityLocations(advisory, files);
});

backendTest("a worktree removal event is recorded once under its registered operation on either backend", async (fixture) => {
  const candidate = await fixture.submitCandidate();
  const devRunId = candidate.run.context.dev_run.id;
  const receipt = { format: "grounds.worktree-removal-receipt/v1" as const, operation_id: newUUIDv7(), event_id: newUUIDv7(), dev_run_id: devRunId, worktree_path: "/tmp/removed-worktree", discard_changes: true, entry_count: 42, attribution: testAgent, recorded: false };
  const summary = await fixture.module.recordDevRunWorktreeRemoval(receipt);
  assert.deepEqual({ ...summary, occurred_at: undefined }, { dev_run_id: devRunId, worktree_path: "/tmp/removed-worktree", discard_changes: true, entry_count: 42, occurred_at: undefined });
  // Same operation: the stored summary is returned and nothing is appended.
  assert.deepEqual(await fixture.module.recordDevRunWorktreeRemoval(receipt), summary);
  assert.deepEqual(await fixture.module.completedDevRunWorktreeRemoval(receipt.operation_id, devRunId), summary);
  assert.equal(await fixture.module.completedDevRunWorktreeRemoval(newUUIDv7(), devRunId), undefined);
  // A different payload under the same operation id is a conflict, not a second event.
  await assert.rejects(() => fixture.module.recordDevRunWorktreeRemoval({ ...receipt, entry_count: 43 }), (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT");
  const page = await fixture.module.listLedger("", "", "dev_run", devRunId);
  const removed = (page as unknown as { events: Array<{ event_type: string; operation_id: string; facts: Array<{ name: string; value: string }> }> }).events.filter((event) => event.event_type === "devrun.worktree_removed");
  assert.equal(removed.length, 1); assert.equal(removed[0].operation_id, receipt.operation_id);
  assert.deepEqual(removed[0].facts.map((fact) => `${fact.name}=${fact.value}`).sort(), ["dev_run_id=" + devRunId, "discard_changes=true", "entry_count=42", "worktree_path=/tmp/removed-worktree"]);
});
