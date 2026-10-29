import { sha256 } from "./canonical-json.js";
import { resolveBaseline } from "./git.js";
import { validation } from "./errors.js";
import type { IssueInput, RequirementInput, TargetBranch } from "./domain.js";
import { JSON_FORMAT, type JsonManifest } from "./workspace-json.js";
import { parseIssueMarkdown, parseRequirementMarkdown } from "./workspace-markdown.js";
import { contentDigestFor, publishAuthoringBinding } from "./preflight-bindings.js";
import type { WorkspaceModule } from "./workspace.js";

export interface WorkspacePublicationBinding {
  canonical_remote: string;
  content_digest: string;
  reviewed_version?: string;
  targets: TargetBranch[];
  target: TargetBranch;
  definition_commit?: string;
}
type Snapshot = ReturnType<WorkspaceModule["reviewSnapshot"]>;
type Entry = Snapshot["manifest"]["issues"][number];
interface Draft { input: IssueInput; baselineExpression: string; entry: Entry }
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && sha256(a) === sha256(b);

function markdownDrafts(snapshot: Snapshot): Draft[] {
  const files = Object.entries(snapshot.files).filter(([name]) => name.startsWith("issues/")).map(([file, text]) => ({ file, draft: parseIssueMarkdown(text, file) }));
  const known = snapshot.manifest.issues.flatMap(entry => {
    const matches = files.filter(item => entry.id ? item.draft.frontmatter.id === entry.id : item.file === entry.file);
    if (matches.length > 1 || (entry.id && !matches.length)) throw validation("issues", "managed Issue source is missing or duplicated");
    return matches.map(item => ({ ...item.draft, entry }));
  });
  const extra = files.filter(item => !snapshot.manifest.issues.some(entry => entry.id ? item.draft.frontmatter.id === entry.id : item.file === entry.file));
  return [...known, ...extra.map(item => {
    if (item.draft.frontmatter.id) throw validation("issues", "unowned Issue identity in Workspace");
    return { ...item.draft, entry: { key: item.file, file: item.file } };
  })];
}

export function workspacePublicationBinding(snapshot: Snapshot, root: string, expectedVersion = ""): WorkspacePublicationBinding | undefined {
  const manifest = snapshot.manifest;
  const json = manifest.format === JSON_FORMAT ? manifest as JsonManifest : undefined;
  if (json && (!expectedVersion || snapshot.version !== expectedVersion)) throw validation("expected-version", "must match the exact reviewed JSON Workspace version");
  if (!json && expectedVersion) throw validation("expected-version", "Markdown publication binds normalized content, not a JSON Workspace version");
  const requirement: RequirementInput = json ? json.draft.requirement : parseRequirementMarkdown(snapshot.files["requirement.md"], "requirement.md").input;
  const requirementChanged = !same(requirement, manifest.requirement.base);
  const drafts: Draft[] = json ? json.draft.issues.map(draft => ({ ...draft, entry: manifest.issues.find(entry => entry.key === draft.key) ?? { key: draft.key, file: `issues/${draft.key}.md` } })) : markdownDrafts(snapshot);
  const changes = drafts.filter(({ input, baselineExpression, entry }) => !same(input, entry.base)
    || baselineExpression !== entry.baseline?.git_oid
    || (json ? entry.desired_requirement_revision_id !== undefined : entry.desired_requirement_revision_id !== undefined && entry.desired_requirement_revision_id !== entry.requirement_revision_id));
  const targets = changes.map(item => item.input.target_branch ?? item.entry.base?.target_branch)
    .filter((target, index, all): target is TargetBranch => !!target && all.findIndex(other => other?.remote === target.remote && other?.ref === target.ref) === index);
  if (!targets.length) return undefined;
  const command = {
    canonical_remote: manifest.repository_remote,
    requirement: {
      ...(manifest.requirement.id ? { requirement_id: manifest.requirement.id, expected_revision_id: manifest.requirement.revision_id, require_current: manifest.requirement.require_current ?? true } : {}),
      ...(requirementChanged ? { input: requirement } : {}),
    },
    issues: changes.map(({ input, baselineExpression, entry }) => ({
      ...(entry.id ? { issue_id: entry.id, expected_revision_id: entry.revision_id } : {}),
      ...(!requirementChanged && (entry.desired_requirement_revision_id || entry.requirement_revision_id) ? { requirement_revision_id: entry.desired_requirement_revision_id || entry.requirement_revision_id } : {}),
      baseline: { git_oid: resolveBaseline(root, baselineExpression) }, target_branch: input.target_branch, input,
    })),
  };
  return { canonical_remote: manifest.repository_remote, content_digest: contentDigestFor(publishAuthoringBinding(command)),
    ...(json ? { reviewed_version: expectedVersion } : {}), targets, target: targets[0]!,
    ...(new Set(command.issues.map(issue => issue.baseline.git_oid)).size === 1 ? { definition_commit: command.issues[0]!.baseline.git_oid } : {}) };
}
