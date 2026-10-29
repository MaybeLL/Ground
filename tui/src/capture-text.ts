import type { Data } from './protocol.js';
import { obj, strings, text } from './capture-lines.js';
import { clean } from './markdown.js';

/** Plain-language names for the codes the capture pipeline stores.
 * Unknown codes fall back to the raw value so nothing is silently hidden. */
const COMPLETENESS_NAMES: Record<string, string> = { question: '问题', query: '查询', answer: '回答', feedback: '用户反馈', attachments: '附件', subtasks: '子任务' };
const COMPLETENESS_STATES: Record<string, { label: string; ok: boolean }> = {
  complete: { label: '完整', ok: true }, not_applicable: { label: '不适用', ok: true },
  partial: { label: '部分缺失', ok: false }, missing: { label: '没有记录', ok: false },
  unknown: { label: '未知', ok: false }, not_fully_observed: { label: '未完整观察', ok: false },
};
const COMPLETENESS_CONCERNS: Record<string, string> = {
  attachments: '无法确认题目是否依赖附件；如果题面需要附件，要先整理成可公开的材料。',
  feedback: '没有记录到用户对回答的后续反馈。',
};
const LIMITATIONS: Record<string, string> = {
  model_extraction_unverified: '题面、答案和评分条件是模型从对话里提取的，还没有人核实过。',
  private_scoring_requires_human_review: '私有评分内容（评分标准、参考答案、要点）必须由人审核后才能用于评测。',
  hidden_reasoning_excluded: '不包含模型的隐藏推理，只依据看得见的对话和查询记录。',
  historical_state_requires_reproducible_public_conditions: '答案取决于当时的知识库状态。必须给被测者一个公开、固定、可重现的查询条件，否则这道题无法公平作答。',
};
const CLUE_REASONS: Record<string, string> = { query_failed: '查询失败' };
const CLUE_STATES: Record<string, string> = { pending_analysis: '待提取', expired: '已到期', ignored: '已忽略' };
const REVIEW_STATUS: Record<string, string> = { pending: '待审核', reviewed: '已人工核实', ignored: '已忽略', not_applicable: '不适用' };
const KNOWLEDGE: Record<string, string> = { unknown: '未判定', stable: '稳定知识', historical: '历史状态' };
const PUBLICATION: Record<string, string> = { not_started: '尚未发布', published: '已发布', partial: '发布未完成', pending: '发布等待回执', conflict: '发布冲突', cancelled: '发布已取消' };
const code = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const mapped = (table: Record<string, string>, value: unknown): string => table[text(value)] ?? clean(text(value));

export const reviewStatusLabel = (v: unknown) => mapped(REVIEW_STATUS, v);
export const knowledgeLabel = (v: unknown) => mapped(KNOWLEDGE, v);
export const publicationLabel = (v: unknown) => mapped(PUBLICATION, v);
export const clueReasonLabel = (v: unknown) => mapped(CLUE_REASONS, v);
export const clueStateLabel = (v: unknown) => mapped(CLUE_STATES, v);

export interface CompletenessSegment { key: string; name: string; label: string; ok: boolean }
export function completenessSummary(value: unknown): { segments: CompletenessSegment[]; concerns: string[] } {
  const segments = Object.entries(obj(value)).map(([key, raw]) => {
    const state = COMPLETENESS_STATES[text(raw)];
    return { key, name: COMPLETENESS_NAMES[key] ?? key, label: state?.label ?? text(raw), ok: state?.ok ?? false };
  });
  return { segments, concerns: segments.filter(s => !s.ok).map(s => `${s.name}：${s.label}。${COMPLETENESS_CONCERNS[s.key] ?? '现场记录在这一方面不完整。'}`) };
}

export function explainLimitation(raw: string): { text: string; code?: string; known: boolean } {
  const value = raw.trim();
  if (LIMITATIONS[value]) return { text: LIMITATIONS[value]!, code: value, known: true };
  if (code.test(value)) return { text: `未识别的系统标记（暂无中文说明，详见技术细节）：${value}`, code: value, known: false };
  return { text: value, known: true };
}

