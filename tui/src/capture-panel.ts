import type { Data } from './protocol.js';
import { clipCells, limitLines, list, obj, paint, rule, shortId, strings, text, wrapBlock } from './capture-lines.js';
import { clean } from './markdown.js';
import { FIELD_KEYS, FIELD_NAMES, draftStage, fieldTag, knowledgeLabel, explainLimitation, reviewChecklist, type DraftStage, type FieldTag, type Tone } from './capture-text.js';

const tone = (value: Tone, s: string) => value === 'good' ? paint.green(s) : value === 'warn' ? paint.yellow(s) : value === 'bad' ? paint.red.bold(s) : paint.dim(s);
const tag = (t: FieldTag) => tone(t.tone, `[${clean(t.text)}]`);
const KIND_NAMES: Record<string, string> = { question: '用户消息', answer: '模型回答', query: '查询', tool: '工具输出', clue: '系统线索', model_proposal: '拆题建议', cli_start: '' };

export interface DraftView { draft: Data; qa: Data; provenance: Data; verified: string[]; materials: Data[]; missing: string[] }
export const viewOf = (value: Data): DraftView => ({ draft: obj(value.draft), qa: obj(value.qa), provenance: obj(value.provenance), verified: strings(value.verified_fields), materials: list(value.materials), missing: strings(value.missing) });

export const draftTitle = (view: DraftView): string => text(view.qa.name).trim() || clipCells(text(view.qa.question), 28) || shortId(text(view.draft.id));
export const stageOf = (view: DraftView): DraftStage => draftStage(view.draft, view.qa, true, view.materials);

/** Counts like "用户消息 2 · 查询 3 · 模型回答 2" from the evidence index. */
export function evidenceDigest(materials: Data[]): string {
  const counts = new Map<string, number>();
  for (const kind of materials.flatMap(m => list(m.evidence)).map(e => text(e.kind))) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].filter(([k]) => KIND_NAMES[k] !== '').map(([k, n]) => `${KIND_NAMES[k] ?? k} ${n}`).join(' · ') || '无现场记录';
}

/** Banner above both panes: where this draft stands, and what to do next.
 * On a narrow terminal it shrinks to the essentials; the how-to stays in the right pane. */
export function renderBanner(view: DraftView, width: number): string[] {
  const stage = stageOf(view), compact = width < 90;
  const filled = FIELD_KEYS.filter(k => Array.isArray(view.qa[k]) ? strings(view.qa[k]).length > 0 : text(view.qa[k]).trim() !== ''), confirmed = filled.filter(k => view.verified.includes(k)).length;
  const state = compact ? `审核：${stage.label}` : `审核状态：${stage.label}${stage.tone === 'muted' ? '' : ` · 已人工确认 ${confirmed}/${filled.length} 个已填字段`}`;
  return [
    ...wrapBlock(state, width).map(l => tone(stage.tone, l)),
    ...wrapBlock(`下一步：${compact ? stage.nextShort : stage.next}`, width, '', '       ').map(l => paint.bold(l)),
  ];
}

function field(view: DraftView, key: string, width: number, heading = FIELD_NAMES[key]!): string[] {
  const value = view.qa[key], marker = tag(fieldTag(key, view.qa, view.provenance, view.verified));
  const body = Array.isArray(value)
    ? strings(value).flatMap((item, i) => wrapBlock(item, width, `  ${i + 1}. `, '     '))
    : text(value).trim() ? wrapBlock(text(value), width, '  ') : [];
  return [`${paint.bold(heading)} ${marker}`, ...(body.length ? body : [paint.dim('  （空）')])];
}

