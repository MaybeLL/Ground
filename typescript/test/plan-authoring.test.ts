import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonWorkspaceStore, type JsonDraft, type JsonManifest, validateJsonDraft } from "../src/workspace-json.js";
import { issueInputFromRevision, parseIssueMarkdown, renderIssueMarkdown } from "../src/workspace-markdown.js";
import { validateIssueInput, type IssueRevision } from "../src/domain.js";

const PLAN = "方案：先加列，再拆定义。\n\n```mermaid\nflowchart TD\n  A-->B\n```";

const draftWith = (plan?: string): JsonDraft => ({
  requirement: { format: 1, summary: "R", outcomes: ["O"] },
  issues: [{
    key: "main",
    input: {
      format: 1,
      summary: "S",
      ...(plan === undefined ? {} : { plan }),
      goals: [{ statement: "G", criteria: ["C"], traces_to: [{ type: "outcome", ordinal: 1 }] }],
    },
    baselineExpression: "HEAD",
    questions: [],
    assumptions: [],
  }],
});

const manifestWith = (plan?: string): JsonManifest => ({
  format: "grounds.authoring-workspace/v2",
  name: "test",
  database_id: "db",
  repository_remote: "repo",
  requirement: {},
  issues: [{ key: "main", file: "issues/main.md" }],
  revision: 1,
  draft: draftWith(plan),
});

test("the JSON authoring draft accepts a plan and still rejects an unknown field", () => {
  assert.doesNotThrow(() => validateJsonDraft(draftWith(PLAN)));

  const stray = draftWith(PLAN) as unknown as { issues: { input: Record<string, unknown> }[] };
  stray.issues[0].input.not_a_field = "x";
  assert.throws(() => validateJsonDraft(stray as JsonDraft));
});

test("plan survives a JSON workspace save and read round trip", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-plan-authoring-"));
  try {
    const manifest = manifestWith(PLAN);
    writeFileSync(join(directory, ".workspace.json"), JSON.stringify(manifest));
    const snapshot = new JsonWorkspaceStore(directory).read();
    assert.equal((snapshot.draft.issues[0].input as { plan?: string }).plan, PLAN);
    assert.equal((snapshot.draft.issues[0].input as { plan?: string }).plan, manifest.draft.issues[0].input.plan);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy Markdown never carries a plan: a ## Plan line stays inside Context", () => {
  // The dangerous case is an existing Context that already contains `## Plan`.
  // Position cannot distinguish it from a real plan section, so the parser must
  // surface no plan field and leave the text where it was.
  const issue = {
    format: 1,
    summary: "S",
    context: "some background",
    goals: [{ statement: "G", criteria: ["C"], traces_to: [{ type: "outcome" as const, ordinal: 1 }] }],
  };
  const rendered = renderIssueMarkdown(issue, `sha1:${"a".repeat(40)}`);
  const injected = rendered.replace("some background", "some background\n\n## Plan\n\nthis line is ordinary Context prose");
  const parsed = parseIssueMarkdown(injected, "issues/main.md");
  assert.equal("plan" in parsed.input, false);
  assert.match(parsed.input.context ?? "", /## Plan/);
});

test("issueInputFromRevision omits plan when absent and includes it when present", () => {
  const base = {
    id: "01a1347f-2692-7624-9cf2-765c5de65b3a",
    issue_id: "01a1347f-2692-7624-9cf2-765c5de65b3a",
    requirement_id: "01a1347f-2692-7c00-82f3-03f6fd0ad281",
    requirement_revision_id: "01a1347f-2692-7c00-82f3-03f6fd0ad281",
    revision_number: 1,
    baseline: { git_oid: `sha1:${"a".repeat(40)}`, reachability: "remote_tracking_reachable" as const },
    summary: "S",
    goals: [],
    constraints: [],
  } satisfies IssueRevision;
  assert.equal("plan" in issueInputFromRevision(base), false);
  assert.equal(issueInputFromRevision({ ...base, plan: PLAN }).plan, PLAN);
  // Empty is treated as absent, matching the domain rule.
  assert.equal("plan" in issueInputFromRevision({ ...base, plan: "" }), false);
});

test("a whitespace-only plan is rejected rather than silently dropped", () => {
  // v3 requires an explicit failure: a blank section means the author probably
  // meant to write something, and quietly treating it as absent hides that.
  // Structural validation permits incomplete prose, so this gate lives in the
  // domain validator that publication runs.
  const issue = (plan: string) => ({ format: 1, summary: "S", plan, goals: [{ statement: "G", criteria: ["C"] }] });
  // The human-readable reason lives in `details.reason`; `message` is generic.
  const reasonOf = (fn: () => void): string => {
    try { fn(); } catch (error) { return String((error as { details?: { reason?: string } }).details?.reason ?? ""); }
    return "";
  };
  assert.match(reasonOf(() => validateIssueInput(issue("   \n  "))), /whitespace-only/);
  assert.match(reasonOf(() => validateIssueInput(issue(""))), /between 1 and 65536/);
  assert.doesNotThrow(() => validateIssueInput(issue("有内容")));
});

test("plan text may not contain a heading equal to a semantic section name", () => {
  // Such a heading would collide with the authoring parser's section split;
  // plan is non-normative prose, so those names are reserved.
  const issue = (plan: string) => ({ format: 1, summary: "S", plan, goals: [{ statement: "G", criteria: ["C"] }] });
  const reasonOf = (fn: () => void): string => {
    try { fn(); } catch (error) { return String((error as { details?: { reason?: string } }).details?.reason ?? ""); }
    return "";
  };
  for (const name of ["Summary", "Context", "Plan", "Goals", "Constraints", "Open Questions", "Assumptions"]) {
    assert.match(reasonOf(() => validateIssueInput(issue(`说明\n\n## ${name}\n\n正文`))), /reserved section heading/, `## ${name} must be rejected`);
    assert.match(reasonOf(() => validateIssueInput(issue(`# ${name}\n\n正文`))), /reserved section heading/, `# ${name} must be rejected`);
  }
  // Ordinary prose and non-reserved headings are fine.
  assert.doesNotThrow(() => validateIssueInput(issue("## 实现步骤\n\n先加列。\n\n### 细节\n\n再拆定义。")));
});
