import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { contractHTML, pinnedRuntimeSource } from "../src/contract-review.js";
import type { ContractSection } from "../src/contract-page.js";

test("shared reading in Chromium: responsive widths, keyboard navigation, exact links, local diagram and immutable export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grounds-reading-browser-"));
  const browser = await chromium.launch();
  const screenshotDir = process.env.GROUNDS_READING_SCREENSHOTS;
  if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
  try {
    const long =
      "用户在同一个页面阅读契约并编辑独立内容块，保存成功后回到阅读模式，保持当前位置与清晰的层级。".repeat(
        5,
      );
    const sections: ContractSection[] = [
      {
        key: "requirement-fixed-v1",
        kind: "requirement",
        state: "published",
        version: 1,
        markdown: "",
        input: {
          format: 1,
          summary: "统一契约阅读与编辑",
          context:
            "保留完整正文，提供精简的阅读目录。\n\n| 字段 | 值 |\n| --- | --- |\n| 长值 | " +
            "long-value-".repeat(40) +
            " |\n\n```text\n" +
            "long-code-".repeat(40) +
            "\n```",
          outcomes: [long],
          decisions: [
            { statement: "采用轻量本地服务", rationale: "复用已有运行时" },
          ],
        },
      },
      {
        key: "issue-1",
        kind: "issue",
        state: "published",
        version: 1,
        binding: "requirement-fixed-v1",
        markdown: "",
        input: {
          format: 1,
          summary: "统一 HTML 交互",
          context: "每次保存写入 JSON，并重新读取完整快照。",
          plan: "```mermaid\nflowchart LR\n Read-->Edit\n Edit-->Save\n Save-->Read\n```",
          goals: [
            {
              statement: "区块编辑",
              criteria: ["保存后返回阅读并保留完整正文"],
              traces_to: [{ type: "outcome", ordinal: 1 }],
            },
          ],
          constraints: [
            { statement: "历史快照只读", criteria: ["不能修改已发布版本"] },
          ],
        },
      },
    ];
    const file = join(dir, "reading.html");
    writeFileSync(
      file,
      contractHTML(
        sections,
        { mode: "published" },
        "sha256:fixture",
        "fixture",
        pinnedRuntimeSource(),
      ).html,
    );
    for (const width of [1280, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const external: string[] = [];
      page.on("request", (request) => {
        if (/^https?:/.test(request.url())) external.push(request.url());
      });
      await page.goto(pathToFileURL(file).href);
      await page.waitForFunction(
        () =>
          !!document
            .querySelector("[data-mermaid-source]")
            ?.shadowRoot?.querySelector("svg"),
      );
      const clip = await page
        .locator(".plan-diagram-clip")
        .evaluate((element) => ({
          contain: getComputedStyle(element).contain,
          overflow: getComputedStyle(element).overflow,
          height: element.getBoundingClientRect().height,
        }));
      assert.equal(clip.contain, "paint");
      assert.equal(clip.overflow, "hidden");
      assert.ok(clip.height <= 900 * 0.8 + 1);
      assert.equal(
        await page
          .locator("button,input,textarea,[contenteditable],[data-edit-path]")
          .count(),
        0,
      );
      const collection = page
        .locator(".reading-nav-collection")
        .filter({ has: page.locator("summary", { hasText: /^Outcomes$/ }) });
      await collection.locator(":scope > summary").focus();
      await page.keyboard.press("Enter");
      assert.equal(await collection.getAttribute("open"), "");
      const entry = collection.locator(".reading-nav-entry").first();
      const label = entry.locator("summary .nav-label");
      const size = await label.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(element).lineHeight),
      }));
      assert.ok(
        size.height <= size.line * 2 + 1,
        `${width}: label is at most two lines`,
      );
      await entry.locator(":scope > summary").click();
      assert.equal(await entry.locator(":scope > p").textContent(), long);
      assert.equal(await entry.locator(":scope > p").isVisible(), true);
      await page
        .locator('#issue-1-goals a[href="#requirement-fixed-v1-outcome-1"]')
        .click();
      assert.match(page.url(), /#requirement-fixed-v1-outcome-1$/);
      const target = page.locator("#requirement-fixed-v1-outcome-1");
      assert.equal(await target.textContent(), long + "\n");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${width}: no horizontal page overflow`,
      );
      assert.deepEqual(external, []);
      await page.evaluate(() => scrollTo(0, 0));
      if (screenshotDir)
        await page.screenshot({
          path: join(screenshotDir, `reading-${width}.png`),
          fullPage: true,
        });
      await page.close();
    }
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
