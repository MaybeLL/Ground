import { draftsRoot } from "./data-layout.js";
import { privateDirectory } from "./runtime-files.js";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { sha256 } from "./canonical-json.js";
import { checkContentLanguage, issueProse, requirementProse, type ContentLanguagePolicy } from "./content-language.js";
import type { Attribution, Baseline, IssueInput, RequirementInput } from "./domain.js";
import { DomainError, validation } from "./errors.js";
import { discoverRepository, matchingRemoteNames, remoteTrackingReachable, resolveBaseline, selectRemote } from "./git.js";
import { withGroundsExclude } from "./grounds-exclude.js";
import { newUUIDv7 } from "./identity.js";
import type { Module, PublishAuthoringCommand, PublishAuthoringResult, Warning } from "./module.js";
import { workspacePublicationBinding, type WorkspacePublicationBinding } from "./workspace-preflight.js";
import { collectContractReview } from "./contract-review.js";
import { validateTargetBranch } from "./target-branch.js";
import { issueInputFromRevision, parseIssueMarkdown, parseRequirementMarkdown, renderIssueMarkdown, renderRequirementMarkdown, requirementInputFromRevision, type WorkspaceIssueDraft } from "./workspace-markdown.js";
export { parseIssueMarkdown, parseRequirementMarkdown, renderIssueMarkdown, renderRequirementMarkdown } from "./workspace-markdown.js";

import { JsonWorkspaceStore, JSON_FORMAT, type JsonManifest } from "./workspace-json.js";
import { JsonPublication } from "./workspace-json-publication.js";

const FORMAT = "patchledger.authoring-workspace/v1";
interface RequirementEntry { id?: string; revision_id?: string; version?: number; require_current?: boolean; base?: RequirementInput }
interface IssueEntry { key: string; file: string; id?: string; revision_id?: string; version?: number; requirement_revision_id?: string; desired_requirement_revision_id?: string; base?: IssueInput; baseline?: Baseline }
export interface Manifest { format: string; name: string; database_id: string; repository_remote: string; requirement: RequirementEntry; issues: IssueEntry[] }
type IssueDraft = WorkspaceIssueDraft;
interface PendingPublication { format: string; operation_id: string; content_digest: string; command: PublishAuthoringCommand; requirement_input: RequirementInput; issues: { key: string; input: IssueInput; baseline: Baseline }[] }

const atomicWrite = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
};
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const same = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return sha256(left) === sha256(right);
};
const boundedRead = (path: string, limit = 2 * 1024 * 1024): string => {
  if (lstatSync(path).isSymbolicLink()) throw validation(path, "must not be a symbolic link");
  const data = readFileSync(path);
  if (data.length > limit) throw validation(path, `must not exceed ${limit / 1024 / 1024} MiB`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw validation(path, "must contain valid UTF-8"); }
};
/** Fill the draft-only Open Questions / Assumptions sections.
 * Author text is spliced by index, never through a replacement string: `$&`,
 * `` $` ``, `$'` and `$$` inside a question would otherwise be interpreted as
 * replacement patterns and copy surrounding markup into the body. */
const withDraftQuestions = (markdown: string, questions: string[], assumptions: string[]): string => {
  const fill = (source: string, heading: string, items: string[]): string => {
    if (!items.length) return source;
    const blank = `${heading}\n\n\n`;
    const at = source.indexOf(blank);
    const body = `${heading}\n\n${items.map((item) => `### ${item}`).join("\n\n")}\n\n`;
    return at < 0 ? source : source.slice(0, at) + body + source.slice(at + blank.length);
  };
  return fill(fill(markdown, "## Open Questions", questions), "## Assumptions", assumptions);
};