/** A bare "to be filled in" marker. The preview applies the full rule set; this only mirrors the obvious case. */
const placeholder = (value: string) => /^[\s>*_`-]*(?:TODO|TBD|FIXME|pending|待补(?:充)?|待定|待确认|未填写)[\s:：。.!！*_`-]*$/iu.test(value.normalize('NFKC'));
/** Whether the recording itself can support publication: each core kind needs a body and usable coverage. */
const evidenceCovered = (materials: Data[]): boolean => ['question', 'query', 'answer'].every(kind => materials.some(m => Array.isArray(m.evidence) && (m.evidence as Data[]).some(e => text(e.kind) === kind && Number(e.size) > 0) && ['complete', 'partial'].includes(text(obj(m.completeness)[kind]))));

/** The checks the publication preview applies, shown up front as a checklist.
 * The preview stays the authority: it also re-checks evidence and leftover placeholder text. */
export interface CheckItem { key: string; label: string; done: boolean; how: string }
export function reviewChecklist(review: Data, qa: Data, materials?: Data[]): CheckItem[] {
  const conditions = obj(review.answer_conditions);
  const filled = ['question', 'instructions', 'rubric'].every(k => text(qa[k]).trim() && !placeholder(text(qa[k])));
  const items: CheckItem[] = [
    { key: 'content', label: '公开题目、公开作答条件和评分标准都已填写（不是「待补」占位）', done: filled, how: '按 : 选「编辑」补全空着或写着「待补」的字段' },
    { key: 'independent_text', label: '题面脱离原对话也能独立看懂', done: review.independent_text === true, how: '按 : →「审核条件与权威依据」→「独立文本题面」，对照左侧现场确认' },
    { key: 'attachments', label: '题目需要的附件已整理好', done: review.attachments_resolved === true, how: '按 : →「审核条件与权威依据」→「必要附件已整理」' },
    { key: 'authority', label: '已写明权威依据（用户的纠正只算线索）', done: text(review.authority).trim() !== '' && !placeholder(text(review.authority)), how: '按 : →「审核条件与权威依据」→「填写权威依据」' },
    { key: 'knowledge', label: `已判定知识类型（${knowledgeLabel(review.knowledge)}）`, done: review.knowledge === 'stable' || review.knowledge === 'historical', how: '按 : →「审核条件与权威依据」→ 标为稳定知识或历史状态' },
  ];
  if (review.knowledge === 'historical') items.push({ key: 'conditions', label: '历史状态的可重现作答条件已补齐，并写进公开作答条件', done: conditions.accessible === true && conditions.preserves_question === true && text(conditions.locator).trim() !== '' && text(conditions.instructions).trim() !== '' && text(qa.instructions).includes(text(conditions.instructions)), how: '按 : →「审核条件与权威依据」→「标为历史状态，补可重现条件」' });
  if (materials) items.push({ key: 'evidence', label: '现场记录里有用户问题、查询和回答，且完整度不是「没有记录／未知」', done: evidenceCovered(materials), how: '这一项取决于采集结果，界面里不能改；缺失时请重新采集后再交接' });
  items.push({ key: 'reviewed', label: '已确认核实题面与评分依据', done: review.status === 'reviewed', how: '最后一步：按 : →「审核条件与权威依据」→「确认已核实题面与评分依据」' });
  return items;
}

