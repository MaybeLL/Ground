import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Module } from "../src/module.js";
import { SQLStore } from "../src/sql-store.js";
import { parseIssueMarkdown, parseRequirementMarkdown, renderIssueMarkdown, renderRequirementMarkdown, WorkspaceModule } from "../src/workspace.js";
import { testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { testBaseline } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";
import { decodeRequirement } from "../src/domain.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const repository = (): string => {
  const root = mkdtempSync(join(tmpdir(), "grounds-workspace-")); execFileSync("git", ["init", "-q", root]);
  git(root, "config", "user.name", "Workspace Test"); git(root, "config", "user.email", "workspace@example.test");
  git(root, "remote", "add", "origin", "ssh://git@example.test/team/workspace"); writeFileSync(join(root, "README.md"), "test\n"); git(root, "add", "README.md"); git(root, "commit", "-m", "initial"); git(root, "update-ref", "refs/remotes/origin/main", "HEAD"); return root;
};

test("Workspace Markdown round trips semantic Requirement and Issue content", () => {
  const requirement = { format: 1 as const, summary: "Build it", context: "For users", outcomes: ["It works"], decisions: [{ statement: "Keep compatibility", rationale: "Existing callers" }], open_questions: [{ question: "Which color?", blocking: false, assumption: "Blue for now" }] };
  const issue = { format: 1 as const, summary: "Implement it", goals: [{ statement: "Ship behavior", criteria: ["Test observes it"], traces_to: [{ type: "outcome" as const, ordinal: 1 }], guidance: ["Prefer a small change"] }], constraints: [{ statement: "Remain compatible", criteria: ["Old input works"], traces_to: [{ type: "decision" as const, ordinal: 1 }], rationale: "Stable interface" }] };
  const requirementMarkdown = renderRequirementMarkdown(requirement);
  assert.match(requirementMarkdown, /\[outcome-1\] It works/);
  assert.match(requirementMarkdown, /\[decision-1\] Keep compatibility/);
  assert.deepEqual(parseRequirementMarkdown(requirementMarkdown).input, requirement);
  assert.equal(decodeRequirement(Buffer.from("format: 1\nsummary: Build it\noutcomes: [It works]\nopen_questions:\n  - question: Which color?\n    blocking: false\n")).open_questions?.[0].blocking, false);
  const issueMarkdown = renderIssueMarkdown(issue, "HEAD");
  assert.match(issueMarkdown, /#### Traces To\n\n- outcome-1/);
  assert.match(issueMarkdown, /#### Traces To\n\n- decision-1/);
  assert.deepEqual(parseIssueMarkdown(issueMarkdown).input, issue);
});

test("Workspace Markdown preserves prose headings and rejects lossy semantic content", () => {
  const requirement = { format: 1 as const, summary: "Build it", context: "Background\n\n## Detailed behavior\n\nKeep this heading", outcomes: ["It works"] };
  assert.deepEqual(parseRequirementMarkdown(renderRequirementMarkdown(requirement)).input, requirement);
  assert.throws(
    () => parseRequirementMarkdown(renderRequirementMarkdown(requirement).replace("- [outcome-1] It works", "This would previously disappear")),
    (error: unknown) => error instanceof Error && "details" in error && String((error as { details: { reason?: string } }).details.reason).includes("bullet items"),
  );
  assert.throws(
    () => parseRequirementMarkdown(renderRequirementMarkdown({ ...requirement, outcomes: ["First", "Second"] }).replace("[outcome-2]", "[outcome-3]")),
    (error: unknown) => error instanceof Error && "details" in error && String((error as { details: { reason?: string } }).details.reason).includes("1-based list order"),
  );
  assert.throws(
    () => parseRequirementMarkdown(renderRequirementMarkdown(requirement).replace("[outcome-1]", "[outcome-01]")),
    (error: unknown) => error instanceof Error && "details" in error && String((error as { details: { reason?: string } }).details.reason).includes("complete [outcome-N] label"),
  );
  assert.throws(
    () => parseRequirementMarkdown(renderRequirementMarkdown({ ...requirement, decisions: [{ statement: "Choose it" }] }).replace("[decision-1] Choose it", "[decision-] Choose it")),
    (error: unknown) => error instanceof Error && "details" in error && String((error as { details: { reason?: string } }).details.reason).includes("complete [decision-N] label"),
  );
  assert.throws(
    () => parseRequirementMarkdown(renderRequirementMarkdown({ ...requirement, decisions: [{ statement: "Choose it", rationale: "Because" }] }).replace("### [decision-1] Choose it\n\n#### Rationale", "### [decision-1] Choose it\n\nUnstructured text\n\n#### Rationale")),
    (error: unknown) => error instanceof Error && "details" in error && String((error as { details: { reason?: string } }).details.reason).includes("allowed #### subsection"),
  );
});

test("Workspace new publishes atomically and becomes a clean reusable projection", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const work = new Module(store); const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id);
    const created = await workspace.new("first") as { path: string }; assertContract("command-results.schema.json", created); assertContract("command-results.schema.json", workspace.list()); assertContract("command-results.schema.json", workspace.show("first", root)); assert.equal(created.path.startsWith(root + "/"), false);
    const requirementFile = join(created.path, "requirement.md");
    const requirementDraft = parseRequirementMarkdown(readFileSync(requirementFile, "utf8")).input;
    requirementDraft.decisions = [{ statement: "Use local storage", context: "Offline work", options: [{ key: "sqlite", description: "Embedded database" }], chosen_option: "sqlite", consequences: [{ kind: "limitation", statement: "Local filesystem only" }] }];
    writeFileSync(requirementFile, renderRequirementMarkdown(requirementDraft));
    const published = await workspace.publish("first", root, false, false) as { result: { requirement: { id: string; version: number }; issues: { id: string; version: number }[] } };
    assert.deepEqual((await work.showRequirement(published.result.requirement.id)).requirement.decisions, requirementDraft.decisions);
    assert.deepEqual(parseRequirementMarkdown(readFileSync(requirementFile, "utf8")).input.decisions, requirementDraft.decisions);
    assert.equal(published.result.requirement.version, 1); assert.equal(published.result.issues[0].version, 1);
    assertContract("command-results.schema.json", published.result);
    assert.equal((workspace.show("first", root) as { state: string }).state, "clean");
    const replay = await workspace.publish("first", root, false, false) as { result: { no_op: boolean } }; assert.equal(replay.result.no_op, true); assertContract("command-results.schema.json", replay.result);
    assert.equal((await work.showRequirement(published.result.requirement.id)).issues.length, 1);
    assertContract("command-results.schema.json", workspace.remove("first", root, false));
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Workspace blocks Issue publication when draft questions remain", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const workspace = new WorkspaceModule(new Module(store), root, "warn", () => testAgent, metadata.metadata.database_id); const created = await workspace.new("blocked") as { path: string };
    const issue = join(created.path, "issues", "main.md"); writeFileSync(issue, readFileSync(issue, "utf8").replace("## Open Questions\n", "## Open Questions\n\n### Which API?\n"));
    await assert.rejects(workspace.publish("blocked", root, false, false), (error: unknown) => error instanceof Error && "details" in error && String((error as { details: { reason?: string } }).details.reason).includes("remove or resolve every Open Question"));
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("atomic authoring publication rolls back an earlier Requirement revision when a later Issue is unrelated", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-atomic-")); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    await store.initialize("warn"); const work = new Module(store); const first = await work.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent, input: { format: 1, summary: "First", outcomes: ["First outcome"] } }); const second = await work.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent, input: { format: 1, summary: "Second", outcomes: ["Second outcome"] } }); const repository = await work.registerRepository({ operation_id: newUUIDv7(), attribution: testAgent, canonical_remote: "ssh://git@example.test/team/atomic" }); const issue = await work.createIssue({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: second.result.requirement_id, requirement_revision_id: second.result.requirement_revision_id, requirement_revision_explicit: true, repository_id: repository.result.repository_id, baseline: testBaseline, input: { format: 1, summary: "Second issue", goals: [{ statement: "Do it", criteria: ["It is done"] }] } });
    await assert.rejects(work.publishAuthoring({ operation_id: newUUIDv7(), canonical_remote: repository.result.canonical_remote, attribution: testAgent, requirement: { requirement_id: first.result.requirement_id, expected_revision_id: first.result.requirement_revision_id, input: { format: 1, summary: "First changed", outcomes: ["First outcome"] } }, issues: [{ issue_id: issue.result.issue_id, expected_revision_id: issue.result.issue_revision_id, baseline: testBaseline, input: { format: 1, summary: "Wrong parent", goals: [{ statement: "Do it", criteria: ["It is done"] }] } }] }));
    assert.equal((await work.currentRequirementRevision(first.result.requirement_id)).revision_number, 1);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Requirement Open Questions persist while blocking questions prevent an Issue Version", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-questions-")); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    await store.initialize("warn"); const work = new Module(store); const requirement = await work.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent, input: { format: 1, summary: "Questioned", outcomes: ["Known outcome"], open_questions: [{ question: "Which policy?", blocking: true, assumption: "Use the current policy" }] } }); const loaded = await work.currentRequirementRevision(requirement.result.requirement_id); assert.equal(loaded.open_questions?.[0].blocking, true); const repository = await work.registerRepository({ operation_id: newUUIDv7(), attribution: testAgent, canonical_remote: "ssh://git@example.test/team/questions" });
    await assert.rejects(work.createIssue({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: requirement.result.requirement_id, requirement_revision_id: requirement.result.requirement_revision_id, requirement_revision_explicit: true, repository_id: repository.result.repository_id, baseline: testBaseline, input: { format: 1, summary: "Blocked", goals: [{ statement: "Do it", criteria: ["It is done"] }] } }));
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("opening an Issue with current binding publishes a new Issue Version without requiring prose edits", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const work = new Module(store); const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id); const seed = await workspace.new("seed") as { path: string }; const first = await workspace.publish("seed", root, false, false) as { result: { requirement: { id: string }; issues: { id: string }[] } };
    const requirementFile = join(seed.path, "requirement.md"); writeFileSync(requirementFile, readFileSync(requirementFile, "utf8").replace("Describe the requirement", "Describe the revised requirement")); const revised = await workspace.publish("seed", root, false, false) as { result: { requirement: { version: number } } };
    await workspace.openIssue(first.result.issues[0].id, "upgrade", "current"); assert.equal((workspace.show("upgrade", root) as { state: string }).state, "draft"); await workspace.publish("upgrade", root, false, false); const issue = await work.showIssue(first.result.issues[0].id); assert.equal(issue.issue.version, 2); assert.equal(issue.requirement.version, revised.result.requirement.version);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Workspace dry-run enforces blocking Requirement questions", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const workspace = new WorkspaceModule(new Module(store), root, "warn", () => testAgent, metadata.metadata.database_id);
    const created = await workspace.new("blocked-plan") as { path: string };
    const requirement = join(created.path, "requirement.md");
    writeFileSync(requirement, readFileSync(requirement, "utf8").replace("## Open Questions\n", "## Open Questions\n\n### [blocking] Which contract?\n"));
    await assert.rejects(workspace.publish("blocked-plan", root, true, false), (error: unknown) => error instanceof Error && "details" in error && String((error as { details: { reason?: string } }).details.reason).includes("blocking Open Question"));
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Issue-only publication rejects a stale current Requirement binding", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const work = new Module(store); const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id);
    await workspace.new("seed"); const published = await workspace.publish("seed", root, false, false) as { result: { requirement: { id: string }; issues: { id: string }[] } };
    const editing = await workspace.openRequirement(published.result.requirement.id, "editing") as { path: string };
    const current = await work.currentRequirementRevision(published.result.requirement.id);
    await work.reviseRequirement({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: published.result.requirement.id, expected_predecessor_id: current.id, input: { format: 1, summary: "Changed elsewhere", outcomes: current.outcomes } });
    const issuePath = join(editing.path, "issues", `${published.result.issues[0].id}.md`);
    writeFileSync(issuePath, readFileSync(issuePath, "utf8").replace("Implement the requirement", "Implement the stale requirement"));
    await assert.rejects(workspace.publish("editing", root, false, false), (error: unknown) => error instanceof Error && "details" in error && String((error as { details: { reason?: string } }).details.reason).includes("Requirement source Version is stale"));
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an explicit Workspace name wins over the enclosing directory", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const workspace = new WorkspaceModule(new Module(store), root, "warn", () => testAgent, metadata.metadata.database_id);
    const first = await workspace.new("first") as { path: string }; const second = await workspace.new("second") as { path: string };
    const shown = workspace.show("second", first.path) as { name: string; path: string };
    assert.equal(shown.name, "second"); assert.equal(shown.path, second.path);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Workspace publish recovers an idempotently committed transaction after a local write failure", async () => {
  class CommitThenFailModule extends Module {
    private failOnce = true;
    override async publishAuthoring(input: Parameters<Module["publishAuthoring"]>[0]): ReturnType<Module["publishAuthoring"]> {
      const result = await super.publishAuthoring(input);
      if (this.failOnce) { this.failOnce = false; throw new Error("injected local projection failure"); }
      return result;
    }
  }
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const work = new CommitThenFailModule(store); const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id);
    await workspace.new("recover");
    await assert.rejects(workspace.publish("recover", root, false, false), /injected local projection failure/);
    assert.equal((workspace.show("recover", root) as { state: string }).state, "publishing");
    const recovered = await workspace.publish("recover", root, false, false) as { result: { requirement: { version: number } } };
    assert.equal(recovered.result.requirement.version, 1);
    assert.equal((workspace.show("recover", root) as { state: string }).state, "clean");
    assert.equal((await work.listRequirements()).resources.length, 1);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Workspace rebase three-way merges non-overlapping Requirement edits", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const work = new Module(store); const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id);
    const seed = await workspace.new("seed") as { path: string }; const published = await workspace.publish("seed", root, false, false) as { result: { requirement: { id: string } } };
    const left = await workspace.openRequirement(published.result.requirement.id, "left") as { path: string };
    const right = await workspace.openRequirement(published.result.requirement.id, "right") as { path: string };
    writeFileSync(join(left.path, "requirement.md"), readFileSync(join(left.path, "requirement.md"), "utf8").replace("Describe the requirement", "Authoritative summary"));
    writeFileSync(join(right.path, "requirement.md"), readFileSync(join(right.path, "requirement.md"), "utf8").replace("- [outcome-1] Describe an observable outcome", "- [outcome-1] A locally refined outcome"));
    await workspace.publish("left", root, false, false);
    const rebased = await workspace.rebase("right", root) as { state: string; conflicts: string[] }; assertContract("command-results.schema.json", rebased);
    assert.equal(rebased.state, "draft"); assert.deepEqual(rebased.conflicts, []);
    const merged = readFileSync(join(right.path, "requirement.md"), "utf8");
    assert.match(merged, /Authoritative summary/); assert.match(merged, /A locally refined outcome/);
    await workspace.publish("right", root, false, false);
    assert.equal((await work.currentRequirementRevision(published.result.requirement.id)).revision_number, 3);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Workspace rebase exposes overlapping edits as resolvable Markdown conflicts", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const work = new Module(store); const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id);
    await workspace.new("seed"); const published = await workspace.publish("seed", root, false, false) as { result: { requirement: { id: string } } };
    const left = await workspace.openRequirement(published.result.requirement.id, "left") as { path: string };
    const right = await workspace.openRequirement(published.result.requirement.id, "right") as { path: string };
    writeFileSync(join(left.path, "requirement.md"), readFileSync(join(left.path, "requirement.md"), "utf8").replace("Describe the requirement", "Left summary"));
    writeFileSync(join(right.path, "requirement.md"), readFileSync(join(right.path, "requirement.md"), "utf8").replace("Describe the requirement", "Right summary"));
    await workspace.publish("left", root, false, false);
    const rebased = await workspace.rebase("right", root) as { state: string; conflicts: string[] };
    assert.equal(rebased.state, "conflicted"); assert.deepEqual(rebased.conflicts, ["requirement.summary"]);
    assert.match(readFileSync(join(right.path, "requirement.md"), "utf8"), /<<<<<<< LOCAL[\s\S]*Right summary[\s\S]*=======([\s\S]*)Left summary[\s\S]*>>>>>>> REMOTE/);
    assert.equal((workspace.show("right", root) as { state: string }).state, "conflicted");
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Workspace keeps structured Decisions atomic during conflicting refresh", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const work = new Module(store);
    const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id);
    await workspace.new("seed");
    const published = await workspace.publish("seed", root, false, false) as { result: { requirement: { id: string } } };
    for (const name of ["left", "right"]) {
      const draft = await workspace.openRequirement(published.result.requirement.id, name) as { path: string };
      const path = join(draft.path, "requirement.md"); const parsed = parseRequirementMarkdown(readFileSync(path, "utf8"));
      parsed.input.decisions = [{ statement: "Choose storage", consequences: [{ kind: "risk", statement: `${name} risk` }] }];
      writeFileSync(path, renderRequirementMarkdown(parsed.input, parsed.frontmatter.id, parsed.frontmatter.version));
    }
    await workspace.publish("left", root, false, false);
    const rebased = await workspace.rebase("right", root) as { state: string; conflicts: string[] };
    assert.equal(rebased.state, "conflicted"); assert.deepEqual(rebased.conflicts, ["requirement.decisions"]);
    await assert.rejects(workspace.publish("right", root, false, false));
    assert.equal((await work.showRequirement(published.result.requirement.id)).requirement.decisions[0].consequences?.[0].statement, "left risk");
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("publication retains bound versions without loading report state", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const { LedgerFixture } = await import("./fixture.js"); const fixture = await LedgerFixture.createWithStore(store);
    git(root, "remote", "set-url", "origin", fixture.repository.canonical_remote);
    const candidate = await fixture.submitCandidate();
    for (let i = 0; i < 3; i++) await fixture.verify(candidate);
    const workspace = new WorkspaceModule(fixture.module, root, "warn", () => testAgent, (await store.open()).database_id);
    await fixture.module.reviseRequirement({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: fixture.requirement.requirement_id,
      expected_predecessor_id: fixture.requirement.requirement_revision_id, input: { format: 1, summary: "New intent", outcomes: ["The change is observable"] } });
    const opened = await workspace.openRequirement(fixture.requirement.requirement_id, "narrow") as { path: string };
    const file = join(opened.path, "issues", `${fixture.issue.issue_id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace("Implement the change", "Revised implementation").replace(testBaseline.git_oid, `sha1:${git(root, "rev-parse", "HEAD")}`));
    const read = store.read.bind(store);
    store.read = callback => read(async tx => {
      const forbidden = async (): Promise<never> => { throw Error("publication loaded unrelated report state"); };
      tx.requirementAggregateFacts = forbidden; tx.getVerification = forbidden; tx.getSelection = forbidden; tx.candidateCount = forbidden;
      return callback(tx);
    });
    for (const dryRun of [true, false]) {
      const published = await workspace.publish("narrow", root, dryRun, false) as { result: { issues: { version: number; requirement: { version: number } }[] } };
      assert.equal(published.result.issues[0].version, 2); assert.equal(published.result.issues[0].requirement.version, 1);
      assertContract("command-results.schema.json", published.result);
    }
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("publication rejects stale Issue drafts in dry-run and write paths", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    await store.initialize("warn"); const work = new Module(store); const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, (await store.open()).database_id);
    const seed = await workspace.new("seed") as { path: string };
    const initial = await workspace.publish("seed", root, false, false) as { result: { issues: { id: string }[] } };
    const other = await workspace.openIssue(initial.result.issues[0].id, "other", "bound") as { path: string };
    for (const file of [join(seed.path, "issues/main.md"), join(other.path, "issues", `${initial.result.issues[0].id}.md`)]) writeFileSync(file, readFileSync(file, "utf8").replace("Implement the requirement", "Updated implementation"));
    await workspace.publish("seed", root, false, false);
    for (const dryRun of [true, false]) await assert.rejects(workspace.publish("other", root, dryRun, false),
      (error: unknown) => error instanceof Error && "details" in error && String((error as { details: { reason?: string } }).details.reason).includes("Issue source Version is stale"));
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("publication checks stored blocking questions and rejects a post-preflight race", async () => {
  const root = repository(); const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    await store.initialize("warn"); const work = new Module(store); const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, (await store.open()).database_id);
    const seed = await workspace.new("seed") as { path: string };
    const initial = await workspace.publish("seed", root, false, false) as { result: { requirement: { id: string }; issues: { id: string }[] } };
    const file = join(seed.path, "issues/main.md"); writeFileSync(file, readFileSync(file, "utf8").replace("Implement the requirement", "Revised implementation"));
    const publish = work.publishAuthoring.bind(work);
    work.publishAuthoring = async input => {
      const current = await work.currentRequirementRevision(initial.result.requirement.id);
      await work.reviseRequirement({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: current.requirement_id,
        expected_predecessor_id: current.id, input: { format: 1, summary: "Concurrent edit", outcomes: current.outcomes, open_questions: [{ question: "Unresolved policy", blocking: true }] } });
      return publish(input);
    };
    await assert.rejects(workspace.publish("seed", root, false, false), { code: "VERSION_CONFLICT" });
    work.publishAuthoring = publish;
    await workspace.openIssue(initial.result.issues[0].id, "blocked-binding", "current");
    for (const dryRun of [true, false]) await assert.rejects(workspace.publish("blocked-binding", root, dryRun, false),
      (error: unknown) => error instanceof Error && "details" in error && String((error as { details: { reason?: string } }).details.reason).includes("blocking Open Question"));
    assert.equal((await work.currentIssueRevision(initial.result.issues[0].id)).revision_number, 1);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});
