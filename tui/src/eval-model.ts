import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { Data } from './protocol.js';
import { ClientError } from './protocol.js';
import { checkedReport, fixedRecord, type EvalAccess, type EvalRead, type EvalRecord, type EvalReport, type ReportTask, type Attempt, type Ref } from './eval-protocol.js';
export const object = (v: unknown): Data => v && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
export const items = (v: unknown): Data[] => Array.isArray(v) ? v.map(object) : [];
export const string = (v: unknown) => String(v ?? '');
const pretty = (v: unknown) => v === undefined ? '未记录' : JSON.stringify(v, null, 2);
export const refText = (v: unknown) => { const r = object(v); return `${r.id ?? '未绑定'}${r.version ? ` · v${r.version}` : ''}`; };
export const recordLabel = (r: EvalRecord) => `${r.data.name ?? object(r.data.subject).name ?? r.id} · v${r.version}`;
export const titleFor: Record<string, string> = { suite: '题集', qa: 'QA 题目', grader: '评分规则', experiment: '实验', snapshot: '冻结题集', artifact: '答案' };
export async function readRecord(access: EvalAccess, kind: string, id: string, version?: number, signal?: AbortSignal): Promise<EvalRecord> { return fixedRecord(await access.read(`${kind}.show` as EvalRead, [id, ...(version ? ['--version', String(version)] : [])], signal), kind, id, version); }
export async function readRecords(access: EvalAccess, kind: string, signal?: AbortSignal): Promise<EvalRecord[]> {
  const result = await access.read(`${kind}.list` as EvalRead, [], signal);
  if (!Array.isArray(result)) throw new ClientError('PROTOCOL_ERROR', '列表不是集合');
  const values = result.map(v => fixedRecord(v, kind)); if (new Set(values.map(v => v.id)).size !== values.length) throw new ClientError('PROTOCOL_ERROR', '列表身份重复'); return values;
}
export async function reports(access: EvalAccess, ids: string[], signal?: AbortSignal): Promise<EvalReport[]> {
  if (ids.length < 2 || new Set(ids).size !== ids.length) throw new Error('请选择至少两个不同实验');
  const values = await Promise.all(ids.map(async id => checkedReport(await access.read('experiment.report', [id], signal), id)));
  if (values.some(r => r.snapshot.id !== values[0].snapshot.id)) throw new Error('对照需要同一 Snapshot；选择已保留，请调整实验');
  const fixed = values[0].snapshot.data; if (values.some(r => !isDeepStrictEqual(r.snapshot.data, fixed))) throw new ClientError('PROTOCOL_ERROR', '相同 Snapshot 返回不同内容');
  return values;
}
export function assetText(r: EvalRecord): string {
  const d = r.data, header = `# ${recordLabel(r)}\n\n身份：${r.id}\n\n版本：${r.version} · 记录时间：${r.created_at}`;
  if (r.kind === 'qa') return [header, '## 公开题面', string(d.question), '## 公开作答指令', string(d.instructions), '## 私有评分材料 · 仅供协调者审阅', '### Rubric', string(d.rubric), '### 参考答案', string(d.reference_answer) || '未记录', '### 必需要点', ...itemsAsLines(d.required_points), '### 禁止断言', ...itemsAsLines(d.forbidden_claims), '### 参考材料', ...itemsAsLines(d.references), '## 来源', pretty(d.source)].join('\n\n');
  if (r.kind === 'grader') { const scope = object(d.scope), spec = object(d.result_spec), def = object(d.definition); return [header, `绑定任务：${refText(d.qa ?? d.issue)}`, `评分范围：${scope.kind === 'criterion' ? 'Criterion ' + (scope.criterion_ids as string[]).join(', ') : '诊断维度 ' + scope.name}`, `结果类型：${spec.kind}`, spec.kind === 'score' ? `区间：${spec.min}–${spec.max}，${spec.higher_is_better ? '越高越好' : '越低越好'}\n\n${spec.rubric}` : '', '## 私有评分定义', def.type === 'agent' ? string(def.instructions) : `Go 单测 · ${def.package} · ${def.test_name}\n\n超时 ${def.timeout_seconds} 秒\n\n` + items(def.files).map(f => `### ${f.path}\n\n\u0060\u0060\u0060go\n${f.content}\n\u0060\u0060\u0060`).join('\n\n'), '## 局限', string(d.limitations)].join('\n\n'); }
  if (r.kind === 'suite') return `${header}\n\n${items(d.tasks).length} 项任务。成员绑定固定版本，修订不改写实验。\n\n${items(d.tasks).map(t => `## ${t.qa ? 'QA' : 'Coding'} · ${t.name}\n\n任务：${refText(t.qa ?? t.issue)}\n\nGrader：${items(t.graders).map(refText).join(' / ')}`).join('\n\n')}`;
  return header + '\n\n' + pretty(d);
}
const itemsAsLines = (v: unknown) => Array.isArray(v) && v.length ? v.map(x => '- ' + string(x)) : ['未记录'];
export function noticesText(notices: EvalRecord[]) { return notices.map(n => `不推荐 ${refText(n.data.grader)} · ${n.created_at}\n${n.data.reason}`).join('\n\n'); }
export const selectedAttempt = (task: ReportTask, selected?: string): Attempt | undefined => selected ? task.runs.find(r => r.run.id === selected) : task.runs.length === 1 ? task.runs[0] : undefined;
export function resultText(a: Attempt | undefined, grader?: Ref): string {
  if (!a) return '待选择尝试';
  if (!a.result) return a.run.data.state === 'open' ? '未结束／无定稿' : '无定稿结果';
  if (object(a.artifact?.data.execution).status === 'error') return '作答执行失败';
  const values = items(a.result.data.graders).filter(g => !grader || object(g.grader).id === grader.id && object(g.grader).version === grader.version);
  if (!values.length) return '缺评分';
  return values.map(g => { const s = object(g.submission), o = object(s.outcome); if (!g.submission) return '缺评分'; if (s.status === 'error') return '执行失败'; if (s.status === 'not_executed') return '未执行评分'; if (o.kind === 'inconclusive') return 'inconclusive · 无法判定'; if (o.kind === 'score') return string(o.value); return string(o.verdict) || '无质量判定'; }).join(' / ');
}
export function taskStatus(t: ReportTask, chosen?: string, grader?: Ref) { if (!t.runs.length) return '未开始'; const a = selectedAttempt(t, chosen); return a ? resultText(a, grader) : `${t.runs.length} 次 · 待选择`; }
export function reportText(r: EvalReport): string {
  const subject = object(r.experiment.data.subject);
  const started = r.tasks.filter(t => t.runs.length).length, complete = r.tasks.filter(t => t.runs.some(a => a.result)).length;
  return [`# ${subject.name}`, string(subject.description), `实验：${r.experiment.id}`, `Snapshot：${r.snapshot.id} · 题集 ${refText(r.snapshot.data.suite)}`, `${r.tasks.length} 题 · ${started} 题已有尝试 · ${complete} 题至少一次有定稿（不等于通过）`, '状态来自账本记录，不表示宿主进程存活。', '## 配置与材料来源', pretty(r.experiment.data.environment), '## 环境与准备记录', pretty(r.environment), noticesText(r.notices), '各次尝试与 Grader 结果分别保留，不合成总分。'].join('\n\n');
}
export function gradingDuration(evidence: Data): string {
  const metrics = object(evidence.metrics), execution = object(evidence.execution);
  if (typeof metrics.duration_ms === 'number' && Number.isFinite(metrics.duration_ms) && metrics.duration_ms >= 0) return metrics.duration_ms + ' ms（metrics）';
  const start = Date.parse(string(execution.started_at)), end = Date.parse(string(execution.finished_at));
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) + ' ms（记录的起止时间）' : '未知';
}
export function attemptText(t: ReportTask, a: Attempt): string {
  const regrade = ['qa_regrade', 'regrade'].includes(string(a.run.data.mode));
  const lines = [`# ${t.task.name}`, `任务：${refText(t.task.qa ?? t.task.issue)}`, `Run：${a.run.id} · ${a.run.data.mode} · ${a.run.data.state}`, regrade ? '重评：引用原交付物，以下原作答耗时不计作本次新作答。' : '', !a.result ? '尚无正式 EvalResult，当前内容不代表定稿成绩。' : `Result：${a.result.id}`, a.result?.data.reason ? `终止说明：${a.result.data.reason}` : ''];
  if (a.artifact) { const d = a.artifact.data, metrics = object(d.metrics); lines.push('## 原交付物来源', `Artifact：${a.artifact.id}`, `原作答 Run：${d.run_id ?? '未记录'}`, `原答案 QA：${refText(d.qa)}`, `本次评分任务 QA：${refText(t.task.qa)}`, '## 冻结答案', string(d.answer) || '未记录答案', '## 引用', pretty(d.citations), `作答耗时：${metrics.duration_ms ?? a.result?.data.answering_duration_ms ?? '未知'} ms`, `作答 Token（原记录）：${pretty(metrics.usage)}`, '## 作答状态与实际配置', pretty(d.execution), '## 采集覆盖', pretty(d.capture), '## 环境来源', pretty(d.environment)); }
  else if (t.task.qa) lines.push('答案未记录或尚未提交');
  else lines.push('Eval 评分与 Candidate 独立 Verification 分别记录，判定不能互相替代。', `Candidate：${a.result?.data.candidate_id ?? a.run.data.candidate_id ?? '未记录'}`, `开发耗时：${pretty(a.result?.data.development_duration)}`, 'Coding Token 未统一采集，未知不能当作零。');
  for (const g of t.graders) {
    const result = items(a.result?.data.graders).find(x => object(x.grader).id === g.id && object(x.grader).version === g.version);
    const sub = object(result?.submission), spec = object(g.data.result_spec);
    lines.push(`## ${g.data.name} · v${g.version}`, `Eval 判定：${a.result ? resultText(a, { id: g.id, version: g.version }) : '尚无定稿'}`, spec.kind === 'score' ? `评分区间 ${spec.min}–${spec.max} · ${spec.higher_is_better ? '越高越好' : '越低越好'}` : '', string(sub.explanation) || string(result?.missing_reason) || '评分说明未记录', string(object(sub.outcome).reason), ...items(sub.evidence).map(e => `### 证据 · ${e.kind}\n\n${e.content}`));
    const execution = a.executions?.find(e => e.id === result?.execution_id); const evidence = object(execution?.data.grading_evidence);
    lines.push(`评分 Execution：${execution?.id ?? '未记录'}`, `评分耗时：${gradingDuration(evidence)}`, `评分 Token：${pretty(object(evidence.metrics).usage ?? undefined)}`, `评分开始：${object(evidence.execution).started_at ?? '未记录'}`, `评分结束：${object(evidence.execution).finished_at ?? '未记录'}`, `评分采集：${pretty(evidence.capture)}`, `评分实际配置：${pretty(object(evidence.execution).observed)}`);
  }
  return lines.filter(Boolean).join('\n\n');
}
export interface MatrixRow { taskId: string; grader: Ref; label: string; values: string[] }
export type DifferenceKind = '改善' | '退步' | '持平' | '无法比较';
export interface DifferenceRow { taskId: string; grader: Ref; label: string; kind: DifferenceKind; reason: string }
function observedOutcome(t: ReportTask, chosen: string | undefined, grader: Ref): { kind: 'score' | 'decision'; value: number } | { reason: string } {
  if (!t.runs.length) return { reason: '未执行' };
  const run = selectedAttempt(t, chosen);
  if (!run) return { reason: chosen ? '原选择的 Run 已失效，请重新选择' : '多次尝试未选择 Run' };
  if (!run.result) return { reason: run.run.data.state === 'open' ? '运行未定稿' : '无结果' };
  if (object(run.artifact?.data.execution).status === 'error') return { reason: '作答执行失败' };
  const row = items(run.result.data.graders).find(item => object(item.grader).id === grader.id && object(item.grader).version === grader.version);
  if (!row) return { reason: '缺评分记录' };
  if (!row.submission) return { reason: string(row.missing_reason) || '缺评分' };
  const submission = object(row.submission), outcome = object(submission.outcome);
  if (submission.status !== 'completed') return { reason: submission.status === 'not_executed' ? '评分未执行' : '评分执行失败' };
  if (outcome.kind === 'inconclusive') return { reason: string(outcome.reason) || '无法判定' };
  if (outcome.kind === 'score' && typeof outcome.value === 'number' && Number.isFinite(outcome.value)) return { kind: 'score', value: outcome.value };
  if (outcome.kind === 'decision' || outcome.kind === 'qa_decision') {
    const rank = { fail: 0, partial: 1, pass: 2 }[string(outcome.verdict) as 'fail' | 'partial' | 'pass'];
    if (rank !== undefined) return { kind: 'decision', value: rank };
  }
  return { reason: '无有效质量判定' };
}
export function differenceRows(base: EvalReport, peer: EvalReport, selections: Record<string, string>): DifferenceRow[] {
  if (base.experiment.id === peer.experiment.id || base.snapshot.id !== peer.snapshot.id || !isDeepStrictEqual(base.snapshot.data, peer.snapshot.data)) throw new Error('对照需要两个不同实验和同一固定 Snapshot');
  return base.tasks.flatMap(task => task.graders.map(grader => {
    const other = peer.tasks.find(t => t.task.id === task.task.id);
    if (!other) throw new ClientError('PROTOCOL_ERROR', '对照任务缺失');
    const ref = { id: grader.id, version: grader.version };
    const left = observedOutcome(task, selections[`${base.experiment.id}/${task.task.id}`], ref);
    const right = observedOutcome(other, selections[`${peer.experiment.id}/${task.task.id}`], ref);
    const label = `${task.task.name} · ${grader.data.name}`;
    if ('reason' in left || 'reason' in right) return { taskId: task.task.id, grader: ref, label, kind: '无法比较' as const, reason: `基线：${'reason' in left ? left.reason : '有效'}；对照：${'reason' in right ? right.reason : '有效'}` };
    const spec = object(grader.data.result_spec);
    if (left.kind !== right.kind || left.kind === 'score' && spec.kind !== 'score' || left.kind === 'decision' && spec.kind === 'score') return { taskId: task.task.id, grader: ref, label, kind: '无法比较' as const, reason: '评分类型不一致' };
    const delta = (right.value - left.value) * (left.kind === 'score' && spec.higher_is_better === false ? -1 : 1);
    return { taskId: task.task.id, grader: ref, label, kind: (delta > 0 ? '改善' : delta < 0 ? '退步' : '持平') as DifferenceKind, reason: `${resultText(selectedAttempt(task, selections[`${base.experiment.id}/${task.task.id}`]), ref)} → ${resultText(selectedAttempt(other, selections[`${peer.experiment.id}/${task.task.id}`]), ref)}` };
  }));
}
export function matrixRows(rs: EvalReport[], selections: Record<string, string>): MatrixRow[] {
  return rs[0].tasks.flatMap(t => t.graders.map(g => ({ taskId: t.task.id, grader: { id: g.id, version: g.version }, label: `${t.task.name} · ${g.data.name}`, values: rs.map(r => { const rt = r.tasks.find(x => x.task.id === t.task.id); if (!rt) throw new Error('对照任务缺失'); return taskStatus(rt, selections[`${r.experiment.id}/${t.task.id}`], { id: g.id, version: g.version }); }) })));
}
export async function readEvidence(access: EvalAccess, kind: 'artifact' | 'execution', id: string, name: string, signal?: AbortSignal): Promise<string> {
  const command = kind === 'artifact' ? 'artifact.file' : 'grader.evidence-file';
  const chunks: Buffer[] = []; let offset = 0, hash = '', size = -1;
  do {
    const p = object(await access.read(command, [id, '--name', name, '--offset', String(offset)], signal));
    if (p.kind !== kind || p.id !== id || p.name !== name || p.offset !== offset || p.encoding !== 'base64' || !Number.isSafeInteger(p.size) || Number(p.size) > 16 * 1024 * 1024) throw new Error('证据身份、分页或大小异常（上限 16 MiB）');
    if (offset && (p.digest !== hash || p.size !== size)) throw new Error('证据内容在分页间变化');
    hash = string(p.digest); size = Number(p.size);
    const bytes = Buffer.from(string(p.content), 'base64'); if (bytes.toString('base64') !== p.content || bytes.length > 65536) throw new Error('证据编码无效');
    chunks.push(bytes); const end = offset + bytes.length;
    if (p.next_offset !== null && (p.next_offset !== end || end <= offset || end >= size) || p.next_offset === null && end !== size) throw new Error('证据分页不完整');
    offset = p.next_offset === null ? -1 : end;
  } while (offset >= 0);
  const bytes = Buffer.concat(chunks); if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('证据摘要不匹配');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('二进制证据不可作为文本阅读，请使用 CLI 导出'); }
}