export type Tone = 'good' | 'warn' | 'bad' | 'muted';
export interface DraftStage { badge: string; label: string; tone: Tone; next: string; nextShort: string; remaining: number }
/** One state summary for list rows and the review banner. */
export function draftStage(draft: Data, qa: Data = {}, hasQA = false, materials?: Data[]): DraftStage {
  const stage = stageDetail(draft, qa, hasQA, materials);
  return { ...stage, nextShort: stage.remaining > 0 ? stage.next.split('。')[0]! : stage.next };
}
function stageDetail(draft: Data, qa: Data, hasQA: boolean, materials?: Data[]): Omit<DraftStage, 'nextShort'> {
  const review = obj(draft.review), journal = obj(draft.journal);
  const publication = text(journal.state || draft.publication_state || 'not_started');
  if (draft.state === 'replaced') return { badge: '已被替代', label: '已被替代（仅供追溯）', tone: 'muted', next: '这份草稿已被拆分或合并后的新草稿取代，只能查看来源，不能发布；请打开新草稿继续。', remaining: 0 };
  if (draft.state === 'boundary_pending') return { badge: '边界待确认', label: '题目边界待确认', tone: 'warn', next: '同一条原始消息已有题目。按 : 先选「关联已有题目」或「确认这是独立新题」，确认前不能编辑或发布。', remaining: 0 };
  if (publication === 'published') return { badge: '已发布', label: '已发布', tone: 'good', next: '已经发布。按 : 可查看发布记录；不需要再审核。', remaining: 0 };
  if (['partial', 'pending', 'conflict'].includes(publication)) return { badge: publicationLabel(publication), label: publicationLabel(publication), tone: 'bad', next: `发布${publication === 'conflict' ? '遇到冲突' : '没有完成'}。按 : 选「${publication === 'conflict' ? '重新选择题集成员并预览冲突恢复' : '核查并恢复原发布'}」，不会重复创建。`, remaining: 0 };
  const status = text(review.status);
  if (status === 'ignored' || status === 'not_applicable') return { badge: reviewStatusLabel(status), label: `${reviewStatusLabel(status)}（不会发布）`, tone: 'muted', next: '已标为不发布。想恢复的话按 : →「审核条件与权威依据」→「标为待补」。', remaining: 0 };
  if (!hasQA) return { badge: reviewStatusLabel(status), label: reviewStatusLabel(status), tone: status === 'reviewed' ? 'good' : 'warn', next: '打开后可查看还差哪些项。', remaining: 0 };
  const undone = reviewChecklist(review, qa, materials).filter(item => !item.done);
  if (!undone.length) return { badge: '可预览', label: '前置检查已齐', tone: 'good', next: '前置检查已齐。按 : →「选择题集与模板并预览发布」；预览时系统还会复核证据和残留的待补文字，通过后你再确认，确认前不会写入。', remaining: 0 };
  return { badge: `${reviewStatusLabel(status)}·缺${undone.length}项`, label: `${reviewStatusLabel(status)} · 还差 ${undone.length} 项才能预览发布`, tone: 'warn', next: `${undone[0]!.label}。${undone[0]!.how}`, remaining: undone.length };
}

export const FIELD_NAMES: Record<string, string> = { name: '名称', question: '公开题目', instructions: '公开作答条件', rubric: '私有评分标准（Rubric）', reference_answer: '私有参考答案（可选）', required_points: '必答要点', forbidden_claims: '错误说法（评分时用来识别错误回答）', references: '私有依据' };
export const FIELD_KEYS = ['name', 'question', 'instructions', 'rubric', 'reference_answer', 'required_points', 'forbidden_claims', 'references'];

export interface FieldTag { text: string; tone: Tone }
/** Who wrote the value and whether a person has checked it. */
export function fieldTag(key: string, qa: Data, provenance: Data, verified: string[]): FieldTag {
  const value = qa[key], empty = Array.isArray(value) ? strings(value).length === 0 : text(value).trim() === '';
  if (empty) return key === 'reference_answer' || key === 'references' || key === 'forbidden_claims' ? { text: '暂无', tone: 'muted' } : { text: '待补', tone: 'bad' };
  if (verified.includes(key)) return { text: '已人工确认', tone: 'good' };
  const source = clean(text(provenance[key]));
  if (source === 'human') return { text: '人工填写', tone: 'good' };
  if (source === 'model_suggestion' || source === '') return { text: '模型建议，待核对', tone: 'warn' };
  return { text: source, tone: 'warn' };
}
