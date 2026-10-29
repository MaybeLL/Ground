import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { renderReadingSections, READING_CSS, type ContractSection } from "./contract-page.js";
import { sha256 } from "./canonical-json.js";
import { DomainError, validation } from "./errors.js";
import type { Module } from "./module.js";
import type { RequirementInput, RequirementRevision, IssueInput } from "./domain.js";
import { JSON_FORMAT, type JsonManifest } from "./workspace-json.js";
import type { WorkspaceModule } from "./workspace.js";
import { parseRequirementMarkdown, parseIssueMarkdown, renderRequirementMarkdown, renderIssueMarkdown, requirementInputFromRevision, issueInputFromRevision } from "./workspace-markdown.js";
import { CSP_WITHOUT_DIAGRAMS, PLAN_NOTICE_TEXT, cspWithDiagrams, inlineRuntimeScript, renderPlanSection } from "./plan-render.js";

type Section = ContractSection;
export interface ContractOptions { workspace?: string; requirement?: string; issues: string[]; output: string; format: string }
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const tuple = (text: string): [string, number] => { const match = /^(.+)@([1-9][0-9]*)$/.exec(text); if (!match || !Number.isSafeInteger(Number(match[2]))) throw validation("source", `expected ID@VERSION: ${text}`); return [match[1], Number(match[2])]; };
const body = (text: string): string => text.slice(text.indexOf("\n---\n", 4) + 5);
const requirementSourceDigest = ({ decisions, open_questions, ...input }: RequirementInput): string => sha256({
  ...input,
  ...(decisions === undefined || (Array.isArray(decisions) && decisions.length === 0) ? {} : { decisions }),
  ...(open_questions === undefined || (Array.isArray(open_questions) && open_questions.length === 0) ? {} : { open_questions }),
});
const targetSource = ({ guidance, ...input }: IssueInput["goals"][number]) => ({
  ...input,
  ...(guidance === undefined || (Array.isArray(guidance) && guidance.length === 0) ? {} : { guidance }),
});
const issueSourceDigest = ({ goals, constraints, ...input }: IssueInput): string => sha256({
  ...input,
  goals: goals.map(targetSource),
  ...(constraints === undefined || (Array.isArray(constraints) && constraints.length === 0) ? {} : { constraints: constraints.map(targetSource) }),
});