/** Right pane: the proposed QA, split by who may see each part. */
export function renderQAPane(view: DraftView, width: number): string[] {
  const { draft, qa } = view, review = obj(draft.review), stage = stageOf(view), lines: string[] = [];
  const checks = reviewChecklist(review, qa), editable = draft.state === 'active';
  lines.push(`${paint.bold('题名')} ${tag(fieldTag('name', qa, view.provenance, view.verified))}`, ...wrapBlock(text(qa.name) || '（空）', width, '  '));
  if (editable && !['ignored', 'not_applicable'].includes(text(review.status))) {
    lines.push('', rule(width, stage.remaining ? `发布前检查 · 还差 ${stage.remaining} 项` : '发布前检查 · 已齐'));
    let first = true;
    for (const item of checks) {
      const wrapped = wrapBlock(item.label, width - 4);
      lines.push(`${item.done ? paint.green('[✓]') : paint.red('[ ]')} ${wrapped[0]}`, ...wrapped.slice(1).map(l => '    ' + l));
      if (!item.done && first) { first = false; lines.push(...wrapBlock(`→ ${item.how}`, width - 4).map(l => '    ' + paint.yellow(l))); }
    }
  }
  lines.push('', rule(width, '一、被测者能看到（公开）'), ...field(view, 'question', width), ...field(view, 'instructions', width));
  lines.push('', rule(width, '二、只有评分时可见（私有，被测者看不到）'), ...field(view, 'rubric', width), ...field(view, 'reference_answer', width), ...field(view, 'required_points', width), ...field(view, 'forbidden_claims', width), ...field(view, 'references', width));
  const authority = text(review.authority).trim(), conditions = obj(review.answer_conditions);
  lines.push('', rule(width, '三、依据、来源与限制'));
  lines.push(`${paint.bold('权威依据')} ${authority ? paint.green('[已填写]') : paint.red.bold('[待补]')}`, ...(authority ? wrapBlock(authority, width, '  ') : [paint.dim('  （用户的纠正只算线索，需要有可核对的权威来源）')]));
  lines.push(`${paint.bold('知识类型')}  ${knowledgeLabel(review.knowledge)}${review.knowledge === 'unknown' ? paint.yellow('（需要判定：稳定知识，还是随时间变化的历史状态）') : ''}`);
  if (review.knowledge === 'historical') lines.push(...wrapBlock(`历史作答条件：${text(conditions.locator) || '未填'}｜${text(conditions.instructions) || '未填'}`, width, '  '));
  for (const material of view.materials) {
    const project = obj(material.project);
    if (project.id) lines.push(...wrapBlock(`来源：项目 ${text(project.id)} · 采集 ${date(project.first_captured_at)} · 自动材料 ${date(project.expires_at)} 到期（人工填写的字段不会随之删除）`, width, '', '  '));
  }
  const limits = [...new Set(view.materials.flatMap(m => strings(m.limitations)))].map(explainLimitation);
  if (limits.length) { lines.push(paint.bold('系统标出的限制')); for (const item of limits) lines.push(...wrapBlock(item.text, width, '  • ', '    ')); }
  lines.push('', paint.dim('哈希、定位符、字节数、限制代码等技术信息：按 : 选「技术细节」查看。'));
  return lines;
}

