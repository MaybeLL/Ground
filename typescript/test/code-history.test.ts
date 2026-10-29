import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, runCLI } from "../src/cli.js";
import { SQLStore } from "../src/sql-store.js";
import { Module } from "../src/module.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { deriveLocalGitArtifact } from "../src/git-artifact-local.js";
import { captureArtifact } from "../src/git.js";
import { captureCommittedCandidate, retainCandidateSource } from "../src/development-branch.js";
import type { CandidateSubmissionV2Input } from "../src/domain.js";
import { assertContract } from "./schema-fixture.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "grounds-history-"));
  const repo = join(root, "repo"); const config = join(root, "config.yaml");
  execFileSync("git", ["init", "-q", repo]);
  git(repo, "config", "user.name", "History Test"); git(repo, "config", "user.email", "history@example.test");
  git(repo, "remote", "add", "origin", "ssh://git@example.test/team/repo");
  writeFileSync(join(repo, ".git/info/exclude"), "/.grounds/\n");
  writeFileSync(join(repo, "refund.ts"), "export function refund(days: number) {\n  return days > 30 ? 'manual' : 'automatic';\n}\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Initial refund");
  await execute(["init", "--driver", "sqlite", "--path", join(root, "ledger.db"), "--config", config, "--non-interactive", "--json"], { cwd: repo });
  await execute(["repository", "register", "--config", config, "--json"], { cwd: repo });
  const invoke = async (...args: string[]) => {
    const output: string[] = [];
    const code = await runCLI([...args, "--config", config, "--json"], { cwd: repo, stdout: s => output.push(s), stderr: () => {} });
    const envelope = JSON.parse(output.join("\n"));
    assertContract("cli-envelope.schema.json", envelope);
    if (code === 0) assertContract("command-results.schema.json", envelope.data);
    else assertContract("error.schema.json", envelope.error);
    return { code, ...envelope };
  };
  return { root, repo, config, invoke, close: () => rmSync(root, { recursive: true, force: true }) };
}

async function candidate(f: Awaited<ReturnType<typeof setup>>, content: string) {
  const ledger = await LedgerFixture.createWithStore(SQLStore.sqlite(join(f.root, "ledger.db")));
  try {
    const baseline = `sha1:${git(f.repo, "rev-parse", "HEAD")}`;
    const issue = await ledger.module.reviseIssue({ operation_id: newUUIDv7(), issue_id: ledger.issue.issue_id, expected_predecessor_id: ledger.issue.issue_revision_id, requirement_revision_id: ledger.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: { git_oid: baseline, reachability: "unconfirmed", warning: "fixture", override_reason: "fixture" }, input: { format: 1, summary: "Extend automated refund window", goals: [{ statement: "Use sixty days", criteria: ["Manual refunds start after sixty days"], traces_to: [{ type: "outcome", ordinal: 1 }] }] }, attribution: testAgent });
    const run = await ledger.module.startDevRun({ operation_id: newUUIDv7(), issue_id: ledger.issue.issue_id, issue_revision_id: issue.result.issue_revision_id, issue_revision_explicit: true, repository_remote_snapshot: ledger.repository.canonical_remote, attribution: testAgent });
    writeFileSync(join(f.repo, "refund.ts"), content);
    git(f.repo, "add", "-A"); git(f.repo, "commit", "--allow-empty", "-qm", "fixed candidate");
    const fixed = captureCommittedCandidate(f.repo, baseline), artifact = fixed.artifact;
    const submission = (await ledger.module.candidateSubmissionTemplate(run.result.context.dev_run.id, artifact)).submission as CandidateSubmissionV2Input;
    submission.explanation = "The payment channel now supports sixty days";
    for (const claim of submission.claims) { claim.explanation = "Extended the window"; for (const criterion of claim.criteria) criterion.explanation = "The threshold is sixty"; }
    for (const rationale of submission.change_rationales) { rationale.rationale = "The payment channel extended the automatic refund window"; rationale.target_refs = [{ type: "criterion", id: submission.claims[0].criteria[0].criterion_id }]; }
    const submitted = await ledger.module.submitCandidate({ ...ledger.gitCandidateFields(artifact, baseline, fixed.source), operation_id: newUUIDv7(), dev_run_id: run.result.context.dev_run.id, expected_version: 1, submission, artifact, attribution: testAgent });
    retainCandidateSource(f.repo, submitted.candidate_id, fixed.source);
    git(f.repo, "reset", "--mixed", baseline.slice(5));
    return { source: fixed.source, id: submitted.candidate_id, issue: issue.result, requirement: ledger.requirement, baseline, artifact };
  } finally { await ledger.close(); }
}

