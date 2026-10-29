import { assertContract } from './schema-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLStore } from '../src/sql-store.js';
import { QADraftStore, decodeCandidate, decodeMaterialJSON, type CandidateHandoff } from '../src/qa-candidate.js';
import { QADraftPublisher, QASourceModule } from '../src/qa-draft-publication.js';
import { canonicalBytes, sha256, sha256Bytes } from '../src/canonical-json.js';
import { newUUIDv7 } from '../src/identity.js';
import { execute,parseArgs } from '../src/cli.js';
import { executeQADraft } from '../src/qa-draft-cli.js';
import { sourceIndexSchema } from '../src/qa-source-index.js';
import { testAgent } from './fixture.js';
const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
export function handoff(identity = 'trace:question-A', revision = 'r1'): CandidateHandoff {
  const first = new Date(Date.now() - 1000).toISOString(), expires = new Date(Date.now() + 86400000).toISOString();
  const evidence = [['question', 'user1', 'What is the concurrency limit?'], ['query', 'call1', 'Actual graphkb query found limit 10.'], ['answer', 'assistant1', 'The limit is 10.'], ['feedback', 'user2', 'Correction: historical configuration changed.']].map(([kind, id, content]) => ({ id, kind, content, locator: `session:S1/turn:T1/${id}`, digest: sha256Bytes(Buffer.from(content)), first_captured_at: first, expires_at: expires }));
  return { format: 'grounds.qa-candidate/v1', identity, revision, project: { id: 'project1', first_captured_at: first, expires_at: expires }, qa: { format: 'grounds.eval-qa/v1', name: 'Concurrency', question: 'What is the concurrency rule?', instructions: 'Explain the stable rule and cite the fixed specification.', rubric: 'Explain the guard and its documented exceptions.', required_points: ['guard'], forbidden_claims: [], references: ['doc:fixed-commit'], source: { identity, repository: 'kb:project1', revision: 'observed:7', path: 'session:S1/turn:T1', digest: sha256Bytes(Buffer.from('call1')), record: { call_ids: ['call1'], message_ids: ['user1', 'assistant1', 'user2'] } } }, evidence, relations: { question: ['user1'], calls: ['call1'], answer: ['assistant1'], feedback: ['user2'], association: 'observed' }, completeness: { question: 'complete', query: 'complete', answer: 'complete', feedback: 'complete', attachments: 'not_applicable', subtasks: 'not_applicable' }, limitations: ['Fixture: observable messages only.'], extraction: { run_id: 'analysis1', prompt_version: 'v1', model: 'fixture', input_digest: sha256Bytes(Buffer.from('input')), clue_ids: ['call1'], reason: 'feedback' } };
}
async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-drafts-'))), store = SQLStore.sqlite(join(root, 'ledger.db')); await store.initialize('warn');
  const m = new QASourceModule(store), drafts = new QADraftStore(join(root, 'drafts')), file = join(root, 'handoff.json'); writeFileSync(file, JSON.stringify(handoff()));
  let d = await drafts.import(file);
  d = await drafts.edit(d.id, d.version, { review: { status: 'reviewed', knowledge: 'stable', independent_text: true, attachments_resolved: true, authority: 'Reviewed fixed specification doc:commit1.' } });
  const seed = await m.publishQA({ ...handoff('seed').qa, source: handoff('seed').qa.source! }, actor());
  const template = await m.publishGrader({ format: 'grounds.eval-grader/v1', qa: { id: seed.id, version: 1 }, name: 'Quality template', scope: { kind: 'diagnostic', name: 'Answer quality' }, result_spec: { kind: 'qa_decision' }, definition: { type: 'agent', instructions: 'Use the fixed QA rubric and authority.' }, limitations: 'Human-reviewed authority required.' }, actor());
  const suite = await m.createSuite('Collected QA', actor()), publisher = new QADraftPublisher(drafts, m, 'fixture-ledger');
  const target = { suite: { id: suite.id, version: suite.version }, member: { mode: 'add' as const }, template: { id: template.id, version: 1 } };
  return { root, store, m, drafts, file, d, publisher, target, close: async () => { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('local import works without SQL config; retry, suggestions and human overlays remain authoritative', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-local-drafts-'))); try {
    const file = join(root, 'handoff.json'); writeFileSync(file, JSON.stringify(handoff()));
    const cli = await execute(['eval', 'draft', 'import', '--file', file, '--draft-root', join(root, 'drafts'), '--config', join(root, 'does-not-exist')]) as any;
    assertContract('eval.schema.json', cli);
    const listed = await execute(['eval', 'draft', 'list', '--draft-root', join(root, 'drafts')]) as any; assertContract('eval.schema.json', listed);
    const shown = await execute(['eval', 'draft', 'show', cli.payload.id, '--draft-root', join(root, 'drafts')]) as any; assertContract('eval.schema.json', shown); assert.ok(!JSON.stringify(shown).includes('The limit is 10.'));
    const ds = new QADraftStore(join(root, 'drafts')), d = cli.payload; assert.equal(d.version, 1); assert.equal((await ds.import(file)).id, d.id);
    assert.ok(!readFileSync(ds.path(d.id), 'utf8').includes('The limit is 10.'));
    const edited = await ds.edit(d.id, 1, { qa: { question: 'Human fixed question' } }); writeFileSync(file, JSON.stringify(handoff(undefined, 'r2')));
    const next = await ds.import(file); assert.equal(next.id, d.id); assert.equal(next.suggestions.length, 1); assert.equal(ds.view(d.id).qa.question, 'Human fixed question');
    // Old immutable pointer became unavailable; it is not silently rebound to the newly overwritten path.
    assert.equal(ds.view(d.id).missing.length, 1); assert.equal(edited.manual.question, 'Human fixed question');
    await assert.rejects(ds.edit(d.id, 1, { qa: { rubric: 'stale' } }), /version/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('split/merge new identities replace predecessors; late old feedback stays a routed suggestion', async () => {
  const f = await setup(); try {
    const successors = await f.drafts.split(f.d.id, f.d.version, [{ question: 'Question A' }, { question: 'Question B' }]); assert.equal(new Set(successors.map(d => d.identity)).size, 2); assert.notEqual(successors[0].identity, f.d.identity);
    assert.equal(f.drafts.load(f.d.id).state, 'replaced'); await assert.rejects(f.publisher.preview(f.d.id, f.drafts.load(f.d.id).version, f.target), /validation/i);
    const later = join(f.root, 'later.json'); writeFileSync(later, JSON.stringify(handoff(undefined, 'r2'))); const old = await f.drafts.import(later); assert.equal(old.state, 'replaced'); assert.equal(old.suggestions.length, 1);
    const routed = await f.drafts.acceptSuggestion(old.id, old.version, old.suggestions[0].digest, successors[1].id, successors[1].version); assert.equal(routed.manual.question, 'Question B'); assert.equal(routed.automatic[0].revision, 'r2');
    const merged = await f.drafts.merge([{ id: successors[0].id, version: 1 }, { id: routed.id, version: routed.version }], { question: 'Combined question' }); assert.equal(merged.predecessors.length, 2); assert.equal(merged.automatic.length, 2); assert.equal(merged.state, 'active');
  } finally { await f.close(); }
});
test('expiry and overwritten caches do not restore automatic text; manual information survives', async () => {
  const f = await setup(); try {
    const d = await f.drafts.edit(f.d.id, f.d.version, { qa: { question: 'Persistent human question' } }); const view = f.drafts.view(d.id, Date.now() + 2 * 86400000); assert.equal(view.materials.length, 0); assert.equal(view.qa.question, 'Persistent human question'); assert.equal(view.provenance.question, 'human'); assert.equal(view.qa.reference_answer, undefined);
    const invalid = handoff(); invalid.project.expires_at = new Date(Date.now() + 8 * 86400000).toISOString(); assert.throws(() => decodeCandidate(invalid));
    invalid.project = handoff().project; invalid.evidence[0].content = 'tampered'; assert.throws(() => decodeCandidate(invalid)); assert.throws(() => decodeMaterialJSON(Buffer.from('{"a":1,"a":2}')));assert.throws(()=>decodeMaterialJSON(Buffer.from('{"a":1e999}')));const bodyIndex=handoff();bodyIndex.qa.source!.record={trace:'full trace'};assert.throws(()=>decodeCandidate(bodyIndex));
  } finally { await f.close(); }
});
test('candidate source index rejects unknown or renamed body fields at every supported level', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../../docs/contracts/v1/qa-source-index.schema.json', import.meta.url), 'utf8')), sourceIndexSchema());
  for (const value of [
    { session_notes: 'user: Q\nassistant: A\nuser: correction' },
    { kind: 'user:Q;assistant:A;feedback:correction' },
    { scope: '用户问最大并发，助手回答10，用户更正20' },
    { question_span: 'original user question' },
    { model_question_proposal: 'rewritten question' },
    { material_ids: ['ref', { session_notes: 'full body' }] },
    { context_reads: [{ state: 'completed', request_digest: 'a'.repeat(64), requested_count: 1,
      material_ids: ['ref'], scopes: ['scope'], authorization_digest: 'b'.repeat(64), input_digest: 'c'.repeat(64),
      added_bytes: 12, missing_count: 0, records: [{ id: 'ref', kind: 'question', sha256: 'd'.repeat(64),
        bytes: 12, first_captured_at: 1, expires_at: 2, session_notes: 'body' }] }] },
  ]) {
    const candidate = handoff(); candidate.qa.source!.record = value;
    assert.throws(() => decodeCandidate(candidate), /source.record|validation/i);
  }
  const valid = handoff(); valid.qa.source!.record = { format: 'graphkb.qa-source/v1', scope: 'scope',
    original_question: 'user1', question_index: 0, question_span_digest: 'a'.repeat(64),
    model_question_proposal_digest: 'b'.repeat(64), question_policy: 'original_span_until_review',
    material_ids: ['user1', 'call1'], clue_ids: [], input_digest: 'c'.repeat(64),
    authorization_digest: 'd'.repeat(64), context_reads: [], observation: 'model_extraction_unverified', condition_type: 'current_state' };
  assert.doesNotThrow(() => decodeCandidate(valid));
  assertContract('qa-candidate.schema.json', valid);
});
test('historical source reuse needs an exact completed source-save receipt, not an arbitrary blob or artifact operation', async () => {
  const f = await setup(); try {
    // Synthetic historical storage/receipt fixture, not a claim of a real old release run.
    const legacy = handoff('legacy-source'); legacy.qa.source!.record = {question_span: 'Old original question'};
    const first = new Date(Date.now() - 10 * 86400000).toISOString(), expires = new Date(Date.now() - 3 * 86400000).toISOString();
    legacy.project.first_captured_at = first; legacy.project.expires_at = expires;
    legacy.evidence.forEach(e => {e.first_captured_at = first; e.expires_at = expires;});
    const pkg = {format: 'grounds.qa-source-package/v1' as const, sources: [legacy], manual: {}, review: f.d.review, lineage: []};
    const bytes = canonicalBytes(pkg), digest = sha256Bytes(bytes), old = actor();
    const reference = {format: 'grounds.qa-source-package-reference/v1', digest, size: bytes.length, evidence: []};
    await f.store.write(async tx => {
      await tx.putEvalBlob(bytes);
      await tx.reserveOperation({id: old.operation_id, command: 'eval.source-package.save', request_hash: sha256({input: {digest}, attribution: old.attribution})});
      await tx.completeOperation(old.operation_id, JSON.stringify({format: 'patchledger.cli/v1', ok: true, data: {command: 'eval.source-package.save', payload: reference}}));
    });
    assert.deepEqual(await f.m.package(digest), pkg);
    await assert.rejects(f.m.freeze(pkg, actor()), /validation/i);
    const same = await f.m.freeze(pkg, actor(), old.operation_id); assert.equal(same.digest, digest);
    const changed = {...pkg, manual: {rubric: 'Reviewed new rubric'}, retained_from: [digest]};
    await assert.rejects(f.m.freeze(changed, actor()), /validation/i);
    const next = await f.m.freeze({...changed, retained_operations: [{digest, operation_id: old.operation_id}]}, actor());
    assert.deepEqual((await f.m.package(next.digest)).sources, [legacy]); assert.deepEqual(await f.m.package(digest), pkg);
    const tampered = {...pkg, sources: [{...legacy, qa: {...legacy.qa, question: 'Changed source body'}}]};
    await assert.rejects(f.m.freeze(tampered, actor(), old.operation_id), /validation/i);
    const wrong = actor(); await f.store.write(async tx => {
      await tx.reserveOperation({id: wrong.operation_id, command: 'eval.artifact.record', request_hash: 'sha256:'+'a'.repeat(64)});
      await tx.completeOperation(wrong.operation_id, JSON.stringify({format: 'patchledger.cli/v1', ok: true, data: {command: 'eval.artifact.record', payload: reference}}));
    });
    await assert.rejects(f.m.freeze({...changed, retained_operations: [{digest, operation_id: wrong.operation_id}]}, actor()), /validation/i);
  } finally {await f.close();}
});
test('one confirmation freezes source, QA, exactly rebound Grader and member; replay and old snapshots remain fixed', async () => {
  const f = await setup(); try {
    const preview = await f.publisher.preview(f.d.id, f.d.version, f.target), who = actor(), done = await f.publisher.publish(f.d.id, f.d.version, f.target, preview.digest, who);
    assert.equal(done.journal?.state, 'published'); assertContract('eval.schema.json', { result_type: 'patchledger.result.eval/v1', command: 'eval.draft.publish', payload: done }); assert.deepEqual(done.journal?.steps.map(s => s.status), ['completed', 'completed', 'completed', 'completed']);
    const again = await f.publisher.publish(f.d.id, f.d.version, f.target, preview.digest, who); assert.deepEqual(again.journal, done.journal);
    const qa = (await f.m.list('qa')).find(q => q.data.source.identity === f.d.identity)!, graders = (await f.m.list('grader')).filter(g => g.data.qa?.id === qa.id); assert.equal(graders.length, 1); assert.equal(graders[0].data.qa?.version, 1);
    const exportPath=join(f.root,'public.json');const packet=await executeQADraft(parseArgs(['eval','draft','export-public',done.id,'--draft-root',f.drafts.root,'--out',exportPath]),f.root,f.store,'fixture-ledger',()=>testAgent) as any;
    assertContract('eval.schema.json',packet);const exported=JSON.parse(readFileSync(exportPath,'utf8'));assert.deepEqual(Object.keys(exported).sort(),['format','instructions','qa','question']);assert.equal(exported.qa.version,1);assert.ok(!JSON.stringify(exported).includes('Correction:'));assert.ok(!JSON.stringify(exported).includes('rubric'));
    const suite = await f.m.show('suite', f.target.suite.id); assert.equal(suite.data.tasks.length, 1); assert.equal(suite.data.tasks[0].graders[0].id, graders[0].id);
    const experiment = await f.m.createExperiment({ suite_id: suite.id }, { name: 'snapshot fixture', description: 'does not run' }, actor()); const frozenSnapshot = await f.m.show('snapshot', experiment.data.snapshot_id);
    const d = await f.drafts.edit(f.d.id, f.d.version, { qa: { rubric: 'New human rubric' }, review: { ...f.d.review, status: 'reviewed' } });
    const nextTarget = { ...f.target, suite: { id: suite.id, version: suite.version }, member: { mode: 'update' as const, id: suite.data.tasks[0].id }, qa: { id: qa.id, version: 1 } };
    const nextPreview = await f.publisher.preview(d.id, d.version, nextTarget); await f.publisher.publish(d.id, d.version, nextTarget, nextPreview.digest, actor());
    assert.equal((await f.m.show('qa', qa.id)).version, 2); assert.equal((await f.m.show('suite', suite.id)).data.tasks[0].id, suite.data.tasks[0].id); assert.deepEqual((await f.m.show('snapshot', frozenSnapshot.id)).data, frozenSnapshot.data);
    rmSync(f.file); const pkg = await f.m.package(done.saved!.digest); assert.equal(pkg.sources[0].evidence[3].kind, 'feedback'); assert.equal(pkg.sources[0].qa.question, handoff().qa.question); assert.equal(f.drafts.view(d.id).provenance.question, 'model_suggestion');
  } finally { await f.close(); }
});
test('receipt lost after Grader commit resumes exact operation without duplicate QA/Grader/member', async () => {
  const f = await setup(); try {
    const original = f.m.publishGrader.bind(f.m); let lost = true; f.m.publishGrader = async (...args) => { const result = await original(...args); if (lost) { lost = false; throw new Error('receipt lost'); } return result; };
    const p = await f.publisher.preview(f.d.id, f.d.version, f.target); await assert.rejects(f.publisher.publish(f.d.id, f.d.version, f.target, p.digest, actor()), /receipt lost/);
    assert.equal(f.drafts.load(f.d.id).journal?.steps.at(-1)?.status, 'pending'); rmSync(f.file);
    const done = await f.publisher.resume(f.d.id); assert.equal(done.journal?.state, 'published'); assert.equal((await f.m.list('grader')).length, 2); assert.equal((await f.m.show('suite', f.target.suite.id)).data.tasks.length, 1);
  } finally { await f.close(); }
});
test('suite conflict new confirmation retains successful steps and unrelated members; deleted update does not become add', async () => {
  const f = await setup(); try {
    const p = await f.publisher.preview(f.d.id, f.d.version, f.target), original = f.m.publishGrader.bind(f.m);
    f.m.publishGrader = async (...args) => { const g = await original(...args); await f.m.changeTask(f.target.suite.id, 1, { type: 'add', task: { kind: 'qa', name: 'Other member', qa: g.data.qa!, graders: [{ id: g.id, version: g.version }] } }, actor()); return g; };
    await assert.rejects(f.publisher.publish(f.d.id, f.d.version, f.target, p.digest, actor()), /version/i);
    const before = f.drafts.load(f.d.id), old = before.journal!.steps.at(-1)!; assert.equal(old.status, 'rejected'); assert.equal(before.journal!.state, 'conflict'); assert.equal(await f.m.replay(old.operation_id), undefined);
    const changed = { ...f.target, suite: { id: f.target.suite.id, version: 2 } }; const preview = await f.publisher.preview(f.d.id, f.d.version, changed); const done = await f.publisher.publish(f.d.id, f.d.version, changed, preview.digest, actor());
    assert.equal(done.journal!.steps.at(-1)!.replaces, old.operation_id); assert.equal(done.journal!.steps.filter(s => s.name === 'qa').length, 1); assert.equal((await f.m.show('suite', f.target.suite.id)).data.tasks.length, 2);
    assert.equal((await f.m.list('grader')).length, 2);
    await assert.rejects(f.publisher.preview(f.d.id, f.d.version, { ...changed, suite: { id: changed.suite.id, version: 3 }, member: { mode: 'update', id: newUUIDv7() } }), (e: any) => e.code === 'VALIDATION_ERROR' && e.details.field === 'member');
  } finally { await f.close(); }
});
test('history 10 versus current 20 needs an accessible fixed channel; private date/revision and copying old answer fail', async () => {
  const f = await setup(); try {
    const base = { ...f.d.review, knowledge: 'historical' as const }; let d = await f.drafts.edit(f.d.id, f.d.version, { review: base }); await assert.rejects(f.publisher.preview(d.id, d.version, f.target), /validation/i);
    d = await f.drafts.edit(d.id, d.version, { qa: { question: 'What was the concurrency limit in commit abc?', instructions: 'Use document commit abc in the read-only environment.' }, review: { ...base, answer_conditions: { accessible: true, locator: 'git:doc@abc', instructions: 'Use document commit abc in the read-only environment.', preserves_question: true } } });
    assert.ok((await f.publisher.preview(d.id, d.version, f.target)).digest);
    d = await f.drafts.edit(d.id, d.version, { qa: { reference_answer: 'The limit was 10.', question: 'The limit was 10. Repeat it.' }, review: { ...base, answer_conditions: { accessible: true, locator: 'git:doc@abc', instructions: 'Use document commit abc in the read-only environment.', preserves_question: true } } }); await assert.rejects(f.publisher.preview(d.id, d.version, f.target), /validation/i);
  } finally { await f.close(); }
});
test('historical actual answers remain private when reference_answer is absent or cleared', async () => {
  for (const reference_answer of [undefined, '']) for (const field of ['question', 'instructions'] as const) {
    const f = await setup(); try {
      const fixed = 'Use the fixed document commit abc in the read-only environment.';
      const qa = {question: 'What was the concurrency limit in commit abc?', instructions: fixed,
        ...(reference_answer === undefined ? {} : {reference_answer})};
      qa[field] += ' The limit is 10. Repeat this historical answer.';
      const d = await f.drafts.edit(f.d.id, f.d.version, {qa, review: {...f.d.review, knowledge: 'historical',
        answer_conditions: {accessible: true, locator: 'git:doc@abc', instructions: fixed, preserves_question: true}}});
      await assert.rejects(f.publisher.preview(d.id, d.version, f.target), (e: any) => e.details.field === 'answer_conditions');
      assert.equal((await f.m.list('qa')).length, 1);
      assert.equal((await f.m.show('suite', f.target.suite.id)).data.tasks.length, 0);
    } finally {await f.close();}
  }
});
test('explicit source save receipt recovery survives eviction and can be retried with the original operation', async () => {
  const f = await setup(); try {
    const freeze = f.m.freeze.bind(f.m); let lost = true; f.m.freeze = async (...args) => { const result = await freeze(...args); if (lost) { lost = false; throw new Error('source receipt lost'); } return result; };
    const who = actor(); await assert.rejects(f.publisher.saveSource(f.d.id, f.d.version, who), /source receipt lost/);
    await assert.rejects(f.drafts.edit(f.d.id, f.d.version, { qa: { question: 'unsafe overwrite' } }), (e: any) => e.code === 'VALIDATION_ERROR');
    rmSync(f.file); const resumed = await f.publisher.saveSource(f.d.id, f.d.version, who); assert.ok(resumed.source_package.digest); assert.equal(resumed.draft.version, f.d.version + 1);
    const repeated = await f.publisher.saveSource(f.d.id, f.d.version, who); assert.equal(repeated.draft.version, resumed.draft.version);
    const shown = await execute(['eval', 'draft', 'show', f.d.id, '--draft-root', f.drafts.root]) as any; assert.equal(shown.payload.qa.question, handoff().qa.question); assert.equal(shown.payload.missing.length, 1); assertContract('eval.schema.json', shown);
  } finally { await f.close(); }
});
test('saved source can seed a new revision after expiry; unretained material and false completeness cannot publish', async () => {
  const f = await setup(); try {
    const kept = await f.publisher.saveSource(f.d.id, f.d.version, actor()); rmSync(f.file);
    const d = await f.drafts.edit(f.d.id, kept.draft.version, { qa: { rubric: 'Rechecked stable rule' }, review: { ...f.d.review, status: 'reviewed' } });
    const actualNow = Date.now; const shifted = actualNow() + 2 * 86400000; Date.now = () => shifted;
    let preview, done; try { preview = await f.publisher.preview(d.id, d.version, f.target); done = await f.publisher.publish(d.id, d.version, f.target, preview.digest, actor()); } finally { Date.now = actualNow; }
    assertContract('eval.schema.json', { result_type: 'patchledger.result.eval/v1', command: 'eval.draft.preview', payload: preview });
    assert.equal(done.journal?.state, 'published'); assert.ok((await f.m.package(done.saved!.digest)).retained_from?.includes(kept.source_package.digest));
    const material = handoff('missing-query'); material.evidence = material.evidence.filter(e => e.kind !== 'query'); const file = join(f.root, 'missing.json'); writeFileSync(file, JSON.stringify(material)); let bad = await f.drafts.import(file); bad = await f.drafts.edit(bad.id, bad.version, { review: f.d.review }); const latest = await f.m.show('suite', f.target.suite.id);
    await assert.rejects(f.publisher.preview(bad.id, bad.version, { ...f.target, suite: { id: latest.id, version: latest.version } }), (e: any) => e.code === 'VALIDATION_ERROR' && e.details.field === 'materials');
  } finally { await f.close(); }
});
test('preview binds current human edits and the exact target, and cancellation never discards unknown results', async () => {
  const f = await setup(); try {
    const p = await f.publisher.preview(f.d.id, f.d.version, f.target); const edited = await f.drafts.edit(f.d.id, f.d.version, { qa: { question: 'Edited question' }, review: f.d.review });
    await assert.rejects(f.publisher.publish(edited.id, edited.version, f.target, p.digest, actor()), (e: any) => e.code === 'VALIDATION_ERROR' && e.details.field === 'confirmation');
    const good = await f.publisher.preview(edited.id, edited.version, f.target), publish = f.m.publishQA.bind(f.m); f.m.publishQA = async (...args) => { await publish(...args); throw new Error('QA commit result unknown'); };
    await assert.rejects(f.publisher.publish(edited.id, edited.version, f.target, good.digest, actor()), /result unknown/); await assert.rejects(f.publisher.cancel(edited.id, edited.version), (e: any) => e.code === 'VALIDATION_ERROR' && e.details.field === 'cancel');
    const done = await f.publisher.resume(edited.id); assert.equal(done.journal?.state, 'published');
  } finally { await f.close(); }
});
test('local multi-draft recovery completes exact split records before subsequent reads', async () => {
  const f = await setup(); try {
    const children = await f.drafts.split(f.d.id, f.d.version, [{ question: 'A' }, { question: 'B' }]), old = f.drafts.load(f.d.id);
    writeFileSync(join(f.drafts.root, 'transaction.json'), JSON.stringify({ format: 'grounds.qa-draft-transaction/v1', drafts: [old, ...children] })); rmSync(f.drafts.path(children[1].id));
    const result = await execute(['eval', 'draft', 'list', '--draft-root', f.drafts.root]) as any; assert.equal(result.payload.drafts.length, 3); assert.equal(f.drafts.load(children[1].id).identity, children[1].identity); assert.equal(f.drafts.load(old.id).state, 'replaced');
  } finally { await f.close(); }
});
test('late feedback joins a saved source without losing human edits or resurrecting expired automatic copies',async()=>{
  const f=await setup();try{
    let d=await f.drafts.edit(f.d.id,f.d.version,{qa:{question:'Human-reviewed stable rule',reference_answer:''},review:f.d.review});
    const saved=await f.publisher.saveSource(d.id,d.version,actor());d=saved.draft;rmSync(f.file);
    const later=handoff(undefined,'r2');later.qa.question='New model proposal';later.evidence=later.evidence.filter(e=>e.kind==='feedback');later.completeness.question='missing';later.completeness.query='missing';later.completeness.answer='missing';const path=join(f.root,'feedback.json');writeFileSync(path,JSON.stringify(later));
    d=await f.drafts.import(path);d=await f.drafts.acceptSuggestion(d.id,d.version,d.suggestions[0].digest,d.id,d.version);
    assert.equal(f.drafts.view(d.id).qa.question,'Human-reviewed stable rule');assert.equal(f.drafts.view(d.id).qa.reference_answer,undefined);
    d=await f.drafts.edit(d.id,d.version,{review:f.d.review});const preview=await f.publisher.preview(d.id,d.version,f.target),done=await f.publisher.publish(d.id,d.version,f.target,preview.digest,actor());
    const pkg=await f.m.package(done.saved!.digest);assert.equal(pkg.sources.length,2);assert.equal(pkg.sources[0].revision,'r2');assert.equal(pkg.sources[0].evidence[0].kind,'feedback');assert.ok(pkg.retained_from?.includes(saved.source_package.digest));
    const qa=(await f.m.list('qa')).find(q=>q.data.source.identity===d.identity)!;assert.equal(qa.data.question,'Human-reviewed stable rule');assert.equal(qa.data.reference_answer,undefined);assert.ok(!JSON.stringify(qa.data.source.record).includes('Correction: historical'));
  }finally{await f.close();}
});
test('split successors inherit fixed source references after cache eviction',async()=>{
  const f=await setup();try{
    const saved=await f.publisher.saveSource(f.d.id,f.d.version,actor());rmSync(f.file);
    const [child]=await f.drafts.split(saved.draft.id,saved.draft.version,[{question:'Independent sub-question A'},{question:'Independent sub-question B'}]);
    assert.equal(child.retained_packages?.[0].digest,saved.source_package.digest);let reviewed=await f.drafts.edit(child.id,child.version,{review:f.d.review});
    const preview=await f.publisher.preview(reviewed.id,reviewed.version,f.target);const done=await f.publisher.publish(reviewed.id,reviewed.version,f.target,preview.digest,actor());assert.equal(done.journal?.state,'published');assert.notEqual(done.identity,f.d.identity);assert.equal((await f.m.package(done.saved!.digest)).sources[0].identity,f.d.identity);
  }finally{await f.close();}
});
test('evidence locators include source revision so repeated native message ids remain readable',async()=>{
  const f=await setup();try{
    const later=join(f.root,'r2.json');writeFileSync(later,JSON.stringify(handoff(undefined,'r2')));let d=await f.drafts.import(later);d=await f.drafts.acceptSuggestion(d.id,d.version,d.suggestions[0].digest,d.id,d.version);d=await f.drafts.edit(d.id,d.version,{review:f.d.review});
    const p=await f.publisher.preview(d.id,d.version,f.target),done=await f.publisher.publish(d.id,d.version,f.target,p.digest,actor());const manifest=await f.m.manifest(done.saved!.digest);
    assert.equal(new Set(manifest.evidence.map(e=>e.name)).size,manifest.evidence.length);
    for(const e of manifest.evidence){const read=await f.m.file(manifest.digest,e.name);assert.equal(read.digest,e.digest);}
  }finally{await f.close();}
});
test('an unchanged published draft reuses its exact QA and Grader when explicitly added to another suite',async()=>{
  const f=await setup();try{
    const first=await f.publisher.preview(f.d.id,f.d.version,f.target);
    const published=await f.publisher.publish(f.d.id,f.d.version,f.target,first.digest,actor());
    const qaStep=published.journal!.steps.find(s=>s.name==='qa')!.result as any;
    const graderStep=published.journal!.steps.find(s=>s.name==='grader')!.result as any;
    const suite=await f.m.createSuite('Another reviewed collection',actor());
    const next={...f.target,suite:{id:suite.id,version:suite.version}};
    await assert.rejects(f.publisher.preview(f.d.id,f.d.version,next),/validation/i);
    rmSync(f.file);
    const exact={...next,qa:{id:qaStep.id,version:qaStep.version}};
    const preview=await f.publisher.preview(f.d.id,f.d.version,exact);
    assert.equal(preview.source_package.digest,published.saved!.digest);
    const done=await f.publisher.publish(f.d.id,f.d.version,exact,preview.digest,actor());
    assert.equal((done.journal!.steps.find(s=>s.name==='qa')!.result as any).version,qaStep.version);
    assert.equal((done.journal!.steps.find(s=>s.name==='grader')!.result as any).id,graderStep.id);
    assert.equal((await f.m.list('grader')).length,2);
    assert.equal((await f.m.show('suite',suite.id)).data.tasks[0].qa?.version,qaStep.version);
  }finally{await f.close();}
});
test('blank or uncovered core evidence cannot preview or publish even with reviewed complete-looking QA', async () => {
  for (const kind of ['question', 'query', 'answer']) for (const body of ['', ' \n\t ']) {
    const f = await setup(); try {
      const packet = handoff('blank:' + kind), e = packet.evidence.find(x => x.kind === kind)!;
      e.content = body; e.digest = sha256Bytes(Buffer.from(body));
      const file = join(f.root, 'blank.json'); writeFileSync(file, JSON.stringify(packet));
      let d = await f.drafts.import(file); d = await f.drafts.edit(d.id, d.version, { review: f.d.review });
      await assert.rejects(f.publisher.preview(d.id, d.version, f.target), (error: any) => error.details.field === 'materials' && error.details.reason.includes(kind));
      await assert.rejects(f.publisher.publish(d.id, d.version, f.target, 'sha256:' + '0'.repeat(64), actor()), (error: any) => error.details.field === 'materials');
      assert.equal(f.drafts.load(d.id).journal, undefined); assert.equal((await f.m.list('qa')).length, 1);
      assert.equal((await f.m.list('grader')).length, 1); assert.equal((await f.m.show('suite', f.target.suite.id)).data.tasks.length, 0);
    } finally { await f.close(); }
  }
  const f = await setup(); try {
    for (const coverage of ['missing', 'unknown', 'not_applicable']) {
      const p = handoff('coverage:' + coverage); p.completeness.answer = coverage;
      const file = join(f.root, coverage + '.json'); writeFileSync(file, JSON.stringify(p));
      let d = await f.drafts.import(file); d = await f.drafts.edit(d.id, d.version, { review: f.d.review });
      await assert.rejects(f.publisher.preview(d.id, d.version, f.target), (e: any) => e.details.field === 'materials');
    }
  } finally { await f.close(); }
});
test('numeric historical answer is not a substring of dates, declared source paths or commit digests', async () => {
  const f = await setup(); try {
    const locator = 'file:///capture/2026-10-13/specification.md', hash = 'a10' + 'b'.repeat(37);
    const conditions = `Read fixed source ${locator} at commit ${hash}.`;
    let d = await f.drafts.edit(f.d.id, f.d.version, { qa: { reference_answer: '10', question: 'What was the limit on 2026-10-13?', instructions: conditions }, review: { ...f.d.review, knowledge: 'historical', answer_conditions: { accessible: true, locator, instructions: conditions, preserves_question: true } } });
    assert.ok((await f.publisher.preview(d.id, d.version, f.target)).digest);
    for (const question of ['请查询2026-10-13服务A的历史上限。', '2026-10-13服务A上限是多少？', '服务A在2026-10-13T00:00:00Z时的上限是多少？']) {
      d = await f.drafts.edit(d.id, d.version, {qa: {question}, review: d.review});
      assert.ok((await f.publisher.preview(d.id, d.version, f.target)).digest);
    }
    for (const leaked of ['The historical limit is 10.', '旧上限为10。', 'The historical limit is 10.0.', '{"limit":10}', '2026-10-13服务A的历史上限为10。']) {
      d = await f.drafts.edit(d.id, d.version, { qa: { question: leaked }, review: d.review });
      await assert.rejects(f.publisher.preview(d.id, d.version, f.target), (error: any) => error.details.field === 'answer_conditions');
    }
    d = await f.drafts.edit(d.id, d.version, { qa: { question: 'What was the limit?', instructions: conditions + ' The actual limit is 10.' }, review: d.review });
    await assert.rejects(f.publisher.preview(d.id, d.version, f.target), (error: any) => error.details.field === 'answer_conditions');
    d = await f.drafts.edit(d.id, d.version, { qa: { question: 'What was the limit?', instructions: conditions }, review: { ...d.review, answer_conditions: undefined } });
    await assert.rejects(f.publisher.preview(d.id, d.version, f.target), (error: any) => error.details.field === 'answer_conditions');
  } finally { await f.close(); }
});
test('explicit pending scoring or authority remains editable as a draft but cannot be published', async () => {
  const f = await setup(); try {
    let d = await f.drafts.edit(f.d.id, f.d.version, {qa: {rubric: 'TODO: 待补评分标准'}, review: {...f.d.review, authority: '合成审核，评分依据仍待补'}});
    await assert.rejects(f.publisher.preview(d.id, d.version, f.target), (e: any) => ['rubric', 'review.authority'].includes(e.details.field));
    d = await f.drafts.edit(d.id, d.version, {qa: {rubric: '依据固定规范检查规则和例外。'}, review: d.review});
    await assert.rejects(f.publisher.preview(d.id, d.version, f.target), (e: any) => e.details.field === 'review.authority');
    for (const placeholder of ['TODO', '**TBD**', '待补充', 'TODO: 待补评分标准', '评分标准仍待补', 'TODO：补充评分标准。', 'FIXME: 填写评分依据', 'TBD: 完善 rubric']) {
      d = await f.drafts.edit(d.id, d.version, {qa: {rubric: placeholder}, review: f.d.review});
      await assert.rejects(f.publisher.preview(d.id, d.version, f.target), (e: any) => e.details.field === 'rubric');
    }
    d = await f.drafts.edit(d.id, d.version, {qa: {rubric: 'TODO应用应正确处理待办项新增、完成和删除；按固定规范检查。'}, review: f.d.review});
    assert.ok((await f.publisher.preview(d.id, d.version, f.target)).digest);
    d = await f.drafts.edit(d.id, d.version, {qa: {rubric: '解释UI为何显示评分依据仍待补'}, review: f.d.review});
    assert.ok((await f.publisher.preview(d.id, d.version, f.target)).digest);
    d = await f.drafts.edit(d.id, d.version, {qa: {reference_answer: 'TODO: 待补参考答案'}, review: f.d.review});
    await assert.rejects(f.publisher.preview(d.id, d.version, f.target), (e: any) => e.details.field === 'reference_answer');
    d = await f.drafts.edit(d.id, d.version, {qa: {reference_answer: ''}, review: f.d.review});
    assert.ok((await f.publisher.preview(d.id, d.version, f.target)).digest);
    d = await f.drafts.edit(d.id, d.version, {qa: {reference_answer: 'TBD'}, review: f.d.review});
    assert.ok((await f.publisher.preview(d.id, d.version, f.target)).digest);
  } finally {await f.close();}
});
