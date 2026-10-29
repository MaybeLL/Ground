import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LedgerFixture, testAgent } from './fixture.js';
import { EvalModule } from '../src/eval-module.js';
import { executeUnitGrader, FileGraderRecovery, type GraderRecovery } from '../src/eval-runner.js';
import type { GraderSubmission } from '../src/evaluation.js';
import { newUUIDv7 } from '../src/identity.js';

const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
class MemoryRecovery implements GraderRecovery {
  records = new Map<string, GraderSubmission>();
  load(id: string) { return this.records.get(id); }
  save(result: GraderSubmission) { this.records.set(result.execution_id, result); }
  remove(id: string) { this.records.delete(id); }
}
const prepare = async (fixture: LedgerFixture) => {
  const module = new EvalModule(fixture.store);
  const issue = { id: fixture.issue.issue_id, version: 1 };
  const grader = await module.publishGrader({ format: 'patchledger.eval-grader/v1', issue, name: 'Behavior', scope: { kind: 'diagnostic', name: 'Behavior' }, result_spec: { kind: 'decision' }, definition: { type: 'unit_test', adapter: 'go', package: '.', test_name: 'TestBehavior', timeout_seconds: 1, files: [{ path: 'behavior_test.go', content: 'package fixture' }] }, limitations: 'Test fixture' }, actor());
  let suite = await module.createSuite('Fixture', actor());
  suite = await module.changeTask(suite.id, 1, { type: 'add', task: { name: 'Task', issue, graders: [{ id: grader.id, version: 1 }] } }, actor());
  const experiment = await module.createExperiment({ suite_id: suite.id }, { name: 'Fixture', description: 'No model' }, actor());
  const candidate = await fixture.submitCandidate();
  const run = await module.startRun({ experiment_id: experiment.id, task_id: suite.data.tasks[0].id, candidate_id: candidate.candidate.candidate_id }, actor());
  const execution = await module.reserveGrader(run.id, grader.id, actor(), 'execute');
  return { module, work: fixture.module, execution, grader, source: '.', actor: actor() };
};
const passed = { status: 'completed' as const, outcome: { kind: 'decision' as const, verdict: 'pass' as const }, explanation: 'The fixed test passed', evidence: [{ kind: 'command' as const, content: 'go test: passed' }] };

test('ledger submission failure recovers complete evidence without executing Go again', async () => {
  const fixture = await LedgerFixture.create();
  const directory = mkdtempSync(join(tmpdir(), 'eval-recovery-test-'));
  try {
    const request = await prepare(fixture);
    const recovery = new FileGraderRecovery(directory);
    let executions = 0;
    const grade = async () => { executions++; return passed; };
    const offline = { ...request, module: { show: request.module.show.bind(request.module), claimUnitExecution: request.module.claimUnitExecution.bind(request.module), submitGrader: async () => { throw new Error('database unavailable'); } } };
    await assert.rejects(executeUnitGrader(offline, { grade, recovery }), /database unavailable/);
    assert.deepEqual(recovery.load(request.execution.id)?.evidence, passed.evidence);
    const saved = await executeUnitGrader(request, { grade, recovery });
    assert.equal(executions, 1);
    assert.equal(saved.data.submission?.status, 'completed');
    assert.equal(recovery.load(request.execution.id), undefined);
    assert.deepEqual(await executeUnitGrader(request, { grade, recovery }), saved);
    assert.equal(executions, 1);
  } finally { await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('an interrupted claimed execution without evidence cannot silently rerun', async () => {
  const fixture = await LedgerFixture.create();
  try {
    const request = await prepare(fixture);
    await request.module.claimUnitExecution(request.execution.id, actor());
    let executions = 0;
    await assert.rejects(executeUnitGrader(request, { grade: async () => { executions++; return passed; }, recovery: new MemoryRecovery() }), (error: any) => error.details.reason.includes('without recoverable evidence'));
    assert.equal(executions, 0);
    assert.equal((await request.module.show('execution', request.execution.id)).data.submission, undefined);
  } finally { await fixture.close(); }
});

test('adapter failures produce an execution error, while local cleanup cannot undo a saved result', async () => {
  const fixture = await LedgerFixture.create();
  try {
    const request = await prepare(fixture);
    const recovery = new MemoryRecovery();
    recovery.remove = () => { throw new Error('temporary directory locked'); };
    const saved = await executeUnitGrader(request, { grade: async () => { throw new Error('materialization failed'); }, recovery });
    assert.equal(saved.data.submission?.status, 'error');
    assert.equal(saved.data.submission?.outcome, undefined);
    assert.match(saved.data.submission!.explanation, /materialization failed/);
    assert.equal((await request.module.show('execution', saved.id)).version, saved.version);
  } finally { await fixture.close(); }
});

test('recovery from a different context is rejected before any new execution', async () => {
  const fixture = await LedgerFixture.create();
  try {
    const request = await prepare(fixture);
    const recovery = new MemoryRecovery();
    recovery.save({ format: 'patchledger.eval-grader-submission/v1', execution_id: request.execution.id, context_digest: 'sha256:' + '0'.repeat(64), ...passed });
    await assert.rejects(executeUnitGrader(request, { grade: async () => assert.fail('must not execute'), recovery }), (error: any) => error.details.field === 'recovery');
    assert.equal((await request.module.show('execution', request.execution.id)).data.unit_execution_started, undefined);
  } finally { await fixture.close(); }
});
