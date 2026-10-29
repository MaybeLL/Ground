import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonWorkspaceStore, JSON_FORMAT } from "../src/workspace-json.js";
import { startWorkspaceEditor } from "../src/workspace-editor.js";

test(
  "unified page: real browser reading, block state machine, atomic references, failures and responsive layout",
  {
    skip: !process.env.GROUNDS_TEST_PLAYWRIGHT_MODULE,
    timeout: 120000,
  },
  async () => {
    const { chromium } = await import(
      process.env.GROUNDS_TEST_PLAYWRIGHT_MODULE!
    );
    const root = mkdtempSync(join(tmpdir(), "grounds-unified-browser-"));
    const store = new JsonWorkspaceStore(root);
    const long = "很长的中文条文用于检查导航和正文仍然完整。".repeat(30);
    store.writeUnlocked({
      format: JSON_FORMAT,
      name: "draft",
      database_id: "isolated",
      repository_remote: "example/repo",
      revision: 1,
      requirement: {},
      issues: [{ key: "main", file: "issues/main.md" }],
      draft: {
        requirement: {
          format: 1,
          summary: "统一页面测试",
          context:
            "| 项目 | 结果 |\n| --- | --- |\n| 本地 | 可用 |\n\n```js\nconst safe = true;\n```",
          outcomes: ["Outcome A " + long, "Outcome B"],
          decisions: [{ statement: "Decision", rationale: "理由" }],
        },
        issues: [
          {
            key: "main",
            baselineExpression: "HEAD",
            questions: [],
            assumptions: [],
            input: {
              format: 1,
              summary: "Issue",
              plan: "```mermaid\nflowchart TD\nA[阅读] --> B[编辑]\n```",
              goals: [
                {
                  statement: "Goal",
                  criteria: [long],
                  traces_to: [{ type: "outcome", ordinal: 1 }],
                },
              ],
              constraints: [{ statement: "约束", criteria: ["不自动发布"] }],
            },
          },
        ],
      },
    });
    let server = await startWorkspaceEditor(root);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("dialog", (dialog: any) => dialog.accept());
    const block = (path: (string | number)[]) =>
      page.locator(
        "[data-edit-path=" + JSON.stringify(JSON.stringify(path)) + "]",
      );
    const edit = async (path: (string | number)[]) => {
      await block(path).locator(":scope > button.edit-block").click();
    };
    const saved = () =>
      page
        .locator("#status")
        .filter({ hasText: /已保存到本地|已重新读取并确认保存成功/ })
        .waitFor();
    try {
      await page.goto(server.url);
      await page
        .locator("#status")
        .filter({ hasText: "已读取本地草稿" })
        .waitFor();
      assert.equal(await page.locator("textarea").count(), 0);
      assert.ok((await page.locator("#reading").innerText()).includes(long));
      assert.equal(await page.locator("#reading table").count(), 1);
      await page.waitForFunction(
        () =>
          !!document
            .querySelector("[data-mermaid-source]")
            ?.shadowRoot?.querySelector("svg"),
      );
      // Directory and Intent Link fragments must never replace the session credential.
      const credential = await page.evaluate(() =>
        sessionStorage.getItem("grounds-session"),
      );
      const unchanged = store.read().version;
      for (const selector of [
        "#navigation a[href^='#']",
        "#reading a[href^='#']",
      ]) {
        const link = page.locator(selector).first();
        const fragment = await link.getAttribute("href");
        await link.click();
        await page.reload();
        await page
          .locator("#status")
          .filter({ hasText: "已读取本地草稿" })
          .waitFor();
        assert.equal(new URL(page.url()).hash, fragment);
        assert.equal(
          await page.evaluate(() => sessionStorage.getItem("grounds-session")),
          credential,
        );
        assert.equal(store.read().version, unchanged);
      }
      // A delayed reload must not accept edits that its returning snapshot would erase.
      let releaseRead!: () => void;
      let readStarted!: () => void;
      const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
      const readingStarted = new Promise<void>(
        (resolve) => (readStarted = resolve),
      );
      await page.route(
        "**/api/draft",
        async (route: any) => {
          const response = await route.fetch();
          readStarted();
          await readGate;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      await page.locator("#reload").click();
      await readingStarted;
      assert.equal(await page.locator("#reload").isDisabled(), true);
      assert.equal(await page.locator("#save").isDisabled(), true);
      assert.equal(await page.locator("#validate").isDisabled(), true);
      assert.equal(
        await page.locator("button.edit-block:not(:disabled)").count(),
        0,
      );
      await block(["requirement", "summary"])
        .locator(":scope > button.edit-block")
        .evaluate((button: HTMLButtonElement) => button.click());
      assert.equal(await page.locator("textarea").count(), 0);
      assert.equal(store.read().version, unchanged);
      releaseRead();
      await page
        .locator("#status")
        .filter({ hasText: "已读取本地草稿" })
        .waitFor();
      await edit(["requirement", "summary"]);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill("读取完成后的输入");
      assert.equal(
        await block(["requirement", "summary"])
          .locator("textarea")
          .inputValue(),
        "读取完成后的输入",
      );
      await page.locator("#cancel").click();
      // A failed read must also release the controls without mutating persisted content.
      await page.route("**/api/draft", (route: any) => route.abort("failed"), {
        times: 1,
      });
      await page.locator("#reload").click();
      await page.locator("#status").filter({ hasText: "读取失败" }).waitFor();
      assert.equal(await page.locator("#reload").isEnabled(), true);
      await edit(["requirement", "summary"]);
      assert.equal(
        await block(["requirement", "summary"])
          .locator("textarea")
          .inputValue(),
        store.read().draft.requirement.summary,
      );
      await page.locator("#cancel").click();
      assert.equal(store.read().version, unchanged);
      // Structural edits are staged without opening unrelated Issue fields.
      await edit(["issues"]);
      assert.equal(await block(["issues"]).locator("textarea").count(), 0);
      await block(["issues"])
        .getByRole("button", { name: "添加", exact: true })
        .click();
      assert.equal(store.read().draft.issues.length, 1);
      await page.locator("#cancel").click();
      await edit(["issues"]);
      await block(["issues"])
        .getByRole("button", { name: "添加", exact: true })
        .click();
      await page.locator("#save").click();
      await saved();
      assert.equal(store.read().draft.issues.length, 2);
      await edit(["issues"]);
      await block(["issues"])
        .getByRole("button", { name: "删除", exact: true })
        .last()
        .click();
      await page.locator("#save").click();
      await saved();
      assert.equal(store.read().draft.issues.length, 1);
      const original = store.read().version;
      await edit(["requirement", "summary"]);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill("取消的内容");
      await page.locator("#cancel").click();
      assert.equal(store.read().version, original);
      assert.equal(await page.locator("textarea").count(), 0);
      await edit(["requirement", "summary"]);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill("已保存的标题");
      await page.locator("#save").click();
      await saved();
      assert.equal(store.read().draft.requirement.summary, "已保存的标题");
      assert.equal(await page.locator("textarea").count(), 0);
      await page.reload();
      await page
        .locator("#status")
        .filter({ hasText: "已读取本地草稿" })
        .waitFor();
      await edit(["requirement", "summary"]);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill("切换前未保存");
      await edit(["requirement", "context"]);
      await page.locator("#switch-stay").click();
      assert.equal(
        await block(["requirement", "summary"])
          .locator("textarea")
          .inputValue(),
        "切换前未保存",
      );
      await edit(["requirement", "context"]);
      await page.locator("#switch-discard").click();
      assert.equal(store.read().draft.requirement.summary, "已保存的标题");
      await page.locator("#cancel").click();
      await edit(["requirement", "outcomes"]);
      await block(["requirement", "outcomes"])
        .getByRole("button", { name: "下移", exact: true })
        .first()
        .click();
      assert.equal(
        store.read().draft.issues[0].input.goals[0].traces_to![0].ordinal,
        1,
      );
      await page.locator("#save").click();
      await saved();
      assert.equal(
        store.read().draft.issues[0].input.goals[0].traces_to![0].ordinal,
        2,
      );
      // A later unrelated target edit must use the complete new snapshot, including reference renumbering.
      await edit(["issues", 0, "input", "goals", 0]);
      await block(["issues", 0, "input", "goals", 0])
        .getByLabel("说明", { exact: true })
        .fill("Goal updated");
      await page.locator("#save").click();
      await saved();
      assert.equal(
        store.read().draft.issues[0].input.goals[0].traces_to![0].ordinal,
        2,
      );
      await edit(["requirement", "summary"]);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill("我的待保存输入");
      const beforeAgent = store.read(),
        agent = structuredClone(beforeAgent.draft);
      agent.requirement.summary = "Agent的新内容";
      await store.save(agent, beforeAgent.version);
      await page.locator("#save").click();
      await page.locator("#status").filter({ hasText: "保存冲突" }).waitFor();
      assert.equal(
        await block(["requirement", "summary"])
          .locator("textarea")
          .inputValue(),
        "我的待保存输入",
      );
      assert.equal(store.read().draft.requirement.summary, "Agent的新内容");
      await page.locator("#reload").click();
      await page.locator("#switch-discard").click();
      await page
        .locator("#status")
        .filter({ hasText: "已读取本地草稿" })
        .waitFor();
      // Explicit rejection preserves the editor and disk.
      await edit(["requirement", "summary"]);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill("失败保留");
      await page.route(
        "**/api/save",
        async (route: any) =>
          route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({
              error: "校验拒绝",
              commit_state: "not_committed",
            }),
          }),
        { times: 1 },
      );
      await page.locator("#save").click();
      await page
        .locator("#status")
        .filter({ hasText: "保存失败（未提交）" })
        .waitFor();
      assert.equal(store.read().draft.requirement.summary, "Agent的新内容");
      assert.equal(
        await block(["requirement", "summary"])
          .locator("textarea")
          .inputValue(),
        "失败保留",
      );
      // The HTTP request commits, but its response never arrives. One read reconciles without a second POST.
      await page.route(
        "**/api/save",
        async (route: any) => {
          const committed = await route.fetch();
          assert.equal(committed.status(), 200, await committed.text());
          await route.abort("failed");
        },
        { times: 1 },
      );
      await page.locator("#save").click();
      await page
        .locator("#status")
        .filter({ hasText: "已重新读取并确认保存成功" })
        .waitFor();
      assert.equal(store.read().draft.requirement.summary, "失败保留");
      assert.equal(await page.locator("textarea").count(), 0);
      // Input is disabled during an in-flight save; no later input can be discarded.
      await edit(["requirement", "summary"]);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill("等待保存");
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((r) => (release = r)),
        fetched = new Promise<void>((r) => (reached = r));
      await page.route(
        "**/api/save",
        async (route: any) => {
          const response = await route.fetch();
          reached();
          await gate;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      await page.locator("#save").click();
      await fetched;
      assert.equal(
        await block(["requirement", "summary"])
          .locator("textarea")
          .isDisabled(),
        true,
      );
      release();
      await saved();
      // A second page has its own snapshot, but shares the exact same CAS.
      const tab = await browser.newPage();
      await tab.goto(server.url);
      await tab
        .locator("#status")
        .filter({ hasText: "已读取本地草稿" })
        .waitFor();
      await edit(["requirement", "summary"]);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill(
          '<img src=x onerror="window.stolen=true"><script>window.stolen=true</script>',
        );
      await page.locator("#save").click();
      await saved();
      await tab
        .locator(
          "[data-edit-path=" +
            JSON.stringify(JSON.stringify(["requirement", "summary"])) +
            "] > button.edit-block",
        )
        .click();
      await tab.locator("textarea").fill("过期标签");
      await tab.locator("#save").click();
      await tab.locator("#status").filter({ hasText: "保存冲突" }).waitFor();
      await tab.close();
      assert.equal(
        await page.evaluate(() => (window as any).stolen),
        undefined,
      );
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
        );
        if (process.env.GROUNDS_BROWSER_EVIDENCE) {
          mkdirSync(process.env.GROUNDS_BROWSER_EVIDENCE, { recursive: true });
          await page.screenshot({
            path: join(
              process.env.GROUNDS_BROWSER_EVIDENCE,
              `unified-${width}.png`,
            ),
          });
        }
      }
      // Keyboard controls, navigation full-title expansion and exact references remain available.
      await page.locator("#navigation summary").first().focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      assert.ok(await page.locator('#reading a[href*="outcome"]').count());
      // Rebase conflicts are a storage gate, including when introduced after page load.
      await edit(["requirement", "summary"]);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill("冲突中保留的输入");
      const beforeConflict = store.read();
      store.writeUnlocked(
        {
          ...beforeConflict.manifest,
          conflicts: [
            {
              path: "requirement.summary",
              base: "base",
              local: "local",
              remote: "remote",
            },
          ],
        },
        beforeConflict.version,
      );
      const conflicted = store.read();
      await page.locator("#save").click();
      await page.locator("#status").filter({ hasText: "保存冲突" }).waitFor();
      assert.equal(
        await block(["requirement", "summary"])
          .locator("textarea")
          .inputValue(),
        "冲突中保留的输入",
      );
      assert.equal(store.read().version, conflicted.version);
      await page.locator("#cancel").click();
      await page.locator("#reload").click();
      await page.locator("#info").filter({ hasText: "保存已禁用" }).waitFor();
      await edit(["requirement", "summary"]);
      assert.equal(await page.locator("#save").isDisabled(), true);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill("不能绕过冲突");
      assert.equal(store.read().version, conflicted.version);
      await store.resolve(conflicted.draft, conflicted.version);
      await page.locator("#cancel").click();
      await page.locator("#reload").click();
      await page
        .locator("#status")
        .filter({ hasText: "已读取本地草稿" })
        .waitFor();
      await edit(["requirement", "summary"]);
      assert.equal(await page.locator("#save").isEnabled(), true);
      await block(["requirement", "summary"])
        .locator("textarea")
        .fill("停止后输入");
      await server.close();
      await page.locator("#save").click();
      await page
        .locator("#status")
        .filter({ hasText: "保存结果未知" })
        .waitFor();
      assert.equal(
        await block(["requirement", "summary"])
          .locator("textarea")
          .inputValue(),
        "停止后输入",
      );
      const oldUrl = server.url;
      server = await startWorkspaceEditor(root);
      assert.notEqual(server.url, oldUrl);
      assert.notEqual(store.read().draft.requirement.summary, "停止后输入");
      if (process.env.GROUNDS_BROWSER_EVIDENCE) {
        mkdirSync(process.env.GROUNDS_BROWSER_EVIDENCE, { recursive: true });
        writeFileSync(
          join(process.env.GROUNDS_BROWSER_EVIDENCE, "unified-browser.json"),
          JSON.stringify(
            {
              errors,
              version: store.read().version,
              checked: [
                "reading",
                "cancel",
                "switch",
                "save",
                "reload",
                "atomic-links",
                "agent-conflict",
                "two-tabs",
                "failure",
                "lost-response",
                "busy-input",
                "service-stop-restart",
                "xss",
                "1280/390/320",
                "keyboard",
                "mermaid",
              ],
            },
            null,
            2,
          ),
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
