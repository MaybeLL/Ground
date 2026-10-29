import { gitCLICandidate } from "./git-cli-ledger-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandNeedsOperationID, execute, exitCode, parseArgs, runCLI } from "../src/cli.js";
import { loadConfig, mysqlKeychainLocator, mysqlPassword, validateConfig, writeConfig, type DatabaseConfig } from "../src/config.js";
import { asDomainError, DomainError } from "../src/errors.js";
import { assertContract } from "./schema-fixture.js";
import { LedgerFixture, testVerifier } from "./fixture.js";
import { createVerificationHandoff } from "../src/verification-handoff.js";
import { SCHEMA_VERSION, SQLStore } from "../src/sql-store.js";

test("CLI exit codes follow the stable error registry", () => {
  assert.equal(exitCode(new DomainError("VALIDATION_ERROR", "invalid")), 2);
  assert.equal(exitCode(new DomainError("NOT_FOUND", "missing")), 3);
  for (const code of ["STATE_CONFLICT", "AUTH_FAILED", "VERSION_CONFLICT", "PREDECESSOR_CONFLICT", "IDEMPOTENCY_CONFLICT"] as const) {
    assert.equal(exitCode(new DomainError(code, "conflict")), 4);
  }
  for (const code of ["SCHEMA_INCOMPATIBLE", "MIGRATION_DIRTY", "DATABASE_ID_MISMATCH"] as const) {
    assert.equal(exitCode(new DomainError(code, "schema")), 5);
  }
  for (const code of ["REPOSITORY_NOT_RESOLVED", "BASELINE_UNAVAILABLE", "ARTIFACT_TOO_LARGE"] as const) {
    assert.equal(exitCode(new DomainError(code, "boundary")), 6);
  }
  assert.equal(exitCode(new DomainError("STORAGE_TRANSIENT", "retry", true)), 7);
});

test("only business writes receive generated operation IDs", async () => {
  assert.equal(commandNeedsOperationID(parseArgs(["repository", "register"])), true);
  assert.equal(commandNeedsOperationID(parseArgs(["requirement", "create"])), false);
  assert.equal(commandNeedsOperationID(parseArgs(["requirement", "show"])), false);
  assert.equal(commandNeedsOperationID(parseArgs(["workspace", "publish"])), false);
  // Cleanup appends a ledger event under a registered operation, so it is a business write like abandon.
  assert.equal(commandNeedsOperationID(parseArgs(["devrun", "cleanup"])), true);
  assert.equal(commandNeedsOperationID(parseArgs(["devrun", "reconcile"])), false);
  assert.equal(commandNeedsOperationID(parseArgs(["init"])), false);

  const output: string[] = [];
  const errors: string[] = [];
  const status = await runCLI(
    ["config", "path", "--json", "--config", "/tmp/grounds-test-config.yaml"],
    { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) },
  );
  assert.equal(status, 0);
  assert.deepEqual(errors, []);
  const envelope = JSON.parse(output[0]) as Record<string, unknown>;
  assertContract("cli-envelope.schema.json", envelope);
  assert.equal("operation_id" in envelope, false);
  assert.deepEqual(envelope.data, {
    result_type: "patchledger.result.config-path/v1",
    command: "config.path",
    config_path: "/tmp/grounds-test-config.yaml",
  });
});

