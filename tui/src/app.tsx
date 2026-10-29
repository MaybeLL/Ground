import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createHash } from 'node:crypto';
import { Box, Text, useInput, useStdout } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { clean, markdownLocations, markdownWindow, renderMarkdown } from './markdown.js';
import type { Context, Reader } from './client.js';
import { array, describe, type Route } from './pages.js';
import { ClientError } from './protocol.js';
import { Workspace, detailKey, screenKey, text as valueText } from './workspace.js';
import { bodyMarkdown, flatten, resolveNode, type Node, type Task } from './details.js';
import { directoryNodes, directoryPath } from './directory.js';
import { initial, navigate, Positions } from './navigation.js';
import { operationHintLines } from './operation-hints.js';
export { initial, navigate } from './navigation.js';
export { clean } from './markdown.js';
export const fold = (lines: string[], width: number) => lines.flatMap(line => wrapAnsi(clean(line), Math.max(1, width), { hard: true, trim: false }).split('\n'));
export const directoryWidth = (width: number) => width >= 100 ? Math.min(64, Math.max(38, Math.floor(width * 0.3))) : width;
const message = (e: unknown) => e instanceof Error ? `${e instanceof ClientError ? e.code : 'ERROR'}: ${e.message}` : String(e);
const label = (s: string) => clean(s).replace(/[\r\n\t]/g, ' ');
const clamp = (n: number, max: number) => Math.max(0, Math.min(n, Math.max(0, max)));
const preview = (node: Node): unknown => {
  if (node.body !== undefined) return node.body;
  const sections = (node.children ?? []).flatMap(child => child.body === undefined ? [] : [`## ${child.label}`, ...bodyMarkdown(child.body), '']);
  return sections.length ? [`# ${node.label}`, '', ...sections].join('\n') : node.task ? '内容尚未加载' : node.label;
};

