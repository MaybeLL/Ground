import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EvalModule } from '../src/eval-module.js';
import { newUUIDv7 } from '../src/identity.js';
import type { Store, Tx } from '../src/store-types.js';
import { SQLStore } from '../src/sql-store.js';
import { LedgerFixture, testAgent } from './fixture.js';
import { isolatedPostgres, postgresEnabled } from './isolated-postgres.js';

const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
const members = (tasks: unknown[]) => ({ format: 'grounds.eval-suite-members/v1', tasks });

test('suite member publication is one atomic, idempotent version with stable member identities', async () => {
  const f = await LedgerFixture.create();
  try {
    const evals = new EvalModule(f.store);
    const issue = { id: f.issue.issue_id, version: 1 };
    const grader = await evals.publishGrader({ format: 'patchledger.eval-grader/v1', issue, name: 'Behavior', scope: { kind: 'diagnostic', name: 'Behavior' }, result_spec: { kind: 'decision' }, definition: { type: 'agent', instructions: 'Check behavior.' }, limitations: 'Fixture' }, actor());
    const binding = [{ id: grader.id, version: 1 }];
    const suite = await evals.createSuite('Atomic', actor());
    const initial = members([{ name: 'First', issue, graders: binding }, { name: 'Second', issue, graders: binding }]);
    const request = actor();
    const published = await evals.publishSuiteTasks(suite.id, 1, initial, request);
    assert.equal(published.version, 2);
    assert.equal(published.data.tasks.length, 2);
    assert.deepEqual(await evals.publishSuiteTasks(suite.id, 1, initial, request), published);
    assert.equal((await evals.show('suite', suite.id)).version, 2);
    await assert.rejects(evals.publishSuiteTasks(suite.id, 1, members([{ name: 'Different', issue, graders: binding }]), request), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(evals.publishSuiteTasks(suite.id, 1, initial, actor()), { code: 'VERSION_CONFLICT' });
    const first = published.data.tasks[0];
    const changed = await evals.publishSuiteTasks(suite.id, 2, members([{ id: first.id, name: 'Updated', issue, graders: binding }, { name: 'Third', issue, graders: binding }]), actor());
    assert.equal(changed.version, 3);
    assert.equal(changed.data.tasks[0].id, first.id);
    assert.notEqual(changed.data.tasks[1].id, published.data.tasks[1].id);
    assert.deepEqual((await evals.show('suite', suite.id, 2)).data.tasks, published.data.tasks);
    await assert.rejects(evals.publishSuiteTasks(suite.id, 3, members(changed.data.tasks), actor()), { code: 'VALIDATION_ERROR' });
    await assert.rejects(evals.publishSuiteTasks(suite.id, 3, members([{ id: first.id, name: 'A', issue, graders: binding }, { id: first.id, name: 'B', issue, graders: binding }]), actor()), { code: 'VALIDATION_ERROR' });
    await assert.rejects(evals.publishSuiteTasks(suite.id, 3, members([{ id: first.id, name: 'Valid', issue, graders: binding }, { name: 'Invalid', issue: { id: newUUIDv7(), version: 1 }, graders: binding }]), actor()));
    assert.equal((await evals.show('suite', suite.id)).version, 3);
    assert.equal((await f.store.inspectIntegrity()).report.valid, true);
  } finally { await f.close(); }
});

const mysqlReady = ['HOST', 'DATABASE', 'USERNAME', 'PASSWORD'].every(key => Boolean(process.env[`GROUNDS_TEST_MYSQL_${key}`]));
// One scenario, every networked backend: the atomic and replay behavior must not depend on the engine.
const suitePublicationScenario = async (f: LedgerFixture, engine: string): Promise<void> => {
  try {
    const evals = new EvalModule(f.store), issue = { id: f.issue.issue_id, version: 1 };
    const grader = await evals.publishGrader({ format: 'patchledger.eval-grader/v1', issue, name: 'Behavior', scope: { kind: 'diagnostic', name: 'Behavior' }, result_spec: { kind: 'decision' }, definition: { type: 'agent', instructions: 'Check behavior.' }, limitations: 'Fixture' }, actor());
    const suite = await evals.createSuite('Atomic', actor()), binding = [{ id: grader.id, version: 1 }];
    const input = members([{ name: 'A', issue, graders: binding }, { name: 'B', issue, graders: binding }]), request = actor();
    const faultyStore = new Proxy(f.store as Store, { get(target, key) { if (key === 'write') return (action: (tx: Tx) => Promise<unknown>) => target.write(tx => action(new Proxy(tx, { get(inner, member) { if (member === 'saveEvalRecord') return async () => { throw new Error(`injected ${engine} failure`); }; const value = Reflect.get(inner, member); return typeof value === 'function' ? value.bind(inner) : value; } }))); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    await assert.rejects(new EvalModule(faultyStore).publishSuiteTasks(suite.id, 1, input, actor()), new RegExp(`injected ${engine} failure`));
    assert.equal((await evals.show('suite', suite.id)).version, 1);
    await assert.rejects(async () => { await evals.publishSuiteTasks(suite.id, 1, input, request); throw new Error('response dropped after commit'); }, /response dropped after commit/);
    const published = await evals.publishSuiteTasks(suite.id, 1, input, request);
    assert.equal(published.version, 2); assert.equal(published.data.tasks.length, 2);
    assert.deepEqual(await evals.publishSuiteTasks(suite.id, 1, input, request), published);
    await assert.rejects(evals.publishSuiteTasks(suite.id, 1, members([{ name: 'Changed', issue, graders: binding }]), request), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(evals.publishSuiteTasks(suite.id, 1, input, actor()), { code: 'VERSION_CONFLICT' });
    await assert.rejects(evals.publishSuiteTasks(suite.id, 2, members([{ ...published.data.tasks[0] }, { name: 'Invalid', issue: { id: newUUIDv7(), version: 1 }, graders: binding }]), actor()));
    assert.equal((await evals.show('suite', suite.id)).version, 2);
    const attempts = await Promise.allSettled([evals.publishSuiteTasks(suite.id, 2, members([{ ...published.data.tasks[0] }]), actor()), evals.publishSuiteTasks(suite.id, 2, members([{ ...published.data.tasks[1] }]), actor())]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await evals.show('suite', suite.id)).version, 3);
  } finally { await f.close(); }
};

test('dedicated MySQL suite publication has the same atomic and replay behavior', { skip: !mysqlReady }, async () => {
  await suitePublicationScenario(await LedgerFixture.createWithStore(SQLStore.mysql({
    host: process.env.GROUNDS_TEST_MYSQL_HOST!, database: process.env.GROUNDS_TEST_MYSQL_DATABASE!,
    username: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!,
    port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306),
    ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE } : {}),
  })), 'MySQL');
});

test('dedicated PostgreSQL suite publication has the same atomic and replay behavior', { skip: !postgresEnabled }, async () => {
  const pg = await isolatedPostgres();
  await suitePublicationScenario(await LedgerFixture.createWithStore(pg.store, pg.cleanup), 'PostgreSQL');
});

test('suite member publication rolls back on storage failure and concurrent expected versions have one winner', async () => {
  const f = await LedgerFixture.create();
  try {
    const evals = new EvalModule(f.store), issue = { id: f.issue.issue_id, version: 1 };
    const grader = await evals.publishGrader({ format: 'patchledger.eval-grader/v1', issue, name: 'Behavior', scope: { kind: 'diagnostic', name: 'Behavior' }, result_spec: { kind: 'decision' }, definition: { type: 'agent', instructions: 'Check behavior.' }, limitations: 'Fixture' }, actor());
    const suite = await evals.createSuite('Atomic', actor());
    const body = members([{ name: 'A', issue, graders: [{ id: grader.id, version: 1 }] }]);
    const faultyStore = new Proxy(f.store as Store, { get(target, key) { if (key === 'write') return (action: (tx: Tx) => Promise<unknown>) => target.write(tx => action(new Proxy(tx, { get(inner, member) { if (member === 'saveEvalRecord') return async () => { throw new Error('injected failure'); }; const value = Reflect.get(inner, member); return typeof value === 'function' ? value.bind(inner) : value; } }))); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    await assert.rejects(new EvalModule(faultyStore).publishSuiteTasks(suite.id, 1, body, actor()), /injected failure/);
    assert.equal((await evals.show('suite', suite.id)).version, 1);
    const attempts = await Promise.allSettled([evals.publishSuiteTasks(suite.id, 1, body, actor()), evals.publishSuiteTasks(suite.id, 1, members([{ name: 'B', issue, graders: [{ id: grader.id, version: 1 }] }]), actor())]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await evals.show('suite', suite.id)).version, 2);
  } finally { await f.close(); }
});
