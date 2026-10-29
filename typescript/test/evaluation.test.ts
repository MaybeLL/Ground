import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LedgerFixture, testAgent } from './fixture.js';
import { EvalModule } from '../src/eval-module.js';
import { decodeGrader, decodeSubmission, decodeEvalJSON, type GraderDraft } from '../src/evaluation.js';
import { newUUIDv7 } from '../src/identity.js';
import { interpretGoResult } from '../src/eval-runner.js';
import { renderEvalReport } from '../src/eval-report.js';
import { assertContract } from './schema-fixture.js';
const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
const draft = (f: LedgerFixture): GraderDraft => ({ format: 'patchledger.eval-grader/v1', issue: { id: f.issue.issue_id, version: 1 }, name: 'Behavior', scope: { kind: 'diagnostic', name: 'Public behavior' }, result_spec: { kind: 'decision' }, definition: { type: 'agent', instructions: 'Write table-driven tests first; reason only for aspects that cannot be tested.' }, limitations: 'Not independently calibrated' });
const setup = async (f: LedgerFixture) => {
  const m = new EvalModule(f.store); const grader = await m.publishGrader(draft(f), actor());
  const created = await m.createSuite('Coding KB', actor());
  const suite = await m.changeTask(created.id, 1, { type: 'add', task: { name: 'Implement feature', issue: grader.data.issue, graders: [{ id: grader.id, version: 1 }] } }, actor());
  const experiment = await m.createExperiment({ suite_id: suite.id }, { name: 'No KB', description: 'Same model, no knowledge tools' }, actor());
  return { m, grader, suite, experiment, task: suite.data.tasks[0] };
};

test('Eval suite edits, immutable grader history and experiment snapshot preserve historical bindings', async () => {
  const f = await LedgerFixture.create();
  try {
    const { m, grader, suite, experiment, task } = await setup(f);
    const updated = await m.publishGrader({ ...draft(f), name: 'Updated' }, actor(), { id: grader.id, expected_version: 1 });
    assert.equal(updated.version, 2); assert.equal((await m.show('grader', grader.id, 1)).data.name, 'Behavior');
    await assert.rejects(m.publishGrader(draft(f), actor(), { id: grader.id, expected_version: 1 }));
    await m.changeTask(suite.id, suite.version, { type: 'remove', task_id: task.id }, actor());
    const snapshot = await m.show('snapshot', experiment.data.snapshot_id);
    assert.equal(snapshot.data.tasks.length, 1); assert.equal(snapshot.data.tasks[0].graders[0].version, 1);
    assert.equal((await m.show('suite', suite.id)).data.tasks.length, 0);
    assert.equal((await m.show('suite', suite.id, 2)).data.tasks.length, 1);
    const peer = await m.createExperiment({ snapshot_id: snapshot.id }, { name: 'Graph KB', description: 'Same model with Graph KB' }, actor());
    assert.equal(peer.data.snapshot_id, snapshot.id);
    await assert.rejects(m.createExperiment({ suite_id: suite.id }, { name: 'Empty', description: 'Empty' }, actor()));
    const integrity = (await f.store.inspectIntegrity()).report; assert.equal(integrity.valid, true, JSON.stringify(integrity.issues));
    assertContract('query-results.schema.json', await f.module.listLedger('', '', 'eval_grader', grader.id));
  } finally { await f.close(); }
});

