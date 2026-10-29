import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { App, clean, directoryWidth, fold, initial, navigate } from '../src/app.js';
import type { Data, Method } from '../src/protocol.js';
import { fixture } from './fixtures.js';

const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (ready: () => boolean, timeout = 2_000) => {
  const deadline = Date.now() + timeout;
  while (!ready() && Date.now() < deadline) await pause(20);
  assert.ok(ready(), 'timed out waiting for asynchronous UI state');
};
const context = { cli: 'cli', version: 'dev', configSource: '/test/config', databaseId: 'db', driver: 'sqlite', cwd: '/test' };

test('a late response cannot replace the newly selected Requirement', async () => {
  let releaseFirst!: (data: Data) => void;
  let releaseSecond!: (data: Data) => void;
  const reader = { async query(method: Method, args: string[] = []) {
    if (method === 'requirements') return { resources: [{ resource_id: 'r1', label: '第一项' }, { resource_id: 'r2', label: '第二项' }] };
    return new Promise<Data>(resolve => {
      if (args[0] === 'r1') releaseFirst = resolve;
      else releaseSecond = resolve;
    });
  } };
  const view = render(<App reader={reader} context={context} onExit={() => {}} width={120} height={28} />);
  try {
    await waitFor(() => typeof releaseFirst === 'function');
    view.stdin.write('j');
    await waitFor(() => typeof releaseSecond === 'function');
    releaseFirst({ requirement: { id: 'r1', version: 1, summary: '过期正文' }, issues: [], aggregates: { issue_count: 0 } });
    await pause();
    assert.doesNotMatch(view.lastFrame()!, /过期正文/);
    releaseSecond({ requirement: { id: 'r2', version: 1, summary: '第二项正文' }, issues: [], aggregates: { issue_count: 0 } });
    await waitFor(() => /第二项正文/.test(view.lastFrame() ?? ''));
    assert.doesNotMatch(view.lastFrame()!, /过期正文/);
  } finally { view.unmount(); view.cleanup(); }
});

test('navigation keeps scroll but clears comparison selection on refresh or version navigation', () => {
  let state = navigate(initial, { type: 'scroll', scroll: 45 });
  state = navigate(state, { type: 'open', route: { kind: 'issue', id: 'i' } });
  state = navigate(state, { type: 'mark', id: 'c' });
  assert.deepEqual(navigate(state, { type: 'refresh' }).marked, []);
  assert.equal(navigate(state, { type: 'back' }).scroll, 45);
});

