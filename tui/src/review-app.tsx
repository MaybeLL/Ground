import { candidateHistoryLines } from './candidate-history.js';
import { RequirementView, requirementLines, issueDetailLines, requirementLayout, requirementWidth } from './requirement-view.js';
import { SearchHome, searchIssues, weekIssues } from './home.js';
import { association, fullFileDiff, scopedBlocks, scopeLabel, unitBasis, unitBasisSummary, type DiffScope } from './diff-review.js';
import stringWidth from 'string-width';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { Context, Reader, SelectionWriter } from './client.js';
import type { Data } from './protocol.js';
import { App, fold } from './app.js';
import { clean, renderMarkdown } from './markdown.js';
import { record } from './pages.js';
import { ReviewSession } from './review-data.js';
import { operationHintLines } from './operation-hints.js';
import { assessment, blocks, criteria, criterionText, outlineCriterionChecks, outlineTargetChecks, reportDetail, verifierName, targetText, criterionNumber, criterionClaim, evidenceText, shortId, json, objects, operationId, rangeLabel, recentIssues, relatedBlocks, text, type Criterion, type OutlineChecks, type OutlineState } from './review-model.js';

interface Screen { page: 'issues' | 'requirement' | 'candidates' | 'review' | 'code'; title: string; rows: Data[]; row: number; scroll: number; basisScroll: number; focus: number; filter: string; searchKind?: 'requirements' | 'issues'; requirement?: Data; requirementTab?: 'requirement' | 'issues'; requirementScroll?: number; issueScroll?: number; issueDetail?: Data; issue?: Data; selection?: Data; session?: ReviewSession; unitId?: string; scope: DiffScope; collapsed: string[]; expandedReports: boolean }
interface OutlineLine { row: number; value: string; kind: 'title' | 'space'; parent: boolean; lead?: string; checks?: OutlineChecks }
const selfColumnWidth = 6, independentColumnWidth = 10;
const statusColumnsWidth = selfColumnWidth + independentColumnWidth;
const statusCell = (value: string, width: number) => value + ' '.repeat(Math.max(0, width - stringWidth(value)));
const centeredStatusCell = (value: string, width: number) => {
  const left = Math.floor(Math.max(0, width - stringWidth(value)) / 2);
  return ' '.repeat(left) + statusCell(value, width - left);
};
const statusAppearance: Record<OutlineState, { symbol: string; color: string }> = {
  met: { symbol: '✓', color: 'green' },
  unmet: { symbol: '×', color: 'red' },
  partial: { symbol: '△', color: 'yellow' },
  pending: { symbol: '…', color: 'gray' },
  unknown: { symbol: '?', color: 'yellow' },
  conflict: { symbol: '!', color: 'yellow' },
};
function StatusCell({ state, count, width }: { state: OutlineState; count?: string; width: number }) {
  const { symbol, color } = statusAppearance[state];
  const value = count && stringWidth(`${symbol}${count}`) <= width ? `${symbol}${count}` : symbol;
  return <Text color={process.env.NO_COLOR !== undefined ? undefined : color}>{centeredStatusCell(value, width)}</Text>;
}
const initial = (): Screen => ({ page: 'issues', title: '最近任务', rows: [], row: 0, scroll: 0, basisScroll: 0, focus: 0, filter: '', scope: { kind: 'all' }, collapsed: [], expandedReports: false });
interface Action { id: string; label: string; run: () => void }
type Overlay = { kind: 'menu' | 'search' | 'help' | 'evidence' | 'basis' | 'reason' | 'confirm'; title: string; body?: string; value: string; row: number; actions?: Action[]; selection?: Data; operation?: string; identity?: string };
const label = (v: unknown) => clean(text(v)).replace(/[\r\n\t]/g, ' ');
const bound = (n: number, max: number) => Math.max(0, Math.min(n, Math.max(0, max)));

function barLabel(value: string, width: number): string {
  let output = '';
  for (const char of Array.from(label(value))) { if (stringWidth(output + char) > width) break; output += char; }
  return output + ' '.repeat(Math.max(0, width - stringWidth(output)));
}
function PanelBar({ title, active, width }: { title: string; active: boolean; width: number }) {
  return <Text bold inverse={active} wrap="truncate">{barLabel(`${active ? '▶ ' : '  '}${title}`, width)}</Text>;
}
function OutlineText({ line, selected }: { line: OutlineLine; selected: boolean }) {
  const color = process.env.NO_COLOR !== undefined ? undefined : selected ? 'cyan' : line.parent ? 'blueBright' : undefined;
  if (!line.checks) return <Text bold={line.kind === 'title' && (line.parent || selected)} color={color} wrap="truncate">{line.value}</Text>;
  return <Text wrap="truncate"><Text color={color}>{line.lead}</Text><StatusCell state={line.checks.self} count={line.checks.counts?.self} width={selfColumnWidth} /><StatusCell state={line.checks.independent} count={line.checks.counts?.independent} width={independentColumnWidth} /><Text bold={line.parent || selected} color={color}>{line.value}</Text></Text>;
}