export function App({ reader, context, onExit, width: widthOverride, height: heightOverride }: { reader: Reader; context: Context; onExit: () => void; width?: number; height?: number }) {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns || 100, height: stdout.rows || 30 });
  useEffect(() => { const resize = () => setSize({ width: stdout.columns || 100, height: stdout.rows || 30 }); stdout.on('resize', resize); return () => { stdout.off('resize', resize); }; }, [stdout]);
  const width = widthOverride ?? size.width, height = heightOverride ?? size.height, wide = width >= 100;
  const [nav, dispatch] = useReducer(navigate, initial);
  const workspace = useMemo(() => new Workspace(reader), [reader, context.databaseId, context.configSource]);
  const positions = useRef(new Positions());
  const [, render] = useReducer(n => n + 1, 0);
  const [busy, setBusy] = useState(false), [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState(''), [previewError, setPreviewError] = useState(''), [notice, setNotice] = useState('');
  const [input, setInput] = useState<'search' | 'goto' | 'body-search'>();
  const [draft, setDraft] = useState(''), [caret, setCaret] = useState(0);
  const [help, setHelp] = useState(false);
  const [bodyQuery, setBodyQuery] = useState('');
  const readingCursor = useRef<number | undefined>(undefined);
  const [task, setTask] = useState<string>(), [taskError, setTaskError] = useState<{ id: string; message: string }>();
  const [retry, setRetry] = useState(0);
  const [compareSide, setCompareSide] = useState(0), [compareScroll, setCompareScroll] = useState([0, 0]);
  const pageGeneration = useRef(0), previewGeneration = useRef(0), taskController = useRef<AbortController | undefined>(undefined);
  const lastRefresh = useRef(0), lastPreviewRefresh = useRef(0), lastRetry = useRef(0);
  const routeKey = screenKey(nav.route), page = workspace.screen(nav.route);
  const rows = useMemo(() => [
    ...(page?.rows ?? []).filter(r => r.id.startsWith('__') || (r.label + r.id).toLowerCase().includes(nav.search.toLowerCase())),
    ...(page?.singlePage && page.cursors?.length ? [{ id: '__prev', label: '上一页', route: page.route, pageAction: 'prev' as const }] : []),
    ...(page?.next ? [{ id: '__next', label: '加载更多 Issue', route: page.route, pageAction: 'next' as const }] : []),
  ], [page, nav.search]);
  const selectedIndex = nav.selected ? rows.findIndex(r => r.id === nav.selected) : -1;
  const row = selectedIndex >= 0 ? selectedIndex : clamp(nav.row, rows.length - 1), selected = rows[row];
  const detailRoute = selected?.route;
  const dk = detailRoute ? detailKey(detailRoute) : '';
  workspace.cache.pin([routeKey, dk]);
  const detail = detailRoute ? workspace.detail(detailRoute) : undefined;
  const status = error ? `${page ? '刷新失败，旧数据 · ' : ''}${error}` : notice || nav.notice
    || (busy ? page ? '刷新中，仍显示旧数据' : '读取中…' : page?.warnings?.[0] ?? detail?.note ?? page?.note ?? '');
  const compare = nav.route.kind === 'compare';
  const leftWidth = directoryWidth(width);
  const detailWidth = wide ? width - leftWidth - 1 : width - 2;
  const state = positions.current.get(routeKey);
  const directory = directoryNodes(page, selected, detail);
  const visible = flatten(directory, state.expanded);
  const nodeIndex = resolveNode(visible, state.selected), active = visible[nodeIndex];
  const pageHintParts = input ? ['输入文字', '←/→ 移动光标', 'Home/End 首尾', 'Backspace/Delete 删除', 'Enter 确认', 'Esc 取消', 'Ctrl+C 退出']
      : compare ? ['↑↓/j/k 滚动', 'PgUp/PgDn 翻页', 'Home/End 首尾', ...(wide ? [] : ['←/→/Tab 切换 A/B']), 'r 刷新', 'Esc 返回', '? 帮助', 'q/Ctrl+C 退出']
        : nav.focus === 'detail' ? ['↑↓/j/k 滚动', 'PgUp/PgDn 翻页', 'Home/End 首尾', 'Tab/Esc/← 返回目录', '/ 搜索正文', 'n/N 匹配', '[ / ] 章节', '? 帮助', 'q/Ctrl+C 退出']
          : ['↑↓/j/k 选择', 'PgUp/PgDn 翻页', 'Home/End 首尾', '←/→ 层级', 'Enter 展开/打开/阅读', 'Tab 查看正文', '/ 筛选', 'r 刷新', ...(page?.next ? ['n 下一页'] : []), ...(page?.singlePage && page.cursors?.length ? ['p 上一页'] : []), ...(nav.route.kind === 'issue' && active?.node.resourceId && rows.find(item => item.id === active.node.resourceId)?.candidate ? ['Space 标记候选'] : []), ...(nav.route.kind === 'issue' && nav.marked.length === 2 ? ['c 对比已标记候选'] : []), ...(nav.route.kind === 'home' ? ['g 输入 Candidate ID'] : []), 'Esc 返回', '? 帮助', 'q/Ctrl+C 退出'];
  const hintParts = help ? ['Esc/? 关闭帮助', 'Ctrl+C 退出'] : pageHintParts;
  const hintLines = operationHintLines(hintParts, width, Math.max(1, Math.min(5, height - 16)));
  const bodyHeight = Math.max(1, height - 5 - (status ? 1 : 0) - hintLines.length - (input ? 1 : 0));
  const readingRows = Math.max(1, bodyHeight - 1);

  useEffect(() => {
    const controller = new AbortController(), generation = ++pageGeneration.current;
    const force = nav.refresh !== lastRefresh.current; lastRefresh.current = nav.refresh;
    setBusy(true); setError(''); setNotice('');
    workspace.loadScreen(nav.route, controller.signal, force).then(screen => {
      if (controller.signal.aborted || generation !== pageGeneration.current) return;
      const defaultRow = screen.rows[0];
      dispatch({ type: 'resolved', route: screen.route, selected: defaultRow?.id }); render();
    }).catch(e => { if (!controller.signal.aborted && generation === pageGeneration.current) setError(message(e)); })
      .finally(() => { if (!controller.signal.aborted && generation === pageGeneration.current) setBusy(false); });
    return () => { controller.abort(); taskController.current?.abort(); };
  }, [workspace, routeKey, nav.refresh]);

  useEffect(() => {
    const controller = new AbortController(), generation = ++previewGeneration.current;
    taskController.current?.abort(); setTask(undefined); setTaskError(undefined); setPreviewError('');
    if (!detailRoute || nav.route.kind === 'compare' || busy) { setPreviewBusy(false); return () => controller.abort(); }
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      const force = nav.refresh !== lastPreviewRefresh.current || retry !== lastRetry.current;
      workspace.loadDetail(detailRoute, controller.signal, force).then(() => {
        if (!controller.signal.aborted && generation === previewGeneration.current) { lastPreviewRefresh.current = nav.refresh; lastRetry.current = retry; render(); }
      }).catch(e => { if (!controller.signal.aborted && generation === previewGeneration.current) setPreviewError(message(e)); })
        .finally(() => { if (!controller.signal.aborted && generation === previewGeneration.current) setPreviewBusy(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); taskController.current?.abort(); };
  }, [workspace, dk, nav.refresh, retry, page, busy]);

  useEffect(() => {
    if (!visible.length) return;
    const resolved = resolveNode(visible, state.selected);
    if (!state.selected || !visible.some(item => item.node.id === state.selected)) state.selected = visible[resolved]?.node.id;
  }, [routeKey, dk, visible.length]);
  const readingNode = active?.node;
  const readingPath = directoryPath(directory, readingNode?.id ?? '')?.join(' / ') ?? '';
  const source = readingNode ? bodyMarkdown(preview(readingNode)) : ['选择目录节点查看内容'];
  const digest = createHash('sha256').update(source.join('\n')).digest('hex');
  const locations = useMemo(() => readingNode ? markdownLocations(source, detailWidth, bodyQuery) : { matches: [], chapters: [] }, [digest, detailWidth, bodyQuery]);
  useEffect(() => { setBodyQuery(''); readingCursor.current = undefined; }, [readingNode?.id, dk]);
  const saved = readingNode ? state.readings[readingNode.id] : undefined;
  const rawOffset = saved?.digest === digest ? saved.line : 0;
  const metrics = markdownWindow(source, detailWidth, rawOffset, readingRows);
  const adjusted = saved && saved.digest === digest && saved.width !== detailWidth ? Math.round(saved.line / Math.max(1, saved.total - readingRows) * Math.max(0, metrics.total - readingRows)) : rawOffset;
  const offset = clamp(adjusted, metrics.total - readingRows);
  const readingView = offset === rawOffset ? metrics : markdownWindow(source, detailWidth, offset, readingRows);
  useEffect(() => {
    if (!readingNode) return;
    if (saved && saved.width !== detailWidth) setNotice('窗口宽度变化：已近似恢复阅读位置');
    else if (saved && saved.digest !== digest && saved.line > 0) setNotice('正文变化：已返回顶部');
    state.readings[readingNode.id] = { line: offset, total: metrics.total, width: detailWidth, digest };
    positions.current.trim(state);
  }, [readingNode?.id, digest, detailWidth, offset, metrics.total]);

  const compareData = array(page?.overview?.candidates);
  const comparisonWidth = wide ? Math.floor(width / 2) - 2 : width - 2;
  const comparisons = compareData.map((c, i) => markdownWindow(describe(c), comparisonWidth, compareScroll[wide ? 0 : i], bodyHeight - 1));
  const seek = (line: number) => {
    if (!readingNode) return;
    readingCursor.current = line;
    state.readings[readingNode.id] = { line: clamp(line, metrics.total - readingRows), total: metrics.total, width: detailWidth, digest }; render();
  };
  const jump = (lines: number[], backwards = false) => {
    const at = readingCursor.current ?? offset;
    const line = backwards ? [...lines].reverse().find(n => n < at) ?? lines.at(-1) : lines.find(n => n > at) ?? lines[0];
    if (line !== undefined) seek(line);
  };
  const runTask = (node: Node, operation: Task) => {
    if (!detailRoute || task || busy || previewBusy) return;
    const controller = new AbortController(); taskController.current?.abort(); taskController.current = controller;
    setTask(node.id); setTaskError(undefined);
    workspace.expand(detailRoute, operation, controller.signal).then(() => { if (!controller.signal.aborted) render(); })
      .catch(e => { if (!controller.signal.aborted) setTaskError({ id: node.id, message: message(e) }); })
      .finally(() => { if (!controller.signal.aborted) setTask(undefined); });
  };
  useEffect(() => {
    if (!detail || busy || previewBusy || task || previewError || taskError) return;
    const pending = visible.find(v => v.node.kind === 'group' && (state.expanded[v.node.id] ?? v.node.defaultOpen) && v.node.task
      && (v.node.task === 'review' ? !detail.review : v.node.task === 'reports' ? !detail.directory : false));
    if (pending) runTask(pending.node, pending.node.task!);
  }, [detail, busy, previewBusy, task, taskError, dk]);
  const open = (route: Route, replace = false) => {
    if (screenKey(route) === routeKey) { dispatch({ type: 'focus', focus: 'list' }); return; }
    dispatch({ type: 'open', route, replace });
  };
  const more = (previous = false) => {
    if (busy) return;
    const controller = new AbortController(); taskController.current?.abort(); taskController.current = controller; setBusy(true); setError('');
    workspace.moreIssues(nav.route, controller.signal, previous).then(p => {
      if (controller.signal.aborted) return;
      if (p.note?.includes('版本变化')) dispatch({ type: 'row', row: 0, selected: p.rows[0]?.id });
      render();
    }).catch(e => { if (!controller.signal.aborted) setError(message(e)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
  };
  const refresh = () => { taskController.current?.abort(); setTask(undefined); setCompareScroll([0, 0]); dispatch({ type: 'refresh' }); };
  const selectNode = (index: number) => {
    const item = visible[clamp(index, visible.length - 1)];
    if (!item) return;
    state.selected = item.node.id;
    const linked = item.node.resourceId ? rows.findIndex(row => row.id === item.node.resourceId) : -1;
    if (linked >= 0 && linked !== row) dispatch({ type: 'row', row: linked, selected: rows[linked]?.id });
    else render();
  };
  useInput((inputText, key) => {
    if (key.ctrl && inputText === 'c') { onExit(); return; }
    if (width < 60 || height < 16) { if (inputText === 'q') onExit(); return; }
    if (help) { if (key.escape || inputText === '?') setHelp(false); return; }
    if (input) {
      if (key.escape) { setInput(undefined); return; }
      if (key.return) {
        if (input === 'body-search') {
          setBodyQuery(draft);
          const found = markdownLocations(source, detailWidth, draft).matches;
          if (found.length) seek(found.find(n => n >= offset) ?? found[0]!);
          setNotice(draft ? found.length ? `找到 ${found.length} 个匹配行 · n/N 切换` : '正文未找到匹配' : '已清除正文搜索');
        }
        else if (input === 'search') dispatch({ type: 'search', search: draft });
        else if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(draft.trim())) open({ kind: 'candidate', id: draft.trim() });
        else { setNotice('请输入完整的 Candidate UUIDv7'); return; }
        setInput(undefined); return;
      }
      const chars = [...draft];
      if (key.leftArrow) setCaret(Math.max(0, caret - 1));
      else if (key.rightArrow) setCaret(Math.min(chars.length, caret + 1));
      else if (key.home) setCaret(0);
      else if (key.end) setCaret(chars.length);
      else if (key.backspace || key.delete) { if (caret) { chars.splice(caret - 1, 1); setDraft(chars.join('')); setCaret(caret - 1); } }
      else if (!key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.pageUp && !key.pageDown) { const inserted = [...label(inputText)]; chars.splice(caret, 0, ...inserted); setDraft(chars.join('')); setCaret(caret + inserted.length); }
      return;
    }
    if (inputText === 'q') { onExit(); return; }
    if (inputText === '?') { setHelp(true); return; }
    const delta = key.downArrow || inputText === 'j' ? 1 : key.upArrow || inputText === 'k' ? -1 : key.pageDown ? bodyHeight : key.pageUp ? -bodyHeight : 0;
    const target = (at: number, max: number) => clamp(key.home ? 0 : key.end ? max : at + delta, max);
    if (compare) {
      if (key.escape) { dispatch({ type: 'back' }); return; }
      if (inputText === 'r') { refresh(); return; }
      if (!wide && (key.leftArrow || key.rightArrow || key.tab)) { setCompareSide(key.tab ? 1 - compareSide : key.leftArrow ? 0 : 1); return; }
      if (delta || key.home || key.end) {
        const side = wide ? 0 : compareSide, max = wide ? Math.max(...comparisons.map(c => c.total), 1) : comparisons[side]?.total ?? 1;
        setCompareScroll(s => s.map((n, i) => i === side ? target(n, max - bodyHeight + 1) : n));
      }
      return;
    }
    if (nav.focus === 'detail') {
      if (key.escape || key.tab || key.leftArrow) { dispatch({ type: 'focus', focus: 'list' }); return; }
      if (inputText === '/') { setDraft(bodyQuery); setCaret([...bodyQuery].length); setInput('body-search'); return; }
      if (inputText === 'n' || inputText === 'N') { jump(locations.matches, inputText === 'N'); return; }
      if (inputText === '[' || inputText === ']') { jump(locations.chapters, inputText === '['); return; }
      if (inputText === 'r') { setNotice('请先返回结构视图刷新'); return; }
      if (delta || key.home || key.end) { readingCursor.current = undefined; if (readingNode) state.readings[readingNode.id] = { line: target(offset, metrics.total - readingRows), total: metrics.total, width: detailWidth, digest }; render(); }
      return;
    }
    if (key.escape) { dispatch({ type: 'back' }); return; }
    if (key.tab) { dispatch({ type: 'focus', focus: 'detail' }); return; }
    if (inputText === 'r') { refresh(); return; }
    if (inputText === '/') { setDraft(nav.search); setCaret([...nav.search].length); setInput('search'); return; }
    if (inputText === 'g' && nav.route.kind === 'home') { setDraft(''); setCaret(0); setInput('goto'); return; }
    if (delta || key.home || key.end) { selectNode(target(nodeIndex, visible.length - 1)); return; }
    if (inputText === ' ' && active?.node.resourceId && rows.find(r => r.id === active.node.resourceId)?.candidate && nav.route.kind === 'issue') {
      dispatch({ type: 'mark', id: active.node.resourceId }); return;
    }
    if (inputText === 'c' && nav.route.kind === 'issue' && nav.marked.length === 2) { open({ kind: 'compare', pair: nav.marked }); return; }
    if (busy || previewBusy || !active) return;
    const node = active.node, expanded = state.expanded[node.id] ?? node.defaultOpen;
    if (key.leftArrow) {
      if (node.kind === 'group' && expanded) { state.expanded[node.id] = false; render(); }
      else { const parent = active.ancestors.at(-1); if (parent) selectNode(resolveNode(visible, parent)); }
      return;
    }
    if (key.rightArrow) {
      if (node.kind === 'group' && !expanded) { state.expanded[node.id] = true; render(); if (node.task) runTask(node, node.task); }
      else if (node.kind === 'group') selectNode(nodeIndex + 1);
      return;
    }
    if (key.return) {
      if (previewError) { setRetry(n => n + 1); return; }
      if (taskError?.id === node.id && node.task) { runTask(node, node.task); return; }
      const linkedRow = node.resourceId ? rows.find(row => row.id === node.resourceId) : undefined;
      if (linkedRow?.pageAction) { more(linkedRow.pageAction === 'prev'); return; }
      if (node.kind === 'group') { state.expanded[node.id] = !expanded; render(); if (!expanded && node.task) runTask(node, node.task); }
      else if (node.route && !(node.route.kind === 'verification' && task)) open(node.route);
      else if (node.task) runTask(node, node.task);
      else dispatch({ type: 'focus', focus: 'detail' });
      return;
    }
    if (inputText === 'n' && page?.next) { more(); return; }
    if (inputText === 'p' && page?.singlePage && page.cursors?.length) { more(true); return; }
  });

  if (width < 60 || height < 16) return <Text>请将终端调整到至少 60×16；q 退出。输入草稿已冻结。</Text>;
  const structure: { text: string; id?: string }[] = [];
  for (const v of visible) {
    const n = v.node, expanded = state.expanded[n.id] ?? n.defaultOpen;
    const marked = n.resourceId && nav.marked.includes(n.resourceId) ? '[x] ' : '';
    structure.push({ id: n.id, text: `${'  '.repeat(v.depth)}${n.kind === 'group' ? expanded ? '▼' : '▶' : n.kind === 'body' ? '·' : '›'} ${marked}${label(n.label)}` });
    if (n.preview && expanded) for (const s of renderMarkdown(n.preview.split('\n').slice(0, 8), detailWidth - 4).slice(0, 3)) structure.push({ text: '    ' + s });
    if (task === n.id) structure.push({ text: '    加载中…（可继续浏览其他分组）' });
    if (taskError?.id === n.id) structure.push({ text: '    ' + label(taskError.message) + ' · Enter 重试' });
    if (n.kind === 'group' && expanded && !n.children?.length && task !== n.id && taskError?.id !== n.id) structure.push({ text: n.task && !detail?.review ? '    未加载：收起再展开重试' : '    无' });
  }
  const activeLine = Math.max(0, structure.findIndex(s => s.id === active?.node.id));
  const treeStart = Math.max(0, activeLine - bodyHeight + 2);
  const scope: Record<Route['kind'], string> = { home: 'Requirement', requirement: 'Requirement', issue: 'Issue', candidates: 'Candidate',
    devruns: 'DevRun', devrun: 'DevRun', candidate: 'Candidate', review: 'Review', verifications: 'Verification', verification: 'Verification', compare: 'Compare' };
  const position = compare ? `行 ${compareScroll[wide ? 0 : compareSide] + 1}/${Math.max(comparisons[wide ? 0 : compareSide]?.total ?? 1, 1)}`
    : nav.focus === 'list' ? `目录 ${visible.length ? nodeIndex + 1 : 0}/${visible.length} · 行 ${offset + 1}/${readingView.total}` : `行 ${offset + 1}/${readingView.total}`;
  return <Box flexDirection="column" width={width} height={height}>
    <Text bold color="cyan">有据 Grounds · 只读 · {scope[nav.route.kind]} · {label(context.driver)} · CLI {label(context.version)}</Text>
    <Text wrap="truncate">{readingPath ? label(readingPath) : label(page?.title ?? '连接中…')}{nav.search ? ` · 筛选 ${label(nav.search)}（仅已加载资源）` : ''}</Text>
    {status && <Text color={error ? 'red' : 'yellow'} wrap="truncate">{label(status)}</Text>}
    {input && <Text wrap="truncate">{input === 'body-search' ? '搜索正文' : input === 'search' ? '筛选已加载资源' : 'Candidate ID'}: {label([...draft].slice(0, caret).join(''))}█{label([...draft].slice(caret).join(''))}</Text>}
    {help ? <Box height={bodyHeight + 2} borderStyle="round"><Text>{`当前页操作：${pageHintParts.join(' · ')}\n\n` + (compare
      ? '对比：↑↓/j/k 滚动 · PgUp/PgDn · Home/End\n窄屏 ← A / → B / Tab 切换；宽屏同步滚动\nr 刷新 · Esc 返回 · q/Ctrl+C 退出\nEsc/? 关闭帮助；其他键不透传。'
      : `配置 ${label(context.configSource)} · 会话 ${label(context.databaseId)}\n读取于 ${detail?.time ?? page?.time ?? '尚未读取'}\n` + '目录：↑↓ 选择 · → 展开/首个子项 · ← 收起/父级 · Enter 展开或打开\n正文：↑↓/PgUp/PgDn/Home/End 滚动 · / 搜索 · n/N 匹配 · [/] 章节\nTab/Shift+Tab 切换目录与正文 · Esc 从正文回目录/从目录返回页面\nr 刷新 · n/p 分页 · Space 标记 · c 对比\ng 首页输入 Candidate ID · q/Ctrl+C 退出\n资源筛选只覆盖已加载的顶层资源。Esc/? 关闭帮助；帮助中其他键不透传。')}</Text></Box>
      : compare ? <Box height={bodyHeight + 2} borderStyle="round" borderColor="gray">{comparisons.map((c, i) => (wide || compareSide === i) && <Box key={i}
        width={wide && i === 0 ? Math.floor(width / 2) - 1 : undefined} flexGrow={wide && i === 1 ? 1 : undefined} minWidth={0} flexDirection="column"
        borderStyle={wide && i === 0 ? 'single' : undefined} borderLeft={false} borderTop={false} borderBottom={false} borderRight={wide && i === 0}>
        <Text bold>{i ? 'B' : 'A'} · {label(valueText(compareData[i]?.candidate_id))}</Text>{c.lines.map((s, j) => <Text key={j} wrap="truncate">{s || ' '}</Text>)}</Box>)}</Box>
      : <Box height={bodyHeight + 2} borderStyle="round" borderColor="gray">
        {(wide || nav.focus === 'list') && <Box width={wide ? leftWidth - 1 : width - 2} flexShrink={0} flexDirection="column"
          borderStyle={wide ? 'single' : undefined} borderLeft={false} borderTop={false} borderBottom={false} borderRight={wide}>
          <Text bold color={nav.focus === 'list' ? 'cyan' : undefined}>结构目录</Text>
          {structure.slice(treeStart, treeStart + bodyHeight - 1).map((item, i) => <Text key={i} inverse={nav.focus === 'list' && item.id === active?.node.id} wrap="truncate">{item.text}</Text>)}
          {!visible.length && <Text>{nav.search ? '已加载目录无匹配（不代表账本不存在）' : '暂无资源'}</Text>}
        </Box>}
        {(wide || nav.focus === 'detail') && <Box flexGrow={1} minWidth={0} flexDirection="column">
          <Text bold color={nav.focus === 'detail' ? 'cyan' : undefined} wrap="truncate">{label(readingNode?.panelTitle ?? readingNode?.label ?? selected?.label ?? '内容')}{previewBusy ? ` · 读取中…${detail ? '（旧内容）' : ''}` : previewError ? ` · ${label(previewError)} · Enter 重试` : ''}</Text>
          {readingView.lines.map((line, i) => <Text key={i} inverse={!!bodyQuery && locations.matches.includes(offset + i)} wrap="truncate">{line || ' '}</Text>)}
        </Box>}
      </Box>}
    <Box flexDirection="column">{hintLines.map((line, index) => <Text key={index} bold color={process.env.NO_COLOR === undefined ? 'green' : undefined} wrap="truncate">{line}</Text>)}</Box>
    <Text color="gray" wrap="truncate">{position}</Text>
  </Box>;
}
