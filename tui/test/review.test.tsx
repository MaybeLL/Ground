import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { ReviewApp } from '../src/review-app.js';
import { renderMarkdown } from '../src/markdown.js';
import { ReviewSession } from '../src/review-data.js';
import { blocks, criteria, criterionText, criterionStatus, targetStatus, outlineCriterionChecks, outlineTargetChecks, reportDetail, targetText, linkedCriteria, operationId, recentIssues } from '../src/review-model.js';
import { fixture, trace, report, entry, set, issue } from './fixtures.js';
import type { Data, Method } from '../src/protocol.js';
const context = { cli: 'cli', version: '0.2.13', configSource: '/test/config', databaseId: 'db', driver: 'sqlite', cwd: '/test' };
const pause = (ms = 70) => new Promise(r => setTimeout(r, ms));
async function wait(view: { lastFrame(): string | undefined }, match: RegExp) { for (let i = 0; i < 80 && !match.test(view.lastFrame() ?? ''); i++) await pause(30); assert.match(view.lastFrame()!, match); }
const reader = { async query(method: Method, args: string[] = []): Promise<Data> {
  if (method === 'issues') return { resources: [{ resource_id: 'i', label: '输入校验', version: 1 }] };
  if (method === 'candidates') return { resources: [{ resource_id: 'c', label: '方案 A' }] };
  if (method === 'selection') return { issue: { id: 'i', version: 1 }, selection: { state: 'unselected', version: 0 } };
  return fixture(method, args);
} };
test('criterion identity includes parent and self verification never replaces independent results', () => {
  const c = criteria(trace); assert.notEqual(c[0].key, c[1].key);
  assert.match(criterionText(trace, c[0], [report], 1), /## 作者交付 · 自验 — 未记录/);
  assert.match(criterionText(trace, c[0], [report], 1), /## 独立复核 · 1 份报告 · ✓ 满足/);
  assert.match(criterionText(trace, c[0], [report], 1), /自验结论：未记录/);
  assert.match(criterionText(trace, c[0], [report], 1), /最终结论/);
  assert.match(criterionText(trace, c[1], [report], 1), /本报告未覆盖该标准/);
  assert.match(criterionText(trace, c[1], [report], 1), /## 独立复核 · 1 份报告 · \? 未覆盖/);
  assert.match(criterionText(trace, c[0], [], 0), /## 独立复核 · 0 份报告 · — 未提交/);
});
test('review prose shows quoted Chinese supporting copy without code-color fragments', () => {
  const source = structuredClone(trace);
  const copy = 'The full wordmark is followed by the centered supporting lines `有 据` and `可信交付 · Know How. Know Why.`.';
  source.contract.issue.goals[0].criteria[0].statement = copy;
  source.submission.claims[0].criteria[0].explanation = `The component renders centered ${copy}`;
  const raw = criterionText(source, criteria(source)[0], [report], 1);
  assert.match(raw, /`有 据` and `可信交付 · Know How\. Know Why\.`/);
  const body = renderMarkdown(raw.split('\n'), 180, true).join('\n');
  const plain = stripAnsi(body);
  assert.match(plain, /centered supporting lines 「有 据」 and 「可信交付 · Know How\. Know Why\.」/);
  assert.doesNotMatch(plain, /Know Why\.」\./);
  assert.doesNotMatch(body, /\u001b\[33m(?:有 据|可信交付)/);
  assert.equal(stripAnsi(renderMarkdown(['`brandTier` selects the tier'], 80, true).join('')), 'brandTier selects the tier');
  assert.equal(stripAnsi(renderMarkdown(['`const 文案 = "有 据"`'], 80, true).join('')), 'const 文案 = "有 据"');
  for (const width of [40, 65]) for (const line of renderMarkdown(raw.split('\n'), width, true)) assert.ok(stringWidth(line) <= width);
});
test('contract outline separates self checks from complete independent reports and counts child criteria', () => {
  const c = criteria(trace);
  assert.deepEqual(criterionStatus(trace, c[0], [report], 1), { self: '— 未记录', independent: '✓ 满足', selfSatisfied: false, independentSatisfied: true, selfState: 'pending', independentState: 'met' });
  assert.match(targetStatus(trace, 'goal', 'g', [report], 1), /自验满足 0\/1  独立验证满足 ✓ 1\/1/);
  assert.match(targetStatus(trace, 'constraint', 'h', [report], 1), /独立验证满足 0\/1/);
  assert.match(targetStatus(trace, 'goal', 'g', [], 0), /独立验证 — 未提交/);
  assert.match(targetStatus(trace, 'goal', 'g', [report], 2), /独立验证 … 待载入 1\/2/);
  assert.equal(criterionStatus(trace, c[0], [], 0).independent, '— 未提交');
  assert.equal(criterionStatus(trace, c[0], [report], 2).independent, '… 待载入 1/2');
  const rejected = structuredClone(report); rejected.report.assessments[0].criteria[0].final.verdict = 'rejected';
  assert.equal(outlineCriterionChecks(trace, c[0], [rejected], 1).independent, 'unmet');
  const inconclusive = structuredClone(report); inconclusive.report.assessments[0].criteria[0].final.verdict = 'inconclusive';
  assert.equal(outlineCriterionChecks(trace, c[0], [inconclusive], 1).independent, 'unknown');
  assert.equal(criterionStatus(trace, c[0], [report, rejected], 2).independent, '! 结论不一');
  assert.equal(criterionStatus(trace, c[1], [report], 1).independent, '? 未覆盖');
  const withSelf = structuredClone(trace); withSelf.submission.claims[0].criteria[0].self_verification = { status: 'satisfied' };
  assert.equal(criterionStatus(withSelf, c[0], [report], 1).self, '✓ 满足');
  assert.match(targetStatus(withSelf, 'goal', 'g', [report], 1), /自验满足 ✓ 1\/1  独立验证满足 ✓ 1\/1/);
  assert.deepEqual(outlineCriterionChecks(trace, c[0], [report], 1), { self: 'pending', independent: 'met' });
  assert.deepEqual(outlineCriterionChecks(trace, c[0], [report], 2), { self: 'pending', independent: 'pending' });
  assert.deepEqual(outlineCriterionChecks(trace, c[0], [report, rejected], 2), { self: 'pending', independent: 'conflict' });
  assert.deepEqual(outlineCriterionChecks(trace, c[1], [report], 1), { self: 'pending', independent: 'unknown' });
  assert.deepEqual(outlineCriterionChecks(withSelf, c[0], [report], 1), { self: 'met', independent: 'met' });
  assert.deepEqual(outlineTargetChecks(trace, 'goal', 'g', [report], 1), { self: 'pending', independent: 'met', counts: { self: '0/1', independent: '1/1' } });
  assert.deepEqual(outlineTargetChecks(withSelf, 'goal', 'g', [report], 1), { self: 'met', independent: 'met', counts: { self: '1/1', independent: '1/1' } });
  assert.deepEqual(outlineTargetChecks(trace, 'goal', 'g', [], 0), { self: 'pending', independent: 'pending', counts: { self: '0/1', independent: '0/1' } });
  const notMet = structuredClone(withSelf); notMet.submission.claims[0].criteria[0].self_verification.status = 'not_satisfied';
  assert.equal(outlineCriterionChecks(notMet, c[0], [report], 1).self, 'unmet');
  const partial = structuredClone(withSelf); partial.submission.claims[0].criteria[0].self_verification.status = 'partially_satisfied';
  assert.equal(outlineCriterionChecks(partial, c[0], [report], 1).self, 'partial');
  const unknown = structuredClone(withSelf); unknown.submission.claims[0].criteria[0].self_verification.status = 'inconclusive';
  assert.equal(outlineCriterionChecks(unknown, c[0], [report], 1).self, 'unknown');
});
test('diff requires exact content digest and keeps unlocated unit, ambiguity is not guessed', () => {
  const hunk = '@@ -1 +1 @@\n-old\n+new\n';
  const source = { ...trace, artifact: { patch_state: 'inline', patch: `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n${hunk}`, file_manifest: [{ path_bytes: 'YS50cw==' }] }, change_index: { change_units: [{ change_unit_id: 'unit', path_bytes: 'YS50cw==', content_digest: `sha256:${createHash('sha256').update(hunk).digest('hex')}` }] } };
  assert.equal(blocks(source)[0].content, hunk);
  const invalid = { ...source, change_index: { change_units: [{ ...source.change_index.change_units[0], content_digest: 'wrong' }] } }; assert.match(blocks(invalid)[0].unavailable!, /不匹配/);
  const associated = { ...trace, submission: { change_rationales: [{ change_refs: ['unit'], target_refs: [{ type: 'criterion', id: 'ac' }] }] } };
  assert.equal(linkedCriteria(associated, blocks(associated)[0]).length, 0);
});
test('recent issues uses facts rather than browsing, operation ID is UUIDv7', () => {
  const resources = [{ resource_id: 'a', last_activity: { occurred_at: '2026-01-01' } }, { resource_id: 'b', last_activity: { occurred_at: '2026-02-01' } }];
  assert.equal(recentIssues(resources)[0].resource_id, 'b'); assert.equal(resources[0].resource_id, 'a');
  assert.match(operationId(), /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
test('recent activity sorts timestamps at nanosecond precision and breaks equal-time ties by ID', () => {
  const rows = [
    ['z', '2026-01-01T00:00:00.1Z'],
    ['a', '2026-01-01T00:00:00.100000000Z'],
    ['n', '2026-01-01T00:00:00.100000001Z'],
    ['b', '2026-01-01T00:00:00.11Z'],
  ].map(([resource_id, occurred_at]) => ({ resource_id, last_activity: { occurred_at } }));
  assert.deepEqual(recentIssues(rows).map(row => row.resource_id), ['b', 'n', 'a', 'z']);
});
test('report session sorts equivalent timestamps and nanoseconds before loading bodies', async () => {
  const many = { ...trace, verification_set: { ...set, count: 4 } };
  const dates: Record<string, string> = { a: '2026-01-01T00:00:00.1Z', z: '2026-01-01T00:00:00.100000000Z', n: '2026-01-01T00:00:00.100000001Z', b: '2026-01-01T00:00:00.11Z' };
  const r = { async query(method: Method, args: string[] = []) {
    if (method === 'verifications') return { candidate_id: 'c', verification_set: many.verification_set, verifications: Object.entries(dates).map(([verification_id, created_at]) => ({ ...entry, verification_id, created_at })) };
    return { ...report, verification_id: args[0], created_at: dates[args[0]] };
  } };
  const session = new ReviewSession(many, r);
  while (session.hasMore) await session.next();
  assert.deepEqual(session.reports.map(row => row.verification_id), ['b', 'n', 'z', 'a']);
});
test('report session loads newest first across pages, bodies remain lazy', async () => {
  const calls: string[] = [];
  const many = { ...trace, verification_set: { ...set, count: 2 } };
  const r = { async query(method: Method, args: string[] = []) {
    calls.push(method + ':' + args.join(','));
    if (method === 'verifications') return { candidate_id: 'c', verification_set: many.verification_set, verifications: [{ ...entry, verification_id: args.includes('next') ? 'new' : 'old', created_at: args.includes('next') ? '2026-09-16' : '2026-09-15' }], ...(!args.includes('next') ? { next_cursor: 'next' } : {}) };
    return { ...report, verification_id: args[0], created_at: args[0] === 'new' ? '2026-09-16' : '2026-09-15' };
  } };
  const session = new ReviewSession(many, r); await session.next();
  assert.equal(session.reports[0].verification_id, 'new'); assert.equal(calls.filter(c => c.startsWith('verification:')).length, 1); assert.equal(session.hasMore, true);
  await session.next(); assert.equal(session.reports[1].verification_id, 'old');
});
test('set changes and report tree mismatch are errors, never evidence against business behavior', async () => {
  const changed = new ReviewSession(trace, { async query() { return { candidate_id: 'c', verification_set: { ...set, digest: 'different' } }; } });
  await assert.rejects(changed.next(), /报告集合已变化/); assert.equal(changed.reports.length, 0);
  const mismatch = new ReviewSession(trace, { async query(method) { return method === 'verifications' ? { candidate_id: 'c', verification_set: set, verifications: [entry] } : { ...report, report: { ...report.report, result_tree_oid: 'other' } }; } });
  await assert.rejects(mismatch.next(), /不匹配/);
});
test('report body budget rejects overflow without silently dropping loaded evidence', async () => {
  const session = new ReviewSession(trace, { async query(m) { return m === 'verifications' ? { candidate_id: 'c', verification_set: set, verifications: [entry] } : { ...report, extra: 'x'.repeat(16 * 1024 * 1024) }; } });
  await assert.rejects(session.next(), /16 MiB/); assert.equal(session.reports.length, 0); assert.equal(session.hasMore, true);
});
test('default Issue entry opens sole candidate, all criteria remain present; menu and input consume keys', async () => {
  const view = render(<ReviewApp initialSearchKind="issues" reader={reader} context={context} onExit={() => assert.fail('input q must not quit')} width={100} height={28} />);
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /交付概览/);
    assert.match(view.lastFrame()!, /拒绝非法参数/); assert.match(view.lastFrame()!, /兼容原调用/);
    view.stdin.write('jj'); await pause(); view.stdin.write('/'); await pause(); view.stdin.write('q'); await pause(); assert.match(view.lastFrame()!, /q▏/);
    view.stdin.write('\u001b'); await pause(); view.stdin.write(':'); await wait(view, /操作（可搜索）/);
    view.stdin.write('审阅全部'); await pause();
    assert.doesNotMatch(view.lastFrame()!, /审阅全部代码变更/);
    view.stdin.write('\u001b'); await pause(); view.stdin.write('\t'); await wait(view, /范围：/);
    assert.match(view.lastFrame()!, /定位|固定工件|没有关联变更/);
    view.stdin.write('\u001b'); await wait(view, /固定契约/);
  } finally { view.unmount(); view.cleanup(); }
});
test('selection requires explicit confirmation and exact version; cancelling never writes', async () => {
  const writes: Data[] = [];
  const writer = { async selectCandidate(request: any) { writes.push(request); return { issue: { id: 'i', version: 1 }, selection: { version: 1, state: 'selected', candidate_id: 'c' } }; } };
  const view = render(<ReviewApp initialSearchKind="issues" reader={reader} writer={writer} context={context} onExit={() => {}} width={100} height={30} />);
  const menu = async () => { view.stdin.write(':'); await pause(); view.stdin.write('人工选择'); await pause(); view.stdin.write('\r'); await wait(view, /填写选择理由/); };
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /交付概览/); await pause(150);
    await menu(); view.stdin.write('reviewed'); await pause(); view.stdin.write('\r'); await wait(view, /确认人工选择/); assert.equal(writes.length, 0);
    view.stdin.write('\u001b'); await pause(); assert.equal(writes.length, 0);
    await menu(); view.stdin.write('reviewed'); await pause(); view.stdin.write('\r'); await pause(); view.stdin.write('\r'); await wait(view, /人工选择已记录/);
    assert.equal(writes.length, 1); assert.equal(writes[0].expectedVersion, 0); assert.equal(writes[0].version, 1); assert.equal(writes[0].candidate, 'c');
  } finally { view.unmount(); view.cleanup(); }
});
test('uncertain Selection retry reuses the exact operation and never retries automatically', async () => {
  const writes: any[] = [];
  const writer = { async selectCandidate(request: any) { writes.push(request); if (writes.length === 1) throw new Error('TIMEOUT'); return { issue: { id: 'i', version: 1 }, selection: { version: 1, state: 'selected', candidate_id: 'c' } }; } };
  const view = render(<ReviewApp initialSearchKind="issues" reader={reader} writer={writer} context={context} onExit={() => {}} width={100} height={30} />);
  const menu = async (s: string) => { view.stdin.write(':'); await pause(); view.stdin.write(s); await pause(); view.stdin.write('\r'); await pause(); };
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /交付概览/); await pause();
    await menu('人工选择'); await wait(view, /填写选择理由/); view.stdin.write('reason'); await pause(); view.stdin.write('\r'); await wait(view, /确认人工选择/); view.stdin.write('\r'); await wait(view, /选择未确认/);
    await pause(200); assert.equal(writes.length, 1);
    await menu('重试上次选择'); await wait(view, /确认人工选择/); assert.equal(writes.length, 1); view.stdin.write('\r'); await wait(view, /人工选择已记录/);
    assert.deepEqual(writes[0], writes[1]);
  } finally { view.unmount(); view.cleanup(); }
});
test('late candidate response cannot reopen a page after Esc', async () => {
  let release: ((d: Data) => void) | undefined;
  const delayed = { async query(m: Method, a?: string[]) { if (m === 'review') return new Promise<Data>(r => { release = r; }); return reader.query(m, a); } };
  const view = render(<ReviewApp initialSearchKind="issues" reader={delayed} context={context} onExit={() => {}} width={100} height={24} />);
  try { await wait(view, /输入校验/); view.stdin.write('\r'); for (let i = 0; i < 20 && !release; i++) await pause(); view.stdin.write('\u001b'); await pause(); release?.({ trace }); await pause(); assert.doesNotMatch(view.lastFrame()!, /交付概览/); }
  finally { view.unmount(); view.cleanup(); }
});

test('code purpose stays fixed across blocks, shared borders survive actual terminal widths and return restores position', async () => {
  const base = JSON.parse(JSON.stringify(trace));
  base.contract.issue.goals[0].criteria[0] = { id: 'one', statement: '核查目标一' };
  base.contract.issue.constraints[0].criteria[0] = { id: 'two', statement: '关联约束二' };
  const paths = ['中文文件.ts', 'other.ts'];
  const hunks = ['@@ -1 +1 @@\n-old\n+\t中文结果\n', '@@ -1 +1 @@\n-x\n+y\n'];
  base.artifact = { result_tree_oid: 'tree', patch_state: 'inline', file_manifest: paths.map(p => ({ path_bytes: Buffer.from(p).toString('base64') })), patch: paths.map((p, i) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${hunks[i]}`).join('') };
  base.change_index.change_units = paths.map((p, i) => ({ change_unit_id: `unit${i}`, display_path: p, path_bytes: Buffer.from(p).toString('base64'), kind: 'hunk', old_range: { start: 1, lines: 1 }, new_range: { start: 1, lines: 1 }, content_digest: `sha256:${createHash('sha256').update(hunks[i]).digest('hex')}` }));
  base.submission.change_rationales = paths.map((_, i) => ({ change_refs: [`unit${i}`], target_refs: [{ type: 'criterion', id: i === 0 ? 'two' : 'one' }], rationale: '具体修改理由' }));
  const r = { async query(m: Method, a?: string[]) { return m === 'review' ? { trace: base } : reader.query(m, a); } };
  const view = render(<ReviewApp initialSearchKind="issues" reader={r} context={context} onExit={() => {}} height={28} />);
  const menu = async (value: string) => { view.stdin.write(':'); await pause(); view.stdin.write(value); await pause(); view.stdin.write('\r'); await pause(); };
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /交付概览/); await pause();
    view.stdin.write('\u001b[B'); await pause(); view.stdin.write('\u001b[B'); await pause();
    view.stdin.write('\r'); await wait(view, /下一步：按 Enter 审阅关联代码 diff（1 处）/);
    view.stdin.write('\r'); await wait(view, /范围：标准 G1.1 · 核查目标一/);
    const codeFrame = view.lastFrame()!.split('\n');
    const scopeLine = codeFrame.findIndex(line => line.includes('范围：标准 G1.1'));
    const operationLine = codeFrame.findIndex(line => line.includes('操作 │ Tab 切换页签'));
    const frameTop = codeFrame.findIndex(line => line.startsWith('┌'));
    const frameBottom = codeFrame.findIndex(line => line.startsWith('└'));
    const locationLine = codeFrame.findIndex(line => line.includes('目录 1/1'));
    assert.ok(scopeLine < operationLine && operationLine < frameTop && frameTop < frameBottom && frameBottom < locationLine);
    assert.equal(codeFrame.filter(line => line.includes('操作 │')).length, 1);
    await menu('当前块完整关联依据'); await wait(view, /关联要求与标准验证/);
    assert.match(view.lastFrame()!, /具体修改理由/);
    view.stdin.write('\u001b'); await wait(view, /关联依据 · 摘要/);
    view.stdin.write('\t'); await wait(view, /下一步：按 Enter 审阅关联代码 diff（1 处）/);
    view.stdin.write('\t'); await wait(view, /范围：标准 G1.1 · 核查目标一/);
    view.stdin.write('\u001b'); await wait(view, /下一步：按 Enter 审阅关联代码 diff（1 处）/);
    view.stdin.write('\u001b'); await wait(view, /目录 3\/5 · 焦点：目录/);
    view.stdin.write('\r'); await wait(view, /标准 G1.1/);
    view.stdin.write('\r'); await wait(view, /范围：标准 G1.1 · 核查目标一/);
    view.stdin.write('['); await wait(view, /other.ts/); assert.doesNotMatch(view.lastFrame()!, /中文文件/);
    assert.match(view.lastFrame()!, /范围：标准 G1.1 · 核查目标一/);
    await menu('当前块关联标准'); await wait(view, /核查目标一/); view.stdin.write('\u001b'); await pause();
    for (const width of [236, 160, 110, 65, 100]) {
      // Keep Ink's actual stdout width and the app's measured width in agreement.
      Object.defineProperty(view.stdout, 'columns', { configurable: true, value: width }); view.stdout.emit('resize'); await pause(150);
      const frame = view.lastFrame()!;
      assert.ok(frame.split('\n').every(line => stringWidth(line) <= width), `overflow at ${width}`);
      const lines = frame.split('\n'); const top = lines.findIndex(l => l.startsWith('┌')); const bottom = lines.findIndex(l => l.startsWith('└'));
      assert.ok(top >= 0 && bottom > top);
      for (const line of lines.slice(top + 1, bottom)) { assert.ok(line.startsWith('│') && line.endsWith('│'), `broken outer frame at ${width}: ${line}`); assert.equal(stringWidth(line), width); }
      if (width >= 100) assert.match(frame, /关联依据 · 摘要/);
      if (width === 236) {
        const columns = stripAnsi(lines.find(line => line.includes('关联依据 · 摘要'))!).split('│');
        assert.ok(stringWidth(columns[2]!) >= 100, 'diff should retain a useful width');
        assert.ok(stringWidth(columns[3]!) >= 75, 'wide terminal should give evidence room to breathe');
      }
      if (width === 65) { assert.ok(lines.findIndex(line => line.includes('Tab 切换页签')) < top); view.stdin.write('\u001b[C'); await wait(view, /焦点：关联依据/); view.stdin.write('\u001b[D'); await wait(view, /焦点：正文/); }
    }
    await menu('选择变更单元'); view.stdin.write('j'); await pause(); // menu filtering consumes j, never underlying navigation
    view.stdin.write('\u001b'); await pause();
    view.stdin.write('\u001b'); await wait(view, /固定契约/); assert.match(view.lastFrame()!, /核查目标一/);
  } finally { view.unmount(); view.cleanup(); }
});

test('criterion reading order groups author and verifier and hides long evidence and keeps unknown, uncovered and conflicting reports distinct', () => {
  const source = structuredClone(trace);
  source.submission.claims[0].criteria[0].evidence = [{ type: 'command', command: 'test-command', exit_code: 0, output: 'LONG-OUTPUT'.repeat(1000) }] as never[];
  const c = criteria(source)[0];
  const summary = criterionText(source, c, [report], 1);
  assert.ok(summary.indexOf('要求') < summary.indexOf('作者交付') && summary.indexOf('作者交付') < summary.indexOf('独立复核'));
  assert.match(summary, /最终判断：满足/);
  assert.doesNotMatch(summary, /LONG-OUTPUT|test-command/);
  assert.match(summary, /作者提供的证据：1 条/);
  assert.match(criterionText(source, c, [], 1), /报告正文尚未加载/);
  assert.match(criterionText(source, c, [], 0), /未提交独立验证；不代表失败/);
  const opposite = structuredClone(report);
  opposite.verification_id = 'rejected-report';
  opposite.report.assessments[0].criteria[0].final.verdict = 'rejected';
  assert.match(criterionText(source, c, [report], 2, [report, opposite]), /\[分歧\]/);
});

test('criterion evidence and identifiers remain available through the operation menu', async () => {
  const source = structuredClone(trace);
  source.submission.claims[0].criteria[0].evidence = [{ type: 'command', command: 'test-command', exit_code: 0, output: 'evidence-output', digest: 'sha256:example' }] as never[];
  const r = { async query(m: Method, a?: string[]) { return m === 'review' ? { trace: source } : reader.query(m, a); } };
  const view = render(<ReviewApp initialSearchKind="issues" reader={r} context={context} onExit={() => {}} width={100} height={32} />);
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /交付概览/); await pause(150);
    view.stdin.write('\u001b[B'); await wait(view, /目录 2\/5/);
    view.stdin.write('\u001b[B'); await wait(view, /目录 3\/5/);
    view.stdin.write('\r'); await wait(view, /标准 G1.1/);
    assert.doesNotMatch(view.lastFrame()!, /C1.1/);
    assert.match(view.lastFrame()!, /当前无关联代码 diff；按 Enter 查看空范围/);
    view.stdin.write('\u001b[B'); await pause();
    assert.match(view.lastFrame()!, /当前无关联代码 diff；按 Enter 查看空范围/);
    assert.match(view.lastFrame()!, /独立复核/);
    assert.doesNotMatch(view.lastFrame()!, /evidence-output/);
    view.stdin.write(':'); await pause(); view.stdin.write('查看当前标准证据'); await pause(); view.stdin.write('\r'); await wait(view, /evidence-output/);
    assert.match(view.lastFrame()!, /记录退出码 0/);
    assert.match(view.lastFrame()!, /退出码不等于验收通过/);
    view.stdin.write('\u001b'); await wait(view, /标准 G1.1/);
    view.stdin.write(':'); await pause(); view.stdin.write('技术信息'); await pause(); view.stdin.write('\r'); await wait(view, /criterion_id/);
    view.stdin.write('\u001b'); await wait(view, /标准 G1.1/);
    view.stdin.write('\r'); await wait(view, /范围：标准 G1.1 · 拒绝非法参数/);
    view.stdin.write('\u001b'); await wait(view, /作者交付/);
    view.stdin.write('\r'); await wait(view, /范围：标准 G1.1 · 拒绝非法参数/);
    view.stdin.write('\u001b'); await wait(view, /作者交付/);
    view.stdin.write('\u001b'); await wait(view, /焦点：目录/);
  } finally { view.unmount(); view.cleanup(); }
});


test('goal and constraint pages show their own claims and child assessments without inventing a rollup verdict', () => {
  const goal = targetText(trace, 'goal', 'g', [report], 1);
  assert.match(goal, /目标声明/);
  assert.match(goal, /G1.1 · 拒绝非法参数/);
  assert.match(goal, /报告 v：满足/);
  assert.match(goal, /不合成目标通过结论/);
  const constraint = targetText(trace, 'constraint', 'h', [report], 1);
  assert.match(constraint, /约束声明/);
  assert.match(constraint, /C1.1 · 兼容原调用/);
  assert.match(constraint, /本报告未覆盖该标准/);
  assert.doesNotMatch(criterionText(trace, criteria(trace)[0], [report], 1), /e 查看证据|更多操作/);
});

test('parent stays readable when collapsed and focus moves between panel bars', async () => {
  const view = render(<ReviewApp initialSearchKind="issues" reader={reader} context={context} onExit={() => {}} width={110} height={32} />);
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /交付概览/); await pause(150);
    view.stdin.write('\u001b[B'); await wait(view, /目录 2\/5/);
    assert.match(view.lastFrame()!, /…0\/1\s+✓1\/1\s+▾ 目标 G1  校验参数/);
    assert.match(view.lastFrame()!, /▸ 固定契约 · 总览/);
    view.stdin.write('\r'); await wait(view, /▶ 目标 G1/);
    assert.match(view.lastFrame()!, /目标声明/);
    assert.match(view.lastFrame()!, /焦点：正文/);
    view.stdin.write('\r'); await wait(view, /范围：目标 G1/);
    view.stdin.write('\u001b'); await wait(view, /目标声明/);
    view.stdin.write('\u001b'); await wait(view, /固定契约 · 总览/);
    view.stdin.write(' '); await pause();
    assert.doesNotMatch(view.lastFrame()!, /G1.1 拒绝非法参数/);
  } finally { view.unmount(); view.cleanup(); }
});
test('134-column review uses a full-width outline with complete titles and criterion states', async () => {
  const longTrace = structuredClone(trace);
  longTrace.contract.issue.goals[0].statement = 'Present the full Grounds identity on sufficiently large root homes while preserving every descriptive word in this deliberately long goal heading';
  longTrace.contract.issue.goals[0].criteria[0].statement = 'The supporting copy must keep the approved value statement and remain readable without opening detail even when this criterion heading is long';
  const source = { async query(method: Method, args: string[] = []) { return method === 'review' ? { trace: longTrace } : reader.query(method, args); } };
  const view = render(<ReviewApp initialSearchKind="issues" reader={source} context={context} onExit={() => {}} width={134} height={52} />);
  const assertOperationAtTop = (frame: string) => {
    const lines = stripAnsi(frame).split('\n');
    const issue = lines.findIndex(line => line.startsWith('Issue v'));
    const tabs = lines.findIndex(line => line.includes('固定契约 · 总览') && line.includes('代码变更'));
    const operation = lines.findIndex(line => line.includes('操作 │'));
    const frameTop = lines.findIndex(line => line.startsWith('┌'));
    const frameBottom = lines.findIndex(line => line.startsWith('└'));
    const location = lines.findIndex(line => line.startsWith('目录 '));
    assert.ok(operation >= 0 && operation < frameTop && frameTop < frameBottom && frameBottom < location);
    assert.equal(tabs, issue + 2);
    assert.equal(operation, tabs + 2);
    assert.equal(lines[issue + 1]!.trim(), '');
    assert.equal(lines[tabs + 1]!.trim(), '');
    assert.ok(lines.slice(operation, frameTop).every(line => stringWidth(line) <= 112), 'wide prompts should stay within the readable hint width');
    assert.equal(lines.filter(line => line.includes('操作 │')).length, 1);
  };
  try {
    await wait(view, /输入校验/); view.stdin.write('\r');
    await wait(view, /固定契约 · 总览/);
    await wait(view, /自验\s+独立验证/);
    if (process.env.FORCE_COLOR && process.env.NO_COLOR === undefined) {
      assert.match(view.lastFrame()!, /\u001b\[32m[^\u001b]*✓/);
      assert.match(view.lastFrame()!, /\u001b\[90m[^\u001b]*…/);
    }
    const frame = stripAnsi(view.lastFrame()!);
    assertOperationAtTop(frame);
    assert.doesNotMatch(frame, /✅|❌/);
    assert.match(frame, /目标 1 · 约束 1 · 标准 2/);
    assert.match(frame, /›\s+交付概览/);
    assert.match(frame, /▾ 目标 G1/);
    assert.match(frame, /long goal heading/);
    assert.match(frame, /criterion heading is long/);
    assert.match(frame, /…0\/1\s+✓1\/1\s+▾ 目标 G1/);
    assert.match(frame, /…\s+✓\s+G1\.1  The supporting copy/);
    const lines = frame.split('\n');
    const header = lines.find(line => line.includes('自验') && line.includes('独立验证'))!;
    const goal = lines.find(line => line.includes('▾ 目标 G1'))!;
    const criterion = lines.find(line => line.includes('G1.1  The supporting copy'))!;
    assert.equal(stringWidth(header.slice(0, header.indexOf('自验'))) + Math.floor((6 - stringWidth('…0/1')) / 2), stringWidth(goal.slice(0, goal.indexOf('…0/1'))));
    assert.equal(stringWidth(header.slice(0, header.indexOf('独立验证'))) + Math.floor((10 - stringWidth('✓')) / 2), stringWidth(criterion.slice(0, criterion.indexOf('✓'))));
    assert.equal(lines.filter(line => line.includes('自验') && line.includes('独立验证')).length, 1);
    view.stdin.write('\u001b[B'); await wait(view, /目录 2\/5/);
    view.stdin.write('\u001b[B'); await wait(view, /目录 3\/5/);
    view.stdin.write('\r'); await wait(view, /标准 G1.1/);
    assertOperationAtTop(view.lastFrame()!);
    assert.match(view.lastFrame()!, /▸ 固定契约 · 总览/);
    view.stdin.write('\u001b'); await wait(view, /固定契约 · 总览/);
  } finally { view.unmount(); view.cleanup(); }
});
test('narrow review outline keeps both status columns aligned without breaking the frame or detail return', async () => {
  const view = render(<ReviewApp initialSearchKind="issues" reader={reader} context={context} onExit={() => {}} width={65} height={22} />);
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /固定契约 · 总览/);
    view.stdin.write('\u001b[B'); await wait(view, /目录 2\/5/);
    view.stdin.write('\u001b[B'); await wait(view, /目录 3\/5/);
    const frame = view.lastFrame()!;
    assert.ok(frame.split('\n').every(line => stringWidth(line) <= 65));
    assert.match(frame, /G1\.1  拒绝非法参数/);
    assert.match(frame, /自验\s+独立验证/);
    assert.match(frame, /…\s+✓\s+G1\.1  拒绝非法参数/);
    view.stdin.write('\r'); await wait(view, /标准 G1.1/);
    assert.match(view.lastFrame()!, /当前无关联代码 diff；按 Enter 查看空范围/);
    assert.ok(view.lastFrame()!.split('\n').every(line => stringWidth(line) <= 65));
    view.stdin.write('\u001b'); await wait(view, /固定契约 · 总览/);
  } finally { view.unmount(); view.cleanup(); }
});
test('40-column review still shows both status headers and complete criterion titles', async () => {
  const view = render(<ReviewApp initialSearchKind="issues" reader={reader} context={context} onExit={() => {}} width={40} height={24} />);
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /自验\s+独立验证/);
    const frame = view.lastFrame()!;
    assert.match(frame, /…0\/1\s+✓1\/1\s+▾ 目标 G1/);
    assert.match(frame, /…\s+✓\s+G1\.1/);
    assert.match(frame, /拒绝非法参数/);
    assert.ok(frame.split('\n').every(line => stringWidth(line) <= 40));
  } finally { view.unmount(); view.cleanup(); }
});
test('wide criterion prose wraps at a readable measure while its panel remains full width', async () => {
  const sourceTrace = structuredClone(trace);
  sourceTrace.contract.issue.goals[0].criteria[0].statement = 'readable '.repeat(38).trim();
  const source = { async query(method: Method, args: string[] = []) { return method === 'review' ? { trace: sourceTrace } : reader.query(method, args); } };
  const view = render(<ReviewApp initialSearchKind="issues" reader={source} context={context} onExit={() => {}} width={180} height={44} />);
  try {
    await wait(view, /输入校验/);
    view.stdin.write('\r'); await wait(view, /固定契约 · 总览/);
    view.stdin.write('\u001b[B'); await wait(view, /目录 2\/5/);
    view.stdin.write('\u001b[B'); await wait(view, /目录 3\/5/);
    view.stdin.write('\r'); await wait(view, /标准 G1.1/);
    const lines = stripAnsi(view.lastFrame()!).split('\n');
    const prose = lines.filter(line => line.includes('readable'));
    assert.ok(prose.length >= 3, 'long prose should wrap into several lines');
    assert.ok(prose.every(line => stringWidth(line.trim()) <= 104), 'prose should stay within the readable width');
    assert.ok(lines.some(line => line.startsWith('┌') && stringWidth(line) === 180), 'the panel should still use the full terminal');
  } finally { view.unmount(); view.cleanup(); }
});
test('minimum terminal width keeps both review tabs visible', async () => {
  const view = render(<ReviewApp initialSearchKind="issues" reader={reader} context={context} onExit={() => {}} width={40} height={10} />);
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /▸ 契约.*代码 1/);
    assert.ok(view.lastFrame()!.split('\n').every(line => stringWidth(line) <= 40));
    view.stdin.write('\t'); await wait(view, /范围：全部/);
    assert.match(view.lastFrame()!, /契约.*▸ 代码 1/);
    assert.ok(view.lastFrame()!.split('\n').every(line => stringWidth(line) <= 40));
    view.stdin.write('\t'); await wait(view, /▸ 契约.*代码 1/);
  } finally { view.unmount(); view.cleanup(); }
});
test('top-level contract and code tabs replace the trailing code row and restore the selected contract', async () => {
  const view = render(<ReviewApp initialSearchKind="issues" reader={reader} context={context} onExit={() => {}} width={110} height={32} />);
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /▸ 固定契约 · 总览.*代码变更 · 1 处/);
    assert.doesNotMatch(view.lastFrame()!, /整体发现 \/ 未关联证据/);
    assert.match(view.lastFrame()!, /目录 1\/5/);
    assert.doesNotMatch(view.lastFrame()!, /Enter 看全部变更/);
    assert.match(view.lastFrame()!, /操作 │ Tab 切换页签/);
    for (const shortcut of ['Enter 查看详情', 'PgUp/PgDn 翻页', ': 更多操作', '? 帮助', 'Esc 返回', 'q 退出']) assert.ok(view.lastFrame()!.includes(shortcut), shortcut);
    for (const removed of ['Shift+Tab', '1/2 直达', 'Enter/→', 'd 关联代码', 'v 复核详情', 'e 证据', 'i 标识', 'r 刷新']) assert.ok(!view.lastFrame()!.includes(removed), removed);
    view.stdin.write('2'); await pause();
    view.stdin.write('\u001b[Z'); await pause();
    assert.match(view.lastFrame()!, /目录 1\/5 · 焦点：目录/);
    view.stdin.write(':'); await wait(view, /操作（可搜索）/);
    for (const shortcut of ['输入筛选', '↑↓ 选择', 'Backspace 删除', 'Enter 执行', 'Esc 关闭']) assert.ok(view.lastFrame()!.includes(shortcut), shortcut);
    view.stdin.write('原始验证报告'); await pause(); view.stdin.write('\r'); await wait(view, /报告原文/);
    assert.match(view.lastFrame()!, /verification_id/);
    view.stdin.write('\u001b'); await wait(view, /目录 1\/5 · 焦点：目录/);
    for (let index = 2; index <= 3; index++) { view.stdin.write('\u001b[B'); await wait(view, new RegExp(`目录 ${index}/5`)); }
    view.stdin.write('d'); await pause();
    view.stdin.write('\u001b[C'); await pause();
    assert.match(view.lastFrame()!, /目录 3\/5 · 焦点：目录/);
    view.stdin.write('\r'); await wait(view, /标准 G1.1/);
    view.stdin.write('d'); await pause();
    assert.match(view.lastFrame()!, /焦点：正文/);
    view.stdin.write('\u001b'); await wait(view, /目录 3\/5 · 焦点：目录/);
    view.stdin.write('\t'); await wait(view, /范围：全部/);
    assert.match(view.lastFrame()!, /固定契约 · 总览.*▸ 代码变更 · 1 处/);
    assert.match(view.lastFrame()!, /操作 │ Tab 切换页签/);
    for (const shortcut of ['s 切换范围', '[ / ] 切变更', '←/→ 切面板', '/ 搜索', '? 帮助', 'Esc 返回']) assert.ok(view.lastFrame()!.includes(shortcut), shortcut);
    view.stdin.write('\t'); await wait(view, /目录 3\/5/);
    assert.match(view.lastFrame()!, /▸ 固定契约 · 总览/);
    view.stdin.write('\t'); await wait(view, /范围：全部/);
    view.stdin.write('\t'); await wait(view, /目录 3\/5/);
  } finally { view.unmount(); view.cleanup(); }
});


test('report summary shows only final reasoning and readable identity while details preserve each stage', () => {
  const r = { ...report, attribution: { kind: 'agent', agent_id: 'agent-internal', display_name: '独立验证者' } };
  const c = criteria(trace)[0];
  const summary = criterionText(trace, c, [r], 1);
  assert.match(summary, /验证者：独立验证者/);
  assert.match(summary, /最终结论/);
  assert.doesNotMatch(summary, /agent_id|独立观察|corroborated|核对作者/);
  assert.equal((summary.match(/最终判断/g) ?? []).length, 1);
  assert.match(reportDetail(r, c, 'independent'), /独立观察/);
  assert.match(reportDetail(r, c, 'reconciliation'), /作者声明得到验证支持/);
  assert.match(reportDetail(r, c, 'reconciliation'), /核对作者/);
  assert.match(reportDetail(r, c, 'metadata'), /agent-internal/);
});

test('verification detail menus open the selected stage and Esc returns to the criterion', async () => {
  const view = render(<ReviewApp initialSearchKind="issues" reader={reader} context={context} onExit={() => {}} width={110} height={36} />);
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /交付概览/); await pause(150);
    view.stdin.write('\u001b[B'); await wait(view, /目录 2\/5/);
    view.stdin.write('\u001b[B'); await wait(view, /目录 3\/5/);
    view.stdin.write('\r'); await wait(view, /标准 G1.1/);
    view.stdin.write(':'); await pause(); view.stdin.write('独立复核详情'); await pause(); view.stdin.write('\r'); await wait(view, /选择验证报告/);
    view.stdin.write('\r'); await wait(view, /独立检查过程与证据/);
    view.stdin.write('\r'); await wait(view, /独立观察/);
    view.stdin.write('\u001b'); await wait(view, /标准 G1.1/);
    assert.match(view.lastFrame()!, /作者交付/);
  } finally { view.unmount(); view.cleanup(); }
});

test('goal entry, pending scope and full file overlay return preserve the selected scope and unit', async () => {
  const source = structuredClone(trace) as any;
  source.contract.issue.goals[0].criteria[0].id = 'only-goal';
  source.change_index.change_units = [
    { change_unit_id: 'first-unit', path_bytes: 'YQ==', display_path: 'same.ts', kind: 'hunk' },
    { change_unit_id: 'second-unit', path_bytes: 'YQ==', display_path: 'same.ts', kind: 'file' },
  ];
  source.submission.change_rationales = [{ change_refs: ['first-unit'], target_refs: [{ type: 'criterion', id: 'only-goal' }], rationale: '目标理由', relation: 'implements' }];
  const r = { async query(m: Method, a?: string[]) { return m === 'review' ? { trace: source } : reader.query(m, a); } };
  const view = render(<ReviewApp initialSearchKind="issues" reader={r} context={context} onExit={() => {}} width={160} height={30} />);
  const menu = async (label: string) => { view.stdin.write(':'); await pause(); view.stdin.write(label); await pause(); view.stdin.write('\r'); await pause(); };
  try {
    await wait(view, /输入校验/); view.stdin.write('\r'); await wait(view, /交付概览/); await pause(150);
    view.stdin.write('\u001b[B'); await wait(view, /目录 2\/5/);
    view.stdin.write('\r'); await wait(view, /目标声明/);
    view.stdin.write('\r'); await wait(view, /范围：目标 G1/);
    assert.match(view.lastFrame()!, /first-unit/); assert.doesNotMatch(view.lastFrame()!, /second-unit/);
    view.stdin.write(']'); await pause(); assert.doesNotMatch(view.lastFrame()!, /second-unit/);
    await menu('完整文件'); await wait(view, /不显示当前块依据/);
    view.stdin.write('\u001b'); await pause(180); await wait(view, /范围：目标 G1/);
    view.stdin.write('s'); await wait(view, /审阅范围/);
    view.stdin.write('关联待核查'); await pause(); view.stdin.write('\r'); await wait(view, /second-unit/);
    view.stdin.write('\u001b'); await pause(180); await wait(view, /范围：目标 G1/);
    assert.match(view.lastFrame()!, /first-unit/);
  } finally { view.unmount(); view.cleanup(); }
});

test('home searches as you type, treats shortcut letters as text and restores query on return', async () => {
  const view = render(<ReviewApp initialSearchKind="issues" reader={reader} context={context} onExit={() => { throw new Error('search must not exit'); }} width={110} height={32} />);
  try {
    await wait(view, /找到任务，开始审阅/); await wait(view, /输入校验/); await pause(150);
    view.stdin.write('?'); await wait(view, /当前页面全部操作/);
    assert.match(view.lastFrame()!, /Ctrl\+T 切换需求\/任务/);
    view.stdin.write('\u001b'); await wait(view, /找到任务，开始审阅/);
    view.stdin.write('qr'); await wait(view, /没有匹配结果/);
    view.stdin.write('\u001b'); await pause(180);
    view.stdin.write('输入'); await wait(view, /匹配 1 项/);
    view.stdin.write('\r'); await wait(view, /交付概览/); await pause(150);
    view.stdin.write('\u001b'); await pause(180); await wait(view, /匹配 1 项/);
    assert.match(view.lastFrame()!, /输入/);
  } finally { view.unmount(); view.cleanup(); }
});

test('Requirement and linked Issue tabs keep context; Issue detail precedes the sole Candidate', async () => {
  const calls: string[] = [];
  let extra = false;
  const r = { async query(method: Method, args: string[] = []): Promise<Data> {
    calls.push(method + ':' + args.join(','));
    if (method === 'requirements') return { resources: [{ resource_id: 'req', label: '需求入口', version: 1 }] };
    if (method === 'requirement') return { requirement: { id: 'req', version: 1, summary: '需求入口', context: '真实需求背景', outcomes: ['预期成果原文'] }, issues: args.includes('next') ? [{ issue: { id: 'other', version: 2, summary: '历史绑定', requirement: { id: 'req', version: 2 } }, bound_to_selected_version: false }, ...(extra ? [{ issue: { id: 'new', version: 1, summary: '新增关联', requirement: { id: 'req', version: 1 } }, bound_to_selected_version: true }] : [])] : [{ issue: { id: 'i', version: 1, summary: '输入校验', requirement: { id: 'req', version: 1 } }, bound_to_selected_version: true }], ...(args.includes('next') ? {} : { issues_next_cursor: 'next', issues_omitted: true }) };
    if (method === 'issue') return { issue: { ...issue, requirement: { id: 'req', version: 1 }, context: '任务背景原文' }, requirement: { id: 'req', version: 1 }, repository: { canonical_remote: 'ssh://example/repo' }, baseline: { git_oid: 'sha1:abc' }, board: { status: 'candidates_available', candidate_count: 1, open_dev_run_count: 0, selection: { state: 'unselected', version: 0 } } };
    if (method === 'candidates') return { resources: [{ resource_id: 'c', label: '方案 A' }] };
    return reader.query(method, args);
  } };
  const view = render(<ReviewApp reader={r} context={context} onExit={() => {}} width={110} height={32} />);
  try {
    await wait(view, /需求入口/); view.stdin.write('需求'); await pause(150);
    view.stdin.write('\r'); await wait(view, /需求原文/);
    assert.match(view.lastFrame()!, /真实需求背景/);
    assert.doesNotMatch(view.lastFrame()!, /关联 Issue ·|输入校验/);
    view.stdin.write('\t'); await wait(view, /关联 Issue · 2 个/);
    assert.match(view.lastFrame()!, /输入校验/);
    assert.match(view.lastFrame()!, /v2 · 绑定需求 v2 · 历史绑定/);
    assert.ok(calls.includes('requirement:req,--issues-cursor,next'));
    view.stdin.write('\r'); await wait(view, /Issue 详情 · v1 · 输入校验/);
    assert.match(view.lastFrame()!, /任务背景原文/);
    assert.doesNotMatch(view.lastFrame()!, /交付概览/);
    view.stdin.write('\t'); await wait(view, /真实需求背景/);
    view.stdin.write('\t'); await wait(view, /Issue 详情 · v1 · 输入校验/);
    view.stdin.write('\r'); await wait(view, /交付概览/);
    view.stdin.write('\u001b'); await wait(view, /Issue 详情 · v1 · 输入校验/);
    extra = true;
    view.stdin.write('\x12'); await wait(view, /关联 Issue：新增 1、移除 0、更新 0/);
    assert.match(view.lastFrame()!, /Issue 详情 · v1 · 输入校验/);
    view.stdin.write('\u001b'); await wait(view, /关联 Issue · 3 个/);
    assert.match(view.lastFrame()!, /新增关联/);
    view.stdin.write('\u001b'); await wait(view, /真实需求背景/);
    view.stdin.write('\u001b'); await pause(180); await wait(view, /查找需求（Requirement）/);
    assert.match(view.lastFrame()!, /匹配 1 项/);
    view.stdin.write('\x14'); await wait(view, /查找交付任务（Issue）/);
  } finally { view.unmount(); view.cleanup(); }
});

test('linked Issue identity mismatch leaves the Requirement list available', async () => {
  const r = { async query(method: Method, args: string[] = []): Promise<Data> {
    if (method === 'requirements') return { resources: [{ resource_id: 'req', label: '需求入口', version: 1 }] };
    if (method === 'requirement') return { requirement: { id: 'req', version: 1, summary: '需求入口' }, issues: [{ issue: { id: 'i', version: 1, summary: '关联任务', requirement: { id: 'req', version: 1 } } }] };
    if (method === 'issue') return { issue: { ...issue, requirement: { id: 'other', version: 1 } }, board: {} };
    return reader.query(method, args);
  } };
  const view = render(<ReviewApp reader={r} context={context} onExit={() => {}} width={80} height={24} />);
  try {
    await wait(view, /需求入口/); view.stdin.write('\r'); await wait(view, /需求原文/);
    view.stdin.write('\t'); await wait(view, /关联 Issue · 1 个/);
    view.stdin.write('\r'); await wait(view, /Issue 返回身份、版本或所属需求不匹配/);
    assert.match(view.lastFrame()!, /关联任务/);
    assert.doesNotMatch(view.lastFrame()!, /Issue 详情 · v1 · 关联任务/);
  } finally { view.unmount(); view.cleanup(); }
});

test('Requirement Issue detail keeps an empty Candidate set readable and makes multiple Candidates explicit', async () => {
  let candidates: Data[] = [];
  const r = { async query(method: Method, args: string[] = []): Promise<Data> {
    if (method === 'requirements') return { resources: [{ resource_id: 'req', label: '需求入口', version: 1 }] };
    if (method === 'requirement') return { requirement: { id: 'req', version: 1, summary: '需求入口' }, issues: [{ issue: { id: 'i', version: 1, summary: '关联任务', requirement: { id: 'req', version: 1 } } }] };
    if (method === 'issue') return { issue: { ...issue, summary: '关联任务', requirement: { id: 'req', version: 1 }, context: '任务背景' }, board: { candidate_count: candidates.length, selection: { state: 'unselected' } } };
    if (method === 'candidates') return { resources: candidates };
    return reader.query(method, args);
  } };
  const view = render(<ReviewApp reader={r} context={context} onExit={() => {}} width={80} height={24} />);
  try {
    await wait(view, /需求入口/); view.stdin.write('\r'); await wait(view, /需求原文/);
    view.stdin.write('\t'); await wait(view, /关联 Issue · 1 个/);
    view.stdin.write('\r'); await wait(view, /Issue 详情 · v1 · 关联任务/);
    view.stdin.write('\r'); await wait(view, /暂无 Candidate/);
    assert.match(view.lastFrame()!, /Issue 详情 · v1 · 关联任务/);
    candidates = [{ resource_id: 'c', label: '方案 A' }, { resource_id: 'other', label: '方案 B' }];
    view.stdin.write('\r'); await wait(view, /选择该 Issue Version 的 Candidate/);
    assert.match(view.lastFrame()!, /方案 A/);
    assert.match(view.lastFrame()!, /方案 B/);
    view.stdin.write('\u001b'); await wait(view, /Issue 详情 · v1 · 关联任务/);
  } finally { view.unmount(); view.cleanup(); }
});

test('40x10 long Requirement and historical Issue stay identifiable and openable', async () => {
  const id = '01a0ebfa-92e8-7a56-bdc6-c5ed151c26f3';
  const summary = '一个稍长的需求标题用于核对完整身份是否显示';
  const issueSummary = '一个很长很长的关联任务标题使列表行尾的版本和绑定信息被截断';
  const r = { async query(method: Method): Promise<Data> {
    if (method === 'requirements') return { resources: [{ resource_id: id, label: summary, version: 12 }] };
    if (method === 'requirement') return { requirement: { id, version: 12, summary, context: '需求背景' }, issues: [{ issue: { id: 'issue', version: 5, summary: issueSummary, requirement: { id, version: 9 } }, bound_to_selected_version: false }] };
    if (method === 'issue') return { issue: { id: 'issue', version: 5, summary: issueSummary, requirement: { id, version: 9 }, context: 'Issue 背景' }, board: { candidate_count: 1 } };
    throw new Error(`unexpected query ${method}`);
  } };
  const view = render(<ReviewApp reader={r} context={context} onExit={() => {}} width={40} height={10} />);
  try {
    await wait(view, /可搜索 1 项/);
    view.stdin.write('\r'); await wait(view, /当前需求 v12/);
    assert.match(view.lastFrame()!, new RegExp(`ID ${id}`));
    view.stdin.write('\t'); await wait(view, /v5 · 绑定需求 v9/);
    assert.match(view.lastFrame()!, /Enter 详情/);
    view.stdin.write('\r'); await wait(view, /Issue 详情 · v5/);
    assert.match(view.lastFrame()!, /Enter 候选 · Esc 列表/);
    view.stdin.write('\u001b'); await wait(view, /v5 · 绑定需求 v9/);
  } finally { view.unmount(); view.cleanup(); }
});

test('Eval entry opens the exact Candidate contract and returns through the Eval action', async () => {
  let returned = 0;
  const calls: string[] = [];
  const source = { query: async (method: Method, args: string[] = []) => { calls.push(method + ':' + args.join(',')); return reader.query(method, args); } };
  const view = render(<ReviewApp initialCandidate="c" reader={source} context={context} onEval={() => returned++} onExit={() => {}} width={100} height={30} />);
  try {
    await wait(view, /交付概览/); await wait(view, /固定契约/);
    assert.ok(calls.includes('issue:i,--issue-version,1'));
    assert.ok(calls.includes('review:c,--summary,--include-diff'));
    await pause(); view.stdin.write('\x05'); await pause(); assert.equal(returned, 1);
  } finally { view.unmount(); view.cleanup(); }
});

for (const [width, height] of [[40,10],[80,24]]) test(`Eval fixed Candidate remains actionable at ${width}x${height}`, async () => {
  let returned = 0;
  const view = render(<ReviewApp initialCandidate="c" reader={reader} context={context} onEval={() => returned++} onExit={() => {}} width={width} height={height} />);
  try {
    await wait(view, /交付概览/);
    view.stdin.write('\u001b[B'); await pause();
    assert.match(view.lastFrame()!, /›/);
    view.stdin.write('\r'); await pause();
    assert.match(view.lastFrame()!, /焦点：正文/);
    view.stdin.write('\u001b'); await pause();
    view.stdin.write(':'); await pause();
    view.stdin.write('评测'); await pause();
    assert.match(view.lastFrame()!, /评测资产与实验对照/);
    view.stdin.write('\r'); await pause(); assert.equal(returned, 1);
    assert.ok(view.lastFrame()!.split('\n').every(line => stringWidth(line) <= width));
  } finally { view.unmount(); view.cleanup(); }
});

test('an ultra report is labelled in the criterion reading view and points to the CLI for quality findings', () => {
  const c = criteria(trace)[0];
  const ultra = { ...structuredClone(report), mode: 'ultra', quality: { overall_verdict: 'rejected' }, quality_verdict: 'rejected' };
  const text = criterionText(trace, c, [ultra], 1);
  assert.match(text, /验证报告 1 · v · ultra（质量评审 rejected）/);
  assert.match(text, /契约部分的判断/);
  assert.match(text, /verification show/);
  const plain = criterionText(trace, c, [report], 1);
  assert.match(plain, /验证报告 1 · v · normal/);
  assert.doesNotMatch(plain, /契约部分的判断/);
});
