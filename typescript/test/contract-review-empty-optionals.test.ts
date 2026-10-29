import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module } from "../src/module.js";
import { SQLStore } from "../src/sql-store.js";
import { WorkspaceModule } from "../src/workspace.js";
import { JsonWorkspaceStore, type JsonManifest } from "../src/workspace-json.js";
import type { IssueInput, RequirementInput } from "../src/domain.js";
import { collectContractReview, renderContractReview } from "../src/contract-review.js";
import { newUUIDv7 } from "../src/identity.js";
import { testAgent } from "./fixture.js";

const reason = (pattern: RegExp) => (error: unknown) => {
  const failure = error as { details?: { reason?: string }; message?: string };
  return pattern.test(failure.details?.reason ?? failure.message ?? "");
};

interface Options { root: string; work: Module; ws: WorkspaceModule; local: JsonWorkspaceStore; path: string }
interface PublishOutcome { result: { requirement: { version: number }; issues: { version: number }[]; no_op?: boolean } }

async function jsonWorkspace(fn: (options: Options) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "grounds-contract-empty-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  writeFileSync(join(root, "base"), "base"); git("add", "."); git("commit", "-qm", "baseline");
  git("remote", "add", "origin", "ssh://git@example.test/team/empty"); git("update-ref", "refs/remotes/origin/main", "HEAD");
  const store = SQLStore.sqlite(join(root, "ledger.db"));
  try {
    const metadata = await store.initialize("warn"); const work = new Module(store);
    const ws = new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id, newUUIDv7, true);
    const created = await ws.new("draft") as { path: string };
    await fn({ root, work, ws, local: new JsonWorkspaceStore(created.path), path: created.path });
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}

const publish = (ws: WorkspaceModule, root: string, local: JsonWorkspaceStore) =>
  ws.publish("draft", root, false, false, false, "", undefined, local.read().version) as Promise<PublishOutcome>;
const review = (work: Module, ws: WorkspaceModule) => collectContractReview(work, { workspace: "draft", issues: [], output: "", format: "html" }, ws);
const readManifest = (path: string): JsonManifest => JSON.parse(readFileSync(join(path, ".workspace.json"), "utf8"));

const emptyOptionalVariants: readonly [string, Partial<RequirementInput>][] = [
  ["empty open_questions", { open_questions: [] }],
  ["empty decisions", { decisions: [] }],
  ["both empty optionals", { open_questions: [], decisions: [] }],
];
for (const [label, optionals] of emptyOptionalVariants)
  test(`published draft keeps ${label} equivalent to omitted ones for contract review`, async () =>
    jsonWorkspace(async ({ root, work, ws, local, path }) => {
      const snap = local.read();
      await local.save({ ...snap.draft, requirement: { ...snap.draft.requirement, ...optionals } }, snap.version);
      const published = await publish(ws, root, local);
      assert.equal(published.result.requirement.version, 1);
      for (const field of ["open_questions", "decisions"] as const) {
        if (optionals[field] !== undefined) assert.deepEqual(readManifest(path).requirement.base?.[field], []);
      }
      const beforeReview = readFileSync(join(path, ".workspace.json"), "utf8");
      const collected = await review(work, ws);
      assert.deepEqual(collected.sections.map(section => [section.kind, section.state]), [["requirement", "draft"], ["requirement", "published"], ["issue", "draft"]]);
      assert.equal(collected.sections[2].binding, collected.sections[1].key);
      assert.equal(readFileSync(join(path, ".workspace.json"), "utf8"), beforeReview);

      const edit = local.read();
      await local.save({ ...edit.draft, requirement: { ...edit.draft.requirement, summary: "发布后继续编辑" } }, edit.version);
      const beforeRender = readFileSync(join(path, ".workspace.json"), "utf8");
      const rendered = await renderContractReview(work, { workspace: "draft", issues: [], output: join(root, "review"), format: "html" }, ws);
      assert.match(readFileSync(rendered.path, "utf8"), /发布后继续编辑/);
      const markdown = await renderContractReview(work, { workspace: "draft", issues: [], output: join(root, "review"), format: "markdown" }, ws);
      assert.equal(markdown.content_digest, rendered.content_digest); assert.match(readFileSync(markdown.path, "utf8"), /发布后继续编辑/);
      assert.equal(readFileSync(join(path, ".workspace.json"), "utf8"), beforeRender);
    }));

const tamperedFields: readonly [string, Partial<RequirementInput>][] = [
  ["non-empty open question", { open_questions: [{ question: "伪造阻塞问题", blocking: true, assumption: "伪造假设" }] }],
  ["non-empty decision", { decisions: [{ statement: "伪造决策", rationale: "伪造理由" }] }],
  ["changed outcome", { outcomes: ["伪造结果"] }],
  ["changed context", { context: "伪造背景" }],
  ["changed summary", { summary: "伪造摘要" }],
];
test("real non-empty Requirement content that differs from the fixed revision is still rejected", async () =>
  jsonWorkspace(async ({ root, work, ws, local, path }) => {
    const snap = local.read();
    assert.equal(snap.draft.requirement.decisions, undefined); assert.equal(snap.draft.requirement.open_questions, undefined);
    await local.save(snap.draft, snap.version);
    await publish(ws, root, local);
    const original = readFileSync(join(path, ".workspace.json"), "utf8");
    assert.equal((await review(work, ws)).sections.find(section => section.kind === "requirement")?.state, "draft");

    for (const [label, fields] of tamperedFields) {
      const manifest = readManifest(path);
      const changed = { ...manifest, requirement: { ...manifest.requirement, base: { ...manifest.requirement.base!, ...fields } } };
      writeFileSync(join(path, ".workspace.json"), JSON.stringify(changed));
      await assert.rejects(review(work, ws), reason(/managed Requirement source conflict/), label);
      writeFileSync(join(path, ".workspace.json"), original);
    }
    const recovered = await review(work, ws);
    assert.equal(recovered.sections.find(section => section.kind === "requirement")?.state, "draft");
    assert.equal((await publish(ws, root, local)).result.no_op, true);
  }));