test("pasted code locates the current source without inventing a historical Candidate", async () => {
  const f = await setup();
  try {
    const snippet = join(f.root, "snippet.txt");
    writeFileSync(snippet, "  return days > 30 ? 'manual' : 'automatic';\n");
    const result = await f.invoke("trace", "--snippet-file", snippet);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.result_type, "patchledger.result.code-history-trace/v1");
    assert.equal(result.data.locations.resolution, "unique_in_scan");
    assert.deepEqual(result.data.locations.matches.map((x: any) => [x.path, x.start_line, x.end_line]), [["refund.ts", 2, 2]]);
    assert.equal(result.data.segments.length, 0);
    assert.equal(result.data.coverage.candidate_search_complete, true);
    assert.equal(result.data.source.commit_oid, git(f.repo, "rev-parse", "HEAD"));
  } finally { f.close(); }
});

test("an explicit location distinguishes an uncommitted rule from Git history", async () => {
  const f = await setup();
  try {
    writeFileSync(join(f.repo, "refund.ts"), "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "refund.ts");
    const result = await f.invoke("trace", "--at", "refund.ts:2-2");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.locations.resolution, "explicit");
    assert.deepEqual(result.data.coverage.local_only, [{ path: "refund.ts", start_line: 2, end_line: 2 }]);
    assert.deepEqual(result.data.source.index, { staged_paths: ["refund.ts"], unmerged_paths: [] });
    assert.equal(result.data.segments.length, 0);
    assert.equal(git(f.repo, "diff", "--cached", "--name-only"), "refund.ts");
  } finally { f.close(); }
});

test("a recorded delivery connects current code to its historical Candidate and contract", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Extend window");
    const commit = git(f.repo, "rev-parse", "HEAD");
    const recorded = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", commit, "--expected-version", "0");
    assert.equal(recorded.code, 0, JSON.stringify(recorded));
    const traced = await f.invoke("trace", "--at", "refund.ts:2-2");
    assert.equal(traced.code, 0, JSON.stringify(traced));
    const segment = traced.data.segments.find((s: any) => s.candidate_id === c.id);
    assert.ok(segment, JSON.stringify(traced));
    assert.equal(segment.origin, "recorded_delivery");
    assert.equal(segment.connection, "mapped");
    assert.equal(segment.issue_id, c.issue.issue_id);
    assert.equal(segment.requirement_id, c.requirement.requirement_id);
    const reviewed = await f.invoke(...segment.review_argv);
    assert.equal(reviewed.code, 0, JSON.stringify(reviewed));
    assert.equal(reviewed.data.trace.contract.issue.version, 2);
    assert.match(reviewed.data.trace.location.rationales[0].rationale, /payment channel/);
  } finally { f.close(); }
});

test("later line shifts map current code to the old Candidate line without attributing a replaced rule", async () => {
  const f = await setup();
  try {
    const content = "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n";
    const c = await candidate(f, content);
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Extend window");
    assert.equal((await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0")).code, 0);
    writeFileSync(join(f.repo, "refund.ts"), "// Refund policy\n" + content);
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Document policy");
    const traced = await f.invoke("trace", "--at", "refund.ts:3");
    assert.equal(traced.code, 0, JSON.stringify(traced));
    assert.equal(traced.data.segments[0]?.candidate_id, c.id);
    assert.ok(traced.data.segments[0].review_argv.includes("refund.ts:2"));
    writeFileSync(join(f.repo, "refund.ts"), ("// Refund policy\n" + content).replace("> 60", "> 90"));
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Replace rule outside ledger");
    assert.equal((await f.invoke("trace", "--at", "refund.ts:3")).data.segments.filter((s: any) => s.origin === "recorded_delivery").length, 0);
  } finally { f.close(); }
});

test("a materialized Review snapshot is explained before ordinary dirty-worktree classification", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    const target = join(f.root, "review");
    assert.equal((await f.invoke("candidate", "materialize", c.id, "--mode", "review", "--path", target)).code, 0);
    const traced = await f.invoke("trace", "--cwd", target, "--at", "refund.ts:2");
    assert.equal(traced.code, 0, JSON.stringify(traced));
    assert.equal(traced.data.segments[0]?.origin, "review_snapshot");
    assert.equal(traced.data.segments[0]?.candidate_id, c.id);
    assert.deepEqual(traced.data.coverage.local_only, []);
    writeFileSync(join(target, "refund.ts"), "drifted\n");
    const drifted = await f.invoke("trace", "--cwd", target, "--at", "refund.ts:1");
    assert.equal(drifted.error.code, "WORKTREE_MISMATCH");
  } finally { f.close(); }
});

