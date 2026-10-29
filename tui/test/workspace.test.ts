import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataCache, Workspace, detailKey, screenKey, validateReport } from '../src/workspace.js';
import { detailTree, flatten, type Node } from '../src/details.js';
import { ClientError, type Data, type Method } from '../src/protocol.js';
import { initial, navigate, Positions } from '../src/navigation.js';
import { directoryNodes, directoryPath } from '../src/directory.js';
import { candidate, entry, fixture, issue, report, requirement, set, trace } from './fixtures.js';
const signal = () => new AbortController().signal;
const route = { kind: 'candidate' as const, id: 'c' };

test('Issue workbench pins candidate version, retains historical snapshot and degrades after eviction', async () => {
  let version = 1; const calls: [Method, string[]][] = [];
  const w = new Workspace({ async query(m, args = []) { calls.push([m, args]); return m === 'issue' ? { ...fixture(m), issue: { ...issue, version, summary: `contract${version}` } } : fixture(m, args); } });
  const page = await w.loadScreen({ kind: 'issue', id: 'i' }, signal()); assert.equal(page.route.version, 1);
  version = 2;
  const refreshed = await w.loadScreen(page.route, signal(), true);
  assert.match(refreshed.note!, /当前已为 v2/); assert.equal((refreshed.overview!.issue as Data).summary, 'contract1');
  assert.ok(calls.filter(([m]) => m === 'candidates').every(([, args]) => args.at(-1) === '1'));
  for (let i = 0; i < 11; i++) w.cache.put('evict' + i, { type: 'screen', route: { kind: 'home' }, title: '', rows: [], time: '' });
  await w.loadScreen(page.route, signal(), true);
  const old = await w.loadDetail(page.route, signal()); assert.match(String(old.data.unavailable), /淘汰/);
  assert.equal((old.data.issue as Data).summary, undefined);
});

test('lazy review is shared and adopts validation summary without changing Selection observation', async () => {
  const calls: Method[] = [];
  const w = new Workspace({ async query(m, args) { calls.push(m); return fixture(m, args); } });
  const before = await w.loadDetail(route, signal());
  assert.match(detailTree(before).facts.join(' '), /unverified/);
  await w.expand(route, 'review', signal()); await w.expand(route, 'review', signal());
  const d = await w.expand(route, 'reports', signal());
  assert.equal(calls.filter(m => m === 'review').length, 1);
  assert.equal(d.data.candidate && (d.data.candidate as Data).is_selected, false);
  assert.equal(d.time, before.time);
  assert.match(detailTree(d).facts.join(' '), /standing：qualified/);
  assert.match(detailTree(d).nodes.find(n => n.id.endsWith('/reports'))!.label, /1/);
});

test('criterion keys preserve goal/constraint parents and prose is a Markdown leaf', async () => {
  const w = new Workspace({ async query(m, args) { return fixture(m, args); } });
  await w.loadDetail(route, signal()); const d = await w.expand(route, 'review', signal());
  const nodes = detailTree(d).nodes; const all = (nodes: Node[]): Node[] => nodes.flatMap(n => [n, ...all(n.children ?? [])]);
  const flattened = all(nodes);
  assert.equal(flattened.find(n => n.id.endsWith('/goal:g/ac/claim'))?.body, '目标标准声明');
  assert.equal(flattened.find(n => n.id.endsWith('/constraint:h/ac/claim'))?.body, '约束标准声明');
  const vr = detailTree({ type: 'detail', route: { kind: 'verification', id: 'v' }, time: '', data: report });
  const vn = all(vr.nodes);
  assert.equal(vn.find(n => n.id.endsWith('/independent/explanation'))?.body, '# 独立结论\n\n独立观察');
  assert.ok(vn.some(n => n.id.endsWith('/reconciliation'))); assert.ok(vn.some(n => n.id.endsWith('/final')));
  assert.ok(flatten(nodes, {}).length < flattened.length);
});

test('verification set changes restart at most twice and report bindings cannot be bypassed', async () => {
  let reads = 0; const w = new Workspace({ async query(m, args) {
    if (m === 'verifications') { reads++; throw new ClientError('VERIFICATION_SET_CHANGED', 'changed'); }
    return fixture(m, args);
  } });
  await w.loadDetail(route, signal());
  await assert.rejects(w.expand(route, 'reports', signal()), { code: 'VERIFICATION_SET_CHANGED' }); assert.equal(reads, 3);
  assert.throws(() => validateReport(report, { kind: 'verification', id: 'v', entry, tree: 'wrong' }), { code: 'PROTOCOL_ERROR' });
  assert.doesNotThrow(() => validateReport(report, { kind: 'verification', id: 'v', entry, tree: 'tree' }));
});

