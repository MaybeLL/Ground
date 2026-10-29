import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCLI, execute } from '../src/cli.js';
import { SQLStore } from '../src/sql-store.js';
import { DomainError } from '../src/errors.js';
import { EnvironmentModule } from '../src/eval-environment-module.js';
import type { EvalKind } from '../src/evaluation.js';
import type { EvalListPage } from '../src/eval-list.js';
import { newUUIDv7 } from '../src/identity.js';
import { sha256, sha256Bytes } from '../src/canonical-json.js';
import { testAgent } from './fixture.js';
import { assertContract } from './schema-fixture.js';
import { isolatedMySQL } from './isolated-mysql.js';
import { isolatedPostgres, postgresEnabled } from './isolated-postgres.js';

const mysqlEnabled = ['HOST', 'DATABASE', 'USERNAME', 'PASSWORD'].every(key => process.env[`GROUNDS_TEST_MYSQL_${key}`]);

const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
const bytes = Buffer.from('[]'); const files = new Map([['manifest.json', bytes]]); const manifest = [{ name: 'manifest.json', size: bytes.length, digest: sha256Bytes(bytes) }];
const adapter = { name: 'grounds-env', version: '1', platform: 'docker' };
const definition = (role: string) => ({ format: 'grounds.eval-environment/v1', name: role, role, task_kind: 'qa', parameters: { kb: { type: 'string', required: true } }, script: { interpreter: '/bin/sh', content: 'echo PRIVATE-SCRIPT-BODY' }, execution: { backend: 'docker', timeout_seconds: 60, network_hosts: [] }, access: { read_roles: [], kb: false, writable_workspace: false } });
const qaDraft = (name: string, identity: string) => ({ format: 'grounds.eval-qa/v1', name, question: 'Question?', instructions: 'Read', rubric: 'Correctness', reference_answer: 'PRIVATE-REFERENCE-ANSWER', required_points: [], forbidden_claims: [], references: ['fixed'], source: { identity, repository: 'fixture', revision: 'v1', path: identity, digest: sha256Bytes(bytes), record: {} } });
const failure = (code: string, field?: string) => (error: unknown) => {
  assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code);
  if (field) assert.equal((error.details as { field?: string }).field, field);
  assertContract('error.schema.json', error.toJSON()); return true;
};