test("delivery recording is idempotent and withdrawing preserves history while stopping attribution", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Adopt");
    const args = ["delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0", "--operation-id", newUUIDv7()];
    const recorded = await f.invoke(...args);
    assert.equal(recorded.code, 0, JSON.stringify(recorded));
    assert.deepEqual((await f.invoke(...args)).data, recorded.data);
    const id = recorded.data.link.id;
    assert.equal((await f.invoke("delivery-link", "withdraw", id, "--expected-version", "0", "--reason", "Wrong attribution")).code, 4);
    const withdrawn = await f.invoke("delivery-link", "withdraw", id, "--expected-version", "1", "--reason", "Wrong attribution");
    assert.equal(withdrawn.code, 0, JSON.stringify(withdrawn));
    assert.equal(withdrawn.data.link.version, 2);
    assert.equal(withdrawn.data.link.state, "withdrawn");
    const old = await f.invoke("delivery-link", "show", id, "--version", "1");
    assert.equal(old.data.link.state, "recorded");
    assert.equal((await f.invoke("trace", "--at", "refund.ts:2")).data.segments.filter((s: any) => s.origin === "recorded_delivery").length, 0);
    const audit = await f.invoke("ledger", "list", "--subject-type", "delivery_link", "--subject-id", id);
    assert.equal(audit.code, 0, JSON.stringify(audit));
    assert.equal(audit.data.events.length, 2);
    const status = await f.invoke("db", "status");
    assert.equal(status.code, 0, JSON.stringify(status));
    assert.equal(status.data.integrity.valid, true, JSON.stringify(status));
  } finally { f.close(); }
});

test("an identical historical Candidate without a delivery record is a lead, not confirmed provenance", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Unrecorded delivery");
    const result = await f.invoke("trace", "--at", "refund.ts:2");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.segments[0]?.candidate_id, c.id);
    assert.equal(result.data.segments[0]?.origin, "unrecorded");
    assert.equal(result.data.segments[0]?.content, "exact_artifact");
  } finally { f.close(); }
});

test("delivery can include unrelated changes while preserving exact Candidate change units", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    writeFileSync(join(f.repo, "notes.txt"), "An unrelated change\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Combined changes");
    const result = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.link.content, "exact_scope");
    assert.equal((await f.invoke("trace", "--at", "refund.ts:2")).data.segments[0]?.origin, "recorded_delivery");
  } finally { f.close(); }
});

test("delivery maps a complete change unit despite independent same-file insertions", async () => {
  const f = await setup();
  try {
    const prefix = Array.from({ length: 10 }, (_, i) => `// Stable heading ${i}\n`).join("");
    const initial = "export function refund(days: number) {\n  return days > 30 ? 'manual' : 'automatic';\n}\n";
    writeFileSync(join(f.repo, "refund.ts"), prefix + initial);
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Add headings");
    const c = await candidate(f, prefix + initial.replace("> 30", "> 60"));
    writeFileSync(join(f.repo, "refund.ts"), "// Independent note\n" + prefix + initial.replace("> 30", "> 60"));
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Adopt plus note");
    const result = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
    assert.equal(result.code, 0, JSON.stringify(result));
    const traced = await f.invoke("trace", "--at", "refund.ts:13");
    assert.equal(traced.data.segments[0]?.candidate_id, c.id);
    assert.ok(traced.data.segments[0].review_argv.includes("refund.ts:12"));
  } finally { f.close(); }
});

test("an incomplete snippet scan never claims a unique location", async () => {
  const f = await setup();
  try {
    const snippet = join(f.root, "snippet.txt");
    writeFileSync(snippet, "  return days > 30 ? 'manual' : 'automatic';\n");
    writeFileSync(join(f.repo, "large.ts"), "x".repeat(2 * 1024 * 1024 + 1));
    const result = await f.invoke("trace", "--snippet-file", snippet);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.locations.resolution, "incomplete");
    assert.ok(result.data.limitations.includes("file_size_budget"));
    assert.equal(result.data.segments.length, 0);
  } finally { f.close(); }
});

test("explicit source locations cannot escape the repository through paths or links", async () => {
  const f = await setup();
  try {
    writeFileSync(join(f.root, "outside.ts"), "outside\n");
    symlinkSync(join(f.root, "outside.ts"), join(f.repo, "linked.ts"));
    for (const path of ["../outside.ts", "linked.ts"]) {
      const result = await f.invoke("trace", "--path", path, "--start-line", "1");
      assert.equal(result.code, 2, JSON.stringify(result));
      assert.equal(result.error.code, "VALIDATION_ERROR");
    }
  } finally { f.close(); }
});

test("Review tracing rejects custom clean filters before they can execute", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    const target = join(f.root, "filtered-review");
    assert.equal((await f.invoke("candidate", "materialize", c.id, "--mode", "review", "--path", target)).code, 0);
    const sentinel = join(f.root, "filter-ran");
    git(f.repo, "config", "filter.test.clean", `touch '${sentinel}'; cat`);
    writeFileSync(join(f.repo, ".git/info/attributes"), "*.ts filter=test\n");
    const result = await f.invoke("trace", "--cwd", target, "--at", "refund.ts:2");
    assert.equal(existsSync(sentinel), false);
    assert.equal(result.code, 6, JSON.stringify(result));
  } finally { f.close(); }
});

