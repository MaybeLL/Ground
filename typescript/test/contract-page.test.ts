import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderWorkspaceReading,
  renderReadingSections,
  READING_CSS,
} from "../src/contract-page.js";
import type { JsonSnapshot } from "../src/workspace-json.js";
const fixture = (): JsonSnapshot => {
  const requirement = {
    format: 1,
    summary: "契约",
    context: "**背景**",
    outcomes: ["目标一", "目标二"],
    decisions: [
      {
        statement: "决策",
        rationale: "理由",
        options: [{ key: "a", description: "方案" }],
        chosen_option: "a",
      },
    ],
  };
  const issue = {
    key: "main",
    input: {
      format: 1,
      summary: "实现",
      goals: [
        {
          statement: "目标",
          criteria: ["验收"],
          traces_to: [{ type: "outcome" as const, ordinal: 2 }],
        },
      ],
      constraints: [{ statement: "限制", criteria: ["约束验收"] }],
    },
    baselineExpression: "sha1:base",
    questions: ["问题"],
    assumptions: ["假设"],
  };
  const draft = { requirement, issues: [issue] };
  return {
    version: "test-version",
    draft,
    manifest: {
      format: "grounds.authoring-workspace/v2",
      revision: 1,
      name: "test",
      database_id: "isolated",
      repository_remote: "ssh://example.test/repo",
      requirement: {},
      issues: [{ key: "main", file: "issues/main.md" }],
      draft,
    },
  };
};
test("live reading exposes individual semantic paths, empty optional entrances, grouped complete navigation, and safe prose", () => {
  const snapshot = fixture();
  snapshot.draft.requirement.context =
    "<script>evil()</script>\n\n[unsafe](javascript:alert)";
  const page = renderWorkspaceReading(snapshot);
  const paths = page.blocks.map((b) => JSON.stringify(b.path));
  for (const path of [
    ["requirement", "outcomes", 0],
    ["requirement", "decisions", 0],
    ["issues", 0, "input", "goals", 0],
    ["issues", 0, "input", "constraints", 0],
    ["issues", 0, "input", "plan"],
    ["issues", 0, "input", "target_branch"],
    ["issues", 0, "questions"],
    ["issues"],
  ])
    assert.ok(paths.includes(JSON.stringify(path)), JSON.stringify(path));
  assert.match(page.html, /data-edit-label=/);
  assert.match(page.navigation, /reading-nav-collection/);
  assert.match(page.navigation, /reading-nav-entry/);
  assert.match(page.navigation, /查看 Outcome 1 正文/);
  assert.match(READING_CSS, /-webkit-line-clamp:2/);
  assert.ok(!page.html.includes("<script>"));
  assert.ok(!page.html.includes('href="javascript:'));
  assert.match(page.html, /&lt;script&gt;/);
  assert.match(page.html, /href="#requirement-draft-outcome-2"/);
  const ids = [...page.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(page.source.workspace_version, snapshot.version);
});
test("managed fixed base and edited Requirement use distinct anchors until both contracts change", () => {
  const snapshot = fixture();
  const { manifest, draft } = snapshot;
  Object.assign(manifest.requirement, {
    id: "req",
    revision_id: "req-rev",
    version: 1,
    base: structuredClone(draft.requirement),
  });
  Object.assign(manifest.issues[0], {
    id: "issue",
    version: 1,
    revision_id: "issue-rev",
    requirement_revision_id: "req-rev",
    base: structuredClone(draft.issues[0].input),
    baseline: { git_oid: "sha1:base", reachability: "unconfirmed" },
  });
  draft.requirement.outcomes[1] = "新的目标";
  const fixed = renderWorkspaceReading(snapshot);
  assert.match(fixed.html, /href="#requirement-req-v1-outcome-2"/);
  assert.ok(!fixed.blocks.some((b) => b.id.startsWith("requirement-req-v1")));
  draft.issues[0].input.goals[0].statement = "修订目标";
  const joint = renderWorkspaceReading(snapshot);
  assert.match(joint.html, /href="#requirement-draft-outcome-2"/);
  assert.ok(!joint.html.includes('id="requirement-req-v1"'));
  manifest.issues[0].desired_requirement_revision_id = "missing-revision";
  assert.throws(
    () => renderWorkspaceReading(snapshot),
    (error) =>
      !!error &&
      typeof error === "object" &&
      "details" in error &&
      JSON.stringify(error.details).includes("source missing"),
  );
});
test("unfinished references remain readable but never become dangling semantic hyperlinks", () => {
  const snapshot = fixture();
  snapshot.draft.issues[0].input.goals[0].traces_to[0].ordinal = 99;
  const page = renderWorkspaceReading(snapshot);
  assert.match(page.html, /outcome-99（未解析的关联，请修订）/);
  assert.ok(!page.html.includes('href="#requirement-draft-outcome-99"'));
});
test("shared static and live body preserve all criterion content, omit duplicate Summary prose, and render Mermaid plan", () => {
  const snapshot = fixture();
  snapshot.draft.issues[0].input = {
    ...snapshot.draft.issues[0].input,
    plan: "```mermaid\nflowchart LR\n A-->B\n```",
  } as (typeof snapshot.draft.issues)[0]["input"];
  const page = renderWorkspaceReading(snapshot);
  assert.equal(page.diagrams, 1);
  assert.match(page.html, /方案说明：以下内容/);
  assert.match(page.html, /data-mermaid-source/);
  const staticPage = renderReadingSections([
    {
      key: "requirement-draft",
      kind: "requirement",
      state: "published",
      input: snapshot.draft.requirement,
      markdown: "",
    },
  ]);
  assert.ok(!staticPage.html.includes("data-edit-path="));
  assert.equal(staticPage.html.match(/<h2>契约<\/h2>/g)?.length, 1);
  assert.ok(!staticPage.html.includes("<h3>Summary</h3>"));
  assert.match(staticPage.html, /<strong>背景<\/strong>/);
});
