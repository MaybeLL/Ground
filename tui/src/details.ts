import { completionLines, deliveryStatus } from './completion-view.js';
import { candidateHistoryLines } from './candidate-history.js';
import { array, record, verificationMode, type Route } from './pages.js';
import type { Data } from './protocol.js';
import { text, warnings, type Detail } from './workspace.js';
import { preflightView } from './preflight-view.js';

export type Task = 'review' | 'reports' | 'manifest-next' | 'manifest-prev' | 'reports-next' | 'reports-prev';
export interface Node {
  id: string; label: string; kind: 'group' | 'body' | 'action';
  children?: Node[]; body?: unknown; preview?: string; defaultOpen?: boolean; task?: Task; route?: Route; resourceId?: string;
  pathLabel?: string; panelTitle?: string;
}
export interface DetailTree { title: string; facts: string[]; nodes: Node[] }
export interface VisibleNode { node: Node; depth: number; ancestors: string[] }
const body = (id: string, label: string, value: unknown): Node => ({ id, label: `${label}${value === undefined ? ' · 未提供' : Array.isArray(value) && !value.length ? ' · 无' : ''}`, kind: 'body', body: value });
const group = (id: string, label: string, children: Node[], extra: Partial<Node> = {}): Node => ({ id, label, children, kind: 'group', ...extra });
const action = (id: string, label: string, route: Route): Node => ({ id, label, kind: 'action', route });
// Domain sections expose prose as individual Markdown leaves, not JSON-escaped strings.
function content(id: string, label: string, value: unknown): Node {
  if (Array.isArray(value)) return group(id, `${label} · ${value.length}`, value.map((v, i) => content(`${id}/${text(record(v).id ?? i)}`, `${i + 1}`, v)));
  if (value && typeof value === 'object') return group(id, label, Object.entries(record(value)).map(([key, v]) => content(`${id}/${key}`, key, v)));
  return body(id, label, value);
}
const list = (id: string, label: string, value: unknown): Node => group(id, `${label} · ${value === undefined ? '未提供' : Array.isArray(value) ? value.length : '未知'}`,
  Array.isArray(value) ? value.map((v, i) => content(`${id}/${text(record(v).id ?? i)}`, `${i + 1}. ${text(record(v).statement ?? record(v).summary ?? (typeof v === 'string' ? v : label))}`, v)) : [body(id + '/missing', '内容', value)]);
const intro = (id: string, label: string, value: unknown): Node => ({ id, label, kind: 'body', body: value,
  preview: typeof value === 'string' ? value : value === undefined ? '未提供' : '' });
const count = (value: unknown) => value === undefined ? '未加载' : text(value);

export function flatten(nodes: Node[], expanded: Record<string, boolean>, ancestors: string[] = []): VisibleNode[] {
  return nodes.flatMap(node => [{ node, depth: ancestors.length, ancestors }, ...(node.kind === 'group' && (expanded[node.id] ?? node.defaultOpen) ? flatten(node.children ?? [], expanded, [...ancestors, node.id]) : [])]);
}
export function resolveNode(visible: VisibleNode[], id?: string): number {
  if (!id) return 0;
  let candidate = id;
  while (candidate) { const index = visible.findIndex(v => v.node.id === candidate); if (index >= 0) return index; candidate = candidate.slice(0, candidate.lastIndexOf('/')); }
  return 0;
}
export function bodyMarkdown(value: unknown): string[] {
  if (value === undefined || value === null) return ['未提供'];
  if (typeof value === 'string') return value.split('\n');
  if (Array.isArray(value) && !value.length) return ['无'];
  // Metadata is literal, not executable Markdown supplied by field names.
  return ['````json', JSON.stringify(value, null, 2), '````'];
}

