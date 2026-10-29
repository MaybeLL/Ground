import stringWidth from 'string-width';
import type { Data } from './protocol.js';
import { clipCells, limitLines, list, obj, paint, rule, text, wrapBlock } from './capture-lines.js';
import { clean } from './markdown.js';
import { clueReasonLabel, clueStateLabel, completenessSummary } from './capture-text.js';

/** One captured piece of evidence, as listed by `draft show` (no body). */
export interface EvidenceRef { id: string; kind: string; name: string; digest: string; size: number }
export type Loaded = { state: 'ok'; text: string; truncated?: boolean } | { state: 'error'; message: string };
export type Role = 'user' | 'model' | 'query' | 'tool' | 'proposal' | 'note' | 'other';
export interface Entry {
  key: string; kind: string; role: Role; heading: string; ms?: number; failed: boolean;
  state: 'loading' | 'error' | 'ok'; paragraphs: string[];
}

const QUERY_KINDS: Record<string, string> = { nodes: '节点（nodes）', facts: '事实（facts）' };
const MESSAGE_LINES = 24;
const parse = (value: string): Data | undefined => { try { const v = JSON.parse(value); return v && typeof v === 'object' && !Array.isArray(v) ? v as Data : undefined; } catch { return undefined; } };
const time = (v: unknown): number | undefined => { const n = typeof v === 'number' ? v : Date.parse(text(v)); return Number.isFinite(n) ? n : undefined; };

function messageText(message: Data): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  const output = Array.isArray(message.output) ? message.output : content;
  return list(output).map(part => text(part.text)).filter(Boolean).join('\n');
}

function toolParagraphs(message: Data): { paragraphs: string[]; failed: boolean } {
  const parts = list(message.output).map(p => text(p.text)).filter(Boolean);
  for (const part of [...parts].reverse()) {
    const inner = parse(part);
    if (inner && ('output' in inner || 'exit_code' in inner)) {
      const exit = Number(inner.exit_code ?? 0), body = text(inner.output).trim();
      return { paragraphs: [`退出码 ${exit}${exit === 0 ? '（正常）' : '（失败）'}`, ...(body ? [body] : [])], failed: exit !== 0 };
    }
  }
  return { paragraphs: [messageText(message).trim() || '（没有文字输出）'], failed: false };
}

function queryFromArgs(args: unknown): { keyword?: string; kind?: string } {
  const argv = Array.isArray(args) ? args.map(text) : [];
  if (argv[0] !== 'search') return {};
  const kindAt = argv.indexOf('--kind');
  return { keyword: argv[1], kind: kindAt >= 0 ? argv[kindAt + 1] : undefined };
}

function queryEntry(key: string, call: Data, start: Data | undefined, clue: Data | undefined): Entry {
  const http = list(call.http_observations), first = http[0] ?? {}, body = obj(first.body), out = obj(call.actual_output);
  const fromArgs = queryFromArgs(obj(start?.observation).args ?? start?.args);
  const keyword = text(body.query) || fromArgs.keyword || '', kind = text(body.kind) || fromArgs.kind || '';
  const exit = Number(call.exit_code ?? 0), statuses = http.map(h => Number(h.status ?? 200));
  const errorText = [obj(first.response).error, out.error, call.error].map(v => typeof v === 'string' ? v : v ? JSON.stringify(v) : '').find(Boolean) ?? '';
  const failed = exit !== 0 || (call.status !== undefined && call.status !== 'completed') || statuses.some(s => s >= 400) || errorText !== '';
  const ms = Number(first.elapsed_ms ?? (Number(call.ended_at) - Number(call.started_at)));
  const paragraphs = [`类型 ${QUERY_KINDS[kind] ?? (kind || '未记录')} · 关键词「${keyword || '未记录'}」`];
  if (failed) {
    paragraphs.push(`退出码 ${exit}${statuses.some(s => s >= 400) ? ` · HTTP ${statuses.find(s => s >= 400)}` : ''}`);
    paragraphs.push(errorText || (http.length === 0 ? '没有发出网络请求，也没有返回结果（详见后面的工具输出）。' : '没有返回结果。'));
  } else {
    const items = list(out.items), more = out.has_more === true;
    paragraphs.push(`返回 ${items.length} 条${more ? '（还有更多没取回）' : ''}${items.length ? '：' : ''}`);
    for (const item of items.slice(0, 3)) paragraphs.push(`  · ${text(item.name)}${item.summary ? ` — ${text(item.summary)}` : ''}`);
    if (items.length > 3) paragraphs.push(`  … 另有 ${items.length - 3} 条`);
    if (out.graph_revision) paragraphs.push(`知识库版本 ${text(out.graph_revision)}`);
  }
  if (clue) paragraphs.push(`系统线索：${clueReasonLabel(clue.reason)} · ${clueStateLabel(clue.state)}`);
  return { key, kind: 'query', role: 'query', failed, state: 'ok', ms: time(call.started_at ?? obj(start?.observation).started_at), paragraphs, heading: `${failed ? '✗ 查询失败' : '✓ 查询成功'}${Number.isFinite(ms) && !failed ? ` · ${ms}ms` : ''}` };
}

