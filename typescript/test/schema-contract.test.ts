import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Module } from "../src/module.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const filesBelow = (directory: string): string[] => readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
  .sort();

test("bundled plugin v1 contracts exactly mirror the canonical documentation contracts", () => {
  const canonical = join(repositoryRoot, "docs/contracts/v1");
  const bundled = join(repositoryRoot, "plugins/grounds/references/contracts/v1");
  const canonicalFiles = filesBelow(canonical);
  assert.deepEqual(filesBelow(bundled), canonicalFiles);
  for (const file of canonicalFiles) {
    assert.deepEqual(readFileSync(join(bundled, file)), readFileSync(join(canonical, file)), file);
  }
});

test("core lifecycle command, context, and query projections satisfy v1 schemas", async () => {
  const fixture = await LedgerFixture.create();
  try {
    assertContract("command-results.schema.json", fixture.repository);

    const candidate = await fixture.submitCandidate();
    const verification = await fixture.verify(candidate);
    assertContract("command-results.schema.json", candidate.run);
    assertContract("command-results.schema.json", candidate.candidate);
    assertContract("command-results.schema.json", verification);
    assertContract("devrun-context.schema.json", candidate.run.context);

    const blind = await fixture.module.verificationContext(candidate.candidate.candidate_id, "blind");
    const reconcile = await fixture.module.verificationContext(candidate.candidate.candidate_id, "reconcile");
    assertContract("command-results.schema.json", blind);
    assertContract("command-results.schema.json", reconcile);
    assertContract("verification-context.schema.json", blind.context);
    assertContract("verification-context.schema.json", reconcile.context);

    for (const query of [
      await fixture.module.showRepository(fixture.repository.repository_id),
      await fixture.module.showRequirement(fixture.requirement.requirement_id),
      await fixture.module.showIssue(fixture.issue.issue_id),
      await fixture.module.showDevRun(candidate.run.context.dev_run.id),
      await fixture.module.showCandidate(candidate.candidate.candidate_id),
      await fixture.module.reviewCandidate(candidate.candidate.candidate_id),
      await fixture.module.showVerification(verification.verification_id),
      await fixture.module.listLedger(),
    ]) assertContract("query-results.schema.json", query);

    for (const list of [
      await fixture.module.listRequirements(),
      await fixture.module.listRepositories(),
      await fixture.module.listIssues(fixture.requirement.requirement_id),
      await fixture.module.listDevRuns(fixture.issue.issue_id),
      await fixture.module.listCandidates(fixture.issue.issue_revision_id),
      await fixture.module.listVerifications(candidate.candidate.candidate_id),
    ]) assertContract("command-results.schema.json", list);

    const comparisonModule = new Module(fixture.store, newUUIDv7, async () => ({ patch: Buffer.alloc(0), files: 0, insertions: 0, deletions: 0, binary: false, too_large: false }));
    const second = await fixture.submitCandidate("two");
    assertContract("query-results.schema.json", await comparisonModule.compareCandidates([candidate.candidate.candidate_id, second.candidate.candidate_id]));
  } finally {
    await fixture.close();
  }
});

test("candidate materialization modes satisfy the command result contract", () => {
  const common = {
    result_type: "patchledger.result.candidate-materialize/v1",
    command: "candidate.materialize",
    candidate_id: newUUIDv7(),
    result_tree_oid: `sha1:${"1".repeat(40)}`,
  };
  assertContract("command-results.schema.json", {
    ...common,
    target_path: "/tmp/grounds-review",
    materialization_mode: "review",
  });
  assertContract("command-results.schema.json", {
    ...common,
    target_path: "/tmp/grounds-delivery",
    materialization_mode: "delivery",
    branch: "grounds/candidate/example",
  });
});

test("local DevRun worktree statuses and cleanup satisfy the command result contract", () => {
  const devRunId = newUUIDv7();
  for (const localWorktree of [
    { status: "available", path: "/tmp/grounds-devrun" },
    { status: "missing", reason: "not_available_on_this_machine" },
    { status: "missing", reason: "local_worktree_deleted" },
    { status: "invalid", reason: "local state is corrupt" },
    { status: "removed" },
  ]) assertContract("command-results.schema.json", {
    result_type: "patchledger.result.devrun-worktree-cleanup/v1",
    command: "devrun.cleanup",
    dev_run_id: devRunId,
    removed: false,
    local_worktree: localWorktree,
  });
});

test("a removed worktree must carry its deletion summary and a kept one must not", () => {
  const base = { result_type: "patchledger.result.devrun-worktree-cleanup/v1", command: "devrun.cleanup", dev_run_id: newUUIDv7(), local_worktree: { status: "removed" } };
  const summary = { dev_run_id: base.dev_run_id, worktree_path: "/tmp/grounds-devrun", discard_changes: false, entry_count: 12, occurred_at: "2026-10-13T00:00:00.000Z" };
  assertContract("command-results.schema.json", { ...base, removed: true, deletion_summary: summary });
  assertContract("command-results.schema.json", { ...base, removed: false });
  assertContract("command-results.schema.json", { ...base, removed: false, external_preserved: true });
  assert.throws(() => assertContract("command-results.schema.json", { ...base, removed: true }));
  assert.throws(() => assertContract("command-results.schema.json", { ...base, removed: false, deletion_summary: summary }));
  assert.throws(() => assertContract("command-results.schema.json", { ...base, removed: true, deletion_summary: { ...summary, entry_count: -1 } }));
});

test("standalone help satisfies the command result contract", () => {
  assertContract("command-results.schema.json", {
    result_type: "patchledger.result.help/v1",
    command: "help",
    usage: "grounds init | requirement | repository | issue | devrun | candidate | verification | ledger | db | config",
  });
});

test("query results do not expose a natural-language review answer contract", () => {
  // Keep the complete retired shape: a malformed payload would be rejected even
  // if reviewAnswer were accidentally added back to the query-result union.
  assert.throws(() => assertContract("query-results.schema.json", {
    result_type: "patchledger.result.review-answer/v1",
    command: "review.ask",
    answer: {
      format: "patchledger.review-answer/v1",
      candidate_id: newUUIDv7(),
      question: "why?",
      topic: "why",
      scope: { kind: "candidate" },
      status: "answered",
      summary: "The author recorded a purpose.",
      statements: [{ source: "author_claim", text: "The author recorded a purpose.", refs: [] }],
      caveats: [],
    },
  }));
});
