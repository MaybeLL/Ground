import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerFixture, testVerifier } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { DomainError } from "../src/errors.js";
import { prepareReviewMarkdown } from "../src/review-export.js";
import { renderReviewMarkdown } from "../src/review.js";
import { SQLStore } from "../src/sql-store.js";
import { backendSkip, openLedger } from "./backends.js";
import { runCLI } from "../src/cli.js";

const mysqlEnabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every(key => Boolean(process.env[`GROUNDS_TEST_MYSQL_${key}`]));
const createFixture = async (backend: "sqlite" | "mysql" | "postgres"): Promise<LedgerFixture> => {
  if (backend === "postgres") return openLedger("postgres");
  return backend === "sqlite" ? await LedgerFixture.create() : await LedgerFixture.createWithStore(SQLStore.mysql({ host: process.env.GROUNDS_TEST_MYSQL_HOST!, database: process.env.GROUNDS_TEST_MYSQL_DATABASE!, username: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306), ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE } : {}) }));
};
const backendTest = (name: string, run: (fixture: LedgerFixture) => Promise<void>): void => {
  for (const backend of ["sqlite", "mysql", "postgres"] as const) test(`${backend}: ${name}`, { skip: backendSkip(backend) }, async () => run(await createFixture(backend)));
};
backendTest("Review directory pagination, fixed set and no report reads", async fixture => {
    try {
      const candidate = await fixture.submitCandidate();
      const id = candidate.candidate.candidate_id;
      const empty = await fixture.module.reviewSummary(id);
      assert.equal(empty.trace.verification_set.count, 0);
      assertContract("query-results.schema.json", empty);
      for (let index = 0; index < 257; index++) await fixture.verify(candidate, index % 3 === 0 ? "rejected" : index % 3 === 1 ? "qualified" : "inconclusive");
      const originalRead = fixture.store.read.bind(fixture.store);
      fixture.store.read = callback => originalRead(async tx => {
        tx.getVerification = async () => { throw new Error("summary path read a report"); };
        return callback(tx);
      });
      const summary = await fixture.module.reviewSummary(id);
      const first = await fixture.module.verificationPage(id);
      assert.equal(first.verifications.length, 256);
      assert.equal(first.verification_set.digest, summary.trace.verification_set.digest);
      assert.equal(first.verification_set.standing, "disputed");
      assert.equal("complete" in summary.trace.verification_set, false);
      assert.equal("verifications" in summary.trace.verification_set, false);
      assertContract("query-results.schema.json", summary);
      assertContract("query-results.schema.json", first);
      const last = await fixture.module.verificationPage(id, first.next_cursor!);
      assert.equal(last.verifications.length, 1);
      assert.equal(last.next_cursor, undefined);
      await assert.rejects(fixture.module.verificationPage(newUUIDv7(), first.next_cursor!), { code: "VALIDATION_ERROR" });
      await assert.rejects(fixture.module.verificationPage(id, "invalid"), { code: "VALIDATION_ERROR" });
      await assert.rejects(fixture.module.verificationPage(newUUIDv7()), { code: "NOT_FOUND" });
      fixture.store.read = originalRead;
      await fixture.verify(candidate);
      await assert.rejects(fixture.module.verificationPage(id, first.next_cursor!), error => {
        assertContract("error.schema.json", (error as DomainError).toJSON());
        return error instanceof DomainError && error.code === "VERIFICATION_SET_CHANGED" && error.retryable;
      });
    } finally { await fixture.close(); }
});

backendTest("Markdown staged export matches legacy rendering and cleans up", async fixture => {
  try {
    const candidate = await fixture.submitCandidate();
    const id = candidate.candidate.candidate_id;
    await fixture.verify(candidate, "qualified");
    const trace = await fixture.module.reviewCandidate(id);
    const prepared = await prepareReviewMarkdown(fixture.module, id);
    assert.equal(readFileSync(prepared.path, "utf8"), renderReviewMarkdown(trace));
    const lines: string[] = [];
    await prepared.print(line => { lines.push(line); });
    assert.equal(lines.join("\n"), renderReviewMarkdown(trace));
    assert.equal(existsSync(prepared.directory), false);
  } finally { await fixture.close(); }
});