async function fixture(store: SQLStore, cleanup: () => Promise<void>) {
  await store.initialize('warn');
  const m = new EnvironmentModule(store); const bindings: any = {}; const checks: any[] = []; const environments: any[] = [];
  for (const role of ['answer', 'grade']) {
    const record = await m.publishEnvironment(definition(role), actor()); environments.push(record);
    const reference = { id: record.id, version: record.version, digest: sha256(record.data) };
    const check = await m.submitCheck({ format: 'grounds.environment-validation/v1', environment: reference, adapter, parameters: { kb: 'test' }, checks: { success: true, failure: true, protocol: true, isolation: true }, files: manifest }, files, actor()); checks.push(check);
    bindings[role] = { environment: reference, validation: { id: check.id, version: 1 }, parameters: { kb: 'test' }, execution_config: { model: 'fixture', enable_kb: false } };
  }
  const qa1 = await m.publishQA(qaDraft('First QA', 'qa-one'), actor()); const qa2 = await m.publishQA(qaDraft('Second QA', 'qa-two'), actor());
  const ref = (r: { id: string }) => ({ id: r.id, version: 1 });
  const grade = (qa: { id: string }, name: string) => m.publishGrader({ format: 'grounds.eval-grader/v1', qa: ref(qa), name, scope: { kind: 'diagnostic', name: 'quality' }, result_spec: { kind: 'qa_decision' }, definition: { type: 'agent', instructions: 'PRIVATE-GRADER-INSTRUCTIONS' }, limitations: 'test' }, actor());
  const grader1 = await grade(qa1, 'Grader one'); const grader2 = await grade(qa2, 'Grader two');
  const suite = await m.createSuite('Suite', actor());
  const populated = await m.changeTask(suite.id, 1, { type: 'add', task: { kind: 'qa', name: 'task one', qa: ref(qa1), graders: [ref(grader1)] } }, actor());
  const second = await m.changeTask(suite.id, populated.version, { type: 'add', task: { kind: 'qa', name: 'task two', qa: ref(qa2), graders: [ref(grader2)] } }, actor());
  const experiment1 = await m.createExperiment({ suite_id: suite.id }, { name: 'Agent A', description: 'x'.repeat(500), environment: bindings }, actor());
  const experiment2 = await m.createExperiment({ suite_id: suite.id }, { name: 'Agent B', description: 'no runs yet' }, actor());
  const experiment3 = await m.createExperiment({ snapshot_id: experiment1.data.snapshot_id }, { name: 'Agent C', description: 'shares the frozen snapshot' }, actor());
  const tasks = second.data.tasks;
  const run1 = await m.startRun({ experiment_id: experiment1.id, task_id: tasks[0].id }, actor());
  const prepDraft = { format: 'grounds.environment-preparation/v1', environment: bindings.answer.environment, parameters: { kb: 'test' }, adapter, experiment_ids: [experiment1.id], owner: 'fixture', attempt: 1, state: 'registered', duration_ms: 0, files: [] };
  const preparation = await m.submitPreparation(prepDraft, new Map(), actor());
  const instance = await m.submitInstance({ format: 'grounds.environment-instance/v1', run_id: run1.id, role: 'answer', environment: bindings.answer.environment, preparation_id: preparation.id, state: 'registered', attempt: 0, input_digest: sha256(await m.publicContext(run1.id)), validity: 'pending', release: 'pending', duration_ms: 0, files: [] }, new Map(), actor());
  return { m, store, bindings, environments, checks, qa1, qa2, grader1, grader2, suite, experiment1, experiment2, experiment3, tasks, run1, preparation, instance, close: cleanup };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const readAll = async (list: (request: { limit?: number; cursor?: string }) => Promise<EvalListPage>, limit: number): Promise<EvalListPage[]> => {
  const pages: EvalListPage[] = []; let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await list({ limit, ...(cursor ? { cursor } : {}) });
    assertContract('eval-list.schema.json', { ...page, command: `eval.${page.kind}.list` }); pages.push(page);
    if (!page.page.has_more) { assert.equal(page.next_cursor, undefined); return pages; }
    cursor = page.next_cursor;
  }
  throw new Error('pagination did not terminate');
};

