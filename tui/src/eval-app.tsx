import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout, useApp } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { isDeepStrictEqual } from 'node:util';
import type { Context, Reader, SelectionWriter } from './client.js';
import type { Data } from './protocol.js';
import { clean, renderMarkdown } from './markdown.js';
import { operationHintLines } from './operation-hints.js';
import { ReviewApp } from './review-app.js';
import { checkedReport, type EvalAccess, type EvalRead, type EvalRecord, type EvalReport, type ReportTask, type Attempt, type Publication, type Ref } from './eval-protocol.js';
import { DraftStore, compilePublication, editText, newGrader, newQA, type Draft } from './eval-drafts.js';
import { buildTimeline, clock, renderEvidencePane, renderTimeline, type EvidenceRef, type Loaded } from './capture-timeline.js';
import { fallbackSummary, renderBanner, renderListPreview, renderPublishPreview, renderQAPane, renderTechnical, rowLabels, summarize, viewOf, type DraftSummary } from './capture-panel.js';
import { clipCells, rule, wrapBlock } from './capture-lines.js';
import { fieldTag, reviewChecklist } from './capture-text.js';
import { assetText, attemptText, differenceRows, items, matrixRows, noticesText, object, readEvidence, readRecord, readRecords, recordLabel, refText, reports, reportText, selectedAttempt, string, taskStatus, type DifferenceKind, type DifferenceRow } from './eval-model.js';