backendTest("44 large reports exceed legacy trace but summary and complete Markdown remain readable", async fixture => {
  try {
    const candidate = await fixture.submitCandidate();
    const id = candidate.candidate.candidate_id;
    const first = await fixture.verify(candidate);
    const report = (await fixture.module.showVerification(first.verification_id)).report;
    report.assessments[0].criteria[0].independent.evidence = Array.from({ length: 4 }, () => ({ type: "command" as const, command: "test", exit_code: 0, output: "x".repeat(60_000) }));
    for (let index = 1; index < 44; index++) await fixture.module.submitVerification({ operation_id: newUUIDv7(), attribution: testVerifier, report });
    await assert.rejects(fixture.module.reviewCandidate(id), { code: "ARTIFACT_TOO_LARGE" });
    assert.equal((await fixture.module.reviewSummary(id)).trace.verification_set.count, 44);
    const prepared = await prepareReviewMarkdown(fixture.module, id);
    try {
      const markdown = readFileSync(prepared.path, "utf8");
      assert.equal((markdown.match(/- Verification: `/g) ?? []).length, 44);
      const intro = markdown.split("<details>")[0];
      assert.ok([...intro].length <= 4000);
      assert.ok(intro.split("\n").length <= 50);
    } finally { prepared.dispose(); }
  } finally { await fixture.close(); }
});

backendTest("export rejects missing reports and mismatched directories without leaking staging files", async fixture => {
  const staging = () => readdirSync(tmpdir()).filter(name => name.startsWith("grounds-review-")).sort();
  try {
    const candidate = await fixture.submitCandidate();
    await fixture.verify(candidate);
    const before = staging();
    const readReport = fixture.module.showVerification.bind(fixture.module);
    fixture.module.showVerification = async () => { throw new DomainError("NOT_FOUND", "missing report"); };
    await assert.rejects(prepareReviewMarkdown(fixture.module, candidate.candidate.candidate_id), { code: "NOT_FOUND" });
    assert.deepEqual(staging(), before);
    fixture.module.showVerification = async id => { const report = await readReport(id); return { ...report, candidate_id: newUUIDv7() }; };
    await assert.rejects(prepareReviewMarkdown(fixture.module, candidate.candidate.candidate_id), { code: "ARTIFACT_INTEGRITY_ERROR" });
    assert.deepEqual(staging(), before);
    fixture.module.showVerification = readReport;
    const readPage = fixture.module.verificationPage.bind(fixture.module);
    fixture.module.verificationPage = async (...args) => ({ ...await readPage(...args), verifications: [] });
    await assert.rejects(prepareReviewMarkdown(fixture.module, candidate.candidate.candidate_id), { code: "ARTIFACT_INTEGRITY_ERROR" });
    fixture.module.verificationPage = readPage;
    fixture.module.showVerification = async () => { throw new DomainError("ARTIFACT_TOO_LARGE", "single report exceeds 8 MiB"); };
    await assert.rejects(prepareReviewMarkdown(fixture.module, candidate.candidate.candidate_id), { code: "ARTIFACT_TOO_LARGE" });
    fixture.module.reviewSummary = async () => { throw new DomainError("ARTIFACT_TOO_LARGE", "base exceeds 8 MiB"); };
    await assert.rejects(prepareReviewMarkdown(fixture.module, candidate.candidate.candidate_id), { code: "ARTIFACT_TOO_LARGE" });
    assert.deepEqual(staging(), before);
  } finally { await fixture.close(); }
});

backendTest("export retries set changes at most twice and preserves fixed reports after directory collection", async fixture => {
  try {
    const candidate = await fixture.submitCandidate();
    await fixture.verify(candidate);
    const page = fixture.module.verificationPage.bind(fixture.module);
    let calls = 0;
    fixture.module.verificationPage = async () => { calls++; throw new DomainError("VERIFICATION_SET_CHANGED", "changed", true); };
    await assert.rejects(prepareReviewMarkdown(fixture.module, candidate.candidate.candidate_id), { code: "VERIFICATION_SET_CHANGED" });
    assert.equal(calls, 3);
    fixture.module.verificationPage = page;
    const read = fixture.module.showVerification.bind(fixture.module);
    let added = false;
    fixture.module.showVerification = async id => { if (!added) { added = true; await fixture.verify(candidate, "rejected"); } return read(id); };
    const prepared = await prepareReviewMarkdown(fixture.module, candidate.candidate.candidate_id);
    try { assert.match(readFileSync(prepared.path, "utf8"), /Complete set: \*\*1\*\*/); }
    finally { prepared.dispose(); }
  } finally { await fixture.close(); }
});

test("CLI rejects incompatible new flags before accessing a database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-review-invalid-flags-"));
  try {
    // Cursor pagination is valid for list commands; show still rejects it.
    // A missing dedicated config also proves validation runs before storage access.
    for (const args of [["review", "--summary", "--markdown"], ["verification", "show", "--cursor", "abc"], ["review", "--paged"]]) {
      const output: string[] = [];
      assert.equal(await runCLI([...args, "--config", join(directory, "missing-config.yaml"), "--json"], { stdout: line => output.push(line), stderr: () => {} }), 2);
      assert.equal(JSON.parse(output[0]).error.code, "VALIDATION_ERROR");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
