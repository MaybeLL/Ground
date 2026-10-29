import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EvalModule } from '../src/eval-module.js';
import { newUUIDv7 } from '../src/identity.js';
import type { Store, Tx } from '../src/store-types.js';
import { LedgerFixture, testAgent } from './fixture.js';

const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
async function setup(f: LedgerFixture) {
  const evals = new EvalModule(f.store);
  const issue = { id: f.issue.issue_id, version: 1 };
  const grader = await evals.publishGrader({ format: 'patchledger.eval-grader/v1', issue, name: 'Behavior', scope: { kind: 'diagnostic', name: 'Behavior' }, result_spec: { kind: 'decision' }, definition: { type: 'agent', instructions: 'Test behavior first.' }, limitations: 'Uncalibrated' }, actor());
  const empty = await evals.createSuite('Lifecycle', actor());
  const suite = await evals.changeTask(empty.id, 1, { type: 'add', task: { name: 'Develop', issue, graders: [{ id: grader.id, version: 1 }] } }, actor());
  const experiment = await evals.createExperiment({ suite_id: suite.id }, { name: 'Agent', description: 'Lifecycle fixture' }, actor());
  return { evals, input: { experiment_id: experiment.id, task_id: suite.data.tasks[0].id } };
}

/** Inject only the failing transaction dependency; rollback remains real SQLite. */
function withTransactionFault(store: Store, override: (tx: Tx) => Tx): Store {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'write') return (action: (tx: Tx) => Promise<unknown>) => target.write(tx => action(override(tx)));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('Eval finish retains an ordinary DevRun abandonment reason and terminal time', async () => {
  const f = await LedgerFixture.create();
  try {
    const { evals, input } = await setup(f);
    const run = await evals.startRun(input, actor());
    await f.module.abandonDevRun({ ...actor(), dev_run_id: run.data.dev_run_id!, expected_version: 1, reason: 'Dependency has no supported implementation seam' });
    const result = await evals.finishRun(run.id, actor());
    assert.equal(result.data.reason, 'Dependency has no supported implementation seam');
    assert.equal(result.data.graders[0].missing_reason, result.data.reason);
    assert.equal(result.data.development_duration.kind, 'measured');
    const events = await f.store.read(tx => tx.listLedgerEventsPage(0, '', 'dev_run', run.data.dev_run_id!, 100));
    const abandoned = events.rows.filter(e => e.event_type === 'devrun.abandoned');
    assert.equal(abandoned.length, 1);
    if (result.data.development_duration.kind !== 'unknown') {
      assert.equal(result.data.development_duration.finished_at, abandoned[0].occurred_at);
    }
    assert.deepEqual(await evals.finishRun(run.id, actor()), result);
    assert.equal((await f.store.inspectIntegrity()).report.valid, true);
  } finally { await f.close(); }
});

test('EvalRun storage failure rolls back its DevRun and lifecycle event together', async () => {
  const f = await LedgerFixture.create();
  try {
    const { evals, input } = await setup(f);
    const before = await f.module.listDevRuns();
    const fault = new EvalModule(withTransactionFault(f.store, tx => new Proxy(tx, {
      get(target, key) {
        if (key === 'saveEvalRecord') return async () => { throw new Error('Injected EvalRun write failure'); };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
    const who = actor();
    await assert.rejects(fault.startRun(input, who), /Injected EvalRun write failure/);
    assert.deepEqual(await f.module.listDevRuns(), before);
    assert.deepEqual(await evals.list('run', input.experiment_id), []);
    assert.equal((await f.store.inspectIntegrity()).report.valid, true);
    const retried = await evals.startRun(input, who);
    assert.ok(retried.data.dev_run_id);
  } finally { await f.close(); }
});

test('Eval development validates deliverable context before committing its DevRun', async () => {
  const f = await LedgerFixture.create();
  try {
    const { evals, input } = await setup(f);
    const before = await f.module.listDevRuns();
    const fault = new EvalModule(withTransactionFault(f.store, tx => new Proxy(tx, {
      get(target, key) {
        if (key === 'getRequirementRevision') return async (...args: Parameters<Tx['getRequirementRevision']>) => ({ ...await target.getRequirementRevision(...args), summary: 'x'.repeat(9 * 1024 * 1024) });
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
    await assert.rejects(fault.startRun(input, actor()), { code: 'ARTIFACT_TOO_LARGE' });
    assert.deepEqual(await f.module.listDevRuns(), before);
    assert.deepEqual(await evals.list('run', input.experiment_id), []);
  } finally { await f.close(); }
});
