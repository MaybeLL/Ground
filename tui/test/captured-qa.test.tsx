import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalApp } from '../src/eval-app.js';
import { DraftStore, compilePublication } from '../src/eval-drafts.js';
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
async function until(ui: ReturnType<typeof render>, text: string) { for (let n = 0; n < 100 && !ui.lastFrame()?.includes(text); n++)await pause(); assert.ok(ui.lastFrame()?.includes(text), ui.lastFrame()); }
async function press(ui: ReturnType<typeof render>, key: string, count = 1) { for (let n = 0; n < count; n++) { for (let k = 0; k < 100 && ui.lastFrame()?.includes('正在读取／保存'); k++)await pause(); ui.stdin.write(key); await pause(); } }
async function choose(ui: ReturnType<typeof render>, label: string) { await press(ui, '/'); await press(ui, label); await press(ui, '\r'); await press(ui, '\r'); }
async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-captured-ui-'))), store = SQLStore.sqlite(join(root, 'ledger.db')); await store.initialize('warn'); const module = new QASourceModule(store), drafts = new QADraftStore(join(root, 'native-drafts'));
  const first = new Date(Date.now() - 1000).toISOString(), expires = new Date(Date.now() + 86400000).toISOString(), file = join(root, 'handoff.json');
  const source = { identity: 'session:S/q:1', repository: 'kb:project', revision: 'observed:2', path: 'session:S/turn:T1', digest: sha256Bytes(Buffer.from('call1')), record: { call_ids: ['call1'], message_ids: ['u1', 'a1'] } };
  const qa = { format: 'grounds.eval-qa/v1', name: '规则', question: '请解释这个稳定规则及例外。', instructions: '引用固定文档。', rubric: '必须解释规则和例外。', reference_answer: '模型私有答案 10', required_points: ['规则'], forbidden_claims: [], references: ['doc:commit'], source };
  writeFileSync(file, JSON.stringify({ format: 'grounds.qa-candidate/v1', identity: source.identity, revision: 'r1', project: { id: 'project', first_captured_at: first, expires_at: expires }, qa, evidence: [['u1', 'question', '中文原问题与现场查询证据'], ['call1', 'query', '真实查询返回'], ['a1', 'answer', '可见最终答复']].map(([id, kind, content]) => ({ id, kind, content, locator: `session:S/${id}`, digest: sha256Bytes(Buffer.from(content)), first_captured_at: first, expires_at: expires })), relations: { call_ids: ['call1'] }, completeness: { question: 'complete', query: 'complete', answer: 'complete', feedback: 'not_applicable', attachments: 'not_applicable', subtasks: 'not_applicable' }, limitations: ['只包含可观察事实'], extraction: { model: 'fixture' } }));
  let d = await drafts.import(file); d = await drafts.edit(d.id, d.version, { review: { status: 'reviewed', knowledge: 'stable', independent_text: true, attachments_resolved: true, authority: '固定规则 doc:commit 已由人工核实' } });
  const seed = await module.publishQA({ ...qa, source: { ...source, identity: 'template-seed' } }, actor()); await module.publishGrader({ format: 'grounds.eval-grader/v1', name: '质量模板', qa: { id: seed.id, version: 1 }, scope: { kind: 'diagnostic', name: '正确性' }, result_spec: { kind: 'qa_decision' }, definition: { type: 'agent', instructions: '按固定评分依据检查。' }, limitations: 'fixture' }, actor()); await module.createSuite('审核题集', actor()); let writes = 0; const calls: string[] = [];
  const access: EvalAccess = {    
database: async () => 'fixture-ledger', identity: async () => human, publish: async () => { throw new Error('must use public draft workflow'); }, read: async (command, args) => { const [kind, action] = command.split('.'); if (kind === 'experiment') return []; return action === 'list' ? module.list(kind as any) : module.show(kind as any, args![0], args!.includes('--version') ? Number(args![args!.indexOf('--version') + 1]) : undefined); }, qaDraft: async (command, args = [], body) => {
      calls.push(command); if (command === 'draft.publish') writes++;
      const path = join(root, newUUIDv7() + '.json'); if (body) writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
      try { const argv = ['eval', ...command.split('.'), ...args, '--draft-root', drafts.root, ...(body ? ['--file', path] : []), ...(['draft.publish', 'draft.save-source'].includes(command) ? ['--operation-id', newUUIDv7()] : [])]; return (await executeQADraft(parseArgs(argv), root, store, 'fixture-ledger', () => human)).payload; } finally { if (body) unlinkSync(path); }
    }  
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
  return { root, store, module, drafts, d, access, calls, writes: () => writes, close: async () => { while (pending.size) await Promise.allSettled([...pending]); await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
for (const [width, height] of [[40, 10], [80, 24], [160, 40]]) test(`captured QA keyboard evidence and native editing use public CLI at ${width}x${height}`, async () => {
  const f = await setup(), ui = render(<EvalApp access={f.access} reader={{} as any} context={{ databaseId: 'fixture-ledger' } as any} onExit={() => { }} onBack={() => { }} store={new DraftStore(join(f.root, 'tui'))} width={width} height={height} edit={async () => '人工补充的稳定问题'} />);
  try {
    await until(ui, '评测工作台'); await choose(ui, '采集 QA'); await until(ui, '本机权威草稿'); await press(ui, '\r'); await until(ui, '证据对照'); assert.equal(f.writes(), 0);
    await press(ui, ':'); await choose(ui, '证据 question'); await until(ui, '采集证据'); await press(ui, '\u001b[C'); assert.ok(ui.lastFrame()!.split('\n').every(line => stringWidth(line) <= width), ui.lastFrame());
    await press(ui, '\u001b'); await until(ui, '当前操作'); await press(ui, '\u001b'); await until(ui, '证据对照'); await press(ui, ':'); await choose(ui, '公开题目');await until(ui,'内存编辑');await press(ui,'人工补充的稳定问题');await press(ui,'\u0013');await until(ui, '证据对照'); assert.equal(f.drafts.load(f.d.id).manual.question, '请解释这个稳定规则及例外。人工补充的稳定问题'); assert.equal(f.drafts.load(f.d.id).review.status, 'pending'); assert.equal(f.writes(), 0); assert.ok(f.calls.includes('draft.evidence')); assert.ok(f.calls.includes('draft.edit'));
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});
test('captured multiline editing consumes every burst input before immediate save and cancellation', async () => {
  const f = await setup(), ui = render(<EvalApp access={f.access} reader={{} as any} context={{databaseId: 'fixture-ledger'} as any} onExit={() => {throw new Error('field shortcut must not exit');}} onBack={() => {}} store={new DraftStore(join(f.root, 'tui'))} width={80} height={24}/>);
  try {
    await until(ui, '评测工作台'); await choose(ui, '采集 QA'); await until(ui, '本机权威草稿'); await press(ui, '\r'); await until(ui, '证据对照');
    const open = async () => {await press(ui, ':'); await choose(ui, '公开题目'); await until(ui, '内存编辑');};
    await open();
    for (const _ of Array.from('请解释这个稳定规则及例外。')) ui.stdin.write('\u007f');
    const expected = '中文q/:新问题\n第二行';
    for (const character of expected) ui.stdin.write(character === '\n' ? '\r' : character);
    ui.stdin.write('\u0013');
    await until(ui, '证据对照');
    assert.equal(f.drafts.load(f.d.id).manual.question, expected);
    await open();
    for (const character of '取消的q/:输入') ui.stdin.write(character);
    ui.stdin.write('\u001b'); await until(ui, '当前操作');
    assert.equal(f.drafts.load(f.d.id).manual.question, expected); assert.equal(f.writes(), 0);
  } finally {ui.unmount(); ui.cleanup(); await f.close();}
});
test('captured publication preview cancels read-only, then one confirmation creates source/QA/Grader/member', async () => {
  const f = await setup(), ui = render(<EvalApp access={f.access} reader={{} as any} context={{ databaseId: 'fixture-ledger' } as any} onExit={() => { }} onBack={() => { }} store={new DraftStore(join(f.root, 'tui'))} width={100} height={30} />);
  try {
    await until(ui, '评测工作台'); await choose(ui, '采集 QA'); await until(ui, '本机权威草稿'); await press(ui, '\r'); await until(ui, '证据对照');
    const preview = async () => { await press(ui, ':'); await choose(ui, '选择题集与模板'); await until(ui, '选择发布题集'); await press(ui, '\r'); await until(ui, '新增或更新'); await press(ui, '\r'); await until(ui, '评分模板'); await press(ui, '\r'); await until(ui, '明确确认'); };
    await preview(); assert.equal(f.writes(), 0); await press(ui, '\u001b'); assert.equal(f.writes(), 0);
    // Back navigation retains the template selection; confirm only from a fresh preview.
    await until(ui, '评分模板'); await press(ui, '\r'); await until(ui, '明确确认'); await press(ui, '\r'); await until(ui, '证据对照'); assert.equal(f.writes(), 1); assert.equal(f.drafts.load(f.d.id).journal?.state, 'published'); assert.equal((await f.module.list('suite'))[0].data.tasks.length, 1); assert.equal((await f.module.list('grader')).length, 2);
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});
test('old TUI manual revision preserves a captured QA source package and native provenance', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-captured-manual-'))), store = new DraftStore(root); try {
    const source = { identity: 'capture:q1', repository: 'kb:project', revision: 'observed:7', path: 'session:S/turn:T1', digest: 'sha256:' + 'a'.repeat(64), record: { kind: 'captured_review', source_package: 'sha256:' + 'b'.repeat(64), captured_sources: [{ identity: 'capture:q1' }] } };
    const original = { id: 'qa1', kind: 'qa', version: 1, created_at: 'now', attribution: human, data: { format: 'grounds.eval-qa/v1', name: '题目', question: '原题', instructions: '作答', rubric: '依据', required_points: [], forbidden_claims: [], references: [], source } };
    const draft = await store.create('db', { command: 'qa.publish', id: 'qa1', expectedVersion: 1, body: { ...original.data, question: '人工修订' } }, original);
    const revised = compilePublication(draft).body!.source as any; assert.equal(revised.repository, source.repository); assert.equal(revised.path, source.path); assert.equal(revised.identity, source.identity); assert.equal(revised.record.source_package, source.record.source_package); assert.equal(revised.record.manual_revision.kind, 'human');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('keyboard merge preserves automatic provenance and never retains an unedited private answer after expiry', async () => {
  const f = await setup();
  const packet = JSON.parse(readFileSync(join(f.root, 'handoff.json'), 'utf8'));
  packet.identity = 'session:S/q:2'; packet.qa.source.identity = packet.identity;
  const second = join(f.root, 'second.json'); writeFileSync(second, JSON.stringify(packet)); await f.drafts.import(second);
  const edited = await f.drafts.edit(f.d.id, f.d.version, { qa: { rubric: '人工保存的评分依据' } });
  const ui = render(<EvalApp access={f.access} reader={{} as any} context={{ databaseId: 'fixture-ledger' } as any} onExit={() => { }} onBack={() => { }} store={new DraftStore(join(f.root, 'tui'))} width={100} height={30} />);
  try {
    await until(ui, '评测工作台'); await choose(ui, '采集 QA'); await until(ui, '本机权威草稿'); await press(ui, '\r'); await until(ui, '证据对照');
    await press(ui, ':'); await choose(ui, '与另一草稿合并'); await until(ui, '选择合并对象'); await press(ui, '\r'); await until(ui, '确认合并'); await press(ui, '\r'); await until(ui, '证据对照');
    const merged = f.drafts.list().find(d => d.state === 'active')!;
    assert.equal(merged.predecessors.length, 2); assert.equal(merged.review.status, 'pending');
    assert.deepEqual(merged.manual, edited.manual); assert.equal(merged.manual.reference_answer, undefined);
    assert.equal(f.drafts.view(merged.id).provenance.reference_answer, 'model_suggestion');
    const expired = f.drafts.view(merged.id, Date.now() + 2 * 86400000);
    assert.equal(expired.qa.reference_answer, undefined); assert.equal(expired.provenance.reference_answer, 'missing');
    assert.equal(expired.qa.rubric, '人工保存的评分依据'); assert.equal(expired.provenance.rubric, 'human');
    assert.equal(merged.automatic.length, 2); assert.equal(f.writes(), 0);
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});
test('source-clue keyboard list/filter/detail/ignore uses public CLI without creating a QA', async () => {
  const f = await setup();
  const packet = { format: 'grounds.source-clue/v1', project: { id: 'project', root: '/selected/project' }, clues: [{ id: 'clue-1', project_id: 'project', host: 'pi', session: 'session', branch: '', reason: 'query_failed', state: 'pending_analysis', record_ref: { id: 'material', kind: 'cli_result', digest: 'sha256:' + 'a'.repeat(64) }, first_captured_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), limitations: ['仅公开材料索引'] }] };
  const input = join(f.root, 'clue.json'); writeFileSync(input, JSON.stringify(packet));
  await executeQADraft(parseArgs(['eval', 'clue', 'import', '--file', input, '--draft-root', f.drafts.root]), f.root);
  const before = f.drafts.list().length;
  const ui = render(<EvalApp access={f.access} reader={{} as any} context={{ databaseId: 'fixture-ledger' } as any} onExit={() => { }} onBack={() => { }} store={new DraftStore(join(f.root, 'tui'))} width={100} height={30} />);
  try {
    await until(ui, '评测工作台'); await choose(ui, '待提取来源线索'); await until(ui, '不是 QA');
    await press(ui, '/'); await press(ui, 'pi'); await press(ui, '\r'); await press(ui, '\r'); await until(ui, '来源线索 · 仅元数据');
    await press(ui, '\r'); await until(ui, '已忽略'); assert.equal(f.drafts.list().length, before); assert.equal(f.writes(), 0);
    assert.ok(f.calls.includes('clue.show')); assert.ok(f.calls.includes('clue.ignore'));
  } finally { ui.unmount(); ui.cleanup(); await f.close(); }
});
test('question boundary keyboard review confirms a real omitted question through the public CLI', async () => {
  const f = await setup();
  const base = JSON.parse(readFileSync(join(f.root, 'handoff.json'), 'utf8'));
  base.identity = 'graphkb:original'; base.qa.source.identity = base.identity;
  base.qa.source.record = {format: 'graphkb.qa-source/v2', origin_key: sha256Bytes(Buffer.from('original-message')), scope: 'scope'};
  base.extraction = {run_id: 'analysis', input_digest: sha256Bytes(Buffer.from('initial'))};
  const originalFile = join(f.root, 'original.json'); writeFileSync(originalFile, JSON.stringify(base)); await f.drafts.import(originalFile);
  const proposal = structuredClone(base); proposal.identity = 'graphkb:discovery'; proposal.qa.source.identity = proposal.identity;
  proposal.revision = 'refresh'; proposal.extraction.input_digest = sha256Bytes(Buffer.from('refresh'));
  const newFile = join(f.root, 'discovery.json'); writeFileSync(newFile, JSON.stringify(proposal)); const pending = await f.drafts.import(newFile);
  assert.equal(pending.state, 'boundary_pending');
  const ui = render(<EvalApp access={f.access} reader={{} as any} context={{databaseId: 'fixture-ledger'} as any} onExit={() => {}} onBack={() => {}} store={new DraftStore(join(f.root, 'tui'))} width={80} height={24} />);
  try {
    await until(ui, '评测工作台'); await choose(ui, '采集 QA'); await until(ui, '本机权威草稿');
    await choose(ui, 'graphkb:discovery'); await until(ui, '证据对照'); await press(ui, ':');
    assert.ok(!ui.lastFrame()?.includes('选择题集与模板'));
    await choose(ui, '确认这是独立新题'); await until(ui, '确认新的题目边界');
    await press(ui, '\u001b'); assert.equal(f.drafts.load(pending.id).state, 'boundary_pending');
    // Esc restores the selected action and its existing filter.
    await press(ui, '\r'); await until(ui, '确认新的题目边界'); await press(ui, '\r'); await until(ui, '证据对照');
    assert.equal(f.drafts.load(pending.id).state, 'active'); assert.equal(f.drafts.load(pending.id).review.status, 'pending');
    assert.ok(f.calls.includes('draft.resolve-boundary')); assert.equal(f.writes(), 0);
  } finally {ui.unmount(); ui.cleanup(); await f.close();}
});
