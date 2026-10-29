import { createHash, randomBytes } from 'node:crypto';
import type { Data } from './protocol.js';
import { array, record, verificationMode } from './pages.js';
import { timestampOrderKey } from './timestamp-order.js';

export const objects = (v: unknown): Data[] => array(v).map(record);
export const text = (v: unknown): string => v == null ? '' : String(v);
export const json = (v: unknown): string => JSON.stringify(v, null, 2) ?? '';
export interface Criterion { key: string; id: string; targetId: string; targetType: string; parent: string; statement: string }
export function criteria(trace: Data): Criterion[] {
  const issue = record(record(trace.contract).issue);
  return (['goal', 'constraint'] as const).flatMap(type => objects(issue[type === 'goal' ? 'goals' : 'constraints']).flatMap(parent =>
    objects(parent.criteria).map(c => ({ key: `${issue.id}:${issue.version}:${type}:${parent.id}:${c.id}`, id: text(c.id), targetId: text(parent.id), targetType: type, parent: text(parent.statement), statement: text(c.statement) }))));
}
export function criterionClaim(trace: Data, criterion: Criterion): Data {
  const parent = objects(record(trace.submission).claims).find(c => c.target_type === criterion.targetType && c.target_id === criterion.targetId);
  return objects(parent?.criteria).find(c => c.criterion_id === criterion.id) ?? {};
}
export function assessment(report: Data, criterion: Criterion): Data {
  const parent = objects(record(report.report).assessments).find(c => c.target_type === criterion.targetType && c.target_id === criterion.targetId);
  return objects(parent?.criteria).find(c => c.criterion_id === criterion.id) ?? {};
}
export const selfStatus: Record<string, string> = { satisfied: '满足', partially_satisfied: '部分满足', not_satisfied: '未满足', inconclusive: '无法判断', not_verified: '未验证' };
export type OutlineState = 'met' | 'unmet' | 'partial' | 'pending' | 'unknown' | 'conflict';
export interface OutlineChecks { self: OutlineState; independent: OutlineState; counts?: { self: string; independent: string } }
export function criterionStatus(trace: Data, criterion: Criterion, reports: Data[], count: number): { self: string; independent: string; selfSatisfied: boolean; independentSatisfied: boolean; selfState: OutlineState; independentState: OutlineState } {
  const self = text(record(criterionClaim(trace, criterion).self_verification).status);
  const selfState: OutlineState = ({ satisfied: 'met', partially_satisfied: 'partial', not_satisfied: 'unmet', inconclusive: 'unknown' } as Record<string, OutlineState>)[self] ?? 'pending';
  const selfLabels: Record<string, string> = {
    satisfied: '✓ 满足', partially_satisfied: '△ 部分满足', not_satisfied: '× 未满足',
    inconclusive: '? 无法判断', not_verified: '— 未验证',
  };
  let independent = '— 未提交';
  let independentState: OutlineState = 'pending';
  if (count > 0 && reports.length !== count) independent = `… 待载入 ${reports.length}/${count}`;
  else if (count > 0) {
    const verdicts = reports.map(report => text(record(assessment(report, criterion).final).verdict));
    if (verdicts.some(verdict => !['qualified', 'rejected', 'inconclusive'].includes(verdict))) { independent = '? 未覆盖'; independentState = 'unknown'; }
    else if (verdicts.every(verdict => verdict === 'qualified')) { independent = '✓ 满足'; independentState = 'met'; }
    else if (verdicts.every(verdict => verdict === 'rejected')) { independent = '× 未满足'; independentState = 'unmet'; }
    else if (verdicts.every(verdict => verdict === 'inconclusive')) { independent = '? 无法判断'; independentState = 'unknown'; }
    else { independent = '! 结论不一'; independentState = 'conflict'; }
  }
  return { self: selfLabels[self] ?? '— 未记录', independent, selfSatisfied: selfState === 'met', independentSatisfied: independentState === 'met', selfState, independentState };
}
export function targetStatus(trace: Data, type: string, id: string, reports: Data[], count: number): string {
  const children = criteria(trace).filter(c => c.targetType === type && c.targetId === id);
  if (!children.length) return '无子标准';
  const statuses = children.map(c => criterionStatus(trace, c, reports, count));
  const self = statuses.filter(status => status.selfSatisfied).length;
  const independent = statuses.filter(status => status.independentSatisfied).length;
  const selfLabel = `自验满足${self === children.length ? ' ✓' : ''} ${self}/${children.length}`;
  const independentLabel = count === 0 ? '独立验证 — 未提交'
    : reports.length !== count ? `独立验证 … 待载入 ${reports.length}/${count}`
    : `独立验证满足${independent === children.length ? ' ✓' : ''} ${independent}/${children.length}`;
  return `子标准 ${children.length} 条  ${selfLabel}  ${independentLabel}`;
}
export function outlineCriterionChecks(trace: Data, criterion: Criterion, reports: Data[], count: number): OutlineChecks {
  const status = criterionStatus(trace, criterion, reports, count);
  return { self: status.selfState, independent: status.independentState };
}
function aggregateState(states: OutlineState[]): OutlineState {
  if (!states.length) return 'pending';
  if (states.every(state => state === 'met')) return 'met';
  for (const state of ['unmet', 'conflict', 'partial', 'unknown', 'pending'] as const) if (states.includes(state)) return state;
  return 'pending';
}
export function outlineTargetChecks(trace: Data, type: string, id: string, reports: Data[], count: number): OutlineChecks {
  const children = criteria(trace).filter(c => c.targetType === type && c.targetId === id);
  const statuses = children.map(c => criterionStatus(trace, c, reports, count));
  return {
    self: aggregateState(statuses.map(status => status.selfState)),
    independent: aggregateState(statuses.map(status => status.independentState)),
    counts: { self: `${statuses.filter(status => status.selfSatisfied).length}/${children.length}`, independent: `${statuses.filter(status => status.independentSatisfied).length}/${children.length}` },
  };
}
export const shortId = (value: unknown): string => { const id = text(value); return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id; };
export function criterionNumber(trace: Data, c: Criterion): string {
  const issue = record(record(trace.contract).issue);
  const parents = objects(issue[c.targetType === 'goal' ? 'goals' : 'constraints']);
  const index = parents.findIndex(p => p.id === c.targetId);
  const child = objects(parents[index]?.criteria).findIndex(item => item.id === c.id);
  return `${c.targetType === 'goal' ? 'G' : 'C'}${index + 1}.${child + 1}`;
}
export function evidenceText(value: unknown): string {
  const evidence = objects(value);
  return evidence.length ? evidence.map((e, i) => [
    `证据 ${i + 1} · ${text(e.type) || '记录'}${e.exit_code !== undefined ? ` · 记录退出码 ${e.exit_code}` : ''}`,
    e.command ? `$ ${text(e.command)}` : '',
    e.output !== undefined ? `输出：\n${text(e.output)}` : '',
    ...Object.entries(e).filter(([k]) => !['type', 'command', 'exit_code', 'output'].includes(k)).map(([k, v]) => `${k}：${typeof v === 'string' ? v : json(v)}`),
  ].filter(Boolean).join('\n')).join('\n\n') : '未附证据';
}
const verdictLabel = (value: unknown) => ({ qualified: '满足', rejected: '未满足', inconclusive: '无法判断' }[text(value)] ?? (text(value) || '未记录'));
export function verifierName(report: Data): string {
  const who = record(report.attribution);
  return text(who.display_name) || text(who.name) || text(who.agent_id) || text(who.email) || '未记录验证者名称';
}
export function reportDetail(report: Data, c: Criterion, section: 'independent' | 'reconciliation' | 'metadata'): string {
  const a = assessment(report, c);
  const header = `验证者：${verifierName(report)}\n报告：${text(report.verification_id)}`;
  if (section === 'metadata') return `${header}\n时间：${text(report.created_at)}\n来源：${json(report.attribution)}`;
  if (!Object.keys(a).length) return `${header}\n\n本报告未覆盖该标准`;
  if (section === 'independent') return [header, '独立检查', `判断：${verdictLabel(record(a.independent).verdict)}`, text(record(a.independent).explanation) || '未记录判断理由', '证据 · 提供者记录，退出码不等于验收通过', evidenceText(record(a.independent).evidence)].join('\n\n');
  const relation = text(record(a.reconciliation).claim_relation);
  const translated = ({ corroborated: '作者声明得到验证支持', contradicted: '作者声明与检查结果矛盾', insufficient: '证据不足' } as Record<string, string>)[relation] ?? relation;
  return [header, '对照作者声明', translated || '未记录核对结果', text(record(a.reconciliation).explanation) || '未记录核对理由'].join('\n\n');
}
export function criterionText(trace: Data, c: Criterion, reports: Data[], count: number, inspectedReports = reports): string {
  const claim = criterionClaim(trace, c), self = record(claim.self_verification);
  const status = criterionStatus(trace, c, inspectedReports, count);
  const verdicts = inspectedReports.map(r => record(assessment(r, c).final).verdict);
  const conflict = verdicts.includes('qualified') && verdicts.includes('rejected');
  return ['## 要求', c.statement, `所属${c.targetType === 'goal' ? '目标' : '约束'} ${criterionNumber(trace, c).split('.')[0]}：${c.parent}`,
    '---', `## 作者交付 · 自验 ${status.self}`, '**实现说明**', text(claim.explanation) || '未记录作者声明',
    `自验结论：${selfStatus[text(self.status)] ?? '未记录'} · 作者提供的证据：${objects(claim.evidence).length} 条`,
    text(self.explanation), self.method ? `自验方法：${self.method}` : '',
    '---', `## 独立复核 · ${count} 份报告 · ${status.independent}`,
    `已加载 ${inspectedReports.length}/${count} 份正文 · 当前展示 ${reports.length} 份`,
    ...(conflict ? ['[分歧] 已加载报告对本标准存在相反结论，请逐份核对来源与范围。'] : []),
    ...(count === 0 ? ['未提交独立验证；不代表失败。'] : reports.length === 0 ? ['报告正文尚未加载。'] : []),
    ...reports.flatMap((r, index) => { const a = assessment(r, c); return [
      `### 验证报告 ${index + 1} · ${shortId(r.verification_id)} · ${verificationMode(r)}`,
      `验证者：${verifierName(r)}`,
      ...(r.mode === 'ultra' ? ['本条为契约部分的判断；代码质量评审的维度结论与发现请用 CLI `verification show` 或 Review 阅读，整体结论取两部分中更保守者。'] : []),
      ...(Object.keys(a).length ? [`**最终判断：${verdictLabel(record(a.final).verdict)}**`, '**判断理由**', text(record(a.final).explanation) || '未记录最终判断理由'] : ['本报告未覆盖该标准']),
    ]; }),
  ].filter(Boolean).join('\n\n');
}
export function targetText(trace: Data, type: string, id: string, reports: Data[], count: number): string {
  const issue = record(record(trace.contract).issue);
  const target = objects(issue[type === 'goal' ? 'goals' : 'constraints']).find(t => t.id === id) ?? {};
  const claim = objects(record(trace.submission).claims).find(c => c.target_type === type && c.target_id === id);
  const children = criteria(trace).filter(c => c.targetType === type && c.targetId === id);
  return [text(target.statement), '## 作者实现说明', text(claim?.explanation) || '未记录目标级作者说明',
    `## 所属验收标准 · ${children.length} 条`,
    ...children.map(c => [
      `${criterionNumber(trace, c)} · ${c.statement}`,
      `自我验证：${selfStatus[text(record(criterionClaim(trace, c).self_verification).status)] ?? '未记录'}`,
      count === 0 ? '未提交独立验证；不代表失败。' : reports.length === 0 ? '独立报告正文尚未加载。' : reports.map(r => { const a = assessment(r, c); return `报告 ${shortId(r.verification_id)}：${Object.keys(a).length ? verdictLabel(record(a.final).verdict) : '本报告未覆盖该标准'}`; }).join('\n'),
    ].join('\n\n')),
    `独立报告正文已加载 ${reports.length}/${count} 份；逐条展示，不合成目标通过结论。`,
  ].join('\n\n');
}
export const rangeLabel = (v: unknown) => { const r = record(v); return typeof r.start === 'number' ? `${r.start},${r.lines}` : '无'; };
export interface Block { unit: Data; content?: string; unavailable?: string }
const blockCache = new WeakMap<Data, Block[]>();
export function blocks(trace: Data): Block[] {
  const cached = blockCache.get(trace); if (cached) return cached;
  const value = readBlocks(trace); blockCache.set(trace, value); return value;
}
function readBlocks(trace: Data): Block[] {
  const artifact = record(trace.artifact), units = objects(record(trace.change_index).change_units);
  if (artifact.patch_state !== 'inline' || typeof artifact.patch !== 'string') return units.map(unit => ({ unit, unavailable: `固定工件文本不可用：${text(artifact.patch_state) || '未请求'}` }));
  const manifest = objects(artifact.file_manifest);
  if (typeof artifact.patch_digest === 'string' && artifact.patch_digest !== `sha256:${createHash('sha256').update(artifact.patch).digest('hex')}`) return units.map(unit => ({ unit, unavailable: '固定工件摘要不匹配' }));
  const sections = artifact.patch.split(/(?=^diff --git )/m).filter(Boolean);
  const byPath = new Map<string, Map<string, string>>();
  if (sections.length !== manifest.length || sections.some(s => !s.startsWith('diff --git '))) return units.map(unit => ({ unit, unavailable: '工件文件索引不匹配，不能准确定位' }));
  sections.forEach((section, i) => {
    const contents = new Map<string, string>();
    const current = Buffer.from(text(manifest[i].path_bytes), 'base64');
    const old = manifest[i].old_path_bytes ? Buffer.from(text(manifest[i].old_path_bytes), 'base64') : current;
    const left = Buffer.concat([Buffer.from('a/'), old]), right = Buffer.concat([Buffer.from('b/'), current]);
    const quote = (bytes: Buffer) => '"' + [...bytes].map(byte => {
      const named: Record<number, string> = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r' };
      return named[byte] ? `\\${named[byte]}` : byte === 34 || byte === 92 ? `\\${String.fromCharCode(byte)}` : byte < 32 || byte >= 127 ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte);
    }).join('') + '"';
    const header = section.slice(0, section.indexOf('\n')).replace(/\r$/, '');
    if (header !== `diff --git ${left.toString('utf8')} ${right.toString('utf8')}` && header !== `diff --git ${quote(left)} ${quote(right)}`) return;
    const starts = [...section.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm)].map(m => m.index!);
    const parts = starts.length ? starts.map((start, j) => section.slice(start, starts[j + 1] ?? section.length)) : [section];
    for (const part of parts) contents.set(`sha256:${createHash('sha256').update(part).digest('hex')}`, part);
    byPath.set(text(manifest[i].path_bytes), contents);
  });
  return units.map(unit => { const content = byPath.get(text(unit.path_bytes))?.get(text(unit.content_digest)); return { unit, content, ...(!content ? { unavailable: '内容摘要不匹配，定位不可用；保留原始 Change Unit' } : {}) }; });
}
export function rationales(trace: Data, block: Block): Data[] {
  return objects(record(trace.submission).change_rationales).filter(r => Array.isArray(r.change_refs) && r.change_refs.includes(block.unit.change_unit_id));
}
export function linkedCriteria(trace: Data, block: Block): Criterion[] {
  const ids = new Set(rationales(trace, block).flatMap(r => objects(r.target_refs).filter(t => t.type === 'criterion').map(t => t.id)));
  // Old malformed contracts with duplicate criterion IDs must not acquire guessed associations.
  const all = criteria(trace);
  return all.filter(c => ids.has(c.id) && all.filter(other => other.id === c.id).length === 1);
}
export function relatedBlocks(trace: Data, c: Criterion): Block[] { return blocks(trace).filter(b => linkedCriteria(trace, b).some(x => x.key === c.key)); }
export function basisText(trace: Data, block: Block): string {
  const direct = rationales(trace, block), linked = linkedCriteria(trace, block);
  const others = blocks(trace).filter(b => b.unit.path_bytes === block.unit.path_bytes && b.unit.change_unit_id !== block.unit.change_unit_id);
  return [`# 当前${block.unit.kind === 'file' ? '文件级变更' : '块'}已记录关联`, text(block.unit.display_path), `旧侧 ${json(block.unit.old_range)} → 新侧 ${json(block.unit.new_range)}`, `Change Unit：${block.unit.change_unit_id}`,
    ...direct.map(r => `## 作者理由 · ${text(r.relation)}\n${text(r.rationale)}\n标准引用：${objects(r.target_refs).map(t => text(t.id)).join('、')}\n${r.alternatives ? `替代方案：${json(r.alternatives)}` : ''}\n${r.risks ? `风险：${json(r.risks)}` : ''}`), ...(direct.length ? [] : ['未记录关联；不能据此推断标准未满足。']),
    ...linked.map(c => `## ${c.statement}\n契约父项（不是额外代码关联）：${c.parent}`),
    '## 本文件其他块的关联', ...others.filter(b => rationales(trace, b).length).map(b => `${b.unit.change_unit_id}\n旧侧 ${json(b.unit.old_range)} → 新侧 ${json(b.unit.new_range)}\n${json(rationales(trace, b))}`),
    '## Candidate 整体说明', text(record(trace.submission).explanation) || '未记录'].join('\n\n');
}
export function operationId(): string {
  const b = randomBytes(16); b.writeUIntBE(Date.now(), 0, 6); b[6] = 0x70 | (b[6] & 15); b[8] = 0x80 | (b[8] & 63);
  const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function recentIssues(resources: Data[]): Data[] {
  return [...resources].sort((a, b) => timestampOrderKey(text(record(b.last_activity).occurred_at)).localeCompare(timestampOrderKey(text(record(a.last_activity).occurred_at))) || text(a.resource_id).localeCompare(text(b.resource_id)));
}
