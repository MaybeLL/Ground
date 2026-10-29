import assert from "node:assert/strict";
import test from "node:test";
import { contractHTML } from "../src/contract-review.js";
import {
  CSP_WITHOUT_DIAGRAMS,
  PLAN_NOTICE_TEXT,
  cspWithDiagrams,
  inlineRuntimeScript,
  renderPlanSection,
  scanFences,
  staticRejection,
} from "../src/plan-render.js";

const PLAN = "先说明整体思路，再给一张图。\n\n```mermaid\nflowchart TD\n  A[加列] --> B[拆定义]\n```\n\n最后是取舍说明。";
// The third argument is the owning section's stable seed, not a page budget.
const seed = () => "gissue-1v1";

test("the plan section emits the non-normative notice before any author text", () => {
  const out = renderPlanSection(PLAN, "issue-1", seed());
  const noticeAt = out.html.indexOf(PLAN_NOTICE_TEXT);
  const authorAt = out.html.indexOf("先说明整体思路");
  assert.ok(noticeAt >= 0, "notice missing");
  assert.ok(authorAt > noticeAt, "notice must precede author content");
  assert.equal(out.diagrams, 1);
});

test("a mermaid fence becomes a diagram host, a non-mermaid fence stays source", () => {
  const out = renderPlanSection("```mermaid\nflowchart TD\nA-->B\n```\n\n```js\nconst a=1;\n```", "issue-1", seed());
  assert.match(out.html, /data-mermaid-source="issue-1-diagram-1"/);
  assert.match(out.html, /<pre id="issue-1-diagram-1-src"/);
  // The non-mermaid fence is rendered as plain source, not a diagram.
  assert.match(out.html, /const a=1;/);
  assert.equal(out.diagrams, 1);
});

test("the clip sits on the shadow host's PARENT, never on the host itself", () => {
  const out = renderPlanSection(PLAN, "issue-1", seed());
  const clip = out.html.indexOf("plan-diagram-clip");
  const host = out.html.indexOf("plan-diagram-host");
  assert.ok(clip >= 0 && host > clip, "clip must precede the host");
  // The host must not carry contain: it would be overridable by :host rules.
  const hostTag = out.html.slice(out.html.lastIndexOf("<div", host), out.html.indexOf(">", host) + 1);
  assert.equal(/contain\s*:/.test(hostTag), false);
});

test("hostile source is rejected into a placeholder rather than rendered", () => {
  for (const source of [
    'flowchart TD\n  A["<script>alert(1)</script>"]',
    "flowchart TD\n  click A href \"javascript:alert(1)\"",
    "%%{init:{'themeCSS':'*{display:none}'}}%%\nflowchart TD\n  A-->B",
    "flowchart TD\n  A-->B\n  %% <iframe src=x>",
  ]) {
    const out = renderPlanSection(`\`\`\`mermaid\n${source}\n\`\`\``, "issue-1", seed());
    assert.equal(out.diagrams, 0, `should not render: ${source}`);
    assert.match(out.html, /图渲染失败/);
  }
});

test("only allowlisted diagram types render; others become placeholders", () => {
  const out = renderPlanSection("```mermaid\nmindmap\n  root\n```", "issue-1", seed());
  assert.equal(out.diagrams, 0);
  assert.match(out.html, /不在允许列表内/);
});

test("the diagram cap holds and raises a warning", () => {
  const many = Array.from({ length: 12 }, (_, i) => `\`\`\`mermaid\nflowchart TD\n  A${i}-->B${i}\n\`\`\``).join("\n\n");
  const out = renderPlanSection(many, "issue-1", seed());
  assert.equal(out.diagrams, 10);
  assert.equal(out.withheld, 2);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0].message, /上限/);
});

test("static rejection names its reason and leaves benign source alone", () => {
  assert.equal(staticRejection("flowchart TD\n  A-->B"), undefined);
  assert.match(String(staticRejection("flowchart TD\n  click A href \"javascript:x\"")), /javascript/);
  assert.match(String(staticRejection("---\nconfig:\n  theme: dark\n---\nflowchart TD\n A-->B")), /frontmatter/);
});

