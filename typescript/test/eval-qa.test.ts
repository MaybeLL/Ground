import { assertContract } from './schema-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLStore } from '../src/sql-store.js';
import { EvalModule } from '../src/eval-module.js';
import { sha256, sha256Bytes } from '../src/canonical-json.js';
import { newUUIDv7 } from '../src/identity.js';
import { testAgent } from './fixture.js';
import { renderEvalReport } from '../src/eval-report.js';
const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
const draft = { format: 'grounds.eval-qa/v1', name: 'Business QA', question: 'What is pending?', instructions: 'Answer with sources.', rubric: 'Explain recovery; do not invent an order.', reference_answer: 'PRIVATE ANSWER', required_points: ['Recovery'], forbidden_claims: ['Fixed order'], references: ['source'], source: { identity: 'fixture:q1', repository: 'fixture', revision: 'fixed', path: 'samples.csv', digest: sha256Bytes(Buffer.from('source')), record: { id: 'q1', split: 'holdout' } } };
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'grounds-qa-test-')); const path = join(directory, 'ledger.db'); const store = SQLStore.sqlite(path); await store.initialize('warn');
  const m = new EvalModule(store); const qa = await m.publishQA(draft, actor()); const ref = { id: qa.id, version: qa.version };
  const grader = await m.publishGrader({ format: 'grounds.eval-grader/v1', qa: ref, name: 'Correctness', scope: { kind: 'diagnostic', name: 'Answer quality' }, result_spec: { kind: 'qa_decision' }, definition: { type: 'agent', instructions: 'Use only the frozen packet.' }, limitations: 'Fixture' }, actor());
  const suite = await m.createSuite('QA', actor()); const populated = await m.changeTask(suite.id, 1, { type: 'add', task: { kind: 'qa', name: 'q1', qa: ref, graders: [{ id: grader.id, version: 1 }] } }, actor());
  const experiment = await m.createExperiment({ suite_id: suite.id }, { name: 'Codex + KB', description: 'Test configuration' }, actor());
  return { m, store, path, qa, ref, grader, experiment, input: { experiment_id: experiment.id, task_id: populated.data.tasks[0].id }, close: async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function artifact(runId: string, qa: { id: string; version: number }) {
  const bytes = Buffer.from('evidence\n'.repeat(400000));
  return { files: new Map([['events.jsonl', bytes]]), raw: { format: 'grounds.eval-artifact/v1', run_id: runId, qa, answer: 'Recovery is supported.', citations: [{ content: 'Recovery', locator: 'kb:node/recovery' }], execution: { session_id: 'session-test', started_at: '2026-09-21T00:00:00Z', finished_at: '2026-09-21T00:00:03Z', status: 'completed', exit_code: 0, declared: { model: 'fixture' }, observed: { revision: 3 } }, capture: { coverage: 'partial', limitations: ['Fixture, not live capture'] }, files: [{ name: 'events.jsonl', size: bytes.length, digest: sha256Bytes(bytes) }] } };
}
test('native QA publication rejects unfinished scoring while legacy reads and completed replay stay immutable', async () => {
  const f = await setup(); try {
    const pending = {...draft, rubric: 'TODO: 待补评分标准', source: {...draft.source, identity: 'pending:new'}};
    await assert.rejects(f.m.publishQA(pending, actor()), (e: any) => e.details.field === 'rubric');
    await assert.rejects(f.m.publishQA({...draft, rubric: 'TBD'}, actor(), {id: f.qa.id, expected_version: f.qa.version}), (e: any) => e.details.field === 'rubric');
    await assert.rejects(f.m.publishQA({...draft, rubric: 'TODO：补充评分标准。'}, actor()), (e: any) => e.details.field === 'rubric');
    assert.equal((await f.m.show('qa', f.qa.id)).version, 1);
    // A synthetic historical fixture, not evidence from a prior release.
    const legacyActor = actor(); const legacy = await f.store.write(async tx => {
      const data = {...pending, source: {...pending.source, identity: 'legacy:pending'}};
      const record = {id: newUUIDv7(), kind: 'qa' as const, version: 1, created_at: await tx.now(), attribution: legacyActor.attribution, data};
      await tx.reserveOperation({id: legacyActor.operation_id, command: 'eval.qa.publish', request_hash: sha256({input: {draft: data}, attribution: legacyActor.attribution})});
      await tx.saveEvalRecord(record, 0);
      await tx.appendLedgerEvent({event_id: newUUIDv7(), event_type: 'eval.qa.recorded', event_version: 1, operation_id: legacyActor.operation_id, subject_type: 'eval_qa', subject_id: record.id, subject_version: 1, occurred_at: record.created_at, attribution: legacyActor.attribution, facts: [{name: 'record_digest', value: sha256(record)}]});
      await tx.completeOperation(legacyActor.operation_id, JSON.stringify({format: 'patchledger.cli/v1', ok: true, data: {command: 'eval.qa.publish', payload: record}}));
      return record;
    });
    assert.deepEqual((await f.m.show('qa', legacy.id)).data, legacy.data);
    assert.deepEqual(await f.m.publishQA(legacy.data, legacyActor), legacy);
    await assert.rejects(f.m.publishQA(legacy.data, actor()), (e: any) => e.details.field === 'rubric');
  } finally {await f.close();}
});
test('QA freezes evidence, separates private context, regrades without another answer', async () => {
  const f = await setup(); try {
    const run = await f.m.startRun(f.input, actor()); assert.equal(run.data.mode, 'answer'); assert.ok(!JSON.stringify(await f.m.publicContext(run.id)).includes('PRIVATE'));
    await assert.rejects(f.m.reserveGrader(run.id, f.grader.id, actor()), (e: any) => e.code === 'VALIDATION_ERROR' && /artifact/i.test(JSON.stringify(e.details)));
    const a = artifact(run.id, f.ref); const who = actor(); const frozen = await f.m.submitArtifact(a.raw, a.files, who);
    assert.deepEqual(await f.m.submitArtifact(a.raw, a.files, who), frozen); assert.deepEqual((await f.m.artifactFiles(frozen.id))[0].bytes, a.files.get('events.jsonl'));
    await assert.rejects(f.m.submitArtifact(a.raw, a.files, actor()), (e: any) => e.code === 'VALIDATION_ERROR' && /frozen/i.test(JSON.stringify(e.details))); await assert.rejects(f.m.finishRun(run.id, actor()), (e: any) => e.code === 'VALIDATION_ERROR' && /grader/i.test(JSON.stringify(e.details)));
    const execution = await f.m.reserveGrader(run.id, f.grader.id, actor());
    const gradeBytes = Buffer.from('grading trace');
    const gradeFiles = new Map([['events.jsonl', gradeBytes]]);
    const gradingEvidence = { format: 'grounds.eval-grading-evidence/v1', execution_id: execution.id, context_digest: execution.data.context_digest, execution: { ...a.raw.execution, session_id: 'independent-grading-session' }, capture: a.raw.capture, files: [{ name: 'events.jsonl', size: gradeBytes.length, digest: sha256Bytes(gradeBytes) }] };
    await assert.rejects(f.m.submitGradingEvidence({ ...gradingEvidence, context_digest: sha256Bytes(Buffer.from('wrong')) }, gradeFiles, actor()));
    await assert.rejects(async () => f.m.submitGradingEvidence(gradingEvidence, new Map([['events.jsonl', Buffer.from('bad')]]), actor()));
    await assert.rejects(f.m.submitGradingEvidence({ ...gradingEvidence, execution: a.raw.execution }, gradeFiles, actor()));
    const evidenceActor = actor(); const attached = await f.m.submitGradingEvidence(gradingEvidence, gradeFiles, evidenceActor);
    assert.deepEqual(await f.m.submitGradingEvidence(gradingEvidence, gradeFiles, evidenceActor), attached);
    assertContract('eval.schema.json', { result_type: 'patchledger.result.eval/v1', command: 'eval.grader.evidence-submit', payload: attached });
    assert.deepEqual((await f.m.gradingEvidenceFiles(execution.id))[0].bytes, gradeBytes);
    await assert.rejects(f.m.submitGradingEvidence(gradingEvidence, gradeFiles, actor()));
    const submission = { format: 'grounds.eval-grader-submission/v1', execution_id: execution.id, context_digest: execution.data.context_digest, status: 'completed', outcome: { kind: 'qa_decision', verdict: 'partial' }, explanation: 'Missing details.', evidence: [{ kind: 'observation', content: 'The answer only states recovery.' }] };
    await assert.rejects(f.m.submitGrader({ ...submission, context_digest: sha256Bytes(Buffer.from('wrong')) }, actor()), (e: any) => e.code === 'VALIDATION_ERROR' && /match/i.test(JSON.stringify(e.details))); await f.m.submitGrader(submission, actor());
    const packet = await f.m.qaGradingContext(execution.id); assert.ok(JSON.stringify(packet).includes('PRIVATE ANSWER')); assert.ok(!JSON.stringify(packet).includes('Missing details.')); assert.ok(!JSON.stringify(packet).includes('independent-grading-session')); await assert.rejects(f.m.submitGradingEvidence(gradingEvidence, gradeFiles, actor()));
    const result = await f.m.finishRun(run.id, actor()); assert.equal(result.data.answering_duration_ms, 3000); await assert.rejects(f.m.submitGrader(submission, actor()));
    await assert.rejects(f.m.startRun(f.input, actor()), (e: any) => e.code === 'VALIDATION_ERROR' && /rerun_of/i.test(JSON.stringify(e.details)));
    const regrade = await f.m.startRun({ ...f.input, rerun_of: run.id, artifact_id: frozen.id }, actor()); const re = await f.m.reserveGrader(regrade.id, f.grader.id, actor());
    await f.m.submitGrader({ ...submission, execution_id: re.id, context_digest: re.data.context_digest, outcome: { kind: 'inconclusive', reason: 'Evidence insufficient' } }, actor());
    const rr = await f.m.finishRun(regrade.id, actor()); assert.equal(rr.data.answering_duration_ms, undefined); assert.equal(rr.data.artifact_id, frozen.id);
    const report = await f.m.report(f.experiment.id); assertContract('eval.schema.json', { result_type: 'patchledger.result.eval/v1', command: 'eval.experiment.report', payload: report }); assert.equal(report.tasks[0].runs.length, 2); assert.match(renderEvalReport(report), /partial/); assert.match(renderEvalReport(report), /independent-grading-session/); assert.match(renderEvalReport(report), /unavailable \(not attached\)/); const integrity = (await f.store.inspectIntegrity()).report; assert.equal(integrity.valid, true, JSON.stringify(integrity));
  } finally { await f.close(); }
});
test('QA versions deduplicate; snapshots retain old questions and stopped runs have no judgment', async () => {
  const f = await setup(); try {
    assert.equal((await f.m.publishQA(draft, actor())).id, f.qa.id); await assert.rejects(f.m.publishQA({ ...draft, question: 'Changed?' }, actor()), (e: any) => e.code === 'VALIDATION_ERROR' && /explicit/i.test(JSON.stringify(e.details)));
    assert.equal((await f.m.publishQA({ ...draft, question: 'Changed?' }, actor(), { id: f.qa.id, expected_version: 1 })).version, 2);
    const run = await f.m.startRun(f.input, actor()); assert.equal((await f.m.publicContext(run.id)).question, draft.question); const a = artifact(run.id, f.ref);
    await assert.rejects(f.m.submitArtifact({ ...a.raw, qa: { ...f.ref, version: 2 } }, a.files, actor()), (e: any) => e.code === 'VALIDATION_ERROR' && /version/i.test(JSON.stringify(e.details)));
    await assert.rejects(async () => f.m.submitArtifact(a.raw, new Map([['events.jsonl', Buffer.from('bad')]]), actor()), (e: any) => e.code === 'VALIDATION_ERROR' && /digest/i.test(JSON.stringify(e.details)));
    const result = await f.m.finishRun(run.id, actor(), 'environment blocked'); assert.equal(result.data.graders[0].submission, undefined);
  } finally { await f.close(); }
});
test('schema 15 migration adds QA blobs; missing chunks fail integrity checks', async () => {
  const f = await setup(); try {
    await f.store.close(); const db = new DatabaseSync(f.path); db.exec('DROP TABLE eval_blob_chunks; DROP TABLE eval_blobs; UPDATE schema_metadata SET schema_version = 15;'); db.close(); await f.store.migrate();
    const digest = await f.store.write(tx => tx.putEvalBlob(Buffer.from('saved'))); assert.equal((await f.store.read(tx => tx.getEvalBlob(digest))).toString(), 'saved');
    await f.store.close(); const corrupt = new DatabaseSync(f.path); corrupt.exec('DELETE FROM eval_blob_chunks'); corrupt.close(); await assert.rejects(f.store.read(tx => tx.getEvalBlob(digest)), /missing/);
  } finally { await f.close(); }
});
test('QA failed grading capture rejects quality judgment and corrupt grading blobs fail integrity', async () => {
  const f = await setup(); try {
    const run = await f.m.startRun(f.input, actor()); const a = artifact(run.id, f.ref); await f.m.submitArtifact(a.raw, a.files, actor());
    const execution = await f.m.reserveGrader(run.id, f.grader.id, actor());
    const bytes = Buffer.from('failed grading trace'); const digest = sha256Bytes(bytes);
    const manifest = { format: 'grounds.eval-grading-evidence/v1', execution_id: execution.id, context_digest: execution.data.context_digest, execution: { ...a.raw.execution, session_id: 'failed-grading-session', status: 'error', exit_code: 1 }, capture: { coverage: 'partial', limitations: ['service disconnected'] }, files: [{ name: 'events.jsonl', size: bytes.length, digest }] };
    await f.m.submitGradingEvidence(manifest, new Map([['events.jsonl', bytes]]), actor());
    const submission = { format: 'grounds.eval-grader-submission/v1', execution_id: execution.id, context_digest: execution.data.context_digest, explanation: 'service disconnected', evidence: [{ kind: 'observation', content: 'partial trace' }] };
    await assert.rejects(f.m.submitGrader({ ...submission, status: 'completed', outcome: { kind: 'qa_decision', verdict: 'pass' } }, actor()));
    await f.m.submitGrader({ ...submission, status: 'error' }, actor()); await f.m.finishRun(run.id, actor());
    await assert.rejects(f.m.submitGradingEvidence(manifest, new Map([['events.jsonl', bytes]]), actor()));
    await f.store.close(); const db = new DatabaseSync(f.path); db.prepare('DELETE FROM eval_blob_chunks WHERE digest = ?').run(digest); db.close();
    await assert.rejects(f.m.gradingEvidenceFiles(execution.id));
    assert.equal((await f.store.inspectIntegrity()).report.valid, false);
  } finally { await f.close(); }
});
test('QA regrade may update private materials only while retaining original answer input binding', async () => {
  const f = await setup(); try {
    const run = await f.m.startRun(f.input, actor()); const a = artifact(run.id, f.ref);
    const frozen = await f.m.submitArtifact(a.raw, a.files, actor()); await f.m.finishRun(run.id, actor(), 'answer frozen for later grading');
    const experimentFor = async (ref: { id: string; version: number }) => {
      const grader = await f.m.publishGrader({ ...f.grader.data, qa: ref }, actor());
      const suite = await f.m.createSuite('Updated evaluation', actor());
      const populated = await f.m.changeTask(suite.id, 1, { type: 'add', task: { kind: 'qa', name: 'updated', qa: ref, graders: [{ id: grader.id, version: grader.version }] } }, actor());
      const experiment = await f.m.createExperiment({ suite_id: suite.id }, { name: 'Regrade', description: 'Private evidence update' }, actor());
      return { input: { experiment_id: experiment.id, task_id: populated.data.tasks[0].id, artifact_id: frozen.id }, grader };
    };
    const updated = await f.m.publishQA({ ...draft, rubric: 'Updated private rubric', reference_answer: 'Updated private reference', references: ['frozen reference text'] }, actor(), { id: f.qa.id, expected_version: 1 });
    const target = await experimentFor({ id: updated.id, version: updated.version });
    const regrade = await f.m.startRun(target.input, actor()); const execution = await f.m.reserveGrader(regrade.id, target.grader.id, actor());
    const packet = await f.m.qaGradingContext(execution.id);
    assert.deepEqual(packet.qa_ref, { id: updated.id, version: 2 }); assert.deepEqual(packet.artifact.qa, f.ref);
    assert.equal(packet.qa.rubric, 'Updated private rubric'); assert.equal(packet.qa.reference_answer, 'Updated private reference');
    assertContract('eval.schema.json', { result_type: 'patchledger.result.eval/v1', command: 'eval.grader.context', payload: packet });
    await f.m.submitGrader({ format: 'grounds.eval-grader-submission/v1', execution_id: execution.id, context_digest: execution.data.context_digest, status: 'completed', outcome: { kind: 'qa_decision', verdict: 'pass' }, explanation: 'Updated evidence supports answer', evidence: [{ kind: 'observation', content: 'Updated reference' }] }, actor());
    const result = await f.m.finishRun(regrade.id, actor()); assert.equal(result.data.answering_duration_ms, undefined);
    assert.deepEqual((await f.m.show('artifact', frozen.id)).data.qa, f.ref);
    const report = renderEvalReport(await f.m.report(target.input.experiment_id)); assert.match(report, new RegExp(`QA: ${f.qa.id} v2`)); assert.match(report, new RegExp(`Answer input QA: ${f.qa.id} v1`));
    let version = 2;
    for (const changes of [{ question: 'Different question' }, { instructions: 'Different public instructions' }]) {
      const changed = await f.m.publishQA({ ...draft, ...changes }, actor(), { id: f.qa.id, expected_version: version++ });
      const incompatible = await experimentFor({ id: changed.id, version: changed.version });
      await assert.rejects(f.m.startRun(incompatible.input, actor()));
    }
    const other = await f.m.publishQA({ ...draft, source: { ...draft.source, identity: 'fixture:q2' } }, actor());
    const unrelated = await experimentFor({ id: other.id, version: other.version }); await assert.rejects(f.m.startRun(unrelated.input, actor()));
  } finally { await f.close(); }
});

test('evidence captured with a null token usage submits and reports', async () => {
  // A session that errored before reporting usage records `metrics.usage: null`.
  // eval.schema.json permits that (environmentMetrics.usage -> anyOf [null, object]),
  // so the artifact must be storable and the report must render it.
  const f = await setup(); try {
    const run = await f.m.startRun(f.input, actor());
    const a = artifact(run.id, f.ref);
    const withMetrics = { ...a.raw, metrics: { duration_ms: 12, source: 'codex.turn.completed', usage: null } };
    const stored = await f.m.submitArtifact(withMetrics, a.files, actor());
    assert.equal(stored.data.metrics?.usage, null);
    const report = renderEvalReport(await f.m.report(f.input.experiment_id));
    assert.match(report, /tokens: null/);
  } finally { await f.close(); }
});
