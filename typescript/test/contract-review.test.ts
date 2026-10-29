import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectContractReview, renderContractReview, contractHTML } from "../src/contract-review.js";
import { parseRequirementMarkdown, renderRequirementMarkdown, renderIssueMarkdown } from "../src/workspace-markdown.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";
import type { Module } from "../src/module.js";
import type { WorkspaceModule } from "../src/workspace.js";

const req = { format: 1 as const, summary: "中文完整需求", context: "| 列 | 值 |\n| --- | --- |\n| 长表 | 正文 |\n\n```js\nconst x = '<script>alert(1)</script>';\n```\n\n<script>alert(2)</script>\n\n[恶意](javascript:alert%281%29)", outcomes: ["旧 outcome 一"], decisions: [{ statement: "重复标题", rationale: "理由", context: "背景", options: [{ key: "a", description: "方案 A" }], chosen_option: "a", trade_offs: [{ gain: "收益", sacrifice: "取舍", reason: "原因" }], consequences: [{ kind: "benefit" as const, statement: "后果" }] }], open_questions: [{ question: "阻塞问题", blocking: true, assumption: "完整假设" }] };
const issue = { format: 1 as const, summary: "中文 Issue", context: "完整上下文", goals: [{ statement: "重复标题", criteria: ["完整验收"], guidance: ["完整指引"], traces_to: [{ type: "outcome" as const, ordinal: 1 }] }], constraints: [{ statement: "重复标题", criteria: ["约束验收"], rationale: "约束缘由", traces_to: [{ type: "decision" as const, ordinal: 1 }] }] };
const revision = (version: number) => ({ ...req, id: `revision-${version}`, requirement_id: "requirement", revision_number: version, outcomes: [version === 1 ? "旧 outcome 一" : "新 outcome 一"], decisions: req.decisions, open_questions: req.open_questions });
const fakeWork = {
  contractRequirement: async (id: string, version?: number, rev?: string) => { if (id !== "requirement" || version === 99) throw new Error("fixed source missing"); return revision(version ?? Number(rev?.split("-")[1])); },
  contractIssue: async (id: string, version: number) => ({ requirement: { ...revision(version), requirement_id: id === "foreign" ? "foreign" : "requirement" }, repository: { id: "repository", canonical_remote: "ssh://example/repo" }, revision: { id: `issue-revision-${version}`, issue_id: id, revision_number: version, requirement_revision_id: `revision-${version}`, summary: issue.summary, context: issue.context, goals: issue.goals.map(target => ({ ...target, criteria: target.criteria.map(statement => ({ statement })) })), constraints: issue.constraints.map(target => ({ ...target, guidance: [], criteria: target.criteria.map(statement => ({ statement })) })), baseline: { git_oid: "sha1:123", reachability: "unconfirmed" } } }),
} as unknown as Module;
const reason = (pattern: RegExp) => (error: any) => pattern.test(error.details?.reason ?? error.message);
const options = (output: string) => ({ issues: [], output, format: "html" });
const workspaceFixture = (root: string, managed = false) => {
  const manifest = { format: "patchledger.authoring-workspace/v1", name: "draft", repository_remote: "ssh://example/repo", database_id: "test", requirement: managed ? { id: "requirement", version: 1, revision_id: "revision-1", base: req } : {}, issues: managed ? [{ key: "one", file: "issues/one.md", id: "issue", version: 1, revision_id: "issue-revision-1", requirement_revision_id: "revision-1", base: issue, baseline: { git_oid: "sha1:123", reachability: "unconfirmed" } }] : [] };
  const files: Record<string, string> = { "requirement.md": renderRequirementMarkdown(req, managed ? "requirement" : undefined, managed ? 1 : undefined), "issues/one.md": renderIssueMarkdown(issue, managed ? "sha1:123" : "UNRESOLVED", managed ? "issue" : undefined, managed ? 1 : undefined).replace("## Open Questions\n", "## Open Questions\n\n### 待解决问题\n\n完整问题正文解释\n"), "external-issues.md": "跨仓摘要不属于完整范围" };
  const reader = { reviewSnapshot: () => ({ path: root, manifest: structuredClone(manifest), files: { ...files } }) } as unknown as WorkspaceModule;
  return { manifest, files, reader };
};

