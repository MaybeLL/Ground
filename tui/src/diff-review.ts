import type { Data } from './protocol.js';
import { record } from './pages.js';
import { assessment, blocks, criteria, criterionClaim, criterionNumber, criterionStatus, json, objects, selfStatus, shortId, text, verifierName, type Block, type Criterion } from './review-model.js';

export type DiffScope = { kind: 'all' } | { kind: 'pending' } | { kind: 'criterion'; key: string } | { kind: 'goal' | 'constraint'; id: string };
export interface Association { reasons: Data[]; criteria: Criterion[]; problems: string[] }
const associations = new WeakMap<Data, Map<string, Association>>();
export function association(trace: Data, block: Block): Association {
  let cache = associations.get(trace);
  if (!cache) { cache = new Map(); associations.set(trace, cache); }
  const id = text(block.unit.change_unit_id);
  let value = cache.get(id);
  if (!value) { value = resolveAssociation(trace, block); cache.set(id, value); }
  return value;
}
function resolveAssociation(trace: Data, block: Block): Association {
  const submission = record(trace.submission), all = criteria(trace);
  const problems: string[] = [];
  if (!Array.isArray(submission.change_rationales)) return { reasons: [], criteria: [], problems: [submission.format === 'patchledger.candidate-submission/v1' ? '历史未记录' : '协议字段缺失：change_rationales'] };
  const reasons = objects(submission.change_rationales).filter(r => Array.isArray(r.change_refs) && r.change_refs.includes(block.unit.change_unit_id));
  if (!reasons.length) problems.push(submission.format === 'patchledger.candidate-submission/v1' ? '历史未记录' : '没有声明');
  if (objects(submission.change_rationales).some(r => !Array.isArray(r.change_refs))) problems.push('无法定位的理由：change_refs 缺失');
  const linked = new Map<string, Criterion>();
  for (const reason of reasons) {
    if (!Array.isArray(reason.target_refs) || !reason.target_refs.length) problems.push('标准引用缺失');
    if (objects(reason.target_refs).length !== (Array.isArray(reason.target_refs) ? reason.target_refs.length : 0)) problems.push('标准引用格式错误');
    for (const ref of objects(reason.target_refs)) {
      const matches = ref.type === 'criterion' ? all.filter(c => c.id === ref.id) : [];
      if (matches.length === 1) linked.set(matches[0].key, matches[0]);
      else problems.push(matches.length > 1 ? `身份歧义：${text(ref.id)}` : `引用失效：${text(ref.id)}`);
    }
    if ((reason.change_refs as unknown[]).some(id => !blocks(trace).some(b => b.unit.change_unit_id === id))) problems.push('共同关联的变更单元不存在');
  }
  return { reasons, criteria: [...linked.values()], problems: [...new Set(problems)] };
}
export function inScope(c: Criterion, scope: DiffScope): boolean {
  return scope.kind === 'all' || scope.kind === 'pending' || (scope.kind === 'criterion' ? c.key === scope.key : c.targetType === scope.kind && c.targetId === scope.id);
}
export function scopedBlocks(trace: Data, scope: DiffScope): Block[] {
  const unique = new Map(blocks(trace).map(b => [text(b.unit.change_unit_id), b]));
  return [...unique.values()].filter(b => { const a = association(trace, b); return scope.kind === 'all' || (scope.kind === 'pending' ? a.problems.length > 0 : a.criteria.some(c => inScope(c, scope))); });
}
export function scopeLabel(trace: Data, scope: DiffScope): string {
  if (scope.kind === 'all') return '全部变更';
  if (scope.kind === 'pending') return '关联待核查（可与目标范围重叠）';
  const c = criteria(trace).find(c => inScope(c, scope));
  if (c) return scope.kind === 'criterion' ? `标准 ${criterionNumber(trace, c)} · ${c.statement}` : `${scope.kind === 'goal' ? '目标' : '约束'} ${criterionNumber(trace, c).split('.')[0]} · ${c.parent}`;
  return scope.kind === 'criterion' ? '标准（无关联变更）' : `${scope.kind === 'goal' ? '目标' : '约束'}（无关联变更）`;
}
const verdict = (v: unknown) => ({ qualified: '满足', rejected: '未满足', inconclusive: '无法判断' }[text(v)] ?? (text(v) || '未记录'));
const relation = (v: unknown) => ({ implements: '实现', verifies: '验证用途', supports: '支持', generated: '生成', incidental: '附带' }[text(v)] ?? text(v));
const excerpt = (value: unknown, limit = 130): string => {
  const plain = text(value).replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim();
  const chars = Array.from(plain);
  return chars.length > limit ? `${chars.slice(0, limit).join('').trimEnd()}…` : plain || '未记录';
};
/** A scannable preview; the original rationale groups and every report remain in unitBasis. */
export function unitBasisSummary(trace: Data, block: Block, scope: DiffScope, reports: Data[], count: number): string {
  const a = association(trace, block);
  const alternatives = a.reasons.reduce((total, reason) => total + objects(reason.alternatives).length, 0);
  const risks = a.reasons.reduce((total, reason) => total + (Array.isArray(reason.risks) ? reason.risks.length : 0), 0);
  return [
    '## 当前块 · 审阅摘要',
    `作者声明关联 ${a.criteria.length} 条标准 · 修改说明 ${a.reasons.length} 条`,
    '关联来自作者声明；标准判断不是当前代码块的单独验收。',
    ...(a.problems.length ? ['## 待核查', ...a.problems.map(problem => `• ${problem}`)] : []),
    '## 作者修改理由',
    ...(a.reasons.length ? a.reasons.flatMap((reason, index) => [
      `### 说明 ${index + 1} · ${relation(reason.relation)} · 共同关联 ${new Set(reason.change_refs as string[]).size} 个变更单元`,
      excerpt(reason.rationale),
      `声明的标准：${objects(reason.target_refs).map(ref => { const criterion = a.criteria.find(c => c.id === ref.id); return criterion ? criterionNumber(trace, criterion) : `无法解析 ${text(ref.id)}`; }).join('、') || '未记录'}`,
    ]) : ['未记录当前块的修改理由。']),
    `## 关联标准 · ${a.criteria.length}`,
    ...a.criteria.flatMap(c => {
      const status = criterionStatus(trace, c, reports, count);
      const onlyReport = reports.length === 1 && count === 1 ? assessment(reports[0], c) : {};
      return [
        `### ${criterionNumber(trace, c)}${inScope(c, scope) ? '' : ' · 当前范围外'}`,
        excerpt(c.statement, 110),
        `作者自验：${status.self} · 独立验证：${status.independent}`,
        ...(Object.keys(onlyReport).length && text(record(onlyReport.final).explanation) ? [`独立判断理由摘录：${excerpt(record(onlyReport.final).explanation, 120)}`] : []),
      ];
    }),
    ...(a.criteria.length ? [] : ['未建立有效标准关联；不能据此推断标准未满足。']),
    '## 完整材料',
    `已加载独立报告 ${reports.length}/${count} 份 · 替代方案 ${alternatives} 条 · 风险 ${risks} 条`,
    '在 : 操作菜单选择“查看当前块完整关联依据”，阅读原文和逐份报告。',
  ].join('\n\n');
}
export function unitBasis(trace: Data, block: Block, scope: DiffScope, reports: Data[], count: number): string {
  const a = association(trace, block);
  return [
    '## 作者修改理由', '关联来自作者声明，不是平台证明的因果关系。',
    ...a.problems.map(p => `待核查：${p}`),
    ...a.reasons.flatMap((r, i) => [`### 说明 ${i + 1} · ${relation(r.relation)} · 共同关联 ${new Set(r.change_refs as string[]).size} 个变更单元`, text(r.rationale),
      `本条说明的标准：${objects(r.target_refs).map(ref => { const c = a.criteria.find(c => c.id === ref.id); return c ? criterionNumber(trace, c) : `无法解析 ${text(ref.id)}`; }).join('、')}`,
      ...objects(r.alternatives).map(alt => `替代方案：${text(alt.approach)}；未采用原因：${text(alt.rejected_because)}`),
      ...(Array.isArray(r.risks) ? r.risks.map(risk => `风险：${text(risk)}`) : [])]),
    '## 关联要求与标准验证', `候选报告正文已加载 ${reports.length}/${count} 份。标准判断不是当前块单独验收。`,
    ...a.criteria.flatMap(c => { const covered = reports.filter(r => Object.keys(assessment(r, c)).length); const judgments = new Set(covered.map(r => text(record(assessment(r, c).final).verdict)).filter(Boolean));
      return [`### 标准 ${criterionNumber(trace, c)}${inScope(c, scope) ? '' : ' · 当前范围外'}`, c.statement, `所属${c.targetType === 'goal' ? '目标' : '约束'}：${c.parent}`,
        `作者自验：${selfStatus[text(record(criterionClaim(trace, c).self_verification).status)] ?? '未记录'} · 当前标准覆盖 ${covered.length} 份`,
        ...(judgments.size > 1 ? ['判断不一致：请逐份核对依据。'] : []),
        ...(count === 0 ? ['无独立报告；不代表失败。'] : reports.length === 0 ? ['报告正文尚未加载。'] : []),
        ...reports.map(r => { const item = assessment(r, c); return `${verifierName(r)} · 报告 ${shortId(r.verification_id)}\n${Object.keys(item).length ? `标准判断：${verdict(record(item.final).verdict)}\n${text(record(item.final).explanation)}` : '本报告未覆盖该标准'}`; })]; }),
    ...(a.criteria.length ? [] : ['未建立有效标准关联；不能据此推断标准未满足。']),
  ].filter(Boolean).join('\n\n');
}

export function fullFileDiff(trace: Data, current: Block): string {
  const related = blocks(trace).filter(b => b.unit.path_bytes === current.unit.path_bytes);
  if (related.some(b => b.unavailable)) return `完整文件文本不可用：${related.find(b => b.unavailable)?.unavailable}`;
  const artifact = record(trace.artifact);
  const index = objects(artifact.file_manifest).findIndex(f => f.path_bytes === current.unit.path_bytes);
  const section = text(artifact.patch).split(/(?=^diff --git )/m)[index];
  return index >= 0 && section ? section : '完整文件文本不可用：固定工件没有对应文件';
}