test("partial clones are explicitly unsupported instead of implicitly fetching missing history", async () => {
  const f = await setup();
  try {
    git(f.repo, "config", "remote.origin.promisor", "true");
    const result = await f.invoke("trace", "--at", "refund.ts:2");
    assert.equal(result.code, 6, JSON.stringify(result));
    assert.equal(result.error.code, "BASELINE_UNAVAILABLE");
    assert.match(result.error.details.reason, /partial clone/i);
  } finally { f.close(); }
});

test("a fresh clone explicitly receives fixed Git Candidate objects before linking delivery", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    writeFileSync(join(f.repo, "extra.txt"), "Unrelated\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Combined adoption");
    const clone = join(f.root, "fresh");
    execFileSync("git", ["clone", "--no-local", "-q", f.repo, clone]);
    git(clone, "remote", "set-url", "origin", "ssh://git@example.test/team/repo");
    git(clone, "fetch", f.repo, `refs/grounds/candidates/${c.id}:refs/grounds/candidates/${c.id}`);
    const result = await f.invoke("delivery-link", "record", "--cwd", clone, "--candidate", c.id, "--commit", git(clone, "rev-parse", "HEAD"), "--expected-version", "0", "--agent-id", "reader", "--agent-name", "Reader");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.link.content, "exact_scope");
    assert.equal(git(clone, "status", "--porcelain"), "");
  } finally { f.close(); }
});

test("Candidate limits do not turn a uniquely located snippet into a unique provenance claim", async () => {
  const f = await setup();
  try {
    const content = "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n";
    await candidate(f, content); await candidate(f, content);
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Same implementation");
    const result = await f.invoke("trace", "--at", "refund.ts:2", "--limit", "1");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.locations.resolution, "explicit");
    assert.equal(result.data.coverage.candidate_search_complete, false);
    assert.ok(result.data.limitations.includes("candidate_budget"));
    assert.ok(result.data.segments.length <= 1);
  } finally { f.close(); }
});

test("trace exposes a versioned contract with both current and historical source ranges", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Use sixty days");
    const recorded = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
    assertContract("code-history.schema.json", recorded.data);
    const traced = await f.invoke("trace", "--at", "refund.ts:2");
    assert.equal(traced.code, 0, JSON.stringify(traced));
    assertContract("code-history.schema.json", traced.data);
    assertContract("command-results.schema.json", traced.data);
    const segment = traced.data.segments[0];
    assert.deepEqual(segment.source, { path: "refund.ts", start_line: 2, end_line: 2 });
    assert.deepEqual(segment.historical, { path: "refund.ts", start_line: 2, end_line: 2 });
    assert.equal(segment.issue_version, 2);
    assert.equal(segment.requirement_version, 1);
    assert.equal(segment.evidence.delivery_link.version, 1);
    assert.match(traced.data.source.files[0].content_digest, /^sha256:/);
  } finally { f.close(); }
});

test("after preparing a fixed Git delivery the CLI can resolve the Candidate from its validated receipt", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    assert.equal((await f.invoke("selection", "set", "--issue", c.issue.issue_id, "--issue-version", "2", "--candidate", c.id, "--expected-version", "0", "--reason", "Adopt this implementation")).code, 0);
    const target = join(f.root, "delivery");
    assert.equal((await f.invoke("selection", "materialize", "--issue", c.issue.issue_id, "--issue-version", "2", "--expected-version", "1", "--path", target)).code, 0);
    assert.equal(git(target, "rev-parse", "HEAD"), c.source.commit.slice(5));
    const recordArgs = ["delivery-link", "record", "--cwd", target, "--commit", git(target, "rev-parse", "HEAD"), "--expected-version", "0", "--operation-id", newUUIDv7()];
    const linked = await f.invoke(...recordArgs);
    assert.equal(linked.code, 0, JSON.stringify(linked));
    assert.equal(linked.data.link.candidate_id, c.id);
    rmSync(git(target, "rev-parse", "--git-path", "grounds-delivery.json"));
    const retry = await f.invoke(...recordArgs);
    assert.equal(retry.code, 0, JSON.stringify(retry));
    assert.deepEqual(retry.data, linked.data);
    const differentOperation = [...recordArgs]; differentOperation[differentOperation.indexOf("--operation-id") + 1] = newUUIDv7();
    assert.equal((await f.invoke(...differentOperation)).error?.code, "VALIDATION_ERROR");
  } finally { f.close(); }
});