test("fence scanning honours backticks, tildes and info strings", () => {
  const blocks = scanFences("text\n\n~~~mermaid\ngraph TD\n~~~\n\nmore");
  const fences = blocks.filter((b) => b.kind === "fence");
  assert.equal(fences.length, 1);
  assert.equal((fences[0] as { block: { info: string } }).block.info, "mermaid");
});

test("the inline runtime is one script element whose CSP hash covers its exact text", () => {
  const { script, cspHash } = inlineRuntimeScript("var mermaid={};", "seed123");
  assert.equal(script.startsWith("<script>"), true);
  assert.equal(script.endsWith("</script>"), true);
  // Exactly one script element, so one hash suffices.
  assert.equal(script.split("<script>").length - 1, 1);
  assert.equal(/<\/script/i.test(script.slice(8, -9)), false);
  assert.match(cspWithDiagrams(cspHash), new RegExp(`script-src '${cspHash.replace(/[+/=]/g, (c) => "\\" + c)}'`));
  assert.equal(cspWithDiagrams(cspHash).includes("unsafe-eval"), false);
  assert.equal(CSP_WITHOUT_DIAGRAMS.includes("script-src"), false);
});

test("a page without diagrams carries no runtime and keeps the no-script CSP", () => {
  // "Without diagrams" is decided after static rejection and the cap, not by
  // whether a plan exists: prose-only plan still renders its notice.
  const sections = [issueSection("S", "只有文字，没有任何图。")];
  const { html } = contractHTML(sections, { mode: "draft" }, "sha256:abc", "now", "var mermaid={};");
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes(CSP_WITHOUT_DIAGRAMS), true);
  assert.equal(html.includes(PLAN_NOTICE_TEXT), true);
});

test("a page with no plan at all renders neither notice nor runtime", () => {
  const sections = [issueSection("S", undefined)];
  const { html } = contractHTML(sections, { mode: "draft" }, "sha256:abc", "now", "var mermaid={};");
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes(PLAN_NOTICE_TEXT), false);
  assert.equal(html.includes("plan-section"), false);
});

