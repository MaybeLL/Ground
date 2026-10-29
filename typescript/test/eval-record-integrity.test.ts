import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLStore } from '../src/sql-store.js';
import { sha256 } from '../src/canonical-json.js';
import { newUUIDv7 } from '../src/identity.js';
import { validateEvalRecord, type EvalRecord } from '../src/evaluation.js';
import { testAgent } from './fixture.js';

const id = () => newUUIDv7();
const issue = { id: id(), version: 1 };
const grader = { id: id(), version: 1 };
const task = { id: id(), name: 'Implement behavior', issue, graders: [grader] };
const runId = id();
const experimentId = id();
const executionId = id();
const contextDigest = sha256({ candidate: 'fixed' });
const submission = {
  format: 'patchledger.eval-grader-submission/v1', execution_id: executionId, context_digest: contextDigest,
  status: 'completed', outcome: { kind: 'decision', verdict: 'pass' }, explanation: 'Test assertions passed',
  evidence: [{ kind: 'command', content: 'go test output' }],
};
const record = (kind: string, data: object, parent_id?: string, recordId = id()) => ({
  id: recordId, kind, version: 1, created_at: '2026-09-10T00:00:00.000Z', attribution: testAgent,
  ...(parent_id ? { parent_id } : {}), data,
});
const run = () => record('run', { experiment_id: experimentId, task, mode: 'develop', state: 'open', dev_run_id: id() }, experimentId);
const execution = () => record('execution', {
  run_id: runId, grader, candidate_id: id(), result_tree_oid: 'sha1:' + '1'.repeat(40), context_digest: contextDigest, submission,
}, runId, executionId);
const result = () => record('result', {
  run_id: runId, experiment_id: experimentId, task, mode: 'develop', candidate_id: id(),
  development_duration: { kind: 'measured', started_at: '2026-09-10T00:00:00.000Z', finished_at: '2026-09-10T00:00:01.000Z', duration_ms: 1000, source_dev_run_id: id() },
  graders: [{ grader, execution_id: executionId, submission }],
}, runId);

test('persisted Eval validation accepts the valid record shapes without changing JSON', () => {
  const suiteId = id(); const snapshotId = id();
  const records = [
    record('grader', { format: 'patchledger.eval-grader/v1', issue, name: 'Behavior', scope: { kind: 'diagnostic', name: 'Behavior' }, result_spec: { kind: 'decision' }, definition: { type: 'agent', instructions: 'Write and run tests' }, limitations: 'Uncalibrated' }, issue.id),
    record('suite', { name: 'Empty suite is editable', tasks: [] }),
    record('snapshot', { suite: { id: suiteId, version: 1 }, name: 'Frozen suite', tasks: [task] }, suiteId),
    record('experiment', { snapshot_id: snapshotId, subject: { name: 'KB', description: 'Declared setup' } }, snapshotId),
    run(), execution(), result(), record('notice', { grader, reason: 'Incorrect boundary expectation' }, grader.id),
    record('run', { experiment_id: experimentId, task, mode: 'regrade', state: 'closed', candidate_id: id(), result_id: id() }, experimentId),
  ];
  for (const value of records) {
    const before = JSON.stringify(value);
    assert.doesNotThrow(() => validateEvalRecord(value), value.kind);
    assert.equal(JSON.stringify(value), before);
  }
});

const corruptions: { name: string; make: () => ReturnType<typeof record>; change: (value: any) => void }[] = [
  { name: 'develop run without DevRun', make: run, change: r => { delete r.data.dev_run_id; } },
  { name: 'regrade run with development ownership', make: run, change: r => { r.data.mode = 'regrade'; r.data.candidate_id = id(); } },
  { name: 'closed run without result', make: run, change: r => { r.data.state = 'closed'; } },
  { name: 'open run claiming final result', make: run, change: r => { r.data.result_id = id(); } },
  { name: 'unknown state', make: run, change: r => { r.data.state = 'finished'; } },
  { name: 'wrong parent binding', make: run, change: r => { r.parent_id = id(); } },
  { name: 'unknown data field', make: run, change: r => { r.data.total_score = 100; } },
  { name: 'duplicate selected Grader', make: run, change: r => { r.data.task.graders.push(grader); } },
  { name: 'completed execution missing outcome', make: execution, change: r => { delete r.data.submission.outcome; } },
  { name: 'errored execution carrying verdict', make: execution, change: r => { r.data.submission.status = 'error'; } },
  { name: 'submission belonging to another execution', make: execution, change: r => { r.data.submission.execution_id = id(); } },
  { name: 'submission with different context', make: execution, change: r => { r.data.submission.context_digest = sha256({ other: true }); } },
  { name: 'forged duration inconsistent with timestamps', make: result, change: r => { r.data.development_duration.duration_ms = 0; } },
  { name: 'result missing selected check', make: result, change: r => { r.data.graders = []; } },
  { name: 'result substituted Grader version', make: result, change: r => { r.data.graders[0].grader = { ...r.data.graders[0].grader, version: 2 }; } },
  { name: 'result outcome with no Candidate', make: result, change: r => { delete r.data.candidate_id; } },
  { name: 'result mixed submitted and missing check', make: result, change: r => { r.data.graders[0].missing_reason = 'not run'; } },
];

test('SQL Eval reads fail closed on impossible records even when the digest matches', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'grounds-eval-integrity-'));
  const path = join(directory, 'ledger.db'); const store = SQLStore.sqlite(path);
  await store.initialize('warn');
  const raw = new DatabaseSync(path);
  try {
    for (const scenario of corruptions) await t.test(scenario.name, async () => {
      const value = structuredClone(scenario.make()); scenario.change(value);
      // A matching checksum proves bytes only; decoding must still reject impossible states.
      raw.prepare('INSERT INTO eval_records (id, kind, version, parent_id, record_digest, record_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(value.id, value.kind, value.version, value.parent_id ?? null, sha256(value), JSON.stringify(value));
      const integrityError = (error: any) => error.code === 'ARTIFACT_INTEGRITY_ERROR';
      await assert.rejects(store.read(tx => tx.getEvalRecord(value.kind as EvalRecord['kind'], value.id)), integrityError);
      await assert.rejects(store.read(tx => tx.listEvalRecords(value.kind as EvalRecord['kind'])), integrityError);
      raw.prepare('DELETE FROM eval_records WHERE id = ?').run(value.id);
    });
  } finally { raw.close(); await store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('SQL refuses impossible Eval states before inserting a revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grounds-eval-write-'));
  const store = SQLStore.sqlite(join(directory, 'ledger.db')); await store.initialize('warn');
  try {
    const invalid = run(); (invalid.data as any).state = 'closed';
    await assert.rejects(store.write(tx => tx.saveEvalRecord(invalid as EvalRecord<'run'>, 0)), (error: any) => error.code === 'VALIDATION_ERROR');
    assert.deepEqual(await store.read(tx => tx.listEvalRecords('run')), []);
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('persisted timestamps accept ledger fractional precision and reject normalized invalid dates', () => {
  for (const fraction of ['', '.1', '.12', '.123', '.123456', '.123456789']) {
    const value = run(); value.created_at = `2026-09-10T00:00:00${fraction}Z`;
    assert.doesNotThrow(() => validateEvalRecord(value));
  }
  for (const timestamp of ['2026-02-30T00:00:00Z', '2026-09-10T24:00:00Z', '2026-09-10T00:00:00.1234567890Z', '2026-09-10 00:00:00']) {
    const value = run(); value.created_at = timestamp;
    assert.throws(() => validateEvalRecord(value));
  }
});