test('returning to a candidate rechecks the report directory and replaces the active set', async () => {
  let changed = false; const updated = { ...set, count: 2, digest: 'set2' };
  const w = new Workspace({ async query(m, args) {
    if (changed && m === 'review') return { trace: { ...trace, verification_set: updated } };
    if (changed && m === 'verifications') return { candidate_id: 'c', verification_set: updated, verifications: [entry, { ...entry, verification_id: 'v2' }] };
    return fixture(m, args);
  } });
  await w.loadDetail(route, signal()); await w.expand(route, 'reports', signal()); changed = true;
  const d = await w.loadDetail(route, signal());
  assert.equal((d.review!.verification_set as Data).digest, 'set2'); assert.equal((d.directory!.verifications as Data[]).length, 2);
});

test('unchanged directory recheck preserves loaded later pages for exact report-node return', async () => {
  const summary = { ...set, count: 2 };
  const w = new Workspace({ async query(m, args = []) {
    if (m === 'review') return { trace: { ...trace, verification_set: summary } };
    if (m === 'verifications') return { candidate_id: 'c', verification_set: summary, verifications: [{ ...entry, verification_id: args.includes('--cursor') ? 'v2' : 'v' }], next_cursor: args.includes('--cursor') ? undefined : 'p2' };
    return fixture(m, args);
  } });
  await w.loadDetail(route, signal()); await w.expand(route, 'reports', signal()); await w.expand(route, 'reports-next', signal());
  const d = await w.loadDetail(route, signal());
  assert.deepEqual((d.directory!.verifications as Data[]).map(v => v.verification_id), ['v', 'v2']);
});

test('manifest pagination preserves observation fields and rejects digest/cursor/duplicate errors', async () => {
  let mode = 'good';
  const w = new Workspace({ async query(m, args = []) {
    if (m === 'candidate') return { candidate: args.length === 1 ? { ...candidate, file_manifest_omitted: true, manifest_next_cursor: 'p2' } : {
      ...candidate, standing: 'rejected', is_selected: true, manifest_digest: mode === 'digest' ? 'wrong' : candidate.manifest_digest,
      file_manifest: [{ path_bytes: mode === 'duplicate' ? 'YQ==' : 'Yg==', display_path: 'b.ts' }], file_manifest_omitted: mode === 'cursor', manifest_next_cursor: mode === 'cursor' ? 'p2' : undefined,
    } };
    return fixture(m, args);
  } });
  await w.loadDetail(route, signal()); const d = await w.expand(route, 'manifest-next', signal());
  assert.equal((d.data.candidate as Data).standing, 'unverified'); assert.equal((d.data.candidate as Data).is_selected, false);
  assert.equal(((d.data.candidate as Data).file_manifest as Data[]).length, 2);
  for (mode of ['digest', 'cursor', 'duplicate']) { await w.loadDetail(route, signal(), true); await assert.rejects(w.expand(route, 'manifest-next', signal()), { code: 'PROTOCOL_ERROR' }); }
});

test('cache counts all business data and preserves old value on failed atomic replacement', () => {
  const cache = new DataCache<unknown>(100, 2); cache.put('a', { text: 'a'.repeat(40) }); cache.pin(['a']);
  cache.put('b', 'b'); cache.put('c', 'c'); assert.equal(cache.peek('b'), undefined);
  assert.throws(() => cache.put('c', 'c'.repeat(80)), { code: 'VIEW_TOO_LARGE' }); assert.equal(cache.peek('c'), 'c'); assert.ok(cache.size <= 100);
});

test('aborted preview never commits to cache even if Reader ignores cancellation', async () => {
  let release!: (data: Data) => void; const w = new Workspace({ async query() { return new Promise<Data>(resolve => { release = resolve; }); } });
  const controller = new AbortController(), pending = w.loadDetail(route, controller.signal);
  controller.abort(); release({ candidate }); await assert.rejects(pending); assert.equal(w.cache.peek(detailKey(route)), undefined);
});

test('Requirement mixed-version pagination restarts the first page, not appends', async () => {
  let version = 1;
  const w = new Workspace({ async query(m, args = []) {
    const d = fixture(m, args); if (m !== 'requirement') return d;
    return { ...d, requirement: { ...(d.requirement as Data), version }, issues_omitted: version === 1, issues_next_cursor: version === 1 ? 'p2' : undefined };
  } });
  const r = { kind: 'requirement' as const, id: 'r' }; await w.loadScreen(r, signal()); version = 2;
  const p = await w.moreIssues(r, signal()); assert.match(p.note!, /版本变化/); assert.equal(p.rows.length, 2); assert.equal(w.cache.peek(screenKey(r)), p);
});