test("the Work Module rejects delivery evidence pointing at nonexistent change units", async () => {
  const f = await setup();
  const store = SQLStore.sqlite(join(f.root, "ledger.db"));
  store.setGitArtifactResolver(ref => deriveLocalGitArtifact(f.repo, ref.git_artifact!.binding));
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Adopt");
    const recorded = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
    const { id, version, state, updated_at, attribution, ...proof } = recorded.data.link;
    proof.units[0].change_unit_id = `sha256:${"0".repeat(64)}`;
    await assert.rejects(new Module(store).recordDeliveryLink({ operation_id: newUUIDv7(), expected_version: 1, attribution: testAgent, proof }), { code: "VALIDATION_ERROR" });
    assert.equal((await f.invoke("delivery-link", "show", id)).data.link.version, 1);
  } finally { await store.close(); f.close(); }
});

test("pasted code with a shared indentation shift locates the original block", async () => {
  const f = await setup();
  try {
    const snippet = join(f.root, "snippet.txt");
    writeFileSync(snippet, "    export function refund(days: number) {\n      return days > 30 ? 'manual' : 'automatic';\n    }\n");
    const result = await f.invoke("trace", "--snippet-file", snippet);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.locations.resolution, "unique_in_scan");
    assert.deepEqual(result.data.locations.matches, [{ path: "refund.ts", start_line: 1, end_line: 3 }]);
  } finally { f.close(); }
});

test("trace rejects conflicting selectors, phantom lines, oversized snippets and binary source", async () => {
  const f = await setup();
  try {
    const snippet = join(f.root, "snippet.txt"); writeFileSync(snippet, "x".repeat(65537));
    writeFileSync(join(f.repo, "binary.ts"), Buffer.from([0, 255, 10]));
    for (const args of [["--at", "refund.ts:2", "--path", "refund.ts"], ["--at", "refund.ts:4"], ["--snippet-file", snippet], ["--at", "binary.ts:1"], ["--snippet-file", snippet, "--start-line", "1"]]) {
      const result = await f.invoke("trace", ...args);
      assert.equal(result.code, 2, JSON.stringify({ args, result }));
      assert.equal(result.error.code, "VALIDATION_ERROR");
    }
  } finally { f.close(); }
});

test("repeated snippet locations are bounded and reported as an incomplete scan", async () => {
  const f = await setup();
  try {
    const snippet = join(f.root, "snippet.txt"); writeFileSync(snippet, "repeated();\n");
    writeFileSync(join(f.repo, "repeat.ts"), "repeated();\n".repeat(513));
    const result = await f.invoke("trace", "--snippet-file", snippet);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.locations.resolution, "incomplete");
    assert.equal(result.data.locations.matches.length, 512);
    assert.ok(result.data.limitations.includes("location_budget"));
  } finally { f.close(); }
});

test("persisted delivery records fail closed when their validated structure is corrupted", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Adopt");
    const recorded = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
    const { DatabaseSync } = await import("node:sqlite");
    const { sha256 } = await import("../src/canonical-json.js");
    const invalid = { ...recorded.data.link, state: "fabricated" };
    const raw = new DatabaseSync(join(f.root, "ledger.db"));
    raw.prepare("UPDATE delivery_link_versions SET record_json=?, record_digest=? WHERE link_id=?").run(JSON.stringify(invalid), sha256(invalid), invalid.id); raw.close();
    const result = await f.invoke("delivery-link", "show", invalid.id);
    assert.equal(result.error?.code, "ARTIFACT_INTEGRITY_ERROR");
  } finally { f.close(); }
});

test("trace revalidates recorded Git evidence instead of trusting a structurally valid assertion", async () => {
  const f = await setup(); const store = SQLStore.sqlite(join(f.root, "ledger.db"));
  store.setGitArtifactResolver(ref => deriveLocalGitArtifact(f.repo, ref.git_artifact!.binding));
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Adopt");
    const recorded = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
    const { id, version, state, updated_at, attribution, ...proof } = recorded.data.link;
    proof.parent_oid = "1".repeat(40);
    await new Module(store).recordDeliveryLink({ operation_id: newUUIDv7(), expected_version: 1, attribution: testAgent, proof });
    const result = await f.invoke("trace", "--at", "refund.ts:2");
    assert.equal(result.error?.code, "ARTIFACT_INTEGRITY_ERROR");
  } finally { await store.close(); f.close(); }
});

test("a merge boundary leaves explicit unexplained coverage instead of a complete provenance claim", async () => {
  const f = await setup();
  try {
    const branch = git(f.repo, "branch", "--show-current");
    git(f.repo, "checkout", "-qb", "side"); writeFileSync(join(f.repo, "side.txt"), "side\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Side");
    git(f.repo, "checkout", "-q", branch); writeFileSync(join(f.repo, "main.txt"), "main\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Main"); git(f.repo, "merge", "--no-ff", "-qm", "Merge", "side");
    const result = await f.invoke("trace", "--at", "refund.ts:2");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.coverage.candidate_search_complete, false);
    assert.ok(result.data.limitations.includes("history_mapping_unresolved"));
    assert.deepEqual(result.data.coverage.unexplained, [{ path: "refund.ts", start_line: 2, end_line: 2 }]);
  } finally { f.close(); }
});