type Action = () => Page | void | Promise<Page | void>;
interface Item { id: string; label: string; action: Action; replace?: boolean; search?: string }
interface Page { kind: 'list' | 'text' | 'matrix' | 'form' | 'difference' | 'pair' | 'dashboard'; title: string; rows: Item[]; body?: string; previews?: string[]; menu?: Item[]; reload?: Action; row: number; scroll: number; filter: string; focus: 'rows' | 'body'; experimentIds?: string[]; matrix?: EvalReport[]; difference?: DifferenceRow[]; dashboard?: { kind: 'experiment' | 'suite'; records: EvalRecord[] }; suite?: EvalRecord; pair?: { left: string; right: string; leftLabel: string; rightLabel: string; leftLines?: (width: number) => string[]; rightLines?: (width: number) => string[]; banner?: (width: number) => string[]; shortLabels?: [string, string] }; draft?: Draft; readAt?: string; capture?: boolean; captureId?: string; epoch?: number; chrome?: 'capture'; context?: string; listWidth?: number; render?: (width: number, selected?: string) => string[] }
interface Prompt { multiline?: boolean; scroll?: number; label: string; value: string; commit: (value: string) => Promise<Page>; }
interface Props { access: EvalAccess; reader: Reader; writer?: SelectionWriter; context: Context; onExit: () => void; onBack: () => void; backLabel?: string; store?: DraftStore; width?: number; height?: number; edit?: (text: string) => Promise<string> }
const page = (title: string, rows: Item[] = [], body = '', more: Partial<Page> = {}): Page => ({ kind: rows.length ? 'list' : 'text', title, rows, body, row: 0, scroll: 0, filter: '', focus: rows.length ? 'rows' : 'body', ...more });
const action = (label: string, fn: Action, replace = false): Item => ({ id: label, label, action: fn, replace });
const clip = (value: string, width: number) => { let out = ''; for (const c of clean(value).replace(/[\r\n\t]/g, ' ')) { if (stringWidth(out + c) > width) break; out += c; } return out.padEnd(out.length + Math.max(0, width - stringWidth(out))); };
const short = (v: string) => v.slice(0, 8);
/** Re-wrapping long text on every key press is wasteful; reuse the lines while width and data stay the same. */
const memoLines = (compute: (width: number) => string[], stamp: () => number = () => 0) => { let key = '', lines: string[] = []; return (width: number) => { const next = `${width}:${stamp()}`; if (next !== key) { key = next; lines = compute(width); } return lines; }; };
const READ_ONLY_DRAFT_CALLS = new Set(['draft.list', 'draft.show', 'draft.status', 'draft.evidence', 'draft.preview', 'draft.export-public', 'source-package.show', 'source-package.file', 'clue.list', 'clue.show']);
const PREFETCH_EVIDENCE = 60;
// Rows match on their visible label, id and any hidden search text (identity, question, kind).
const matching = (rows: Item[], filter: string) => rows.filter(r => filter.toLowerCase().split(/\s+/).every(term => `${r.label} ${r.search ?? ''}`.toLowerCase().includes(term) || r.id.includes(term)));
const json = (v: unknown) => JSON.stringify(v, null, 2);
export function EvalApp({ access, reader, writer, context, onExit, onBack, backLabel = '返回开发审阅', store: providedStore, width: widthOverride, height: heightOverride, edit }: Props) {
  const { suspendTerminal } = useApp();
  const editLongText = async (value: string) => edit ? edit(value) : editText(storeRef.current.root, value, async () => { const suspension = await suspendTerminal(); return () => suspension.resume(); });
  const storeRef = useRef(providedStore ?? new DraftStore()), store = storeRef.current;
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns || 100, height: stdout.rows || 30 });
  useEffect(() => { const resize = () => setSize({ width: stdout.columns || 100, height: stdout.rows || 30 }); stdout.on('resize', resize); return () => { stdout.off('resize', resize); }; }, [stdout]);
  const width = widthOverride ?? size.width, height = heightOverride ?? size.height;
  const [screen, setScreen] = useState<Page>(page('评测', [], '正在读取…')), [history, setHistory] = useState<Page[]>([]), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [captureProgress,setCaptureProgress] = useState('');
  const [prompt, setPromptState] = useState<Prompt>(), [searching, setSearching] = useState(false), [selectedExperiments, selectExperiments] = useState<string[]>([]), [selections, selectRuns] = useState<Record<string, string>>({}), [column, setColumn] = useState(0), [candidate, setCandidate] = useState<string>();
  // Native input can deliver several events before React commits a render.
  // Saving must use the same latest buffer as every preceding edit event.
  const promptRef = useRef<Prompt | undefined>(undefined);
  const setPrompt = (next: Prompt | undefined) => {promptRef.current = next; setPromptState(next);};
  const selectedRunsRef = useRef(selections); selectedRunsRef.current = selections;
  const [pairScroll, setPairScroll] = useState<[number, number]>([0, 0]);
  const [dashboardPreview, setDashboardPreview] = useState('');
  const previewSerial = useRef(0);
  // Captured evidence bodies are immutable per digest, so edits and reloads never refetch them.
  const lastCaptureId = useRef<string | undefined>(undefined), captureEpoch = useRef(0);
  const evidenceCache = useRef(new Map<string, Loaded>()), evidenceBusy = useRef(new Set<string>()), evidenceVersion = useRef(0), alive = useRef(true), pairMax = useRef<[number, number]>([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
  const [, setEvidenceTick] = useState(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [comparisonReadiness, setComparisonReadiness] = useState('');
  const comparisonSerial = useRef(0);
  const serial = useRef(0), controller = useRef<AbortController | undefined>(undefined), sending = useRef(false);
  const current = useRef(screen); current.current = screen;
  const enterPage = (next: Page, replace = false) => { if (!replace) setHistory(h => [...h, current.current].slice(-48)); const keepPanes = replace && ((next.captureId !== undefined && next.captureId === lastCaptureId.current) || (current.current.kind === 'pair' && current.current.title === next.title)); if (next.kind === 'pair' && !keepPanes) { setColumn(0); setPairScroll([0, 0]); } if (next.captureId !== undefined) lastCaptureId.current = next.captureId; setScreen(replace && current.current.title === next.title ? { ...next, row: current.current.row, scroll: current.current.scroll, filter: current.current.filter, focus: current.current.focus } : next); setPrompt(undefined); setSearching(false); };
  const perform = (fn: Action, replace = false) => {
    if (sending.current) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; const token = ++serial.current; setBusy(true); setNotice('');
    void Promise.resolve().then(fn).then(next => { if (token === serial.current && !abort.signal.aborted && next) enterPage(next, replace); }).catch(e => { if (token === serial.current) setNotice(e instanceof Error ? e.message : String(e)); }).finally(() => { if (token === serial.current) setBusy(false); });
  };
  const mutate = (v: Partial<Page>) => setScreen(p => ({ ...p, ...v }));
  async function home(kind: 'experiment' | 'suite' = 'experiment'): Promise<Page> {
    try {
      const records = await readRecords(access, kind, controller.current?.signal);
      const rows = [action(kind === 'experiment' ? '切换：题集与评分' : '切换：实验与结果', () => home(kind === 'experiment' ? 'suite' : 'experiment'), true),
        ...records.map(r => ({ id: r.id, label: `${r.id.slice(-8)} · ${recordLabel(r)}`, action: () => kind === 'experiment' ? experiment(r.id) : asset('suite', r.id) })),
        ...(kind === 'suite' ? [action('创建题集', async () => form(await store.create(context.databaseId, { command: 'suite.create', name: '' }))), action('题目 · QA', () => listing('qa')), action('任务 · Coding', coding), action('评分规则', () => listing('grader'))] : [action('查看本机草稿', drafts)]),
        action('本机草稿与待恢复操作', drafts), action('采集 QA · 人工审核与发布', capturedDrafts), action('待提取来源线索 · 元数据', () => sourceClues())];
      const body = records.length ? kind === 'experiment' ? '↑↓ 选择即预览；Enter 审阅。Space 选实验，c 进入多组对照。实验执行使用 grounds-eval Skill／CLI。' : '↑↓ 选择题集即预览；Enter 查看成员、固定题目与评分，并可从题集内打开本机编排草稿。' : kind === 'experiment' ? '尚无实验记录。可切换题集与评分创建题集，再通过 grounds-eval Skill／CLI 执行实验。' : '尚无题集记录。可选择“创建题集”开始整理。';
      return page(`评测工作台 · ${kind === 'experiment' ? '实验与结果' : '题集与评分'}`, rows, body, { kind: 'dashboard', dashboard: { kind, records }, experimentIds: kind === 'experiment' ? records.map(r => r.id) : undefined, reload: () => home(kind), menu: [action(backLabel, onBack)], readAt: readAt() });
    } catch (error) {
      return page('评测工作台 · 读取失败', [action('重试读取', () => home(kind)), action(backLabel, onBack)], `读取失败：${error instanceof Error ? error.message : String(error)}。账本状态未知，可重试。`);
    }
  }
  useEffect(() => { perform(() => home(), true); return () => { controller.current?.abort(); serial.current++; previewSerial.current++; }; }, [access]);
  useEffect(() => {
    const dashboard = screen.dashboard, selected = matching(screen.rows, screen.filter)[screen.row], record = dashboard?.records.find(r => r.id === selected?.id);
    const suiteTask = screen.suite && items(screen.suite.data.tasks).find(task => task.id === selected?.id);
    const token = ++previewSerial.current;
    if (!record && !suiteTask) { setDashboardPreview(''); return; }
    setDashboardPreview('正在读取选中条目的预览…');
    void (async () => {
      if (suiteTask) {
        const ref = object(suiteTask.qa ?? suiteTask.issue);
        const target = suiteTask.qa ? object((await readRecord(access, 'qa', string(ref.id), Number(ref.version))).data) : object((await reader.query('issue', [string(ref.id), '--issue-version', String(ref.version)])).issue);
        return `## 当前成员 · ${suiteTask.name}\n任务：${suiteTask.qa ? 'QA' : 'Coding'} ${refText(ref)}\n题面：${string(suiteTask.qa ? target.question : target.summary)}\n评分绑定：${items(suiteTask.graders).map(refText).join(' / ') || '缺评分'}\n成员身份：${suiteTask.id}`;
      }
      if (dashboard!.kind === 'experiment') {
        const report = checkedReport(await access.read('experiment.report', [record!.id]), record!.id);
        const distribution = new Map<string, Map<string, number>>();
        for (const task of report.tasks) for (const grader of task.graders) {
          const key = `${grader.data.name} · ${short(grader.id)} v${grader.version}`, counts = distribution.get(key) ?? new Map<string,number>();
          const status = taskStatus(task, undefined, { id: grader.id, version: grader.version }); counts.set(status, (counts.get(status) ?? 0) + 1); distribution.set(key, counts);
        }
        return `${reportText(report)}\n\n## 按评分维度的题目分布\n${[...distribution].map(([name, counts]) => `${name}：${[...counts].map(([status,count]) => `${status} ${count}`).join(' · ')}`).join('\n') || '未知'}\n\n账本记录：${record!.created_at} · 本次读取：${readAt()}`;
      }
      const suite = await readRecord(access, 'suite', record!.id); const pending = (await store.list()).filter(d => d.databaseId === context.databaseId && d.publication.id === record!.id && d.state !== 'published');
      return `${assetText(suite)}\n\n缺评分成员：${items(suite.data.tasks).filter(t => !items(t.graders).length).length}\n本机草稿：${pending.length ? pending.map(d => `${short(d.id)} · ${d.state}`).join(' / ') : '无'}\n\n账本记录：${record!.created_at} · 本次读取：${readAt()}`;
    })().then(value => { if (token === previewSerial.current) setDashboardPreview(value); }).catch(error => { if (token === previewSerial.current) setDashboardPreview(`预览读取失败：${error instanceof Error ? error.message : String(error)}。Ctrl+R 可重试。`); });
  }, [screen.dashboard, screen.suite, screen.row, screen.rows, screen.filter, access]);
  useEffect(() => {
    const token = ++comparisonSerial.current;
    if (screen.dashboard?.kind !== 'experiment' || !selectedExperiments.length) { setComparisonReadiness(''); return; }
    if (selectedExperiments.length < 2) { setComparisonReadiness('对照条件：还需选择至少一个不同实验；已选实验保留。'); return; }
    setComparisonReadiness('正在核对所选实验的固定 Snapshot…');
    void Promise.all(selectedExperiments.map(async id => checkedReport(await access.read('experiment.report', [id]), id)))
      .then(found => {
        if (token !== comparisonSerial.current) return;
        const first = found[0].snapshot, mismatch = found.find(r => r.snapshot.id !== first.id || !isDeepStrictEqual(r.snapshot.data, first.data));
        setComparisonReadiness(mismatch ? `不可比：${object(mismatch.experiment.data.subject).name} 使用 Snapshot ${mismatch.snapshot.id}；基线条件是同一固定 Snapshot ${first.id}。已选实验保留，可取消或改选。` : `可比：${found.length} 个不同实验共用固定 Snapshot ${first.id}；按 c 进入对照并明确选择基线。`);
      }).catch(error => { if (token === comparisonSerial.current) setComparisonReadiness(`可比性读取失败：${error instanceof Error ? error.message : String(error)}；已选实验保留，可重试。`); });
  }, [screen.dashboard, selectedExperiments, access]);
  const readAt = () => new Date().toLocaleString();
  const textPage = (title: string, body: string, menu: Item[] = []) => page(title, [], body, { menu });
  const choose = (title: string, options: Item[], body = '') => page(title, options, body);
  const ask = (label: string, value: string, commit: (value: string) => Promise<Page>) => { setPrompt({ label, value, commit }); };
  async function listing(kind: string): Promise<Page> {
    const records = await readRecords(access, kind, controller.current?.signal);
    const title = ({ suite: '题集', qa: 'QA 题目', grader: '评分规则', experiment: '实验' } as Record<string, string>)[kind];
    const menu: Item[] = [];
    if (kind === 'suite') menu.push(action('新建题集', async () => form(await store.create(context.databaseId, { command: 'suite.create', name: '' }))));
    if (kind === 'qa') menu.push(action('新建 QA 题目', async () => form(await store.create(context.databaseId, { command: 'qa.publish', body: newQA() }))));
    if (kind === 'grader') menu.push(action('新建评分规则', () => chooseTask(async target => form(await store.create(context.databaseId, { command: 'grader.publish', body: newGrader(target) })))));
    return page(title, records.map(r => ({ id: r.id, label: recordLabel(r), action: () => kind === 'experiment' ? experiment(r.id) : asset(kind, r.id) })), records.length ? '选择条目阅读；: 查看管理操作。' : '暂无记录；: 查看可用操作。', { menu, reload: () => listing(kind), readAt: readAt(), ...(kind === 'experiment' ? { experimentIds: records.map(r => r.id) } : {}) });
  }
  async function allIssues(): Promise<Data[]> {
    const rows: Data[] = []; const seen = new Set<string>(); let cursor = '';
    do { const p = await reader.query('issues', cursor ? ['--cursor', cursor] : [], controller.current?.signal); rows.push(...items(p.resources)); const next = string(object(p.page).next_cursor); if (next && seen.has(next)) throw new Error('Issue 分页重复'); seen.add(next); cursor = next; } while (cursor);
    return rows;
  }
  async function coding(): Promise<Page> { const rows = await allIssues(); return page('Coding 任务 · 已发布 Issue', rows.map(r => ({ id: string(r.resource_id), label: `${r.label} · v${r.version}`, action: () => issueDetail(string(r.resource_id), Number(r.version)) })), '开发契约的创建与修订继续使用 Grounds 定义流程。', { reload: coding }); }
  async function issueDetail(id: string, version: number): Promise<Page> {
    const d = await reader.query('issue', [id, '--issue-version', String(version)], controller.current?.signal), issue = object(d.issue);
    if (issue.id !== id || issue.version !== version) throw new Error('Issue 身份或版本不匹配');
    const body = [`# ${issue.summary}`, `Issue ${id} · v${version}`, string(issue.context), ...['goals', 'constraints'].flatMap(k => items(issue[k]).flatMap(t => [`## ${t.statement}`, ...items(t.criteria).map(c => `- ${c.statement}`)]))].join('\n\n');
    return textPage('Coding 固定契约', body, [action('选择历史版本', () => versions('Issue', version, n => issueDetail(id, n))), action('为此版本新建 Grader', async () => form(await store.create(context.databaseId, { command: 'grader.publish', body: newGrader({ issue: { id, version } }) })))]);
  }
  const versions = (title: string, max: number, load: (n: number) => Promise<Page>) => choose(title + ' · 选择精确版本', Array.from({ length: max }, (_, i) => action(`v${max - i}`, () => load(max - i))));
  async function batchDraft(suite: EvalRecord): Promise<Draft> {
    const existing = (await store.list()).find(d => d.databaseId === context.databaseId && d.publication.command === 'suite.tasks.publish' && d.publication.id === suite.id && d.state !== 'published');
    return existing ?? store.create(context.databaseId, { command: 'suite.tasks.publish', id: suite.id, expectedVersion: suite.version, body: { format: 'grounds.eval-suite-members/v1', tasks: items(suite.data.tasks) } }, suite);
  }
  async function asset(kind: string, id: string, version?: number): Promise<Page> {
    const r = await readRecord(access, kind, id, version, controller.current?.signal); const latest = version ? await readRecord(access, kind, id) : r;
    const menu = [action('选择历史版本', () => versions(string(r.data.name), latest.version, n => asset(kind, id, n)))]; let body = assetText(r); const rows: Item[] = [];
    if (kind === 'grader') { const ns = await access.read('grader.notices', [id, '--version', String(r.version)]) as EvalRecord[]; body += '\n\n' + noticesText(ns); }
    if (kind === 'qa') {
      const parent = object(object(object(r.data.source).record).based_on);
      if (parent.id && parent.version) {
        const original = await readRecord(access, 'qa', string(parent.id), Number(parent.version));
        body += '\n\n## 被引用原版本的来源\n\n' + json(original.data.source) + '\n\n上方题面为本次人工内容；原版本来源不代表本次修改来自原仓库。';
      }
    }
    if (kind === 'qa' || kind === 'grader') {
      menu.push(action('修订此版本', async () => { if (r.version !== latest.version) throw new Error('请先查看最新版本再修订，历史版本仍可阅读'); return form(await store.create(context.databaseId, { command: kind === 'qa' ? 'qa.publish' : 'grader.publish', id, expectedVersion: r.version, body: r.data }, r)); }));
      if (kind === 'qa') { menu.push(action('从此内容新建 QA', async () => form(await store.create(context.databaseId, { command: 'qa.publish', body: r.data }, r))), action('新建此题版本的 Grader', async () => form(await store.create(context.databaseId, { command: 'grader.publish', body: newGrader({ qa: { id, version: r.version } }) })))); const parent = object(object(object(r.data.source).record).based_on); if (parent.id) menu.push(action('查看修订前来源', () => asset('qa', string(parent.id), Number(parent.version)))); }
    }
    if (kind === 'suite') {
      const openBatch = async () => suiteBatchForm(await batchDraft(r));
      rows.push(action('编排成员 · 检查并统一发布', openBatch));
      for (const t of items(r.data.tasks)) rows.push({ id: string(t.id), label: `${t.qa ? 'QA' : 'Coding'} · ${t.name} · v${object(t.qa ?? t.issue).version}`, action: () => suiteTask(r, t) });
      menu.push(action('添加任务（旧单项发布）', () => chooseTask(async target => form(await store.create(context.databaseId, { command: 'suite.task.add', id, expectedVersion: r.version, body: { name: '', ...target, ...(target.qa ? { kind: 'qa' } : {}), graders: [] } }, r)))), action('查看所有版本相关实验', async () => {
        const experiments = await readRecords(access, 'experiment'); const found: Item[] = [];
        for (const e of experiments) { const snapshot = await readRecord(access, 'snapshot', string(e.data.snapshot_id)); if (object(snapshot.data.suite).id === id) found.push({ id: e.id, label: `${recordLabel(e)} · 题集 v${object(snapshot.data.suite).version}`, action: () => experiment(e.id) }); }
        return page('题集相关实验 · 全部版本', found, found.length ? '' : '没有关联实验', { experimentIds: found.map(x => x.id) });
      }));
    }
    return page(`${({ suite: '题集', qa: '题目', grader: '评分规则' } as Record<string,string>)[kind]} · v${r.version}`, rows, body, { menu, reload: () => asset(kind, id, version), readAt: readAt(), ...(kind === 'suite' ? { suite: r } : {}) });
  }
  async function suiteTask(suite: EvalRecord, t: Data): Promise<Page> {
    const ref = object(t.qa ?? t.issue); const rows = [action('查看固定任务', () => t.qa ? asset('qa', string(ref.id), Number(ref.version)) : issueDetail(string(ref.id), Number(ref.version))), action('编排任务版本与评分', async () => {
      const draft = await batchDraft(suite), index = batchTasks(draft).findIndex(task => task.id === t.id);
      if (index < 0) throw new Error('成员在草稿中已移除；请检查题集草稿');
      return editBatchTask(draft, index);
    }), action('从编排草稿移除此成员', async () => {
      const draft = await batchDraft(suite);
      return saveBatch(draft, batchTasks(draft).filter(task => task.id !== t.id));
    })];
    for (const g of items(t.graders)) rows.push(action(`Grader ${refText(g)}`, () => asset('grader', string(g.id), Number(g.version))));
    return page(string(t.name), rows, `任务：${refText(ref)}\n\n题集：${suite.id} · v${suite.version}`, { menu: [action('替换任务或评分版本', async () => form(await store.create(context.databaseId, { command: 'suite.task.update', id: suite.id, expectedVersion: suite.version, taskId: string(t.id), body: Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'id')) }, suite))), action('从题集移除任务', async () => form(await store.create(context.databaseId, { command: 'suite.task.remove', id: suite.id, expectedVersion: suite.version, taskId: string(t.id) }, suite)))] });
  }
  const batchTasks = (d: Draft): Data[] => items(d.publication.body?.tasks);
  const batchSummary = (d: Draft): string => {
    const before = items(d.original?.data.tasks), after = batchTasks(d), old = new Map(before.map(t => [string(t.id), t]));
    const lines = [`题集 ${d.publication.id} · 原版本 v${d.publication.expectedVersion}`, `原成员 ${before.length} 项 → 草稿 ${after.length} 项`];
    for (const t of after) {
      const prior = old.get(string(t.id));
      const state = !prior ? '新增' : isDeepStrictEqual(prior, t) ? '保留' : '调整';
      lines.push(`${state} · ${t.name} · ${refText(t.qa ?? t.issue)} · 评分 ${items(t.graders).map(refText).join(' / ') || '缺失'}`);
    }
    for (const t of before) if (!after.some(next => next.id === t.id)) lines.push(`移除 · ${t.name} · ${t.id}`);
    if (isDeepStrictEqual(before, after)) lines.push('未发生变化，发布不可用。');
    return lines.join('\n\n');
  };
  async function saveBatch(d: Draft, tasks: Data[]): Promise<Page> {
    return suiteBatchForm(await store.edit(d, { ...d.publication, body: { format: 'grounds.eval-suite-members/v1', tasks } }));
  }
  async function chooseBatchGrader(d: Draft, index: number): Promise<Page> {
    const task = batchTasks(d)[index], target = object(task.qa ?? task.issue), all = await readRecords(access, 'grader');
    const rows = all.filter(g => { const ref = object(g.data.qa ?? g.data.issue); return ref.id === target.id && ref.version === target.version; }).map(g => action(recordLabel(g), () => versions('选择精确评分版本', g.version, async version => {
      const selected = await readRecord(access, 'grader', g.id, version);
      return choose('确认评分绑定', [action('绑定此版本', () => {
        const tasks = batchTasks(d), graders = items(tasks[index].graders).filter(ref => ref.id !== g.id);
        tasks[index] = { ...tasks[index], graders: [...graders, { id: g.id, version }] };
        return saveBatch(d, tasks);
      })], assetText(selected));
    })));
    for (const ref of items(task.graders)) rows.push(action(`移除绑定 ${refText(ref)}`, () => {
      const tasks = batchTasks(d); tasks[index] = { ...tasks[index], graders: items(tasks[index].graders).filter(g => g.id !== ref.id) }; return saveBatch(d, tasks);
    }));
    rows.push(action('就地新建匹配 Grader', async () => form(await store.create(context.databaseId, { command: 'grader.publish', body: newGrader(task.qa ? { qa: target as unknown as Ref } : { issue: target as unknown as Ref }) }, undefined, d.id, { index, ...(task.id ? { id: string(task.id) } : {}) }))));
    return choose('匹配评分规则', rows, '选择固定版本；新规则独立发布后返回当前成员，并可明确绑定其版本。');
  }
  async function editBatchTask(d: Draft, index: number, publishedGrader?: EvalRecord): Promise<Page> {
    const task = batchTasks(d)[index];
    const rows = [action('编辑成员名称', () => { ask('成员名称', string(task.name), async name => { const tasks = batchTasks(d); tasks[index] = { ...tasks[index], name }; return saveBatch(d, tasks); }); }), action('替换任务固定版本', () => chooseTask(async target => { const tasks = batchTasks(d); tasks[index] = { ...tasks[index], ...target, ...(target.qa ? { kind: 'qa' } : {}), graders: [] }; delete tasks[index][target.qa ? 'issue' : 'qa']; if (!target.qa) delete tasks[index].kind; return saveBatch(d, tasks); })), action('选择或移除评分绑定', () => chooseBatchGrader(d, index)), action('从草稿移除成员', () => saveBatch(d, batchTasks(d).filter((_, i) => i !== index)))];
    if (publishedGrader) rows.unshift(action(`绑定刚发布的 Grader v${publishedGrader.version}`, () => {
      const tasks = batchTasks(d), graders = items(tasks[index].graders).filter(ref => ref.id !== publishedGrader.id);
      tasks[index] = { ...tasks[index], graders: [...graders, { id: publishedGrader.id, version: publishedGrader.version }] };
      return saveBatch(d, tasks);
    }));
    return choose(`编排 · ${task.name}`, rows, `${publishedGrader ? `Grader ${publishedGrader.id} · v${publishedGrader.version} 已独立发布，题集草稿尚未发布。请明确绑定。\n` : ''}任务：${refText(task.qa ?? task.issue)}\n评分：${items(task.graders).map(refText).join(' / ') || '缺失'}\n成员身份：${task.id ?? '发布时分配'}`);
  }
  async function suiteBatchForm(input: Draft): Promise<Page> {
    const d = await store.load(input.id), tasks = batchTasks(d), editable = !['pending', 'published'].includes(d.state) && d.databaseId === context.databaseId;
    const related = (await store.list()).filter(other => other.returnTo === d.id && other.state === 'published' && other.result);
    const rows = editable ? tasks.map((task, index) => action(`${task.id ? '调整' : '新增'} · ${task.name} · ${items(task.graders).length ? '已绑定评分' : '缺评分'}`, () => editBatchTask(d, index))) : [];
    if (editable) {
      rows.push(action('添加已有 QA 或 Coding Issue', () => chooseTask(async target => {
        const name = target.qa ? string((await readRecord(access, 'qa', target.qa.id, target.qa.version)).data.name) : string(object((await reader.query('issue', [target.issue!.id, '--issue-version', String(target.issue!.version)])).issue).summary);
        return saveBatch(d, [...tasks, { name, ...target, ...(target.qa ? { kind: 'qa' } : {}), graders: [] }]);
      })));
      rows.push(action('就地新建 QA 题目', async () => form(await store.create(context.databaseId, { command: 'qa.publish', body: newQA() }, undefined, d.id))));
      if (!isDeepStrictEqual(items(d.original?.data.tasks), tasks)) rows.push(action('检查变化并确认发布', async () => confirmation(await store.prepare(d, await access.identity()))));
    }
    if (d.state === 'pending' || d.state === 'prepared') rows.push(action('按原请求恢复发布结果', () => confirmation(d)));
    if (d.state === 'rejected') rows.push(action('读取最新版本并处理冲突', async () => {
      const latest = await readRecord(access, 'suite', d.publication.id!);
      return choose('题集冲突 · 对照后决定', [action('以当前完整编排替换最新版本并重新检查', async () => {
        const next = await store.edit(d, { ...d.publication, expectedVersion: latest.version });
        next.original = latest;
        await store.save(next);
        return suiteBatchForm(next);
      })], `## 草稿基于 v${d.publication.expectedVersion}\n${d.original ? assetText(d.original) : '原题集内容未保存在本机草稿'}\n\n## 最新题集 v${latest.version}\n${assetText(latest)}\n\n## 当前完整编排\n${batchSummary(d)}\n\n继续会以当前完整编排替换最新题集成员；请返回草稿逐项检查后再确认发布。`);
    }));
    if (d.state === 'published') rows.push(action('查看已发布题集', () => asset('suite', d.publication.id!)));
    return page('题集编排 · 本机草稿', rows, `${batchSummary(d)}\n\n草稿 ${d.id} · ${d.state} · 目标账本 ${d.databaseId}${d.error ? '\n' + d.error : ''}\n\n${related.length ? '已独立发布：' + related.map(other => `${other.publication.command} ${other.result!.id} · v${other.result!.version}`).join(' / ') + '。题集尚需单独发布。' : '题目与评分规则单独发布；题集成员仅在此检查后一次发布。'}`, { kind: 'form', draft: d, reload: () => suiteBatchForm(d) });
  }
  async function chooseTask(done: (target: { qa?: Ref; issue?: Ref }) => Promise<Page>): Promise<Page> {
    return choose('选择任务类型', [action('QA 题目', async () => { const list = await readRecords(access, 'qa'); return choose('选择 QA 与版本', list.map(r => action(recordLabel(r), () => versions(recordLabel(r), r.version, n => done({ qa: { id: r.id, version: n } }))))); }), action('Coding Issue', async () => { const list = await allIssues(); return choose('选择 Coding Issue 与版本', list.map(r => action(string(r.label), () => versions(string(r.label), Number(r.version), n => done({ issue: { id: string(r.resource_id), version: n } }))))); })]);
  }
  async function experiment(id: string): Promise<Page> {
    const r = checkedReport(await access.read('experiment.report', [id], controller.current?.signal), id);
    return page(string(object(r.experiment.data.subject).name), r.tasks.map(t => action(`${t.task.name} · ${taskStatus(t)}`, () => t.runs.length === 1 ? attemptPage(r, t, t.runs[0]) : taskPage(r, t))), reportText(r), { reload: () => experiment(id), readAt: readAt() });
  }
  const taskPage = (r: EvalReport, t: ReportTask): Page => page(t.task.name, t.runs.map(a => action(`${short(a.run.id)} · ${a.run.data.mode} · ${a.run.data.state}`, () => attemptPage(r, t, a))), t.runs.length ? '所有尝试均保留；选择一次查看交付物与证据。' : '尚未开始，没有作答记录。', { menu: [action('查看冻结任务', () => t.task.qa ? asset('qa', t.task.qa.id, t.task.qa.version) : issueDetail(t.task.issue!.id, t.task.issue!.version))] });
  function attemptPage(r: EvalReport, t: ReportTask, a: Attempt): Page {
    const menu: Item[] = [action('查看冻结题目', () => t.task.qa ? asset('qa', t.task.qa.id, t.task.qa.version) : issueDetail(t.task.issue!.id, t.task.issue!.version)), action('查看所有尝试', () => taskPage(r, t))];
    if (a.artifact) { const originalQA = object(a.artifact.data.qa); menu.push(action('查看原答案 QA 版本', () => asset('qa', string(originalQA.id), Number(originalQA.version)))); }
    if (a.artifact) for (const f of items(a.artifact.data.files)) menu.push(action(`作答证据 · ${f.name}`, async () => textPage(string(f.name), await readEvidence(access, 'artifact', a.artifact!.id, string(f.name), controller.current?.signal))));
    for (const e of a.executions ?? []) for (const f of items(object(e.data.grading_evidence).files)) menu.push(action(`评分轨迹 · ${f.name} · ${short(e.id)}`, async () => textPage(string(f.name), await readEvidence(access, 'execution', e.id, string(f.name), controller.current?.signal))));
    const id = string(a.result?.data.candidate_id ?? a.run.data.candidate_id);
    if (id) menu.push(action('审阅固定 Candidate 与代码', () => { setCandidate(id); }));
    for (const g of t.graders) menu.push(action(`查看评分规则 · ${g.data.name}`, () => asset('grader', g.id, g.version)));
    return textPage('逐题审阅', attemptText(t, a) + '\n\n' + noticesText(r.notices), menu);
  }
  async function comparison(ids: string[]): Promise<Page> {
    const rs = await reports(access, ids, controller.current?.signal);
    const chooseDifference = () => choose('选择基线实验', rs.map(base => action(`${object(base.experiment.data.subject).name} · ${short(base.experiment.id)}`, () =>
      choose('选择对照实验', rs.filter(peer => peer.experiment.id !== base.experiment.id).map(peer =>
        action(`${object(peer.experiment.data.subject).name} · ${short(peer.experiment.id)}`, () => differencePage(base, peer)))))));
    return page('多组实验对照', [], '选择题目与评分维度查看各组证据；各组存在多个尝试时必须显式选择。', {
      kind: 'matrix', matrix: rs, focus: 'rows', reload: () => comparison(ids), readAt: readAt(),
      menu: [action('按差异审阅', chooseDifference), action('查看配置、来源和计量说明', () => textPage('对照来源与配置', rs.map(reportText).join('\n\n---\n\n')))],
    });
  }
  function differencePage(base: EvalReport, peer: EvalReport, category: DifferenceKind | '全部' = '全部', dimension = ''): Page {
    const chosen = selectedRunsRef.current, all = differenceRows(base, peer, chosen), selected = all.filter(r => (category === '全部' || r.kind === category) && (!dimension || r.grader.id === dimension));
    const counts = (['改善','退步','持平','无法比较'] as DifferenceKind[]).map(kind => `${kind} ${all.filter(r => r.kind === kind && (!dimension || r.grader.id === dimension)).length}`).join(' · ');
    const dims = new Map(all.map(r => [r.grader.id, r.label.split(' · ').at(-1) || r.grader.id]));
    const menu = [action('切换分类', () => choose('按变化筛选', (['全部','改善','退步','持平','无法比较'] as const).map(kind => action(kind, () => differencePage(base, peer, kind, dimension))))), action('切换评分维度', () => choose('选择评分维度', [action('全部维度', () => differencePage(base, peer, category)), ...[...dims].map(([id,label]) => action(label, () => differencePage(base, peer, category, id)))])), action('查看两组来源', () => textPage('对照来源', reportText(base) + '\n\n---\n\n' + reportText(peer)))];
    const preview = (report: EvalReport, r: DifferenceRow) => {
      const task = report.tasks.find(t => t.task.id === r.taskId)!, attempt = selectedAttempt(task, chosen[`${report.experiment.id}/${r.taskId}`]);
      const grader = items(attempt?.result?.data.graders).find(g => object(g.grader).id === r.grader.id && object(g.grader).version === r.grader.version);
      return `${object(report.experiment.data.subject).name} · ${attempt ? `Run ${attempt.run.id}` : task.runs.length > 1 ? '待选择 Run' : '未执行'}\n答案：${string(attempt?.artifact?.data.answer).slice(0, 240) || '未记录'}\n结果：${taskStatus(task, chosen[`${report.experiment.id}/${r.taskId}`], r.grader)}\n评分依据：${string(object(grader?.submission).explanation) || string(grader?.missing_reason) || '未记录'}`;
    };
    return page('实验差异 · ' + category, selected.map(r => action(`${r.kind} · ${r.label}`, () => pairDetail(base, peer, r, selected))), `基线 ${object(base.experiment.data.subject).name} · ${base.experiment.id}\n对照 ${object(peer.experiment.data.subject).name} · ${peer.experiment.id}\nSnapshot ${base.snapshot.id}\n${counts}\n当前维度 ${dimension ? dims.get(dimension) : '全部'}\n${selected.length ? '上下选择题目即时查看两组摘要；Enter 展开。' : '当前筛选没有题目。'}`, { kind: 'difference', difference: selected, previews: selected.map(r => `${r.kind} · ${r.reason}\n\n${preview(base, r)}\n\n${preview(peer, r)}`), menu, reload: () => differencePage(base, peer, category, dimension), readAt: readAt() });
  }
  function pairDetail(base: EvalReport, peer: EvalReport, selected: DifferenceRow, visible: DifferenceRow[], chosen = selectedRunsRef.current): Page {
    const left = base.tasks.find(t => t.task.id === selected.taskId)!, right = peer.tasks.find(t => t.task.id === selected.taskId)!;
    const keyLeft = `${base.experiment.id}/${selected.taskId}`, keyRight = `${peer.experiment.id}/${selected.taskId}`;
    const a = selectedAttempt(left, chosen[keyLeft]), b = selectedAttempt(right, chosen[keyRight]);
    const side = (report: EvalReport, task: ReportTask, attempt: Attempt | undefined, key: string) => !attempt ? task.runs.length ? chosen[key] ? '原选择的 Run 已失效；请重新选择。' : '多次尝试未选择 Run。' : '尚未执行。' : attemptText(task, attempt);
    const chooseRun = (report: EvalReport, task: ReportTask, key: string) => choose('明确选择 Run', task.runs.map(attempt => action(`${short(attempt.run.id)} · ${attempt.run.data.mode} · ${attempt.run.data.state}`, () => {
      const next = { ...chosen, [key]: attempt.run.id }; selectedRunsRef.current = next; selectRuns(next); return pairDetail(base, peer, selected, visible, next);
    })), task.runs.length ? '不会自动选最新或最佳尝试。' : '没有尝试');
    const index = visible.findIndex(r => r.taskId === selected.taskId && r.grader.id === selected.grader.id);
    const menu = [action('选择基线 Run', () => chooseRun(base, left, keyLeft)), action('选择对照 Run', () => chooseRun(peer, right, keyRight)), ...(a ? [action('基线完整记录与证据', () => attemptPage(base, left, a))] : []), ...(b ? [action('对照完整记录与证据', () => attemptPage(peer, right, b))] : []), ...(index > 0 ? [action('上一题', () => pairDetail(base, peer, visible[index - 1], visible, chosen))] : []), ...(index + 1 < visible.length ? [action('下一题', () => pairDetail(base, peer, visible[index + 1], visible, chosen))] : [])];
    return page(`同题并排 · ${selected.label}`, [], `${selected.kind} · ${selected.reason}\n←/→ 切换窄屏组别；: 选择 Run、查看完整证据和上一题／下一题。`, { kind: 'pair', pair: { left: side(base, left, a, keyLeft), right: side(peer, right, b, keyRight), leftLabel: `${object(base.experiment.data.subject).name} · 基线`, rightLabel: `${object(peer.experiment.data.subject).name} · 对照` }, menu, focus: 'body' });
  }
  function compareTask(rs: EvalReport[], taskId: string, grader: Ref): Page {
    return choose('同题各组交付物', rs.map(r => {
      const t = r.tasks.find(x => x.task.id === taskId)!; const key = `${r.experiment.id}/${taskId}`; const selected = selectedAttempt(t, selections[key]);
      return action(`${object(r.experiment.data.subject).name} · ${taskStatus(t, selections[key])}`, () => t.runs.length === 1 && selected ? attemptPage(r, t, selected) : choose('选择本组尝试', t.runs.map(a => action(`${short(a.run.id)} · ${a.run.data.mode} · ${a.run.data.state}`, () => { selectRuns(prev => ({ ...prev, [key]: a.run.id })); return attemptPage(r, t, a); })), t.runs.length ? '选定后返回矩阵会保留，不自动选择最佳或最新。' : '此组尚未开始'));
    }), `当前评分维度：${refText(grader)}。每组详情保留全部评分说明及证据。`);
  }
  async function drafts(): Promise<Page> { const ds = await store.list(); return page('本机草稿与待恢复操作', ds.map(d => action(`${d.publication.command} · ${d.state} · ${short(d.id)}${d.databaseId !== context.databaseId ? ' · 其他账本' : ''}`, () => form(d))), ds.length ? '草稿保存在本机，退出后可继续。' : '没有草稿。', { reload: drafts }); }
  const capturedLabel=(v:unknown)=>({active:'当前草稿',boundary_pending:'题目边界待确认',replaced:'前驱已替代',pending:'待补／等待回执',reviewed:'已人工审核',ignored:'已忽略',not_applicable:'不适用',stable:'稳定知识',historical:'历史状态',unknown:'未知',human:'人工信息',model_suggestion:'模型建议',missing:'缺失',partial:'部分完成',conflict:'待处理冲突',published:'已发布',cancelled:'已取消',source:'来源包',qa:'题目',grader:'评分',suite:'题集',completed:'完成',rejected:'明确失败',not_started:'未开始'} as Record<string,string>)[String(v)]??String(v);
  async function candidateCall(command: string, args: string[] = [], body?: Data): Promise<any> {
    if (!access.qaDraft) throw new Error('当前 CLI 不支持采集 QA 草稿，请更新配套 CLI；不会开始分析或发布。');
    if (!READ_ONLY_DRAFT_CALLS.has(command)) captureEpoch.current++;
    if (!['draft.publish', 'draft.resume', 'draft.save-source'].includes(command)) return access.qaDraft(command, args, body);
    sending.current = true; let active = true; const started = Date.now(); setCaptureProgress('等待来源与发布回执；关闭页面不代表取消。');
    const poll = (async () => { while (active) { await new Promise(r => setTimeout(r, 350)); if (!active) break; try { const status = object(await access.qaDraft!('draft.status', [args[0]])), step = items(status.steps).at(-1); if (active) setCaptureProgress(`${status.source_save_pending ? '固定来源包' : step ? `${capturedLabel(step.name)} · ${capturedLabel(step.status)}` : String(status.publication_state)} · ${Math.floor((Date.now() - started) / 1000)}秒 · ${String(status.journal_id ?? args[0]).slice(-8)}`); } catch { if (active) setCaptureProgress('发布状态暂不可读；等待原回执，不重新创建。'); } } })();
    try { return await access.qaDraft(command, args, body); } finally { active = false; sending.current = false; setCaptureProgress(''); void poll; }
  }
  async function candidateList(): Promise<Data[]> { const all: Data[] = []; let cursor: string | undefined; do { const p = await candidateCall('draft.list', cursor ? ['--cursor', cursor] : []); all.push(...items(p.drafts)); cursor = p.next_cursor ?? undefined; } while (cursor); return all; }
  const evidenceRefs = (materials: Data[]): EvidenceRef[] => materials.flatMap((m, source) => items(m.evidence).map(e => ({ id: `${source}:${string(e.id)}`, kind: string(e.kind), name: string(e.name), digest: string(e.digest), size: Number(e.size) || 0 })));
  const evidenceKey = (draftId: string, e: EvidenceRef) => `${draftId}|${e.name}|${e.digest}`;
  async function readEvidenceBody(draftId: string, e: EvidenceRef, limitBytes = Number.POSITIVE_INFINITY): Promise<{ text: string; truncated: boolean }> {
    const chunks: Buffer[] = []; let offset = 0, total = 0, truncated = false;
    for (;;) {
      const f = await candidateCall('draft.evidence', [draftId, '--name', e.name, '--offset', String(offset)]), part = Buffer.from(f.content, 'base64');
      chunks.push(part); total += part.length;
      if (f.next_offset === null) break;
      if (total >= limitBytes) { truncated = true; break; }
      offset = f.next_offset;
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated };
  }
  /** Fill the timeline in the background, three reads at a time; failures are shown and retried on Ctrl+R. */
  function loadEvidence(draftId: string, refs: EvidenceRef[]) {
    for (const [key, value] of evidenceCache.current) if (key.startsWith(draftId + '|') && value.state === 'error') evidenceCache.current.delete(key);
    const todo = refs.filter(r => !evidenceCache.current.has(evidenceKey(draftId, r)) && !evidenceBusy.current.has(evidenceKey(draftId, r)));
    for (const r of todo) evidenceBusy.current.add(evidenceKey(draftId, r));
    let next = 0;
    const worker = async () => { for (;;) {
      const ref = todo[next++]; if (!ref) return;
      const key = evidenceKey(draftId, ref);
      try { evidenceCache.current.set(key, { state: 'ok', ...await readEvidenceBody(draftId, ref, 131072) }); }
      catch (error) { evidenceCache.current.set(key, { state: 'error', message: error instanceof Error ? error.message : String(error) }); }
      finally { evidenceBusy.current.delete(key); evidenceVersion.current++; if (alive.current) setEvidenceTick(t => t + 1); }
    } };
    void Promise.all([worker(), worker(), worker()]);
  }
  async function summariesOf(rows: Data[]): Promise<DraftSummary[]> {
    const out: DraftSummary[] = new Array(rows.length); let next = 0;
    const worker = async () => { for (;;) {
      const index = next++; if (index >= rows.length) return;
      if (index >= 40) { out[index] = fallbackSummary(rows[index]); continue; }
      try { out[index] = summarize(viewOf(object(await candidateCall('draft.show', [String(rows[index].id)])))); } catch { out[index] = fallbackSummary(rows[index]); }
    } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }
  async function capturedDrafts(): Promise<Page> {
    const all = await candidateList();
    if (!all.length) return page('采集 QA · 本机权威草稿', [], '尚无草稿。请用 graphkb CLI 离线提取并交接；Grounds 不启动模型。', { reload: capturedDrafts, chrome: 'capture' });
    const summaries = await summariesOf(all), labels = rowLabels(summaries);
    return page('采集 QA · 本机权威草稿', all.map((d, i) => ({ id: String(d.id), label: labels[i], search: `${d.identity} ${summaries[i].question} ${summaries[i].status} ${summaries[i].digest}`, action: () => capturedDraft(String(d.id)) })), '', { reload: capturedDrafts, capture: true, chrome: 'capture', listWidth: .42, epoch: captureEpoch.current, context: `共 ${all.length} 份本机草稿${all.length > 40 ? '（前 40 份显示题名，其余只显示编号）' : ''} · 读取于 ${clock(Date.now(), false, false)}`, render: (width, id) => renderListPreview(summaries, id, width) });
  }
  async function sourceClues(state?: string, project?: string): Promise<Page> {
    const all: Data[] = []; let cursor: string | undefined;
    do { const p = await candidateCall('clue.list', [...(state ? ['--state', state] : []), ...(project ? ['--project', project] : []), ...(cursor ? ['--cursor', cursor] : [])]); all.push(...items(p.clues)); cursor = p.next_cursor ?? undefined; } while (cursor);
    return page('待提取来源线索 · 不是 QA', all.map(c => action(`${object(c.source).project_id} · ${object(c.source).host} · ${capturedLabel(c.state)} · ${object(c.source).reason} · ${short(String(c.id))}`, async () => {
      const value = object(await candidateCall('clue.show', [String(c.id)]));
      return page('来源线索 · 仅元数据', value.ignored ? [] : [action('忽略此线索（保留来源索引）', async () => { await candidateCall('clue.ignore', [String(value.id), '--expected-version', String(value.version)]); return sourceClues(state, project); })], `${json(value)}\n\n线索不包含会话正文，不是 QA 或正确答案。请通过 graphkb CLI 离线分析形成草稿后审核。到期不续期，忽略决定独立保留。`, { menu: [action('返回线索列表', () => sourceClues(state, project))] });
    })), all.length ? '↑↓/Enter 查看元数据；/ 按项目、宿主、状态或原因筛选。Grounds 不启动模型，不将线索直接转换成题目。' : '尚无匹配线索。请通过 graphkb capture handoff-clues 显式交接元数据；无需生成 QA。', { reload: () => sourceClues(state, project), menu: [action('全部线索', () => sourceClues(undefined, project)), action('只看待提取', () => sourceClues('pending_analysis', project)), action('只看到期', () => sourceClues('expired', project)), action('只看已忽略', () => sourceClues('ignored', project)), action('按项目 ID 筛选', () => { ask('项目 ID（空表示全部）', project ?? '', value => sourceClues(state, value.trim() || undefined)); })] });
  }
  async function capturedDraft(id: string): Promise<Page> {
    const value = await candidateCall('draft.show', [id]), d = object(value.draft), q = object(value.qa), review = object(d.review), v = String(d.version);
    const editCandidate = async (patch: Data) => { await candidateCall('draft.edit', [id, '--expected-version', v], patch); return capturedDraft(id); };
    const rows: Item[] = [];
    if (d.state === 'boundary_pending') {
      rows.push(action('关联已有题目（保留人工题面）', async () => {
        const related = new Set(object(d.boundary).related_drafts as string[] ?? []);
        const targets = (await candidateList()).filter(t => t.state === 'active');
        return choose('明确选择题目 · 新材料作为待审建议', targets.map(t => action(`${related.has(String(t.id)) ? '相关来源 · ' : ''}${t.identity}`, () => choose('确认关联题目', [action('确认关联，返回目标题目审核', async () => {
          const result = await candidateCall('draft.resolve-boundary', [id, '--expected-version', v], { kind: 'existing', target: { id: t.id, version: t.version } });
          return capturedDraft(String(result.id));
        })], `目标 ${t.identity} · v${t.version}。保留人工字段和原模型题面，新材料进入建议列表；该提议不再独立发布。`))));
      }));
      rows.push(action('确认这是独立新题', () => choose('确认新的题目边界', [action('确认新题并继续补充审核', async () => {
        await candidateCall('draft.resolve-boundary', [id, '--expected-version', v], { kind: 'new' }); return capturedDraft(id);
      })], '同一原始消息已有题目。请核对这是首次遗漏的独立问题，还是已有题目的细分。确认后保留关联记录，仍需补充和审核；不会自动发布。')));
      for (const related of object(d.boundary).related_drafts as string[] ?? []) rows.push(action(`查看相关题目 ${short(related)}`, () => capturedDraft(related)));
    }
    if (d.state === 'active' && !items(d.source_saves).some(s => !s.result) && (!d.journal || ['published', 'cancelled'].includes(String(object(d.journal).state)))) {
      for (const [key, label] of [['name', '名称'], ['question', '公开题目'], ['instructions', '公开作答条件'], ['rubric', '私有评分标准（Rubric）'], ['reference_answer', '私有参考答案（可选）'], ['required_points', '必答要点'], ['forbidden_claims', '错误说法'], ['references', '私有依据']]) {
        const current = Array.isArray(q[key]) ? (q[key] as string[]).join(' / ') : string(q[key]);
        rows.push({ ...action(`编辑 · ${label} · ${fieldTag(key, q, object(value.provenance), (value.verified_fields as string[] ?? [])).text} · ${clipCells(current, 30) || '（空）'}`, async () => {
          const array = ['required_points', 'forbidden_claims', 'references'].includes(key);setPrompt({label:`${label} · 内存编辑，Ctrl+S 保存`,value:array?(q[key] as string[]??[]).join('\n'):string(q[key]),multiline:true,commit:async text=>editCandidate({qa:{[key]:array?text.split(/\r?\n/).filter(s=>s.trim()):text}})});
        }, true), search: key });
      }
      rows.push(action('审核条件与权威依据', () => capturedReview(id, v, review, q, items(value.materials))));
      rows.push(action('拆为两题（新身份，保留来源）', () => choose('确认拆分边界', [action('确认拆为两份待编辑草稿', async () => { const result = await candidateCall('draft.split', [id, '--expected-version', v], { successors: [{}, {}] }); return choose('分别补齐拆分题目', (result as Data[]).map(s => action(String(s.identity), () => capturedDraft(String(s.id))))); })], '前驱将标为被替代，不再独立发布。自动字段仍是有期限的模型建议，人工字段保持来源；两份后继需分别编辑和审核。')));
      rows.push(action('与另一草稿合并', async () => { const others = (await candidateList()).filter(s => s.id !== id && s.state === 'active'); return choose('明确选择合并对象', others.map(s => action(String(s.identity), () => choose('确认合并', [action('确认合并并继续补齐', async () => { const merged = await candidateCall('draft.merge', [], { predecessors: [{ id, version: d.version }, { id: s.id, version: s.version }], qa: {} }); return capturedDraft(merged.id); })], '当前题面仍按原字段来源读取，不会把模型建议自动保存成人工正文；保留两侧证据，另一题的人工编辑仍可在前驱查看。新题必须补齐和审核。')))); }));
      rows.push(action('明确长期保存必要来源包', () => choose('确认长期保存证据', [action('确认保存到当前账本', async () => { await candidateCall('draft.save-source', [id, '--expected-version', v]); return capturedDraft(id); })], `保存范围：本草稿关联的必要交接材料与审核信息。当前账本 ${context.databaseId}。独立长期包不自动清理；此操作不发布 QA。`)));
      rows.push(action('选择题集与模板并预览发布', () => capturedTarget(id, v, d)));
      rows.push(action('忽略线索（保留来源）', () => editCandidate({ review: { ...review, status: 'ignored' } })));
    }
    if (items(d.source_saves).some(s => !s.result)) rows.push(action('核查并恢复原来源保存', async () => { await candidateCall('draft.resume', [id]); return capturedDraft(id); }));
    if (d.journal) {
      const journal = object(d.journal);
      if(items(journal.steps).some(s=>s.name==='qa'&&s.status==='completed'))rows.push(action('导出固定 QA 的公开题面',()=>{ask('公开题面导出文件（只含问题／指令）','qa-public-question.json',async out=>{await candidateCall('draft.export-public',[id,'--out',out]);return capturedDraft(id);});}));
      rows.push(action('发布记录与部分完成对象', () => textPage('发布步骤与回执', json(journal))));
      if (['partial', 'pending'].includes(String(journal.state))) rows.push(action('核查并恢复原发布', async () => { await candidateCall('draft.resume', [id]); return capturedDraft(id); }));
      if (journal.state === 'conflict') rows.push(action('重新选择题集成员并预览冲突恢复', () => capturedTarget(id, v, d)));
      if (!items(journal.steps).some(s => s.status === 'pending') && journal.state !== 'published') rows.push(action('取消剩余发布步骤', () => choose('确认取消剩余步骤', [action('确认取消，保留完成对象', async () => { await candidateCall('draft.cancel', [id, '--expected-version', v]); return capturedDraft(id); })], '已经完成的来源包、QA 和评分不会撤回；结果未知步骤必须先恢复。')));
    }
    for (const s of items(d.suggestions)) rows.push(action(`重提取建议 ${s.revision} · 明确选择后继`, async () => {
      const all = (await candidateList()).filter(t => t.state === 'active'); return choose('建议路由：不会覆盖人工字段', all.map(t => action(String(t.identity), async () => { await candidateCall('draft.route-suggestion', [id, '--expected-version', v], { digest: s.digest, target: { id: t.id, version: t.version } }); return capturedDraft(String(t.id)); })));
    }));
    const materials = items(value.materials), detail = viewOf(value), allRefs = evidenceRefs(materials), refs = allRefs.slice(0, PREFETCH_EVIDENCE);
    // The timeline is read in the background (immutable per digest) and fills in as it arrives.
    loadEvidence(id, refs);
    let memo: { version: number; entries: ReturnType<typeof buildTimeline> } | undefined;
    const timeline = () => { if (memo?.version !== evidenceVersion.current) memo = { version: evidenceVersion.current, entries: buildTimeline(refs, r => evidenceCache.current.get(evidenceKey(id, r))) }; return memo.entries; };
    for (const e of allRefs) rows.push({ id: e.id, get label() { const entries = timeline(), at = entries.findIndex(entry => entry.key === e.id); return at < 0 ? `原始记录 · ${e.kind}（${refs.includes(e) ? '已并入相关查询' : '未预读，打开查看'}）` : `原始记录 · [${at + 1}] ${entries[at].heading}${entries[at].ms === undefined ? '' : ' · ' + clock(entries[at].ms!, false, false)}`; }, search: `证据 ${e.kind} ${e.name}`, action: async () => {
      const raw = (await readEvidenceBody(id, e)).text, one = buildTimeline([e], () => ({ state: 'ok', text: raw })), parsed = (() => { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; } })();
      return page('采集证据 · QA 对照', [], '', { kind: 'pair', chrome: 'capture', pair: { left: '', right: '', leftLabel: '这条现场记录', rightLabel: '模型提出的题 · 原生 QA', shortLabels: ['现场记录', '模型的题'], leftLines: width => [...renderTimeline(one, { width }), '', rule(width, '原始记录（技术细节）'), ...wrapBlock(`${e.kind} · ${e.name} · ${e.digest} · ${e.size} bytes`, width), '', ...wrapBlock(parsed, width)], rightLines: memoLines(width => renderQAPane(detail, width)) }, menu: [action('返回审核', () => capturedDraft(id))], focus: 'body' });
    } });
    rows.push(action('技术细节 · 来源标识、哈希、字节数与限制代码', () => page('技术细节', [], '', { render: memoLines(width => renderTechnical(detail, width)), chrome: 'capture', menu: [action('返回审核', () => capturedDraft(id))] })));
    for(const retained of [...(d.saved?[object(d.saved)]:[]),...items(d.retained_packages)])rows.push(action(`读取长期来源包 ${String(retained.digest).slice(-8)}`, async () => {
      const manifest = await candidateCall('source-package.show', [String(retained.digest)]); return choose('固定来源证据', items(manifest.evidence).map(e => action(`${e.kind} · ${e.locator}`, async () => { const chunks: Buffer[] = []; let offset = 0; for (; ;) { const f = await candidateCall('source-package.file', [String(retained.digest), '--name', String(e.name), '--offset', String(offset)]); chunks.push(Buffer.from(f.content, 'base64')); if (f.next_offset === null) break; offset = f.next_offset; } return textPage('长期证据', Buffer.concat(chunks).toString('utf8')); })));
    }));
    return page('采集 QA · 证据对照', [], '', { kind: 'pair', capture: true, captureId: id, epoch: captureEpoch.current, chrome: 'capture', context: `草稿 ${short(id)} · v${d.version} · 读取于 ${clock(Date.now(), false, false)}`, pair: { left: '', right: '', leftLabel: '现场发生了什么 · 按时间顺序', rightLabel: '模型提出的题 · 待你核对', shortLabels: ['现场记录', '模型的题'], leftLines: memoLines(width => renderEvidencePane({ entries: timeline(), materials, width, missing: detail.missing, omitted: allRefs.length - refs.length }), () => evidenceVersion.current), rightLines: memoLines(width => renderQAPane(detail, width)), banner: memoLines(width => renderBanner(detail, width)) }, menu: rows, focus: 'body', reload: () => capturedDraft(id) });
  }
  function capturedReview(id: string, version: string, review: Data, qa: Data, materials: Data[]): Page {
    const save = async (patch: Data) => { await candidateCall('draft.edit', [id, '--expected-version', version], { review: { ...review, ...patch } }); return capturedDraft(id); };
    return page('人工审核条件', [
      action(`独立文本题面：${review.independent_text ? '已确认' : '待确认'}`, () => save({ independent_text: !review.independent_text, status: 'pending' })),
      action(`必要附件已整理：${review.attachments_resolved ? '已确认' : '待补'}`, () => save({ attachments_resolved: !review.attachments_resolved, status: 'pending' })),
      action('填写权威依据（纠正仅是线索）', async () => save({ authority: await editLongText(string(review.authority)), status: 'pending' })),
      action('标为稳定知识', () => save({ knowledge: 'stable', status: 'pending' })),
      action('标为历史状态，补可重现条件', async () => { const c = object(review.answer_conditions); ask('固定来源／环境定位', string(c.locator), async locator => { const instructions = await editLongText(string(c.instructions)); return choose('确认历史作答条件', [action('确认被测者可访问，保持原题意', () => save({ knowledge: 'historical', answer_conditions: { locator, instructions, accessible: true, preserves_question: true }, status: 'pending' }))], '必要条件必须同时写入公开作答指令。日期或 graph revision 不证明能查历史值；不能公开旧答案来代替检索。'); }); }),
      action('标为待补', () => save({ status: 'pending' })), action('标为不适用', () => save({ status: 'not_applicable' })),
      action('确认已核实题面与评分依据', () => save({ status: 'reviewed' })),
    ], '', { chrome: 'capture', render: width => [...reviewChecklist(review, qa, materials).flatMap(item => wrapBlock(item.label, width - 4, `${item.done ? '[✓] ' : '[ ] '}`, '    ')), '', ...wrapBlock('只保存审核决定；正式发布仍需通过独立题面、必要证据、历史可答条件与准确目标检查。', width)] });
  }
  async function capturedTarget(id: string, version: string, d: Data): Promise<Page> {
    const j = object(d.journal), oldTarget = object(j.target), conflict = j.state === 'conflict';
    const suites = await readRecords(access, 'suite');
    return choose('选择发布题集', suites.filter(s => !conflict || s.id === object(oldTarget.suite).id).map(s => action(recordLabel(s), async () => {
      const latest = await readRecord(access, 'suite', s.id), qaResult = object(items(j.steps).find(x => x.name === 'qa')?.result), qa = qaResult.id ? { id: qaResult.id, version: qaResult.version } : undefined;
      const pick = async (member: Data,selectedQA?:Data) => {
        const graders = await readRecords(access, 'grader'); return choose('选择准确版本的 QA 评分模板', graders.filter(g => g.data.qa && object(g.data.definition).type === 'agent').filter(g => !conflict || g.id === object(oldTarget.template).id).map(g => action(recordLabel(g), async () => {
          const template = conflict ? oldTarget.template : { id: g.id, version: g.version }; const target = { suite: { id: latest.id, version: latest.version }, member, template, ...(conflict ? oldTarget.qa ? { qa: oldTarget.qa } : {} : selectedQA?{qa:selectedQA}:qa ? { qa } : {}) };
          const preview = await candidateCall('draft.preview', [id, '--expected-version', version], target);
          return page('明确确认：固定来源、QA、评分与题集成员', [action('确认按此预览发布', async () => { await candidateCall('draft.publish', [id, '--expected-version', version, '--confirm-digest', preview.digest], target); return capturedDraft(id); }), action('返回继续审核', () => capturedDraft(id))], '', { chrome: 'capture', render: memoLines(width => [...renderPublishPreview(preview, width), '', ...wrapBlock('固定草稿或题集变化需重新预览；本次不运行评测。', width)]) });
        })), graders.length ? '模板内容可复用，评分实例绑定准确 QA 版本；同版同配置可匹配，跨版本须新实例。' : '没有评分模板，请先通过评分规则入口创建 QA Agent Grader。');
      };
      const selectedMember=async(member:Data)=>{if(conflict)return pick(member);const prior=(await readRecords(access,'qa')).find(q=>object(q.data.source).identity===d.identity);if(prior&&(!qa||qa.id!==prior.id||qa.version!==prior.version))return choose('明确选择已有 QA 的当前版本',[action(`基于当前 QA v${prior.version} 修订（保留本机草稿）`,()=>pick(member,{id:prior.id,version:prior.version})),action('返回审核',()=>capturedDraft(id))],`原预期：${json(qa??oldTarget.qa??'尚未绑定')}\n\n当前 QA ${prior.id} v${prior.version}\n${assetText(prior)}\n\n本机草稿保留；这一步只选择新预期，最后仍需完整预览确认。`);return pick(member);};
      return choose('明确新增或更新成员', [action('新增一个成员', () => selectedMember({ mode: 'add' })), ...items(latest.data.tasks).map(t => action(`更新成员 ${t.name} · ${t.id}`, () => selectedMember({ mode: 'update', id: t.id })))], conflict ? '仅修改选定成员，保留其他题集变更；原成员已删除需明确另选或新增。' : '新增与更新必须明确选择，历史 Snapshot 不变。');
    })));
  }
  async function saveField(d: Draft, path: string, value: unknown): Promise<Page> { const p = structuredClone((await store.load(d.id)).publication); const parts = path.split('.'); let at = p as unknown as Data; for (const part of parts.slice(0, -1)) at = at[part] as Data; if (value === undefined) delete at[parts.at(-1)!]; else at[parts.at(-1)!] = value; return form(await store.edit(d, p)); }
  async function form(input: Draft): Promise<Page> {
    const d = await store.load(input.id), p = d.publication, b = p.body ?? {};
    if (p.command === 'suite.tasks.publish') return suiteBatchForm(d);
    const rows: Item[] = [], menu: Item[] = [];
    const editable = !['pending', 'published'].includes(d.state) && d.databaseId === context.databaseId;
    const field = (label: string, path: string, value: unknown, type: 'short' | 'long' | 'lines' | 'number' = 'short') => { rows.push(action(`${label}：${type === 'long' ? string(value).slice(0, 24) || '未填写' : Array.isArray(value) ? value.join(' / ') || '未填写' : string(value) || '未填写'}`, () => {
      if (!editable) throw new Error('此草稿不可编辑，请先核查状态');
      if (type === 'long' || type === 'lines') return (async () => { const result = await editLongText(type === 'lines' ? (value as string[] ?? []).join('\n') : string(value)); return saveField(d, path, type === 'lines' ? result.split(/\r?\n/).filter(v => v.trim()) : result.trim() ? result : path.endsWith('reference_answer') ? undefined : result); })();
      ask(label, string(value), v => saveField(d, path, type === 'number' ? Number(v) : v));
    }, true)); };
    if (editable) {
      if (p.command === 'suite.create') field('题集名称', 'name', p.name);
      else if (p.command !== 'suite.task.remove') {
        field('名称', 'body.name', b.name);
        if (p.command === 'qa.publish') { field('公开题目', 'body.question', b.question, 'long'); field('公开作答指令', 'body.instructions', b.instructions, 'long'); field('私有 Rubric', 'body.rubric', b.rubric, 'long'); field('私有参考答案', 'body.reference_answer', b.reference_answer, 'long'); for (const [k, label] of [['required_points','必需要点'],['forbidden_claims','禁止断言'],['references','私有参考材料']]) field(label, `body.${k}`, b[k], 'lines'); }
        else {
          rows.push(action(`任务：${refText(b.qa ?? b.issue)} · 选择版本`, () => chooseTask(async target => {
            if (p.command === 'grader.publish' && p.id) throw new Error('已有 Grader 身份的任务版本固定；请新建另一个 Grader');
            const next = { ...b }; delete next.qa; delete next.issue; delete next.kind; Object.assign(next, target);
            if (p.command.startsWith('suite.task.')) { if (target.qa) next.kind = 'qa'; next.graders = []; }
            else Object.assign(next, newGrader(target), { name: b.name });
            return form(await store.edit(d, { ...p, body: next }));
          })));
          if (p.command.startsWith('suite.task.')) rows.push(action(`评分版本：${items(b.graders).map(refText).join(' / ') || '未选择'}`, () => pickGraders(d)));
          else {
            const def = object(b.definition), scope = object(b.scope), spec = object(b.result_spec);
            rows.push(action(`类型：${def.type}`, () => choose('评分类型', [action('Agent', () => saveField(d, 'body.definition', { type: 'agent', instructions: '' })), ...(!b.qa ? [action('Go 单测', async () => form(await store.edit(d, { ...p, body: { ...b, definition: { type: 'unit_test', adapter: 'go', package: '.', test_name: '', timeout_seconds: 30, files: [] }, result_spec: { kind: 'decision' } } })))] : [])])));
            rows.push(action(`范围：${scope.kind}`, () => choose('评分范围', [action('诊断维度', () => saveField(d, 'body.scope', { kind: 'diagnostic', name: '' })), ...(!b.qa ? [action('Criterion', () => pickCriteria(d))] : [])])));
            if (scope.kind === 'diagnostic') field('维度名称', 'body.scope.name', scope.name); else rows.push(action(`Criterion：${(scope.criterion_ids as string[] ?? []).join(', ')}`, () => pickCriteria(d)));
            if (!b.qa && def.type === 'agent') rows.push(action(`结果：${spec.kind}`, () => choose('结果类型', [action('通过／失败', () => saveField(d, 'body.result_spec', { kind: 'decision' })), action('区间分数', () => saveField(d, 'body.result_spec', { kind: 'score', min: 0, max: 100, higher_is_better: true, rubric: '' }))])));
            if (spec.kind === 'score') { field('最小分', 'body.result_spec.min', spec.min, 'number'); field('最大分', 'body.result_spec.max', spec.max, 'number'); rows.push(action(`方向：${spec.higher_is_better ? '越高越好' : '越低越好'}`, () => saveField(d, 'body.result_spec.higher_is_better', !spec.higher_is_better), true)); field('分数 Rubric', 'body.result_spec.rubric', spec.rubric, 'long'); }
            if (def.type === 'agent') field('Agent 私有评分指令', 'body.definition.instructions', def.instructions, 'long');
            else { field('Go 相对包路径', 'body.definition.package', def.package); field('Go Test 函数名', 'body.definition.test_name', def.test_name); field('超时（秒）', 'body.definition.timeout_seconds', def.timeout_seconds, 'number'); rows.push(action(`测试文件（${items(def.files).length}）`, () => goFiles(d))); }
            field('评分局限', 'body.limitations', b.limitations, 'long');
          }
        }
      }
      rows.push(action('预览变化与发布确认', async () => confirmation(await store.prepare(d, await access.identity()))));
    }
    if (d.state === 'pending' || d.state === 'prepared') rows.push(action('查看原请求并恢复', () => confirmation(d)));
    if (d.state === 'rejected' && p.id) rows.push(action('读取最新版本并处理冲突', async () => {
      const latest = await readRecord(access, p.command.split('.')[0], p.id!);
      return choose('冲突内容对照', [action('基于最新版本重新编辑（保留当前正文）', async () => { const next = await store.edit(d, { ...p, expectedVersion: latest.version }); next.original = latest; await store.save(next); return form(next); })], `## 原版本 v${p.expectedVersion}\n${json(d.original?.data)}\n\n## 最新版本 v${latest.version}\n${assetText(latest)}\n\n## 当前草稿\n${json(p.body)}`);
    }));
    if (d.state !== 'pending') menu.push(action(d.state === 'published' ? '清理已发布草稿' : '放弃本机草稿', () => choose('确认清理草稿', [action('确认清理', async () => { await store.discard(d); return drafts(); })], '此操作只清理本机草稿，不删除账本记录。')));
    const body = [d.result ? `发布成功：${d.result.id} · v${d.result.version}` : '', `草稿：${d.id}`, `状态：${d.state}`, `目标账本：${d.databaseId}`, d.databaseId !== context.databaseId ? '当前账本不匹配；请切回原数据库配置。' : '', p.id ? `修订身份 ${p.id} · 原版本 ${p.expectedVersion}` : '新建资产', d.error || '', d.result ? `发布成功：${d.result.id} · v${d.result.version}` : '', '正文保存在本机私有草稿；修改后需要显式发布。'].filter(Boolean).join('\n\n');
    return page(d.state === 'published' ? '资产草稿 · 已发布' : '资产草稿', rows, body, { kind: 'form', draft: d, menu, reload: () => form(d) });
  }
  async function pickGraders(d: Draft): Promise<Page> {
    const b = d.publication.body!, target = object(b.qa ?? b.issue); const all = await readRecords(access, 'grader'); const rows: Item[] = [];
    for (const g of all) {
      const ref = object(g.data.qa ?? g.data.issue); if (ref.id !== target.id || ref.version !== target.version) continue;
      rows.push(action(recordLabel(g), () => versions('选择评分版本', g.version, async n => {
        const selected = await readRecord(access, 'grader', g.id, n); const notices = await access.read('grader.notices', [g.id, '--version', String(n)]) as EvalRecord[];
        return choose('确认评分版本', [action('使用此版本', async () => { const refs = items(b.graders).filter(r => r.id !== g.id); refs.push({ id: g.id, version: n }); return saveField(d, 'body.graders', refs); }), action('从草稿移除此评分', () => saveField(d, 'body.graders', items(b.graders).filter(r => r.id !== g.id)))], assetText(selected) + '\n\n' + noticesText(notices));
      })));
    }
    return choose('选择匹配的 Grader', rows, rows.length ? '同一 Grader 只能选择一个版本；可重复进入添加其他维度。' : '此任务版本没有评分规则，请先在评分规则入口新建。');
  }
  async function pickCriteria(d: Draft): Promise<Page> {
    const ref = object(d.publication.body!.issue), result = await reader.query('issue', [string(ref.id), '--issue-version', string(ref.version)]), issue = object(result.issue);
    if (issue.id !== ref.id || issue.version !== ref.version) throw new Error('Issue 版本不匹配');
    const selected = (object(d.publication.body!.scope).criterion_ids as string[] ?? []);
    return choose('选择 Criterion（逐项切换）', ['goals', 'constraints'].flatMap(k => items(issue[k]).flatMap(t => items(t.criteria).map(c => action(`${selected.includes(string(c.id)) ? '✓' : '○'} ${c.statement}`, async () => { const ids = selected.includes(string(c.id)) ? selected.filter(id => id !== c.id) : [...selected, string(c.id)]; return saveField(d, 'body.scope', { kind: 'criterion', criterion_ids: ids }); })))));
  }
  async function goFiles(d: Draft): Promise<Page> {
    const files = items(object(d.publication.body!.definition).files);
    return choose('Go 测试文件', [...files.map((f, index) => action(string(f.path), () => choose(string(f.path), [action('编辑文件正文', async () => { const value = await editLongText(string(f.content)); const next = structuredClone(files); next[index].content = value; return saveField(d, 'body.definition.files', next); }), action('移除此文件', () => saveField(d, 'body.definition.files', files.filter((_, i) => i !== index)))]))), action('新增 *_test.go 文件', () => ask('测试文件名', '', async name => { if (!/^[A-Za-z0-9_-]+_test\.go$/.test(name) || files.some(f => f.path === name) || files.length >= 20) throw new Error('文件名无效、重复或已达 20 个'); return saveField(d, 'body.definition.files', [...files, { path: name, content: '' }]); }))]);
  }
  function confirmation(d: Draft): Page {
    const request = d.request!;
    const execute = async (original = false) => { sending.current = true; try {
      const done = await store.send(d, access, original);
      if (done.returnTo && done.state === 'published') {
        const parent = await store.load(done.returnTo);
        if (done.publication.command === 'grader.publish' && done.returnToTask && done.result && parent.databaseId === done.databaseId && parent.publication.command === 'suite.tasks.publish') {
          const tasks = batchTasks(parent), { index, id } = done.returnToTask;
          const restored = id ? tasks.findIndex(task => task.id === id) : index;
          if (restored >= 0 && restored < tasks.length && (!id || tasks[restored].id === id) && isDeepStrictEqual(tasks[restored].qa ?? tasks[restored].issue, done.publication.body?.qa ?? done.publication.body?.issue)) return editBatchTask(parent, restored, done.result);
        }
        return suiteBatchForm(parent);
      }
      return form(done);
    } finally { sending.current = false; } };
    return choose('发布确认 · 核对后执行', [action('确认按原请求发布／恢复', () => execute()), action('当前归属改变时，明确按原归属恢复', () => execute(true)), action('返回草稿', () => form(d))], `账本：${d.databaseId}\n\n操作：${request.command}\n\n归属：${request.attribution.git_name} <${request.attribution.git_email}>\n\n原版本：${request.expectedVersion ?? '新建'}\n\n## 原内容\n${d.original ? assetText(d.original) : '无'}\n\n## 待发布内容\n${request.command === 'suite.tasks.publish' ? batchSummary(d) : request.body ? preview(request.body) : request.name ?? `移除任务 ${request.taskId}`}\n\n仅此操作写入，不执行实验。`);
  }
  function preview(body: Data) { if (body.question !== undefined) return assetText({ id: '待发布', kind: 'qa', version: 1, created_at: '待发布', attribution: {}, data: body }); if (body.definition) return assetText({ id: '待发布', kind: 'grader', version: 1, created_at: '待发布', attribution: {}, data: body }); return `${body.name}\n\n任务：${refText(body.qa ?? body.issue)}\n\nGrader：${items(body.graders).map(refText).join('\n')}`; }
  const matrix = screen.matrix ? matrixRows(screen.matrix, selections) : [];
  const filtered = matching(screen.rows, screen.filter);
  const listSize = screen.kind === 'matrix' ? matrix.length : filtered.length;
  const row = Math.max(0, Math.min(screen.row, Math.max(0, listSize - 1)));
  const back = () => { if (sending.current) return; controller.current?.abort(); serial.current++; setBusy(false); setNotice(''); if (prompt) { setPrompt(undefined); return; } if (searching) { setSearching(false); return; } if (history.length) { const previous = history.at(-1)!; setScreen(previous); setHistory(history.slice(0, -1)); if (previous.draft || (previous.kind === 'difference' || (previous.capture && previous.epoch !== captureEpoch.current)) && previous.reload) perform(async () => ({ ...await (previous.draft ? form(previous.draft) : previous.reload!()) as Page, row: previous.row, scroll: previous.scroll, focus: previous.focus }), true); } else onBack(); };
  const showMenu = () => { const menuPage = choose('当前操作', [...(notice ? [action('查看完整错误', () => textPage('操作未完成', notice + '\n\n原数据与草稿保留；可返回重试或处理冲突。'))] : []), ...(screen.menu ?? []), ...(screen.reload ? [action('刷新当前页面', screen.reload)] : []), action('本机草稿与待恢复操作', drafts)]); enterPage({ ...menuPage, chrome: screen.chrome, context: screen.chrome ? `操作菜单 · 共 ${menuPage.rows.length} 项 · 按 / 可筛选` : undefined }); };
  const viewport = Math.max(1, height - 7);
  useInput((input, key) => {
    if (candidate) return;
    if (key.ctrl && input === 'c') { if (!sending.current) onExit(); return; }
    if (width < 40 || height < 10) { if (input === 'q') onExit(); return; }
    const editing = promptRef.current;
    if (editing) {
      if (busy) return;
      if (key.escape) setPrompt(undefined);
      else if((editing.multiline&&key.ctrl&&input==='s')||(!editing.multiline&&key.return))perform(()=>editing.commit(editing.value),true);
      else if(editing.multiline&&key.return)setPrompt({...editing,scroll:undefined,value:editing.value+'\n'});
      else if (key.pageUp || key.pageDown) setPrompt({ ...editing, scroll: Math.max(0, Math.min((editing.scroll ?? Math.max(0, bodyLines.length - bodyHeight)) + (key.pageUp ? -bodyHeight : bodyHeight), Math.max(0, bodyLines.length - bodyHeight))) });
      else if (key.backspace || key.delete) setPrompt({ ...editing, scroll: undefined, value: Array.from(editing.value).slice(0, -1).join('') });
      else if (!key.ctrl && !key.meta && input) setPrompt({ ...editing, scroll: undefined, value: editing.value + (editing.multiline?clean(input):clean(input).replace(/[\r\n]/g, '')) }); return;
    }
    if (searching) { if (key.escape || key.return) setSearching(false); else if (key.backspace || key.delete) mutate({ filter: screen.filter.slice(0, -1), row: 0 }); else if (!key.ctrl && !key.meta) mutate({ filter: screen.filter + clean(input).replace(/[\r\n]/g, ''), row: 0 }); return; }
    if (key.escape) { back(); return; } if (busy) return;
    if (input === 'q') { onExit(); return; }
    if (input === ':') { showMenu(); return; }
    if (input === '?') { enterPage(textPage('操作帮助', '↑↓ 选择或滚动 · Enter 打开／执行 · Tab 切换列表与正文 · PgUp/PgDn 翻页 · / 筛选列表 · : 当前操作（编辑、历史版本、发布、证据） · Ctrl+R 刷新 · Esc 返回 · q / Ctrl+C 退出\n\n实验列表：Space 选择多组，c 进入对照。矩阵：←/→ 横向查看组，d 选择基线并按差异审阅，Enter 进入同题各组证据。并排详情：←/→ 切换组别，: 选择尝试、证据及上一题／下一题。草稿：Enter 编辑选中字段；正文进入外部编辑器。发布确认页先 Tab 阅读完整原内容与待发布内容，再选确认。\n\n采集 QA 审核：左栏是现场记录（按时间顺序），右栏是模型提出的题；←/→ 换栏，↑↓ 滚动当前栏；: 菜单里编辑字段、审核、发布。字段标签含义：模型建议＝还没人核对，人工填写／已人工确认＝你已处理，待补＝必须补充。')); return; }
    if (key.ctrl && input === 'r' && screen.reload) { perform(screen.reload, true); return; }
    if (input === '/' && screen.rows.length) { setSearching(true); return; }
    if (key.tab) { mutate({ focus: screen.focus === 'rows' ? 'body' : 'rows' }); return; }
    if (screen.kind === 'pair' && (key.leftArrow || key.rightArrow)) { setColumn(key.rightArrow ? 1 : 0); return; }
    if (screen.kind === 'matrix' && (key.leftArrow || key.rightArrow)) { setColumn(c => Math.max(0, Math.min(c + (key.rightArrow ? 1 : -1), (screen.matrix?.length ?? 1) - 1))); return; }
    if (screen.kind === 'matrix' && input === 'd') { const diff = screen.menu?.find(item => item.label === '按差异审阅'); if (diff) perform(diff.action); return; }
    if (screen.experimentIds && input === ' ' && filtered[row] && screen.experimentIds.includes(filtered[row].id)) { const id = filtered[row].id; selectExperiments(s => s.includes(id) ? s.filter(v => v !== id) : [...s, id]); return; }
    if (screen.experimentIds && input === 'c') { perform(() => comparison(selectedExperiments)); return; }
    if (key.return && screen.focus === 'rows') { if (screen.kind === 'matrix' && matrix[row]) enterPage(compareTask(screen.matrix!, matrix[row].taskId, matrix[row].grader)); else if (filtered[row]) perform(filtered[row].action, filtered[row].replace); return; }
    const step = key.downArrow ? 1 : key.upArrow ? -1 : key.pageDown ? viewport : key.pageUp ? -viewport : 0;
    if (step) { if (screen.kind === 'pair') setPairScroll(v => { const next = [...v] as [number,number]; next[column] = Math.max(0, Math.min(pairMax.current[column], next[column] + step)); return next; }); else if (screen.focus === 'rows') mutate({ row: Math.max(0, Math.min(row + step, listSize - 1)) }); else mutate({ scroll: Math.max(0, screen.scroll + step) }); }
  }, { isActive: !candidate });
  if (candidate) return <ReviewApp reader={reader} writer={writer} context={context} initialCandidate={candidate} onEval={() => setCandidate(undefined)} onExit={() => setCandidate(undefined)} width={width} height={height} />;
  if (width < 40 || height < 10) return <Text>请扩大终端至 40×10；q 退出（草稿保留）</Text>;
  const hints = prompt ? prompt.multiline?'Ctrl+S 保存 · Enter 换行 · Esc 取消 · PgUp/PgDn 查看输入':'输入内容 · Backspace 删除 · Enter 保存 · Esc 取消 · PgUp/PgDn 查看输入' : searching ? '输入筛选 · Enter 完成 · Esc 返回' : screen.chrome === 'capture' ? screen.kind === 'pair' ? '↑↓ 滚动本栏 · ←/→ 换栏 · : 编辑／审核／发布 · ? 帮助 · Esc 返回' : !screen.rows.length ? '↑↓ 滚动 · ? 帮助 · Esc 返回' : screen.capture ? '↑↓ 选择 · Enter 打开审核 · / 按题名或状态筛选 · ? 帮助 · Esc 返回' : screen.render ? '↑↓ 选择 · Enter 执行 · Tab 阅读全文 · ? 帮助 · Esc 返回' : '↑↓ 选择 · Enter 执行 · / 筛选 · ? 帮助 · Esc 返回' : `↑↓ 浏览 · Enter 打开 · / 搜索 · Tab 切焦点 · : 操作 · ? 帮助 · Esc 返回${screen.experimentIds ? ' · Space 选组 · c 对照' : screen.kind === 'matrix' ? ' · ←/→ 查看组 · d 差异' : screen.kind === 'pair' ? ' · ←/→ 切换组' : ''}`;
  const hintLines = operationHintLines(hints.split(' · '), width, 2);
  const suiteSelected = screen.suite && items(screen.suite.data.tasks).some(task => task.id === filtered[row]?.id);
  const bodySource = suiteSelected ? dashboardPreview : (screen.body ?? '') + (screen.dashboard?.kind === 'experiment' && comparisonReadiness ? '\n\n' + comparisonReadiness : '') + (screen.dashboard && dashboardPreview ? '\n\n' + dashboardPreview : '') + (screen.previews?.[row] ? '\n\n' + screen.previews[row] : '');
  const hasBody = Boolean(screen.render) || bodySource.trim() !== '';
  const listViewport = !hasBody || width >= 100 ? viewport : Math.max(1, Math.min(Math.floor(viewport / 2), screen.chrome === 'capture' ? Math.max(1, filtered.length) : viewport));
  const listColumn = !hasBody || width < 100 ? width : Math.min(screen.listWidth ? 64 : 45, Math.floor(width * (screen.listWidth ?? .36)));
  const bodyWidth = !prompt && width >= 100 && screen.rows.length && hasBody ? Math.max(20, width - listColumn - 3) : width - 2;
  const bodyLines = prompt ? wrapAnsi(`${clean(prompt.label)}\n${clean(prompt.value)}▌`, bodyWidth, { hard: true, wordWrap: false, trim: false }).split('\n') : screen.render ? screen.render(bodyWidth, filtered[row]?.id) : renderMarkdown(bodySource.split('\n'), bodyWidth, true);
  const bodyHeight = !prompt && screen.rows.length && width < 100 && hasBody ? Math.max(1, viewport - listViewport) : viewport;
  const scroll = Math.min(prompt ? prompt.scroll ?? Math.max(0, bodyLines.length - bodyHeight) : screen.scroll, Math.max(0, bodyLines.length - bodyHeight));
  const start = Math.max(0, row - (screen.kind === 'matrix' ? viewport - 2 : listViewport) + 1);
  const visibleRows = filtered.slice(start, start + listViewport);
  let content: React.ReactNode;
  if (!prompt && screen.kind === 'pair' && screen.pair) {
    const pair = screen.pair, sideWidth = width >= 100 ? Math.floor((width - 3) / 2) : width - 2;
    const banner = (pair.banner ? pair.banner(width - 1) : []).slice(0, Math.max(1, viewport - 4)), paneHeight = Math.max(3, viewport - banner.length);
    const side = (index: 0 | 1) => {
      const label = width < 100 && pair.shortLabels ? pair.shortLabels[index] : index ? pair.rightLabel : pair.leftLabel, inner = sideWidth - 1 - (width >= 100 && index ? 1 : 0), wrapped = (index ? pair.rightLines : pair.leftLines)?.(inner);
      const lines = wrapped ?? renderMarkdown((index ? pair.right : pair.left).split('\n'), inner, true);
      const room = paneHeight - 1, maxStart = Math.max(0, lines.length - room), start = Math.min(pairScroll[index], maxStart);
      pairMax.current[index] = maxStart;
      const position = lines.length > room ? ` ↕ ${start + 1}–${Math.min(lines.length, start + room)}/${lines.length}` : '';
      const other = width < 100 && pair.shortLabels ? ` · ${index ? '←' : '→'} 切到「${pair.shortLabels[index ? 0 : 1]}」` : '';
      return <Box flexDirection="column" width={sideWidth} height={paneHeight} key={index} paddingLeft={width >= 100 && index ? 1 : 0}><Text bold color={column === index ? 'cyan' : undefined} wrap="truncate">{index === column ? '› ' : '  '}{clean(label)}{position}{other}</Text>{lines.slice(start, start + room).map((line, i) => <Text key={i} wrap="truncate">{line || ' '}</Text>)}</Box>;
    };
    const divider = <Box flexDirection="column" width={1}>{Array.from({ length: paneHeight }, (_, i) => <Text key={i} dimColor>│</Text>)}</Box>;
    content = <Box flexDirection="column" height={viewport}>{banner.map((line, i) => <Text key={i} wrap="truncate">{line}</Text>)}<Box flexDirection="row" height={paneHeight}>{width >= 100 ? <>{side(0)}{divider}{side(1)}</> : side(column ? 1 : 0)}</Box></Box>;
  } else if (screen.kind === 'matrix' && screen.matrix) {
    const labelWidth = Math.min(46, Math.floor(width * .3)), cellWidth = width >= 160 ? Math.floor((width - labelWidth - 5) / 4) : 20;
    const count = Math.max(1, Math.floor((width - labelWidth) / (cellWidth + 1))); const first = Math.min(column, Math.max(0, screen.matrix.length - count)); const chosen = screen.matrix.slice(first, first + count);
    content = <Box flexDirection="column" height={viewport}><Text bold>{clip('题目 / 评分维度', labelWidth)}│{chosen.map(r => clip(string(object(r.experiment.data.subject).name), cellWidth)).join('│')}</Text>{matrix.slice(start, start + viewport - 2).map((r, i) => <Text key={`${r.taskId}/${r.grader.id}`} color={start + i === row ? 'cyan' : undefined}>{clip((start + i === row ? '› ' : '  ') + r.label, labelWidth)}│{r.values.slice(first, first + count).map(v => clip(v, cellWidth)).join('│')}</Text>)}<Text dimColor>组 {first + 1}–{Math.min(first + count, screen.matrix.length)}/{screen.matrix.length} · 原始判定，无综合排名</Text></Box>;
  } else content = <Box flexDirection={width >= 100 ? 'row' : 'column'} height={viewport}>{!prompt && screen.rows.length > 0 && <Box flexDirection="column" width={listColumn} height={listViewport}>{visibleRows.map((r, i) => <Text key={`${r.id}/${i}`} color={start + i === row && screen.focus === 'rows' ? 'cyan' : undefined} wrap="truncate">{start + i === row ? '› ' : '  '}{screen.experimentIds && screen.experimentIds.includes(r.id) ? selectedExperiments.includes(r.id) ? '☑ ' : '☐ ' : ''}{clean(r.label)}</Text>)}</Box>}{(hasBody || prompt || !screen.rows.length) && <Box flexDirection="column" width={bodyWidth} height={bodyHeight}>{bodyLines.slice(scroll, scroll + bodyHeight).map((line, i) => <Text key={i} wrap="truncate">{line || ' '}</Text>)}</Box>}</Box>;
  return <Box flexDirection="column" width={width} height={height - 1}><Text bold color="cyan" wrap="truncate">有据 Grounds · {clean(screen.title)}</Text>{hintLines.map((line, i) => <Text key={i} color="green">{line}</Text>)}<Text dimColor wrap="truncate">{prompt ? prompt.multiline?'内存编辑（尚未保存）':'正在编辑短字段' : screen.context ?? `${screen.readAt ? '读取于 ' + screen.readAt : '本次会话'} · 焦点 ${screen.focus === 'rows' ? '列表' : '正文'}${screen.experimentIds ? ' · 已选 ' + selectedExperiments.length + ' 组' : ''}`}</Text>{content}<Text color={notice ? 'yellow' : undefined} wrap="truncate">{busy ? captureProgress || '正在读取／保存…' : notice ? clean(notice) : searching ? `筛选：${screen.filter}▌` : screen.filter ? `筛选：${screen.filter}` : (!history.length && screen.chrome !== 'capture' ? `Esc ${backLabel} · q 退出` : 'Ctrl+R 刷新 · q 退出')}</Text></Box>;
}
