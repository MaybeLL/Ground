import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newUUIDv7 } from "../src/identity.js";
import { Module } from "../src/module.js";
import { SQLStore } from "../src/sql-store.js";
import { parseIssueMarkdown, renderIssueMarkdown, WorkspaceModule } from "../src/workspace.js";
import { testAgent, testBaseline } from "./fixture.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const repository = (): string => {
  const root = mkdtempSync(join(tmpdir(), "grounds-issue-limit-")); execFileSync("git", ["init", "-q", root]);
  git(root, "config", "user.name", "Limit Test"); git(root, "config", "user.email", "limit@example.test");
  git(root, "remote", "add", "origin", "ssh://git@example.test/team/workspace"); writeFileSync(join(root, "README.md"), "test\n"); git(root, "add", "README.md"); git(root, "commit", "-m", "initial"); git(root, "update-ref", "refs/remotes/origin/main", "HEAD"); return root;
};
const setup = async (root: string) => {
  const store = SQLStore.sqlite(join(root, "ledger.db")); const metadata = await store.initialize("warn"); const work = new Module(store);
  return { store, work, workspace: new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id) };
};
const failure = async (promise: Promise<unknown>): Promise<{ code: string; details: { field?: string; reason?: string } }> => {
  try { await promise; } catch (error) { return error as { code: string; details: { field?: string; reason?: string } }; }
  throw new Error("expected the command to fail");
};
const issue = (summary: string, criterion: string) => ({ format: 1 as const, summary, goals: [{ statement: `Deliver ${summary}`, criteria: [criterion] }] });

test("a second new Issue for one Requirement and Repository is rejected, overridable with a reason", async () => {
  const root = repository();
  try {
    const { workspace } = await setup(root);
    const created = await workspace.new("two") as { path: string };
    writeFileSync(join(created.path, "issues", "extra.md"), renderIssueMarkdown(issue("Second delivery", "The second behavior is observable"), "HEAD"));

    for (const dryRun of [true, false]) {
      const blocked = await failure(workspace.publish("two", root, dryRun, false));
      assert.equal(blocked.code, "REPOSITORY_ISSUE_LIMIT");
      assert.match(String(blocked.details.reason), /this publication creates 2 Issues/);
      assert.match(String(blocked.details.reason), /--allow-second-issue-per-repository/);
    }

    const missingReason = await failure(workspace.publish("two", root, false, false, true, "  "));
    assert.equal(missingReason.code, "VALIDATION_ERROR");
    assert.equal(missingReason.details.field, "override-reason");

    const published = await workspace.publish("two", root, false, false, true, "reviewed with the team") as { result: { requirement: { id: string; version: number }; issues: { id: string; action: string }[] }; warnings: { code: string }[] };
    assert.equal(published.result.requirement.version, 1);
    assert.deepEqual(published.result.issues.map((item) => item.action), ["created", "created"]);
    assert.deepEqual(published.warnings.map((warning) => warning.code), ["SECOND_ISSUE_PER_REPOSITORY_OVERRIDE"]);
    assert.equal((workspace.show("two", root) as { state: string }).state, "clean");

    // Existing overlap is not rewritten: revising one Issue keeps the overlap
    // visible as a warning instead of blocking the revision.
    const first = published.result.issues[0];
    await workspace.openIssue(first.id, "revise");
    const file = join((workspace.show("revise", root) as { path: string }).path, "issues", `${first.id}.md`);
    const draft = parseIssueMarkdown(readFileSync(file, "utf8"), `${first.id}.md`);
    writeFileSync(file, renderIssueMarkdown({ ...draft.input, summary: "Revised first delivery" }, draft.baselineExpression, first.id, 1));
    const revised = await workspace.publish("revise", root, false, false) as { result: { issues: { action: string }[] }; warnings: { code: string }[] };
    assert.deepEqual(revised.result.issues.map((item) => item.action), ["revised"]);
    assert.deepEqual(revised.warnings.map((warning) => warning.code), ["SECOND_ISSUE_PER_REPOSITORY_EXISTING"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a Requirement revision does not allow a second Issue by rebinding around the gate", async () => {
  const root = repository();
  try {
    const { work, workspace } = await setup(root);
    const seed = await workspace.new("seed") as { path: string };
    const published = await workspace.publish("seed", root, false, false) as { result: { requirement: { id: string; version: number }; issues: { id: string }[] } };
    const requirementId = published.result.requirement.id; const firstIssue = published.result.issues[0].id;

    const requirementFile = join(seed.path, "requirement.md");
    writeFileSync(requirementFile, readFileSync(requirementFile, "utf8").replace("Describe the requirement", "Describe the revised requirement"));
    const revised = await workspace.publish("seed", root, false, false) as { result: { requirement: { version: number } } };
    assert.equal(revised.result.requirement.version, 2);
    // Revising a Requirement does not silently rebind its Issues.
    assert.equal((await work.showIssue(firstIssue)).requirement.version, 1);

    await workspace.openRequirement(requirementId, "second");
    const second = workspace.show("second", root) as { path: string };
    writeFileSync(join(second.path, "issues", "second.md"), renderIssueMarkdown(issue("Later delivery", "The later behavior is observable"), "HEAD"));
    const blocked = await failure(workspace.publish("second", root, true, false));
    assert.equal(blocked.code, "REPOSITORY_ISSUE_LIMIT");
    assert.match(String(blocked.details.reason), new RegExp(`already has Issue ${firstIssue}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a single Issue per Repository publishes without a warning and other Repositories stay independent", async () => {
  const root = repository();
  try {
    const { work, workspace } = await setup(root);
    await workspace.new("seed");
    const published = await workspace.publish("seed", root, false, false) as { result: { requirement: { id: string } }; warnings: { code: string }[] };
    assert.deepEqual(published.warnings.map((warning) => warning.code), []);
    const current = await work.loadRequirement(published.result.requirement.id);
    const other = await work.publishAuthoring({ operation_id: newUUIDv7(), canonical_remote: "ssh://git@example.test/team/other", attribution: testAgent, requirement: { requirement_id: published.result.requirement.id, expected_revision_id: current.requirement_revision.id }, issues: [{ baseline: testBaseline, input: issue("Other repository delivery", "The other repository behavior is observable") }] });
    assert.deepEqual(other.result.issues.map((item) => item.action), ["created"]);
    assert.deepEqual(other.warnings.map((warning) => warning.code), ["BASELINE_UNCONFIRMED"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