test("fixed scope includes historical bindings, deduplicates, escapes content, and exports identical Markdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-contract-"));
  try {
    const selected = { ...options(root), requirement: "requirement@2", issues: ["issue@1", "issue@1", "second@2"] };
    const result = await renderContractReview(fakeWork, selected); assertContract("command-results.schema.json", result);
    assert.equal(result.source.objects.length, 4); const html = readFileSync(result.path, "utf8");
    for (const text of ["旧 outcome 一", "新 outcome 一", "完整验收", "完整指引", "约束缘由", "完整假设", "trade_offs", "sha1:123", "repository", "table"]) assert.ok(html.includes(text), text);
    assert.ok(html.includes('href="#requirement-requirement-v1-outcome-1"')); assert.ok(html.includes('href="#requirement-requirement-v2-outcome-1"'));
    assert.ok(!html.includes("<script>")); assert.ok(!html.includes('href="javascript:')); assert.ok(!html.includes("<img"));
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]); assert.equal(new Set(ids).size, ids.length);
    const again = await renderContractReview(fakeWork, selected); assert.equal(again.content_digest, result.content_digest);
    const markdown = await renderContractReview(fakeWork, { ...selected, format: "markdown" }); assert.equal(markdown.content_digest, result.content_digest); assert.match(readFileSync(markdown.path, "utf8"), /旧 outcome 一/);
    const only = await renderContractReview(fakeWork, { ...options(root), requirement: "requirement@1" }); assert.equal(only.source.objects.length, 1);
    await assert.rejects(renderContractReview(fakeWork, { ...options(root), issues: ["issue@1", "foreign@1"] }), reason(/mixed Requirement/));
    await assert.rejects(renderContractReview(fakeWork, { ...options(root), requirement: "requirement@99", format: "markdown" }), /fixed source missing/);
    writeFileSync(join(root, "not-directory"), "old"); await assert.rejects(renderContractReview(fakeWork, { ...selected, output: join(root, "not-directory"), format: "markdown" })); assert.equal(readFileSync(join(root, "not-directory"), "utf8"), "old");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft full collection, note-only binding preservation, changed requirement binding and consistency", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-contract-draft-"));
  try {
    const fixture = workspaceFixture(join(root, "draft"), true); mkdirSync(join(root, "draft"));
    const selected = { ...options(join(root, "output")), workspace: "draft" };
    fixture.files["requirement.md"] = fixture.files["requirement.md"].replace("旧 outcome 一", "新草稿 outcome 一");
    let result = await renderContractReview(fakeWork, selected, fixture.reader);
    assert.equal(result.source.objects.find(item => item.kind === "issue")?.binding, "requirement-requirement-v1");
    assert.match(readFileSync(result.path, "utf8"), /完整问题正文解释/); assert.equal(result.source.external_issues_excluded, true);
    const before = result.content_digest; fixture.files["issues/one.md"] += "\n<!-- 完整附注变化 -->\n";
    result = await renderContractReview(fakeWork, selected, fixture.reader); assert.notEqual(result.content_digest, before);
    fixture.files["issues/renamed.md"] = fixture.files["issues/one.md"]; delete fixture.files["issues/one.md"];
    result = await renderContractReview(fakeWork, selected, fixture.reader); assert.match(result.source_paths[1], /renamed.md$/);
    fixture.files["issues/renamed.md"] = fixture.files["issues/renamed.md"].replace("完整验收", "共同修订验收");
    result = await renderContractReview(fakeWork, selected, fixture.reader); assert.equal(result.source.objects.find(item => item.kind === "issue")?.binding, "requirement-draft");
    const collected = await collectContractReview(fakeWork, selected, fixture.reader); fixture.files["issues/new.md"] = renderIssueMarkdown(issue, "not-a-ref"); assert.throws(collected.assertConsistent, reason(/changed/));
    result = await renderContractReview(fakeWork, selected, fixture.reader); assert.equal(result.source.objects.filter(item => item.kind === "issue").length, 2);
    fixture.files["issues/duplicate.md"] = fixture.files["issues/renamed.md"]; await assert.rejects(renderContractReview(fakeWork, selected, fixture.reader), reason(/duplicate/)); delete fixture.files["issues/duplicate.md"];
    delete fixture.files["issues/renamed.md"]; await assert.rejects(renderContractReview(fakeWork, selected, fixture.reader), reason(/missing/));
    await assert.rejects(renderContractReview(fakeWork, { ...selected, output: join(root, "draft") }, workspaceFixture(join(root, "draft")).reader), reason(/outside/));
    symlinkSync(join(root, "draft"), join(root, "linked")); await assert.rejects(renderContractReview(fakeWork, { ...selected, output: join(root, "linked") }, workspaceFixture(join(root, "draft")).reader), reason(/outside/));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("new requirement-only, invalid traces, explicit binding and output safety", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-contract-zero-"));
  try {
    mkdirSync(join(root, "draft")); const f = workspaceFixture(join(root, "draft")); const selected = { ...options(root), workspace: "draft" };
    delete f.files["issues/one.md"]; assert.equal((await renderContractReview(fakeWork, selected, f.reader)).source.objects.length, 1);
    f.files["issues/new.md"] = renderIssueMarkdown({ ...issue, goals: [{ ...issue.goals[0], traces_to: [{ type: "outcome", ordinal: 9 }] }] }, "unknown"); await assert.rejects(renderContractReview(fakeWork, selected, f.reader), reason(/invalid trace/));
    const managed = workspaceFixture(join(root, "draft"), true); Object.assign(managed.manifest.issues[0], { desired_requirement_revision_id: "revision-2" });
    assert.equal((await renderContractReview(fakeWork, selected, managed.reader)).source.objects.find(item => item.kind === "issue")?.binding, "requirement-requirement-v2");
    const valid = await renderContractReview(fakeWork, selected, workspaceFixture(join(root, "draft")).reader); rmSync(valid.path); symlinkSync(join(root, "victim"), valid.path); writeFileSync(join(root, "victim"), "keep");
    await assert.rejects(renderContractReview(fakeWork, selected, workspaceFixture(join(root, "draft")).reader), reason(/regular file/)); assert.equal(readFileSync(join(root, "victim"), "utf8"), "keep");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("public CLI works with isolated SQLite and refuses implicit versions", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-contract-cli-"));
  const run = async (...args: string[]) => { const output: string[] = []; const code = await runCLI([...args, "--json"], { cwd: root, stdout: line => output.push(line), stderr: () => undefined }); return { code, envelope: JSON.parse(output.join("\n")) }; };
  try {
    execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "remote", "add", "origin", "ssh://example.test/team/repo"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test"]); execFileSync("git", ["-C", root, "config", "user.email", "test@example.test"]); writeFileSync(join(root, "base"), "base"); execFileSync("git", ["-C", root, "add", "base"]); execFileSync("git", ["-C", root, "commit", "-qm", "base"]); execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    const config = join(root, "config.yaml"); assert.equal((await run("init", "--driver", "sqlite", "--path", join(root, "ledger.db"), "--config", config, "--non-interactive")).code, 0);
    const created = await run("workspace", "new", "--format", "markdown", "draft", "--config", config); assert.equal(created.code, 0, JSON.stringify(created.envelope));
    const rendered = await run("contract", "render", "--workspace", "draft", "--output", join(root, "review"), "--config", config); assert.equal(rendered.code, 0, JSON.stringify(rendered.envelope)); assertContract("cli-envelope.schema.json", rendered.envelope);
    const published = await run("workspace", "publish", "draft", "--config", config); assert.equal(published.code, 0, JSON.stringify(published.envelope));
    const requirementID = published.envelope.data.requirement.id; const issueID = published.envelope.data.issues[0].id;
    const fixed = await run("contract", "render", "--requirement", `${requirementID}@1`, "--issue", `${issueID}@1`, "--output", join(root, "fixed"), "--config", config); assert.equal(fixed.code, 0, JSON.stringify(fixed.envelope)); assertContract("cli-envelope.schema.json", fixed.envelope);
    const reqPath = join(created.envelope.data.path, "requirement.md"); writeFileSync(reqPath, readFileSync(reqPath, "utf8").replace("# Summary", "# Summary").replace("## Context", "更新说明\n\n## Context"));
    const revised = await run("workspace", "publish", "draft", "--config", config); assert.equal(revised.code, 0, JSON.stringify(revised.envelope));
    const bound = await run("contract", "render", "--workspace", "draft", "--output", join(root, "bound"), "--config", config); assert.equal(bound.code, 0, JSON.stringify(bound.envelope)); assert.equal(bound.envelope.data.source.objects.filter((item: any) => item.kind === "requirement").length, 2);
    const markdown = await run("contract", "render", "--issue", `${issueID}@1`, "--output", join(root, "fallback"), "--format", "markdown", "--config", config); assert.equal(markdown.code, 0, JSON.stringify(markdown.envelope)); assert.ok(!readFileSync(markdown.envelope.data.path, "utf8").includes("更新说明"));
    assert.equal((await run("contract", "render", "--requirement", "abc", "--output", root, "--config", config)).code, 2);
    const help = await run("contract", "render", "--help"); assert.equal(help.code, 0); assert.match(help.envelope.data.usage, /ID@VERSION/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("snapshot checks compare bytes, membership, names and managed bindings before emitting output", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-contract-race-"));
  try {
    const selected = { ...options(root), workspace: "draft" };
    for (const mutate of [
      (f: ReturnType<typeof workspaceFixture>) => { f.files["requirement.md"] += "\nbyte change\n"; },
      (f: ReturnType<typeof workspaceFixture>) => { f.files["issues/new.md"] = renderIssueMarkdown(issue, "unresolved"); },
      (f: ReturnType<typeof workspaceFixture>) => { delete f.files["issues/one.md"]; },
      (f: ReturnType<typeof workspaceFixture>) => { f.files["issues/renamed.md"] = f.files["issues/one.md"]; delete f.files["issues/one.md"]; },
      (f: ReturnType<typeof workspaceFixture>) => { f.manifest.repository_remote = "ssh://changed/repo"; },
    ]) {
      const fixture = workspaceFixture(join(root, "draft")); const read = fixture.reader.reviewSnapshot.bind(fixture.reader); let calls = 0;
      fixture.reader.reviewSnapshot = name => { if (++calls === 2) mutate(fixture); return read(name); };
      await assert.rejects(renderContractReview(fakeWork, selected, fixture.reader), reason(/changed/));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("renderer failure preserves complete output and exact fixed Markdown fallback remains available", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-contract-render-failure-"));
  try {
    const selected = { ...options(root), requirement: "requirement@1", issues: ["issue@1"] };
    const previous = await renderContractReview(fakeWork, selected); const before = readFileSync(previous.path);
    await assert.rejects(renderContractReview(fakeWork, selected, undefined, () => { throw new Error("injected renderer failure"); }), reason(/renderer failure/));
    assert.deepEqual(readFileSync(previous.path), before);
    const fallback = await renderContractReview(fakeWork, { ...selected, format: "markdown" }, undefined, () => { throw new Error("renderer must not run"); });
    assert.equal(fallback.content_digest, previous.content_digest); assert.match(readFileSync(fallback.path, "utf8"), /旧 outcome 一/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Outcome anchors follow parsed source order across nested, loose and mixed bullet lists", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-contract-outcome-order-"));
  try {
    const variants = [
      "- 父条目\n  - 子条目\n    - 孙条目\n- 尾条目",
      "* 重复正文\n\n  * 重复正文\n\n* 尾条目",
      "- [outcome-1] 父条目\n  * [outcome-2] 子条目\n    - [outcome-3] 孙条目\n* [outcome-4] 尾条目",
      "- 父条目\n\t- 子条目\n- 尾条目",
    ];
    for (const outcomes of variants) {
      const fixture = workspaceFixture(join(root, "draft"));
      fixture.files["requirement.md"] = renderRequirementMarkdown(req).replace("- [outcome-1] 旧 outcome 一", outcomes);
      const parsed = parseRequirementMarkdown(fixture.files["requirement.md"]).input.outcomes;
      fixture.files["issues/one.md"] = renderIssueMarkdown({ ...issue, goals: [{ ...issue.goals[0], traces_to: parsed.map((_, index) => ({ type: "outcome" as const, ordinal: index + 1 })) }] }, "UNRESOLVED");
      const collected = await collectContractReview(fakeWork, { ...options(root), workspace: "draft" }, fixture.reader);
      const { html } = contractHTML(collected.sections, collected.source, collected.digest, new Date().toISOString());
      const anchors = [...html.matchAll(/<section class="reading-block reading-target" id="requirement-draft-outcome-(\d+)">(?:<p>)?([^<\n]+)/g)].map(match => ({ ordinal: Number(match[1]), text: match[2].replace(/^\[outcome-\d+\] /, "").trim() }));
      assert.deepEqual(anchors, parsed.map((text, index) => ({ ordinal: index + 1, text })), outcomes);
      for (let i = 1; i <= parsed.length; i++) assert.ok(html.includes(`href="#requirement-draft-outcome-${i}">outcome-${i}</a>`));
    }
    // Parsed semantic ordinals also work when Markdown indentation would
    // treat the source list as code. Never emit dangling traces.
    const unsupported = workspaceFixture(join(root, "draft")); mkdirSync(join(root, "draft"));
    unsupported.files["requirement.md"] = renderRequirementMarkdown(req).replace("- [outcome-1] 旧 outcome 一", "    - 缩进条目\n    - 另一条目");
    const selected = { ...options(root), workspace: "draft" };
    const rendered = await renderContractReview(fakeWork, selected, unsupported.reader);
    assert.match(readFileSync(rendered.path, "utf8"), /id="requirement-draft-outcome-2"/);
    const fallback = await renderContractReview(fakeWork, { ...selected, format: "markdown" }, unsupported.reader);
    assert.match(readFileSync(fallback.path, "utf8"), /    - 缩进条目/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed Issue source contract and complete Baseline must match the fixed source before binding decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-contract-source-integrity-"));
  try {
    const selected = { ...options(root), workspace: "draft" };
    const changes = [
      (entry: any, f: ReturnType<typeof workspaceFixture>) => { entry.base.goals[0].criteria[0] = "被改写的验收"; f.files["issues/one.md"] = f.files["issues/one.md"].replace("完整验收", "被改写的验收"); },
      (entry: any) => { entry.base.context = "基准上下文变更"; },
      (entry: any) => { entry.base.goals[0].guidance = ["伪造指引"]; },
      (entry: any) => { entry.base.constraints[0].rationale = "伪造约束缘由"; },
      (entry: any) => { entry.base.goals[0].traces_to = []; },
      (entry: any) => { delete entry.base; },
      (entry: any, f: ReturnType<typeof workspaceFixture>) => { entry.baseline.git_oid = "changed-baseline"; f.files["issues/one.md"] = f.files["issues/one.md"].replace("sha1:123", "changed-baseline"); },
      (entry: any) => { entry.baseline.reachability = "remote_tracking_reachable"; },
      (entry: any) => { entry.baseline.warning = "伪造警告"; },
      (entry: any) => { entry.baseline.override_reason = "伪造理由"; },
      (entry: any) => { delete entry.baseline; },
      (entry: any) => { entry.requirement_revision_id = "revision-2"; },
      (entry: any) => { entry.revision_id = "different-fixed-revision"; },
    ];
    for (const change of changes) {
      const fixture = workspaceFixture(join(root, "draft"), true); fixture.manifest.issues[0].base = structuredClone(issue);
      fixture.files["requirement.md"] = fixture.files["requirement.md"].replace("旧 outcome 一", "新草稿 outcome 一");
      change(fixture.manifest.issues[0], fixture);
      await assert.rejects(collectContractReview(fakeWork, selected, fixture.reader), reason(/managed source/));
    }
    const valid = workspaceFixture(join(root, "draft"), true);
    assert.equal((await collectContractReview(fakeWork, selected, valid.reader)).sections.find(s => s.kind === "issue")?.binding, "requirement-requirement-v1");
    valid.files["requirement.md"] = valid.files["requirement.md"].replace("旧 outcome 一", "合法共同修订需求");
    valid.files["issues/one.md"] = valid.files["issues/one.md"].replace("完整验收", "合法共同修订验收");
    assert.equal((await collectContractReview(fakeWork, selected, valid.reader)).sections.find(s => s.kind === "issue")?.binding, "requirement-draft");
    Object.assign(valid.manifest.issues[0], { desired_requirement_revision_id: "revision-foreign" });
    const foreignBinding = { ...fakeWork, contractRequirement: async (id: string, version?: number, revisionID?: string) => revisionID === "revision-foreign" ? { ...revision(1), id: revisionID, requirement_id: "another-requirement" } : fakeWork.contractRequirement(id, version, revisionID) } as unknown as Module;
    await assert.rejects(collectContractReview(foreignBinding, selected, valid.reader), reason(/managed source desired Requirement binding conflict/));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Workspace previews exports are allowed but preview symlinks cannot escape',async()=>{
 const root=mkdtempSync(join(tmpdir(),'grounds-previews-'));try{
   const workspace=join(root,'draft');mkdirSync(workspace);const fixture=workspaceFixture(workspace);writeFileSync(join(workspace,'.workspace.json'),JSON.stringify(fixture.manifest));const output=join(workspace,'previews');
   const result=await renderContractReview(fakeWork,{...options(output),workspace:'draft'},fixture.reader);assert.ok(result.path.startsWith(realpathSync(output)));assert.equal(fixture.reader.reviewSnapshot('draft').files['requirement.md'],fixture.files['requirement.md']);
   rmSync(output,{recursive:true});const external=join(root,'external');mkdirSync(external);symlinkSync(external,output);await assert.rejects(renderContractReview(fakeWork,{...options(output),workspace:'draft'},fixture.reader),reason(/symbolic link/));
 }finally{rmSync(root,{recursive:true,force:true});}
});