test('entering a newer Requirement page does not reuse an older root preview contract', async () => {
  let version = 1; const w = new Workspace({ async query(m, args) { const d = fixture(m, args); return m === 'requirement' ? { ...d, requirement: { ...(d.requirement as Data), version } } : d; } });
  const r = { kind: 'requirement' as const, id: 'r' };
  await w.loadDetail(r, signal()); version = 2; await w.loadScreen(r, signal());
  assert.equal(((await w.loadDetail(r, signal())).data.requirement as Data).version, 2);
});

test('candidate preview checks the fixed Issue membership', async () => {
  const w = new Workspace({ async query(m, args) { return fixture(m, args); } });
  await assert.rejects(w.loadDetail({ ...route, issueId: 'i', version: 2 }, signal()), { code: 'PROTOCOL_ERROR' });
});

test('manifest cache overflow degrades to bounded single-page navigation', async () => {
  const w = new Workspace({ async query(m, args = []) {
    if (m !== 'candidate') return fixture(m, args);
    const page = args.length > 1 ? 2 : 1;
    return { candidate: { ...candidate, file_manifest: [{ path_bytes: String(page), display_path: 'x'.repeat(600) }], file_count: 2, file_manifest_omitted: page === 1, manifest_next_cursor: page === 1 ? 'p2' : undefined } };
  } }, 1650);
  await w.loadDetail(route, signal()); const d = await w.expand(route, 'manifest-next', signal());
  assert.equal(d.singleManifest, true); assert.equal(((d.data.candidate as Data).file_manifest as Data[]).length, 1);
  const previous = await w.expand(route, 'manifest-prev', signal());
  assert.equal(((previous.data.candidate as Data).file_manifest as Data[])[0].path_bytes, '1');
});

test('incomplete report directory is an error, not a misleading zero or complete count', async () => {
  const w = new Workspace({ async query(m, args) { return m === 'verifications' ? { candidate_id: 'c', verification_set: set, verifications: [] } : fixture(m, args); } });
  await w.loadDetail(route, signal()); await assert.rejects(w.expand(route, 'reports', signal()), { code: 'PROTOCOL_ERROR' });
  assert.equal(w.detail(route)?.directory, undefined);
});

test('directional focus is idempotent, keeps scroll, and navigation/state budgets are bounded', () => {
  let n = navigate(initial, { type: 'scroll', scroll: 23 });
  n = navigate(n, { type: 'focus', focus: 'detail' }); n = navigate(n, { type: 'focus', focus: 'detail' });
  assert.equal(n.focus, 'detail'); assert.equal(n.scroll, 23);
  for (let i = 0; i < 33; i++) n = navigate(n, { type: 'open', route: { kind: 'issue', id: String(i) } });
  assert.equal(n.stack.length, 32); assert.match(n.notice!, /32/);
  const positions = new Positions(), state = positions.get('test');
  for (let i = 0; i < 1500; i++) state.expanded[String(i)] = true;
  positions.trim(state); assert.equal(Object.keys(state.expanded).length, 1000);
});

test('an unreadable Requirement detail degrades to its Issue list instead of an empty page', async () => {
  const w = new Workspace({ async query(m: Method, args: string[] = []) {
    if (m === 'requirement') throw new ClientError('ARTIFACT_INTEGRITY_ERROR', 'stored Candidate submission is invalid');
    if (m === 'issues') return { resources: [{ resource_id: 'i', label: '输入校验', version: 1 }] };
    return fixture(m, args);
  } });
  const page = await w.loadScreen({ kind: 'requirement', id: 'r' }, signal());
  assert.match(page.note!, /ARTIFACT_INTEGRITY_ERROR/);
  assert.deepEqual(page.rows.map(r => r.id), ['__requirement', 'i']);
  assert.equal(page.rows[1].route!.kind, 'issue');
});

test('an unreadable Candidate list keeps the Issue board and states the reason', async () => {
  const w = new Workspace({ async query(m: Method, args: string[] = []) {
    if (m === 'candidates') throw new ClientError('ARTIFACT_INTEGRITY_ERROR', 'stored Candidate list entry is invalid');
    return fixture(m, args);
  } });
  const page = await w.loadScreen({ kind: 'issue', id: 'i' }, signal());
  assert.match(page.note!, /Candidate 列表不可读/);
  assert.deepEqual(page.rows.map(r => r.id), ['__issue', '__devruns']);
  assert.ok(page.overview);
});

