import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module } from "../src/module.js";
import { SQLStore } from "../src/sql-store.js";
import { WorkspaceModule, parseRequirementMarkdown, parseIssueMarkdown, renderRequirementMarkdown, renderIssueMarkdown } from "../src/workspace.js";
import { collectContractReview, renderContractReview } from "../src/contract-review.js";
import { requirementInputFromRevision } from "../src/workspace-markdown.js";
import { newUUIDv7 } from "../src/identity.js";
import { testAgent } from "./fixture.js";

const reason = (pattern: RegExp) => (error: any) => pattern.test(error.details?.reason ?? error.message);

test("real Workspace review preserves the complete binding matrix even when publication is stale", async t => {
  const root = mkdtempSync(join(tmpdir(), "grounds-contract-matrix-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Contract Test"); git("config", "user.email", "contract@example.test");
  git("remote", "add", "origin", "ssh://git@example.test/team/contracts"); writeFileSync(join(root, "base"), "base"); git("add", "base"); git("commit", "-qm", "baseline"); git("update-ref", "refs/remotes/origin/main", "HEAD");
  const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const work = new Module(store);
    const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id);
    await workspace.new("seed");
    const published = await workspace.publish("seed", root, false, false) as { result: { requirement: { id: string }; issues: { id: string }[] } };
    const requirementID = published.result.requirement.id, issueID = published.result.issues[0].id;
    const stale = await workspace.openRequirement(requirementID, "stale") as { path: string };
    const first = await work.currentRequirementRevision(requirementID);
    await work.reviseRequirement({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: requirementID, expected_predecessor_id: first.id, input: { ...requirementInputFromRevision(first), summary: "新版需求", outcomes: ["新版 outcome 正文"] } });
    const opts = (name: string) => ({ workspace: name, issues: [], output: join(root, "review"), format: "html" });
    const render = (name: string) => renderContractReview(work, opts(name), workspace);
    const binding = (result: Awaited<ReturnType<typeof render>>) => result.source.objects.find(item => item.kind === "issue")!.binding;
    const oldKey = `requirement-${requirementID}-v1`, currentKey = `requirement-${requirementID}-v2`;
    await t.test("a stale publication source remains readable without publishing or rebasing", async () => {
      const path = join(stale.path, "issues", `${issueID}.md`); const draft = parseIssueMarkdown(readFileSync(path, "utf8"));
      writeFileSync(path, renderIssueMarkdown({ ...draft.input, summary: "编辑过期来源" }, draft.baselineExpression, draft.frontmatter.id, draft.frontmatter.version));
      await assert.rejects(workspace.publish("stale", root, true, false), reason(/stale/));
      const result = await render("stale"); assert.equal(binding(result), oldKey); assert.match(readFileSync(result.path, "utf8"), /编辑过期来源/);
      const markdown = await renderContractReview(work, { ...opts("stale"), format: "markdown" }, workspace); assert.equal(markdown.content_digest, result.content_digest);
    });
    const unchanged = await workspace.openRequirement(requirementID, "unchanged") as { path: string };
    const issuePath = join(unchanged.path, "issues", `${issueID}.md`), reqPath = join(unchanged.path, "requirement.md");
    const issueText = readFileSync(issuePath, "utf8"), reqText = readFileSync(reqPath, "utf8");
    await t.test("unchanged Issue keeps its old requirement while the workspace opens current", async () => {
      const result = await render("unchanged"); assert.equal(binding(result), oldKey); assert.equal(result.source.objects.filter(item => item.kind === "requirement").length, 2);
    });
    await t.test("Issue-only edit with unchanged requirement preserves old binding", async () => {
      const draft = parseIssueMarkdown(issueText); writeFileSync(issuePath, renderIssueMarkdown({ ...draft.input, summary: "只改 Issue" }, draft.baselineExpression, draft.frontmatter.id, draft.frontmatter.version));
      assert.equal(binding(await render("unchanged")), oldKey); writeFileSync(issuePath, issueText);
    });
    await t.test("new Issue with unchanged current requirement uses current fixed version", async () => {
      const draft = parseIssueMarkdown(issueText); writeFileSync(join(unchanged.path, "issues", "new.md"), renderIssueMarkdown({ ...draft.input, summary: "新增 Issue" }, "UNRESOLVED"));
      const result = await render("unchanged"); assert.equal(result.source.objects.find(item => item.kind === "issue" && !item.id)!.binding, currentKey); rmSync(join(unchanged.path, "issues", "new.md"));
    });
    await t.test("explicit current binding changes the interpretation without prose changes", async () => {
      await workspace.openIssue(issueID, "current", "current"); assert.equal(binding(await render("current")), currentKey);
    });
    await t.test("common edits use the requirement draft, while unchanged and note-only Issues keep old binding", async () => {
      const req = parseRequirementMarkdown(reqText); writeFileSync(reqPath, renderRequirementMarkdown({ ...req.input, outcomes: ["本轮新 outcome"] }, req.frontmatter.id, req.frontmatter.version));
      writeFileSync(issuePath, issueText + "\n<!-- 附注 -->\n"); assert.equal(binding(await render("unchanged")), oldKey);
      const draft = parseIssueMarkdown(issueText); writeFileSync(issuePath, renderIssueMarkdown({ ...draft.input, summary: "共同修订" }, draft.baselineExpression, draft.frontmatter.id, draft.frontmatter.version));
      assert.equal(binding(await render("unchanged")), "requirement-draft"); writeFileSync(reqPath, reqText); writeFileSync(issuePath, issueText);
    });
    await t.test("each semantic field and file scope changes the fingerprint", async () => {
      const before = await render("unchanged");
      const req = parseRequirementMarkdown(reqText), issue = parseIssueMarkdown(issueText);
      const cases: [string, string][] = [
        [reqPath, renderRequirementMarkdown({ ...req.input, summary: "标题变化" }, req.frontmatter.id, req.frontmatter.version)],
        [reqPath, renderRequirementMarkdown({ ...req.input, context: "背景变化" }, req.frontmatter.id, req.frontmatter.version)],
        [reqPath, renderRequirementMarkdown({ ...req.input, outcomes: ["结果变化"] }, req.frontmatter.id, req.frontmatter.version)],
        [reqPath, renderRequirementMarkdown({ ...req.input, decisions: [{ statement: "决策变化", rationale: "明确缘由" }] }, req.frontmatter.id, req.frontmatter.version)],
        [reqPath, renderRequirementMarkdown({ ...req.input, open_questions: [{ question: "未决变化", blocking: true, assumption: "完整假设" }] }, req.frontmatter.id, req.frontmatter.version)],
        [issuePath, renderIssueMarkdown({ ...issue.input, context: "Issue 背景变化" }, issue.baselineExpression, issue.frontmatter.id, issue.frontmatter.version)],
        [issuePath, renderIssueMarkdown({ ...issue.input, goals: issue.input.goals.map(goal => ({ ...goal, criteria: ["验收变化"] })) }, issue.baselineExpression, issue.frontmatter.id, issue.frontmatter.version)],
        [issuePath, renderIssueMarkdown({ ...issue.input, goals: issue.input.goals.map(goal => ({ ...goal, guidance: ["指引变化"] })) }, issue.baselineExpression, issue.frontmatter.id, issue.frontmatter.version)],
        [issuePath, renderIssueMarkdown({ ...issue.input, constraints: [{ statement: "约束变化", criteria: ["约束验收"], rationale: "约束缘由" }] }, issue.baselineExpression, issue.frontmatter.id, issue.frontmatter.version)],
        [issuePath, issueText.replace("## Open Questions", "## Open Questions\n\n### 新问题\n\n完整问题正文")],
        [issuePath, renderIssueMarkdown(issue.input, "UNRESOLVED", issue.frontmatter.id, issue.frontmatter.version)],
        [issuePath, issueText + "\n<!-- 完整附注变化 -->\n"],
      ];
      for (const [path, text] of cases) {
        writeFileSync(path, text); const next = await render("unchanged"); assert.notEqual(next.content_digest, before.content_digest, text); assert.notEqual(next.path, before.path); writeFileSync(path, path === reqPath ? reqText : issueText);
      }
      const renamed = join(unchanged.path, "issues", "renamed.md"); renameSync(issuePath, renamed); assert.notEqual((await render("unchanged")).content_digest, before.content_digest); renameSync(renamed, issuePath);
      const extra = join(unchanged.path, "issues", "extra.md"); writeFileSync(extra, renderIssueMarkdown(issue.input, "UNRESOLVED")); assert.notEqual((await render("unchanged")).content_digest, before.content_digest); rmSync(extra);
      assert.equal((await render("unchanged")).content_digest, before.content_digest);
    });
    await t.test("real managed binding metadata changes invalidate an already collected snapshot", async () => {
      const manifestPath = join(unchanged.path, ".workspace.json"), original = readFileSync(manifestPath, "utf8");
      const second = await work.currentRequirementRevision(requirementID);
      for (const field of ["desired_requirement_revision_id", "requirement_revision_id", "revision_id", "version", "baseline", "base"]) {
        const collected = await collectContractReview(work, opts("unchanged"), workspace); const manifest = JSON.parse(original);
        const values: Record<string, unknown> = { desired_requirement_revision_id: second.id, requirement_revision_id: second.id, revision_id: newUUIDv7(), version: 2, baseline: { git_oid: "sha1:" + "0".repeat(40) }, base: { ...manifest.issues[0].base, summary: "冲突来源" } };
        manifest.issues[0][field] = values[field]; writeFileSync(manifestPath, JSON.stringify(manifest)); assert.throws(collected.assertConsistent, reason(/changed/), field); writeFileSync(manifestPath, original);
      }
    });
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});
