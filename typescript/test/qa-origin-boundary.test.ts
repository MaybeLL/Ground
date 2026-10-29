import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QADraftStore, type CandidateHandoff } from '../src/qa-candidate.js';
import { sha256Bytes } from '../src/canonical-json.js';
import { assertContract } from './schema-fixture.js';
import { execute } from '../src/cli.js';

function packet(index: number, batch: string, anchor = 'original-C'): CandidateHandoff {
  const identity = `graphkb:${anchor}:${index}`, first = new Date(Date.now() - 1000).toISOString(), expires = new Date(Date.now() + 86400000).toISOString();
  const content = 'Compound original question and observed feedback';
  return { format: 'grounds.qa-candidate/v1', identity, revision: `${batch}:${index}`, project: { id: 'project', first_captured_at: first, expires_at: expires },
    qa: { question: `Extracted question ${index}`, source: { identity, repository: 'project', revision: batch, path: `capture/scope/${anchor}`, digest: sha256Bytes(Buffer.from(batch)), record: { format: 'graphkb.qa-source/v2', scope: 'scope', original_question: anchor, origin_key: sha256Bytes(Buffer.from(anchor)), question_index: index, question_span_digest: sha256Bytes(Buffer.from(`span${index}`)) } } },
    evidence: [{ id: anchor, kind: 'question', locator: `capture:${anchor}`, content, digest: sha256Bytes(Buffer.from(content)), first_captured_at: first, expires_at: expires }],
    relations: { anchor }, extraction: { run_id: 'run', input_digest: sha256Bytes(Buffer.from(batch)) }, limitations: [], completeness: { question: 'complete', query: 'missing', answer: 'missing', feedback: 'unknown', attachments: 'not_applicable', subtasks: 'not_applicable' } };
}
test('bootstrap ownership uses its persisted marker despite UUID order or a backward clock', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-origin-clock-'))), drafts = new QADraftStore(join(root, 'drafts'));
  const originalClock = Date.now, now = originalClock();
  const put = async (index: number, batch = 'initial') => { const p = packet(index, batch), file = join(root, `${index}-${batch}.json`); writeFileSync(file, JSON.stringify(p)); return drafts.import(file); };
  try {
    Date.now = () => now; const first = await put(0);
    Date.now = () => now - 1000; const second = await put(1);
    assert.ok(second.id < first.id); assert.equal(second.state, 'active');
    Date.now = () => now; const third = await put(2);
    assert.equal(third.state, 'active');
    assert.equal((await put(3, 'later')).state, 'boundary_pending');
  } finally {Date.now = originalClock; rmSync(root, {recursive: true, force: true});}
});
test('refresh discoveries retain original ancestry and cannot bypass manual split/merge', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-origin-'))), drafts = new QADraftStore(join(root, 'drafts'));
  const put = async (p: CandidateHandoff) => { const file = join(root, `${p.identity.replaceAll(':', '-')}-${p.revision.replaceAll(':', '-')}.json`); writeFileSync(file, JSON.stringify(p)); return drafts.import(file); };
  try {
    const c = await put(packet(0, 'initial')), d = await put(packet(0, 'initial', 'original-D'));
    const [a, b] = await drafts.split(c.id, c.version, [{ question: 'Human approval question' }, { question: 'Human billing question' }]);
    const e = await drafts.merge([{ id: b.id, version: b.version }, { id: d.id, version: d.version }], { question: 'Human combined billing question' });
    const discoveryPacket = packet(1, 'feedback-refresh');
    const discovery = await put(discoveryPacket);
    assert.equal(discovery.state, 'boundary_pending'); assertContract('qa-draft.schema.json', discovery);
    assert.ok(discovery.boundary?.related_drafts.includes(c.id));
    await assert.rejects(drafts.edit(discovery.id, discovery.version, { qa: { question: 'bypass' } }));
    await assert.rejects(drafts.split(discovery.id, discovery.version, [{}, {}]));
    await assert.rejects(drafts.merge([{ id: discovery.id, version: discovery.version }, { id: a.id, version: a.version }], {}));
    const replay = await put(discoveryPacket);
    assert.equal(replay.version, discovery.version);
    assert.equal(replay.id, discovery.id);
    const resolved = await drafts.resolveBoundary(replay.id, replay.version, { kind: 'existing', target: { id: e.id, version: e.version } });
    assert.equal(resolved.manual.question, 'Human combined billing question');
    assert.equal(drafts.load(discovery.id).state, 'replaced');
    assert.equal(drafts.load(a.id).manual.question, 'Human approval question');
    assert.ok(resolved.suggestions.some(r => r.identity === discovery.identity));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a later batch cannot bootstrap its second discovery and origin metadata survives deleted evidence', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-origin-'))), drafts = new QADraftStore(join(root, 'drafts'));
  const put = async (p: CandidateHandoff) => { const file = join(root, `${p.identity.replaceAll(':', '-')}-${p.revision.replaceAll(':', '-')}.json`); writeFileSync(file, JSON.stringify(p)); return drafts.import(file); };
  try {
    const original = await put(packet(0, 'initial'));
    rmSync(original.automatic[0].file);
    const later1 = await put(packet(1, 'later')), later2 = await put(packet(2, 'later'));
    assert.equal(later1.state, 'boundary_pending'); assert.equal(later2.state, 'boundary_pending');
    assert.ok(later2.boundary?.related_drafts.includes(original.id));
    const listed = await execute(['eval', 'draft', 'list', '--state', 'boundary_pending', '--draft-root', drafts.root]) as any;
    assertContract('eval.schema.json', listed); assert.equal(listed.payload.drafts.length, 2);
    const input = join(root, 'decision.json'); writeFileSync(input, JSON.stringify({kind: 'new'}));
    const result = await execute(['eval', 'draft', 'resolve-boundary', later1.id, '--expected-version', String(later1.version), '--file', input, '--draft-root', drafts.root]) as any;
    assertContract('eval.schema.json', result); assert.equal(result.payload.state, 'active');
    await assert.rejects(drafts.resolveBoundary(later2.id, later2.version, {kind: 'existing', target: {id: later1.id, version: later1.version}}), /version/i);
    assert.equal(drafts.load(later2.id).state, 'boundary_pending');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('manual review permanently closes bootstrap even after a later edit resets review to pending', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-origin-'))), drafts = new QADraftStore(join(root, 'drafts'));
  try {
    const firstFile = join(root, 'first.json'); writeFileSync(firstFile, JSON.stringify(packet(0, 'initial')));
    let d = await drafts.import(firstFile);
    d = await drafts.edit(d.id, d.version, {review: {...d.review, status: 'reviewed'}});
    d = await drafts.edit(d.id, d.version, {qa: {rubric: 'Additional human review'}});
    assert.equal(d.review.status, 'pending');
    const nextFile = join(root, 'second.json'); writeFileSync(nextFile, JSON.stringify(packet(1, 'initial')));
    const next = await drafts.import(nextFile); assert.equal(next.state, 'boundary_pending');
    await assert.rejects(drafts.acceptSuggestion(next.id, next.version, 'absent', d.id, d.version), /boundary|validation/i);
  } finally {rmSync(root, {recursive: true, force: true});}
});
test('initial multi-question batch is allowed; later omitted-question discovery requires explicit new boundary', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-origin-'))), drafts = new QADraftStore(join(root, 'drafts'));
  const put = async (p: CandidateHandoff) => { const file = join(root, `${p.identity.replaceAll(':', '-')}-${p.revision.replaceAll(':', '-')}.json`); writeFileSync(file, JSON.stringify(p)); return drafts.import(file); };
  try {
    const first = await put(packet(0, 'initial')), second = await put(packet(1, 'initial'));
    assert.equal(first.state, 'active'); assert.equal(second.state, 'active');
    const later = await put(packet(2, 'later'));
    assert.equal(later.state, 'boundary_pending');
    const activated = await drafts.resolveBoundary(later.id, later.version, { kind: 'new' });
    assert.equal(activated.state, 'active'); assert.equal(activated.review.status, 'pending');
    assert.equal(activated.automatic[0].project.expires_at, later.automatic[0].project.expires_at);
    assert.ok(activated.lineage.some(l => l.action === 'confirm_new_boundary'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