test("non-empty optional content survives publication and stays reviewable", async () =>
  jsonWorkspace(async ({ root, work, ws, local }) => {
    const snap = local.read();
    const decisions = [{ statement: "保留决策", rationale: "保留理由" }];
    const open_questions = [{ question: "非阻塞问题", blocking: false, assumption: "暂定假设" }];
    await local.save({ ...snap.draft, requirement: { ...snap.draft.requirement, decisions, open_questions } }, snap.version);
    await publish(ws, root, local);
    const collected = await review(work, ws);
    const requirement = collected.sections.find(section => section.kind === "requirement")!;
    assert.deepEqual(requirement.input.decisions, decisions);
    assert.deepEqual(requirement.input.open_questions, open_questions);
  }));

const emptyIssueVariants: readonly [string, (input: IssueInput) => IssueInput][] = [
  ["empty constraints", input => ({ ...input, constraints: [] })],
  ["empty goal guidance", input => ({ ...input, goals: input.goals.map(goal => ({ ...goal, guidance: [] })) })],
  ["empty constraint guidance", input => ({ ...input, constraints: [{ statement: "保留边界", criteria: ["边界成立"], guidance: [] }] })],
  ["combined empty lists", input => ({ ...input, constraints: [], goals: input.goals.map(goal => ({ ...goal, guidance: [] })) })],
];
for (const [label, withOptionals] of emptyIssueVariants)
  test(`published Issue keeps ${label} equivalent to omitted ones for contract review`, async () =>
    jsonWorkspace(async ({ root, work, ws, local, path }) => {
      const snap = local.read();
      const issues = snap.draft.issues.map(issue => ({ ...issue, input: withOptionals(issue.input) }));
      await local.save({ ...snap.draft, issues }, snap.version);
      await publish(ws, root, local);
      assert.deepEqual(readManifest(path).issues[0].base, issues[0].input);
      const beforeReview = readFileSync(join(path, ".workspace.json"), "utf8");
      await review(work, ws);
      assert.equal(readFileSync(join(path, ".workspace.json"), "utf8"), beforeReview);

      const edit = local.read();
      const changed = edit.draft.issues.map(issue => ({ ...issue, input: { ...issue.input, summary: "继续编辑实现契约" } }));
      await local.save({ ...edit.draft, issues: changed }, edit.version);
      const beforeRender = readFileSync(join(path, ".workspace.json"), "utf8");
      const html = await renderContractReview(work, { workspace: "draft", issues: [], output: join(root, "review"), format: "html" }, ws);
      const markdown = await renderContractReview(work, { workspace: "draft", issues: [], output: join(root, "review"), format: "markdown" }, ws);
      assert.equal(html.content_digest, markdown.content_digest);
      assert.match(readFileSync(html.path, "utf8"), /继续编辑实现契约/);
      assert.match(readFileSync(markdown.path, "utf8"), /继续编辑实现契约/);
      assert.equal(readFileSync(join(path, ".workspace.json"), "utf8"), beforeRender);
    }));

test("non-empty Issue constraints and guidance cannot be removed or changed in the managed source", async () =>
  jsonWorkspace(async ({ root, work, ws, local, path }) => {
    const snap = local.read();
    const issues = snap.draft.issues.map(issue => ({ ...issue, input: {
      ...issue.input,
      goals: issue.input.goals.map(goal => ({ ...goal, guidance: ["目标建议"] })),
      constraints: [{ statement: "不可删除的边界", criteria: ["边界成立"], guidance: ["约束建议"] }],
    } }));
    await local.save({ ...snap.draft, issues }, snap.version);
    await publish(ws, root, local);
    const original = readFileSync(join(path, ".workspace.json"), "utf8");
    const collected = await review(work, ws);
    const renderedIssue = collected.sections.find(section => section.kind === "issue")!.input as IssueInput;
    assert.deepEqual(renderedIssue.goals[0].guidance, ["目标建议"]);
    assert.deepEqual(renderedIssue.constraints?.[0].guidance, ["约束建议"]);
    const tamper: readonly ((input: IssueInput) => IssueInput)[] = [
      input => ({ ...input, constraints: [] }),
      input => ({ ...input, goals: input.goals.map(goal => ({ ...goal, guidance: [] })) }),
      input => ({ ...input, constraints: input.constraints!.map(target => ({ ...target, guidance: [] })) }),
      input => ({ ...input, goals: input.goals.map(goal => ({ ...goal, criteria: ["伪造标准"] })) }),
    ];
    for (const change of tamper) {
      const manifest = readManifest(path);
      const changed = { ...manifest, issues: manifest.issues.map(issue => ({ ...issue, base: change(issue.base!) })) };
      writeFileSync(join(path, ".workspace.json"), JSON.stringify(changed));
      await assert.rejects(review(work, ws), reason(/managed source contract conflicts with fixed Issue version/));
      writeFileSync(join(path, ".workspace.json"), original);
    }
    await review(work, ws);
    assert.equal((await publish(ws, root, local)).result.no_op, true);
  }));