test('Regrade closes exactly once, retains failed verdict and referenced duration, rejects late writes', async () => {
  const f = await LedgerFixture.create();
  try {
    const { m, grader, experiment, task } = await setup(f); const c = await f.submitCandidate();
    const input = { experiment_id: experiment.id, task_id: task.id, candidate_id: c.candidate.candidate_id }; const who = actor();
    const run = await m.startRun(input, who); assert.deepEqual(await m.startRun(input, who), run);
    await assert.rejects(m.startRun(input, actor()));
    await assert.rejects(m.startRun({ ...input, task_id: newUUIDv7() }, who), (e: any) => e.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(m.finishRun(run.id, actor()));
    const e = await m.reserveGrader(run.id, grader.id, actor());
    const submission = { format: 'patchledger.eval-grader-submission/v1', execution_id: e.id, context_digest: e.data.context_digest, status: 'completed', outcome: { kind: 'decision', verdict: 'fail' }, explanation: 'Expected branch missing', evidence: [{ kind: 'test_source', content: 'table-driven unit test source' }, { kind: 'command', content: 'go test: assertion failed' }] };
    const submitActor = actor(); await m.submitGrader(submission, submitActor);
    const results = await Promise.all([m.finishRun(run.id, actor()), m.finishRun(run.id, actor())]);
    assert.equal(results[0].id, results[1].id); const result = results[0];
    assert.equal(result.data.graders[0].submission?.outcome?.kind, 'decision');
    assert.equal(result.data.development_duration.kind, 'referenced');
    assert.equal((await m.list('result', run.id)).length, 1);
    await assert.rejects(m.submitGrader(submission, actor()));
    assert.deepEqual((await m.submitGrader(submission, submitActor)).data.submission, submission, 'network replay remains valid after closure');
    assert.deepEqual(await m.finishRun(run.id, actor()), result);
    const report = await m.report(experiment.id); const markdown = renderEvalReport(report);
    assert.match(markdown, /Verdict: fail/); assert.match(markdown, /referenced/); assert.match(markdown, /table-driven unit test source/);
    assert.ok(!JSON.stringify(report).includes('total_score'));
    assertContract('eval.schema.json#/$defs/report', report);
    const rerun = await m.startRun({ ...input, rerun_of: run.id }, actor());
    const stopped = await m.finishRun(rerun.id, actor(), 'Manual stop');
    assert.equal(stopped.data.graders[0].missing_reason, 'Manual stop');
    assert.equal((await m.report(experiment.id)).tasks[0].runs.length, 2);
    const integrity = (await f.store.inspectIntegrity()).report; assert.equal(integrity.valid, true, JSON.stringify(integrity.issues));
  } finally { await f.close(); }
});

test('Develop mode creates a DevRun, public context excludes private Graders, stop records terminal duration', async () => {
  const f = await LedgerFixture.create();
  try {
    const { m, experiment, task } = await setup(f);
    const run = await m.startRun({ experiment_id: experiment.id, task_id: task.id }, actor());
    const context = await f.module.devRunContext(run.data.dev_run_id!);
    assert.ok(!JSON.stringify(context).includes('Not independently calibrated'));
    await assert.rejects(m.reserveGrader(run.id, task.graders[0].id, actor()));
    await assert.rejects(m.finishRun(run.id, actor()));
    const result = await m.finishRun(run.id, actor(), 'Unable to implement');
    assert.equal(result.data.candidate_id, undefined); assert.equal(result.data.development_duration.kind, 'measured');
    assert.equal((await f.store.read(tx => tx.getDevRun(run.data.dev_run_id!))).state, 'abandoned');
    const integrity = (await f.store.inspectIntegrity()).report; assert.equal(integrity.valid, true, JSON.stringify(integrity.issues));
  } finally { await f.close(); }
});

test('Score scales, evidence and inconclusive outcomes are independently validated', async () => {
  const f = await LedgerFixture.create();
  try {
    const { m, experiment, task, grader } = await setup(f);
    const c = await f.submitCandidate(); const run = await m.startRun({ experiment_id: experiment.id, task_id: task.id, candidate_id: c.candidate.candidate_id }, actor());
    const e = await m.reserveGrader(run.id, grader.id, actor());
    const base = { format: 'patchledger.eval-grader-submission/v1', execution_id: e.id, context_digest: e.data.context_digest, status: 'completed', explanation: 'Reasoning', evidence: [{ kind: 'observation', content: 'Specific code reference' }] };
    await assert.rejects(m.submitGrader({ ...base, outcome: { kind: 'score', value: 5 } }, actor()));
    assert.throws(() => decodeSubmission({ ...base, status: 'error', outcome: { kind: 'decision', verdict: 'fail' } }));
    assert.throws(() => decodeSubmission({ ...base, evidence: [], outcome: { kind: 'decision', verdict: 'pass' } }));
    await m.submitGrader({ ...base, outcome: { kind: 'inconclusive', reason: 'No reliable seam for this implementation' }, evidence: [] }, actor());
    const r = await m.finishRun(run.id, actor()); assert.equal(r.data.graders[0].submission?.outcome?.kind, 'inconclusive');
    const score = decodeGrader({ ...draft(f), result_spec: { kind: 'score', min: 0, max: 5, higher_is_better: true, rubric: '0=opaque; 5=clear, localized responsibilities' } });
    assert.equal(score.result_spec.kind, 'score');
    for (const bad of [{ ...score, extra: true }, { ...score, issue: { ...score.issue, version: null } }, { ...score, result_spec: { kind: 'score', min: 5, max: 0, higher_is_better: true, rubric: 'bad' } }]) assert.throws(() => decodeGrader(bad));
  } finally { await f.close(); }
});

for (const [name, exit, events, expected] of [
  ['pass', 0, [{ Action: 'run', Test: 'TestFeature' }, { Action: 'pass', Test: 'TestFeature' }], 'pass'],
  ['fail', 1, [{ Action: 'run', Test: 'TestFeature' }, { Action: 'fail', Test: 'TestFeature' }], 'fail'],
  ['no match', 0, [{ Action: 'pass' }], 'not_executed'],
  ['skip', 0, [{ Action: 'run', Test: 'TestFeature' }, { Action: 'skip', Test: 'TestFeature' }], 'not_executed'],
  ['compile failure', 1, [{ Action: 'fail' }], 'error'],
  ['incomplete stream', 0, [{ Action: 'run', Test: 'TestFeature' }], 'error'],
] as const) test(`Go grading: ${name}`, () => {
  const r = interpretGoResult('TestFeature', { exit_code: exit, stdout: events.map(e => JSON.stringify(e)).join('\n'), stderr: '' });
  assert.equal(r.outcome?.kind === 'decision' ? r.outcome.verdict : r.status, expected);
});

test('Historical Issue grading and advisory metadata do not rewrite frozen contracts or results', async () => {
  const f = await LedgerFixture.create();
  try {
    const { m, grader, experiment, task } = await setup(f);
    await f.module.reviseIssue({ ...actor(), issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: f.issue.baseline, input: { format: 1, summary: 'New version', goals: [{ statement: 'Other behavior', criteria: ['New criterion'], traces_to: [{ type: 'outcome', ordinal: 1 }] }] } });
    const run = await m.startRun({ experiment_id: experiment.id, task_id: task.id }, actor());
    const dev = await f.store.read(tx => tx.getDevRun(run.data.dev_run_id!)); assert.equal(dev.issue_revision_id,f.issue.issue_revision_id);
    const result = await m.finishRun(run.id,actor(),'Stopped');
    const before = await m.show('grader',grader.id,1); const who=actor();
    const notice = await m.discourageGrader({id:grader.id,version:1},'Missing boundary case',who);
    assert.deepEqual(await m.discourageGrader({id:grader.id,version:1},'Missing boundary case',who),notice);
    assert.deepEqual(await m.show('grader',grader.id,1),before);
    assert.deepEqual(await m.show('result',result.id),result);
    const report=await m.report(experiment.id);assert.equal(report.notices.length,1);assert.match(renderEvalReport(report),/Missing boundary case/);
    await assert.rejects(m.publishGrader({...draft(f),scope:{kind:'criterion',criterion_ids:[newUUIDv7()]}},actor()));
    assertContract('eval.schema.json#/$defs/report',report);
    const integrity=(await f.store.inspectIntegrity()).report;assert.equal(integrity.valid,true,JSON.stringify(integrity.issues));
  } finally {await f.close();}
});


test('Eval JSON rejects duplicate keys, nulls, malformed UTF-8 and YAML-only syntax', () => {
  for (const input of [Buffer.from('{"name":"first","name":"last"}'), Buffer.from('{"name":null}'), Buffer.from([0xff]), Buffer.from('name: yaml')]) assert.throws(() => decodeEvalJSON(input));
  assert.deepEqual(decodeEvalJSON(Buffer.from('{"name":"valid"}')), {name:'valid'});
});

test('Go grading does not call skipped table cases full success', () => {
  const events=[{Action:'run',Test:'TestFeature'},{Action:'skip',Test:'TestFeature/case'},{Action:'pass',Test:'TestFeature'}];
  assert.equal(interpretGoResult('TestFeature',{exit_code:0,stdout:events.map(e=>JSON.stringify(e)).join('\n'),stderr:''}).status,'not_executed');
});
