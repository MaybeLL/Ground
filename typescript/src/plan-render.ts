import { createHash } from "node:crypto";

/**
 * Rendering for the non-normative Issue `plan` section in the read-only
 * contract review page.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * 1. Plan is NOT an acceptance obligation. The notice below is emitted by this
 *    template, so a plan author cannot remove or reword it.
 * 2. Mermaid runs in the viewer's browser and injects its own `<style>` into
 *    whatever holds the result. Inline SVG would therefore let a plan author
 *    restyle the whole page, so each diagram is isolated in an open shadow root
 *    on a host whose PARENT carries the clipping — shadow styles cannot select
 *    their host's parent.
 */

/** Emitted next to every plan section. Exact text is a contract criterion. */
export const PLAN_NOTICE_TEXT = "方案说明：以下内容仅为整体设计思路，不构成验收义务；约束以 Goals 与 Constraints 为准。";

/** Language identifier that marks a fence as a diagram. Case-sensitive first word. */
const MERMAID_INFO = "mermaid";

/** Only these diagram types render; anything else becomes a placeholder. */
export const ALLOWED_DIAGRAM_TYPES = ["flowchart", "sequenceDiagram", "classDiagram", "stateDiagram-v2", "erDiagram"] as const;

/** Per-section and per-generation ceilings (G3-c8). */
export const MAX_DIAGRAMS_PER_SECTION = 10;
/** Mirrors mermaid's own `maxTextSize`; over it mermaid returns an error
 * graphic instead of throwing, so the host must reject before rendering. */
export const MAX_DIAGRAM_SOURCE_CHARS = 50000;
export const MAX_DIAGRAMS_TOTAL = 10;

const escapeHTML = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface FencedBlock { info: string; body: string }

/** Split a markdown body into fenced blocks and the text between them. */
export function scanFences(markdown: string): Array<{ kind: "text"; text: string } | { kind: "fence"; block: FencedBlock }> {
  const out: Array<{ kind: "text"; text: string } | { kind: "fence"; block: FencedBlock }> = [];
  const lines = markdown.split("\n");
  let buffer: string[] = [];
  let open: { char: string; length: number; info: string } | undefined;
  let body: string[] = [];
  for (const line of lines) {
    const marker = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open && marker) {
      if (buffer.length) { out.push({ kind: "text", text: buffer.join("\n") }); buffer = []; }
      open = { char: marker[2][0], length: marker[2].length, info: marker[3].trim() };
      body = [];
      continue;
    }
    if (open && marker && marker[2][0] === open.char && marker[2].length >= open.length && !marker[3].trim()) {
      out.push({ kind: "fence", block: { info: open.info, body: body.join("\n") } });
      open = undefined;
      continue;
    }
    if (open) body.push(line); else buffer.push(line);
  }
  if (open) out.push({ kind: "fence", block: { info: open.info, body: body.join("\n") } });
  else if (buffer.length) out.push({ kind: "text", text: buffer.join("\n") });
  return out;
}

const isMermaid = (info: string): boolean => info.split(/\s+/)[0] === MERMAID_INFO;

/**
 * Reject source that could steer the runtime into emitting dangerous markup or
 * page-wide CSS. This is defence in depth: the shadow root and the parent
 * `contain: paint` are the primary controls; this keeps obviously hostile input
 * out of the renderer entirely and turns it into a placeholder.
 */
export const STATIC_REJECTION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "directive block", pattern: /%%\{/ },
  { label: "script tag", pattern: /<script/i },
  { label: "event handler attribute", pattern: /\bon[a-z]+\s*=/i },
  { label: "javascript URL", pattern: /javascript:/i },
  // No word boundary: the contract rejects any source containing these
  // substrings, and `\b` let `<objectives>` and `<embedded>` through.
  { label: "embedded frame or object", pattern: /<(iframe|object|embed)/i },
  // KaTeX ships in the bundle but its CSS and fonts are blocked by the page
  // CSP, so a maths label would render broken rather than merely unstyled.
  { label: "math label", pattern: /\$\$/ },
];

export function staticRejection(source: string): string | undefined {
  // A leading YAML frontmatter block is a second configuration channel.
  if (/^\s*---\s*\n[\s\S]*?\n---/.test(source)) return "frontmatter config block";
  for (const { label, pattern } of STATIC_REJECTION_PATTERNS) if (pattern.test(source)) return label;
  return undefined;
}

export function diagramType(source: string): string | undefined {
  const first = source.split("\n").map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("%%"));
  if (!first) return undefined;
  return (ALLOWED_DIAGRAM_TYPES as readonly string[]).find((type) => first.startsWith(type));
}

