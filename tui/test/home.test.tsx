import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { FULL_GROUNDS_LOGO, searchIssues, weekIssues, SearchHome } from '../src/home.js';
const now = Date.parse('2026-09-17T00:00:00Z');
const items = [
  { resource_id: 'id-a', label: '安装 Search Skills', version: 1, last_activity: { occurred_at: '2026-09-16T00:00:00Z' } },
  { resource_id: 'id-b', label: '旧需求', version: 2, last_activity: { occurred_at: '2026-09-01T00:00:00Z' } },
  { resource_id: 'id-c', label: '无时间' },
];
test('home searches all titles and IDs with all terms; week list excludes old, missing and future timestamps', () => {
  assert.deepEqual(searchIssues(items, 'skills 安装'), [items[0]]);
  assert.deepEqual(searchIssues(items, 'ID-B'), [items[1]]);
  assert.deepEqual(searchIssues(items, 'absent'), []);
  assert.deepEqual(weekIssues([...items, { last_activity: { occurred_at: '2026-09-18' } }], now), [items[0]]);
});
test('home gives result suggestions and a clear empty state without raw metadata', () => {
  const props = { items, results: items, query: '', row: 0, recent: false, busy: false, notice: '', width: 100, height: 30 };
  const view = render(<SearchHome {...props} />);
  try {
    assert.match(view.lastFrame()!, /找到任务，开始审阅/);
    assert.match(view.lastFrame()!, /安装 Search Skills/);
    assert.doesNotMatch(view.lastFrame()!, /occurred_at|最近业务活动：/);
    for (const shortcut of ['输入标题/ID 搜索', 'Backspace 删除', '↑↓ 选结果', 'Enter 打开', 'Tab 最近一周/搜索', 'Esc 清空/返回', 'Ctrl+T 切换需求/任务', 'Ctrl+R 刷新', '? 全部操作', 'Ctrl+C 退出']) assert.ok(view.lastFrame()!.includes(shortcut), shortcut);
  } finally { view.unmount(); view.cleanup(); }
});

test('root home renders the full identity without shifting it for query or recent mode', () => {
  const base = { items, results: items, row: 0, busy: false, notice: '', width: 100, height: 30 };
  for (const state of [
    { query: '', recent: false },
    { query: 'skills', recent: false },
    { query: '', recent: true },
  ]) {
    const view = render(<SearchHome {...base} {...state} />);
    try {
      const frame = view.lastFrame()!;
      assert.match(frame, new RegExp(FULL_GROUNDS_LOGO[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(frame, /有 据/);
      assert.match(frame, /可信交付 · Know How\. Know Why\./);
      assert.equal(frame.match(/Grounds/g)?.length, 1);
      assert.match(frame, /找到任务，开始审阅/);
      assert.match(frame, /↑↓ 选结果/);
    } finally { view.unmount(); view.cleanup(); }
  }
});

test('home honors full, compact and hidden brand boundaries without crowding functional content', () => {
  const base = { items, results: items, query: '', row: 0, recent: false, busy: false, notice: '' };
  const cases = [
    { width: 94, height: 28, parent: undefined, full: true, compact: false },
    { width: 93, height: 28, parent: undefined, full: false, compact: true },
    { width: 94, height: 27, parent: undefined, full: false, compact: true },
    { width: 60, height: 22, parent: undefined, full: false, compact: true },
    { width: 59, height: 22, parent: undefined, full: false, compact: false },
    { width: 60, height: 21, parent: undefined, full: false, compact: false },
    { width: 100, height: 30, parent: '可信交付', full: false, compact: false },
  ];
  for (const current of cases) {
    const view = render(<SearchHome {...base} {...current} />);
    try {
      const frame = view.lastFrame()!;
      assert.equal(frame.includes(FULL_GROUNDS_LOGO[0]), current.full);
      assert.equal(frame.includes('有据  G R O U N D S'), current.compact);
      assert.equal(frame.includes('可信交付 · Know How. Know Why.'), current.full);
      assert.match(frame, /输入标题关键词或 Issue ID/);
      assert.match(frame, /安装 Search Skills/);
      assert.match(frame, /↑↓ 选结果/);
    } finally { view.unmount(); view.cleanup(); }
  }
});