test("large Review queries stop at the output budget without claiming complete coverage", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, Array.from({ length: 2001 }, (_, i) => `const rule${i} = ${i};\n`).join(""));
    const target = join(f.root, "large-review");
    assert.equal((await f.invoke("candidate", "materialize", c.id, "--mode", "review", "--path", target)).code, 0);
    const result = await f.invoke("trace", "--cwd", target, "--at", "refund.ts:1-2001");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.ok(result.data.segments.length > 0 && result.data.segments.length <= 2000);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024);
    assert.equal(result.data.coverage.candidate_search_complete, false);
    assert.ok(result.data.limitations.includes("output_budget"));
    assert.equal(result.data.next_action, "narrow_query");
  } finally { f.close(); }
});

test("Review tracing does not execute filters supplied by global Git configuration", async () => {
  const f = await setup(); const previous = process.env.GIT_CONFIG_GLOBAL;
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    const target = join(f.root, "global-filter-review");
    assert.equal((await f.invoke("candidate", "materialize", c.id, "--mode", "review", "--path", target)).code, 0);
    const sentinel = join(f.root, "global-filter-ran"), attrs = join(f.root, "global-attributes"), config = join(f.root, "global-gitconfig");
    writeFileSync(attrs, "*.ts filter=sentinel\n");
    writeFileSync(config, `[core]\nattributesFile = ${attrs}\n[filter "sentinel"]\nclean = "touch ${sentinel}; cat"\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    const result = await f.invoke("trace", "--cwd", target, "--at", "refund.ts:2");
    assert.equal(existsSync(sentinel), false);
    assert.equal(result.code, 0, JSON.stringify(result));
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; f.close(); }
});

test("shallow history reports unavailable evidence instead of treating its boundary as an original root", async () => {
  const f = await setup();
  try {
    writeFileSync(join(f.repo, "notes.txt"), "later\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Later");
    const clone = join(f.root, "shallow"); execFileSync("git", ["clone", "-q", "--depth", "1", `file://${f.repo}`, clone]);
    git(clone, "remote", "set-url", "origin", "ssh://git@example.test/team/repo");
    const result = await f.invoke("trace", "--cwd", clone, "--at", "refund.ts:2");
    assert.equal(result.error?.code, "BASELINE_UNAVAILABLE");
  } finally { f.close(); }
});