/** The figure HTML for one rendered diagram: parent clip + shadow host + source. */
export function diagramFigureHTML(id: string, caption: string, accessibleName: string, sourceHTML: string, sectionSeed: string): string {
  return [
    `<figure class="plan-figure" data-diagram="${escapeHTML(id)}">`,
    `<figcaption>${escapeHTML(caption)}</figcaption>`,
    // The clipping sits on this PARENT, never on the host: a `:host{...}` rule
    // from inside the shadow tree would otherwise win (inner !important beats
    // outer !important), which is exactly the escape this prevents. The host is
    // the inner element, and it is what receives the shadow root.
    `<div class="plan-diagram-clip" style="contain:paint;overflow:hidden;max-width:100%;max-height:80vh">`,
    `<div class="plan-diagram-host" role="img" aria-label="${escapeHTML(accessibleName)}" data-mermaid-source="${escapeHTML(id)}" data-mermaid-seed="${escapeHTML(sectionSeed)}"></div>`,
    `</div>`,
    `<details class="plan-source"><summary>查看图源码</summary><pre id="${escapeHTML(id)}-src">${sourceHTML}</pre></details>`,
    `</figure>`,
  ].join("");
}

export function diagramPlaceholderHTML(id: string, reason: string, sourceHTML: string, sectionSeed = ""): string {
  return [
    `<figure class="plan-figure" data-diagram="${escapeHTML(id)}">`,
    `<p class="plan-diagram-failed" role="note">⚠ 图渲染失败：${escapeHTML(reason)}</p>`,
    `<details class="plan-source" open><summary>查看图源码</summary><pre id="${escapeHTML(id)}-src">${sourceHTML}</pre></details>`,
    `</figure>`,
  ].join("");
}

export interface PlanWarning { code: string; message: string }
export interface PlanRenderResult { html: string; diagrams: number; withheld: number; warnings: PlanWarning[] }

/**
 * Render a plan section. `plan` is the sealed non-normative text; the section
 * and every diagram below are driven by it alone, never by scanning rendered
 * markdown for a `## Plan` heading.
 */
export function renderPlanSection(plan: string, key: string, sectionSeed = ""): PlanRenderResult {
  const warnings: PlanWarning[] = [];
  const blocks: string[] = [];
  let diagrams = 0;
  let withheld = 0;
  let index = 0;
  // The notice is emitted before any author content and is not derived from it.
  const parts: string[] = [`<div class="plan-notice" role="note">${escapeHTML(PLAN_NOTICE_TEXT)}</div>`];
  for (const item of scanFences(plan)) {
    if (item.kind === "text") { parts.push(markdownToHTML(item.text)); continue; }
    if (!isMermaid(item.block.info)) { parts.push(`<pre><code>${escapeHTML(item.block.body)}</code></pre>`); continue; }
    index += 1;
    const id = `${key}-diagram-${index}`;
    const sourceHTML = escapeHTML(item.block.body);
    if (index > MAX_DIAGRAMS_PER_SECTION) {
      withheld += 1;
      parts.push(diagramPlaceholderHTML(id, "超出本次渲染的图数量上限", sourceHTML));
      continue;
    }
    const rejected = staticRejection(item.block.body);
    if (rejected) { parts.push(diagramPlaceholderHTML(id, `源码被拒绝（${rejected}）`, sourceHTML)); continue; }
    // Over mermaid's maxTextSize the runtime returns its own error graphic
    // rather than throwing, so a runtime check cannot turn it into a
    // placeholder. Reject at generation time instead.
    if (item.block.body.length > MAX_DIAGRAM_SOURCE_CHARS) {
      parts.push(diagramPlaceholderHTML(id, `源码超过 ${MAX_DIAGRAM_SOURCE_CHARS} 字符上限`, sourceHTML));
      continue;
    }
    if (!diagramType(item.block.body)) { parts.push(diagramPlaceholderHTML(id, "图类型不在允许列表内", sourceHTML)); continue; }
    diagrams += 1;
    parts.push(diagramFigureHTML(id, "方案说明图（非约束）", accessibleNameFor(item.block.body), sourceHTML, sectionSeed));
  }
  if (withheld > 0) warnings.push({ code: "PLAN_DIAGRAM_LIMIT", message: `plan 图数量超出上限：本段 ${index} 张，已渲染 ${diagrams} 张，其余使用占位。` });
  blocks.push(parts.join("\n"));
  return { html: blocks.join("\n"), diagrams, withheld, warnings };
}

