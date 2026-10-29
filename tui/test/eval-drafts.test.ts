import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DraftStore, canonical, compilePublication, newQA, newGrader, validatePublication, editorCommand, editText } from '../src/eval-drafts.js';
import { ClientError } from '../src/protocol.js';
import type { EvalAccess, EvalRecord, HumanIdentity } from '../src/eval-protocol.js';
const identity: HumanIdentity = { kind: 'human', git_name: '测试', git_email: 'fixture@example.test' };
const qa = () => ({ ...newQA(), name: '题目', question: 'q'.repeat(40000), instructions: '回答', rubric: 'r'.repeat(40000) });
const result: EvalRecord = { id: 'created', version: 1, kind: 'qa', created_at: 'now', attribution: identity, data: qa() };
test('QA provenance keeps stable identities without duplicating large bodies; revisions and copies differ', async () => {
 const root = await mkdtemp(join(tmpdir(), 'eval-drafts-')); const store = new DraftStore(root);
 try {
  const d = await store.create('db', { command: 'qa.publish', body: qa() });
  const first = compilePublication(d).body!; validatePublication(compilePublication(d));
  const source = first.source as any; assert.ok(JSON.stringify(source.record).length < 1000); assert.match(source.identity, /^manual:/);
  const edited = await store.edit(d, { ...d.publication, body: { ...qa(), question: '修改' } });
  assert.equal((compilePublication(edited).body!.source as any).identity, source.identity);
  assert.notEqual((compilePublication(edited).body!.source as any).digest, source.digest);
  const original = { ...result, data: first };
  const revision = await store.create('db', { command: 'qa.publish', id: result.id, expectedVersion: 1, body: first }, original);
  assert.equal((compilePublication(revision).body!.source as any).identity, source.identity);
  const copied = await store.create('db', { command: 'qa.publish', body: first }, original);
  assert.notEqual((compilePublication(copied).body!.source as any).identity, source.identity);
  const imported = { ...original, data: { ...first, source: { identity: 'repo:question-7', repository: 'ssh://example.test/repo', revision: 'fixed', path: 'questions.csv', digest: source.digest, record: { row: 7 } } } };
  const importedRevision = await store.create('db', { command: 'qa.publish', id: imported.id, expectedVersion: 1, body: imported.data }, imported);
  const revisedSource = compilePublication(importedRevision).body!.source as any;
  assert.equal(revisedSource.identity, 'repo:question-7'); assert.equal(revisedSource.repository, 'manual');
  assert.deepEqual(revisedSource.record.based_on, { id: imported.id, version: 1 });
  assert.equal((importedRevision.original!.data.source as any).repository, 'ssh://example.test/repo');
  assert.equal((await stat(root)).mode & 0o777, 0o700); assert.equal((await stat(store.path(d.id))).mode & 0o777, 0o600);
 } finally { await rm(root, { recursive: true, force: true }); }
});
test('uncertain replies preserve original request across restart, database and attribution changes', async () => {
 const root = await mkdtemp(join(tmpdir(), 'eval-recovery-')); const store = new DraftStore(root);
 let database = 'db', actor = identity, lost = true, calls = 0; const writes = new Map<string, unknown>();
 const access: EvalAccess = { read: async () => [], database: async () => database, identity: async () => actor, publish: async req => { calls++; const prior = writes.get(req.operationId); if (prior) assert.deepEqual(req, prior); writes.set(req.operationId, structuredClone(req)); if (lost) { lost = false; throw new ClientError('TIMEOUT', '回执丢失'); } return result; } };
 try {
  const d = await store.prepare(await store.create('db', { command: 'qa.publish', body: qa() }), identity);
  assert.equal(d.request!.operationId[14], '7');
  await assert.rejects(store.send(d, access), /回执丢失/);
  const restarted = new DraftStore(root), pending = await restarted.load(d.id); assert.equal(pending.state, 'pending');
  await assert.rejects(restarted.edit(pending, pending.publication), /先核查/);
  await assert.rejects(restarted.discard(pending), /未知/);
  database = 'other'; await assert.rejects(restarted.send(pending, access), { code: 'DATABASE_ID_MISMATCH' }); assert.equal(calls, 1);
  database = 'db'; actor = { ...identity, git_name: '他人' }; await assert.rejects(restarted.send(pending, access), { code: 'IDENTITY_CHANGED' }); assert.equal(calls, 1);
  const done = await restarted.send(pending, access, true); assert.equal(done.state, 'published'); assert.equal(writes.size, 1); assert.equal(calls, 2);
  assert.deepEqual(done.request!.attribution, identity); await assert.rejects(restarted.send(done, access), /先预览/);
 } finally { await rm(root, { recursive: true, force: true }); }
});
test('definitive conflict preserves draft and permits a new confirmed request; tampering is rejected', async () => {
 const root = await mkdtemp(join(tmpdir(), 'eval-conflict-')); const store = new DraftStore(root);
 try {
  let d = await store.prepare(await store.create('db', { command: 'suite.create', name: '题集' }), identity);
  const access: EvalAccess = { read: async () => [], identity: async () => identity, database: async () => 'db', publish: async () => { throw new ClientError('VERSION_CONFLICT', '版本冲突'); } };
  await assert.rejects(store.send(d, access), /版本冲突/); assert.equal((await store.load(d.id)).state, 'rejected');
  const old = d.request!.operationId; d = await store.prepare(await store.edit(d, { command: 'suite.create', name: '新名称' }), identity); assert.notEqual(d.request!.operationId, old);
  d.request!.name = 'tamper'; await writeFile(store.path(d.id), JSON.stringify(d)); await assert.rejects(store.load(d.id), /摘要/);
 } finally { await rm(root, { recursive: true, force: true }); }
});
test('suite member draft survives restart, blocks incomplete bindings and recovers the exact pending request', async () => {
 const root = await mkdtemp(join(tmpdir(), 'eval-suite-draft-')); const store = new DraftStore(root);
 const original: EvalRecord = { id: 'suite', kind: 'suite', version: 3, created_at: 'now', attribution: identity, data: { name: '集合', tasks: [] } };
 const task = { kind: 'qa', name: '题目', qa: { id: 'qa', version: 2 }, graders: [{ id: 'grader', version: 4 }] };
 let calls = 0, lose = true; const seen: unknown[] = [];
 const access: EvalAccess = { read: async () => [], database: async () => 'db', identity: async () => identity, publish: async request => { calls++; seen.push(request); if (lose) { lose = false; throw new ClientError('TIMEOUT', '回执丢失'); } return { ...original, version: 4, data: { name: '集合', tasks: [{ ...task, id: 'member' }] } }; } };
 try {
  const draft = await store.create('db', { command: 'suite.tasks.publish', id: 'suite', expectedVersion: 3, body: { format: 'grounds.eval-suite-members/v1', tasks: [{ ...task, graders: [] }] } }, original);
  await assert.rejects(store.prepare(draft, identity), /评分规则/);
  const edited = await store.edit(draft, { ...draft.publication, body: { format: 'grounds.eval-suite-members/v1', tasks: [task] } });
  const prepared = await store.prepare(edited, identity);
  await assert.rejects(store.send(prepared, access), /回执丢失/);
  const restarted = new DraftStore(root), pending = await restarted.load(draft.id);
  assert.equal(pending.state, 'pending'); await assert.rejects(restarted.edit(pending, edited.publication), /先核查/);
  const done = await restarted.send(pending, access); assert.equal(done.result?.version, 4); assert.equal(calls, 2); assert.deepEqual(seen[0], seen[1]);
 } finally { await rm(root, { recursive: true, force: true }); }
});
test('grader authoring admits exactly QA Agent, Coding Agent and Coding Go combinations', () => {
 const g: any = newGrader({ qa: { id: 'q', version: 1 } }); Object.assign(g, { name: '维度', limitations: '局限', scope: { kind: 'diagnostic', name: '正确性' }, definition: { type: 'agent', instructions: '评分' } });
 validatePublication({ command: 'grader.publish', body: g });
 assert.throws(() => validatePublication({ command: 'grader.publish', body: { ...g, result_spec: { kind: 'decision' } } }), /QA/);
 const c = { ...g, format: 'patchledger.eval-grader/v1', issue: g.qa, result_spec: { kind: 'score', min: 0, max: 5, higher_is_better: true, rubric: '规则' } }; delete c.qa;
 validatePublication({ command: 'grader.publish', body: c });
 const go = { ...c, result_spec: { kind: 'decision' }, definition: { type: 'unit_test', adapter: 'go', package: '.', test_name: 'TestExample', timeout_seconds: 30, files: [{ path: 'example_test.go', content: 'package example' }] } };
 validatePublication({ command: 'grader.publish', body: go });
 assert.throws(() => validatePublication({ command: 'grader.publish', body: { ...go, definition: { ...go.definition, timeout_seconds: 301 } } }), /1–300/);
 assert.throws(() => validatePublication({ command: 'grader.publish', body: { ...go, definition: { ...go.definition, files: [{ path: '../a_test.go', content: 'x' }] } } }), /文件/);
});
test('editor arguments are literal, terminal ownership is restored on success and failure', async () => {
 assert.deepEqual(editorCommand('"/a path/editor" --wait'), ['/a path/editor', '--wait']); assert.throws(() => editorCommand('"bad'), /引号/);
 const root = await mkdtemp(join(tmpdir(), 'eval-editor-')); let suspended = 0, resumed = 0;
 const suspend = async () => { suspended++; return () => { resumed++; }; };
 try {
  const script = join(root, 'editor.mjs'); await writeFile(script, "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2], '修改后的正文');");
  assert.equal(await editText(root, '原文', suspend, `"${process.execPath}" "${script}"`), '修改后的正文');
  await writeFile(script, 'process.exit(2)'); await assert.rejects(editText(root, '原文', suspend, `"${process.execPath}" "${script}"`), /保留于/);
  assert.equal(suspended, 2); assert.equal(resumed, 2); assert.throws(() => canonical('\ud800'));
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('the complete task/scope/definition/result matrix accepts only the seven legal combinations', () => {
 for (const qa of [true,false]) for (const scope of ['diagnostic','criterion']) for (const type of ['agent','unit_test']) for (const kind of ['qa_decision','decision','score']) {
  const body = {...newGrader(qa ? {qa:{id:'q',version:1}} : {issue:{id:'i',version:1}}),name:'规则',limitations:'测试',
   scope:scope==='diagnostic'?{kind:scope,name:'正确性'}:{kind:scope,criterion_ids:['criterion']},
   definition:type==='agent'?{type,instructions:'规则'}:{type,adapter:'go',package:'.',test_name:'TestFixture',timeout_seconds:30,files:[{path:'fixture_test.go',content:'package fixture'}]},
   result_spec:kind==='score'?{kind,min:0,max:5,higher_is_better:true,rubric:'规则'}:{kind}};
  const valid=qa ? scope==='diagnostic'&&type==='agent'&&kind==='qa_decision' : kind==='decision'||type==='agent'&&kind==='score';
  const run=()=>validatePublication({command:'grader.publish',body});
  if(valid) assert.doesNotThrow(run,JSON.stringify({qa,scope,type,kind})); else assert.throws(run,undefined,JSON.stringify({qa,scope,type,kind}));
 }
});

test('without VISUAL or EDITOR the long-text editor defaults to vim and explains when vim is missing', async () => {
 const root = await mkdtemp(join(tmpdir(), 'eval-default-editor-')); const keep = { visual: process.env.VISUAL, editor: process.env.EDITOR, path: process.env.PATH };
 const suspend = async () => () => {};
 try {
  const bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'vim'), '#!/bin/sh\nprintf \'默认编辑器写入\' > "$1"\n'); await chmod(join(bin, 'vim'), 0o755);
  delete process.env.VISUAL; delete process.env.EDITOR; process.env.PATH = bin;
  assert.equal(await editText(root, '原文', suspend), '默认编辑器写入');
  const empty = join(root, 'empty'); await mkdir(empty); process.env.PATH = empty;
  await assert.rejects(editText(root, '原文', suspend), /未找到 vim.*EDITOR/);
 } finally {
  for (const [key, value] of [['VISUAL', keep.visual], ['EDITOR', keep.editor], ['PATH', keep.path]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
 }
});