test("delivery refuses same after-text when the parent rule differs or only part of a hunk was adopted", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    writeFileSync(join(f.repo, "refund.ts"), "export function refund(days: number) {\n  return days > 90 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Different old policy");
    writeFileSync(join(f.repo, "refund.ts"), "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Same result from different change");
    assert.equal((await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0")).error.code, "VALIDATION_ERROR");
    const partial = await candidate(f, "export function refund(days: number) {\n  const threshold = 120;\n  return days > threshold ? 'manual' : 'automatic';\n}\n");
    writeFileSync(join(f.repo, "refund.ts"), "export function refund(days: number) {\n  const threshold = 120;\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Only part of hunk");
    assert.equal((await f.invoke("delivery-link", "record", "--candidate", partial.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0")).error.code, "VALIDATION_ERROR");
  } finally { f.close(); }
});

test("new files use the real empty old side and can be traced through an exact delivery", async () => {
  const f = await setup();
  try {
    git(f.repo, "rm", "refund.ts"); git(f.repo, "commit", "-qm", "Remove previous file");
    const c = await candidate(f, "export const refundWindow = 60;\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "New refund implementation");
    const recorded = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
    assert.equal(recorded.code, 0, JSON.stringify(recorded));
    assert.equal((await f.invoke("trace", "--at", "refund.ts:1")).data.segments[0]?.origin, "recorded_delivery");
  } finally { f.close(); }
});

test("a renamed file retains an explicit history gap until rename mapping is supported", async () => {
  const f = await setup();
  try {
    git(f.repo, "mv", "refund.ts", "moved.ts"); git(f.repo, "commit", "-qm", "Rename refund");
    const result = await f.invoke("trace", "--at", "moved.ts:2");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.ok(result.data.limitations.includes("history_mapping_unresolved"));
    assert.equal(result.data.segments.length, 0);
  } finally { f.close(); }
});

test("large uncommitted regions are returned as compact local-only ranges", async () => {
  const f = await setup();
  try {
    writeFileSync(join(f.repo, "refund.ts"), Array.from({ length: 2001 }, (_, i) => `newRule(${i});\n`).join(""));
    const result = await f.invoke("trace", "--at", "refund.ts:1-2001");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.deepEqual(result.data.coverage.local_only, [{ path: "refund.ts", start_line: 1, end_line: 2001 }]);
    assert.deepEqual(result.data.segments, []);
  } finally { f.close(); }
});

test("snippet discovery skips unsupported encodings without claiming a complete unique scan", async () => {
  const f = await setup();
  try {
    const snippet = join(f.root, "snippet.txt"); writeFileSync(snippet, "return days > 30 ? 'manual' : 'automatic';\n");
    writeFileSync(join(f.repo, "encoded.ts"), Buffer.from([255, 254, 0, 10]));
    const result = await f.invoke("trace", "--snippet-file", snippet);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.data.locations.resolution, "incomplete");
    assert.ok(result.data.limitations.includes("unsupported_encoding"));
  } finally { f.close(); }
});

test("new-file Candidate must not match insertion into a previously existing file", async () => {
 const f = await setup(); try {
  git(f.repo, "rm", "refund.ts"); git(f.repo, "commit", "-qm", "Remove refund");
  const c = await candidate(f, "export const refundWindow = 60;\n");
  writeFileSync(join(f.repo, "refund.ts"), "unrelated();\n"); git(f.repo,"add",".");git(f.repo,"commit","-qm","Existing unrelated file");
  writeFileSync(join(f.repo, "refund.ts"), "unrelated();\nexport const refundWindow = 60;\n");git(f.repo,"add",".");git(f.repo,"commit","-qm","Append a line");
  const r=await f.invoke("delivery-link","record","--candidate",c.id,"--commit",git(f.repo,"rev-parse","HEAD"),"--expected-version","0");
  assert.equal(r.code,2);
 } finally {f.close();}
});

test("a deleted tracked file must not abort tracing another file", async () => {
 const f = await setup();try {
  writeFileSync(join(f.repo,"other.ts"),"other();\n");git(f.repo,"add",".");git(f.repo,"commit","-qm","Add other");
  rmSync(join(f.repo,"other.ts"));const snippet=join(f.root,"snippet.txt");writeFileSync(snippet,"return days > 30 ? 'manual' : 'automatic';");
  const r=await f.invoke("trace","--snippet-file",snippet);assert.equal(r.code,0);
 }finally{f.close();}
});

test("snippet scanner must not follow a symlinked parent directory", async () => {
 const f=await setup();try {
  const {mkdirSync}=await import("node:fs");mkdirSync(join(f.repo,"src"));writeFileSync(join(f.repo,"src","rule.ts"),"inside();\n");git(f.repo,"add",".");git(f.repo,"commit","-qm","Source");
  mkdirSync(join(f.root,"external"));writeFileSync(join(f.root,"external","rule.ts"),"outsideSecret();\n");rmSync(join(f.repo,"src"),{recursive:true});symlinkSync(join(f.root,"external"),join(f.repo,"src"));
  const snippet=join(f.root,"snippet.txt");writeFileSync(snippet,"outsideSecret();");const r=await f.invoke("trace","--snippet-file",snippet);
  assert.ok(!r.data?.locations.matches.some((m:any)=>m.path==="src/rule.ts"));
 }finally{f.close();}
});

test("annotated tag object is not a commit OID", async () => {
 const f=await setup();try{
  const c=await candidate(f,"export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
  git(f.repo,"add",".");git(f.repo,"commit","-qm","Adopt");git(f.repo,"tag","-a","adopted","-m","Tag");
  const r=await f.invoke("delivery-link","record","--candidate",c.id,"--commit",git(f.repo,"rev-parse","adopted"),"--expected-version","0");
  assert.equal(r.code,2);
 }finally{f.close();}
});

test("unresolved index entries block provenance even when visible text equals HEAD", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Delivery");
    assert.equal((await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0")).code, 0);
    const ours = git(f.repo, "rev-parse", "HEAD:refund.ts");
    const theirs = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.repo, input: "other\n", encoding: "utf8" }).trim();
    execFileSync("git", ["update-index", "--index-info"], { cwd: f.repo, input: `0 ${"0".repeat(40)}\trefund.ts\n100644 ${ours} 1\trefund.ts\n100644 ${ours} 2\trefund.ts\n100644 ${theirs} 3\trefund.ts\n` });
    const result = await f.invoke("trace", "--at", "refund.ts:2");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.deepEqual(result.data.segments, []);
    assert.equal(result.data.coverage.candidate_search_complete, false);
    assert.ok(result.data.limitations.includes("unresolved_index_conflict"));
    assert.deepEqual(result.data.source.index.unmerged_paths, ["refund.ts"]);
    assert.match(git(f.repo, "status", "--porcelain"), /UU refund.ts/);
  } finally { f.close(); }
});

test("a regressed delivery version pointer is detected and cannot revive a withdrawn association", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Delivery");
    const recorded = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
    const id = recorded.data.link.id;
    assert.equal((await f.invoke("delivery-link", "withdraw", id, "--expected-version", "1", "--reason", "Wrong origin")).code, 0);
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(f.root, "ledger.db"));
    raw.prepare("UPDATE delivery_links SET version=1 WHERE id=?").run(id); raw.close();
    const status = await f.invoke("db", "status");
    assert.equal(status.data.integrity.valid, false, JSON.stringify(status));
    assert.equal((await f.invoke("delivery-link", "show", id)).error?.code, "ARTIFACT_INTEGRITY_ERROR");
    assert.equal((await f.invoke("trace", "--at", "refund.ts:2")).error?.code, "ARTIFACT_INTEGRITY_ERROR");
    assert.equal((await f.invoke("delivery-link", "show", id, "--version", "1")).data.link.state, "recorded");
  } finally { f.close(); }
});