/** Accessible name: Mermaid accTitle when present, else the first source line. */
export function accessibleNameFor(source: string): string {
  const explicit = /^\s*accTitle\s*:\s*(.+)$/m.exec(source);
  if (explicit) return explicit[1].trim();
  const first = source.split("\n").map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("%%"));
  return first ?? "方案说明图";
}

/**
 * Minimal inline markdown for plan prose. Deliberately narrower than the main
 * page renderer: plan is non-normative text, so paragraphs, emphasis, inline
 * code and safe links are enough, and raw HTML is escaped rather than trusted.
 */
function markdownToHTML(text: string): string {
  const inline = (value: string): string => escapeHTML(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  return text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
    .map((paragraph) => `<p>${inline(paragraph).replace(/\n/g, "<br>")}</p>`).join("\n");
}

export interface InlineRuntime { script: string; cspHash: string }

/**
 * Build the single inline `<script>` that renders every diagram on the page:
 * the pinned runtime plus an init block. Returned as one element so the CSP
 * needs exactly one sha256 source.
 *
 * The init block renders OUTSIDE the shadow root and moves the returned SVG in
 * afterwards: mermaid's renderers look their SVG up from `document.body` via
 * d3, so a container inside a shadow root yields null `getBBox` and nothing
 * draws. Injection is `innerHTML` on the shadow root, which is not eval and
 * keeps the runtime's own `<style>` scoped to that diagram.
 */
export function inlineRuntimeScript(runtimeSource: string, seed: string, live = false): InlineRuntime {
  const init = `${live ? "window.addEventListener('grounds-render', function(){" : "(function(){"}
  var nodes=[].slice.call(document.querySelectorAll('[data-mermaid-source]'));
  if(!nodes.length)return;
  mermaid.initialize({startOnLoad:false,securityLevel:'strict',htmlLabels:true,deterministicIds:true,deterministicIDSeed:${JSON.stringify(seed)},suppressErrorRendering:true,
    secure:['theme','themeCSS','themeVariables','fontFamily','securityLevel','htmlLabels'],maxTextSize:50000,maxEdges:500});
  var fail=function(node,error,source){
    // Clear anything already in the shadow root first: on some failures (for
    // example exceeding maxTextSize) mermaid inserts its own error graphic into
    // the document, which would otherwise sit alongside — or instead of — the
    // placeholder. The contract requires the diagram be REPLACED by a
    // placeholder showing the escaped source and an error summary.
    var root=node.shadowRoot||node.attachShadow({mode:'open'});
    root.innerHTML='';
    var box=document.createElement('div');box.className='plan-diagram-failed';box.setAttribute('role','note');
    var p=document.createElement('p');
    p.textContent='图渲染失败：'+(error&&error.message?String(error.message).slice(0,200):'未知错误');
    box.appendChild(p);
    if(source){var pre=document.createElement('pre');pre.textContent=source;box.appendChild(pre);}
    root.appendChild(box);
  };
  var index=0;
  var next=function(){
    if(index>=nodes.length){return;}
    var node=nodes[index];var id=node.getAttribute('data-mermaid-source');index++;
    var source=document.getElementById(id+'-src');
    var text=source?source.textContent:'';
    // Each host carries its own section seed and its own ordinal within that
    // section: the source attribute ends with the diagram number. A page-global
    // counter would make an id depend on how many diagrams share the page.
    var scoped=node.getAttribute('data-mermaid-seed')||${JSON.stringify(seed)};
    var ordinal=id.slice(id.lastIndexOf('-')+1);
    mermaid.render(scoped+'-'+ordinal,text).then(function(result){
      var root=node.shadowRoot||node.attachShadow({mode:'open'});
      root.innerHTML=result.svg;
    }).catch(function(error){fail(node,error,text);}).then(next,next);
  };
  next();
${live ? "});" : "})();"}`;
  // The escape guard runs BEFORE hashing: a future pinned build containing a
  // literal `</script` must not be able to end this element early.
  const guarded = (runtimeSource + "\n" + init).replace(/<\/script/gi, "<\\/script");
  const script = `<script>${guarded}</script>`;
  const cspHash = `sha256-${createHash("sha256").update(guarded, "utf8").digest("base64")}`;
  return { script, cspHash };
}

/** Exact CSP strings; both are emitted in full rather than relying on default-src. */
export const CSP_WITHOUT_DIAGRAMS = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
export const cspWithDiagrams = (hash: string): string => `default-src 'none'; script-src '${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