for (const backend of ['sqlite', 'mysql', 'postgres'] as const) {
  const skipped = backend === 'mysql' ? !mysqlEnabled : backend === 'postgres' ? !postgresEnabled : false;
  const backendTest = (name: string, run: (f: Fixture) => Promise<void>) => test(`${backend}: ${name}`, { skip: skipped }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'grounds-eval-list-'));
    const isolated = backend === 'sqlite'
      ? { store: SQLStore.sqlite(join(root, 'ledger.db')), cleanup: async () => {} }
      : backend === 'mysql' ? await isolatedMySQL() : await isolatedPostgres();
    try { await run(await fixture(isolated.store, isolated.cleanup)); }
    finally {
      try { await isolated.store.close(); }
      finally { try { await isolated.cleanup(); } finally { rmSync(root, { recursive: true, force: true }); } }
    }
  });

  backendTest('every kind has a bounded summary with identity, relations and no private bodies, and the classic list stays complete', async f => {
    const kinds: [EvalKind, number][] = [['environment', 2], ['envcheck', 2], ['preparation', 1], ['instance', 1], ['qa', 2], ['grader', 2], ['suite', 1], ['experiment', 3], ['run', 1]];
    for (const [kind, total] of kinds) {
      const summary = await f.m.listSummary(kind);
      assertContract('eval-list.schema.json', { ...summary, command: `eval.${kind}.list` });
      assert.equal(summary.items.length, total, kind); assert.equal(summary.page.has_more, false);
      const full = await f.m.list(kind);
      assert.equal(full.length, total); assert.deepEqual(summary.items.map(item => item.id), full.map(record => record.id));
      for (const [index, item] of summary.items.entries()) {
        assert.equal(item.kind, kind); assert.equal(item.version, full[index].version); assert.equal(item.created_at, full[index].created_at); assert.equal(item.parent_id, full[index].parent_id);
      }
      const text = JSON.stringify(summary);
      for (const secret of ['PRIVATE-SCRIPT-BODY', 'PRIVATE-REFERENCE-ANSWER', 'PRIVATE-GRADER-INSTRUCTIONS']) assert.ok(!text.includes(secret), `${kind} summary must not inline ${secret}`);
      assert.ok(full.every(record => 'data' in record), 'the classic list still returns complete records');
    }
    const grader = (await f.m.listSummary('grader')).items.find(item => item.id === f.grader1.id)!;
    assert.deepEqual(grader.summary, { scope: 'diagnostic', definition_type: 'agent', result_kind: 'qa_decision', qa: { id: f.qa1.id, version: 1 } });
    assert.equal(grader.name, 'Grader one'); assert.equal(grader.parent_id, f.qa1.id);
    assert.equal((await f.m.listSummary('qa')).items.find(item => item.id === f.qa1.id)?.summary.source_identity, 'qa-one');
  });

  backendTest('filters are exact relations, compose with AND, and never invent a relation', async f => {
    const idsOf = async (kind: EvalKind, filters: Record<string, string>) => (await f.m.listSummary(kind, filters)).items.map(item => item.id).sort();
    const fullIds = async (kind: EvalKind, filters: Record<string, string>) => (await f.m.list(kind, undefined, filters)).map(record => record.id).sort();
    assert.deepEqual(await idsOf('grader', { qa: f.qa1.id }), [f.grader1.id]); assert.deepEqual(await idsOf('grader', { qa: f.qa2.id }), [f.grader2.id]);
    assert.deepEqual(await idsOf('grader', { qa: f.qa1.id, issue: newUUIDv7() }), [], 'a QA Grader has no Issue');
    assert.deepEqual(await idsOf('grader', { issue: newUUIDv7() }), []);
    assert.deepEqual(await idsOf('envcheck', { environment: f.environments[0].id }), [f.checks[0].id]);
    assert.deepEqual(await idsOf('preparation', { environment: f.bindings.answer.environment.id }), [f.preparation.id]);
    assert.deepEqual(await idsOf('preparation', { environment: f.bindings.grade.environment.id }), []);
    assert.deepEqual(await idsOf('instance', { run: f.run1.id }), [f.instance.id]);
    assert.deepEqual(await idsOf('instance', { preparation: f.preparation.id }), [f.instance.id]);
    assert.deepEqual(await idsOf('instance', { run: f.run1.id, preparation: newUUIDv7() }), []);
    assert.notEqual(f.experiment1.data.snapshot_id, f.experiment2.data.snapshot_id);
    assert.deepEqual(await idsOf('experiment', { snapshot: f.experiment1.data.snapshot_id }), [f.experiment1.id, f.experiment3.id].sort());
    assert.deepEqual(await idsOf('experiment', { snapshot: f.experiment2.data.snapshot_id }), [f.experiment2.id]);
    assert.deepEqual(await idsOf('experiment', { snapshot: newUUIDv7() }), []);
    assert.deepEqual(await idsOf('run', { experiment: f.experiment1.id, state: 'open' }), [f.run1.id]);
    assert.deepEqual(await idsOf('run', { experiment: f.experiment1.id, state: 'closed' }), []);
    assert.deepEqual(await idsOf('run', { experiment: f.experiment2.id }), []);
    // The classic full list honours the same filters and existing --issue/--experiment forms.
    assert.deepEqual(await fullIds('grader', { qa: f.qa1.id }), [f.grader1.id]);
    assert.deepEqual(await fullIds('run', { experiment: f.experiment1.id, state: 'open' }), [f.run1.id]);
    // Relations that a kind does not have are rejected, not approximated.
    await assert.rejects(f.m.listSummary('qa', { issue: f.qa1.id }), failure('VALIDATION_ERROR', 'issue'));
    await assert.rejects(f.m.listSummary('suite', { qa: f.qa1.id }), failure('VALIDATION_ERROR', 'qa'));
    await assert.rejects(f.m.listSummary('run', { state: 'done' }), failure('VALIDATION_ERROR', 'state'));
    await assert.rejects(f.m.listSummary('instance', { run: 'not-an-id' }), failure('VALIDATION_ERROR', 'id'));
    await assert.rejects(f.m.list('environment', undefined, { name: 'x' }), failure('VALIDATION_ERROR', 'name'));
  });

  backendTest('experiment progress counts Run states in the same snapshot and follows new, stopped and repeated Runs', async f => {
    const progress = async (id: string) => (await f.m.listSummary('experiment')).items.find(item => item.id === id)!.summary;
    let one: any = await progress(f.experiment1.id);
    assert.deepEqual(one.runs, { total: 1, open: 1, closed: 0 }); assert.equal(one.snapshot_id, f.experiment1.data.snapshot_id);
    assert.deepEqual(one.subject, { name: 'Agent A', description_preview: 'x'.repeat(200), description_truncated: true });
    const empty: any = await progress(f.experiment2.id);
    assert.deepEqual(empty.runs, { total: 0, open: 0, closed: 0 }, 'zero Runs is zero, not complete');
    assert.equal(empty.subject.description_truncated, false); assert.ok(!('result' in empty) && !('verdict' in empty) && !('success' in empty.runs));
    // Stop the open Run without any scoring evidence: it counts as closed but nothing is judged.
    await f.m.finishRun(f.run1.id, actor(), 'stopped for the test');
    one = await progress(f.experiment1.id); assert.deepEqual(one.runs, { total: 1, open: 0, closed: 1 });
    const again = await f.m.startRun({ experiment_id: f.experiment1.id, task_id: f.tasks[0].id, rerun_of: f.run1.id }, actor());
    const other = await f.m.startRun({ experiment_id: f.experiment1.id, task_id: f.tasks[1].id }, actor());
    one = await progress(f.experiment1.id); assert.deepEqual(one.runs, { total: 3, open: 2, closed: 1 });
    assert.deepEqual((await f.m.listSummary('run', { experiment: f.experiment1.id, state: 'open' })).items.map(item => item.id).sort(), [again.id, other.id].sort());
    const closed = (await f.m.listSummary('run', { state: 'closed' })).items[0];
    assert.equal(closed.id, f.run1.id); assert.equal((closed.summary as any).state, 'closed'); assert.ok((closed.summary as any).result_id);
    assert.equal((await f.m.list('experiment', undefined, { snapshot: f.experiment1.data.snapshot_id })).length, 2, 'the classic experiment list carries no derived progress');
    assert.ok(!('runs' in (await f.m.list('experiment'))[0].data));
  });

  backendTest('summary pages follow the published order, bind the cursor, and report collection changes', async f => {
    for (const kind of ['environment', 'envcheck', 'qa', 'grader', 'experiment'] as EvalKind[]) {
      const whole = (await f.m.listSummary(kind)).items.map(item => item.id);
      for (const limit of [1, 2, 5]) {
        const pages = await readAll(request => f.m.listSummary(kind, {}, request), limit);
        assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)), whole, `${kind} limit ${limit}`);
        assert.ok(pages.every(page => page.page.sort === 'id:asc' && page.page.limit === limit));
        assert.equal(pages.length, Math.ceil(whole.length / limit));
      }
    }
    const empty = await f.m.listSummary('run', { experiment: f.experiment2.id }, { limit: 3 });
    assert.deepEqual(empty.items, []); assert.equal(empty.page.has_more, false); assert.equal(empty.next_cursor, undefined);
    const cursor = (await f.m.listSummary('qa', {}, { limit: 1 })).next_cursor!;
    await assert.rejects(f.m.listSummary('grader', {}, { cursor }), failure('VALIDATION_ERROR', 'cursor'));
    await assert.rejects(f.m.listSummary('qa', { }, { cursor: `${cursor.slice(0, -2)}AA` }), failure('VALIDATION_ERROR', 'cursor'));
    const graderCursor = (await f.m.listSummary('grader', { qa: f.qa1.id }, { limit: 1 })).next_cursor;
    assert.equal(graderCursor, undefined);
    const filtered = (await f.m.listSummary('experiment', { snapshot: f.experiment1.data.snapshot_id }, { limit: 1 })).next_cursor!;
    await assert.rejects(f.m.listSummary('experiment', {}, { cursor: filtered }), failure('VALIDATION_ERROR', 'cursor'));
    for (const limit of [0, 1001, 1.5, Number.NaN]) await assert.rejects(f.m.listSummary('qa', {}, { limit }), failure('VALIDATION_ERROR', 'limit'));
    // A write between pages is a retryable collection change; a fresh read is complete.
    const first = await f.m.listSummary('qa', {}, { limit: 1 });
    await f.m.publishQA(qaDraft('Third QA', 'qa-three'), actor());
    await assert.rejects(f.m.listSummary('qa', {}, { cursor: first.next_cursor }), (error: unknown) => { failure('LIST_CHANGED')(error); assert.equal((error as DomainError).retryable, true); return true; });
    assert.equal((await readAll(request => f.m.listSummary('qa', {}, request), 1)).flatMap(page => page.items).length, 3);
  });

  backendTest('a new version keeps its place; large bodies stay out of the summary; a huge page shrinks to the byte budget', async f => {
    const before = (await f.m.listSummary('qa')).items.map(item => ({ id: item.id, version: item.version }));
    await f.m.publishQA({ ...qaDraft('First QA renamed', 'qa-one'), question: 'Changed?' }, actor(), { id: f.qa1.id, expected_version: 1 });
    const after = (await f.m.listSummary('qa')).items;
    assert.deepEqual(after.map(item => item.id), before.map(item => item.id));
    assert.equal(after.find(item => item.id === f.qa1.id)?.version, 2); assert.equal(after.find(item => item.id === f.qa1.id)?.name, 'First QA renamed');
    assert.equal((await f.m.list('qa')).find(record => record.id === f.qa1.id)?.version, 2);
    // A QA with ~256 KB of private material: the classic list carries it all, the summary carries none of it.
    const text = (marker: string) => `${marker} ${'y'.repeat(65000)}`;
    const big = await f.m.publishQA({ ...qaDraft('Big QA', 'qa-big'), question: text('Q'), instructions: text('I'), rubric: text('R'), reference_answer: text('PRIVATE-BIG-REFERENCE') }, actor());
    const summary = await f.m.listSummary('qa'); const bigItem = summary.items.find(item => item.id === big.id)!;
    assert.ok(bigItem); assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 3000, 'the summary is tiny'); assert.ok(!JSON.stringify(summary).includes('PRIVATE-BIG-REFERENCE'));
    assert.ok(Buffer.byteLength(JSON.stringify(await f.m.list('qa'))) > 250_000, 'the classic list still carries the whole definition');
    const whole = (await f.m.listSummary('qa')).items.map(item => item.id);
    const oneItem = Buffer.byteLength(JSON.stringify(await f.m.listSummary('qa', {}, { limit: 1 })));
    const budget = oneItem + 20; // room for exactly one entry per page
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const page: EvalListPage = await f.m.listSummary('qa', {}, { limit: 1000, ...(cursor ? { cursor } : {}) }, budget);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= budget); seen.push(...page.items.map(item => item.id)); cursor = page.next_cursor; pages += 1;
    } while (cursor);
    assert.deepEqual(seen, whole); assert.ok(pages > 1);
    await assert.rejects(f.m.listSummary('qa', {}, { limit: 5 }, 50), failure('ARTIFACT_TOO_LARGE'));
  });
}