export async function collectContractReview(work: Module, options: ContractOptions, workspace?: WorkspaceModule) {
  if (options.workspace ? options.requirement || options.issues.length : !options.requirement && !options.issues.length) throw validation("source", "select one explicit Workspace OR fixed Requirement/Issue versions");
  const sections: Section[] = []; let identity: string | undefined; let snapshot: ReturnType<WorkspaceModule["reviewSnapshot"]> | undefined;
  const fixed = (revision: RequirementRevision): string => {
    if (identity && identity !== revision.requirement_id) throw validation("source", "mixed Requirement identities are not supported");
    identity = revision.requirement_id; const key = `requirement-${revision.requirement_id}-v${revision.revision_number}`;
    if (!sections.some(item => item.key === key)) { const input = requirementInputFromRevision(revision); sections.push({ key, kind: "requirement", state: "published", id: identity, version: revision.revision_number, input, markdown: renderRequirementMarkdown(input, identity, revision.revision_number) }); }
    return key;
  };
  if (options.workspace) {
    if (!workspace) throw validation("workspace", "Workspace reader unavailable");
    snapshot = workspace.reviewSnapshot(options.workspace); const { manifest, files, path } = snapshot;
    identity = manifest.requirement.id;
    const req = manifest.format===JSON_FORMAT ? {input:(manifest as JsonManifest).draft.requirement,frontmatter:{id:manifest.requirement.id,version:manifest.requirement.version}} : parseRequirementMarkdown(files["requirement.md"]);
    if (req.frontmatter.id !== identity || req.frontmatter.version !== manifest.requirement.version) throw validation("requirement.md", "managed identity/version differs from Workspace");
    if (identity) {
      if (!manifest.requirement.revision_id) throw validation("requirement.md", "managed Requirement source revision missing");
      const base = await work.contractRequirement(identity, undefined, manifest.requirement.revision_id);
      if (base.revision_number !== manifest.requirement.version || !manifest.requirement.base || requirementSourceDigest(requirementInputFromRevision(base)) !== requirementSourceDigest(manifest.requirement.base)) throw validation("requirement.md", "managed Requirement source conflict");
    }
    const reqChanged = !manifest.requirement.base || sha256(req.input) !== sha256(manifest.requirement.base);
    sections.push({ key: "requirement-draft", kind: "requirement", state: "draft", id: identity, version: manifest.requirement.version, input: req.input, markdown: files["requirement.md"], source_path: join(path, manifest.format===JSON_FORMAT?".workspace.json":"requirement.md") });
    const seen = new Set<string>(); const claimed = new Set<string>();
    for (const [file, text] of Object.entries(files).filter(([file]) => file.startsWith("issues/"))) {
      const entryForFile=manifest.issues.find(e=>e.file===file);const jsonDraft=manifest.format===JSON_FORMAT?(manifest as JsonManifest).draft.issues.find(d=>d.key===entryForFile?.key):undefined;const draft = jsonDraft?{...jsonDraft,frontmatter:{id:entryForFile?.id,version:entryForFile?.version}}:parseIssueMarkdown(text, file); const id = draft.frontmatter.id;
      if (id && seen.has(id)) throw validation(file, "duplicate Issue identity"); if (id) seen.add(id);
      const matches = manifest.issues.filter(entry => id ? entry.id === id : entry.file === file);
      if (matches.length > 1) throw validation(file, "duplicate managed Issue identity");
      const entry = matches[0];
      if ((id && !entry) || draft.frontmatter.id !== entry?.id || draft.frontmatter.version !== entry?.version) throw validation(file, "managed identity/version differs from Workspace");
      if (entry) { if (claimed.has(entry.key)) throw validation(file, "conflicting managed source"); claimed.add(entry.key); }
      let original: string | undefined;
      if (entry?.id) {
        const recorded = await work.contractIssue(entry.id, entry.version!);
        if (recorded.revision.id !== entry.revision_id || recorded.revision.issue_id !== entry.id || recorded.revision.revision_number !== entry.version || recorded.requirement.id !== entry.requirement_revision_id || recorded.requirement.requirement_id !== identity || recorded.repository.canonical_remote !== manifest.repository_remote) throw validation(file, "managed source binding or repository conflict");
        // Workspace open/rebase use this projection; publication stores the parsed
        // contract and the complete returned Baseline. Validate these immutable
        // bases before using either to decide whether the draft needs a revision.
        if (!entry.base || issueSourceDigest(entry.base) !== issueSourceDigest(issueInputFromRevision(recorded.revision))) throw validation(file, "managed source contract conflicts with fixed Issue version");
        if (!entry.baseline || sha256(entry.baseline) !== sha256(recorded.revision.baseline)) throw validation(file, "managed source Baseline conflicts with fixed Issue version");
        original = `requirement-${recorded.requirement.requirement_id}-v${recorded.requirement.revision_number}`;
      }
      if (entry?.desired_requirement_revision_id !== undefined) {
        if (!identity || !entry.desired_requirement_revision_id) throw validation(file, "managed source desired Requirement binding missing");
        const desired = await work.contractRequirement(identity, undefined, entry.desired_requirement_revision_id);
        if (desired.requirement_id !== identity || desired.id !== entry.desired_requirement_revision_id) throw validation(file, "managed source desired Requirement binding conflict");
      }
      const changed = !entry?.base || sha256(draft.input) !== sha256(entry.base) || draft.baselineExpression !== entry.baseline?.git_oid || (entry.desired_requirement_revision_id !== undefined && entry.desired_requirement_revision_id !== entry.requirement_revision_id);
      let binding = "requirement-draft";
      const selectedBinding = entry?.desired_requirement_revision_id || entry?.requirement_revision_id;
      const historicalJSON = manifest.format === JSON_FORMAT && entry?.id && selectedBinding !== manifest.requirement.revision_id;
      // A JSON historical Issue cannot be jointly published with Requirement edits;
      // its read-only preview must still explain references against its fixed source.
      if (!(changed && reqChanged) || historicalJSON) {
        const revisionID = changed ? entry?.desired_requirement_revision_id || entry?.requirement_revision_id || manifest.requirement.revision_id : entry?.requirement_revision_id;
        if (!identity || !revisionID) throw validation(file, "required fixed Requirement binding missing");
        binding = fixed(await work.contractRequirement(identity, undefined, revisionID));
      }
      sections.push({ key: `issue-${sections.filter(item => item.kind === "issue").length + 1}`, kind: "issue", state: "draft", id, version: entry?.version, input: draft.input, markdown: text, repository: { canonical_remote: manifest.repository_remote }, baseline: draft.baselineExpression, binding, original_binding: original, source_path: join(path, manifest.format===JSON_FORMAT?".workspace.json":file) });
    }
    for (const entry of manifest.issues) if (entry.id && !seen.has(entry.id)) throw validation(entry.file, "managed Issue source missing");
  } else {
    if (options.requirement) { const [id, version] = tuple(options.requirement); fixed(await work.contractRequirement(id, version)); }
    for (const source of [...new Set(options.issues)]) {
      const [id, version] = tuple(source); const detail = await work.contractIssue(id, version); const binding = fixed(detail.requirement); const input = issueInputFromRevision(detail.revision);
      sections.push({ key: `issue-${id}-v${version}`, kind: "issue", state: "published", id, version, input, markdown: renderIssueMarkdown(input, detail.revision.baseline.git_oid, id, version), repository: detail.repository, baseline: detail.revision.baseline.git_oid, binding, original_binding: binding });
    }
  }
  for (const section of sections.filter(item => item.kind === "issue")) {
    const req = sections.find(item => item.key === section.binding)?.input as RequirementInput | undefined;
    if (!req) throw validation(section.key, "required Requirement section missing");
    const issue = section.input as IssueInput;
    for (const target of [...issue.goals, ...(issue.constraints ?? [])]) for (const link of target.traces_to ?? []) if (link.ordinal > (link.type === "outcome" ? req.outcomes.length : req.decisions?.length ?? 0)) throw validation(section.source_path ?? section.key, `invalid trace ${link.type}-${link.ordinal} in ${target.statement}`);
  }
  if (snapshot && sha256(snapshot) !== sha256(workspace!.reviewSnapshot(options.workspace!))) throw validation("workspace", "source collection or contents changed during generation; retry");
  const source = clean({ mode: options.workspace ? "draft" : "published", workspace: options.workspace, workspace_path: snapshot?.path, workspace_version: snapshot?.version, external_issues_excluded: !!snapshot?.files["external-issues.md"], objects: sections.map(({ markdown: _markdown, input: _input, ...metadata }) => metadata) });
  const digest = sha256(clean({ source, sections, files: snapshot?.files }));
  return { sections, source, digest, snapshot, assertConsistent: () => { if (snapshot && sha256(snapshot) !== sha256(workspace!.reviewSnapshot(options.workspace!))) throw validation("workspace", "source collection or contents changed during generation; retry"); } };
}