function proposalEntry(key: string, value: Data): Entry {
  const span = text(value.question_span), proposed = text(value.model_question_proposal);
  const paragraphs = [`模型从对话里拆出的题目片段：${span || '未记录'}`];
  if (proposed && proposed !== span) paragraphs.push(`模型改写为：${proposed}`);
  if (value.observation === 'model_extraction_unverified') paragraphs.push('这是模型提取的结果，还没有人核实。');
  return { key, kind: 'model_proposal', role: 'proposal', heading: '模型拆题建议', failed: false, state: 'ok', paragraphs };
}

/** Turn evidence bodies into readable entries in time order. Unknown shapes
 * degrade to a clipped raw text entry instead of being hidden. */
export function buildTimeline(refs: EvidenceRef[], loaded: (ref: EvidenceRef) => Loaded | undefined): Entry[] {
  const parsed = refs.map(ref => { const state = loaded(ref); return { ref, state, data: state?.state === 'ok' ? parse(state.text) : undefined }; });
  // Records only merge when they carry a real call id; blank ids never match each other.
  const callOf = (d: Data | undefined): string => text(d?.call_id ?? obj(d?.observation).call_id);
  const byCall = (kind: string) => new Map(parsed.filter(r => r.ref.kind === kind && r.data && callOf(r.data)).map(r => [callOf(r.data), r.data!]));
  const queries = byCall('query'), starts = byCall('cli_start'), clues = byCall('clue');
  const entries: Entry[] = [];
  for (const { ref, state, data } of parsed) {
    const key = `${ref.id}`;
    if (!state) { entries.push({ key, kind: ref.kind, role: 'other', heading: `记录（${ref.kind}）`, failed: false, state: 'loading', paragraphs: ['正在读取…'] }); continue; }
    if (state.state === 'error') { entries.push({ key, kind: ref.kind, role: 'other', heading: `记录（${ref.kind}）`, failed: true, state: 'error', paragraphs: [`读取失败：${state.message}。按 Ctrl+R 重试。`] }); continue; }
    const raw = (): Entry => ({ key, kind: ref.kind, role: 'other', heading: `记录（${ref.kind}）`, failed: false, state: 'ok', paragraphs: [clipCells(state.text, 600), ...(state.truncated ? ['（内容很长，这里只读取了开头；按 : 选「原始记录」看全文）'] : [])] });
    if (!data) { entries.push(raw()); continue; }
    const call = callOf(data);
    if (ref.kind === 'query') { entries.push(queryEntry(key, data, call ? starts.get(call) : undefined, call ? clues.get(call) : undefined)); continue; }
    if (ref.kind === 'cli_start') {
      if (call && queries.has(call)) continue;
      const observation = obj(data.observation), args = queryFromArgs(observation.args);
      entries.push({ key, kind: ref.kind, role: 'query', heading: '查询已发起，没有记录到结果', failed: true, state: 'ok', ms: time(observation.started_at), paragraphs: [`关键词「${args.keyword ?? '未记录'}」 · 类型 ${QUERY_KINDS[args.kind ?? ''] ?? (args.kind || '未记录')}`] });
      continue;
    }
    if (ref.kind === 'clue') {
      if (call && queries.has(call)) continue;
      entries.push({ key, kind: ref.kind, role: 'note', heading: '系统线索', failed: false, state: 'ok', paragraphs: [`${clueReasonLabel(data.reason)} · ${clueStateLabel(data.state)}`] });
      continue;
    }
    if (ref.kind === 'model_proposal') { entries.push(proposalEntry(key, data)); continue; }
    const message = obj(obj(data.observation).message ?? data.message);
    if (Object.keys(message).length) {
      const when = time(obj(data.observation).native_time ?? data.native_time), role = text(message.role);
      if (role === 'tool' || ref.kind === 'tool') {
        const result = toolParagraphs(message);
        entries.push({ key, kind: ref.kind, role: 'tool', heading: result.failed ? '✗ 工具输出（失败）' : '工具输出', failed: result.failed, state: 'ok', ms: when, paragraphs: result.paragraphs });
      } else if (role === 'assistant' || ref.kind === 'answer') {
        entries.push({ key, kind: ref.kind, role: 'model', heading: message.phase === undefined || message.phase === 'final_answer' ? '模型回答' : '模型（过程说明）', failed: false, state: 'ok', ms: when, paragraphs: [messageText(message).trim() || '（没有文字）'] });
      } else if (role === 'user' || ref.kind === 'question') {
        entries.push({ key, kind: ref.kind, role: 'user', heading: '用户提问', failed: false, state: 'ok', ms: when, paragraphs: [messageText(message).trim() || '（没有文字）'] });
      } else entries.push({ key, kind: ref.kind, role: 'other', heading: `${role || '消息'}（${ref.kind}）`, failed: false, state: 'ok', ms: when, paragraphs: [messageText(message).trim() || clipCells(state.text, 600)] });
      continue;
    }
    entries.push(raw());
  }
  // Order by the time stored inside each record; untimed rows follow their
  // predecessor and model proposals (no real time) close the list.
  let last = Number.NEGATIVE_INFINITY;
  const keyed = entries.map((entry, index) => {
    if (entry.role === 'proposal') return { entry, index, at: Number.POSITIVE_INFINITY };
    if (entry.ms !== undefined) last = entry.ms;
    return { entry, index, at: last };
  });
  const ordered = keyed.sort((a, b) => a.at - b.at || a.index - b.index).map(k => k.entry);
  // Only the first user message is the question; later ones are follow-ups or corrections.
  return ordered.map((entry, index) => entry.role === 'user' && ordered.findIndex(e => e.role === 'user') !== index ? { ...entry, heading: '用户追问／纠正' } : entry);
}