export class WorkspaceModule {
  readonly root: string;
  get repository(): ReturnType<typeof discoverRepository> { return discoverRepository(this.cwd); }
  private get work(): Module {
    if (!this.connectedWork) throw validation("ledger", "this operation requires an available ledger");
    return this.connectedWork;
  }
  constructor(private readonly connectedWork: Module | undefined, private readonly cwd: string, private readonly policy: "warn" | "require_override", private readonly actor: () => Attribution, private readonly databaseID: string, private readonly newId: () => string = newUUIDv7, private readonly jsonDefault = false) {
    this.root = draftsRoot(databaseID);
  }
  /** Canonical remotes to compare for Repository identity: the selected remote
   * when one is named, otherwise every remote of the clone, so resolution can
   * still bind a Repository registered over a different transport. */
  private cloneRemotes(selected?: { canonical: string }): string[] {
    return selected ? [selected.canonical] : this.repository.remotes.map((remote) => remote.canonical);
  }
  private ensureSafe(): void { privateDirectory(this.root); }
  private path(name: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw validation("workspace", "name must use letters, digits, dot, underscore, or hyphen"); const path = resolve(this.root, name); if (!path.startsWith(resolve(this.root) + sep)) throw validation("workspace", "path escapes the authoring root"); if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw validation("workspace", "must be a real directory"); return path; }
  private manifest(path: string): Manifest { let value: Manifest; try { value = JSON.parse(boundedRead(join(path, ".workspace.json"), 32 * 1024 * 1024)) as Manifest; } catch (error) { if (error instanceof DomainError) throw error; throw validation("workspace", "manifest is not valid JSON"); } if(value.format===FORMAT)boundedRead(join(path,".workspace.json")); if (![FORMAT, JSON_FORMAT].includes(value.format) || !value.requirement || !Array.isArray(value.issues) || typeof value.repository_remote !== "string") throw validation("workspace", "manifest format is not supported"); for (const issue of value.issues) if (!/^issues\/[^/\0]{1,200}\.md$/u.test(issue.file) || !/^[^/\0]{1,200}$/u.test(issue.key)) throw validation("workspace", "manifest contains an unsafe Issue path or key"); if (value.database_id !== this.databaseID) throw new DomainError("DATABASE_ID_MISMATCH", "Workspace belongs to a different Grounds database", false, { reason: "Workspace database_id does not match the configured ledger" }); return value; }
  private save(path: string, manifest: Manifest): void { if(manifest.format===JSON_FORMAT){new JsonWorkspaceStore(path).writeUnlocked(manifest as any);return;} atomicWrite(join(path, ".base", "requirement.json"), json(manifest.requirement.base ?? null)); for (const issue of manifest.issues) atomicWrite(join(path, ".base", "issues", `${issue.key}.json`), json({ input: issue.base ?? null, baseline: issue.baseline ?? null })); atomicWrite(join(path, ".workspace.json"), json(manifest)); }
  private selected(name?: string, cwd = this.cwd): string {
    if (name) { const path = this.path(name); if (!existsSync(path)) throw validation("workspace", `does not exist: ${name}`); return path; }
    const absolute = resolve(cwd); if (absolute.startsWith(resolve(this.root) + sep)) { const rel = relative(this.root, absolute).split(sep)[0]; if (rel) return this.path(rel); }
    const candidates = existsSync(this.root) ? readdirSync(this.root).filter((item) => existsSync(join(this.root, item, ".workspace.json"))) : [];
    if (candidates.length !== 1) throw validation("workspace", candidates.length ? `select one Workspace: ${candidates.join(", ")}` : "no authoring Workspace exists"); return this.path(candidates[0]);
  }
  private selectedForPublish(name: string | undefined, cwd: string): string {
    const absolute = resolve(cwd); if (name || absolute.startsWith(resolve(this.root) + sep)) return this.selected(name, cwd);
    const candidates = existsSync(this.root) ? readdirSync(this.root).filter((item) => existsSync(join(this.root, item, ".workspace.json"))) : [];
    const dirty = candidates.filter((item) => this.describe(this.path(item)).state !== "clean"); if (dirty.length === 1) return this.path(dirty[0]);
    if (dirty.length > 1) throw validation("workspace", `select one changed Workspace: ${dirty.join(", ")}`); return this.selected(name, cwd);
  }
  /** Legacy Markdown cannot distinguish a plan section from a `## Plan` line
   * inside existing Context prose, so it never carries one. Refuse before any
   * write rather than silently dropping or re-splitting the sealed text. */
  private assertMarkdownCarriesNoPlan(inputs: Array<{ label: string; input: IssueInput }>, action: "open" | "rebase"): void {
    const carrying = inputs.filter((item) => item.input.plan !== undefined && item.input.plan !== "");
    if (!carrying.length) return;
    const where = carrying.map((item) => item.label).join(", ");
    throw validation("workspace", action === "rebase"
      ? `Issue Version(s) ${where} carry a plan, which legacy Markdown cannot represent; migrate the workspace with \`workspace migrate\` and use the JSON format`
      : `Issue Version(s) ${where} carry a plan, which legacy Markdown cannot represent; use the default JSON workspace format`);
  }