test("completed delivery retries reuse frozen proof and still reject a different request", async () => {
  const f = await setup();
  try {
    const c = await candidate(f, "export function refund(days: number) {\n  return days > 60 ? 'manual' : 'automatic';\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Delivery");
    const commit = git(f.repo, "rev-parse", "HEAD"), op = newUUIDv7();
    const args = ["delivery-link", "record", "--candidate", c.id, "--commit", commit, "--expected-version", "0", "--operation-id", op];
    const recorded = await f.invoke(...args);
    assert.equal(recorded.code, 0, JSON.stringify(recorded));
    assert.equal((await f.invoke("delivery-link", "withdraw", recorded.data.link.id, "--expected-version", "1", "--reason", "Withdraw")).code, 0);
    git(f.repo, "config", "remote.origin.promisor", "true");
    const retry = await f.invoke(...args);
    assert.equal(retry.code, 0, JSON.stringify(retry));
    assert.deepEqual(retry.data, recorded.data);
    for (const [flag, changed] of [["--commit", "1".repeat(40)], ["--candidate", newUUIDv7()], ["--expected-version", "1"]]) {
      const different = [...args]; different[different.indexOf(flag) + 1] = changed;
      assert.equal((await f.invoke(...different)).error?.code, "IDEMPOTENCY_CONFLICT");
    }
    assert.equal((await f.invoke("delivery-link", "show", recorded.data.link.id)).data.link.state, "withdrawn");
  } finally { f.close(); }
});

test("zero-context insertions must preserve their BOF/EOF boundary", async () => {
  const f = await setup();
  try {
    const original = "export function refund(days: number) {\n  return days > 30 ? 'manual' : 'automatic';\n}\n";
    const added = Array.from({ length: 5 }, (_, i) => `const rule${i} = ${i};\n`).join("");
    git(f.repo, "config", "diff.context", "0");
    const c = await candidate(f, added + original);
    writeFileSync(join(f.repo, "refund.ts"), original + added);
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Same text at the wrong boundary");
    const result = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
    assert.equal(result.error?.code, "VALIDATION_ERROR", JSON.stringify(result));
  } finally { f.close(); }
});

test("zero-context insertions at the correct file boundaries remain traceable with unrelated changes", async () => {
  for (const boundary of ["BOF", "EOF"]) {
    const f = await setup();
    try {
      const original = "export function refund(days: number) {\n  return days > 30 ? 'manual' : 'automatic';\n}\n";
      const added = Array.from({ length: 5 }, (_, i) => `const rule${i} = ${i};\n`).join("");
      git(f.repo, "config", "diff.context", "0");
      const c = await candidate(f, boundary === "BOF" ? added + original : original + added);
      writeFileSync(join(f.repo, "notes.txt"), "Unrelated change\n");
      git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Adopt at correct boundary");
      const result = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
      assert.equal(result.code, 0, JSON.stringify({ boundary, result }));
      assert.equal(result.data.link.content, "exact_scope");
      const traced = await f.invoke("trace", "--at", `refund.ts:${boundary === "BOF" ? 1 : 4}`);
      assert.equal(traced.data.segments[0]?.origin, "recorded_delivery", JSON.stringify(traced));
    } finally { f.close(); }
  }
});

test("empty files and absent files are distinct before-states for delivery proofs", async () => {
  for (const originalExists of [true, false]) {
    const f = await setup();
    try {
      if (originalExists) writeFileSync(join(f.repo, "refund.ts"), "");
      else git(f.repo, "rm", "refund.ts");
      git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Set Candidate before-state");
      const c = await candidate(f, "export const refundWindow = 60;\n");
      if (originalExists) git(f.repo, "rm", "-f", "refund.ts");
      else writeFileSync(join(f.repo, "refund.ts"), "");
      git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Use a different before-state");
      writeFileSync(join(f.repo, "refund.ts"), "export const refundWindow = 60;\n");
      git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "Same after-state");
      const result = await f.invoke("delivery-link", "record", "--candidate", c.id, "--commit", git(f.repo, "rev-parse", "HEAD"), "--expected-version", "0");
      assert.equal(result.error?.code, "VALIDATION_ERROR", JSON.stringify({ originalExists, result }));
    } finally { f.close(); }
  }
});
