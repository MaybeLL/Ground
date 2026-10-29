import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalApp } from '../src/eval-app.js';
import { DraftStore } from '../src/eval-drafts.js';
import type { EvalAccess } from '../src/eval-protocol.js';
import { SQLStore } from '../../typescript/src/sql-store.js';
import { QASourceModule } from '../../typescript/src/qa-draft-publication.js';
import { QADraftStore } from '../../typescript/src/qa-candidate.js';
import { executeQADraft } from '../../typescript/src/qa-draft-cli.js';
import { parseArgs } from '../../typescript/src/cli.js';
import { sha256Bytes } from '../../typescript/src/canonical-json.js';
import { newUUIDv7 } from '../../typescript/src/identity.js';

const human = { kind: 'human' as const, git_name: 'QA Review', git_email: 'qa@example.test' };
const actor = () => ({ operation_id: newUUIDv7(), attribution: human });
const pause = () => new Promise(r => setTimeout(r, 35));
const screen = (ui: ReturnType<typeof render>) => stripAnsi(ui.lastFrame() ?? '');
async function until(ui: ReturnType<typeof render>, text: string) { for (let n = 0; n < 150 && !screen(ui).includes(text); n++) await pause(); assert.ok(screen(ui).includes(text), `missing ${text}\n${screen(ui)}`); }
async function press(ui: ReturnType<typeof render>, key: string, count = 1) { for (let n = 0; n < count; n++) { for (let k = 0; k < 100 && screen(ui).includes('正在读取／保存'); k++) await pause(); ui.stdin.write(key); await pause(); } }
async function choose(ui: ReturnType<typeof render>, label: string) { await press(ui, '/'); await press(ui, label); await press(ui, '\r'); await press(ui, '\r'); }
const wide = (ui: ReturnType<typeof render>, width: number) => assert.ok(screen(ui).split('\n').every(line => stringWidth(line) <= width), screen(ui));