test('sqlite: eval list CLI keeps the classic shape, exposes summary/paging options and rejects misuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grounds-eval-list-cli-')); const config = join(root, 'config.yaml'); const db = join(root, 'ledger.db');
  await execute(['init', '--driver', 'sqlite', '--path', db, '--non-interactive', '--config', config]);
  const f = await fixture(SQLStore.sqlite(db), async () => {});
  try {
    const call = async (...args: string[]) => {
      const out: string[] = []; const status = await runCLI(['eval', ...args, '--json', '--config', config], { cwd: root, stdout: line => out.push(line), stderr: () => undefined });
      return { status, envelope: JSON.parse(out[0]) as { ok: boolean; data?: any; error?: { code: string; retryable: boolean; details?: { field?: string } } } };
    };
    const classic = await call('experiment', 'list');
    assert.equal(classic.status, 0); assert.equal(classic.envelope.data.result_type, 'patchledger.result.eval/v1'); assertContract('eval.schema.json', classic.envelope.data);
    assert.equal(classic.envelope.data.payload.length, 3); assert.ok(classic.envelope.data.payload[0].data.subject);
    const summary = await call('experiment', 'list', '--view', 'summary');
    assert.equal(summary.status, 0); assert.equal(summary.envelope.data.result_type, 'patchledger.result.eval-list/v1'); assertContract('eval-list.schema.json', summary.envelope.data);
    assertContract('cli-envelope.schema.json', summary.envelope);
    const paged = await call('experiment', 'list', '--limit', '1');
    assert.equal(paged.envelope.data.page.has_more, true); assert.ok(paged.envelope.data.next_cursor);
    const next = await call('experiment', 'list', '--cursor', paged.envelope.data.next_cursor);
    assert.equal(next.envelope.data.items.length, 2); assert.equal(next.envelope.data.page.limit, 100);
    assert.equal((await call('run', 'list', '--experiment', f.experiment1.id, '--state', 'open')).envelope.data.payload.length, 1);
    assert.equal((await call('run', 'list', '--experiment', f.experiment1.id, '--state', 'open', '--view', 'summary')).envelope.data.items[0].summary.state, 'open');
    assert.equal((await call('run', 'list', '--state', 'open', '--view', 'summary')).envelope.data.items.length, 1);
    assert.equal((await call('grader', 'list', '--qa', f.qa1.id, '--limit', '5')).envelope.data.items.length, 1);
    for (const [args, field] of [
      [['experiment', 'list', '--view', 'wide'], 'view'], [['experiment', 'list', '--view', 'full', '--limit', '1'], 'limit'], [['experiment', 'list', '--limit', '0'], 'limit'],
      [['qa', 'list', '--issue', newUUIDv7()], 'issue'], [['run', 'list'], 'experiment'], [['experiment', 'list', '--cursor', paged.envelope.data.next_cursor, '--snapshot', f.experiment1.data.snapshot_id], 'cursor'],
    ] as const) { const failed = await call(...args); assert.equal(failed.status, 2, args.join(' ')); assert.equal(failed.envelope.error?.details?.field, field, args.join(' ')); }
    const stale = await call('qa', 'list', '--limit', '1');
    await f.m.publishQA(qaDraft('Late QA', 'qa-late'), actor());
    const changed = await call('qa', 'list', '--cursor', stale.envelope.data.next_cursor);
    assert.equal(changed.status, 4); assert.equal(changed.envelope.error?.code, 'LIST_CHANGED'); assert.equal(changed.envelope.error?.retryable, true);
  } finally { await f.store.close(); rmSync(root, { recursive: true, force: true }); }
});