const ROLE_STYLE: Record<Role, (s: string) => string> = { user: s => paint.cyan.bold(s), model: s => paint.green.bold(s), query: s => paint.blue.bold(s), tool: s => paint.magenta.bold(s), proposal: s => paint.yellow.bold(s), note: s => paint.dim.bold(s), other: s => paint.dim.bold(s) };
const pad2 = (n: number) => String(n).padStart(2, '0');
export function clock(ms: number, utc: boolean, withDate: boolean): string {
  const d = new Date(ms), p = utc ? { M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() } : { M: d.getMonth() + 1, D: d.getDate(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  return `${withDate ? `${pad2(p.M)}-${pad2(p.D)} ` : ''}${pad2(p.h)}:${pad2(p.m)}:${pad2(p.s)}`;
}
const dayOf = (ms: number, utc: boolean) => { const d = new Date(ms); return utc ? `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

export interface TimelineOptions { width: number; utc?: boolean }
export function renderTimeline(entries: Entry[], options: TimelineOptions): string[] {
  const { width, utc = false } = options, days = new Set(entries.flatMap(e => e.ms === undefined ? [] : [dayOf(e.ms, utc)]));
  const lines: string[] = [];
  entries.forEach((entry, index) => {
    const label = `[${index + 1}] ${clean(entry.heading)}`, when = entry.ms === undefined ? '' : clock(entry.ms, utc, days.size > 1);
    const styled = entry.failed ? paint.red.bold(label) : ROLE_STYLE[entry.role](label);
    const gap = width - stringWidth(label) - stringWidth(when);
    lines.push(when ? gap >= 2 ? `${styled}${' '.repeat(gap)}${paint.dim(when)}` : `${styled}  ${paint.dim(when)}` : styled);
    const bar = entry.failed ? paint.red('│ ') : paint.dim('│ ');
    const tint = (line: string) => entry.failed ? paint.red(line) : entry.state === 'loading' ? paint.dim(line) : line;
    const body = entry.paragraphs.flatMap(p => wrapBlock(p, width - 2));
    for (const line of limitLines(body, MESSAGE_LINES, hidden => `… 还有 ${hidden} 行没显示；按 : 选「原始记录」看全文`)) lines.push(bar + tint(line));
    lines.push('');
  });
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Left pane: how complete the recording is, then the readable timeline. */
export function renderEvidencePane(input: { entries: Entry[]; materials: Data[]; width: number; utc?: boolean; missing?: string[]; omitted?: number }): string[] {
  const { entries, materials, width, utc = false, missing = [], omitted = 0 } = input, lines: string[] = [];
  const expected = entries.length;
  const counts = (role: Role) => entries.filter(e => e.role === role).length, failed = entries.filter(e => e.role === 'query' && e.failed && e.state === 'ok').length;
  const pending = entries.filter(e => e.state === 'loading').length, broken = entries.filter(e => e.state === 'error').length;
  const day = entries.find(e => e.ms !== undefined)?.ms;
  const summary = [`共 ${expected} 条`, counts('user') ? `用户 ${counts('user')}` : '', counts('model') ? `模型 ${counts('model')}` : '', counts('query') ? `查询 ${counts('query')}` : '', counts('tool') ? `工具输出 ${counts('tool')}` : '', counts('proposal') ? `拆题建议 ${counts('proposal')}` : ''].filter(Boolean).join(' · ');
  lines.push(...wrapBlock(`${day === undefined ? '' : dayOf(day, utc) + ' · '}${summary}`, width));
  if (failed) lines.push(paint.red.bold(`✗ 其中 ${failed} 处失败，已用红色标出`));
  if (pending) lines.push(paint.dim(`正在读取现场记录… 已完成 ${expected - pending}/${expected}`));
  if (broken) lines.push(paint.red(`${broken} 条读取失败，按 Ctrl+R 重试`));
  if (omitted) lines.push(...wrapBlock(`另有 ${omitted} 条记录没有预读；按 : 选「原始记录」逐条查看`, width, '！ ', '  ').map(l => paint.yellow(l)));
  if (missing.length) lines.push(...wrapBlock(`有 ${missing.length} 份自动材料已到期或读取失败，这里只显示还能读到的部分；原因见 : 菜单「技术细节」`, width, '！ ', '  ').map(l => paint.yellow(l)));
  materials.forEach((material, index) => {
    const { segments, concerns } = completenessSummary(material.completeness);
    if (!segments.length) return;
    const prefix = materials.length > 1 ? `来源 ${index + 1} 完整度：` : '记录完整度：';
    lines.push('');
    lines.push(...wrapBlock(prefix + segments.map(s => `${s.name}${s.ok ? '✓' : '！'}${s.label}`).join(' · '), width, '', '  '));
    for (const concern of concerns) lines.push(...wrapBlock(concern, width, paint.yellow('！ '), '  '));
  });
  lines.push('', rule(width), '');
  lines.push(...(entries.length ? renderTimeline(entries, { width, utc }) : [paint.dim('没有可读取的现场记录；自动材料可能已到期。可在 : 菜单读取已明确保存的长期来源包。')]));
  return lines;
}