  private create(name: string, manifest: Manifest): string { this.ensureSafe(); const path = this.path(name); if (existsSync(path)) throw validation("workspace", `already exists: ${name}`); if(manifest.format===JSON_FORMAT)mkdirSync(path,{mode:0o700});else mkdirSync(join(path, "issues"), { recursive: true }); this.save(path, manifest); return path; }
  async new(name = `draft-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`, remote = "", language?: ContentLanguagePolicy): Promise<unknown> {
    let canonical = "";
    try { canonical = selectRemote(this.repository, remote).canonical; }
    catch (error) {
      if (remote || !(error instanceof DomainError) || error.code !== "REPOSITORY_NOT_RESOLVED") throw error;
    }
    const requirement: RequirementInput = language?.language === "zh-CN"
      ? { format: 1, summary: "描述需求", outcomes: ["描述可观察的业务结果"] }
      : { format: 1, summary: "Describe the requirement", outcomes: ["Describe an observable outcome"] };
    const issue: IssueInput = language?.language === "zh-CN"
      ? { format: 1, summary: "实现需求", goals: [{ statement: "交付所需变更", criteria: ["预期行为可以独立验证"], traces_to: [{ type: "outcome", ordinal: 1 }] }] }
      : { format: 1, summary: "Implement the requirement", goals: [{ statement: "Deliver the change", criteria: ["The expected behavior is observable"], traces_to: [{ type: "outcome", ordinal: 1 }] }] };
    const manifest: Manifest = { format: FORMAT, name, database_id: this.databaseID, repository_remote: canonical, requirement: { require_current: true }, issues: [{ key: "main", file: "issues/main.md" }] };
    if(this.jsonDefault)Object.assign(manifest,{format:JSON_FORMAT,revision:1,draft:{requirement,issues:[{key:"main",input:issue,baselineExpression:"HEAD",questions:[],assumptions:[]}]}});
    const path = this.create(name, manifest);
    if(this.jsonDefault)return {result_type:"patchledger.result.workspace/v1",command:"workspace.new",name,path,state:"draft"};
    const requirementTemplate = renderRequirementMarkdown(requirement)
      .replace("## Decisions\n\n\n", "## Decisions\n\n<!-- Optional: one `### [decision-N] Decision` heading per decision; add `#### Rationale` and `#### Context` when useful. Structured options/chosen_option/trade_offs/consequences go in one YAML code block under `#### Details`. -->\n\n")
      .replace("## Open Questions\n\n\n", "## Open Questions\n\n<!-- Optional: `### [blocking] Question` or `### [non-blocking] Question`, with optional `#### Assumption`. -->\n");
    const issueTemplate = renderIssueMarkdown(issue, "HEAD")
      .replace("## Constraints\n\n\n", "## Constraints\n\n<!-- Optional: one `### Constraint` heading with a `#### Criteria` bullet list. -->\n\n")
      .replace("## Open Questions\n\n\n\n", "## Open Questions\n\n<!-- Draft only: one `### Question` heading per unresolved item. Remove before publish. -->\n\n")
      .replace("## Assumptions\n\n\n", "## Assumptions\n\n<!-- Draft only: one `### Assumption` heading per provisional assumption. Remove before publish. -->\n");
    atomicWrite(join(path, "requirement.md"), requirementTemplate); atomicWrite(join(path, "issues/main.md"), issueTemplate);
    return { result_type: "patchledger.result.workspace/v1", command: "workspace.new", name, path, state: "draft" };
  }
  async openRequirement(requirementID: string, name = "", remote = ""): Promise<unknown> {
    const selected = selectRemote(this.repository, remote); const detail = await this.work.loadRequirement(requirementID); const workspaceName = name || `requirement-${requirementID.slice(0, 8)}`;
    const input = requirementInputFromRevision(detail.requirement_revision); const issues: IssueEntry[] = [];
    // Which Issues are editable is decided by Repository identity (the clone's
    // resolved Repository id), not by comparing canonical URL strings, so a
    // clone bound over a different transport still owns them.
    const cloneRepositoryId = (await this.work.resolveRepository(this.cloneRemotes(selected))).id;
    const editable = (repositoryId: string): boolean => repositoryId === cloneRepositoryId;
    for (const summary of detail.issues.filter((item) => editable(item.repository.id))) { const issue = await this.work.loadIssue(summary.issue_id); const value = issueInputFromRevision(issue.issue_revision); issues.push({ key: summary.issue_id, file: `issues/${summary.issue_id}.md`, id: summary.issue_id, revision_id: issue.issue_revision.id, version: issue.issue_revision.revision_number, requirement_revision_id: issue.issue_revision.requirement_revision_id, base: value, baseline: issue.baseline }); }
    const manifest: Manifest = { format: FORMAT, name: workspaceName, database_id: this.databaseID, repository_remote: selected.canonical, requirement: { id: requirementID, revision_id: detail.requirement_revision.id, version: detail.requirement_revision.revision_number, require_current: true, base: input }, issues };
    const externalJSON=detail.issues.filter(item=>!editable(item.repository.id));
    if(this.jsonDefault)Object.assign(manifest,{format:JSON_FORMAT,revision:1,draft:{requirement:input,issues:issues.map(e=>({key:e.key,input:e.base!,baselineExpression:e.baseline!.git_oid,questions:[],assumptions:[]}))},...(externalJSON.length?{external_issues:externalJSON.map(e=>`${e.current_issue_revision.summary} (${e.issue_id}) — ${e.repository.canonical_remote}`).join("\n")}:{})});
    if(!this.jsonDefault)this.assertMarkdownCarriesNoPlan(issues.map((entry)=>({label:`${entry.id}@${entry.version}`,input:entry.base!})),"open");
    const path = this.create(workspaceName, manifest);
    if(this.jsonDefault)return {result_type:"patchledger.result.workspace/v1",command:"workspace.open",name:workspaceName,path,state:"clean",editable_issues:issues.length,readonly_external_issues:externalJSON.length};
    atomicWrite(join(path, "requirement.md"), renderRequirementMarkdown(input, requirementID, detail.requirement_revision.revision_number)); for (const issue of issues) atomicWrite(join(path, issue.file), renderIssueMarkdown(issue.base!, issue.baseline!.git_oid, issue.id, issue.version));
    const external = detail.issues.filter((item) => !editable(item.repository.id)); if (external.length) { const summaryPath = join(path, "external-issues.md"); atomicWrite(summaryPath, `# Issues in other Repositories\n\n${external.map((item) => `- ${item.current_issue_revision.summary} (${item.issue_id}) — ${item.repository.canonical_remote}`).join("\n")}\n`); chmodSync(summaryPath, 0o444); atomicWrite(join(path, ".base", "external-issues.json"), json(external)); } this.save(path, manifest);
    return { result_type: "patchledger.result.workspace/v1", command: "workspace.open", name: workspaceName, path, state: "clean", editable_issues: issues.length, readonly_external_issues: external.length };
  }
  async openIssue(issueID: string, name = "", bind: "preserve" | "current" = "preserve", remote = ""): Promise<unknown> {
    const issue = await this.work.loadIssue(issueID); const cloneRemote = remote ? selectRemote(this.repository, remote).canonical : selectRemote(this.repository).canonical; const matches = await this.work.remotesBelongToRepository(issue.repository.id, this.cloneRemotes(remote ? selectRemote(this.repository, remote) : undefined)); if (!matches) throw validation("workspace", "current clone or selected remote does not match the Issue Repository");
    const requirementID = issue.requirement_revision.requirement_id; const requirementDetail = bind === "current" ? await this.work.loadRequirement(requirementID) : undefined; const requirementRevision = requirementDetail?.requirement_revision ?? issue.requirement_revision; const requirement = requirementInputFromRevision(requirementRevision); const issueInput = issueInputFromRevision(issue.issue_revision); const workspaceName = name || `issue-${issueID.slice(0, 8)}`;
    const entry: IssueEntry = { key: issueID, file: `issues/${issueID}.md`, id: issueID, revision_id: issue.issue_revision.id, version: issue.issue_revision.revision_number, requirement_revision_id: issue.issue_revision.requirement_revision_id, ...(bind === "current" && requirementRevision.id !== issue.issue_revision.requirement_revision_id ? { desired_requirement_revision_id: requirementRevision.id } : {}), base: issueInput, baseline: issue.baseline };
    const manifest: Manifest = { format: FORMAT, name: workspaceName, database_id: this.databaseID, repository_remote: issue.repository.canonical_remote, requirement: { id: requirementID, revision_id: requirementRevision.id, version: requirementRevision.revision_number, require_current: bind === "current", base: requirement }, issues: [entry] };
    if(this.jsonDefault)Object.assign(manifest,{format:JSON_FORMAT,revision:1,draft:{requirement,issues:[{key:entry.key,input:issueInput,baselineExpression:issue.baseline.git_oid,questions:[],assumptions:[]}]}});
    if(!this.jsonDefault)this.assertMarkdownCarriesNoPlan([{label:`${issueID}@${entry.version}`,input:issueInput}],"open");
    const path = this.create(workspaceName, manifest);
    if(this.jsonDefault)return {result_type:"patchledger.result.workspace/v1",command:"workspace.open",name:workspaceName,path,state:"clean",binding:bind};
    atomicWrite(join(path, "requirement.md"), renderRequirementMarkdown(requirement, requirementID, requirementRevision.revision_number)); atomicWrite(join(path, entry.file), renderIssueMarkdown(issueInput, issue.baseline.git_oid, issueID, entry.version)); this.save(path, manifest);
    return { result_type: "patchledger.result.workspace/v1", command: "workspace.open", name: workspaceName, path, state: "clean", binding: bind };
  }
  list(): unknown { const resources = existsSync(this.root) ? readdirSync(this.root).filter((name) => existsSync(join(this.root, name, ".workspace.json"))).map((name) => this.describe(this.path(name))) : []; return { result_type: "patchledger.result.workspace-list/v1", command: "workspace.list", resources }; }
  show(name?: string, cwd?: string): unknown { return { result_type: "patchledger.result.workspace-detail/v1", command: "workspace.show", ...this.describe(this.selected(name, cwd)) }; }
  private async publicPublication(result: PublishAuthoringResult, name: string, path: string, recovered = false): Promise<unknown> {
    const issues = [] as unknown[];
    for (const issue of result.issues) {
      const bindingVersion = issue.requirement_revision_id === result.requirement.revision_id
        ? result.requirement.version
        : (await this.work.contractRequirement(result.requirement.id, undefined, issue.requirement_revision_id)).revision_number;
      issues.push({ action: issue.action, id: issue.id, version: issue.version, requirement: { id: result.requirement.id, version: bindingVersion }, baseline: issue.baseline });
    }
    return { result_type: "patchledger.result.workspace-publish/v1", command: "workspace.publish", repository_id: result.repository_id, repository_action: result.repository_action, requirement: { action: result.requirement.action, id: result.requirement.id, version: result.requirement.version }, issues, name, path, ...(recovered ? { recovered: true } : {}) };
  }
  private describe(path: string): Record<string, unknown> { const manifest = this.manifest(path); if(manifest.format===JSON_FORMAT){const snap=new JsonWorkspaceStore(path).read();return {name:manifest.name,path,state:existsSync(join(path,".pending-publication.json"))?"publishing":snap.manifest.conflicts?.length?"conflicted":same(snap.draft.requirement,manifest.requirement.base)&&snap.draft.issues.every(d=>{const e=manifest.issues.find(x=>x.key===d.key);return same(d.input,e?.base)&&d.baselineExpression===e?.baseline?.git_oid;})?"clean":"draft",version:snap.version,requirement_id:manifest.requirement.id,issue_count:snap.draft.issues.length};} let state = "clean"; let issueCount = manifest.issues.length; try { const req = parseRequirementMarkdown(boundedRead(join(path, "requirement.md")), "requirement.md"); if (!manifest.requirement.base || !same(req.input, manifest.requirement.base)) state = "draft"; const diskFiles = readdirSync(join(path, "issues")).filter((file) => file.endsWith(".md")).map((file) => `issues/${file}`); issueCount = diskFiles.length; if (diskFiles.some((file) => !manifest.issues.some((item) => item.file === file))) state = "draft"; for (const issue of manifest.issues) { let file = issue.file; if (!existsSync(join(path, file)) && issue.id) file = diskFiles.find((candidate) => parseIssueMarkdown(boundedRead(join(path, candidate)), candidate).frontmatter.id === issue.id) ?? file; if (!existsSync(join(path, file))) { if (issue.id) state = "recoverable_failure"; continue; } const draft = parseIssueMarkdown(boundedRead(join(path, file)), file); if (file !== issue.file || !issue.base || !same(draft.input, issue.base) || draft.baselineExpression !== issue.baseline?.git_oid || (issue.desired_requirement_revision_id !== undefined && issue.desired_requirement_revision_id !== issue.requirement_revision_id)) state = "draft"; } if (existsSync(join(path, ".pending-publication.json"))) state = "publishing"; } catch (error) { const reason = error instanceof DomainError ? String(error.details.reason ?? "") : ""; state = reason.includes("conflict") ? "conflicted" : "recoverable_failure"; } return { name: manifest.name, path, state, requirement_id: manifest.requirement.id, issue_count: issueCount }; }
  /** Read-only, exact byte snapshot. No publish gates or Workspace mutation. */
  reviewSnapshot(name: string): { path: string; manifest: Manifest; files: Record<string, string>; version?: string } {
    try {
    const path = this.path(name); let manifest = this.manifest(path);
    if(manifest.format===JSON_FORMAT){const snap=new JsonWorkspaceStore(path).read();manifest=snap.manifest;const files:Record<string,string>={".workspace.json":JSON.stringify(manifest),"requirement.md":renderRequirementMarkdown(snap.draft.requirement,manifest.requirement.id,manifest.requirement.version)};for(const d of snap.draft.issues){const entry=manifest.issues.find(e=>e.key===d.key);files[entry?.file??`issues/${d.key}.md`]=withDraftQuestions(renderIssueMarkdown(d.input,d.baselineExpression,entry?.id,entry?.version), d.questions, d.assumptions);}if(snap.manifest.external_issues)files["external-issues.md"]=snap.manifest.external_issues;return {path,manifest,files,version:snap.version};}
    const directory = join(path, "issues");
    if (lstatSync(directory).isSymbolicLink()) throw validation(directory, "must not be a symbolic link");
    const names = [".workspace.json", "requirement.md", ...readdirSync(directory).filter(file => file.endsWith(".md")).sort().map(file => `issues/${file}`)];
    if (existsSync(join(path, "external-issues.md"))) names.push("external-issues.md");
    const files = Object.fromEntries(names.map(file => [file, boundedRead(join(path, file))]));
    if (JSON.stringify(JSON.parse(files[".workspace.json"])) !== JSON.stringify(manifest)) throw validation(path, "Workspace changed during snapshot; retry");
    return { path, manifest, files };
    } catch (error) { if (error instanceof DomainError) throw error; throw validation("workspace", `cannot read complete Workspace ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async pendingPublishBinding(name: string | undefined, cwd: string, expectedVersion = ""): Promise<WorkspacePublicationBinding | undefined> {
    const path = this.selectedForPublish(name, cwd);
    const manifest = this.manifest(path);
    const reviewed = await collectContractReview(this.work, { workspace: manifest.name, issues: [], output: "", format: "html" }, this);
    if (!reviewed.snapshot) throw validation("workspace", "publication source snapshot is unavailable");
    return workspacePublicationBinding(reviewed.snapshot, this.repository.root, expectedVersion);
  }

  async publish(name: string | undefined, cwd: string, dryRun: boolean, allowUnpublished: boolean, allowSecondIssuePerRepository = false, overrideReason = "", language?: ContentLanguagePolicy, expectedVersion = ""): Promise<{ result: unknown; warnings: Warning[] }> {
    const path = this.selectedForPublish(name, cwd); const manifest = this.manifest(path); if (!manifest.repository_remote) throw validation("draft", "bind a Repository with draft bind before publishing"); if(manifest.format===JSON_FORMAT){if(!name)throw validation("workspace","explicit name required for JSON publication");return new JsonPublication(this.work,path,this.repository.root,this.policy,this.actor).publish(expectedVersion,dryRun,allowUnpublished,allowSecondIssuePerRepository,overrideReason,language);} const requirementDraft = parseRequirementMarkdown(boundedRead(join(path, "requirement.md")), "requirement.md");
    if (requirementDraft.frontmatter.id !== manifest.requirement.id || requirementDraft.frontmatter.version !== manifest.requirement.version) throw validation("requirement.md.frontmatter", "managed id or version was edited");
    const diskFiles = readdirSync(join(path, "issues")).filter((file) => file.endsWith(".md")).map((file) => `issues/${file}`); const claimed = new Set<string>(); const identities = new Set<string>(); let manifestChanged = false;
    const retained = manifest.issues.filter((entry) => entry.id || diskFiles.includes(entry.file)); if (retained.length !== manifest.issues.length) { manifest.issues = retained; manifestChanged = true; }
    for (const entry of manifest.issues) {
      let candidate = diskFiles.includes(entry.file) ? entry.file : undefined;
      if (entry.id) {
        const matches = diskFiles.filter((file) => parseIssueMarkdown(boundedRead(join(path, file)), file).frontmatter.id === entry.id);
        if (matches.length > 1) throw validation("issues", `duplicate managed Issue id: ${entry.id}`);
        if (matches.length === 1) candidate = matches[0];
      }
      if (candidate) { if (entry.file !== candidate) manifestChanged = true; entry.file = candidate; claimed.add(candidate); }
    }
    for (const file of diskFiles.filter((candidate) => !claimed.has(candidate))) { const draft = parseIssueMarkdown(boundedRead(join(path, file)), file); if (draft.frontmatter.id) throw validation(`${file}.frontmatter`, "contains an id that is not owned by this Workspace"); let key = basename(file, ".md"); while (manifest.issues.some((item) => item.key === key)) key += "-copy"; manifest.issues.push({ key, file }); manifestChanged = true; }
    for (const entry of manifest.issues) if (entry.id) { if (identities.has(entry.id)) throw validation("issues", `duplicate managed Issue id: ${entry.id}`); identities.add(entry.id); }
    const requirementChanged = !manifest.requirement.base || !same(requirementDraft.input, manifest.requirement.base); const changes = [] as { entry: IssueEntry; draft: IssueDraft; baseline: Baseline }[];
    for (const entry of manifest.issues) {
      const file = join(path, entry.file); if (!existsSync(file)) { if (entry.id) throw validation(entry.file, "published Issue file is missing"); continue; }
      const draft = parseIssueMarkdown(boundedRead(file), entry.file);
      if (draft.input.target_branch) validateTargetBranch(this.repository.root, draft.input.target_branch, await this.work.repositoryRemotesForResolution(manifest.repository_remote));
      if (draft.frontmatter.id !== entry.id || draft.frontmatter.version !== entry.version) throw validation(`${entry.file}.frontmatter`, "managed id or version was edited");
      if (!entry.base || !same(draft.input, entry.base) || draft.baselineExpression !== entry.baseline?.git_oid || (entry.desired_requirement_revision_id !== undefined && entry.desired_requirement_revision_id !== entry.requirement_revision_id)) {
        if (draft.questions.length || draft.assumptions.length) throw validation(entry.file, "remove or resolve every Open Question and Assumption before publish");
        const oid = resolveBaseline(this.repository.root, draft.baselineExpression); const remoteNames = matchingRemoteNames(this.repository, await this.work.repositoryRemotesForResolution(manifest.repository_remote)); const reachable = remoteTrackingReachable(this.repository.root, oid, remoteNames);
        const trackingRefs = remoteNames.length ? remoteNames.map((name) => `refs/remotes/${name}/*`).join(", ") : "the selected remote-tracking refs";
        const reachabilityMessage = `baseline is not reachable from ${trackingRefs}; fetch or publish the commit before sharing it. This does not block a local DevRun.`;
        if (!reachable && this.policy === "require_override" && !allowUnpublished) throw new DomainError("BASELINE_UNAVAILABLE", "baseline is not available under the configured reachability policy", false, { reason: `${reachabilityMessage} Pass --allow-unpublished-baseline with --override-reason to accept it explicitly.` });
        if (!reachable && allowUnpublished && !overrideReason.trim()) throw validation("override-reason", "is required for an unpublished baseline override");
        changes.push({ entry, draft, baseline: reachable ? { git_oid: oid, reachability: "remote_tracking_reachable" } : { git_oid: oid, reachability: "unconfirmed", warning: reachabilityMessage, ...(overrideReason.trim() ? { override_reason: overrideReason.trim() } : {}) } });
      }
    }
    const languageWarnings = checkContentLanguage([
      ...(requirementChanged ? requirementProse(requirementDraft.input, "requirement.md") : []),
      ...changes.flatMap(({ entry, draft }) => issueProse(draft.input, entry.file)),
    ], language);
    if (manifest.requirement.id && (manifest.requirement.require_current ?? true) && (requirementChanged || changes.length)) { const current = await this.work.currentRequirementRevision(manifest.requirement.id); if (current.id !== manifest.requirement.revision_id) throw validation("workspace", "Requirement source Version is stale; run workspace rebase"); }
    for (const { entry } of changes) if (entry.id) { const current = await this.work.currentIssueRevision(entry.id); if (current.id !== entry.revision_id) throw validation(entry.file, "Issue source Version is stale; run workspace rebase"); }
    const pendingPath = join(path, ".pending-publication.json"); let pending = existsSync(pendingPath) ? JSON.parse(boundedRead(pendingPath)) as PendingPublication : undefined;
    if (!requirementChanged && !changes.length) { if (pending && !dryRun) { const completed = await this.work.completedAuthoringOperation(pending.operation_id); if (completed) { atomicWrite(join(path, "receipt.json"), json({ operation_id: pending.operation_id, content_digest: pending.content_digest, result: completed.result })); rmSync(pendingPath, { force: true }); return { result: await this.publicPublication(completed.result, manifest.name, path, true), warnings: completed.warnings }; } rmSync(pendingPath, { force: true }); } if (manifestChanged && !dryRun) this.save(path, manifest); return { result: { result_type: "patchledger.result.workspace-publish/v1", command: "workspace.publish", name: manifest.name, dry_run: dryRun, no_op: true }, warnings: [] }; }
    const contentDigest = sha256({ requirement: requirementDraft.input, issues: changes.map(({ entry, draft, baseline }) => ({ key: entry.key, input: draft.input, baseline })), allow_second_issue_per_repository: allowSecondIssuePerRepository, repository_issue_override_reason: overrideReason.trim() });
    const targetRequirementVersion = requirementChanged ? (manifest.requirement.version ?? 0) + 1 : manifest.requirement.version ?? 1;
    const plannedIssues = [] as { id?: string; action: "create" | "revise"; version: number; requirement: { id?: string; version: number } }[];
    for (const { entry } of changes) {
      let bindingVersion = targetRequirementVersion;
      if (!requirementChanged && manifest.requirement.id) {
        const bindingID = entry.desired_requirement_revision_id || entry.requirement_revision_id || manifest.requirement.revision_id;
        const bound = bindingID
          ? await this.work.contractRequirement(manifest.requirement.id, undefined, bindingID)
          : await this.work.currentRequirementRevision(manifest.requirement.id);
        if ((bound.open_questions ?? []).some((question) => question.blocking)) throw validation("requirement.open_questions", "the Requirement Version bound by an Issue contains a blocking Open Question");
        bindingVersion = bound.revision_number;
      } else if ((requirementDraft.input.open_questions ?? []).some((question) => question.blocking)) throw validation("requirement.open_questions", "the Requirement Version bound by an Issue contains a blocking Open Question");
      plannedIssues.push({ ...(entry.id ? { id: entry.id } : {}), action: entry.id ? "revise" : "create", version: (entry.version ?? 0) + 1, requirement: { ...(manifest.requirement.id ? { id: manifest.requirement.id } : {}), version: bindingVersion } });
    }
    if (dryRun) return { result: { result_type: "patchledger.result.workspace-plan/v1", command: "workspace.publish", name: manifest.name, dry_run: true, requirement: { action: requirementChanged ? (manifest.requirement.id ? "revise" : "create") : "unchanged", ...(manifest.requirement.id ? { id: manifest.requirement.id } : {}), version: targetRequirementVersion }, issues: plannedIssues }, warnings: [...languageWarnings, ...await this.work.preflightIssueRepositoryRule({ requirement_id: manifest.requirement.id, canonical_remote: manifest.repository_remote, created_issue_count: changes.filter(({ entry }) => !entry.id).length, allow_second_issue_per_repository: allowSecondIssuePerRepository, override_reason: overrideReason })] };
    if (pending && pending.content_digest !== contentDigest) {
      const completed = await this.work.completedAuthoringOperation(pending.operation_id);
      if (completed) {
        const drafts = new Map<string, string>([["requirement.md", boundedRead(join(path, "requirement.md"))], ...manifest.issues.filter((item) => existsSync(join(path, item.file))).map((item) => [item.file, boundedRead(join(path, item.file))] as [string, string])]);
        const recoveredChanges = pending.issues.map((item) => { const entry = manifest.issues.find((candidate) => candidate.key === item.key); if (!entry) throw validation("workspace", "pending publication refers to an unknown Issue"); return { entry, draft: { input: item.input } as IssueDraft, baseline: item.baseline }; });
        this.applyResult(path, manifest, pending.requirement_input, recoveredChanges, completed.result); for (const [file, text] of drafts) atomicWrite(join(path, file), text); rmSync(pendingPath, { force: true });
        return this.publish(manifest.name, cwd, false, allowUnpublished, allowSecondIssuePerRepository, overrideReason, language);
      }
      rmSync(pendingPath, { force: true }); pending = undefined;
    }
    const operationID = pending?.operation_id ?? this.newId();
    const publishCommand: PublishAuthoringCommand = pending?.command ?? { operation_id: operationID, canonical_remote: manifest.repository_remote, requirement: { ...(manifest.requirement.id ? { requirement_id: manifest.requirement.id, expected_revision_id: manifest.requirement.revision_id, require_current: manifest.requirement.require_current ?? true } : {}), ...(requirementChanged ? { input: requirementDraft.input } : {}) }, issues: changes.map(({ entry, draft, baseline }) => ({ ...(entry.id ? { issue_id: entry.id, expected_revision_id: entry.revision_id } : {}), ...((entry.desired_requirement_revision_id || entry.requirement_revision_id) && !requirementChanged ? { requirement_revision_id: entry.desired_requirement_revision_id || entry.requirement_revision_id } : {}), baseline, input: draft.input })), attribution: this.actor(), ...(allowSecondIssuePerRepository ? { allow_second_issue_per_repository: true } : {}), ...(overrideReason.trim() ? { repository_issue_override_reason: overrideReason.trim() } : {}) };
    if (!pending) atomicWrite(pendingPath, json({ format: "patchledger.pending-publication/v1", operation_id: operationID, content_digest: contentDigest, command: publishCommand, requirement_input: requirementDraft.input, issues: changes.map(({ entry, draft, baseline }) => ({ key: entry.key, input: draft.input, baseline })) } satisfies PendingPublication));
    const published = await this.work.publishAuthoring(publishCommand);
    this.applyResult(path, manifest, requirementDraft.input, changes, published.result); atomicWrite(join(path, "receipt.json"), json({ operation_id: operationID, content_digest: contentDigest, result: published.result })); rmSync(join(path, ".pending-publication.json"), { force: true });
    return { result: await this.publicPublication(published.result, manifest.name, path), warnings: [...published.warnings, ...languageWarnings] };
  }
  private applyResult(path: string, manifest: Manifest, requirement: RequirementInput, changes: { entry: IssueEntry; draft: IssueDraft; baseline: Baseline }[], result: PublishAuthoringResult): void {
    manifest.requirement = { id: result.requirement.id, revision_id: result.requirement.revision_id, version: result.requirement.version, require_current: manifest.requirement.require_current ?? true, base: requirement }; atomicWrite(join(path, "requirement.md"), renderRequirementMarkdown(requirement, result.requirement.id, result.requirement.version));
    result.issues.forEach((published, index) => { const change = changes[index]; change.entry.id = published.id; change.entry.revision_id = published.revision_id; change.entry.version = published.version; change.entry.requirement_revision_id = published.requirement_revision_id; delete change.entry.desired_requirement_revision_id; change.entry.base = change.draft.input; change.entry.baseline = published.baseline; atomicWrite(join(path, change.entry.file), renderIssueMarkdown(change.draft.input, published.baseline!.git_oid, published.id, published.version)); }); this.save(path, manifest);
  }
  async rebase(name: string | undefined, cwd: string): Promise<unknown> {
    const path = this.selected(name, cwd); const manifest = this.manifest(path); if(manifest.format===JSON_FORMAT)return new JsonPublication(this.work,path,this.repository.root,this.policy,this.actor).rebase(); if (!manifest.requirement.id) throw validation("workspace", "an unpublished Workspace has no authoritative version to rebase");
    // Refuse before ANY write: the legacy rebase rewrites requirement.md ahead of
    // its Issue loop, so a later check would leave a half-rebased workspace.
    for (const entry of manifest.issues.filter((item) => item.id)) { const latestIssue = await this.work.loadIssue(entry.id!); if (latestIssue.issue_revision.plan !== undefined && latestIssue.issue_revision.plan !== "") this.assertMarkdownCarriesNoPlan([{ label: `${entry.id}@${latestIssue.issue_revision.revision_number}`, input: issueInputFromRevision(latestIssue.issue_revision) }], "rebase"); }
    const conflicts: string[] = []; let changed = false; const latest = await this.work.loadRequirement(manifest.requirement.id);
    if (latest.requirement_revision.id !== manifest.requirement.revision_id) {
      changed = true; const local = parseRequirementMarkdown(boundedRead(join(path, "requirement.md"))).input; const remote = requirementInputFromRevision(latest.requirement_revision); const base = manifest.requirement.base!; const merged = { ...remote } as RequirementInput; const localConflicts: string[] = [];
      for (const key of ["summary", "context", "outcomes", "decisions", "open_questions"] as const) { const localChanged = !same(local[key], base[key]); const remoteChanged = !same(remote[key], base[key]); if (localChanged && remoteChanged && !same(local[key], remote[key])) localConflicts.push(key); else if (localChanged) (merged as any)[key] = local[key]; }
      if (localConflicts.length) { conflicts.push(...localConflicts.map((item) => `requirement.${item}`)); atomicWrite(join(path, "requirement.md"), `<<<<<<< LOCAL\n${renderRequirementMarkdown(local, manifest.requirement.id, manifest.requirement.version)}=======\n${renderRequirementMarkdown(remote, manifest.requirement.id, latest.requirement_revision.revision_number)}>>>>>>> REMOTE\n`); }
      else atomicWrite(join(path, "requirement.md"), renderRequirementMarkdown(merged, manifest.requirement.id, latest.requirement_revision.revision_number));
      manifest.requirement = { id: manifest.requirement.id, revision_id: latest.requirement_revision.id, version: latest.requirement_revision.revision_number, base: remote };
    }
    for (const entry of manifest.issues.filter((item) => item.id)) {
      const latestIssue = await this.work.loadIssue(entry.id!); if (latestIssue.issue_revision.id === entry.revision_id) continue; changed = true;
      if (!existsSync(join(path, entry.file))) { conflicts.push(`${entry.file}.missing`); continue; }
      const localDraft = parseIssueMarkdown(boundedRead(join(path, entry.file)), entry.file); const local = localDraft.input; const remote = issueInputFromRevision(latestIssue.issue_revision); const base = entry.base!; const merged = { ...remote } as IssueInput; const localConflicts: string[] = [];
      for (const key of ["summary", "context", "target_branch", "goals", "constraints"] as const) { const localChanged = !same(local[key], base[key]); const remoteChanged = !same(remote[key], base[key]); if (localChanged && remoteChanged && !same(local[key], remote[key])) localConflicts.push(key); else if (localChanged) (merged as any)[key] = local[key]; }
      const localBaselineChanged = localDraft.baselineExpression !== entry.baseline?.git_oid; const remoteBaselineChanged = latestIssue.baseline.git_oid !== entry.baseline?.git_oid; if (localBaselineChanged && remoteBaselineChanged && localDraft.baselineExpression !== latestIssue.baseline.git_oid) localConflicts.push("baseline"); const mergedBaseline = localBaselineChanged && !remoteBaselineChanged ? localDraft.baselineExpression : latestIssue.baseline.git_oid;
      if (localConflicts.length) { conflicts.push(...localConflicts.map((item) => `${entry.file}.${item}`)); atomicWrite(join(path, entry.file), `<<<<<<< LOCAL\n${renderIssueMarkdown(local, localDraft.baselineExpression, entry.id, entry.version)}=======\n${renderIssueMarkdown(remote, latestIssue.baseline.git_oid, entry.id, latestIssue.issue_revision.revision_number)}>>>>>>> REMOTE\n`); }
      else atomicWrite(join(path, entry.file), renderIssueMarkdown(merged, mergedBaseline, entry.id, latestIssue.issue_revision.revision_number));
      entry.revision_id = latestIssue.issue_revision.id; entry.version = latestIssue.issue_revision.revision_number; entry.requirement_revision_id = latestIssue.issue_revision.requirement_revision_id; entry.base = remote; entry.baseline = latestIssue.baseline;
    }
    this.save(path, manifest); return { result_type: "patchledger.result.workspace-rebase/v1", command: "workspace.rebase", name: manifest.name, ...(changed ? { state: conflicts.length ? "conflicted" : "draft", conflicts } : { no_op: true }) };
  }
  async abandonPublication(name:string, expectedVersion:string):Promise<unknown>{const path=this.selected(name);return new JsonPublication(this.work,path,this.repository.root,this.policy,this.actor).abandon(expectedVersion);}
  remove(name: string | undefined, cwd: string, discard: boolean): unknown { const path = this.selected(name, cwd);
    if(this.manifest(path).format===JSON_FORMAT)return new JsonWorkspaceStore(path).withLock(async()=>{
      if(existsSync(join(path,".pending-publication.json")))throw validation("workspace","recover pending publication before removing Workspace");
      const detail=this.describe(path);if(detail.state!=="clean"&&!discard)throw validation("workspace","contains unpublished or unresolved changes; pass --discard-changes");
      rmSync(path,{recursive:true,force:true});return {result_type:"patchledger.result.workspace-remove/v1",command:"workspace.remove",name:basename(path),removed:true};
    });
    const detail = this.describe(path); if (detail.state !== "clean" && !discard) throw validation("workspace", "contains unpublished or unresolved changes; pass --discard-changes"); rmSync(path, { recursive: true, force: true }); return { result_type: "patchledger.result.workspace-remove/v1", command: "workspace.remove", name: basename(path), removed: true }; }
}