test('Requirement directory selection immediately previews full content', async () => {
  const view = render(<App reader={{ async query(method: Method, args?: string[]) { return fixture(method, args); } }} context={context} onExit={() => {}} width={130} height={34} />);
  try {
    await waitFor(() => /背景标题/.test(view.lastFrame() ?? ''));
    const frame = view.lastFrame()!;
    assert.match(frame, /结构目录/);
    assert.match(frame, /完整需求 · v1 · r/);
    assert.match(frame, /背景标题/);
    assert.match(frame, /Issue · 1/);
    assert.doesNotMatch(frame, /打开全文/);
    assert.doesNotMatch(frame, /正文 · \d|缓存于|焦点/);
    assert.match(frame, /目录 1\/8 · 行 1\//);
    view.stdin.write('j'); await pause();
    assert.match(view.lastFrame()!, /背景/);
    assert.match(view.lastFrame()!, /背景标题/);
  } finally { view.unmount(); view.cleanup(); }
});

test('Issue opens as Requirement → Issue → Goal → Criterion without a criterion collection layer', async () => {
  const view = render(<App reader={{ async query(method: Method, args?: string[]) { return fixture(method, args); } }} context={context} onExit={() => {}} width={145} height={38} />);
  try {
    await pause(400);
    for (let i = 0; i < 6; i++) { view.stdin.write('j'); await pause(); }
    assert.match(view.lastFrame()!, /输入校验 · v1/);
    view.stdin.write('\r'); await pause(400);
    const issueFrame = view.lastFrame()!;
    assert.match(issueFrame, /Requirement r · v1/);
    assert.match(issueFrame, /Issue 输入校验 · v1/);
    assert.match(issueFrame, /目标 · 1/);
    assert.match(issueFrame, /约束 · 1/);
    for (let i = 0; i < 3; i++) { view.stdin.write('j'); await pause(); }
    view.stdin.write('\u001b[C'); await pause();
    assert.match(view.lastFrame()!, /目标：校验参数/);
    view.stdin.write('\u001b[C'); await pause();
    view.stdin.write('\u001b[C'); await pause();
    view.stdin.write('\u001b[C'); await pause();
    assert.match(view.lastFrame()!, /ac 拒绝非法参数/);
    assert.doesNotMatch(view.lastFrame()!, /验收标准 · 1/);
    assert.match(view.lastFrame()!, /所属目标：校验参数/);
  } finally { view.unmount(); view.cleanup(); }
});

test('body focus preserves a separate reading position for each directory node', async () => {
  const requirement = { id: 'r', version: 1, summary: '长需求', context: Array.from({ length: 80 }, (_, i) => `中文行${i}`).join('\n\n'), outcomes: [], decisions: [], open_questions: [] };
  const reader = { async query(method: Method) { return method === 'requirements' ? { resources: [{ resource_id: 'r', label: '长需求' }] } : { requirement, issues: [], aggregates: { issue_count: 0 } }; } };
  const view = render(<App reader={reader} context={context} onExit={() => {}} width={120} height={24} />);
  try {
    await pause(400); view.stdin.write('\t'); await pause(); view.stdin.write('\u001b[F'); await pause();
    assert.match(view.lastFrame()!, /待解决问题/);
    view.stdin.write('\u001b'); await pause();
    assert.match(view.lastFrame()!, /目录 1\/7/);
    view.stdin.write('j'); await pause();
    view.stdin.write('\t'); await pause();
    view.stdin.write('\u001b[H'); await pause();
    assert.match(view.lastFrame()!, /中文行0/);
    view.stdin.write('\u001b'); await pause();
    view.stdin.write('k'); await pause();
    view.stdin.write('\t'); await pause();
    assert.match(view.lastFrame()!, /待解决问题/);
    view.stdin.write('\u001b'); await pause();
    assert.match(view.lastFrame()!, /长需求 · r/);
  } finally { view.unmount(); view.cleanup(); }
});

test('body search treats q as text and matches current prose', async () => {
  let exited = false;
  const requirement = { id: 'r', version: 1, summary: '搜索需求', context: '包含 query_token 的背景', outcomes: [], decisions: [], open_questions: [] };
  const reader = { async query(method: Method) { return method === 'requirements' ? { resources: [{ resource_id: 'r', label: '搜索需求' }] } : { requirement, issues: [], aggregates: { issue_count: 0 } }; } };
  const view = render(<App reader={reader} context={context} onExit={() => { exited = true; }} width={120} height={25} />);
  try {
    await pause(400); view.stdin.write('\t'); await pause(); view.stdin.write('/'); await pause(); view.stdin.write('query_token'); await pause(); view.stdin.write('\r'); await pause();
    assert.equal(exited, false);
    assert.match(view.lastFrame()!, /找到 1 个匹配行/);
    assert.match(view.lastFrame()!, /query_token/);
  } finally { view.unmount(); view.cleanup(); }
});

test('decision items use a short path and panel title without repeating the statement', async () => {
  const uuid = '01a081d1-6460-797a-aa71-97b324ab259c';
  const requirement = { id: uuid, version: 3, summary: '费率结构化授信改造', context: '背景', outcomes: [],
    decisions: [{ statement: '使用显式 selector 与严格错误语义', rationale: '避免静默回退' }], open_questions: [] };
  const reader = { async query(method: Method) { return method === 'requirements'
    ? { resources: [{ resource_id: uuid, label: `费率结构化授信改造 · v3 · ${uuid}`, version: 3 }] }
    : { requirement, issues: [], aggregates: { issue_count: 0 } }; } };
  const view = render(<App reader={reader} context={context} onExit={() => {}} width={150} height={28} />);
  try {
    await pause(400);
    for (let i = 0; i < 3; i++) { view.stdin.write('j'); await pause(); }
    view.stdin.write('\u001b[C'); await pause();
    view.stdin.write('\u001b[C'); await pause();
    const frame = view.lastFrame()!;
    assert.equal(frame.split('\n')[1], '费率结构化授信改造 · v3 / 决策 / 决策 1');
    assert.match(frame, /│决策 1/);
    assert.equal(frame.match(/使用显式 selector 与严格错误语义/g)?.length, 2);
    assert.match(frame, /避免静默回退/);
  } finally { view.unmount(); view.cleanup(); }
});

test('wide panes share one stable frame and one divider', async () => {
  const view = render(<App reader={{ async query(method: Method, args?: string[]) { return fixture(method, args); } }} context={context} onExit={() => {}} width={100} height={25} />);
  try {
    await pause(400);
    const lines = view.lastFrame()!.split('\n');
    const top = lines.findIndex(line => line.startsWith('╭'));
    const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╰'));
    assert.ok(top >= 0 && bottom > top);
    assert.doesNotMatch(lines[top]!, /╮╭/, 'adjacent pane frames create a doubled center border');
    assert.equal(lines[top + 1]!.match(/│/g)?.length, 3, 'content rows need two outer borders and one divider');
    for (const line of lines.slice(top, bottom + 1)) assert.equal(stringWidth(line), 100, `unstable border row: ${JSON.stringify(line)}`);
  } finally { view.unmount(); view.cleanup(); }
});

test('Candidate remains inside the Issue directory and can be marked for comparison', async () => {
  const calls: Method[] = [];
  const view = render(<App reader={{ async query(method: Method, args?: string[]) { calls.push(method); return fixture(method, args); } }} context={context} onExit={() => {}} width={145} height={38} />);
  try {
    await pause(400);
    for (let i = 0; i < 6; i++) { view.stdin.write('j'); await pause(); }
    view.stdin.write('\r'); await pause(400);
    for (let i = 0; i < 8; i++) { view.stdin.write('j'); await pause(); }
    await pause(350);
    const frame = view.lastFrame()!;
    assert.match(frame, /Requirement r · v1/);
    assert.match(frame, /Issue 输入校验 · v1/);
    assert.match(frame, /Candidate c/);
    assert.match(frame, /实现说明/);
    view.stdin.write(' '); await pause();
    assert.match(view.lastFrame()!, /\[x\] 方案 A · c/);
    for (let i = 0; i < 3; i++) { view.stdin.write('j'); await pause(); }
    view.stdin.write('\r'); await pause(350);
    assert.match(view.lastFrame()!, /解释覆盖/);
    assert.equal(calls.filter(method => method === 'review').length, 1);
    view.stdin.write('\u001b[D'); await pause(); // Collapse reasons.
    view.stdin.write('\u001b[D'); await pause(); // Select parent Candidate.
    view.stdin.write('\u001b[D'); await pause(); // Collapse Candidate details.
    view.stdin.write('j'); await pause();
    view.stdin.write(' '); await pause();
    assert.match(view.lastFrame()!, /\[x\] 方案 B · c2/);
    view.stdin.write('c'); await pause(350);
    const compareFrame = view.lastFrame()!;
    assert.match(compareFrame, /Compare/);
    assert.match(compareFrame, /A · c/);
    assert.match(compareFrame, /B · c2/);
    assert.doesNotMatch(compareFrame.split('\n').find(line => line.startsWith('╭')) ?? '', /╮╭/);
  } finally { view.unmount(); view.cleanup(); }
});

test('help and undersized terminal keep input and exit priorities', async () => {
  let exited = false;
  const props = { reader: { async query(method: Method, args?: string[]) { return fixture(method, args); } }, context, onExit: () => { exited = true; } };
  const view = render(<App {...props} width={100} height={25} />);
  try {
    await pause();
    for (const shortcut of ['↑↓/j/k 选择', 'PgUp/PgDn 翻页', '←/→ 层级', 'Enter 展开/打开/阅读', 'Tab 查看正文', '/ 筛选', 'r 刷新', '? 帮助', 'q/Ctrl+C 退出']) assert.ok(view.lastFrame()!.includes(shortcut), shortcut);
    await pause(); view.stdin.write('?'); await pause(); view.stdin.write('q'); await pause(); assert.equal(exited, false);
    view.stdin.write('\u001b'); await pause(); view.stdin.write('/'); await pause(); view.stdin.write('qr'); await pause(); assert.match(view.lastFrame()!, /qr█/);
    view.rerender(<App {...props} width={50} height={15} />); await pause(); view.stdin.write('k'); await pause();
    view.rerender(<App {...props} width={100} height={25} />); await pause(); assert.match(view.lastFrame()!, /qr█/);
    view.rerender(<App {...props} width={50} height={15} />); await pause(); view.stdin.write('q'); await pause(); assert.equal(exited, true);
  } finally { view.unmount(); view.cleanup(); }
});

test('terminal controls are removed and Chinese text wraps without losing characters', () => {
  assert.equal(clean('\u001b[31m红色\u001b[0m\u0007'), '红色');
  assert.equal(fold(['中文内容很长'], 4).join(''), '中文内容很长');
  assert.equal(directoryWidth(120), 38);
  assert.equal(directoryWidth(200), 60);
  assert.equal(directoryWidth(300), 64);
});