test("init returns the versioned result shape without a business operation ID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-cli-test-"));
  try {
    const output: string[] = [];
    const errors: string[] = [];
    const status = await runCLI([
      "init",
      "--driver", "sqlite",
      "--non-interactive",
      "--json",
      "--config", join(directory, "config.yaml"),
      "--path", join(directory, "ledger.db"),
    ], { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
    assert.equal(status, 0);
    assert.deepEqual(errors, []);
    const envelope = JSON.parse(output[0]) as { operation_id?: string; data: Record<string, unknown> };
    assertContract("cli-envelope.schema.json", envelope);
    assert.equal(envelope.operation_id, undefined);
    assert.equal(envelope.data.result_type, "patchledger.result.init/v1");
    assert.equal(envelope.data.command, "init");
    assert.equal(envelope.data.database_action, "initialized");
    assert.equal("action" in envelope.data, false);
    assert.equal("database_path" in envelope.data, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent SQLite init invocations converge on one database identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-cli-concurrent-init-"));
  try {
    const configFile = join(directory, "config.yaml");
    const databasePath = join(directory, "ledger.db");
    const args = [
      "init", "--driver", "sqlite", "--non-interactive",
      "--config", configFile, "--path", databasePath,
    ];
    const results = await Promise.all([execute(args), execute(args)]) as Array<{ database_action: string; database_id: string }>;
    assert.deepEqual(results.map((result) => result.database_action).sort(), ["attached", "initialized"]);
    assert.equal(new Set(results.map((result) => result.database_id)).size, 1);
    assert.equal(loadConfig(configFile).database.expected_database_id, results[0].database_id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("init rejects an unexpected action instead of silently ignoring it", async () => {
  const output: string[] = [];
  const status = await runCLI(
    ["init", "unexpected", "--json", "--config", "/tmp/grounds-init-action-config.yaml"],
    { stdout: (line) => output.push(line), stderr: () => undefined },
  );
  assert.equal(status, 2);
  const envelope = JSON.parse(output[0]) as { ok: boolean; error?: { code?: string; details?: { field?: string } } };
  assertContract("cli-envelope.schema.json", envelope);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "VALIDATION_ERROR");
  assert.equal(envelope.error?.details?.field, "command");
});

test("JSON failures satisfy the stable CLI envelope", async () => {
  const output: string[] = [];
  const status = await runCLI(
    ["config", "show", "--json", "--config", "/definitely/missing/grounds-config.yaml"],
    { stdout: (line) => output.push(line), stderr: () => undefined },
  );
  assert.equal(status, 2);
  assertContract("cli-envelope.schema.json", JSON.parse(output[0]));
});

test("a malformed JSON flag still keeps the failure machine-readable", async () => {
  const output: string[] = [];
  const status = await runCLI(
    ["config", "path", "--json=maybe"],
    { stdout: (line) => output.push(line), stderr: () => undefined },
  );
  assert.equal(status, 2);
  const envelope = JSON.parse(output[0]) as { ok: boolean; error?: { code?: string; details?: { field?: string } } };
  assertContract("cli-envelope.schema.json", envelope);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "VALIDATION_ERROR");
  assert.equal(envelope.error?.details?.field, "json");
});

test("help validates its own options instead of swallowing command typos", async () => {
  const output: string[] = [];
  const status = await runCLI(["requirement", "list", "--help", "--unknown", "--json"], {
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });
  assert.equal(status, 2);
  const envelope = JSON.parse(output[0]) as { ok: boolean; error?: { code?: string; details?: { field?: string } } };
  assertContract("cli-envelope.schema.json", envelope);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "VALIDATION_ERROR");
  assert.equal(envelope.error?.details?.field, "--unknown");
});

test("help rejects non-boolean help values", async () => {
  const output: string[] = [];
  const status = await runCLI(["help", "--help=maybe", "--json"], {
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });
  assert.equal(status, 2);
  const envelope = JSON.parse(output[0]) as { ok: boolean; error?: { code?: string; details?: { field?: string } } };
  assertContract("cli-envelope.schema.json", envelope);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "VALIDATION_ERROR");
  assert.equal(envelope.error?.details?.field, "help");
});

test("Workspace publish help lists the public authoring options", async () => {
  const output: string[] = [];
  const status = await runCLI(["workspace", "publish", "--help", "--json"], {
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });
  assert.equal(status, 0);
  const envelope = JSON.parse(output[0]) as { ok: boolean; data: { command: string; usage: string } };
  assertContract("cli-envelope.schema.json", envelope);
  assert.equal(envelope.ok, true);
  // The help result keeps the stable `command: "help"` contract; the target
  // subcommand is conveyed inside usage so schema-constrained callers stay
  // compatible.
  assert.equal(envelope.data.command, "help");
  assert.match(envelope.data.usage, /draft publish/);
  assert.match(envelope.data.usage, /--dry-run/);
  assert.match(envelope.data.usage, /--content-language/);
  assert.match(envelope.data.usage, /--language-override-reason/);
  assert.match(envelope.data.usage, /--agent-id/);
});

test("retired per-resource write commands are unavailable, including through help", async () => {
  for (const command of [["quickstart", "create"], ["requirement", "create"], ["requirement", "revise"], ["issue", "create"], ["issue", "revise"]]) {
    for (const suffix of [[], ["--help"]]) {
      const output: string[] = [];
      assert.equal(await runCLI([...command, ...suffix, "--json"], { stdout: (line) => output.push(line), stderr: () => undefined }), 2);
      const envelope = JSON.parse(output[0]) as { error?: { code?: string } };
      assert.equal(envelope.error?.code, "VALIDATION_ERROR");
    }
  }
});

test("blind templates and signed handoffs work without opening a ledger", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-offline-verification-"));
  try {
    const contextPath = join(directory, "blind.json");
    const reportPath = join(directory, "report.json");
    writeFileSync(contextPath, JSON.stringify({
      format: "patchledger.verification-context/v1", phase: "blind",
      candidate_id: "018f0000-0000-7000-8000-000000000001",
      result_tree_oid: `sha1:${"1".repeat(40)}`,
      blind_context_digest: `sha256:${"2".repeat(64)}`,
      issue: {
        goals: [{ id: "018f0000-0000-7000-8000-000000000002", criteria: [{ id: "018f0000-0000-7000-8000-000000000003" }] }],
        constraints: [],
      },
    }));
    const templateOutput: string[] = [];
    assert.equal(await runCLI(["verification", "template", "--context", contextPath, "--json"], { stdout: (line) => templateOutput.push(line), stderr: () => undefined }), 0);
    const template = JSON.parse(templateOutput[0]) as { data: { report: Record<string, unknown> } };
    assertContract("command-results.schema.json", template.data);
    writeFileSync(reportPath, JSON.stringify(template.data.report));

    const handoffOutput: string[] = [];
    assert.equal(await runCLI(["verification", "handoff", "--file", reportPath, "--agent-id", "offline-verifier", "--agent-name", "Offline Verifier", "--json"], { stdout: (line) => handoffOutput.push(line), stderr: () => undefined }), 0);
    const handoff = JSON.parse(handoffOutput[0]) as { data: Record<string, unknown> };
    assertContract("command-results.schema.json", handoff.data);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a coordinator can submit a signed verifier handoff without impersonating the verifier", async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "grounds-handoff-submit-")));
  let fixture: LedgerFixture | undefined;
  try {
    const config = join(directory, "config.yaml");
    const database = join(directory, "ledger.db");
    await execute(["init", "--driver", "sqlite", "--non-interactive", "--config", config, "--path", database]);
    fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(database));
    const candidate = await gitCLICandidate(t, directory, config, fixture);
    const template = await fixture.module.verificationReportTemplate(candidate.candidate.candidate_id);
    const assessment = template.report.assessments[0].criteria[0];
    assessment.independent = { verdict: "qualified", explanation: "The rendered home preserves the existing search and navigation behavior", evidence: [] };
    assessment.reconciliation = { claim_relation: "corroborated", explanation: "agrees" };
    assessment.final = { verdict: "qualified", explanation: "qualified" };
    const handoffPath = join(directory, "handoff.json");
    writeFileSync(handoffPath, JSON.stringify(createVerificationHandoff(template.report, testVerifier)));

    const blockedOutput: string[] = [];
    assert.equal(await runCLI(["verification", "submit", candidate.candidate.candidate_id, "--handoff", handoffPath, "--content-language", "zh-CN", "--config", config, "--json"], { cwd: candidate.repository, stdout: (line) => blockedOutput.push(line), stderr: () => undefined }), 2);
    assert.equal(JSON.parse(blockedOutput[0]).error.details.field, "content_language");

    const output: string[] = [];
    assert.equal(await runCLI(["verification", "submit", candidate.candidate.candidate_id, "--handoff", handoffPath, "--content-language", "zh-CN", "--language-override-reason", "引用上游英文检查结果", "--config", config, "--json"], { cwd: candidate.repository, stdout: (line) => output.push(line), stderr: () => undefined }), 0);
    const envelope = JSON.parse(output[0]) as { data: { command: string; verification_id: string }; warnings: { code: string }[] };
    assert.equal(envelope.data.command, "verification.submit");
    assert.ok(envelope.warnings.some(warning => warning.code === "CONTENT_LANGUAGE_OVERRIDE"));
    const stored = await fixture.module.showVerification(envelope.data.verification_id);
    assert.deepEqual(stored.attribution, testVerifier);
  } finally {
    if (fixture) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("review CLI emits a contract-shaped trace and a provenance-oriented human view", async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "grounds-review-cli-")));
  let fixture: LedgerFixture | undefined;
  try {
    const config = join(directory, "config.yaml");
    const database = join(directory, "ledger.db");
    await execute(["init", "--driver", "sqlite", "--non-interactive", "--config", config, "--path", database]);
    fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(database));
    const candidate = await gitCLICandidate(t, directory, config, fixture);
    await fixture.verify(candidate);
    for (const args of [
      ["review", candidate.candidate.candidate_id, "--summary", "--include-diff", "--at", "file-one"],
      ["verification", "list", "--candidate", candidate.candidate.candidate_id, "--paged"],
    ]) {
      const response: string[] = [];
      assert.equal(await runCLI([...args, "--config", config, "--cwd", candidate.repository, "--json"], { stdout: line => response.push(line), stderr: () => {} }), 0);
      const data = JSON.parse(response[0]).data;
      assertContract("query-results.schema.json", data);
      assert.equal((data.trace?.verification_set ?? data.verification_set).reports_included, false);
    }
    const databaseDigestBeforeReview = createHash("sha256").update(readFileSync(database)).digest("hex");
    const directoryEntriesBeforeReview = readdirSync(directory).sort();

    const jsonOutput: string[] = [];
    assert.equal(await runCLI(["review", candidate.candidate.candidate_id, "--at", "file-one:12", "--include-diff", "--config", config, "--cwd", candidate.repository, "--json"], { stdout: (line) => jsonOutput.push(line), stderr: () => undefined }), 0);
    const envelope = JSON.parse(jsonOutput[0]) as { data: { result_type: string; trace: { location?: { line?: number }; verification_set: { complete: boolean } } } };
    assertContract("cli-envelope.schema.json", envelope);
    assertContract("query-results.schema.json", envelope.data);
    assert.equal(envelope.data.trace.location?.line, 12);
    assert.equal(envelope.data.trace.verification_set.complete, true);

    const humanOutput: string[] = [];
    assert.equal(await runCLI(["review", "--candidate", candidate.candidate.candidate_id, "--config", config, "--cwd", candidate.repository], { stdout: (line) => humanOutput.push(line), stderr: () => undefined }), 0);
    assert.match(humanOutput.join("\n"), /Historical contract \[ledger fact\]/);
    assert.match(humanOutput.join("\n"), /Coverage: 0\/1 Change Units explained \(not_recorded\)/);

    const markdownOutput: string[] = [];
    assert.equal(await runCLI(["review", candidate.candidate.candidate_id, "--markdown", "--config", config, "--cwd", candidate.repository], { stdout: (line) => markdownOutput.push(line), stderr: () => undefined }), 0);
    const markdown = markdownOutput.join("\n");
    assert.match(markdown, /^# Grounds Review — Implement the change/);
    assert.match(markdown, /## Review at a glance/);
    assert.match(markdown, /## Changes and why/);
    assert.match(markdown, /<summary>Full historical contract<\/summary>/);
    assert.match(markdown, /<summary>Complete independent verification<\/summary>/);
    assert.match(markdown, /Complete set: \*\*1\*\*/);
    assert.doesNotMatch(markdown, /"format":"patchledger\.cli\/v1"/);

    const markdownWithDiffOutput: string[] = [];
    assert.equal(await runCLI(["review", candidate.candidate.candidate_id, "--markdown", "--include-diff", "--config", config, "--cwd", candidate.repository], { stdout: (line) => markdownWithDiffOutput.push(line), stderr: () => undefined }), 0);
    assert.match(markdownWithDiffOutput.join("\n"), /<summary>Unified diff<\/summary>[\s\S]*```diff/);
    assert.equal(createHash("sha256").update(readFileSync(database)).digest("hex"), databaseDigestBeforeReview);
    assert.deepEqual(readdirSync(directory).sort(), directoryEntriesBeforeReview);
    assert.equal(commandNeedsOperationID(parseArgs(["review", candidate.candidate.candidate_id, "--markdown"])), false);

    const conflictOutput: string[] = [];
    assert.equal(await runCLI(["review", candidate.candidate.candidate_id, "--markdown", "--json"], { stdout: (line) => conflictOutput.push(line), stderr: () => undefined }), 2);
    assert.equal((JSON.parse(conflictOutput[0]) as { error: { details: { field: string } } }).error.details.field, "markdown");

    const reviewWorktree = join(directory, "review-worktree");
    execFileSync("git", ["-C", candidate.repository, "worktree", "add", "--detach", reviewWorktree, candidate.candidate.source!.commit.split(":")[1]!], { stdio: "pipe" });
    const reviewMarker = execFileSync("git", ["-C", reviewWorktree, "rev-parse", "--git-path", "grounds-review.json"], { encoding: "utf8" }).trim();
    writeFileSync(reviewMarker, JSON.stringify({
      format: "patchledger.review-worktree/v1",
      database_id: loadConfig(config).database.expected_database_id,
      candidate_id: candidate.candidate.candidate_id,
      repository_id: fixture.repository.repository_id,
      baseline_oid: candidate.run.context.baseline.git_oid,
      result_tree_oid: candidate.artifact.result_tree_oid,
      patch_digest: candidate.artifact.patch_digest,
    }));
    const databaseDigestBeforeDiscovery = createHash("sha256").update(readFileSync(database)).digest("hex");
    const summaryOutput: string[] = [];
    assert.equal(await runCLI(["review", "--summary", "--cwd", reviewWorktree, "--config", config, "--json"], { stdout: line => summaryOutput.push(line), stderr: () => {} }), 0);
    assert.equal(JSON.parse(summaryOutput[0]).data.trace.candidate.candidate_id, candidate.candidate.candidate_id);
    const markerDigestBeforeDiscovery = createHash("sha256").update(readFileSync(reviewMarker)).digest("hex");
    const worktreeEntriesBeforeDiscovery = readdirSync(reviewWorktree).sort();
    const discoveredOutput: string[] = [];
    assert.equal(await runCLI(["review", "--cwd", reviewWorktree, "--config", config, "--json"], { stdout: (line) => discoveredOutput.push(line), stderr: () => undefined }), 0);
    assert.equal((JSON.parse(discoveredOutput[0]) as { data: { trace: { candidate: { candidate_id: string } } } }).data.trace.candidate.candidate_id, candidate.candidate.candidate_id);
    const discoveredMarkdownOutput: string[] = [];
    assert.equal(await runCLI(["review", "--cwd", reviewWorktree, "--config", config, "--markdown"], { stdout: (line) => discoveredMarkdownOutput.push(line), stderr: () => undefined }), 0);
    assert.equal(discoveredMarkdownOutput.join("\n"), markdown);
    assert.equal(createHash("sha256").update(readFileSync(database)).digest("hex"), databaseDigestBeforeDiscovery);
    assert.equal(createHash("sha256").update(readFileSync(reviewMarker)).digest("hex"), markerDigestBeforeDiscovery);
    assert.deepEqual(readdirSync(reviewWorktree).sort(), worktreeEntriesBeforeDiscovery);
  } finally {
    if (fixture) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("command-family help lists actions and link mode explains its behavior", async () => {
  const candidateOutput: string[] = [];
  const candidateStatus = await runCLI(["candidate", "--help", "--json"], {
    stdout: (line) => candidateOutput.push(line), stderr: () => undefined,
  });
  assert.equal(candidateStatus, 0);
  const candidate = JSON.parse(candidateOutput[0]) as { data: { usage: string } };
  assert.match(candidate.data.usage, /candidate template/);
  assert.match(candidate.data.usage, /candidate materialize/);
  assert.match(candidate.data.usage, /candidate <操作> --help/);

  const devRunOutput: string[] = [];
  const devRunStatus = await runCLI(["devrun", "--help", "--json"], {
    stdout: (line) => devRunOutput.push(line), stderr: () => undefined,
  });
  assert.equal(devRunStatus, 0);
  assert.match((JSON.parse(devRunOutput[0]) as { data: { usage: string } }).data.usage, /devrun cleanup/);

  const installOutput: string[] = [];
  const installStatus = await runCLI(["install", "skill", "--help", "--json"], {
    stdout: (line) => installOutput.push(line), stderr: () => undefined,
  });
  assert.equal(installStatus, 0);
  const install = JSON.parse(installOutput[0]) as { data: { usage: string } };
  assert.match(install.data.usage, /--link/);
  assert.match(install.data.usage, /canonical/);

  const reviewOutput: string[] = [];
  assert.equal(await runCLI(["review", "--help", "--json"], { stdout: (line) => reviewOutput.push(line), stderr: () => undefined }), 0);
  const reviewUsage = (JSON.parse(reviewOutput[0]) as { data: { usage: string } }).data.usage;
  assert.match(reviewUsage, /^grounds review \[candidate-id\]/);
  assert.match(reviewUsage, /--markdown/);
  assert.doesNotMatch(reviewUsage, /review ask/);

  const removedAskOutput: string[] = [];
  assert.equal(await runCLI(["review", "ask", "why?", "--json"], { stdout: (line) => removedAskOutput.push(line), stderr: () => undefined }), 2);
  assert.equal((JSON.parse(removedAskOutput[0]) as { error: { details: { field: string } } }).error.details.field, "command");
});

test("--version prints the package version under the stable contract", async () => {
  const output: string[] = [];
  const status = await runCLI(["--version", "--json"], {
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });
  assert.equal(status, 0);
  const envelope = JSON.parse(output[0]) as { ok: boolean; data: { command: string; version: string } };
  assertContract("cli-envelope.schema.json", envelope);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.command, "version");
  assert.match(envelope.data.version, /^\d+\.\d+\.\d+/);
});

test("ledger show with an invalid ID points the caller at ledger list", async () => {
  const output: string[] = [];
  const status = await runCLI(["ledger", "show", "not-a-uuid", "--json"], {
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });
  assert.equal(status, 2);
  const envelope = JSON.parse(output[0]) as { ok: boolean; error?: { details?: { field?: string; reason?: string } } };
  assertContract("cli-envelope.schema.json", envelope);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.details?.field, "event");
  assert.match(String(envelope.error?.details?.reason), /ledger list/);
});

test("invalid supplied operation IDs fail before opening the configured store", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const status = await runCLI(
    ["repository", "register", "--json", "--operation-id", "not-a-uuid", "--config", "/definitely/missing/grounds-config.yaml"],
    { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) },
  );
  assert.equal(status, 2);
  assert.deepEqual(errors, []);
  const envelope = JSON.parse(output[0]) as { ok: boolean; operation_id?: string; error?: { code: string; details?: { field?: string } } };
  assertContract("cli-envelope.schema.json", envelope);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.operation_id, undefined);
  assert.equal(envelope.error?.code, "VALIDATION_ERROR");
  assert.equal(envelope.error?.details?.field, "operation_id");
});

test("unexpected failures use the stable internal error message", () => {
  const domain = asDomainError(new Error("driver exploded"));
  assert.equal(domain.code, "INTERNAL");
  assert.equal(domain.message, "unexpected internal failure");
  assert.equal(exitCode(domain), 1);
});

test("interactive init uses the same config model as flags", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-cli-test-"));
  try {
    const configFile = join(directory, "config.yaml");
    const databasePath = join(directory, "interactive.db");
    const answers = ["sqlite", "warn", databasePath];
    const questions: string[] = [];
    const result = await execute(["init", "--config", configFile], {
      isTTY: true,
      prompt: async (question) => { questions.push(question); return answers.shift() ?? ""; },
    }) as Record<string, unknown>;
    assert.equal(result.database_action, "initialized");
    assert.equal(questions.length, 3);
    const config = loadConfig(configFile);
    assertContract("config.schema.json", config);
    assert.equal(config.database.driver, "sqlite");
    assert.equal(config.database.path, databasePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MySQL keychain locator is deterministic and secrets stay outside config", () => {
  const database: DatabaseConfig = {
    driver: "mysql",
    host: "MySQL.Example.Internal",
    port: 3306,
    database: "grounds",
    username: "alice",
    tls: { mode: "verify_identity" },
    password: { source: "keychain" },
    expected_database_id: "019c0000-0000-7000-8000-000000000001",
  };
  const locators: string[] = [];
  assert.equal(mysqlPassword(database, (locator) => { locators.push(locator); return "secret"; }), "secret");
  assert.deepEqual(locators, ["mysql://alice@mysql.example.internal:3306/grounds"]);
  assert.equal(mysqlKeychainLocator(database), locators[0]);
  assert.equal(JSON.stringify(database).includes("secret"), false);
});

test("MySQL configuration rejects host padding before opening a connection", () => {
  assert.throws(() => validateConfig({
    version: 2,
    database: {
      driver: "mysql",
      host: " mysql.example.internal",
      port: 3306,
      database: "grounds",
      username: "alice",
      tls: { mode: "verify_identity" },
      password: { source: "environment", variable: "GROUNDS_MYSQL_PASSWORD" },
      expected_database_id: "019c0000-0000-7000-8000-000000000001",
    },
  }), (error) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "database.host");
});

test("configuration validation reports malformed runtime shapes as validation errors", () => {
  assert.throws(() => validateConfig(null), (error) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "config");
  assert.throws(() => validateConfig({ version: 2, database: null }), (error) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "database");
  assert.throws(() => validateConfig({ version: 2, database: { driver: "mysql", host: 123 } }), (error) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "database.host");
});

test("config validation rejects unknown fields even for direct callers", () => {
  assert.throws(() => validateConfig({
    version: 2,
    unexpected: true,
    database: {
      driver: "sqlite",
      path: "/tmp/grounds.db",
      expected_database_id: "019c0000-0000-7000-8000-000000000001",
    },
  }), (error) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "config.unexpected");
});

test("non-interactive MySQL init validates the connection model before opening a pool", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-cli-test-"));
  try {
    const output: string[] = [];
    const status = await runCLI([
      "init", "--driver", "mysql", "--non-interactive", "--json",
      "--config", join(directory, "config.yaml"), "--host", "db.example.test",
      "--port", "99999", "--database", "grounds", "--username", "alice",
      "--password-source", "environment",
    ], { stdout: (line) => output.push(line), stderr: () => undefined });
    assert.equal(status, 2);
    const envelope = JSON.parse(output[0]) as { ok: boolean; error?: { code: string; details: { field?: string } } };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, "VALIDATION_ERROR");
    assert.equal(envelope.error?.details.field, "database.port");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("numeric CLI options reject non-decimal integer spellings before storage access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-cli-test-"));
  try {
    const output: string[] = [];
    const status = await runCLI([
      "init", "--driver", "mysql", "--non-interactive", "--json",
      "--config", join(directory, "config.yaml"), "--host", "db.example.test",
      "--port", "1e3", "--database", "grounds", "--username", "alice",
      "--password-source", "environment",
    ], { stdout: (line) => output.push(line), stderr: () => undefined });
    assert.equal(status, 2);
    const envelope = JSON.parse(output[0]) as { ok: boolean; error?: { code: string; details: { field?: string } } };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, "VALIDATION_ERROR");
    assert.equal(envelope.error?.details.field, "port");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file options accept the documented stdin sentinel", () => {
  const parsed = parseArgs(["issue", "create", "--requirement", "019c0000-0000-7000-8000-000000000001", "--file", "-"]);
  assert.equal(parsed.values.file, "-");
  assert.deepEqual(parsed.positionals, ["issue", "create"]);
});

test("boolean option values are case-insensitive in execution", async () => {
  const output: string[] = [];
  const status = await runCLI(
    ["config", "path", "--json=TRUE", "--config", "/tmp/grounds-test-config.yaml"],
    { stdout: (line) => output.push(line), stderr: () => undefined },
  );
  assert.equal(status, 0);
  assert.equal(JSON.parse(output[0]).ok, true);
});

test("explicit empty config and SQLite paths fail before filesystem access", async () => {
  const configOutput: string[] = [];
  const configStatus = await runCLI(
    ["config", "path", "--json", "--config="],
    { stdout: (line) => configOutput.push(line), stderr: () => undefined },
  );
  assert.equal(configStatus, 2);
  const configEnvelope = JSON.parse(configOutput[0]) as { ok: boolean; error?: { code: string; details?: { field?: string } } };
  assert.equal(configEnvelope.ok, false);
  assert.equal(configEnvelope.error?.code, "VALIDATION_ERROR");
  assert.equal(configEnvelope.error?.details?.field, "config");

  const initOutput: string[] = [];
  const initStatus = await runCLI(
    ["init", "--driver", "sqlite", "--non-interactive", "--json", "--config", "/tmp/grounds-empty-path-config.yaml", "--path="],
    { stdout: (line) => initOutput.push(line), stderr: () => undefined },
  );
  assert.equal(initStatus, 2);
  const initEnvelope = JSON.parse(initOutput[0]) as { ok: boolean; error?: { code: string; details?: { field?: string } } };
  assert.equal(initEnvelope.ok, false);
  assert.equal(initEnvelope.error?.code, "VALIDATION_ERROR");
  assert.equal(initEnvelope.error?.details?.field, "path");
});

test("CLI rejects the retired --worktree clone selector before opening storage", async () => {
  const output: string[] = [];
  const status = await runCLI(
    ["config", "path", "--worktree", "/tmp/two", "--json"],
    { stdout: (line) => output.push(line), stderr: () => undefined },
  );
  assert.equal(status, 2);
  const envelope = JSON.parse(output[0]) as { ok: boolean; error?: { code: string; details?: { field?: string } } };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "VALIDATION_ERROR");
  assert.equal(envelope.error?.details?.field, "--worktree");
});

test("schema and database identity failures keep their details contract-valid", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-cli-test-"));
  try {
    const configFile = join(directory, "config.yaml");
    const databasePath = join(directory, "uninitialized.db");
    writeConfig(configFile, {
      version: 2,
      database: {
        driver: "sqlite",
        path: databasePath,
        expected_database_id: "019c0000-0000-7000-8000-000000000001",
      },
    });
    const schemaOutput: string[] = [];
    const schemaStatus = await runCLI(["db", "test", "--config", configFile, "--json"], { stdout: (line) => schemaOutput.push(line), stderr: () => undefined });
    assert.equal(schemaStatus, 5);
    const schemaEnvelope = JSON.parse(schemaOutput[0]) as { ok: boolean; error?: { code?: string; details?: Record<string, unknown> } };
    assertContract("cli-envelope.schema.json", schemaEnvelope);
    assert.equal(schemaEnvelope.error?.code, "SCHEMA_INCOMPATIBLE");
    assert.equal(schemaEnvelope.error?.details?.required_version, String(SCHEMA_VERSION));

    const initializedConfig = join(directory, "initialized-config.yaml");
    const initializedDatabase = join(directory, "initialized.db");
    const initOutput: string[] = [];
    assert.equal(await runCLI(["init", "--driver", "sqlite", "--non-interactive", "--config", initializedConfig, "--path", initializedDatabase, "--json"], { stdout: (line) => initOutput.push(line), stderr: () => undefined }), 0);
    const initialized = loadConfig(initializedConfig);
    writeConfig(initializedConfig, { ...initialized, database: { ...initialized.database, expected_database_id: "019c0000-0000-7000-8000-000000000002" } }, true);
    const identityOutput: string[] = [];
    const identityStatus = await runCLI(["db", "test", "--config", initializedConfig, "--json"], { stdout: (line) => identityOutput.push(line), stderr: () => undefined });
    assert.equal(identityStatus, 5);
    const identityEnvelope = JSON.parse(identityOutput[0]) as { ok: boolean; error?: { code?: string; details?: Record<string, unknown> } };
    assertContract("cli-envelope.schema.json", identityEnvelope);
    assert.equal(identityEnvelope.error?.code, "DATABASE_ID_MISMATCH");
    assert.deepEqual(Object.keys(identityEnvelope.error?.details ?? {}), ["reason"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repository move rejects both canonical remote option spellings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-cli-test-"));
  try {
    const configFile = join(directory, "config.yaml");
    await execute(["init", "--driver", "sqlite", "--non-interactive", "--config", configFile, "--path", join(directory, "ledger.db")]);
    const output: string[] = [];
    const status = await runCLI([
      "repository", "move", "--json", "--config", configFile,
      "--repository", "019c0000-0000-7000-8000-000000000001",
      "--canonical-remote", "https://example.test/one",
      "--remote-url", "https://example.test/two",
      "--operation-id", "019c0000-0000-7000-8000-000000000002",
      "--agent-id", "agent", "--agent-name", "agent",
    ], { stdout: (line) => output.push(line), stderr: () => undefined });
    assert.equal(status, 2);
    const envelope = JSON.parse(output[0]) as { ok: boolean; error?: { code?: string; details?: { field?: string } } };
    assertContract("cli-envelope.schema.json", envelope);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, "VALIDATION_ERROR");
    assert.equal(envelope.error?.details?.field, "canonical-remote");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("candidate artifact help advertises only supported Git artifacts", async () => {
  for (const json of [false, true]) {
    const output: string[] = [], errors: string[] = [];
    assert.equal(await runCLI(["candidate", "artifact", "--help", ...(json ? ["--json"] : [])], {
      stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
    }), 0);
    assert.deepEqual(errors, []);
    const help = json ? JSON.stringify(JSON.parse(output[0]).data) : output.join("\n");
    assert.match(help, /protected remote Git source/);
    assert.match(help, /historical patch-only Candidates are unsupported/);
    assert.doesNotMatch(help, /legacy base\/SQL patch\/tree/);
  }
});

test("integration source help requires exact Git history and retires patch-only", async () => {
  for (const json of [false, true]) {
    const output: string[] = [];
    assert.equal(await runCLI(["integration", "observe", "--help", ...(json ? ["--json"] : [])], {
      stdout: (line) => output.push(line), stderr: () => undefined,
    }), 0);
    const usage = json ? JSON.stringify(JSON.parse(output[0]).data) : output.join("\n");
    assert.match(usage, /managed source must match archived commit\/ordered parents\/result tree and contain Candidate base/);
    assert.match(usage, /requires the exact source commit of the Git artifact/);
    assert.doesNotMatch(usage, /single parent must equal Candidate base/);
  }
  const design = readFileSync(new URL("../../GROUNDS_DESIGN.md", import.meta.url), "utf8")
    .split("### 4.4 Review、比较、选择与交付")[1].split("## 5.")[0];
  assert.match(design, /新受管 source Candidate[\s\S]*完整 OID、ordered parents[\s\S]*Candidate 逻辑 base/);
  assert.match(design, /允许正常多提交和真实 merge，不要求直接父等于 base，也不限制为单父/);
  assert.match(design, /历史 patch-only Candidate 已退出交付支持范围/);
});