function criterionMarkdown(kind: '目标' | '约束', target: Data, criterion: Data): string {
  return [`# ${text(criterion.id)} ${text(criterion.statement)}`, `所属${kind}：${text(target.statement)}`,
    criterion.guidance === undefined ? '' : `## 验证指引\n\n${prose(criterion.guidance)}`].filter(Boolean).join('\n\n');
}
function targetMarkdown(kind: '目标' | '约束', target: Data): string {
  return [`# ${kind}：${text(target.statement)}`,
    target.rationale === undefined ? '' : `## 理由\n\n${prose(target.rationale)}`,
    target.guidance === undefined ? '' : `## 验证指引\n\n${prose(target.guidance)}`,
    `## 验收标准\n\n${array(target.criteria).length ? array(target.criteria).map(c => `### ${text(c.id)} ${text(c.statement)}${c.guidance === undefined ? '' : `\n\n${prose(c.guidance)}`}`).join('\n\n') : '无'}`,
  ].filter(Boolean).join('\n\n');
}
function targets(id: string, issue: Data, claims?: Data[]): Node[] {
  return (['goal', 'constraint'] as const).flatMap(type => array(issue[type === 'goal' ? 'goals' : 'constraints']).map(target => {
    const key = `${id}/${type}:${text(target.id)}`;
    const claim = claims?.find(c => c.target_type === type && c.target_id === target.id);
    const kind = type === 'goal' ? '目标' : '约束';
    return group(key, `${kind}：${text(target.statement)}`, [
      ...(claims ? [body(key + '/claim', '作者目标声明', claim?.explanation)] : []),
      ...array(target.criteria).map(criterion => {
        const ck = `${key}/${text(criterion.id)}`;
        const c = array(claim?.criteria).find(c => c.criterion_id === criterion.id);
        const criterionNode = claims ? group(ck, `${text(criterion.id)} ${text(criterion.statement)} · 声明${c ? '已提供' : '未提供'}`, [
          body(ck + '/claim', '作者声明（非验证结论）', c?.explanation), content(ck + '/evidence', '作者证据', c?.evidence),
        ], { body: criterionMarkdown(kind, target, criterion) }) : body(ck, `${text(criterion.id)} ${text(criterion.statement)}`, criterionMarkdown(kind, target, criterion));
        return { ...criterionNode, panelTitle: `验收标准 ${text(criterion.id)}` };
      }),
    ], { body: targetMarkdown(kind, target), panelTitle: `${kind} ${text(target.id)}` });
  }));
}

// Keep business prose together; unfamiliar fields remain available in technical information.
function prose(value: unknown): string {
  if (value === undefined || value === null) return '未提供';
  if (Array.isArray(value)) return value.length ? value.map((v, i) => `### ${i + 1}\n\n${prose(v)}`).join('\n\n') : '无';
  if (typeof value !== 'object') return String(value);
  const names: Record<string, string> = { statement: '内容', rationale: '理由', summary: '摘要', question: '问题', reason: '原因' };
  return Object.entries(record(value)).map(([key, v]) => `**${names[key] ?? key}**：${prose(v)}`).join('\n\n');
}
export function requirementMarkdown(q: Data): string {
  return [`# ${text(q.summary)}`, ...[['背景', q.context], ['目标', q.outcomes], ['决策', q.decisions], ['待解决问题', q.open_questions]].map(([title, value]) => `## ${title}\n\n${prose(value)}`)].join('\n\n');
}
export function issueMarkdown(issue: Data, repository?: unknown, baseline?: unknown): string {
  const targetSection = (kind: '目标' | '约束', values: Data[]) => `## ${kind}\n\n${values.length ? values.map(v => targetMarkdown(kind, v)).join('\n\n') : '无'}`;
  // Plan is non-normative context, and any Mermaid source inside it stays as
  // text here: the terminal renders no diagrams. The label carries the same
  // "not an obligation" meaning the review page shows.
  const planSection = issue.plan === undefined ? '' : `## 方案说明（非约束）\n\n${prose(issue.plan)}`;
  return [`# ${text(issue.summary)}`, issue.context === undefined ? '' : `## 背景\n\n${prose(issue.context)}`, planSection,
    targetSection('目标', array(issue.goals)), targetSection('约束', array(issue.constraints)),
    repository === undefined ? '' : `## 仓库\n\n${prose(repository)}`, baseline === undefined ? '' : `## 基线\n\n${prose(baseline)}`,
  ].filter(Boolean).join('\n\n');
}
export function detailMarkdown(d: Detail): string {
  const raw = d.data;
  if (d.route.kind === 'requirement') return requirementMarkdown(record(raw.requirement));
  if (d.route.kind === 'issue') return issueMarkdown(record(raw.issue), raw.repository, raw.baseline);
  if (d.route.kind === 'candidate') {
    const candidate = record(raw.candidate);
    return [`# Candidate ${text(candidate.candidate_id)}`, `Issue ${text(record(candidate.issue).id)} v${text(record(candidate.issue).version)}`,
      ...candidateHistoryLines(candidate, d.review), `## 提交说明\n\n${prose(candidate.submission_explanation)}`, `## 状态\n\nstanding：${text(candidate.standing)}\n\n验证报告：${text(candidate.verification_count)}`].join('\n\n');
  }
  if (d.route.kind === 'verification') return `# Verification ${text(raw.verification_id)}\n\n${prose(raw)}`;
  return `# ${d.route.kind} ${text(d.route.id)}\n\n${prose(raw)}`;
}
function proseList(id: string, title: string, value: unknown): Node {
  return group(id, `${title} · ${Array.isArray(value) ? value.length : '未提供'}`, Array.isArray(value)
    ? value.map((v, i) => ({ ...body(`${id}/${i}`, `${i + 1}. ${text(record(v).statement ?? record(v).summary ?? (typeof v === 'string' ? v : title))}`, prose(v)),
      pathLabel: `${title} ${i + 1}`, panelTitle: `${title} ${i + 1}` }))
    : [body(id + '/missing', '内容', value)], { body: `# ${title}\n\n${prose(value)}`, pathLabel: title, panelTitle: title });
}

