import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { contractHTML } from "../src/contract-review.js";

/**
 * Enforced-CSP browser check for the review page's Mermaid rendering.
 *
 * The page is opened as `file://`, which is how a reader opens the generated
 * snapshot; that also means the enforced CSP and the absence of external loads
 * are exercised under the real conditions.
 *
 * Only Chromium is covered: the contract was narrowed to Chromium-only after a
 * deliberate scoping decision, and shadow-tree marker resolution on other
 * engines is recorded as a known unverified item rather than a gate.
 *
 * Skips when Chromium is unavailable. A skip is an environment gap and must be
 * reported as such, never as a pass.
 */
const runtime = readFileSync(new URL("../vendor/mermaid.min.js", import.meta.url), "utf8");

const normalPlan = "方案：先加列封存。\n\n```mermaid\nflowchart TD\n  A[加列] --> B[拆定义]\n```";
const oversized = `flowchart TD\n${Array.from({ length: 6000 }, (_, i) => `  N${i}-->N${i + 1}`).join("\n")}`;
// The contract names the escapes these fixtures must attempt, so each name
// states exactly what its source writes: classDef/style/linkStyle writing
// `display:none` or `position:fixed`, and a rule broken with `}` that
// constructs a `:host` selector. Every one of them passes the host-side static
// checks and an allowlisted type, so all of them genuinely reach the runtime.
const HOST_ESCAPE = "classDef a fill:red} :host{position:fixed;inset:0;z-index:2147483647;background:#fff;contain:none!important} x{";
/** Enlargement attempt on the host's own box via a `:host` rule. */
const HOST_ENLARGE = "classDef a fill:red} :host{max-height:none!important;max-width:none!important;height:5000px!important;width:5000px!important;contain:none!important;position:fixed;inset:0} x{";
/**
 * Enlargement that genuinely reaches the runtime: a 60-node vertical chart
 * draws a ~6300px-tall SVG. The `:host` fixtures above are refused by Mermaid's
 * lexer and become placeholders, so on their own they would let a missing
 * cap go unnoticed — this one asserts the cap against a host that really grew.
 */
const tallDiagram = `flowchart TD\n${Array.from({ length: 60 }, (_, i) => `  N${i}-->N${i + 1}`).join("\n")}`;
const adversarialCss = [
  { name: "classDef-display-none", source: "flowchart TD\n  N[提示]:::x --> M\n  classDef x fill:red,display:none" },
  { name: "style-position-fixed", source: "flowchart TD\n  N[提示] --> M\n  style N fill:red,position:fixed" },
  { name: "linkStyle-display-none", source: "flowchart TD\n  N[提示] --> M\n  linkStyle 0 display:none" },
  { name: "host-escape", source: `flowchart TD\n  N[提示]:::a --> M\n  ${HOST_ESCAPE}` },
  { name: "host-enlarge-host-rule", source: `flowchart TD\n  N[提示]:::a --> M\n  ${HOST_ENLARGE}` },
  { name: "host-enlarge-tall-chart", source: tallDiagram },
];

/** Every adversarial fixture must either draw with the notice intact, or fail
 * into a placeholder — never render something that hides or resizes the page. */