export interface ContractHTMLResult { html: string; warnings: Array<{ code: string; message: string }> }
export function contractHTML(sections: Section[], source: unknown, digest: string, generated: string, runtime = ""): ContractHTMLResult {
  const reading = renderReadingSections(sections);
  const { documents, warnings } = reading; const renderedDiagrams = reading.diagrams;
  // Whether to inline the runtime is decided by how many diagrams actually
  // rendered, not by whether the text happens to contain a fence: a plan whose
  // only fences are statically rejected, use a non-allowlisted type, or exceed
  // the size limit renders nothing and must keep the script-free page.
  const diagramCount = renderedDiagrams;
  // Diagram ids must be valid CSS identifiers, so the seed starts with a
  // letter: a content digest truncated to hex can begin with a digit, and
  // `#4a1b…` is not a valid selector — mermaid then throws and nothing draws.
  //
  // The seed binds each section to its OWN identity (published Issue id and
  // version, or the draft key) so a diagram's id does not move when another
  // Issue joins the page. The per-page seed below only orders them; each
  // section's own scope is applied inside the init script.
  const seeds = sections.filter(section => section.kind === "issue").map((section, index) => {
    const identity = section.id ?? section.key;
    return `g${String(identity).replace(/[^A-Za-z0-9_-]/g, "")}v${section.version ?? index}`;
  });
  const diagramSeed = [...new Set(seeds)].join("-") || "gissue";
  const runtimeInfo = runtime && diagramCount > 0 ? inlineRuntimeScript(runtime, diagramSeed) : undefined;
  const csp = runtimeInfo ? cspWithDiagrams(runtimeInfo.cspHash) : CSP_WITHOUT_DIAGRAMS;
  const runtimeScript = runtimeInfo ? runtimeInfo.script : "";
  const sourceInfo = source as { mode: string; workspace?: string; external_issues_excluded?: boolean };
  const issueCount = sections.filter(section => section.kind === "issue").length;
  const title = sections.find(section => section.kind === "requirement")?.input.summary ?? "契约审阅";
  const document = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${esc(title)} · Grounds</title><style>
:root{color-scheme:light;--ink:#192c3d;--muted:#52677a;--line:#dce5eb;--accent:#14645c}*{box-sizing:border-box}body{margin:0;background:#f3f6f8;color:var(--ink);font:16px/1.8 system-ui,-apple-system,sans-serif;overflow-wrap:anywhere}header{max-width:1240px;margin:auto;padding:40px 32px 24px}.eyebrow{font-size:13px;letter-spacing:.08em;color:var(--accent);font-weight:700}h1{font-size:30px;line-height:1.45;margin:12px 0}.lead,.repository,.binding{color:var(--muted);font-size:14px}.layout{display:grid;grid-template-columns:250px minmax(0,1fr);gap:24px;max-width:1240px;margin:auto;padding:0 32px 40px}aside{min-width:0}aside details{position:sticky;top:20px;background:white;border:1px solid var(--line);border-radius:12px;padding:16px}summary{cursor:pointer;font-weight:600;color:var(--muted)}nav{max-height:75vh;overflow:auto;padding-top:12px}nav a{display:block;font-size:13px;padding:3px 0}nav small{display:block;font-size:11px;color:var(--muted)}nav .section-link{padding:12px 0 6px;border-top:1px solid var(--line);margin-top:10px}nav .depth-3,nav .depth-4{padding-left:12px}a{color:var(--accent);text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid #6eaaa4;outline-offset:3px}main{min-width:0}article{background:white;padding:28px;margin:0 0 24px;border:1px solid var(--line);border-radius:12px;min-width:0}.section-top{display:flex;gap:10px;align-items:center;font-size:13px;color:var(--muted)}.badge{font-size:12px;padding:2px 10px;border-radius:20px;background:#e5efeb;color:#205849}.badge.draft{background:#fff0d6;color:#7e571a}h2,h3,h4,h5{scroll-margin-top:24px;line-height:1.5}h2{font-size:23px;margin:14px 0}h3{font-size:19px;margin-top:28px;border-bottom:1px solid var(--line);padding-bottom:6px}h4{font-size:17px}pre{overflow:auto;max-width:100%;background:#eef3f5;padding:14px;border-radius:6px;white-space:pre}pre.metadata{white-space:pre-wrap;font-size:12px;line-height:1.6}.source-details{margin:12px 0;font-size:13px}table{display:block;overflow:auto;max-width:100%;border-collapse:collapse;font-size:14px}td,th{padding:9px 12px;border:1px solid var(--line);text-align:left}th{background:#f0f5f6}code{font-size:.9em}blockquote{border-left:4px solid #91b5b0;margin-left:0;padding-left:16px;color:var(--muted)}li{margin:5px 0}.scope-note{font-size:13px;color:var(--muted);margin-bottom:8px}@media(max-width:850px){header{padding:24px 16px 16px}.layout{display:block;padding:0 16px 24px}aside details{position:static;margin-bottom:20px}nav{max-height:35vh}article{padding:20px}h1{font-size:25px}}@media print{body{background:white}.layout{display:block;padding:0}aside{display:none}article{border:0;padding:12px 0}header{padding:0}a{color:inherit}pre,table{white-space:pre-wrap}}
${READING_CSS}</style></head><body><header><div class="eyebrow">有据 GROUNDS · 契约审阅</div><h1>${esc(title)}</h1><p class="lead">${sourceInfo.mode === "draft" ? `草稿审阅${sourceInfo.workspace ? ` · ${esc(sourceInfo.workspace)}` : ""}` : "已发布固定版本"} · ${issueCount} 个 Issue · 生成于 ${esc(generated)}</p><p class="scope-note">这是生成时的只读快照，反馈与确认请在对话中进行。${issueCount === 0 ? "本页仅包含 Requirement，未包含任何 Issue。" : "仅包含本页列明的契约与版本。"}${sourceInfo.external_issues_excluded ? " Workspace 的其他仓库摘要不在本次完整审阅范围内。" : ""}</p><details class="source-details"><summary>查看内容标识与完整来源范围</summary><p>${esc(digest)}</p><pre class="metadata">${esc(JSON.stringify(source, null, 2))}</pre></details></header><div class="layout"><aside><details open><summary>阅读目录</summary><nav aria-label="目录">${reading.navigation}</nav></details></aside><main>${documents}</main></div>${runtimeScript}</body></html>`;
  return { html: document, warnings };
}

export async function renderContractReview(work: Module, options: ContractOptions, workspace?: WorkspaceModule, renderHTML = contractHTML) {
  if (!["html", "markdown"].includes(options.format)) throw validation("format", "must be html or markdown");
  const collected = await collectContractReview(work, options, workspace); const generated = new Date().toISOString();
  const output = resolve(options.output);
  if (collected.snapshot && (output === collected.snapshot.path || (output.startsWith(collected.snapshot.path + sep) && output !== join(collected.snapshot.path,"previews")))) throw validation("output", "must be outside the authoring Workspace or its previews directory");
  if(collected.snapshot && output===join(collected.snapshot.path,"previews") && existsSync(output) && lstatSync(output).isSymbolicLink())throw validation("output","previews must not be a symbolic link");
  // A different Workspace is not an unrestricted export directory either.
  for(let cursor=output;cursor!==dirname(cursor);cursor=dirname(cursor))if(existsSync(join(cursor,".workspace.json"))&&output!==join(cursor,"previews"))throw validation("output","cannot export into Workspace metadata or backups");
  let temp = "";
  try {
    mkdirSync(output, { recursive: true });
    const real = realpathSync(output);
    if (collected.snapshot && (real === realpathSync(collected.snapshot.path) || (real.startsWith(realpathSync(collected.snapshot.path) + sep) && real !== join(realpathSync(collected.snapshot.path),"previews")))) throw validation("output", "must be outside the authoring Workspace or its previews directory");
    for(let cursor=real;cursor!==dirname(cursor);cursor=dirname(cursor))if(existsSync(join(cursor,".workspace.json"))&&real!==join(cursor,"previews"))throw validation("output","cannot export into Workspace metadata or backups");
    const path = join(real, `contract-${collected.digest.slice(7)}.${options.format === "html" ? "html" : "md"}`);
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw validation("output", "destination must be a regular file");
    const runtime = options.format === "html" ? pinnedRuntimeSource() : "";
    const rendered = options.format === "html" ? renderHTML(collected.sections, collected.source, collected.digest, generated, runtime) : undefined;
    const contents = options.format === "html" && rendered ? rendered.html : `# Grounds 契约审阅 · 只读派生快照\n\n${generated}\n\n${collected.digest}\n\n范围与绑定：\n\n\`\`\`json\n${JSON.stringify(collected.source, null, 2)}\n\`\`\`\n\n` + collected.sections.map(section => `# ${section.key} · ${section.state}\n\n${section.markdown}${markdownPlanFallback(section)}`).join("\n\n---\n\n");
    collected.assertConsistent();
    temp = join(real, `.contract-${randomUUID()}.tmp`); writeFileSync(temp, contents, { encoding: "utf8", flag: "wx", mode: 0o444 });
    collected.assertConsistent(); renameSync(temp, path); temp = "";
    return { result_type: "patchledger.result.contract-review/v1", command: "contract.render", format: options.format, path, content_digest: collected.digest, generated_at: generated, source: collected.source, source_paths: collected.sections.flatMap(section => section.source_path ? [section.source_path] : []), ...(rendered && rendered.warnings.length ? { warnings: rendered.warnings } : {}) };
  } catch (error) { if (temp) rmSync(temp, { force: true }); if (error instanceof DomainError) throw error; throw validation("contract.render", error instanceof Error ? error.message : String(error)); }
}

/** Locate the vendored, version-pinned mermaid build that ships with the CLI. */
export function pinnedRuntimeSource(): string {
  for (const candidate of [new URL("../vendor/mermaid.min.js", import.meta.url), new URL("../../vendor/mermaid.min.js", import.meta.url)]) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return "";
}

/** The markdown fallback carries plan under the same notice as the HTML page. */
function markdownPlanFallback(section: Section): string {
  if (section.kind !== "issue") return "";
  const plan = (section.input as IssueInput).plan;
  if (!plan) return "";
  return `\n\n## Plan\n\n${PLAN_NOTICE_TEXT}\n\n${plan}`;
}