const message = (role: string, text: string, time: string, extra: object = {}) => JSON.stringify({ message: { role, content: [{ type: 'input_text', text }], ...extra }, native_time: time });
const call = (extra: object) => JSON.stringify({ format: 'graphkb.call/v1', started_at: Date.parse('2026-10-15T06:40:30.000Z'), ended_at: Date.parse('2026-10-15T06:40:31.000Z'), status: 'completed', exit_code: 0, ...extra });
const longQuestion = '请解释这个稳定规则及例外：' + '并发上限与排队策略，'.repeat(12) + '注意 **加粗** 与 `代码` 不应被当成排版。';
const evidence = [
  ['u1', 'question', message('user', longQuestion, '2026-10-15T06:40:22.000Z')],
  ['call1', 'query', call({ call_id: 'c1', actual_output: { items: [{ name: 'desktop fixture concurrency', summary: 'Synthetic fixture concurrency is 10.' }], graph_revision: 'desktop-fixture-v1' }, http_observations: [{ status: 200, elapsed_ms: 34, body: { query: 'desktop fixture concurrency', kind: 'facts' } }] })],
  ['callf', 'query', call({ call_id: 'c2', started_at: Date.parse('2026-10-15T06:40:35.000Z'), exit_code: 1, status: 'failed', http_observations: [] })],
  ['a1', 'answer', message('assistant', '最大并发是 10。', '2026-10-15T06:40:38.000Z', { phase: 'final_answer' })],
] as const;
const completeness = { question: 'complete', query: 'complete', answer: 'complete', feedback: 'not_applicable', attachments: 'unknown', subtasks: 'not_applicable' };
const limitations = ['只包含可观察事实', 'model_extraction_unverified', 'private_scoring_requires_human_review', 'brand_new_unknown_code'];

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-readability-ui-'))), store = SQLStore.sqlite(join(root, 'ledger.db'));
  await store.initialize('warn'); const module = new QASourceModule(store), drafts = new QADraftStore(join(root, 'native-drafts'));
  const first = new Date(Date.now() - 1000).toISOString(), expires = new Date(Date.now() + 86400000).toISOString();
  const packet = (identity: string, name: string, question: string) => {
    const source = { identity, repository: 'kb:project', revision: 'observed:2', path: `session:S/${identity}`, digest: sha256Bytes(Buffer.from(identity)), record: { call_ids: ['call1'], message_ids: ['u1', 'a1'] } };
    const qa = { format: 'grounds.eval-qa/v1', name, question, instructions: '引用固定文档作答。', rubric: '必须解释规则和例外。', reference_answer: '模型私有答案 10', required_points: ['规则'], forbidden_claims: ['把用户纠正当事实'], references: [], source };
    return { format: 'grounds.qa-candidate/v1', identity, revision: 'r1', project: { id: 'project', first_captured_at: first, expires_at: expires }, qa, evidence: evidence.map(([id, kind, content]) => ({ id, kind, content, locator: `session:S/${id}`, digest: sha256Bytes(Buffer.from(content)), first_captured_at: first, expires_at: expires })), relations: { call_ids: ['call1'] }, completeness, limitations, extraction: { model: 'fixture' } };
  };
  for (const [index, [identity, name, question]] of ([['session:S/q:1', '稳定规则与例外', longQuestion], ['session:S/q:2', '图版本是什么', '该 fixture 当前的 graph_revision 是什么？']] as const).entries()) writeFileSync(join(root, `h${index}.json`), JSON.stringify(packet(identity, name, question)));
  const d1 = await drafts.import(join(root, 'h0.json')), d2 = await drafts.import(join(root, 'h1.json'));
  const seed = await module.publishQA({ ...packet('seed', '种子', '种子题？').qa, source: { identity: 'template-seed', repository: 'kb:project', revision: 'x', path: 'p', digest: sha256Bytes(Buffer.from('seed')), record: {} } } as any, actor());
  await module.publishGrader({ format: 'grounds.eval-grader/v1', name: '质量模板', qa: { id: seed.id, version: 1 }, scope: { kind: 'diagnostic', name: '正确性' }, result_spec: { kind: 'qa_decision' }, definition: { type: 'agent', instructions: '按固定评分依据检查。' }, limitations: 'fixture' }, actor());
  await module.createSuite('审核题集', actor());
  const calls: string[] = [];
  const access: EvalAccess = {
    database: async () => 'fixture-ledger', identity: async () => human, publish: async () => { throw new Error('must use public draft workflow'); },
    read: async (command, args) => { const [kind, action] = command.split('.'); if (kind === 'experiment') return []; return action === 'list' ? module.list(kind as any) : module.show(kind as any, args![0], args!.includes('--version') ? Number(args![args!.indexOf('--version') + 1]) : undefined); },
    qaDraft: async (command, args = [], body) => {
      calls.push(command); const path = join(root, newUUIDv7() + '.json'); if (body) writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
      try { return (await executeQADraft(parseArgs(['eval', ...command.split('.'), ...args, '--draft-root', drafts.root, ...(body ? ['--file', path] : []), ...(['draft.publish', 'draft.save-source'].includes(command) ? ['--operation-id', newUUIDv7()] : [])]), root, store, 'fixture-ledger', () => human)).payload; } finally { if (body) unlinkSync(path); }
    },
  };
  // Unmounting the UI does not cancel requests already dispatched to the fixture.
  const pending = new Set<Promise<unknown>>();
  const track = <T,>(request: Promise<T>): Promise<T> => {
    pending.add(request);
    void request.then(() => pending.delete(request), () => pending.delete(request));
    return request;
  };
  const read = access.read, qaDraft = access.qaDraft!;
  access.read = (...args) => track(read(...args));
  access.qaDraft = (...args) => track(qaDraft(...args));
  return { root, drafts, d1, d2, access, calls, close: async () => { while (pending.size) await Promise.allSettled([...pending]); await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const open = (f: Awaited<ReturnType<typeof setup>>, width: number, height: number, edit?: (text: string) => Promise<string>) => render(<EvalApp access={f.access} reader={{} as any} context={{ databaseId: 'fixture-ledger' } as any} onExit={() => { }} onBack={() => { }} store={new DraftStore(join(f.root, 'tui'))} width={width} height={height} edit={edit} />);
async function toList(ui: ReturnType<typeof render>) { await until(ui, '评测工作台'); await choose(ui, '采集 QA'); await until(ui, '本机权威草稿'); }

for (const [width, height] of [[140, 45], [60, 28]]) test(`draft list tells drafts apart by title, status and next step at ${width}x${height}`, async () => {
  const f = await setup(), ui = open(f, width, height);
  try {
    await toList(ui); await until(ui, '图版本是什么'); const text = screen(ui);
    assert.ok(text.includes('稳定规则与例外') && text.includes('图版本是什么'), text);
    assert.ok(text.includes('待审核·缺5项') && !text.includes('当前草稿 · 待补'), text);
    assert.ok(!text.includes('gra…') && !/[0-9a-f]{8} · 当前草稿/.test(text), text);
    assert.ok(text.includes('下一步'), 'selected row shows what to do next\n' + text);
    wide(ui, width);
    await press(ui, '\u001b[B'); await until(ui, '题面：该 fixture 当前的 graph_revision 是什么？');
    await press(ui, '/'); await press(ui, '图版本'); await press(ui, '\r'); assert.ok(!screen(ui).includes('稳定规则与例外'), 'filter by title');
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});

test('evidence page at 140x45 shows the conversation on the left and the proposed QA on the right', async () => {
  const f = await setup(), ui = open(f, 140, 45);
  try {
    await toList(ui); await press(ui, '\r'); await until(ui, '证据对照'); await until(ui, '用户提问'); await until(ui, '✗ 查询失败'); await until(ui, '✓ 查询成功'); await until(ui, '模型回答'); const text = screen(ui);
    for (const expected of ['现场发生了什么', '[1] 用户提问', '✓ 查询成功', '模型回答', '关键词「desktop fixture concurrency」', '退出码 1', '记录完整度：', '附件！未知', '模型提出的题', '审核状态：待审核 · 还差 5 项才能预览发布', '下一步：', '一、被测者能看到（公开）', '二、只有评分时可见', '发布前检查']) assert.ok(text.includes(expected), `${expected}\n${text}`);
    for (const forbidden of ['"question": "complete"', '"attachments"', 'model_extraction_unverified', 'graphkb-capture:', ' bytes', '完整度 {']) assert.ok(!text.includes(forbidden), `${forbidden}\n${text}`);
    wide(ui, 140);
    // Jargon is translated, and unknown codes fall back instead of disappearing.
    await press(ui, '\u001b[C'); await press(ui, '\u001b[B', 40); const right = screen(ui);
    assert.ok(right.includes('系统标出的限制') || right.includes('依据、来源与限制'), right);
    wide(ui, 140);
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});

test('evidence page at 60x28 stays readable one pane at a time and never overflows', async () => {
  const f = await setup(), ui = open(f, 60, 28);
  try {
    await toList(ui); await press(ui, '\r'); await until(ui, '证据对照'); await until(ui, '用户提问'); wide(ui, 60);
    assert.ok(screen(ui).includes('审核：待审核 · 还差 5 项才能预览发布'), screen(ui)); assert.ok(screen(ui).includes('→ 切到'), 'tells how to reach the other pane\n' + screen(ui));
    await press(ui, '\u001b[C'); await until(ui, '被测者能看到'); wide(ui, 60); assert.ok(screen(ui).includes('← 切到'));
    await press(ui, '\u001b[B', 12); wide(ui, 60); await press(ui, '\u001b[D'); await until(ui, '用户提问'); wide(ui, 60);
    for (const _ of Array.from({ length: 80 })) ui.stdin.write('\u001b[B'); await pause(); await press(ui, '\u001b[A'); assert.ok(!screen(ui).includes('正在读取'), screen(ui));
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});

test('action menu uses the full width and labels evidence in plain words', async () => {
  const f = await setup(), ui = open(f, 140, 45);
  try {
    await toList(ui); await press(ui, '\r'); await until(ui, '用户提问'); await press(ui, ':'); await until(ui, '当前操作'); const text = screen(ui);
    assert.ok(text.includes('编辑 · 公开题目 · 模型建议，待核对 ·'), text); assert.ok(text.includes('原始记录 · [1] 用户提问'), text);
    assert.ok(text.includes('技术细节'), text); assert.ok(!text.includes('graphkb-capture:'), text);
    assert.ok(!/…\s*$/m.test(text.split('\n').filter(l => l.includes('审核条件与权威依据')).join('\n')), 'rows are not clipped at 45 columns');
    wide(ui, 140);
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});

test('Esc from an edit returns to the refreshed review, not a stale snapshot', async () => {
  const f = await setup(), ui = open(f, 140, 45, async () => '人工改写后的题目');
  try {
    await toList(ui); await press(ui, '\r'); await until(ui, '用户提问'); await press(ui, ':'); await choose(ui, '公开题目'); await until(ui, '内存编辑');
    for (const _ of Array.from(longQuestion)) ui.stdin.write('\u007f');
    for (const c of '改写后') ui.stdin.write(c); ui.stdin.write('\u0013'); await until(ui, '用户提问'); await until(ui, '改写后');
    await press(ui, '\u001b'); await until(ui, '改写后'); assert.ok(screen(ui).includes('审核状态'), screen(ui));
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});

test('publication preview explains what will be written before the single confirmation', async () => {
  const f = await setup(); await f.drafts.edit(f.d1.id, f.d1.version, { review: { status: 'reviewed', knowledge: 'stable', independent_text: true, attachments_resolved: true, authority: '固定规则 doc:commit 已由人工核实' } });
  const ui = open(f, 100, 40);
  try {
    await toList(ui); await press(ui, '\r'); await until(ui, '用户提问'); await until(ui, '前置检查已齐');
    await press(ui, ':'); await choose(ui, '选择题集与模板'); await until(ui, '选择发布题集'); await press(ui, '\r'); await until(ui, '新增或更新'); await press(ui, '\r'); await until(ui, '评分模板'); await press(ui, '\r'); await until(ui, '明确确认');
    const text = screen(ui);
    assert.ok(text.includes('还没有写入任何东西'), text); assert.ok(text.includes('确认后会依次创建'), text); assert.ok(!text.includes('"public_input"'), 'JSON dump is behind the plain summary');
    wide(ui, 100); assert.equal(f.calls.includes('draft.publish'), false);
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});

test('leaving the action menu without editing keeps the page and does not re-read the draft', async () => {
  const f = await setup(), ui = open(f, 100, 30);
  try {
    await toList(ui); await press(ui, '\r'); await until(ui, '用户提问'); await press(ui, '\u001b[C'); await press(ui, '\u001b[B', 3); const before = f.calls.filter(c => c === 'draft.show').length, position = () => /模型提出的题 · 待你核对 ↕ (\d+–\d+\/\d+)/.exec(screen(ui))?.[1], scrolled = position();
    assert.ok(scrolled?.startsWith('4–'), String(scrolled));
    await press(ui, ':'); await until(ui, '当前操作'); await press(ui, '\u001b'); await until(ui, '证据对照'); await pause(); await pause();
    assert.equal(f.calls.filter(c => c === 'draft.show').length, before, 'no reload without a change');
    assert.equal(position(), scrolled, 'the right pane keeps its scroll position');
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});
