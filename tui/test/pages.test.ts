import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from '../src/pages.js';
import { ClientError, type Data, type Method } from '../src/protocol.js';
const signal = () => new AbortController().signal;
const set = { count: 1, digest: 'old', standing: 'qualified', verdict_counts: { qualified: 1, rejected: 0, inconclusive: 0 }, reports_included: false };

test('candidate list passes pinned version, devrun list explicitly covers all versions', async () => {
  const calls: unknown[] = [];
  const reader = { async query(m: Method, args?: string[]) { calls.push([m, args]); return { resources: [] }; } };
  await loadPage(reader, { kind: 'candidates', id: 'issue', version: 1 }, signal());
  assert.deepEqual(calls[0], ['candidates', ['--issue', 'issue', '--issue-version', '1']]);
  assert.match((await loadPage(reader, { kind: 'devruns', id: 'issue' }, signal())).title, /全部/);
});

test('comparison preserves selected order despite sorted CLI output', async () => {
  const reader = { async query() { return { issue: { id: 'i', version: 1 }, candidates: [{ candidate_id: 'b' }, { candidate_id: 'a' }] }; } };
  const p = await loadPage(reader, { kind: 'compare', pair: ['a', 'b'] }, signal());
  assert.deepEqual(p.rows.map(r => r.id), ['a', 'b']);
});

test('verification set changes restart at the summary and first page', async () => {
  const calls: Method[] = [];
  let attempt = 0;
  const reader = { async query(m: Method): Promise<Data> {
    calls.push(m);
    if (m === 'review') return { trace: { verification_set: { ...set, digest: 'new' }, artifact: { result_tree_oid: 'tree' } } };
    if (!attempt++) throw new ClientError('VERIFICATION_SET_CHANGED', 'changed', true);
    return { candidate_id: 'c', verification_set: { ...set, digest: 'new' }, verifications: [{ verification_id: 'v', candidate_id: 'c' }] };
  } };
  const p = await loadPage(reader, { kind: 'verifications', id: 'c', set, cursor: 'old-cursor' }, signal());
  assert.deepEqual(calls, ['verifications', 'review', 'verifications']);
  assert.match(p.note!, /重新读取/);
});

test('report membership and artifact identity are verified before rendering', async () => {
  const entry = { verification_id: 'v', candidate_id: 'c', overall_verdict: 'qualified', attribution: { kind: 'human' }, created_at: '2026-09-14T00:00:00Z' };
  const reader = { async query() { return { ...entry, report: { candidate_id: 'c', result_tree_oid: 'wrong' } }; } };
  await assert.rejects(loadPage(reader, { kind: 'verification', id: 'v', entry, tree: 'expected' }, signal()), { code: 'PROTOCOL_ERROR' });
});

const ultraEntry = { verification_id: 'v', candidate_id: 'c', overall_verdict: 'rejected', mode: 'ultra', quality_verdict: 'rejected', quality_attribution: { kind: 'agent', agent_id: 'quality' }, attribution: { kind: 'agent', agent_id: 'contract' }, created_at: '2026-09-14T00:00:00Z' };
const normalEntry = { ...ultraEntry, verification_id: 'n', overall_verdict: 'qualified', mode: 'normal', quality_verdict: undefined, quality_attribution: undefined };

test('verification directory shows the mode and the quality verdict of ultra reports and keeps normal reports plain', async () => {
  const reader = { async query(): Promise<Data> { return { candidate_id: 'c', verification_set: set, verifications: [ultraEntry, normalEntry] }; } };
  const p = await loadPage(reader, { kind: 'verifications', id: 'c', set, tree: 'tree' }, signal());
  assert.match(p.rows[0].label, /rejected · ultra（质量评审 rejected）/);
  assert.match(p.rows[1].label, /qualified · normal · n/);
  assert.doesNotMatch(p.rows[1].label, /质量评审/);
});

test('an ultra report opens with its mode, the contract part and the raw quality section, and must match its directory entry', async () => {
  const body = { ...ultraEntry, report: { candidate_id: 'c', result_tree_oid: 'tree', assessments: [] }, quality: { overall_verdict: 'rejected', attribution: { kind: 'agent', agent_id: 'quality' }, report: { rubric_version: 'grounds.quality-rubric/v1', dimensions: [{ dimension_id: 'conciseness', final: { verdict: 'rejected', explanation: '重复分支' } }] } } };
  const reader = { async query(): Promise<Data> { return body; } };
  const p = await loadPage(reader, { kind: 'verification', id: 'v', entry: ultraEntry, tree: 'tree' }, signal());
  const lines = p.lines.join('\n');
  assert.match(lines, /验收模式：ultra（质量评审 rejected）/);
  assert.match(lines, /代码质量评审（ultra）/);
  assert.match(lines, /重复分支/);
  // A body whose mode differs from the fixed directory entry is rejected instead of rendered.
  const downgraded = { async query(): Promise<Data> { return { ...body, mode: 'normal', quality: undefined, quality_verdict: undefined }; } };
  await assert.rejects(loadPage(downgraded, { kind: 'verification', id: 'v', entry: ultraEntry, tree: 'tree' }, signal()), { code: 'PROTOCOL_ERROR' });
});
test('managed branch page separates observed HEAD standing from dirty live files', async () => {
  const reader = { async query(m: Method) {
    assert.equal(m, 'devrun');
    return { dev_run_id: 'run', issue: { id: 'issue', version: 1 }, state: 'submitted', development: { workspace_id: 'route', branch: 'grounds/route' },
      local_worktree: { status: 'available', path: '/tmp/route', head: 'sha1:old', working_tree_dirty: true, git_operation_in_progress: false, continuation: 'paused' }, current_head: { standing: 'qualified', candidate_id: 'old' } };
  } };
  const p = await loadPage(reader, { kind: 'devrun', id: 'run' }, signal());
  assert.match(p.lines.join('\n'), /本次观察到的 HEAD/);
  assert.match(p.lines.join('\n'), /未保存文件/);
  assert.match(p.lines.join('\n'), /活动文件存在未保存改动: true/);
  assert.match(p.lines.join('\n'), /默认暂停/);
});