test('failures other than ledger integrity still fail the whole page', async () => {
  const w = new Workspace({ async query(m: Method, args: string[] = []) {
    if (m === 'requirement') throw new ClientError('TIMEOUT', '查询超时，可调整 --query-timeout 后重试');
    return fixture(m, args);
  } });
  await assert.rejects(w.loadScreen({ kind: 'requirement', id: 'r' }, signal()), { code: 'TIMEOUT' });
});

test('a Requirement without Issues states that Candidates need an Issue version', async () => {
  const w = new Workspace({ async query(m: Method, args: string[] = []) {
    if (m === 'requirement') return { requirement, issues: [], aggregates: { issue_count: 0 } };
    return fixture(m, args);
  } });
  const page = await w.loadScreen({ kind: 'requirement', id: 'r' }, signal());
  assert.match(page.note!, /暂无 Issue/);
  assert.deepEqual(page.rows.map(r => r.id), ['__requirement']);
});

test('the Requirement tree exposes Issue nodes and explains an empty Issue set', async () => {
  const w = new Workspace({ async query(m: Method, args: string[] = []) { return fixture(m, args); } });
  const detail = await w.loadDetail({ kind: 'requirement', id: 'r' }, signal());
  const visible = flatten(detailTree(detail).nodes, {}).map(v => v.node.id);
  assert.ok(visible.some(id => id.endsWith('/issues/i')));
  assert.equal(visible.some(id => id.endsWith('/issues/none')), false);
  const empty = detailTree({ type: 'detail', route: { kind: 'requirement', id: 'r' }, time: '', data: { requirement, aggregates: { issue_count: 0 } } });
  assert.ok(flatten(empty.nodes, {}).some(v => v.node.id.endsWith('/issues/none')));
});

test('the unified directory preserves the Issue hierarchy and nests the selected Candidate', async () => {
  const w = new Workspace({ async query(m: Method, args: string[] = []) { return fixture(m, args); } });
  const page = await w.loadScreen({ kind: 'issue', id: 'i' }, signal());
  const selected = page.rows.find(row => row.id === 'c')!;
  const detail = await w.loadDetail(selected.route, signal());
  const roots = directoryNodes(page, selected, detail);
  const all = (nodes: Node[]): Node[] => nodes.flatMap(node => [node, ...all(node.children ?? [])]);
  const nodes = all(roots);
  assert.match(roots[0]!.label, /^Requirement r · v1/);
  assert.ok(nodes.some(node => node.label === 'Issue 输入校验 · v1'));
  const criterion = nodes.find(node => node.id.endsWith('/goals/goal:g/ac'))!;
  assert.match(criterion.id, /issue:i:1\/goals\/goal:g\/ac$/);
  assert.equal(nodes.find(node => node.id.endsWith('/goals/goal:g'))?.panelTitle, '目标 g');
  assert.equal(criterion.panelTitle, '验收标准 ac');
  assert.equal(nodes.some(node => /^验收标准 ·/.test(node.label)), false);
  const candidateNode = nodes.find(node => node.resourceId === 'c')!;
  assert.ok(candidateNode.children?.some(node => node.label === '提交说明'));
  assert.deepEqual(directoryPath(roots, criterion.id)?.slice(-3), ['目标 · 1', '目标：校验参数', 'ac 拒绝非法参数']);
});

test('Issue view shows the non-normative plan and keeps Mermaid as source text', async () => {
  const plan = '整体方案。\n\n```mermaid\nflowchart TD\n  A-->B\n```';
  const w = new Workspace({ async query(m, args = []) { return m === 'issue' ? { ...fixture(m), issue: { ...issue, plan } } : fixture(m, args); } });
  const detail = await w.loadDetail({ kind: 'issue', id: 'i' }, signal());
  const rendered = JSON.stringify(detailTree(detail));
  // The section is present, labelled non-normative, and carries the source text.
  assert.match(rendered, /方案说明（非约束）/);
  assert.match(rendered, /flowchart TD/);
  assert.match(rendered, /A-->B/);
});

test('an Issue without a plan renders no plan section', async () => {
  const w = new Workspace({ async query(m, args = []) { return fixture(m, args); } });
  const detail = await w.loadDetail({ kind: 'issue', id: 'i' }, signal());
  assert.equal(/方案说明（非约束）/.test(JSON.stringify(detailTree(detail))), false);
});
