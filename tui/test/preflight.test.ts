import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailTree, type Node } from '../src/details.js';
import { loadPage } from '../src/pages.js';
import { issueDetailLines } from '../src/requirement-view.js';
import { decode, methods, type Data, type Method } from '../src/protocol.js';
import { fixture } from './fixtures.js';

const commands = [
  'grounds preflight observe --phase start --issue i --refresh',
  'grounds preflight assess --observation o --file assessment.json',
  'grounds devrun admit --dev-run d --preflight a --refresh',
];
const requiredInputs = { repository_id: 'r', issue_id: 'i', issue_version: 2, target: { remote: 'origin', ref: 'refs/heads/main' }, base_commit: 'sha1:base' };
const preparing = {
  state: 'preparing', code: 'no_observation', summary: '恢复现场已就绪，尚未完成正式开发准入',
  blocking: [{ code: 'no_observation', detail: '缺少目标刷新与适用性评估' }],
  required_inputs: requiredInputs, next_commands: commands,
};
const nodes = (items: Node[]): Node[] => items.flatMap(node => [node, ...nodes(node.children ?? [])]);
const nodeText = (items: Node[]) => nodes(items).map(node => `${node.label}\n${typeof node.body === 'string' ? node.body : ''}`).join('\n');
const detail = (preflight?: unknown) => ({
  type: 'detail' as const, route: { kind: 'devrun' as const, id: 'd' }, time: '2026-10-15T10:00:00Z',
  data: { dev_run_id: 'd', issue: { id: 'i', version: 2 }, state: 'open', ...(preflight === undefined ? {} : { preflight }) },
});

test('DevRun preparation is displayed as blocked and gives the exact CLI recovery path', () => {
  const tree = detailTree(detail(preparing));
  assert.match(tree.facts.join('\n'), /准备中.*不可正式开发/);
  assert.ok(tree.nodes.some(node => node.id.endsWith('/preflight')));
  const text = nodeText(tree.nodes);
  assert.match(text, /缺少目标刷新与适用性评估/);
  for (const command of commands) assert.ok(text.includes(command));
  assert.ok(nodes(tree.nodes).every(node => node.task === undefined));
});

test('admission is a recorded fact rather than a guarantee of latest remote or verification', () => {
  const preflight = { ...preparing, state: 'admitted', code: 'admitted', summary: '本次输入已准入', blocking: [], next_commands: [],
    admission: { observation_id: 'o', assessment_id: 'a', target_commit: 'sha1:tip', base_commit: 'sha1:tip', admitted_at: '2026-10-15T09:00:00Z' } };
  const tree = detailTree(detail(preflight));
  assert.match(tree.facts.join('\n'), /已准入/);
  assert.match(nodeText(tree.nodes), /不代表远端最新/);
  assert.match(nodeText(tree.nodes), /不代表候选验证或交付就绪/);
});

test('contradictory admission with blockers never displays a positive readiness fact', () => {
  const tree = detailTree(detail({ ...preparing, state: 'admitted', code: 'input_mismatch' }));
  assert.match(tree.facts.join('\n'), /阻塞/);
  assert.doesNotMatch(tree.facts.join('\n'), /已准入/);
});

test('target Issue shows preflight requirements while older missing data remains unknown', () => {
  const base = fixture('issue');
  const issue = { ...(base.issue as Data), target_branch: requiredInputs.target };
  const tree = detailTree({ type: 'detail', route: { kind: 'issue', id: 'i', version: 2 }, time: '', data: {
    ...base, issue, board: { ...(base.board as Data), preflight: { required: true, state: 'missing', code: 'no_observation', next_commands: commands } },
  } });
  assert.match(tree.facts.join('\n'), /待检查.*不可正式开发/);
  assert.ok(nodeText(tree.nodes).includes(commands[0]));
  const absent = detailTree({ type: 'detail', route: { kind: 'issue', id: 'i' }, time: '', data: { ...base, issue } });
  assert.match(absent.facts.join('\n'), /未知/);
  assert.doesNotMatch(absent.facts.join('\n'), /已准入/);
});

test('default Issue detail shows the same preflight blockers and manual completion path', () => {
  const base = fixture('issue');
  const detail = { ...base, issue: { ...(base.issue as Data), target_branch: requiredInputs.target }, board: { ...(base.board as Data), preflight: preparing } };
  const lines = issueDetailLines(detail, 100).join('\n');
  assert.match(lines, /准备中.*不可正式开发/);
  assert.match(lines, /缺少目标刷新与适用性评估/);
  assert.match(lines, /grounds preflight observe/);
  assert.match(lines, /仅展示，不自动执行/);
});

test('managed development with a missing preflight projection is explicitly unknown', () => {
  const old = detail();
  const tree = detailTree({ ...old, data: { ...old.data, development: { format: 'grounds.development-branch/v1', workspace_id: 'w', branch: 'grounds/task' } } });
  assert.match(tree.facts.join('\n'), /未知.*不可视为通过/);
  assert.doesNotMatch(tree.facts.join('\n'), /已准入/);
});

test('legacy DevRun without a target preflight projection does not invent an admission', () => {
  const tree = detailTree(detail());
  assert.ok(tree.nodes.every(node => !node.id.endsWith('/preflight')));
  assert.doesNotMatch(tree.facts.join('\n'), /已准入/);
});

test('read-only DevRun page presents blockers without dispatching any preflight write', async () => {
  let calls: [Method, string[]][] = [];
  const reader = { async query(method: Method, args: string[] = []) {
    calls = [...calls, [method, args]];
    assert.equal(method, 'devrun');
    return detail(preparing).data;
  } };
  const page = await loadPage(reader, { kind: 'devrun', id: 'd' }, new AbortController().signal);
  assert.match(page.lines.join('\n'), /准备中.*不可正式开发/);
  for (const command of commands) assert.ok(page.lines.join('\n').includes(command));
  assert.deepEqual(calls, [['devrun', ['d']]]);
});

test('protocol rejects malformed preflight states and blocker shapes', () => {
  const envelope = (preflight: unknown) => JSON.stringify({ format: 'patchledger.cli/v1', ok: true, warnings: [], data: {
    ...detail(preflight).data, result_type: 'patchledger.result.devrun-detail/v1', command: 'devrun.show',
  } });
  assert.doesNotThrow(() => decode(envelope(preparing), 0, 'devrun'));
  assert.doesNotThrow(() => decode(envelope({ ...preparing, blocking: [{ code: 'no_observation' }] }), 0, 'devrun'));
  for (const bad of [{ ...preparing, state: 'passed' }, { ...preparing, blocking: 'none' }, { ...preparing, next_commands: [true] }, { state: 'admitted', code: 'admitted', next_commands: [] }, { ...preparing, required_inputs: {} }, { ...preparing, admission: {} }]) {
    assert.throws(() => decode(envelope(bad), 0, 'devrun'), { code: 'PROTOCOL_ERROR' });
  }
  assert.ok(!Object.values(methods).some(method => ['devrun.start', 'devrun.admit', 'workspace.publish', 'preflight.assess'].includes(method.command)));
});
