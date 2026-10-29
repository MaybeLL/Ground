import { detailMarkdown, detailTree, type Node } from './details.js';
import { array, record, type Route } from './pages.js';
import { text, type Detail, type ResourceRow, type Screen } from './workspace.js';

const compactLabel = (value: string) => value.split(/\s*·\s*/).filter(part => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(part))
  .filter((part, index, parts) => index === 0 || part !== parts[index - 1]).join(' · ');
const resource = (row: ResourceRow, children: Node[] = [], body?: unknown, open = false): Node => ({
  id: `resource:${row.route.kind}:${row.id}:${row.route.version ?? ''}`,
  label: row.label,
  kind: children.length ? 'group' : 'action',
  children,
  body: body ?? `# ${row.label}`,
  route: row.route,
  resourceId: row.id,
  pathLabel: compactLabel(row.label),
  defaultOpen: open,
});

const candidateNodes = (rows: ResourceRow[], selected: ResourceRow | undefined, detail: Detail | undefined): Node[] => rows.filter(row => row.candidate).map(row => {
  const active = selected?.id === row.id && detail?.route.kind === 'candidate';
  return resource(row, active ? detailTree(detail).nodes : [], active ? detailMarkdown(detail) : undefined, active);
});

/** Build one visible business hierarchy while keeping data loading in Workspace. */
export function directoryNodes(page: Screen | undefined, selected: ResourceRow | undefined, detail: Detail | undefined): Node[] {
  if (!page) return [];
  if (page.route.kind === 'home') return page.rows.map(row => {
    const active = selected?.id === row.id && detail?.route.kind === 'requirement';
    return resource(row, active ? detailTree(detail).nodes : [], active ? detailMarkdown(detail) : undefined, active);
  });
  if (page.route.kind === 'requirement') {
    const root = page.rows.find(row => row.id === '__requirement') ?? page.rows[0];
    if (!root) return [];
    return [resource(root, detail?.route.kind === 'requirement' ? detailTree(detail).nodes : [], detail ? detailMarkdown(detail) : undefined, true)];
  }
  if (page.route.kind === 'issue') {
    const issue = record(page.overview?.issue);
    const issueRoute: Route = { kind: 'issue', id: text(issue.id ?? page.route.id), version: page.route.version };
    const issueDetail: Detail = { type: 'detail', route: issueRoute, data: page.overview ?? { issue }, time: page.time };
    const selectedCandidate = selected?.candidate && detail?.route.kind === 'candidate';
    const candidates = candidateNodes(page.rows, selected, selectedCandidate ? detail : undefined);
    const candidateGroup: Node = { id: `issue:${text(issue.id)}/candidates`, label: `Candidates · ${candidates.length}`, kind: 'group', children: candidates,
      body: candidates.length ? `# Candidates\n\n${candidates.map(node => `- ${node.label}`).join('\n')}` : '此 Issue 暂无 Candidate', defaultOpen: true };
    const devruns = page.rows.find(row => row.id === '__devruns');
    const issueNode: Node = { id: `issue:${text(issue.id)}:${text(issue.version)}`, label: `Issue ${text(issue.summary)} · v${text(issue.version)}`, kind: 'group',
      body: detailMarkdown(issueDetail), defaultOpen: true, route: issueRoute,
      children: [...detailTree(issueDetail).nodes.slice(1), candidateGroup, ...(devruns ? [resource(devruns)] : [])] };
    const requirement = record(issue.requirement);
    return [{ id: `requirement:${text(requirement.id)}:${text(requirement.version)}`, label: `Requirement ${text(requirement.id)} · v${text(requirement.version)}`, kind: 'group',
      body: `# Requirement ${text(requirement.id)}\n\n当前目录固定在 Issue v${text(issue.version)}。`, children: [issueNode], defaultOpen: true }];
  }
  return page.rows.map(row => {
    const active = selected?.id === row.id && detail;
    return resource(row, active ? detailTree(detail).nodes : [], active ? detailMarkdown(detail) : undefined, Boolean(active));
  });
}

export function directoryPath(nodes: Node[], target: string, parents: string[] = []): string[] | undefined {
  for (const node of nodes) {
    const path = [...parents, node.pathLabel ?? node.label];
    if (node.id === target) return path;
    const nested = directoryPath(node.children ?? [], target, path);
    if (nested) return nested;
  }
  return undefined;
}