test("adversarial diagram source cannot hide the page's content", async (t) => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { t.skip("playwright is not installed"); return; }
  let browser;
  try { browser = await chromium.launch(); } catch (error) { t.skip(`Chromium unavailable: ${String(error).split("\n")[0]}`); return; }
  const dir = mkdtempSync(join(tmpdir(), "grounds-plan-adversarial-"));
  try {
    for (const item of adversarialCss) {
      const path = join(dir, `${item.name}.html`);
      writeFileSync(path, pageFor(`\`\`\`mermaid\n${item.source}\n\`\`\``));
      const loaded = await browser.newPage();
      await loaded.goto(pathToFileURL(path).href, { waitUntil: "networkidle" });
      const view = await loaded.evaluate(() => {
        const host = document.querySelector("[data-mermaid-source]");
        const notice = document.querySelector(".plan-notice");
        const headings = [...document.querySelectorAll("h3")];
        const clip = document.querySelector(".plan-diagram-clip");
        const goalsHeading = headings.find((h) => h.textContent === "Goals");
        const constraintsHeading = headings.find((h) => h.textContent === "Constraints");
        return {
          drawn: !!(host?.shadowRoot?.querySelector("svg")),
          notice: notice ? getComputedStyle(notice).display : "MISSING",
          goals: goalsHeading ? getComputedStyle(goalsHeading).display : "MISSING",
          constraints: constraintsHeading ? getComputedStyle(constraintsHeading).display : "MISSING",
          hasConstraintText: document.body.textContent.includes("KEEP"),
          // 80vh is the ceiling the contract sets on the outer container. A
          // fixture that only checks "the page still exists" would pass even if
          // the host had grown to 5000px, so measure it.
          clipHeight: clip ? Math.round(clip.getBoundingClientRect().height) : -1,
          viewportHeight: window.innerHeight,
          clipContain: clip ? getComputedStyle(clip).contain : "MISSING",
        };
      });
      await loaded.close();
      assert.equal(view.notice, "block", `${item.name}: the notice must stay visible`);
      // These headings must EXIST as well as be visible: asserting only
      // `display !== "none"` passes vacuously when the element is missing.
      assert.equal(view.goals, "block", `${item.name}: Goals heading must be present and visible`);
      assert.equal(view.constraints, "block", `${item.name}: Constraints heading must be present and visible`);
      assert.equal(view.hasConstraintText, true, `${item.name}: Constraints content must remain`);
      assert.match(String(view.clipContain), /paint/, `${item.name}: clipping must stay on the host's parent`);
      assert.ok(view.clipHeight > 0 && view.clipHeight <= Math.ceil(view.viewportHeight * 0.8) + 1,
        `${item.name}: the diagram container must stay within 80vh (got ${view.clipHeight}px of ${view.viewportHeight}px)`);
    }
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});// Passes host-side static checks and has an allowlisted type, so it only fails
// inside the runtime — the case the earlier fixture (rejected at generation
// time) never exercised.
const runtimeSyntaxError = "flowchart TD\n  A --> ";

const issueSection = (plan: string) => ({
  key: "issue-1", kind: "issue" as const, state: "draft" as const,
  // Constraints must be part of the rendered markdown, not only of `input`: the
  // visibility assertions below select the heading, and a heading that is
  // absent would make `display !== "none"` pass without testing anything.
  markdown: "---\ntype: issue\n---\n\n# Summary\n\nS\n\n## Context\n\n背景\n\n## Goals\n\n### G\n\n#### Criteria\n\n- C\n\n## Constraints\n\n### KEEP\n\n#### Criteria\n\n- Stays\n",
  input: {
    format: 1, summary: "S", plan,
    goals: [{ statement: "G", criteria: ["C"], traces_to: [{ type: "outcome" as const, ordinal: 1 }] }],
    constraints: [{ statement: "KEEP", criteria: ["Stays"], traces_to: [{ type: "outcome" as const, ordinal: 1 }] }],
  },
});

const pageFor = (plan: string) => contractHTML(
  [issueSection(plan)],
  { mode: "draft" },
  // A hex digest beginning with a digit — the shape that used to break ids.
  "sha256:42556db494827eabae81d11b1c0f09eb156aa944344ca0121fc0b48a1454ffc1",
  "2026-10-14T00:00:00Z",
  runtime,
).html;