test("a page with diagrams carries exactly one script and the diagram CSP", () => {
  const sections = [issueSection("S", PLAN)];
  const { html } = contractHTML(sections, { mode: "draft" }, "sha256:abc", "now", "var mermaid={};");
  assert.equal(html.split("<script").length - 1, 1);
  assert.match(html, /script-src 'sha256-/);
  assert.match(html, new RegExp(PLAN_NOTICE_TEXT.slice(0, 10)));
  assert.match(html, /data-mermaid-source=/);
});

test("plan headings do not become criterion or trace anchors", () => {
  const tricky = "说明\n\n#### Criteria\n\n- 这是方案里的普通条目\n\n#### Traces To\n\n- outcome-1";
  const out = renderPlanSection(tricky, "issue-1", seed());
  assert.equal(out.html.includes("-criterion-"), false);
  assert.equal(out.html.includes('href="#issue-1-outcome-1"'), false);
});

function issueSection(summary: string, plan: string | undefined) {
  return {
    key: "issue-1",
    kind: "issue" as const,
    state: "draft" as const,
    markdown: "---\ntype: issue\n---\n\n# Summary\n\nS\n",
    input: {
      format: 1,
      summary,
      context: "",
      ...(plan === undefined ? {} : { plan }),
      goals: [{ statement: "G", criteria: ["C"], traces_to: [{ type: "outcome" as const, ordinal: 1 }] }],
    },
  };
}

test("diagram ids are valid CSS identifiers even when the digest starts with a digit", () => {
  // A real content digest is hex, so roughly 61% of pages begin with a digit.
  // `#4a1b…` is not a valid selector; mermaid throws and nothing draws. The
  // seed must therefore never depend on the digest's leading character.
  for (const digest of ["sha256:42556db494827eabae81d11b1c0f09eb156aa944344ca0121fc0b48a1454ffc1",
                        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"]) {
    const { html } = contractHTML([issueSection("S", PLAN)], { mode: "draft" }, digest, "now", "var mermaid={};");
    // Each host carries its own section seed, and it must be a valid identifier.
    const seeds = [...html.matchAll(/data-mermaid-seed="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(seeds.length > 0, "each diagram host must carry a seed");
    for (const value of seeds) assert.match(value, /^[A-Za-z]/, `seed must start with a letter, got ${value}`);
    // The page-level seed in the init script must also be identifier-safe.
    const fallback = /var scoped=node\.getAttribute\('data-mermaid-seed'\)\|\|"([^"]+)"/.exec(html) ?? /deterministicIDSeed:"([^"]+)"/.exec(html);
    assert.ok(fallback, "init script must embed a literal seed");
    assert.match(fallback![1], /^[A-Za-z]/, `init seed must start with a letter, got ${fallback![1]}`);
  }
});

test("diagram ids differ per Issue section so two sections cannot collide", () => {
  const a = issueSection("A", PLAN);
  const b = { ...issueSection("B", PLAN), key: "issue-2" };
  const { html } = contractHTML([a, b], { mode: "draft" }, "sha256:abc", "now", "var mermaid={};");
  const seeds = [...html.matchAll(/data-mermaid-source="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(seeds).size, seeds.length, `diagram host ids must be unique: ${seeds.join(", ")}`);
});

test("the plan section sits between Context and Goals", () => {
  const section = issueSection("S", PLAN);
  section.markdown = "---\ntype: issue\n---\n\n# Summary\n\nS\n\n## Context\n\n背景文字\n\n## Goals\n\n### G\n\n#### Criteria\n\n- C\n";
  section.input.context = "背景文字";
  const { html } = contractHTML([section], { mode: "draft" }, "sha256:abc", "now", "var mermaid={};");
  const contextAt = html.indexOf("背景文字");
  const planAt = html.indexOf("plan-section");
  const goalsAt = html.search(/<h3 id="[^"]*-heading-\d+">Goals<\/h3>/);
  assert.ok(contextAt >= 0 && planAt >= 0 && goalsAt >= 0, "all three must be present");
  assert.ok(contextAt < planAt && planAt < goalsAt, `expected Context < plan < Goals, got ${contextAt} / ${planAt} / ${goalsAt}`);
});

test("the diagram-cap warning reaches the caller instead of being dropped", () => {
  const many = Array.from({ length: 12 }, (_, i) => `\`\`\`mermaid\nflowchart TD\n  A${i}-->B${i}\n\`\`\``).join("\n\n");
  const { warnings } = contractHTML([issueSection("S", many)], { mode: "draft" }, "sha256:abc", "now", "var mermaid={};");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "PLAN_DIAGRAM_LIMIT");
  assert.match(warnings[0].message, /上限/);
});

test("a diagram over the source-size limit is rejected at generation time", () => {
  // mermaid returns its own error graphic above maxTextSize instead of
  // throwing, so this must be caught before the page is written.
  const huge = `flowchart TD\n${Array.from({ length: 6000 }, (_, i) => `  N${i}-->N${i + 1}`).join("\n")}`;
  assert.ok(huge.length > 50000, "fixture must exceed the limit");
  const out = renderPlanSection(`\`\`\`mermaid\n${huge}\n\`\`\``, "issue-1", seed());
  assert.equal(out.diagrams, 0);
  assert.match(out.html, /图渲染失败/);
  assert.match(out.html, /字符上限/);
});

test("the internal plan sentinel never reaches the rendered page", () => {
  // Regression: the sentinel that marks where plan is spliced used to survive
  // into the document, where it rendered as visible text on EVERY Issue page.
  const noPlan = issueSection("S", undefined);
  const withPlan = issueSection("S", PLAN);
  for (const [label, section] of [["without plan", noPlan], ["with plan", withPlan]] as const) {
    const { html } = contractHTML([section], { mode: "published" }, "sha256:abc", "now", "var mermaid={};");
    assert.equal(html.includes("grounds-plan-anchor"), false, `sentinel leaked (${label})`);
    assert.equal(/\u0000/.test(html), false, `NUL character leaked (${label})`);
  }
});

test("a page without a plan is unchanged by the plan feature", () => {
  // The sentinel splice must not shift anything when there is no plan.
  const section = issueSection("S", undefined);
  section.markdown = "---\ntype: issue\n---\n\n# Summary\n\nS\n\n## Context\n\n背景\n\n## Goals\n\n### G\n\n#### Criteria\n\n- C\n";
  section.input.context = "背景";
  const { html } = contractHTML([section], { mode: "published" }, "sha256:abc", "now", "var mermaid={};");
  const contextAt = html.indexOf("背景");
  const goalsAt = html.search(/<h3 id="[^"]*-heading-\d+">Goals<\/h3>/);
  assert.ok(contextAt > 0 && goalsAt > contextAt, "Context must precede Goals");
  assert.equal(html.slice(contextAt, goalsAt).includes("plan-anchor"), false);
});

test("plan text containing $-sequences never corrupts the surrounding sections", () => {
  // String.replace interprets `$&`, `` $` ``, `$'` and `$$` in a replacement
  // string. Plan is author text, so the splice must not go through one: `$&`
  // used to copy the Summary into the plan section and duplicate heading ids.
  const plan = "方案含 $& 与 $` 与 $' 与 $$5 这些记号。";
  const section = issueSection("S", plan);
  section.markdown = "---\ntype: issue\n---\n\n# Summary\n\nSUMMARYTEXT\n\n## Context\n\n背景段落\n\n## Goals\n\n### G\n\n#### Criteria\n\n- C\n";
  section.input.summary = "SUMMARYTEXT";
  section.input.context = "背景段落";
  const { html } = contractHTML([section], { mode: "draft" }, "sha256:abc", "now", "");
  const article = html.slice(html.indexOf("<article"));
  const planAt = article.indexOf("plan-section");
  const goalsAt = article.search(/<h3 id="[^"]*-heading-\d+">Goals<\/h3>/);
  assert.ok(planAt >= 0 && goalsAt > planAt, "plan section must precede Goals");
  // The Summary text must appear exactly once — in its own section, not copied in.
  assert.equal(article.split("SUMMARYTEXT").length - 1, 1, "Summary text must not be duplicated into plan");
  // No duplicated anchor ids.
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`);
  // The author's characters survive verbatim.
  assert.match(article, /\$&/);
  assert.match(article, /\$\$/);
});

test("a plan whose only fences never render keeps the script-free page", () => {
  // Presence of a fence is not presence of a diagram: statically rejected,
  // non-allowlisted and oversized diagrams all render nothing, so the page must
  // stay small and script-free.
  const cases = [
    "```mermaid\n%%{init:{'themeCSS':'.x{display:none}'}}%%\nflowchart TD\n A-->B\n```",
    "```mermaid\nflowchart TD\n  N[$$ 数学 $$]\n```",
    "```mermaid\npie\n  \"a\" : 1\n```",
    `\`\`\`mermaid\nflowchart TD\n${Array.from({ length: 6000 }, (_, i) => `  N${i}-->N${i + 1}`).join("\n")}\n\`\`\``,
  ];
  for (const plan of cases) {
    const { html } = contractHTML([issueSection("S", plan)], { mode: "draft" }, "sha256:abc", "now", "var mermaid={};");
    assert.equal(html.includes("<script"), false, `must not inline a runtime for: ${plan.slice(0, 40)}`);
    assert.equal(/\u0000/.test(html), false);
  }
});

test("static rejection matches the contract's literal substrings, not word-bounded ones", () => {
  // The contract rejects any source containing `<iframe`, `<object` or
  // `<embed`. A word boundary let `<objectives>` and `<embedded>` through.
  for (const source of ["<objectives>", "<embedded>", "<iframe_x>", "<iframe src=x>", "<object data=x>", "<embed src=x>"]) {
    assert.ok(staticRejection(`flowchart TD\n  A["${source}"]-->B`), `${source} must be rejected`);
  }
  // A plain identifier that merely starts with those letters is unaffected only
  // if it does not contain the angle bracket — the contract keys on `<`.
  assert.equal(staticRejection("flowchart TD\n  objective-->embedded"), undefined);
});
