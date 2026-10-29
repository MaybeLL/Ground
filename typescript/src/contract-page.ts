import { Marked, Renderer } from "marked";
import type {
  RequirementInput,
  IssueInput,
  TargetInput,
  ConstraintInput,
} from "./domain.js";
import type { JsonSnapshot } from "./workspace-json.js";
import { sha256 } from "./canonical-json.js";
import { validation } from "./errors.js";
import { renderPlanSection } from "./plan-render.js";
export interface ContractSection {
  key: string;
  kind: "requirement" | "issue";
  state: "draft" | "published";
  id?: string;
  version?: number;
  markdown: string;
  input: RequirementInput | IssueInput;
  repository?: { id?: string; canonical_remote: string };
  baseline?: string;
  binding?: string;
  original_binding?: string;
  source_path?: string;
  editPath?: Array<string | number>;
  questions?: string[];
  assumptions?: string[];
}
export interface ReadingBlock {
  id: string;
  path: Array<string | number>;
  label: string;
}
export const escapeReadingHTML = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const esc = escapeReadingHTML;
export function readingMarkdown(text: string): string {
  const renderer = new Renderer();
  renderer.html = ({ text }) => esc(text);
  renderer.link = function ({ href, tokens }) {
    const label = this.parser.parseInline(tokens);
    return /^(https?:|mailto:|#)/i.test(href)
      ? `<a href="${esc(href)}" rel="noreferrer">${label}</a>`
      : `${label} <code>${esc(href)}</code>`;
  };
  renderer.image = ({ text, href }) => `[image: ${esc(text)} — ${esc(href)}]`;
  renderer.heading = function ({ tokens }) {
    return `<h5>${this.parser.parseInline(tokens)}</h5>`;
  };
  return new Marked({ renderer, gfm: true, breaks: false }).parse(
    text,
  ) as string;
}
export const READING_CSS = `
.reading-block{position:relative;min-width:0;scroll-margin-top:24px}
.reading-block:focus-within{outline:2px solid #8bbab4;outline-offset:4px}
.empty-field{color:#647889;font-size:14px}
.reading-nav-group,.reading-nav-collection,.reading-nav-entry{position:static!important;border-radius:0!important;box-shadow:none!important;margin:0!important;padding:6px 0!important}
.reading-nav-collection,.reading-nav-entry{border:0!important}
.reading-nav-entry p{font-size:12px;margin:6px 0;white-space:normal}
.reading-nav-collection{padding-left:8px!important}
.reading-nav-group{border-top:1px solid #dce5eb;padding:8px 0}
.reading-nav-group summary{display:flex;gap:6px;list-style:none}
.reading-nav-group summary::before{content:"▸";flex:none}
.reading-nav-group details[open]>summary::before,.reading-nav-group[open]>summary::before{content:"▾"}
.nav-label{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5;overflow-wrap:anywhere}
.reading-nav-group a{display:block;padding:4px 0;font-size:13px}
.reading-nav-group .nav-child{padding-left:12px}
.reading-nav-group summary{font-size:14px;cursor:pointer}
.reading-nav-group summary:focus-visible,.reading-nav-group a:focus-visible{outline:3px solid #6eaaa4;outline-offset:2px}
.reading-target{border-left:3px solid #dce5eb;padding:0 0 4px 16px;margin:20px 0}
.reading-details dt{font-weight:600}
.reading-details dd{margin:0 0 12px 12px}
.reading-block pre{max-width:100%;overflow:auto}
.reading-block li{overflow-wrap:anywhere}
@media(max-width:400px){article{padding:12px!important}
.layout{padding-left:8px!important;padding-right:8px!important}
.reading-target{padding-left:8px}
.section-top{flex-wrap:wrap}
header{padding:20px 12px!important}
h1{font-size:23px!important}
}

.reading-block{line-height:1.8}
.reading-block h2,.reading-block h3,.reading-block h4,.reading-block h5{line-height:1.5;scroll-margin-top:180px}
.reading-block h3{font-size:19px;border-bottom:1px solid #dce5eb;padding-bottom:6px;margin-top:28px}
.reading-block h4{font-size:17px}
.reading-block pre{background:#eef3f5;padding:14px;border-radius:6px;white-space:pre;overflow:auto}
.reading-block table{display:block;overflow:auto;max-width:100%;border-collapse:collapse;font-size:14px}
.reading-block td,.reading-block th{padding:9px 12px;border:1px solid #dce5eb;text-align:left}
.reading-block th{background:#f0f5f6}
.reading-block blockquote{border-left:4px solid #91b5b0;margin-left:0;padding-left:16px;color:#52677a}
.source-details{margin:12px 0;font-size:13px}
.source-details pre.metadata{white-space:pre-wrap;font-size:12px;line-height:1.6;max-width:100%;overflow:auto}
.section-top{display:flex;gap:10px;align-items:center;font-size:13px;color:#52677a}
.badge{font-size:12px;padding:2px 10px;border-radius:20px;background:#e5efeb;color:#205849}
.badge.draft{background:#fff0d6;color:#7e571a}
.repository,.binding{color:#52677a;font-size:14px}
.plan-diagram-clip{contain:paint;overflow:hidden;max-width:100%;max-height:80vh}
.plan-figure{max-width:100%;min-width:0}
`;
/** Typed semantic blocks are shared by immutable exports and the live editor. */
export function renderReadingSections(sections: ContractSection[]) {
  const blocks: ReadingBlock[] = [];
  const warnings: Array<{ code: string; message: string }> = [];
  let diagrams = 0;
  const groups: string[] = [];
  const html = sections
    .map((section) => {
      const key = section.key;
      let serial = 0;
      const nav: string[] = [];
      const children: Record<string, string[]> = {};
      const path = section.editPath;
      const childNav = (
        group: string,
        id: string,
        label: string,
        title: string,
      ) => {
        (children[group] ??= []).push(
          `<details class="reading-nav-entry"><summary><span class="nav-label">${esc(label)} · ${esc(title)}</span></summary><p>${esc(title)}</p><a href="#${esc(id)}">查看 ${esc(label)} 正文</a></details>`,
        );
      };
      const at = (...parts: Array<string | number>) =>
        path ? [...path, ...parts] : undefined;
      const block = (
        name: string,
        label: string,
        contents: string,
        p?: Array<string | number>,
        heading = true,
      ) => {
        const id = `${key}-${name}`;
        if (p) blocks.push({ id, path: p, label });
        nav.push(
          children[name]?.length
            ? `<details class="reading-nav-collection"><summary>${esc(label)}</summary><a href="#${esc(id)}">查看全部</a>${children[name].join("")}</details>`
            : `<a href="#${esc(id)}"><span class="nav-label">${esc(label)}</span></a>`,
        );
        return `<section class="reading-block" id="${esc(id)}"${p ? ` data-edit-path="${esc(JSON.stringify(p))}" data-edit-label="${esc(label)}"` : ""}>${heading ? `<h3 id="${key}-heading-${++serial}">${esc(label)}</h3>` : ""}${contents || '<p class="empty-field">尚未填写</p>'}</section>`;
      };
      const itemBlock = (
        name: string,
        label: string,
        contents: string,
        p?: Array<string | number>,
      ) => {
        const id = `${key}-${name}`;
        if (p) blocks.push({ id, path: p, label });
        return `<section class="reading-block reading-target" id="${id}"${p ? ` data-edit-path="${esc(JSON.stringify(p))}" data-edit-label="${esc(label)}"` : ""}>${contents}</section>`;
      };
      const list = (values: string[] | undefined, prefix?: string) =>
        values?.length
          ? `<ul>${values.map((v, i) => `<li${prefix ? ` id="${prefix}-${i + 1}"` : ""}>${readingMarkdown(v)}</li>`).join("")}</ul>`
          : "";
      let content = block(
        "summary",
        "Summary",
        `<h2>${esc(section.input.summary)}</h2>`,
        at("summary"),
        false,
      );
      content += block(
        "context",
        "Context",
        readingMarkdown(section.input.context ?? ""),
        at("context"),
      );
      if (section.kind === "requirement") {
        const input = section.input as RequirementInput;
        content += block(
          "outcomes",
          "Outcomes",
          input.outcomes
            .map((value, i) => {
              childNav(
                "outcomes",
                `${key}-outcome-${i + 1}`,
                `Outcome ${i + 1}`,
                value,
              );
              return itemBlock(
                `outcome-${i + 1}`,
                `Outcome ${i + 1}`,
                readingMarkdown(value),
                at("outcomes", i),
              );
            })
            .join(""),
          at("outcomes"),
        );
        content += block(
          "decisions",
          "Decisions",
          (input.decisions ?? [])
            .map((d, i) => {
              childNav(
                "decisions",
                `${key}-decision-${i + 1}`,
                `Decision ${i + 1}`,
                d.statement,
              );
              return itemBlock(
                `decision-${i + 1}`,
                `Decision ${i + 1}`,
                `<h4>decision-${i + 1} · ${esc(d.statement)}</h4>${d.rationale ? `<h5>Rationale</h5>${readingMarkdown(d.rationale)}` : ""}${d.context ? `<h5>Context</h5>${readingMarkdown(d.context)}` : ""}${
                  Object.keys(d).some(
                    (k) => !["statement", "rationale", "context"].includes(k),
                  )
                    ? `<details open><summary>Details</summary><dl class="reading-details">${Object.entries(
                        d,
                      )
                        .filter(
                          ([k]) =>
                            !["statement", "rationale", "context"].includes(k),
                        )
                        .map(
                          ([k, v]) =>
                            `<dt>${esc(k)}</dt><dd><pre>${esc(JSON.stringify(v, null, 2))}</pre></dd>`,
                        )
                        .join("")}</dl></details>`
                    : ""
                }`,
                at("decisions", i),
              );
            })
            .join(""),
          at("decisions"),
        );
        content += block(
          "questions",
          "Open Questions",
          (input.open_questions ?? [])
            .map(
              (q) =>
                `<section><h4>${q.blocking ? "[blocking]" : "[non-blocking]"} ${esc(q.question)}</h4>${q.assumption ? `<h5>Assumption</h5>${readingMarkdown(q.assumption)}` : ""}</section>`,
            )
            .join(""),
          at("open_questions"),
        );
      } else {
        const input = section.input as IssueInput;
        if (input.plan || path) {
          const plan = input.plan
            ? renderPlanSection(
                input.plan,
                key,
                `g${String(section.id ?? key).replace(/[^A-Za-z0-9_-]/g, "")}v${section.version ?? 0}`,
              )
            : undefined;
          if (plan) {
            diagrams += plan.diagrams;
            warnings.push(...plan.warnings);
          }
          content += block(
            "plan",
            "方案说明（非约束）",
            plan ? `<div class="plan-section">${plan.html}</div>` : "",
            at("plan"),
          );
        }
        const targets = (values: TargetInput[] | undefined, kind: string) =>
          (values ?? [])
            .map((t, i) => {
              const label = `${kind === "goals" ? "G" : "C"}${i + 1}`;
              const id = `${key}-${kind}-${i + 1}`;
              childNav(kind, id, label, t.statement);
              const rationale = (t as ConstraintInput).rationale;
              return itemBlock(
                `${kind}-${i + 1}`,
                label,
                `<h4>${label} · ${esc(t.statement)}</h4>${rationale ? `<h5>Rationale</h5>${readingMarkdown(rationale)}` : ""}<h5>Criteria</h5>${list(t.criteria, `${id}-criterion`)}${t.guidance?.length ? `<h5>Guidance</h5>${list(t.guidance)}` : ""}${t.traces_to?.length ? `<h5>Traces To</h5><ul>${t.traces_to.map((link) => `<li>${traceExists(sections, section.binding, link.type, link.ordinal) ? `<a href="#${esc(section.binding!)}-${link.type}-${link.ordinal}">${link.type}-${link.ordinal}</a>` : `${link.type}-${link.ordinal}（未解析的关联，请修订）`}</li>`).join("")}</ul>` : ""}`,
                at(kind, i),
              );
            })
            .join("");
        content += block(
          "goals",
          "Goals",
          targets(input.goals, "goals"),
          at("goals"),
        );
        content += block(
          "constraints",
          "Constraints",
          targets(input.constraints, "constraints"),
          at("constraints"),
        );
        content += block(
          "target-branch",
          "目标分支",
          input.target_branch
            ? `<p>${esc(input.target_branch.remote)} · ${esc(input.target_branch.ref)}</p>`
            : "",
          at("target_branch"),
        );
        content += block(
          "baseline",
          "Baseline",
          section.baseline ? `<p>${esc(section.baseline)}</p>` : "",
          path ? [...path.slice(0, -1), "baselineExpression"] : undefined,
        );
        for (const [name, label] of [
          ["questions", "Open Questions"],
          ["assumptions", "Assumptions"],
        ] as const) {
          const note =
            section[name] !== undefined
              ? list(section[name])
              : legacyNotes(section.markdown, label);
          content += block(
            name,
            label,
            note,
            path ? [...path.slice(0, -1), name] : undefined,
          );
        }
      }
      const metadata = {
        ...section,
        input: undefined,
        markdown: undefined,
        editPath: undefined,
        questions: undefined,
        assumptions: undefined,
      };
      groups.push(
        `<details class="reading-nav-group" open><summary><span class="nav-label">${section.kind === "requirement" ? "需求" : "Issue"} · ${esc(section.input.summary)}</span></summary><a href="#${key}">概览 · ${section.state === "draft" ? "草稿" : `v${section.version}`}</a>${nav.join("")}</details>`,
      );
      return `<article id="${esc(key)}"><div class="section-top"><span class="badge ${section.state}">${section.state === "draft" ? "草稿" : "已发布"}</span><span>${section.kind === "requirement" ? "Requirement · 需求" : "Issue · 开发契约"}${section.version ? ` · ${section.state === "draft" ? "基础版本 " : "版本 "}${section.version}` : ""}</span></div>${section.binding ? `<p class="binding">${section.state === "draft" ? "本轮解释依据" : "绑定需求"}：<a href="#${esc(section.binding)}">${section.binding === "requirement-draft" ? "当前需求草稿" : esc(section.binding)}</a>${section.original_binding && section.original_binding !== section.binding ? ` · 原绑定：${esc(section.original_binding)}` : ""}</p>` : ""}${section.repository ? `<p class="repository">仓库：${esc(section.repository.canonical_remote)}</p>` : ""}<details class="source-details"><summary>查看身份、版本与来源</summary><pre class="metadata">${esc(JSON.stringify(metadata, null, 2))}</pre></details>${content}</article>`;
    })
    .join("\n");
  return {
    html,
    documents: html,
    navigation: groups.join("\n"),
    blocks,
    warnings,
    diagrams,
  };
}
function legacyNotes(markdown: string, label: string): string {
  const tokens = new Marked().lexer(markdown);
  let active = false,
    result = "";
  for (const token of tokens) {
    if (token.type === "heading" && token.depth <= 2) {
      active = token.text === label;
      continue;
    }
    if (active) result += token.raw;
  }
  return readingMarkdown(result);
}
/** Local managed bases are sufficient for the common case; never guess missing history. */
export function renderWorkspaceReading(snapshot: JsonSnapshot) {
  const { manifest, draft } = snapshot;
  const sections: ContractSection[] = [
    {
      key: "requirement-draft",
      kind: "requirement",
      state: "draft",
      id: manifest.requirement.id,
      version: manifest.requirement.version,
      input: draft.requirement,
      markdown: "",
      editPath: ["requirement"],
    },
  ];
  const reqChanged =
    !manifest.requirement.base ||
    sha256(manifest.requirement.base) !== sha256(draft.requirement);
  draft.issues.forEach((issue, index) => {
    const entry = manifest.issues.find((e) => e.key === issue.key);
    let binding = "requirement-draft";
    let original: string | undefined;
    if (entry?.id) {
      const selected =
        entry.desired_requirement_revision_id ?? entry.requirement_revision_id;
      if (
        !selected ||
        selected !== manifest.requirement.revision_id ||
        !manifest.requirement.base
      )
        throw validation(
          "workspace.source",
          `required fixed Requirement source missing for Issue ${issue.key}; reopen or rebase the Workspace to include its source`,
        );
      original = `requirement-${manifest.requirement.id}-v${manifest.requirement.version}`;
      const changed =
        !entry.base ||
        sha256(issue.input) !== sha256(entry.base) ||
        issue.baselineExpression !== entry.baseline?.git_oid ||
        selected !== entry.requirement_revision_id;
      if (!(changed && reqChanged)) {
        binding = original;
        if (!sections.some((s) => s.key === binding))
          sections.push({
            key: binding,
            kind: "requirement",
            state: "published",
            id: manifest.requirement.id,
            version: manifest.requirement.version,
            input: manifest.requirement.base,
            markdown: "",
          });
      }
    }

    sections.push({
      key: `issue-${index + 1}`,
      kind: "issue",
      state: "draft",
      id: entry?.id,
      version: entry?.version,
      input: issue.input,
      markdown: "",
      repository: { canonical_remote: manifest.repository_remote },
      baseline: issue.baselineExpression,
      binding,
      original_binding: original,
      editPath: ["issues", index, "input"],
      questions: issue.questions,
      assumptions: issue.assumptions,
    });
  });
  const source = {
    mode: "draft",
    workspace: manifest.name,
    workspace_version: snapshot.version,
    external_issues_excluded: !!manifest.external_issues,
    objects: sections.map(
      ({ input, markdown, editPath, questions, assumptions, ...metadata }) =>
        metadata,
    ),
  };
  const reading = renderReadingSections(sections);
  const id = "workspace-issues";
  const management = `<section class="reading-block" id="${id}" data-edit-path="${esc(JSON.stringify(["issues"]))}" data-edit-label="管理工作项"><h3>管理工作项</h3><ul>${draft.issues.map((issue) => `<li>${esc(issue.key)}</li>`).join("")}</ul></section>`;
  return {
    ...reading,
    html: reading.html + management,
    documents: reading.html + management,
    navigation: reading.navigation + `<a href="#${id}">管理工作项</a>`,
    blocks: [...reading.blocks, { id, path: ["issues"], label: "管理工作项" }],
    source,
  };
}

function traceExists(
  sections: ContractSection[],
  binding: string | undefined,
  type: string,
  ordinal: number,
): boolean {
  const input = sections.find((s) => s.key === binding)?.input as
    RequirementInput | undefined;
  return (
    !!input &&
    ordinal > 0 &&
    ordinal <=
      (type === "outcome"
        ? input.outcomes.length
        : (input.decisions?.length ?? 0))
  );
}