test("the review page renders diagrams under an enforced CSP in Chromium", async (t) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    t.skip("playwright is not installed");
    return;
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    t.skip(`Chromium unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "grounds-plan-browser-"));
  // Composition, all opened from disk as a reader would:
  //   2 renderable + 1 mid-list syntax error + 1 after it + 6 adversarial
  //   = 10 diagram hosts.
  // 3 of the adversarial sources fail at runtime (the two that break a rule
  // with `}` and build a `:host` selector, plus the plain syntax-shaped one is
  // not present here) — the other 4 draw, including the 60-node chart. The
  // generation-time rejection and the oversized source never get a host.
  const plan = [
    normalPlan, "",
    "第二张：", "", "```mermaid", "flowchart TD\n  C-->D", "```", "",
    // Mid-list runtime failure: the diagrams after it must still render.
    "中段运行时失败：", "", "```mermaid", runtimeSyntaxError, "```", "",
    "后续图（失败之后仍须渲染）：", "", "```mermaid", "flowchart TD\n  E-->F", "```", "",
    ...adversarialCss.flatMap((item) => [`对抗性（${item.name}）：`, "", "```mermaid", item.source, "```", ""]),
    "生成期拒绝：", "", "```mermaid", "flowchart TD\n  %%{init:{'themeCSS':'.plan-notice{display:none}'}}%%\n  A-->B", "```", "",
    "超限图：", "", "```mermaid", oversized, "```", "",
  ].join("\n");
  const path = join(dir, "page.html");
  writeFileSync(path, pageFor(plan));

  try {
    const context = await browser.newContext();
    const offPage: string[] = [];
    const consoleReports: string[] = [];
    // Any attempt to load something off disk breaks the self-contained snapshot
    // contract; record and abort it.
    await context.route("**/*", (route) => {
      const target = route.request().url();
      if (!target.startsWith("file://")) { offPage.push(target); return route.abort(); }
      return route.continue();
    });

    const loaded = await context.newPage();
    loaded.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) consoleReports.push(message.text()); });
    // The contract is about the securitypolicyviolation event, not console text.
    await loaded.addInitScript(() => {
      (window as unknown as { __violations: string[] }).__violations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });
    await loaded.goto(pathToFileURL(path).href, { waitUntil: "networkidle" });

    // Network idle does not mean asynchronous diagram rendering has finished.
    await loaded.waitForFunction(() => [...document.querySelectorAll("[data-mermaid-source]")]
      .every(host => host.shadowRoot?.querySelector("svg, .plan-diagram-failed")), undefined, { timeout: 15000 });
    const result = await loaded.evaluate(() => {
      const hosts = [...document.querySelectorAll("[data-mermaid-source]")];
      const figures = [...document.querySelectorAll(".plan-figure")];
      const notice = document.querySelector(".plan-notice");
      const goals = [...document.querySelectorAll("h3")].find((h) => h.textContent === "Goals");
      const clip = document.querySelector(".plan-diagram-clip");
      const host = document.querySelector(".plan-diagram-host");
      // Marker references live inside the shadow trees, so they must be read
      // from there — the main document deliberately holds no mermaid markup.
      const markerRefs: string[] = [];
      const resolved: string[] = [];
      for (const h of hosts) {
        const root = h.shadowRoot;
        if (!root) continue;
        for (const el of root.querySelectorAll("[marker-end],[marker-start],[marker-mid]")) {
          for (const attr of ["marker-end", "marker-start", "marker-mid"]) {
            const value = el.getAttribute(attr);
            if (!value) continue;
            markerRefs.push(value);
            const id = value.replace(/^url\(#?/, "").replace(/\)$/, "");
            if (id && (root.getElementById(id) || root.querySelector(`#${CSS.escape(id)}`))) resolved.push(value);
          }
        }
      }
      return {
        violations: (window as unknown as { __violations: string[] }).__violations,
        // Mermaid injects <style> into whatever holds the result; none may reach
        // the main document.
        mainDocStyles: [...document.querySelectorAll("style")].filter((node) => !node.closest("svg") && node.textContent !== null && /#\w+-\d+/.test(node.textContent)).length,
        hosts: hosts.length,
        drawn: hosts.filter((h) => h.shadowRoot && h.shadowRoot.querySelector("svg")).length,
        outcomes: hosts.map(h => ({ id: h.getAttribute("data-mermaid-source"), drawn: !!h.shadowRoot?.querySelector("svg"), error: h.shadowRoot?.querySelector(".plan-diagram-failed p")?.textContent })),
        mainDocSvgs: document.body.querySelectorAll("svg").length,
        noticeDisplay: notice ? getComputedStyle(notice).display : "MISSING",
        goalsDisplay: goals ? getComputedStyle(goals).display : "MISSING",
        constraintsDisplay: (() => { const h = [...document.querySelectorAll("h3")].find((n) => n.textContent === "Constraints"); return h ? getComputedStyle(h).display : "MISSING"; })(),
        constraintsTextVisible: document.body.textContent.includes("KEEP"),
        placeholders: figures.filter((f) => f.querySelector(".plan-diagram-failed")).length,
        // Placeholders produced by the init script live inside the shadow root.
        runtimePlaceholders: hosts.filter((h) => h.shadowRoot && h.shadowRoot.querySelector(".plan-diagram-failed")).length,
        failedFiguresHaveSource: figures.filter((f) => f.querySelector(".plan-diagram-failed")).every((f) => !!f.querySelector("pre")),
        clipContain: clip ? getComputedStyle(clip).contain : "MISSING",
        hostContain: host ? getComputedStyle(host).contain : "MISSING",
        // The enlargement fixture is defeated by the clipping container, so the
        // check has to measure that container, not merely look for the page.
        maxClipHeight: Math.max(0, ...[...document.querySelectorAll(".plan-diagram-clip")].map((node) => Math.round(node.getBoundingClientRect().height))),
        viewportHeight: window.innerHeight,
        markerRefs: markerRefs.length,
        resolvedMarkers: resolved.length,
      };
    });

    assert.deepEqual(result.violations, [], `securitypolicyviolation events: ${result.violations.join(" | ")}`);
    assert.deepEqual(consoleReports, [], `CSP console reports: ${consoleReports.join(" | ")}`);
    assert.deepEqual(offPage, [], `page must load nothing outside file://: ${offPage.join(", ")}`);

    // The renderable diagrams actually draw.
    // 10 hosts = 2 valid + mid-list failure + the diagram after it + 6
    // adversarial; the 2 rule-breaking `:host` attempts fail at runtime.
    assert.equal(result.hosts, 10, `expected 10 hosts, got ${result.hosts}`);
    assert.equal(result.drawn, 7, `all but the runtime-failing diagrams must draw: ${JSON.stringify(result.outcomes)}`);
    // The hosts whose only failure is at runtime must carry a placeholder too,
    // proving the runtime path was genuinely exercised.
    assert.equal(result.runtimePlaceholders, 3, "the mid-list syntax error and the two unparseable :host attempts are all replaced at runtime");
    // Arrow marker references resolve inside their own shadow trees.
    assert.ok(result.markerRefs > 0, "fixture must produce arrow markers");
    assert.equal(result.resolvedMarkers, result.markerRefs, "every marker reference must resolve");

    // Failures become placeholders, each keeping its source.
    // Adversarial and oversized are replaced at generation time. The
    // runtime-syntax-error diagram keeps its host and is replaced by the init
    // script instead, so it is counted separately below.
    assert.equal(result.placeholders, 2, "the generation-time rejection and the oversized source each get a placeholder");
    assert.equal(result.failedFiguresHaveSource, true);

    // Isolation: nothing left in the main document; notice and Goals stay visible.
    assert.equal(result.mainDocSvgs, 0, "no mermaid svg may remain outside the shadow roots");
    assert.equal(result.mainDocStyles, 0, "no mermaid style may remain outside the shadow roots");
    assert.equal(result.noticeDisplay, "block", "the non-normative notice must stay visible");
    // Exact equality, not `!== "none"`: a missing heading reports "MISSING" and
    // would otherwise satisfy a negative assertion vacuously.
    assert.equal(result.goalsDisplay, "block", "Goals heading must be present and visible");
    assert.equal(result.constraintsDisplay, "block", "Constraints heading must be present and visible under adversarial CSS");
    assert.equal(result.constraintsTextVisible, true, "Constraints content must remain in the page");
    // The size ceiling holds even against the fixture that tries to enlarge the
    // host: the container stays within 80vh.
    assert.ok(result.maxClipHeight > 0 && result.maxClipHeight <= Math.ceil(result.viewportHeight * 0.8) + 1,
      `every diagram container must stay within 80vh (tallest ${result.maxClipHeight}px of ${result.viewportHeight}px)`);

    // Clipping sits on the host's parent, never the host itself.
    assert.match(String(result.clipContain), /paint/);
    assert.equal(result.hostContain, "none", "the host must not carry contain; :host rules would override it");
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a diagram's ids do not change when other Issues share the page", async (t) => {
  // The seed binds a section to its own identity plus the diagram's ordinal
  // within that section. A page-global counter would make ids depend on how
  // many other diagrams happen to be present.
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    t.skip("playwright is not installed");
    return;
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    t.skip(`Chromium unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "grounds-plan-seed-"));
  const issue = (key: string, id: string, version: number) => ({
    key, id, version, kind: "issue" as const, state: "published" as const,
    markdown: "---\ntype: issue\n---\n\n# Summary\n\nS\n\n## Context\n\nC\n\n## Goals\n\n### G\n\n#### Criteria\n\n- C\n",
    input: { format: 1, summary: key, plan: normalPlan, goals: [{ statement: "G", criteria: ["C"], traces_to: [{ type: "outcome" as const, ordinal: 1 }] }] },
  });
  const a = issue("issue-1", "01a1388e-bcb8-71ac-92a4-e5423d91fde4", 1);
  const b = issue("issue-2", "01bbbbbbbbbbbbbbbbbbbbbb", 2);
  const alone = join(dir, "alone.html");
  const together = join(dir, "together.html");
  writeFileSync(alone, contractHTML([a], { mode: "published" }, "sha256:abc", "now", runtime).html);
  writeFileSync(together, contractHTML([a, b], { mode: "published" }, "sha256:abc", "now", runtime).html);
  try {
    const ids = async (path: string): Promise<string[]> => {
      const page = await browser!.newPage();
      await page.goto(pathToFileURL(path).href, { waitUntil: "networkidle" });
      const value = await page.evaluate(() => [...document.querySelectorAll("[data-mermaid-source]")]
        .filter((host) => host.getAttribute("data-mermaid-source")!.startsWith("issue-1"))
        .flatMap((host) => [...(host.shadowRoot?.querySelectorAll("[id]") ?? [])].map((node) => node.id)));
      await page.close();
      return value;
    };
    const solo = await ids(alone);
    const duo = await ids(together);
    assert.ok(solo.length > 0, "Issue A must draw at least one element with an id");
    assert.deepEqual(solo, duo, "Issue A's ids must not depend on other Issues on the page");
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