function date(value: unknown): string {
  const ms = Date.parse(text(value));
  if (!Number.isFinite(ms)) return text(value) || '未记录';
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Everything a list row needs, built from one `draft show` payload. */
export interface DraftSummary { id: string; title: string; question: string; badge: string; status: string; next: string; digest: string; tone: Tone }
export function summarize(view: DraftView): DraftSummary {
  const stage = stageOf(view);
  return { id: text(view.draft.id), title: draftTitle(view), question: text(view.qa.question), badge: stage.badge, status: stage.label, next: stage.next, digest: evidenceDigest(view.materials), tone: stage.tone };
}
/** Fallback when the detail could not be read: the list row must still tell drafts apart. */
export function fallbackSummary(row: Data): DraftSummary {
  const stage = draftStage(row);
  return { id: text(row.id), title: `未读取题名 · ${shortId(text(row.id))}`, question: '', badge: stage.badge, status: stage.label, next: '打开后会再次读取详情。', digest: '', tone: stage.tone };
}
/** Rows must differ even if two drafts share a title. */
export function rowLabels(rows: DraftSummary[]): string[] {
  const seen = new Map<string, number>(); for (const r of rows) seen.set(r.title, (seen.get(r.title) ?? 0) + 1);
  return rows.map(r => `[${r.badge}] ${r.title}${(seen.get(r.title) ?? 0) > 1 ? ` #${r.id.slice(-4)}` : ''}`);
}
export function renderListPreview(rows: DraftSummary[], id: string | undefined, width: number): string[] {
  const lines: string[] = [];
  const pending = rows.filter(r => r.tone === 'warn').length;
  lines.push(...wrapBlock(`共 ${rows.length} 份草稿${pending ? `，${pending} 份还需要你处理` : ''}`, width).map(l => paint.dim(l)), '');
  const row = rows.find(r => r.id === id);
  if (!row) return [...lines, paint.dim('按 ↑↓ 选择一份草稿；按 Enter 打开，左边看现场、右边看模型提出的题。')];
  lines.push(...wrapBlock(row.title, width).map(l => paint.bold.cyan(l)), '');
  lines.push(...wrapBlock(`状态：${row.status}`, width, '', '      ').map(l => tone(row.tone, l)));
  lines.push(...wrapBlock(`下一步：${row.next}`, width, '', '       '));
  lines.push(...limitLines(wrapBlock(`题面：${row.question || '（未读取）'}`, width, '', '      '), 5, hidden => `      … 还有 ${hidden} 行，打开后查看全文`));
  if (row.digest) lines.push(...wrapBlock(`现场：${row.digest}`, width, '', '      '));
  lines.push('', ...wrapBlock('Enter 打开审核 · / 按题名或状态筛选。未审材料只保存在本机；查看与保存编辑不会永久保留全部证据。', width).map(l => paint.dim(l)));
  return lines;
}

/** Plain-language view of `draft preview`, with the exact JSON kept below for anyone who wants it. */
export function renderPublishPreview(preview: Data, width: number): string[] {
  const qa = obj(preview.qa), review = obj(preview.review), target = obj(preview.target), suite = obj(preview.suite), template = obj(preview.template);
  const pub = obj(preview.public_input), member = obj(target.member), lines: string[] = [];
  const name = (record: Data, fallback: string) => text(obj(record.data).name) || fallback;
  lines.push(...wrapBlock('发布预览：现在还没有写入任何东西。只有选「确认按此预览发布」才会一次性写入下面这些内容。', width).map(l => paint.bold(l)));
  const placement = `题集「${name(suite, text(suite.id))}」v${text(suite.version)}：${member.mode === 'add' ? '新增一个成员' : `更新成员 ${text(member.id)}`}`;
  const steps = preview.conflict
    ? ['沿用上次已经创建的固定来源包、QA 题目和评分实例，不会重复创建', placement]
    : [`固定来源包：保存 ${list(obj(preview.source_package).evidence).length} 条现场证据`, `QA 题目「${text(qa.name)}」`, `评分实例：基于模板「${name(template, text(template.id))}」v${text(template.version)}`, placement];
  lines.push(...wrapBlock(`账本 ${text(preview.database_id)}`, width), '', rule(width, preview.conflict ? '冲突恢复：只重新放置题集成员' : '确认后会依次创建'));
  steps.forEach((step, i) => lines.push(...wrapBlock(step, width, `${i + 1}. `, '   ')));
  lines.push('', rule(width, '被测者会看到（公开输入）'), ...wrapBlock(`题目：${text(pub.question)}`, width, '', '  '), ...wrapBlock(`作答条件：${text(pub.instructions)}`, width, '', '  '));
  lines.push('', rule(width, '只有评分时可见（私有，被测者看不到）'), ...wrapBlock(`评分标准：${text(qa.rubric) || '（空）'}`, width, '', '  '));
  if (text(qa.reference_answer)) lines.push(...wrapBlock(`参考答案：${text(qa.reference_answer)}`, width, '', '  '));
  for (const [key, label] of [['required_points', '必答要点'], ['forbidden_claims', '错误说法'], ['references', '私有依据']] as const) if (strings(qa[key]).length) lines.push(...strings(qa[key]).flatMap((item, i) => wrapBlock(item, width, i === 0 ? `${label}：` : '  ', '  ')));
  lines.push('', rule(width, '审核依据'), ...wrapBlock(`权威依据：${text(review.authority) || '（空）'}`, width, '', '  '), `知识类型：${knowledgeLabel(review.knowledge)}`);
  const limits = strings(preview.limitations).map(explainLimitation);
  if (limits.length) { lines.push('', rule(width, '系统标出的限制')); for (const item of limits) lines.push(...wrapBlock(item.text, width, '• ', '  ')); }
  lines.push('', rule(width, '技术细节：完整预览 JSON'), ...wrapBlock(JSON.stringify(preview, null, 2), width));
  return lines;
}

/** Hashes, locators, sizes and raw codes: everything that is kept out of the main views. */
export function renderTechnical(view: DraftView, width: number): string[] {
  const { draft } = view, lines: string[] = [paint.bold('技术细节（仅供排查，审核不需要）'), ''];
  lines.push(...wrapBlock(`草稿 ${text(draft.id)} · 版本 ${text(draft.version)} · 题目身份 ${text(draft.identity)}`, width));
  for (const reason of view.missing) lines.push(...wrapBlock(`自动材料读取失败或已到期：${reason}`, width, '', '  '));
  for (const material of view.materials) {
    const project = obj(material.project);
    lines.push('', rule(width, `来源 ${shortId(text(material.identity).replace(/^graphkb:/, ''))}`));
    lines.push(...wrapBlock(`身份 ${text(material.identity)} · 修订 ${text(material.revision)}`, width), ...wrapBlock(`项目 ${text(project.id)} · 首次采集 ${text(project.first_captured_at)} · 到期 ${text(project.expires_at)}`, width));
    lines.push(...wrapBlock(`原始完整度：${JSON.stringify(material.completeness)}`, width));
    for (const raw of strings(material.limitations)) lines.push(...wrapBlock(`限制：${raw}`, width, '', '  '));
    for (const e of list(material.evidence)) lines.push(...wrapBlock(`证据 ${text(e.kind)} · ${text(e.locator)} · ${text(e.digest)} · ${text(e.size)} bytes`, width, '', '  '));
  }
  return lines;
}