export function ReviewApp({ reader, writer, context, onExit, onEval, onHome, initialCandidate, initialSearchKind = 'requirements', width: widthOverride, height: heightOverride }: { onHome?: () => void; onEval?: () => void; initialCandidate?: string; initialSearchKind?: 'requirements' | 'issues'; reader: Reader; writer?: SelectionWriter; context: Context; onExit: () => void; width?: number; height?: number }) {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns || 100, height: stdout.rows || 30 });
  useEffect(() => { const f = () => setSize({ width: stdout.columns || 100, height: stdout.rows || 30 }); stdout.on('resize', f); return () => { stdout.off('resize', f); }; }, [stdout]);
  const width = widthOverride ?? size.width, height = heightOverride ?? size.height;
  const [screen, setScreen] = useState<Screen>(() => ({ ...initial(), searchKind: initialSearchKind })), [history, setHistory] = useState<Screen[]>([]), [overlay, setOverlay] = useState<Overlay>(), [legacy, setLegacy] = useState(false);
  const [savedCode, setSavedCode] = useState<Screen>();
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [, repaint] = useState(0);
  const [pendingSelection, setPendingSelection] = useState<{ overlay: Overlay; candidate: string; issue: string; version: number }>();
  const request = useRef<AbortController | undefined>(undefined), writing = useRef(false);
  const change = (part: Partial<Screen>) => setScreen(s => ({ ...s, ...part }));
  const run = (work: (signal: AbortSignal) => Promise<void>) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true); setNotice('');
    void work(controller.signal).catch(e => { if (!controller.signal.aborted) setNotice(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
  };
  const push = (next: Screen) => { setHistory(h => [...h, screen].slice(-32)); setScreen(next); setOverlay(undefined); };
  const back = () => {
    request.current?.abort(); setBusy(false); setNotice('');
    if (overlay) { setOverlay(undefined); return; }
    if (history.length) { if (screen.page === 'code' && history[history.length - 1].page === 'review') setSavedCode(screen); setScreen(history[history.length - 1]); setHistory(history.slice(0, -1)); }
  };
  const returnToRequirementSearch = () => {
    request.current?.abort(); setBusy(false); setNotice('');
    const reverse = [...history].reverse().findIndex(item => item.page === 'issues' && item.searchKind === 'requirements');
    const index = reverse < 0 ? -1 : history.length - reverse - 1;
    if (index < 0) { back(); return; }
    setScreen(history[index]); setHistory(history.slice(0, index));
  };
  const loadIssues = (signal: AbortSignal, kind = screen.searchKind ?? 'issues') => reader.query(kind, [], signal).then(result => {
    if (!signal.aborted) setScreen(s => ({ ...s, rows: recentIssues(objects(result.resources)), searchKind: kind, row: 0 }));
  });
  const loadRequirement = async (id: string, signal: AbortSignal): Promise<{ requirement: Data; linked: Data[] }> => {
    let cursor = '', fixedVersion: unknown;
    const linked: Data[] = [], seen = new Set<string>();
    let requirement: Data = {};
    do {
      const detail = await reader.query('requirement', [id, ...(cursor ? ['--issues-cursor', cursor] : [])], signal);
      requirement = { ...record(detail.requirement), aggregates: detail.aggregates };
      if (requirement.id !== id || (fixedVersion !== undefined && requirement.version !== fixedVersion)) throw new Error('Requirement 已变化，请重新打开');
      fixedVersion = requirement.version;
      linked.push(...objects(detail.issues).map(entry => {
        const issue = record(entry.issue), binding = record(issue.requirement);
        const boundToSelected = binding.version === requirement.version;
        if (binding.id !== id || !Number.isSafeInteger(binding.version) ||
          (typeof entry.bound_to_selected_version === 'boolean' && entry.bound_to_selected_version !== boundToSelected)) throw new Error('关联 Issue 的 Requirement 身份或版本关系不匹配');
        return { ...issue, board: entry.board, resource_id: issue.id, label: issue.summary, requirementVersion: binding.version, bound_to_selected_version: boundToSelected };
      }));
      const next = text(detail.issues_next_cursor);
      if ((detail.issues_omitted && !next) || (next && seen.has(next))) throw new Error('关联 Issue 分页不完整');
      cursor = next; if (cursor) seen.add(cursor);
    } while (cursor && !signal.aborted);
    return { requirement, linked };
  };
  useEffect(() => {
    if (initialCandidate) run(async signal => {
      const value = record((await reader.query('candidate', [initialCandidate], signal)).candidate), ref = record(value.issue);
      if (value.candidate_id !== initialCandidate) throw new Error('Candidate 身份不匹配');
      const detail = await reader.query('issue', [text(ref.id), '--issue-version', text(ref.version)], signal);
      await openCandidate(initialCandidate, record(detail.issue), record(record(detail.board).selection), signal);
    }); else run(loadIssues);
    return () => request.current?.abort();
  }, [reader, initialCandidate]);
  const session = screen.session, trace = session?.trace ?? {}, contract = record(record(trace.contract).issue);
  const allCriteria = criteria(trace), allBlocks = blocks(trace);
  const scopeBlocks = scopedBlocks(trace, screen.scope);
  const unitIndex = scopeBlocks.findIndex(b => b.unit.change_unit_id === screen.unitId);
  const block = scopeBlocks[unitIndex];
  const criterionRows: Data[] = [{ resource_id: '@overview', label: '交付概览' }];
  let parentKey = '';
  for (const c of allCriteria) {
    const key = `${c.targetType}:${c.targetId}`;
    if (key !== parentKey) { criterionRows.push({ resource_id: key, label: `${screen.collapsed.includes(key) ? '▸' : '▾'} [${c.targetType === 'goal' ? '目标' : '约束'} ${criterionNumber(trace, c).split('.')[0]}] ${c.parent}`, parent: true, targetType: c.targetType, targetId: c.targetId, shortLabel: `${c.targetType === 'goal' ? '目标' : '约束'} ${criterionNumber(trace, c).split('.')[0]}` }); parentKey = key; }
    if (!screen.collapsed.includes(key)) criterionRows.push({ resource_id: c.key, label: `  ${criterionNumber(trace, c)} ${c.statement}`, criterion: c });
  }
  const sourceRows = screen.page === 'review' ? criterionRows : screen.rows;
  const rows = screen.page === 'issues' ? screen.focus === 1 ? weekIssues(sourceRows) : searchIssues(sourceRows, screen.filter)
    : screen.page === 'requirement' ? searchIssues(sourceRows, screen.filter)
      : sourceRows.filter(r => !screen.filter || label(r.label).toLowerCase().includes(screen.filter.toLowerCase()));
  const row = bound(screen.row, rows.length - 1), selected = rows[row];
  const activeCriterion = selected?.criterion as Criterion | undefined;
  const reports = session?.reports ?? [], count = session?.count ?? 0;
  const visibleReports = screen.expandedReports ? reports : reports.slice(0, 1);
  let body = '';
  if (screen.page === 'issues') body = selected ? [`Issue v${selected.version} · ${shortId(selected.resource_id)}`, `最近业务活动：${json(selected.last_activity) || '该 CLI 未提供活动时间'}`, 'Enter 查看候选；版本固定后再审阅。'].join('\n\n') : '尚无 Issue。可在操作菜单打开需求阅读。';
  if (screen.page === 'candidates') body = [`# ${screen.issue?.summary}`, `Issue ${screen.issue?.id} · v${screen.issue?.version}`, `当前选择：${shortId(screen.selection?.candidate_id) || '未选择'}`, selected ? json(selected) : '没有候选，仍可阅读下方固定契约。', '## 固定契约', json(screen.issue)].join('\n\n');
  if (screen.page === 'review') {
    if (activeCriterion) body = criterionText(trace, activeCriterion, visibleReports, count, reports) + (reports.length > 1 && !screen.expandedReports ? `\n\n另有 ${reports.length - 1} 份已加载报告折叠；操作菜单可展开。` : '');
    else if (selected?.parent) body = targetText(trace, text(selected.targetType), text(selected.targetId), reports, count);
    else body = ['## 候选交付', `Issue v${contract.version} · Candidate ${shortId(record(trace.candidate).candidate_id)}`, `当前选择：${shortId(screen.selection?.candidate_id) || '未选择'}`, ...candidateHistoryLines(record(trace.candidate), trace), '## 作者交付说明', text(record(trace.submission).explanation), `## 独立验证集合 · ${count} 份`, `已加载 ${reports.length} 份正文；请进入具体标准查看判断与来源。`, '集合统计不代表逐项验收结论；自我验证与独立验证分别阅读。'].join('\n\n');
  }
  const codePage = screen.page === 'code', tabbedPage = codePage || screen.page === 'review';
  const reviewOutline = screen.page === 'review';
  const detailScope: DiffScope | undefined = reviewOutline && screen.focus === 1
    ? activeCriterion ? { kind: 'criterion', key: activeCriterion.key }
      : selected?.parent ? { kind: selected.targetType as 'goal' | 'constraint', id: text(selected.targetId) }
        : undefined
    : undefined;
  const overlayHints = overlay?.kind === 'confirm' ? ['Enter 确认', 'Esc 取消']
    : overlay?.kind === 'reason' ? ['输入理由', 'Backspace 删除', 'Enter 下一步', 'Esc 取消']
      : overlay?.kind === 'menu' ? ['输入筛选', '↑↓ 选择', 'Backspace 删除', 'Enter 执行', 'Esc 关闭']
        : overlay?.kind === 'search' ? ['输入关键词', 'Backspace 删除', 'Enter 搜索', 'Esc 取消']
          : overlay ? ['↑↓ 滚动', 'PgUp/PgDn 翻页', 'Home/End 首尾', 'Esc 返回'] : [];
  const pageHints = codePage ? [
    'Tab 切换页签', 's 切换范围', ...(scopeBlocks.length ? ['[ / ] 切变更'] : []), '←/→ 切面板',
    '↑↓ 浏览', 'PgUp/PgDn 翻页', '/ 搜索', ': 更多操作', '? 帮助', 'Esc 返回', 'q 退出',
  ] : reviewOutline ? [
    'Tab 切换页签',
    ...(screen.focus === 1 ? [detailScope ? 'Enter 审阅关联代码' : 'Esc 返回总览']
      : selected?.parent ? ['Enter 查看详情', 'Space 展开/收起']
        : ['Enter 查看详情']),
    '↑↓ 浏览', 'PgUp/PgDn 翻页', '/ 搜索', ': 更多操作', '? 帮助', ...(screen.focus === 0 ? ['Esc 返回'] : []), 'q 退出',
  ] : ['↑↓/j/k 选择', 'PgUp/PgDn 翻页', 'Enter 打开', '←/Esc 返回', '/ 搜索', ': 更多操作', '? 帮助', 'r 刷新', 'q/Ctrl+C 退出'];
  const hintParts = overlay ? overlayHints : busy ? ['正在读取…', 'Esc 返回', '/ 搜索', ': 更多操作', '? 帮助', 'q/Ctrl+C 退出'] : notice ? [label(notice), ...pageHints] : pageHints;
  const spaciousHeader = tabbedPage && height >= 28;
  const hintWidth = tabbedPage && width >= 120 ? Math.min(width, 112) : width;
  const hintLines = operationHintLines(hintParts, hintWidth, Math.max(1, Math.min(5, height - 10)), overlay ? 'Esc 返回后 ? 查看操作' : undefined);
  const panelHeight = Math.max(1, height - (tabbedPage ? 7 : 6) - hintLines.length - (spaciousHeader ? 2 : 0));
  const wideCode = codePage && width >= 150, splitCode = codePage && width >= 100;
  const leftWidth = codePage ? wideCode ? Math.min(30, Math.floor(width * .2)) : 0 : screen.page === 'review' ? 0 : width >= 90 ? Math.min(60, Math.floor(width * .34)) : 0;
  const basisWidth = splitCode ? wideCode ? Math.min(84, Math.max(48, Math.floor((width - leftWidth) * .4))) : Math.min(52, Math.floor(width * .34)) : 0;
  const bodyWidth = Math.max(1, width - 2 - leftWidth - (leftWidth ? 1 : 0) - basisWidth - (basisWidth ? 1 : 0));
  const proseWidth = screen.page === 'review' ? Math.min(bodyWidth, 104) : bodyWidth;
  const linkedChanges = detailScope ? scopedBlocks(trace, detailScope).length : 0;
  const detailHint = detailScope && panelHeight >= 3 ? linkedChanges
    ? `  › 下一步：按 Enter 审阅关联代码 diff（${linkedChanges} 处）`
    : '  › 当前无关联代码 diff；按 Enter 查看空范围'
    : '';
  const bodyViewport = Math.max(1, panelHeight - 1 - (detailHint ? 1 : 0));
  const codeLines = block ? fold([`${block.unit.kind === 'file' ? '文件级变更' : '当前块'} ${unitIndex + 1}/${scopeBlocks.length}${block.unit.kind === 'file' ? '' : ` · 旧 ${rangeLabel(block.unit.old_range)} → 新 ${rangeLabel(block.unit.new_range)}`}`, (block.content ?? `${block.unavailable}\n${json(block.unit)}`).replace(/\t/g, '    ')], bodyWidth) : ['当前范围没有关联变更。', '可通过 s 显式切换范围；不会自动跳到其他代码。'];
  const bodyLines = codePage ? codeLines : renderMarkdown(body.split('\n'), proseWidth, true);
  const basisLines = renderMarkdown((block ? unitBasisSummary(trace, block, screen.scope, reports, count) : '当前范围 0/0，无变更单元。').split('\n'), Math.max(1, basisWidth ? basisWidth - 1 : width - 2), true);
  const start = 0;
  const codeScroll = bound(screen.scroll, codeLines.length - panelHeight + 1);
  const offscreen = false;
  const files = scopeBlocks;
  const openCandidate = async (id: string, issue: Data, selection: Data, signal: AbortSignal) => {
    const review = await ReviewSession.open(reader, id, signal);
    const fixed = record(record(review.trace.contract).issue);
    if (fixed.id !== issue.id || fixed.version !== issue.version) throw new Error('Candidate 与所选 Issue 版本不匹配');
    if (signal.aborted) return;
    push({ ...initial(), page: 'review', title: `Candidate ${id}`, issue: fixed, session: review, selection });
    if (review.hasMore) { await review.next(signal); if (!signal.aborted) repaint(n => n + 1); }
  };
  const enter = () => {
    if (screen.page === 'issues' && screen.searchKind === 'requirements') run(async signal => {
      if (!selected) return;
      const { requirement, linked } = await loadRequirement(text(selected.resource_id), signal);
      if (!signal.aborted) push({ ...initial(), page: 'requirement', title: `Requirement · ${text(requirement.summary)}`, requirement, requirementTab: 'requirement', rows: linked });
    });
    else if (screen.page === 'requirement' && screen.requirementTab === 'issues' && !screen.issueDetail && selected) run(async signal => {
      const detail = await reader.query('issue', [text(selected.resource_id), '--issue-version', text(selected.version)], signal);
      const issue = record(detail.issue), binding = record(issue.requirement);
      if (issue.id !== selected.resource_id || issue.version !== selected.version || binding.id !== screen.requirement?.id ||
        (selected.requirementVersion !== undefined && binding.version !== selected.requirementVersion)) throw new Error('Issue 返回身份、版本或所属需求不匹配，请刷新关联列表');
      if (!signal.aborted) push({ ...screen, issue, issueDetail: detail, issueScroll: 0 });
    });
    else if (screen.page === 'requirement' && screen.requirementTab === 'issues' && screen.issueDetail && screen.issue) run(async signal => {
      const issue = screen.issue!;
      const result = await reader.query('candidates', ['--issue', text(issue.id), '--issue-version', text(issue.version)], signal);
      if (signal.aborted) return;
      const candidates = objects(result.resources), selection = record(record(screen.issueDetail).board).selection;
      if (!candidates.length) { setNotice('该 Issue Version 暂无 Candidate；契约详情仍可阅读。'); return; }
      if (candidates.length === 1) await openCandidate(text(candidates[0].resource_id), issue, record(selection), signal);
      else showMenu('选择该 Issue Version 的 Candidate', candidates.map(candidate => ({ id: text(candidate.resource_id), label: `${text(candidate.label)} · ${shortId(candidate.resource_id)}`, run: () => run(next => openCandidate(text(candidate.resource_id), issue, record(selection), next)) })));
    });
    else if (screen.page === 'issues') run(async signal => {
      if (!selected) return;
      const detail = await reader.query('issue', [text(selected.resource_id), '--issue-version', text(selected.version)], signal), issue = record(detail.issue);
      if (issue.id !== selected.resource_id || issue.version !== selected.version) throw new Error('Issue 返回身份或版本不匹配');
      const result = await reader.query('candidates', ['--issue', text(issue.id), '--issue-version', text(issue.version)], signal);
      if (signal.aborted) return;
      const candidates = objects(result.resources), selection = record(record(detail.board).selection);
      if (candidates.length === 1) await openCandidate(text(candidates[0].resource_id), issue, selection, signal);
      else push({ ...initial(), page: 'candidates', title: `${issue.summary} · v${issue.version}`, issue, selection, rows: candidates });
    });
    else if (screen.page === 'candidates' && selected) run(signal => openCandidate(text(selected.resource_id), screen.issue!, screen.selection ?? {}, signal));
    else if (screen.page === 'review' && screen.focus === 1 && (activeCriterion || selected?.parent)) openCode();
    else if (screen.page === 'review' && selected) change({ focus: 1 });
  };
  const openCode = (index?: number, purpose = activeCriterion, explicitScope?: DiffScope) => {
    const scope: DiffScope = explicitScope ?? (codePage ? screen.scope : purpose ? { kind: 'criterion', key: purpose.key } : selected?.parent ? { kind: selected.targetType as 'goal' | 'constraint', id: text(selected.targetId) } : { kind: 'all' });
    const candidates = scopedBlocks(trace, scope);
    const preferred = index === undefined ? screen.unitId : text(allBlocks[index]?.unit.change_unit_id);
    const target = candidates.find(b => b.unit.change_unit_id === preferred) ?? candidates[0];
    push({ ...screen, page: 'code', row: Math.max(0, candidates.indexOf(target)), scope, unitId: target ? text(target.unit.change_unit_id) : undefined, focus: 1, filter: '', scroll: 0, basisScroll: 0 });
  };
  const openCodeTab = () => {
    if (screen.page !== 'review') return;
    if (savedCode && savedCode.session === session) push({ ...savedCode, issue: screen.issue, session: screen.session, selection: screen.selection });
    else openCode(undefined, undefined, { kind: 'all' });
  };
  const returnToReview = () => {
    const reverse = [...history].reverse().findIndex(s => s.page === 'review');
    const index = reverse < 0 ? -1 : history.length - reverse - 1;
    if (index < 0) return;
    setSavedCode(screen);
    setScreen(history[index]);
    setHistory(history.slice(0, index));
  };
  const moveBlock = (index: number) => { const target = scopeBlocks[bound(index, scopeBlocks.length - 1)]; if (!target) return; change({ unitId: text(target.unit.change_unit_id), row: scopeBlocks.indexOf(target), scroll: 0, basisScroll: 0 }); };
  const showMenu = (title: string, actions: Action[]) => setOverlay({ kind: 'menu', title, actions, value: '', row: 0 });
  const beginSelection = () => run(async signal => {
    const identity = await writer?.selectionIdentity?.();
    const latest = record((await reader.query('review', [text(record(trace.candidate).candidate_id), '--summary'], signal)).trace);
    if (record(latest.candidate).candidate_id !== record(trace.candidate).candidate_id || record(latest.artifact).result_tree_oid !== record(trace.artifact).result_tree_oid) throw new Error('选择前读取的 Candidate 身份不匹配');
    if (record(latest.verification_set).digest !== record(trace.verification_set).digest) throw new Error('独立报告集合已变化，请刷新候选并核对新报告后再选择');
    const result = await reader.query('selection', ['--issue', text(contract.id), '--issue-version', text(contract.version)], signal);
    if (record(result.issue).id !== contract.id || record(result.issue).version !== contract.version) throw new Error('Selection 所属契约不匹配');
    if (!signal.aborted) setOverlay({ kind: 'reason', title: '人工选择候选：填写选择理由', value: '', row: 0, selection: record(result.selection), operation: operationId(), identity });
  });
  const actions: Action[] = [
    ...(onHome ? [{ id: 'home', label: '返回首页（Ctrl+G）', run: onHome }] : []),
    ...(onEval ? [{ id: 'eval', label: '评测资产与实验对照（Ctrl+E）', run: onEval }] : []),
    ...(screen.issue ? [{ id: 'versions', label: '切换 Issue 版本', run: () => showMenu('Issue 版本（候选与选择分别固定）', Array.from({ length: Number(screen.issue!.version) }, (_, index) => ({ id: String(index + 1), label: `v${index + 1}`, run: () => run(async signal => {
      const detail = await reader.query('issue', [text(screen.issue!.id), '--issue-version', String(index + 1)], signal), issue = record(detail.issue);
      if (issue.id !== screen.issue!.id || issue.version !== index + 1) throw new Error('历史 Issue 返回身份或版本不匹配');
      const candidates = await reader.query('candidates', ['--issue', text(issue.id), '--issue-version', text(issue.version)], signal);
      if (!signal.aborted) push({ ...initial(), page: 'candidates', title: `${issue.summary} · v${issue.version}`, issue, selection: record(record(detail.board).selection), rows: objects(candidates.resources) });
    }) }))) }] : []),
    ...(activeCriterion ? [
      { id: 'report-details', label: '独立复核详情', run: () => reports.length === 0 ? setNotice(count === 0 ? '未提交独立验证；不代表失败。' : '报告正文尚未加载；请通过操作菜单加载下一份独立报告。') : showMenu('选择验证报告', reports.map((r, index) => ({ id: text(r.verification_id), label: `${index + 1}. ${verifierName(r)} · ${shortId(r.verification_id)}`, run: () => showMenu(`报告 ${shortId(r.verification_id)}`, ([['independent', '独立检查过程与证据'], ['reconciliation', '对照作者声明'], ['metadata', '报告标识与时间']] as const).map(([section, title]) => ({ id: section, label: title, run: () => setOverlay({ kind: 'evidence', title, body: reportDetail(r, activeCriterion, section), value: '', row: 0 }) }))) }))) },
      { id: 'criterion-evidence', label: '查看当前标准证据', run: () => setOverlay({ kind: 'evidence', title: '证据 · 提供者记录，退出码不等于验收通过', body: ['作者提供的证据', evidenceText(criterionClaim(trace, activeCriterion).evidence), ...visibleReports.flatMap(r => [`报告 ${r.verification_id} · 来源 ${json(r.attribution)}`, evidenceText(record(assessment(r, activeCriterion).independent).evidence)])].join('\n\n'), value: '', row: 0 }) },
      { id: 'technical', label: '查看技术信息与完整标识', run: () => setOverlay({ kind: 'evidence', title: '技术信息', body: json({ issue: { id: contract.id, version: contract.version }, candidate: trace.candidate, criterion_id: activeCriterion.id, baseline: trace.baseline, artifact: { result_tree_oid: record(trace.artifact).result_tree_oid, patch_digest: record(trace.artifact).patch_digest } }), value: '', row: 0 }) },
    ] : []),
    ...(session ? [{ id: 'reports', label: `加载下一份独立报告（${reports.length}/${count}）`, run: () => run(async signal => { await session.next(signal); if (!signal.aborted) { change({ expandedReports: true }); repaint(n => n + 1); } }) },
      { id: 'collapse', label: screen.expandedReports ? '折叠旧报告' : '展开已加载旧报告', run: () => change({ expandedReports: !screen.expandedReports }) },
      { id: 'evidence', label: '查看原始验证报告与来源（高级）', run: () => setOverlay({ kind: 'evidence', title: '已加载报告原文 · 提供者记录', body: reports.map(r => json(r)).join('\n\n') || '尚未加载报告正文', value: '', row: 0 }) },
      ...(writer ? [{ id: 'select', label: '人工选择此 Candidate（写入 Selection）', run: beginSelection }] : [])] : []),
    ...(pendingSelection && pendingSelection.candidate === record(trace.candidate).candidate_id && pendingSelection.issue === contract.id && pendingSelection.version === contract.version ? [{ id: 'retry-selection', label: '重试上次选择（复用同一操作 ID，仍需确认）', run: () => setOverlay({ ...pendingSelection.overlay, kind: 'confirm' }) }] : []),
    ...(codePage ? [{ id: 'scope', label: '切换审阅范围（s）', run: () => {
      const choices: DiffScope[] = [{ kind: 'all' }, { kind: 'pending' }];
      for (const type of ['goal', 'constraint'] as const) for (const target of objects(contract[type === 'goal' ? 'goals' : 'constraints'])) choices.push({ kind: type, id: text(target.id) });
      choices.push(...allCriteria.map(c => ({ kind: 'criterion' as const, key: c.key })));
      showMenu('审阅范围（各范围可重叠，总数按唯一单元计算）', choices.map((scope, i) => ({ id: String(i), label: `${scopeLabel(trace, scope)} · ${scopedBlocks(trace, scope).length} 项`, run: () => openCode(undefined, undefined, scope) })));
    } }] : []),
    ...(codePage && block ? [
      { id: 'full-basis', label: '查看当前块完整关联依据（理由、替代方案、风险、逐份报告）', run: () => setOverlay({ kind: 'basis', title: '当前块完整关联依据 · 作者声明与标准验证', body: unitBasis(trace, block, screen.scope, reports, count), value: '', row: 0 }) },
      { id: 'file-diff', label: '查看完整文件 diff（不显示当前块依据）', run: () => setOverlay({ kind: 'evidence', title: '完整文件 · 不显示当前块依据', body: fullFileDiff(trace, block), value: '', row: 0 }) },
      { id: 'candidate-history', label: '查看代码归档、固定比较与修订关系', run: () => setOverlay({ kind: 'evidence', title: '候选代码与历史', body: candidateHistoryLines(record(trace.candidate), trace).join('\n\n') || '该历史格式未记录归档与比较参照信息。', value: '', row: 0 }) },
      { id: 'candidate-context', label: '查看候选整体说明（不是当前块理由）', run: () => setOverlay({ kind: 'evidence', title: '候选整体说明', body: text(record(trace.submission).explanation) || '未记录', value: '', row: 0 }) },
      { id: 'locate', label: '回到当前块', run: () => change({ scroll: start }) },
      { id: 'files', label: '选择变更单元（当前范围）', run: () => showMenu('当前范围变更单元', files.map(b => ({ id: text(b.unit.change_unit_id), label: `${text(b.unit.display_path)} · ${b.unit.kind === 'file' ? '文件级变更' : rangeLabel(b.unit.new_range)}`, run: () => openCode(allBlocks.indexOf(b)) }))) },
      { id: 'links', label: '当前块关联标准 / 其他关联位置', run: () => showMenu('当前块明确关联的标准', association(trace, block).criteria.map(c => ({ id: c.key, label: c.statement, run: () => showMenu(c.statement, [
        { id: 'read', label: '阅读标准、作者说明与独立验证', run: () => setOverlay({ kind: 'evidence', title: c.statement, body: criterionText(trace, c, reports, count), value: '', row: 0 }) },
        ...reports.map(r => ({ id: `report:${r.verification_id}`, label: `标准报告 · ${verifierName(r)} · ${shortId(r.verification_id)}`, run: () => showMenu('标准验证详情（不是块级验收）', (['independent', 'reconciliation', 'metadata'] as const).map(section => ({ id: section, label: { independent: '独立检查与证据', reconciliation: '对照作者声明', metadata: '来源与时间' }[section], run: () => setOverlay({ kind: 'evidence', title: '标准验证详情', body: reportDetail(r, c, section), value: '', row: 0 }) }))) })),
        { id: 'purpose', label: '改为核查此标准', run: () => openCode(undefined, c, { kind: 'criterion', key: c.key }) },
        ...relatedBlocks(trace, c).map(b => ({ id: text(b.unit.change_unit_id), label: `${b.unit.display_path} · ${json(b.unit.new_range)}`, run: () => openCode(allBlocks.findIndex(x => x.unit.change_unit_id === b.unit.change_unit_id), c, { kind: 'criterion', key: c.key }) }))
      ]) }))) }
    ] : []),
    { id: 'refresh', label: '刷新当前数据', run: () => run(async signal => {
      if (session) { const next = await ReviewSession.open(reader, text(record(trace.candidate).candidate_id), signal); const selection = await reader.query('selection', ['--issue', text(contract.id), '--issue-version', text(contract.version)], signal); if (!signal.aborted) { change({ session: next, selection: record(selection.selection), expandedReports: false }); setHistory(h => h.map(s => s.session === session ? { ...s, session: next, selection: record(selection.selection) } : s)); } if (next.hasMore) await next.next(signal); if (!signal.aborted) repaint(n => n + 1); }
      else if (screen.page === 'issues') await loadIssues(signal);
      else { const result = await reader.query('candidates', ['--issue', text(screen.issue?.id), '--issue-version', text(screen.issue?.version)], signal); if (!signal.aborted) change({ rows: objects(result.resources), row: 0 }); }
    }) },
    { id: 'requirements', label: '打开原有需求阅读工作台', run: () => setLegacy(true) },
  ];
  const confirm = async () => {
    if (!overlay || !writer || writing.current) return;
    writing.current = true; setBusy(true); setNotice('');
    try {
      const result = await writer.selectCandidate({ issue: text(contract.id), version: Number(contract.version), candidate: text(record(trace.candidate).candidate_id), expectedVersion: Number(overlay.selection?.version), operationId: overlay.operation!, reason: overlay.value.trim() });
      if (record(result.issue).id !== contract.id || record(result.issue).version !== contract.version || record(result.selection).candidate_id !== record(trace.candidate).candidate_id) throw new Error('Selection 返回身份不匹配，请重新读取确认');
      const selection = record(result.selection); change({ selection }); setHistory(h => h.map(s => s.issue?.id === contract.id && s.issue?.version === contract.version ? { ...s, selection } : s));
      setPendingSelection(undefined); setNotice('人工选择已记录；不表示已合入。'); setOverlay(undefined);
    } catch (e) { setPendingSelection({ overlay, candidate: text(record(trace.candidate).candidate_id), issue: text(contract.id), version: Number(contract.version) }); setOverlay(undefined); setNotice(`选择未确认：${e instanceof Error ? e.message : String(e)}。请刷新后核对；同一次重试可在操作菜单复用操作 ID。`); }
    finally { writing.current = false; setBusy(false); }
  };
  useInput((input, key) => {
    if (key.ctrl && input === 'g' && onHome && !overlay && !legacy && !busy && !writing.current) { onHome(); return; }
    if (key.ctrl && input === 'e' && onEval && !busy && !writing.current) { onEval(); return; }
    if (legacy) return;
    if (writing.current) return;
    if (key.escape) {
      if (screen.page === 'requirement' && !overlay) {
        if (screen.requirementTab === 'issues' && screen.issueDetail) back();
        else if (screen.requirementTab === 'issues') { request.current?.abort(); setBusy(false); change({ requirementTab: 'requirement' }); }
        else returnToRequirementSearch();
      } else if (screen.page === 'review' && !overlay && screen.focus === 1) change({ focus: 0 });
      else if (screen.page === 'issues' && !overlay && (screen.filter || !history.length)) { request.current?.abort(); setBusy(false); change({ filter: '', row: 0, focus: 0 }); }
      else back();
      return;
    }
    if (overlay) {
      if (overlay.kind === 'confirm') { if (key.return) void confirm(); return; }
      if (overlay.kind === 'help' || overlay.kind === 'evidence') { const step = key.pageDown ? panelHeight - 1 : key.pageUp ? 1 - panelHeight : key.downArrow ? 1 : key.upArrow ? -1 : 0; if (step || key.home || key.end) setOverlay({ ...overlay, row: bound(key.home ? 0 : key.end ? overlayLines.length : overlay.row + step, overlayLines.length - panelHeight + 1) }); return; }
      if (key.return) {
        if (overlay.kind === 'reason') { if (!overlay.value.trim() && record(trace.verification_set).standing !== 'qualified') { setNotice('当前候选未达 qualified；核心规则要求填写选择理由。'); return; } setOverlay({ ...overlay, kind: 'confirm', title: '确认人工选择（Enter 提交 / Esc 取消）' }); }
        else if (overlay.kind === 'search') { if (screen.focus === 0 && !codePage) change({ filter: overlay.value, row: 0, scroll: 0 }); else { const lines = codePage && screen.focus === 2 ? basisLines : bodyLines; const found = lines.findIndex(l => l.toLowerCase().includes(overlay.value.toLowerCase())); if (found >= 0) change(screen.focus === 2 ? { basisScroll: found } : { scroll: found }); else setNotice('当前面板未找到匹配'); } setOverlay(undefined); }
        else { const list = overlay.actions?.filter(a => a.label.toLowerCase().includes(overlay.value.toLowerCase())) ?? []; const a = list[bound(overlay.row, list.length - 1)]; setOverlay(undefined); a?.run(); }
        return;
      }
      if (overlay.kind === 'menu' && (key.upArrow || key.downArrow)) { const list = overlay.actions?.filter(a => a.label.toLowerCase().includes(overlay.value.toLowerCase())) ?? []; setOverlay({ ...overlay, row: bound(overlay.row + (key.downArrow ? 1 : -1), list.length - 1) }); return; }
      if (key.backspace || key.delete) setOverlay({ ...overlay, value: Array.from(overlay.value).slice(0, -1).join(''), row: 0 });
      else if (!key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) setOverlay({ ...overlay, value: overlay.value + clean(input).replace(/[\r\n]/g, ''), row: 0 });
      return;
    }
    if (screen.page === 'requirement') {
      if (key.ctrl && input === 'c') { onExit(); return; }
      if (input === '?') {
        setOverlay({ kind: 'help', title: '需求与关联 Issue 操作', body: 'Tab/Ctrl+T 切换 Requirement 与 Issue 页签；切换后保留正文、列表和详情位置。\nIssue 列表：输入标题或 ID 筛选，↑↓ 选择，Enter 查看详情。\nIssue 详情：↑↓/PgUp/PgDn 阅读，Enter 显式查看 Candidate，Esc 返回关联列表。\nIssue 列表按 Esc 返回 Requirement 详情；Requirement 详情按 Esc 返回需求搜索。\nCtrl+R 刷新当前需求及关联列表；Ctrl+C 退出。', value: '', row: 0 });
        return;
      }
      if (key.tab || (key.ctrl && input === 't')) { request.current?.abort(); setBusy(false); change({ requirementTab: screen.requirementTab === 'issues' ? 'requirement' : 'issues' }); return; }
      if (key.ctrl && input === 'r') {
        run(async signal => {
          const current = screen.requirement!;
          const latest = await loadRequirement(text(current.id), signal);
          if (latest.requirement.version !== current.version) { setNotice(`Requirement 已升至 v${text(latest.requirement.version)}；返回需求搜索后重新打开。`); return; }
          if (!signal.aborted) {
            const before = new Map(screen.rows.map(item => [text(item.id), item]));
            const after = new Map(latest.linked.map(item => [text(item.id), item]));
            const added = latest.linked.filter(item => !before.has(text(item.id))).length;
            const removed = screen.rows.filter(item => !after.has(text(item.id))).length;
            const revised = latest.linked.filter(item => {
              const old = before.get(text(item.id));
              return old && (old.version !== item.version || old.requirementVersion !== item.requirementVersion);
            }).length;
            setScreen(previous => previous.page === 'requirement' && previous.requirement?.id === current.id ? { ...previous, requirement: latest.requirement, rows: latest.linked, row: bound(previous.row, latest.linked.length - 1) } : previous);
            setHistory(previous => previous.map(item => item.page === 'requirement' && item.requirement?.id === current.id ? { ...item, requirement: latest.requirement, rows: latest.linked, row: bound(item.row, latest.linked.length - 1) } : item));
            setNotice(`关联 Issue：新增 ${added}、移除 ${removed}、更新 ${revised}；已打开的 Issue 详情保留原版本。`);
          }
        });
        return;
      }
      if (busy) return;
      if (screen.requirementTab === 'requirement') {
        const lines = requirementLines(screen.requirement!, requirementWidth(width));
        const bodySize = requirementLayout(height, 2);
        const step = key.downArrow ? 1 : key.upArrow ? -1 : key.pageDown ? bodySize : key.pageUp ? -bodySize : 0;
        if (step || key.home || key.end) change({ requirementScroll: bound(key.home ? 0 : key.end ? lines.length : (screen.requirementScroll ?? 0) + step, lines.length - bodySize) });
        return;
      }
      if (screen.issueDetail) {
        if (key.return) { enter(); return; }
        const lines = issueDetailLines(screen.issueDetail, requirementWidth(width));
        const bodySize = requirementLayout(height, 2);
        const step = key.downArrow ? 1 : key.upArrow ? -1 : key.pageDown ? bodySize : key.pageUp ? -bodySize : 0;
        if (step || key.home || key.end) change({ issueScroll: bound(key.home ? 0 : key.end ? lines.length : (screen.issueScroll ?? 0) + step, lines.length - bodySize) });
        return;
      }
      if (key.return) { enter(); return; }
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) {
        const step = key.pageDown ? Math.max(1, height - 8) : key.pageUp ? 8 - height : key.downArrow ? 1 : key.upArrow ? -1 : 0;
        change({ row: bound(key.home ? 0 : key.end ? rows.length - 1 : row + step, rows.length - 1) }); return;
      }
      if (key.backspace || key.delete) { change({ filter: Array.from(screen.filter).slice(0, -1).join(''), row: 0 }); return; }
      if (!key.ctrl && !key.meta && input === '/') { change({ filter: '', row: 0 }); return; }
      if (!key.ctrl && !key.meta && input) change({ filter: screen.filter + clean(input).replace(/[\r\n]/g, ''), row: 0 });
      return;
    }
    if (screen.page === 'issues' && input === '?') {
      const body = '输入标题或 ID 搜索 · Backspace 删除 · ↑↓ 选择结果 · Enter 打开 · Tab 切换最近一周/搜索 · Esc 清空/返回 · Ctrl+T 切换需求/任务 · Ctrl+R 刷新 · Ctrl+C 退出';
      setOverlay({ kind: 'help', title: '当前页面全部操作', body: body + (onHome ? ' · Ctrl+G 返回首页' : ''), value: '', row: 0 });
      return;
    }
    if (screen.page === 'issues') {
      if (key.ctrl && input === 'c') { onExit(); return; }
      if (key.ctrl && input === 't') { run(async signal => { const kind = screen.searchKind === 'requirements' ? 'issues' : 'requirements'; const result = await reader.query(kind, [], signal); if (!signal.aborted) push({ ...initial(), searchKind: kind, rows: recentIssues(objects(result.resources)) }); }); return; }
      if (key.ctrl && input === 'r') { run(loadIssues); return; }
      if (key.tab) { change({ focus: screen.focus === 1 ? 0 : 1, row: 0 }); return; }
      if (key.return) { if (!busy) enter(); return; }
      if (key.upArrow || key.downArrow) { change({ row: bound(row + (key.downArrow ? 1 : -1), rows.length - 1) }); return; }
      if (key.backspace || key.delete) { change({ filter: Array.from(screen.filter).slice(0, -1).join(''), row: 0, focus: 0 }); return; }
      if (!key.ctrl && !key.meta && input) change({ filter: screen.filter + clean(input).replace(/[\r\n]/g, ''), row: 0, focus: 0 });
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c' && !tabbedPage)) { onExit(); return; }
    if (input === ':') { showMenu('操作（可搜索）', actions); return; }
    if (input === '?') { setOverlay({ kind: 'help', title: '当前页面帮助', body: `当前页全部快捷键：${pageHints.join(' · ')}\n\n实体颜色：蓝色 目标 · 绿色 当前页签 · 青色 当前项；状态以文字和符号为准。\n焦点：› 当前项标记；总览用粗体和青色强调。\n契约总览：✓ 绿色表示满足；× 红色表示明确未满足；△ 黄色表示部分满足；… 灰色表示未记录、未提交或待载入；? 黄色表示未覆盖或无法判断；! 黄色表示报告结论不一。目标与约束两列附已满足子标准数/总数，只汇总子标准，不作目标级判定。\n页签：Tab 在固定契约与代码变更间切换；返回时保留各页位置。\n代码审阅：标准或目标详情按 Enter 审阅关联 diff；代码页按 s 切换范围。\n原始报告：在 : 操作菜单查看；日常验收优先阅读标准详情。\n\n菜单可执行操作：\n${actions.map(a => a.label).join('\n')}\n\n连接 ${context.driver} · CLI ${context.version}\n${context.configSource}`, value: '', row: 0 }); return; }
    if (input === '/') { setOverlay({ kind: 'search', title: screen.focus === 0 && !codePage ? '筛选当前目录' : '搜索当前面板（跳至首个匹配）', value: '', row: 0 }); return; }
    if (busy) return;
    if (codePage && input === 's') { actions.find(a => a.id === 'scope')?.run(); return; }
    if (key.tab && tabbedPage) { if (!key.shift) { if (codePage) returnToReview(); else openCodeTab(); } return; }
    if (reviewOutline && screen.focus === 0 && selected?.parent && input === ' ') { const id = text(selected.resource_id); change({ collapsed: screen.collapsed.includes(id) ? screen.collapsed.filter(x => x !== id) : [...screen.collapsed, id] }); return; }
    if (key.return) { if (!codePage) enter(); return; }
    if (key.rightArrow) { if (codePage) change({ focus: Math.min(2, screen.focus + 1) }); else if (!reviewOutline) enter(); return; }
    if (key.leftArrow && codePage) { change({ focus: Math.max(wideCode ? 0 : 1, screen.focus - 1) }); return; }
    if (key.leftArrow && !reviewOutline) { back(); return; }
    if (!tabbedPage && input === 'r') { actions.find(a => a.id === 'refresh')!.run(); return; }
    if (codePage && (input === '[' || input === ']')) { moveBlock(unitIndex + (input === ']' ? 1 : -1)); return; }
    const readingPage = screen.focus === 1 ? bodyViewport : panelHeight - 1;
    const delta = key.downArrow || (!tabbedPage && input === 'j') ? 1 : key.upArrow || (!tabbedPage && input === 'k') ? -1 : key.pageDown ? readingPage : key.pageUp ? -readingPage : 0;
    if (delta) {
      if (screen.focus === 0) { if (codePage) moveBlock(screen.row + delta); else change({ row: bound(screen.row + delta, rows.length - 1), scroll: 0 }); }
      else if (screen.focus === 2) change({ basisScroll: bound(screen.basisScroll + delta, basisLines.length - (panelHeight - 1)) });
      else change({ scroll: bound((codePage ? codeScroll : screen.scroll) + delta, bodyLines.length - bodyViewport) });
    }
  });
  if (legacy) return <App reader={reader} context={context} onExit={() => setLegacy(false)} width={widthOverride} height={heightOverride} />;
  if (width < 40 || height < 10) return <Text wrap="truncate">请扩大终端至 40×10；q 退出</Text>;
  if (screen.page === 'requirement' && !overlay) return <RequirementView requirement={screen.requirement!} activeTab={screen.requirementTab ?? 'requirement'} rows={rows} total={screen.rows.length} query={screen.filter} row={row} requirementScroll={screen.requirementScroll ?? 0} issueScroll={screen.issueScroll ?? 0} issueDetail={screen.issueDetail} busy={busy} notice={notice} width={width} height={height} />;
  if (screen.page === 'issues' && !overlay) return <SearchHome homeAvailable={Boolean(onHome)} evalAvailable={Boolean(onEval)} kind={screen.searchKind ?? 'issues'} items={screen.rows} results={rows} query={screen.filter} row={row} recent={screen.focus === 1} busy={busy} notice={notice} width={width} height={height} />;
  const renderLines = (lines: string[], scroll: number, w: number, diff = false, visible = panelHeight - 1) => <Box flexDirection="column" width={w} height={visible} overflow="hidden">{lines.slice(bound(scroll, lines.length - visible), bound(scroll, lines.length - visible) + visible).map((line, i) => <Text key={i} wrap="truncate" color={process.env.NO_COLOR !== undefined ? undefined : diff && line.startsWith('+') ? 'green' : diff && line.startsWith('-') ? 'red' : undefined}>{line || ' '}</Text>)}</Box>;
  const dirRows: Data[] = codePage ? files.map((b, i) => ({ resource_id: text(b.unit.change_unit_id), label: `${i + 1}. ${association(trace, b).problems.length ? '[待核查] ' : ''}${text(b.unit.display_path)} · ${b.unit.kind === 'file' ? '文件级变更' : rangeLabel(b.unit.new_range)}` })) : rows;
  const dirWidth = leftWidth || width - 2;
  const dirStart = Math.max(0, screen.row - panelHeight + 2);
  const outlineLines: OutlineLine[] = reviewOutline ? dirRows.flatMap((r, index) => {
    const parent = Boolean(r.parent);
    const indent = r.criterion ? '  ' : '';
    const parentStatement = parent ? label(r.label).slice(label(r.label).indexOf(']') + 1).trim() : '';
    const title = r.criterion ? `${criterionNumber(trace, r.criterion as Criterion)}  ${label((r.criterion as Criterion).statement)}`
      : parent ? `${screen.collapsed.includes(text(r.resource_id)) ? '▸' : '▾'} ${text(r.shortLabel)}  ${parentStatement}`
      : label(r.label);
    const lines: OutlineLine[] = parent ? [{ row: index, value: ' ', kind: 'space', parent }] : [];
    const checks = r.criterion ? outlineCriterionChecks(trace, r.criterion as Criterion, reports, count)
      : parent ? outlineTargetChecks(trace, text(r.targetType), text(r.targetId), reports, count) : undefined;
    const pointer = `${index === row ? '› ' : '  '}  `;
    const cells = checks ? ' '.repeat(statusColumnsWidth) : '';
    const firstWidth = Math.max(1, dirWidth - stringWidth(pointer + cells + indent));
    const first = fold([title], firstWidth)[0] ?? '';
    lines.push({ row: index, value: checks ? `${indent}${first}` : `${pointer}${first}`, lead: checks ? pointer : undefined, checks, kind: 'title', parent });
    const remainder = title.slice(first.length).trimStart();
    if (remainder) lines.push(...fold([remainder], Math.max(1, dirWidth - stringWidth(pointer + cells + indent))).map(part => ({ row: index, value: `${' '.repeat(stringWidth(pointer + cells))}${indent}${part}`, kind: 'title' as const, parent })));
    return lines;
  }) : [];
  const outlineEnd = outlineLines.reduce((end, line, index) => line.row === row ? index + 1 : end, 0);
  const outlineHeaderLines = Math.min(2, Math.max(0, panelHeight - 1));
  const outlineViewport = Math.max(1, panelHeight - outlineHeaderLines);
  const selectedTitleStart = outlineLines.findIndex(line => line.row === row && line.kind === 'title');
  const outlineStart = Math.max(0, Math.min(selectedTitleStart, outlineEnd - outlineViewport));
  const menuHeaderLines = Math.min(2, Math.max(0, panelHeight - 1));
  const menuViewport = Math.max(1, panelHeight - menuHeaderLines);
  const outlineMeta = `目标 ${objects(contract.goals).length} · 约束 ${objects(contract.constraints).length} · 标准 ${allCriteria.length} · 独立报告 ${count ? `${reports.length}/${count} 已载入` : '未提交'}`;
  const dir = reviewOutline ? <Box flexDirection="column" width={dirWidth} overflow="hidden">{outlineHeaderLines === 2 && <Text dimColor wrap="truncate">{`  ${outlineMeta}`}</Text>}{outlineHeaderLines >= 1 && <Text bold color={process.env.NO_COLOR !== undefined ? undefined : 'cyan'} wrap="truncate">{`    ${statusCell('自验', selfColumnWidth)}${statusCell('独立验证', independentColumnWidth)}`}</Text>}{outlineLines.slice(outlineStart, outlineStart + outlineViewport).map((line, index) => <OutlineText key={`${outlineStart + index}`} line={line} selected={line.row === row && screen.focus === 0} />)}</Box>
    : <Box flexDirection="column" width={dirWidth} overflow="hidden"><PanelBar title={codePage ? `${scopeLabel(trace, screen.scope).split(' · ')[0]} · 变更` : screen.title} active={screen.focus === 0} width={dirWidth} />{dirRows.slice(dirStart, dirStart + panelHeight - 1).map((r, i) => <Text key={text(r.resource_id)} inverse={dirStart + i === screen.row} bold={dirStart + i === screen.row && screen.focus === 0} wrap="truncate">{dirStart + i === screen.row ? '› ' : '  '}<Text color={dirStart + i === screen.row ? undefined : process.env.NO_COLOR !== undefined ? undefined : r.parent || r.criterion || screen.page === 'issues' ? 'blueBright' : 'magentaBright'}>{r.criterion ? `${criterionNumber(trace, r.criterion as Criterion)} ` : r.parent ? label(r.label).split(']')[0] + '] ' : ''}</Text>{r.criterion ? label((r.criterion as Criterion).statement) : r.parent ? label(r.label).slice(label(r.label).indexOf(']') + 1).trim() : `${r.is_selected ? '[已选择] ' : ''}${label(r.label)}`}</Text>)}</Box>;
  const overlayLines = overlay ? overlay.kind === 'confirm' || overlay.kind === 'reason' ? fold([`Issue ${contract.id} · v${contract.version}`, `原候选：${text(overlay.selection?.candidate_id) || '未选择'}`, `新候选：${record(trace.candidate).candidate_id}`, `Selection 并发版本：${overlay.selection?.version}`, `独立报告集合：${count} 份 · ${text(record(trace.verification_set).standing)} · 已加载 ${reports.length} 份`, `记录身份：${overlay.identity ?? "本目录的 Git 人类身份"}`, '选择不表示验收通过或已合入。', `理由：${overlay.value}`, ...(overlay.kind === 'reason' ? ['输入理由后 Enter，下一步确认。'] : [])], width - 4) : overlay.kind === 'basis' ? renderMarkdown((overlay.body ?? '').split('\n'), Math.min(104, width - 4), true) : fold((overlay.body ?? '').split('\n'), width - 4) : [];
  const menuItems = overlay?.actions?.filter(a => a.label.toLowerCase().includes(overlay.value.toLowerCase())) ?? [];
  const operationBar = <Box width={width} height={hintLines.length} flexDirection="column">{hintLines.map((line, index) => <Text key={index} bold={index === 0} color={process.env.NO_COLOR === undefined ? 'green' : undefined} wrap="truncate">{line}</Text>)}</Box>;
  const compactTabs = width < 65;
  const tabs = tabbedPage ? <Text wrap="truncate"><Text bold={reviewOutline} underline={reviewOutline} color={process.env.NO_COLOR !== undefined ? undefined : reviewOutline ? 'green' : 'gray'}>{`${reviewOutline ? '▸' : ' '} ${compactTabs ? '契约' : '固定契约 · 总览'}`}</Text><Text dimColor>  │  </Text><Text bold={codePage} underline={codePage} color={process.env.NO_COLOR !== undefined ? undefined : codePage ? 'green' : 'gray'}>{`${codePage ? '▸' : ' '} ${compactTabs ? `代码 ${allBlocks.length}` : `代码变更 · ${allBlocks.length} 处`}`}</Text></Text> : null;
  const operationOnTop = codePage || reviewOutline;
  return <Box flexDirection="column" width={width} height={Math.max(8, height - 1)}>
    <Text color={process.env.NO_COLOR !== undefined ? undefined : 'cyan'} bold wrap="truncate">有据 Grounds · 候选审阅 · {label(screen.issue?.summary ?? screen.title)}</Text>
    <Text wrap="truncate">{label(codePage ? `范围：${scopeLabel(trace, screen.scope)} · 当前 ${block ? unitIndex + 1 : 0}/${scopeBlocks.length}` : screen.filter ? `目录筛选：${screen.filter}` : screen.issue ? `Issue v${screen.issue.version} · Candidate ${shortId(record(trace.candidate).candidate_id) || '待选择'} · ${screen.selection?.candidate_id === record(trace.candidate).candidate_id && screen.selection?.candidate_id ? '[已选择]' : '未选择此候选'}` : '最近业务活动优先；r 手动刷新')} </Text>
    {spaciousHeader && <Box height={1} />}
    {tabs}
    {spaciousHeader && <Box height={1} />}
    {operationOnTop && operationBar}
    <Box borderStyle="single" width={width} height={panelHeight + 2} overflow="hidden">
      {overlay ? <Box flexDirection="column" width={width - 2}>{(overlay.kind !== 'menu' || menuHeaderLines === 2) && <Text bold color={process.env.NO_COLOR !== undefined ? undefined : 'cyan'} wrap="truncate">{label(overlay.title)}</Text>}{overlay.kind === 'menu' ? <>{menuHeaderLines >= 1 && <Text wrap="truncate">搜索：{overlay.value}</Text>}{menuItems.slice(Math.max(0, overlay.row - menuViewport + 1), Math.max(0, overlay.row - menuViewport + 1) + menuViewport).map(a => <Text key={a.id} inverse={menuItems.indexOf(a) === overlay.row} wrap="truncate">{label(a.label)}</Text>)}</> : overlay.kind === 'search' ? <Text wrap="truncate">{overlay.value}▏</Text> : renderLines(overlayLines, bound(overlay.row, overlayLines.length - panelHeight + 1), width - 2)}</Box>
        : <>{(leftWidth > 0 || (!codePage && screen.focus === 0)) && dir}{leftWidth > 0 && <Box width={1}><Text>{Array(panelHeight).fill('│').join('\n')}</Text></Box>}
          {(leftWidth > 0 || codePage || screen.focus !== 0) && <Box flexDirection="column" width={codePage && !splitCode ? width - 2 : bodyWidth}><PanelBar active={screen.focus === 1 || (codePage && !splitCode && screen.focus === 2)} width={bodyWidth} title={codePage ? `${block?.unit.display_path ?? '无文本变更'} · ${!splitCode && screen.focus === 2 ? '关联依据' : '固定 diff'}` : activeCriterion ? `标准 ${criterionNumber(trace, activeCriterion)}` : label(selected?.shortLabel ?? selected?.label ?? '固定契约')} />{detailHint && <Text bold color={process.env.NO_COLOR !== undefined ? undefined : 'cyan'} wrap="truncate">{detailHint}</Text>}{codePage && !splitCode && screen.focus === 2 ? renderLines(basisLines, screen.basisScroll, width - 2) : renderLines(bodyLines, codePage ? codeScroll : screen.scroll, bodyWidth, codePage, bodyViewport)}</Box>}
          {splitCode && <><Box width={1}><Text>{Array(panelHeight).fill('│').join('\n')}</Text></Box><Box flexDirection="column" width={basisWidth}><PanelBar title="关联依据 · 摘要" active={screen.focus === 2} width={basisWidth} />{renderLines(basisLines, screen.basisScroll, basisWidth - 1)}</Box></>}
        </>}
    </Box>
    <Text dimColor wrap="truncate">{overlay ? `详情 ${Math.min(overlay.row + 1, Math.max(1, overlayLines.length))}/${Math.max(1, overlayLines.length)}` : `目录 ${codePage ? scopeBlocks.length ? unitIndex + 1 : 0 : rows.length ? row + 1 : 0}/${codePage ? scopeBlocks.length : rows.length} · ${screen.focus === 0 ? '焦点：目录' : screen.focus === 2 ? '焦点：关联依据' : '焦点：正文'} · 正文 ${Math.min((codePage ? codeScroll : bound(screen.scroll, bodyLines.length - bodyViewport)) + 1, Math.max(1, bodyLines.length))}/${Math.max(1, bodyLines.length)} 行`}</Text>
    {!operationOnTop && operationBar}
  </Box>;
}
