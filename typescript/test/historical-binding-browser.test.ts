import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Module } from "../src/module.js";
import { SQLStore } from "../src/sql-store.js";
import { WorkspaceModule } from "../src/workspace.js";
import { JsonWorkspaceStore } from "../src/workspace-json.js";
import { startWorkspaceEditor } from "../src/workspace-editor.js";
import { testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { PreflightService } from "../src/preflight.js";

// Author-side regression using only disposable SQLite/Git/JSON workspaces.
async function fixture(run: (context: any) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-historical-browser-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const db = SQLStore.sqlite(join(root, "ledger.sqlite"));
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    writeFileSync(join(root, "readme"), "isolated fixture");
    git("add", "readme");
    git("commit", "-qm", "fixture");
    git("remote", "add", "origin", "ssh://git@example.test/team/test");
    const remote = join(root, "remote.git");
    git("init", "--bare", "-q", remote);
    git("push", "-q", remote, "HEAD:refs/heads/main");
    git("config", `url.file://${remote}.insteadOf`, "ssh://git@example.test/team/test");
    git("fetch", "origin");
    const meta = await db.initialize("warn");
    const preflight = new PreflightService(db, root);
    const work = new Module(db, newUUIDv7, undefined, undefined, preflight.coordinator({ refresh: true }));
    const ws = new WorkspaceModule(
      work,
      root,
      "warn",
      () => testAgent,
      meta.metadata.database_id,
      newUUIDv7,
      true,
    );
    const created = (await ws.new("draft")) as { path: string };
    const store = new JsonWorkspaceStore(created.path);
    const snap = store.read();
    snap.draft.requirement = {
      format: 1,
      summary: "固定来源需求",
      outcomes: ["来源结果 A", "来源结果 B", "来源结果 C"],
      decisions: [
        { statement: "来源决策 A" },
        { statement: "来源决策 B" },
        { statement: "来源决策 C" },
      ],
    };
    snap.draft.issues[0].input = {
      format: 1,
      summary: "已发布工作项",
      target_branch: { remote: "origin", ref: "refs/heads/main" },
      goals: [
        {
          statement: "来源目标",
          criteria: ["来源验收"],
          traces_to: [
            { type: "outcome", ordinal: 2 },
            { type: "decision", ordinal: 2 },
          ],
        },
      ],
    };
    await store.save(snap.draft, snap.version);
    const publish = async () => {
      const version = store.read().version;
      const binding = await ws.pendingPublishBinding("draft", root, version);
      if (binding) {
        const observation = await preflight.observe({ operation_id: newUUIDv7(), attribution: testAgent,
          phase: "publish", refresh: true, canonical_remote: binding.canonical_remote,
          target: binding.target, scope_digest: version, content_digest: binding.content_digest });
        assert.equal((observation.data.observation as {refreshed: boolean}).refreshed, true);
        await preflight.assess({ operation_id: newUUIDv7(), attribution: testAgent, observation_id: observation.id,
          file: { assessment: "applicable", rationale: "Reviewed the historical binding fixture against its fixed, refreshed target", affected: [] } });
      }
      return ws.publish(
        "draft",
        root,
        false,
        false,
        false,
        "",
        undefined,
        version,
      );
    };
    await publish();
    await run({ store, path: created.path, publish });
  } finally {
    await db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
async function inBrowser(path: string, run: (page: any) => Promise<void>) {
  const server = await startWorkspaceEditor(path);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    await page
      .locator("#status")
      .filter({ hasText: "已读取本地草稿" })
      .waitFor();
    await run(page);
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
  }
}
function controls(page: any) {
  const block = (path: (string | number)[]) =>
    page.locator(
      "[data-edit-path=" + JSON.stringify(JSON.stringify(path)) + "]",
    );
  const edit = (path: (string | number)[]) =>
    block(path).locator(":scope > button.edit-block").click();
  const save = async () => {
    await page.locator("#save").click();
    await page
      .locator("#status")
      .filter({ hasText: /已保存到本地|已重新读取并确认保存成功/ })
      .waitFor();
  };
  return { block, edit, save };
}

test("a genuinely older Requirement binding with no local fixed source fails explicitly before starting or changing JSON", () =>
  fixture(async ({ store, path, publish }) => {
    let snap = store.read();
    const originalBinding = snap.manifest.issues[0].requirement_revision_id;
    snap.draft.requirement.outcomes = ["当前版本 A", "当前版本 B"];
    await store.save(snap.draft, snap.version);
    await publish();
    snap = store.read();
    assert.equal(snap.manifest.requirement.version, 2);
    assert.equal(
      snap.manifest.issues[0].requirement_revision_id,
      originalBinding,
    );
    assert.notEqual(snap.manifest.requirement.revision_id, originalBinding);
    snap.draft.requirement.context = "还有未发布的变化";
    await store.save(snap.draft, snap.version);
    const before = store.read();
    await assert.rejects(
      startWorkspaceEditor(path),
      (error: any) =>
        error.code === "VALIDATION_ERROR" &&
        /required fixed Requirement source missing/.test(error.details?.reason),
    );
    assert.deepEqual(store.read(), before);
  }));

test(
  "same-base fixed reading transitions to draft only after saved joint changes; reorder/delete links and cancel are atomic",
  { timeout: 90000 },
  () =>
    fixture(async ({ store, path }) => {
      let snap = store.read();
      const requirementID = snap.manifest.requirement.id;
      const originalBinding = snap.manifest.issues[0].requirement_revision_id;
      snap.draft.requirement.context = "未发布的当前需求变化";
      snap.draft.requirement.outcomes = [
        "草稿结果 A",
        "草稿结果 B",
        "草稿结果 C",
      ];
      snap.draft.requirement.decisions = [
        { statement: "草稿决策 A" },
        { statement: "草稿决策 B" },
        { statement: "草稿决策 C" },
      ];
      snap.draft.issues.push({
        key: "current",
        baselineExpression: "HEAD",
        questions: [],
        assumptions: [],
        input: {
          format: 1,
          summary: "当前工作项",
          goals: [
            {
              statement: "当前目标",
              criteria: ["验收"],
              traces_to: [
                { type: "outcome", ordinal: 2 },
                { type: "decision", ordinal: 2 },
              ],
            },
          ],
        },
      });
      await store.save(snap.draft, snap.version);
      await inBrowser(path, async (page) => {
        const { block, edit, save } = controls(page);
        const dialogs: string[] = [];
        page.on("dialog", async (dialog: any) => {
          dialogs.push(dialog.message());
          await dialog.accept();
        });
        const fixed = `requirement-${requirementID}-v1`;
        assert.equal(
          await page
            .locator(`#issue-1-goals a[href="#${fixed}-outcome-2"]`)
            .count(),
          1,
        );
        assert.equal(
          await page.locator(`#${fixed}-outcome-2`).innerText(),
          "来源结果 B",
        );
        for (const [field, type] of [
          ["outcomes", "outcome"],
          ["decisions", "decision"],
        ] as const) {
          const before = store.read();
          await edit(["requirement", field]);
          await block(["requirement", field])
            .getByRole("button", { name: "下移", exact: true })
            .first()
            .click();
          assert.equal(store.read().version, before.version);
          await page.locator("#cancel").click();
          assert.deepEqual(store.read(), before);
          await edit(["requirement", field]);
          await block(["requirement", field])
            .getByRole("button", { name: "下移", exact: true })
            .first()
            .click();
          await save();
          for (const issue of store.read().draft.issues)
            assert.equal(
              issue.input.goals[0].traces_to!.find((x: any) => x.type === type)!
                .ordinal,
              1,
            );
          // The same-base Issue is now jointly changed with Requirement, so existing
          // publication semantics explain it against the draft, without publishing.
          assert.equal(
            await page
              .locator(`#issue-1-goals a[href="#requirement-draft-${type}-1"]`)
              .count(),
            1,
          );
          assert.equal(
            store.read().manifest.issues[0].requirement_revision_id,
            originalBinding,
          );
          const baseline = store.read();
          await edit(["requirement", field]);
          await block(["requirement", field])
            .getByRole("button", { name: "删除", exact: true })
            .first()
            .click();
          assert.match(dialogs.at(-1)!, /引用/);
          assert.equal(store.read().version, baseline.version);
          await page.locator("#cancel").click();
          // Delete the unreferenced middle entry, stage/cancel once, then save.
          await edit(["requirement", field]);
          await block(["requirement", field])
            .getByRole("button", { name: "删除", exact: true })
            .nth(1)
            .click();
          assert.equal(store.read().version, baseline.version);
          await page.locator("#cancel").click();
          assert.deepEqual(store.read(), baseline);
          await edit(["requirement", field]);
          await block(["requirement", field])
            .getByRole("button", { name: "删除", exact: true })
            .nth(1)
            .click();
          await save();
          assert.equal(store.read().draft.requirement[field].length, 2);
          for (const issue of store.read().draft.issues)
            assert.equal(
              issue.input.goals[0].traces_to!.find((x: any) => x.type === type)!
                .ordinal,
              1,
            );
        }
        const target = ["issues", 0, "input", "goals", 0];
        await edit(target);
        const choices = await block(target)
          .locator("select")
          .first()
          .locator("option")
          .allTextContents();
        assert.ok(choices.some((text: string) => text.includes("草稿结果 B")));
        assert.ok(choices.every((text: string) => !text.includes("来源结果")));
        const before = store.read();
        await block(target).locator("select").first().selectOption("outcome:2");
        await page.locator("#cancel").click();
        assert.deepEqual(store.read(), before);
        await edit(target);
        await block(target).locator("select").first().selectOption("outcome:2");
        await save();
        assert.equal(
          store.read().draft.issues[0].input.goals[0].traces_to[0].ordinal,
          2,
        );
        assert.equal(
          await page
            .locator('#issue-1-goals a[href="#requirement-draft-outcome-2"]')
            .count(),
          1,
        );
      });
    }),
);

test(
  "available fixed base with unchanged Requirement supplies matching association choices and preserves binding after save",
  { timeout: 60000 },
  () =>
    fixture(async ({ store, path }) => {
      const initial = store.read();
      const fixed = `requirement-${initial.manifest.requirement.id}-v1`;
      await inBrowser(path, async (page) => {
        page.on("dialog", (dialog: any) => dialog.accept());
        const { block, edit, save } = controls(page);
        const target = ["issues", 0, "input", "goals", 0];
        assert.equal(
          await page
            .locator(`#issue-1-goals a[href="#${fixed}-outcome-2"]`)
            .count(),
          1,
        );
        await edit(target);
        const choices = await block(target)
          .locator("select")
          .first()
          .locator("option")
          .allTextContents();
        assert.ok(choices.some((text: string) => text.includes("来源结果 A")));
        assert.ok(choices.some((text: string) => text.includes("来源决策 B")));
        await block(target).locator("select").first().selectOption("outcome:1");
        assert.equal(store.read().version, initial.version);
        await page.locator("#cancel").click();
        assert.deepEqual(store.read(), initial);
        await edit(target);
        await block(target).locator("select").first().selectOption("outcome:1");
        await save();
        assert.equal(
          store.read().manifest.issues[0].requirement_revision_id,
          initial.manifest.issues[0].requirement_revision_id,
        );
        assert.equal(
          await page
            .locator(`#issue-1-goals a[href="#${fixed}-outcome-1"]`)
            .count(),
          1,
        );
        assert.equal(
          await page.locator(`#${fixed}-outcome-1`).innerText(),
          "来源结果 A",
        );
      });
    }),
);
