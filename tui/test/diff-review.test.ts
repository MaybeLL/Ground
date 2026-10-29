import { test } from 'node:test';
import assert from 'node:assert/strict';
import { association, scopedBlocks, unitBasis, unitBasisSummary } from '../src/diff-review.js';
import { blocks, criteria } from '../src/review-model.js';
import type { Data } from '../src/protocol.js';
import { trace, report } from './fixtures.js';
function sample(): Data {
  const source: Data = structuredClone(trace);
  const t = source as any;
  t.contract.issue.goals[0].criteria[0].id = 'c1';
  t.contract.issue.constraints[0].criteria[0].id = 'c2';
  t.change_index.change_units = ['h1', 'h2', 'h3'].map(change_unit_id => ({ change_unit_id, kind: change_unit_id === 'h3' ? 'file' : 'hunk', path_bytes: 'YQ==', display_path: 'same.ts' }));
  t.submission.format = 'patchledger.candidate-submission/v2';
  t.submission.change_rationales = [
    { change_refs: ['h1'], target_refs: [{ type: 'criterion', id: 'c1' }], relation: 'implements', rationale: '实现目标' },
    { change_refs: ['h2'], target_refs: [{ type: 'criterion', id: 'c2' }], relation: 'verifies', rationale: '检查约束' },
  ];
  return source;
}
test('scopes isolate units from the same file and preserve unreadable file units in pending', () => {
  const t = sample();
  assert.deepEqual(scopedBlocks(t, { kind: 'goal', id: 'g' }).map(b => b.unit.change_unit_id), ['h1']);
  assert.deepEqual(scopedBlocks(t, { kind: 'constraint', id: 'h' }).map(b => b.unit.change_unit_id), ['h2']);
  assert.deepEqual(scopedBlocks(t, { kind: 'pending' }).map(b => b.unit.change_unit_id), ['h3']);
  assert.equal(scopedBlocks(t, { kind: 'goal', id: 'missing' }).length, 0);
  assert.equal(scopedBlocks(t, { kind: 'pending' })[0].unit.kind, 'file');
  assert.match(scopedBlocks(t, { kind: 'pending' })[0].unavailable!, /不可用/);
});
test('many-to-many reasons keep their grouping and show standards outside the current scope', () => {
  const t = sample() as any;
  t.submission.change_rationales = [{ change_refs: ['h1', 'h2'], target_refs: [{ type: 'criterion', id: 'c1' }, { type: 'criterion', id: 'c2' }], relation: 'supports', rationale: '共同支持', alternatives: [{ approach: '其他方式', rejected_because: '不合适' }], risks: ['边界风险'] }];
  const body = unitBasis(t, blocks(t)[0], { kind: 'goal', id: 'g' }, [], 3);
  assert.match(body, /共同关联 2 个变更单元/);
  assert.match(body, /标准 C1.1 · 当前范围外/);
  assert.match(body, /边界风险/);
  assert.match(body, /0\/3/);
  const summary = unitBasisSummary(t, blocks(t)[0], { kind: 'goal', id: 'g' }, [], 3);
  assert.ok(summary.indexOf('作者修改理由') < summary.indexOf('关联标准'));
  assert.match(summary, /共同关联 2 个变更单元/);
  assert.match(summary, /C1.1 · 当前范围外/);
  assert.match(summary, /替代方案 1 条 · 风险 1 条/);
  assert.doesNotMatch(summary, /边界风险|未采用原因/);
  assert.match(summary, /查看当前块完整关联依据/);
  assert.deepEqual(scopedBlocks(t, { kind: 'goal', id: 'g' }).map(b => b.unit.change_unit_id), ['h1', 'h2']);
});
test('partial invalid references overlap the goal and pending views without inventing links', () => {
  const t = sample() as any;
  t.submission.change_rationales[0].target_refs.push({ type: 'criterion', id: 'missing' });
  assert.equal(scopedBlocks(t, { kind: 'goal', id: 'g' }).length, 1);
  assert.deepEqual(scopedBlocks(t, { kind: 'pending' }).map(b => b.unit.change_unit_id), ['h1', 'h3']);
  assert.match(association(t, blocks(t)[0]).problems.join(), /引用失效/);
  const ambiguous = structuredClone(t);
  ambiguous.contract.issue.constraints[0].criteria.push({ id: 'c1', statement: '歧义' });
  assert.equal(association(ambiguous, blocks(ambiguous)[0]).criteria.length, 0);
  assert.match(association(ambiguous, blocks(ambiguous)[0]).problems.join(), /身份歧义/);
});
test('historical missing associations differ from missing protocol fields', () => {
  const t = sample() as any; delete t.submission.change_rationales;
  assert.match(association(t, blocks(t)[0]).problems.join(), /协议字段缺失/);
  const historical = structuredClone(t); historical.submission.format = 'patchledger.candidate-submission/v1';
  assert.deepEqual(association(historical, blocks(historical)[0]).problems, ['历史未记录']);
});
test('verification stays criterion-level with partial coverage, disagreement and uncovered reports', () => {
  const t = sample(); const r = structuredClone(report);
  r.report.assessments[0].criteria[0].criterion_id = criteria(t)[0].id;
  const scope = { kind: 'goal' as const, id: 'g' };
  const one = unitBasis(t, blocks(t)[0], scope, [r], 3);
  assert.match(one, /已加载 1\/3/); assert.match(one, /当前标准覆盖 1 份/);
  assert.match(one, /不是当前块单独验收/);
  const negative = structuredClone(r); negative.report.assessments[0].criteria[0].final.verdict = 'rejected';
  assert.match(unitBasis(t, blocks(t)[0], scope, [r, negative], 3), /判断不一致/);
  assert.match(unitBasis(t, blocks(t)[1], scope, [r], 3), /本报告未覆盖/);
  const complete = unitBasisSummary(t, blocks(t)[0], scope, [r], 1);
  assert.match(complete, /作者自验：— 未记录 · 独立验证：✓ 满足/);
  assert.match(complete, /独立判断理由摘录：最终结论/);
});