function projectTree(d: Detail): DetailTree {
  const raw = d.data, r = d.route, id = `${r.kind}:${r.id ?? ''}:${r.version ?? ''}`;
  const technical = (value: unknown) => group(id + '/technical', '技术信息', [body(id + '/technical/full', '完整元信息', value)]);
  const warnings = array(raw.warnings).map(w => `警告 ${text(w.code)}: ${text(w.message)}`);
  if (r.kind === 'requirement') {
    const q = record(raw.requirement);
    return { title: `${text(q.summary)} · v${text(q.version)}`, facts: [...warnings, `交付汇总：${deliveryStatus(record(raw.aggregates).completion_status) || "未记录"}`], nodes: [
      body(id + '/context', '背景', `# 背景\n\n${prose(q.context)}`),
      proseList(id + '/outcomes', '目标', q.outcomes), proseList(id + '/decisions', '决策', q.decisions), proseList(id + '/questions', '待解决问题', q.open_questions),
      ...(record(raw.aggregates).issue_count === 0
        ? [body(id + '/issues/none', '暂无关联 Issue，因此暂无 Candidate', '此 Requirement 暂无 Issue；Candidate 只能通过 Issue 版本浏览。')]
        : [group(id + '/issues', `Issue · ${count(record(raw.aggregates).issue_count)}`, [
          ...array(raw.issues).map(entry => { const issue = record(entry.issue); return { ...action(`${id}/issues/${text(issue.id)}`,
            `${text(issue.summary)} · v${text(issue.version)}${entry.bound_to_selected_version === false ? '（其他需求版本）' : ''} · ${deliveryStatus(record(entry.board).status)}`,
            { kind: 'issue', id: text(issue.id), version: typeof issue.version === 'number' ? issue.version : undefined }),
            body: `# Issue ${text(issue.summary)}\n\n版本：v${text(issue.version)}\n\n绑定 Requirement v${text(record(issue.requirement).version)}\n\n按 Enter 打开完整契约。` }; }),
          ...(raw.issues_omitted ? [action(id + '/issues/open', '加载更多 Issue', { kind: 'requirement', id: r.id })] : []),
        ], { defaultOpen: true, body: `# 关联 Issue\n\n${array(raw.issues).length ? array(raw.issues).map(entry => { const issue = record(entry.issue); return `- ${text(issue.summary)} · v${text(issue.version)}`; }).join('\n') : '未加载'}` })]),
      technical({ requirement: q, aggregates: raw.aggregates }),
    ] };
  }
  if (r.kind === 'issue') {
    const issue = record(raw.issue);
    const preflight = preflightView(record(raw.board).preflight, !!issue.target_branch);
    return { title: `${text(issue.summary)} · v${text(issue.version)}${r.version ? '（固定版本）' : '（当前）'}`, facts: [
      ...completionLines(raw.board),
      `绑定 Requirement v${text(record(issue.requirement).version)}`, ...(raw.unavailable ? [text(raw.unavailable)] : []), ...(preflight ? [preflight.label] : []), ...warnings,
    ], nodes: [...(record(raw.board).completion ? [body(id + '/completion', '交付状态与完成依据', completionLines(raw.board).join('\n\n'))] : []), ...(preflight ? [body(id + '/preflight', '开工预检与补齐路径', preflight.lines.join('\n\n'))] : []), body(id + '/overview', `Issue ${text(issue.summary)} · v${text(issue.version)}`, issueMarkdown(issue, raw.repository, raw.baseline)),
      body(id + '/context', '背景', issue.context),
      group(id + '/goals', `目标 · ${array(issue.goals).length}`, targets(id + '/goals', { goals: issue.goals }), { body: array(issue.goals).length ? array(issue.goals).map(v => targetMarkdown('目标', v)).join('\n\n') : '无' }),
      group(id + '/constraints', `约束 · ${array(issue.constraints).length}`, targets(id + '/constraints', { constraints: issue.constraints }), { body: array(issue.constraints).length ? array(issue.constraints).map(v => targetMarkdown('约束', v)).join('\n\n') : '无' }),
      group(id + '/binding', '仓库与基线', [body(id + '/binding/repo', '仓库', raw.repository), body(id + '/binding/base', '基线', raw.baseline)], { body: `# 仓库与基线\n\n${prose(raw.repository)}\n\n${prose(raw.baseline)}` }), technical(raw)] };
  }
  if (r.kind === 'devrun') {
    const preflight = preflightView(raw.preflight, !!raw.development);
    return { title: `DevRun ${text(raw.dev_run_id ?? r.id)}`, facts: [
      `状态：${text(raw.state)}（不证明 Agent 正在运行）`, ...(preflight ? [preflight.label] : []), ...warnings,
    ], nodes: [...(preflight ? [body(id + '/preflight', '开工预检与补齐路径', preflight.lines.join('\n\n'))] : []), technical(raw)] };
  }
  if (r.kind === 'candidate') {
    const c = record(raw.candidate), review = d.review, set = record(review?.verification_set);
    const issue = record(record(review?.contract).issue);
    const files = array(c.file_manifest), units = array(record(review?.change_index).change_units);
    const load = (key: string, label: string, task: Task): Node => ({ id: key, label, kind: 'action', task });
    const lazy = (key: string, label: string, children: Node[], task: Task = 'review') => group(key, label, children, { task });
    return { title: `Candidate ${text(c.candidate_id)}`, facts: [
      `Issue ${text(record(c.issue).id)} v${text(record(c.issue).version)}`,
      `standing：${text(review ? set.standing : c.standing)} · ${review ? 'review' : 'candidate show'} ${d.reviewTime ?? d.time}`,
      `已选择：${c.is_selected === undefined ? '未知' : c.is_selected ? '是（不等于合入）' : '否'} · Selection 观测 ${d.time}`, ...warnings,
    ], nodes: [intro(id + '/submission', '提交说明', c.submission_explanation),
      ...(candidateHistoryLines(c, review).length ? [body(id + '/history', '代码归档、固定比较与修订关系', candidateHistoryLines(c, review).join('\n\n'))] : []),
      group(id + '/files', `变更文件 · ${files.length} / ${count(c.file_count)}${d.singleManifest ? ' · 单页浏览' : ''}`, [
        ...files.map(f => body(id + '/files/' + text(f.path_bytes), `${text(f.display_path)} · ${text(f.change)}（元数据）`, f)),
        ...(d.singleManifest && d.manifestCursors?.length ? [load(id + '/files/prev', '上一页', 'manifest-prev')] : []),
        ...(c.file_manifest_omitted ? [load(id + '/files/next', '加载更多文件', 'manifest-next')] : []),
      ]),
      lazy(id + '/reasons', `变更理由 · ${review ? units.length : '未加载'}`, review ? [body(id + '/reasons/coverage', '解释覆盖（来源：derived relation）', review.explanation_coverage), ...units.map(unit => {
        const key = id + '/reasons/' + text(unit.change_unit_id);
        return group(key, `${text(unit.display_path)} · ${text(unit.kind)}`, [body(key + '/unit', '变更单元（不是原始 diff）', unit),
          ...array(record(review.submission).change_rationales).filter(r => Array.isArray(r.change_refs) && r.change_refs.includes(unit.change_unit_id)).map((r, i) => content(`${key}/rationale/${i}`, '作者理由（引用不证明因果）', r))]);
      })] : []),
      lazy(id + '/criteria', `验收标准与作者声明 · ${review ? '历史契约' : '未加载'}`, review ? targets(id + '/criteria', issue, array(record(review.submission).claims)) : []),
      lazy(id + '/reports', `验证报告 · ${count(review ? set.count : c.verification_count)}${d.singleDirectory ? ' · 单页浏览' : ''}`, [
        ...(review ? [body(id + '/reports/set', '集合摘要（目录不等于已审阅）', set)] : []),
        ...array(d.directory?.verifications).map(entry => action(id + '/reports/' + text(entry.verification_id), `${text(entry.overall_verdict)} · ${verificationMode(entry)} · ${text(entry.verification_id)} · ${text(entry.created_at)}`, { kind: 'verification', id: text(entry.verification_id), entry, tree: text(record(review?.artifact).result_tree_oid) })),
        ...(d.singleDirectory && d.directoryCursors?.length ? [load(id + '/reports/prev', '上一页', 'reports-prev')] : []),
        ...(d.directory?.next_cursor ? [load(id + '/reports/next', '加载更多报告', 'reports-next')] : []),
      ], 'reports'),
      lazy(id + '/contract', `关联契约 · ${review ? '历史快照' : '未加载'}`, review ? [content(id + '/contract/issue', `Issue v${text(issue.version)} 历史契约`, issue), content(id + '/contract/requirement', 'Requirement 历史契约', record(review.contract).requirement), action(id + '/contract/current', '打开 Issue 当前版本（离开历史快照）', { kind: 'issue', id: text(issue.id) })] : []),
      technical(Object.fromEntries(Object.entries(c).filter(([k]) => !['file_manifest', 'claims', 'verifications', 'submission_explanation'].includes(k)))),
    ] };
  }
  if (r.kind === 'verification') {
    const report = record(raw.report);
    return { title: `Verification ${text(raw.verification_id)}`, facts: [`verifier finding · ${text(raw.overall_verdict)} · ${verificationMode(raw)} · ${text(raw.created_at)}`, '正文已打开，不代表人工已审阅', ...warnings], nodes: [
      group(id + '/assessments', '逐项验证', array(report.assessments).map(a => {
        const key = `${id}/assessments/${text(a.target_type)}:${text(a.target_id)}`;
        return group(key, `${text(a.target_type)} ${text(a.target_id)}`, array(a.criteria).map(c => {
          const ck = key + '/' + text(c.criterion_id);
          return group(ck, `Criterion ${text(c.criterion_id)} · final ${text(record(c.final).verdict)}`, [
            content(ck + '/independent', '独立判断 independent', c.independent), content(ck + '/reconciliation', '核对作者声明 reconciliation', c.reconciliation), content(ck + '/final', '最终判断 final', c.final),
          ]);
        }));
      })), technical(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'report'))), body(id + '/subject', '被验证对象', { candidate_id: report.candidate_id, result_tree_oid: report.result_tree_oid, blind_context_digest: report.blind_context_digest }),
    ] };
  }
  return { title: `${r.kind} ${r.id ?? ''}`, facts: warnings, nodes: [intro(id + '/summary', '详情', raw.summary), body(id + '/full', '完整记录', raw)] };
}

export function detailTree(d: Detail, pageWarnings: string[] = []): DetailTree {
  const tree = projectTree(d);
  const notices = [...new Set([...pageWarnings, ...warnings(d.data), ...warnings(d.review), ...warnings(d.directory)])];
  if (notices.length) tree.nodes.unshift(group(`${d.route.kind}:${d.route.id}/warnings`, `CLI 警告 · ${notices.length}`, notices.map((w, i) => body(`${d.route.kind}:${d.route.id}/warnings/${i}`, '警告详情', w))));
  return tree;
}
