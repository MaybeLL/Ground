import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { RequirementView, issueDetailLines, requirementLayout, requirementLines, requirementWidth } from '../src/requirement-view.js';

const requirement = { id: 'req', version: 1, summary: '标题', context: '背景原文', outcomes: ['成果原文'] };
const common = { requirement, rows: [], total: 0, query: '', row: 0, requirementScroll: 0, issueScroll: 0, busy: false, notice: '', width: 100, height: 32 };

test('Requirement tab keeps the complete prose without an embedded Issue list', () => {
  const view = render(<RequirementView {...common} activeTab="requirement" />);
  try {
    const frame = view.lastFrame()!;
    assert.match(frame, /Requirement.*Issue \(0\)/);
    assert.match(frame, /背景原文/);
    assert.match(frame, /成果原文/);
    assert.match(frame, /决策：未记录 · 待澄清问题：未记录/);
    assert.doesNotMatch(frame, /关联 Issue ·|该需求尚无关联 Issue/);
    assert.match(frame, /Tab 切换 Requirement\/Issue/);
  } finally { view.unmount(); view.cleanup(); }
});

test('Issue tab shows only linked rows, binding version, then the selected Issue detail', () => {
  const rows = [{ resource_id: 'one', label: '任务一', version: 2, bound_to_selected_version: false, requirementVersion: 2 }];
  const list = render(<RequirementView {...common} activeTab="issues" rows={rows} total={1} />);
  try {
    assert.match(list.lastFrame()!, /关联 Issue · 1 个/);
    assert.match(list.lastFrame()!, /v2 · 绑定需求 v2 · 任务一/);
    assert.doesNotMatch(list.lastFrame()!, /背景原文/);
  } finally { list.unmount(); list.cleanup(); }
  const detail = { issue: { id: 'one', version: 2, summary: '任务一', requirement: { id: 'req', version: 2 }, context: '任务背景', goals: [{ statement: '目标一', criteria: [{ statement: '标准一' }] }], constraints: [] }, repository: { canonical_remote: 'ssh://example/repo' }, baseline: { git_oid: 'sha1:abc' }, board: { status: 'ready', candidate_count: 1, open_dev_run_count: 0, selection: { state: 'unselected' } } };
  const page = render(<RequirementView {...common} activeTab="issues" rows={rows} total={1} issueDetail={detail} />);
  try {
    assert.match(page.lastFrame()!, /Issue 详情 · v2 · 任务一/);
    assert.match(page.lastFrame()!, /任务背景/);
    assert.match(page.lastFrame()!, /标准一/);
    assert.match(page.lastFrame()!, /Enter 查看 Candidate/);
    assert.match(issueDetailLines(detail, 90).join('\n'), /绑定 Requirement v2/);
  } finally { page.unmount(); page.cleanup(); }
});

test('reading width and viewport stay usable at minimum size', () => {
  assert.equal(requirementWidth(200), 104);
  assert.equal(requirementWidth(60), 56);
  assert.ok(requirementLayout(10, 3, true) >= 1);
  const view = render(<RequirementView {...common} activeTab="issues" width={40} height={10} />);
  try { assert.match(view.lastFrame()!, /Requirement.*Issue/); assert.match(view.lastFrame()!, /该需求尚无关联 Issue/); }
  finally { view.unmount(); view.cleanup(); }
});

test('40x10 keeps exact versions, full Requirement ID and Enter visible with long summaries', () => {
  const id = '01a0ebfa-92e8-7a56-bdc6-c5ed151c26f3';
  const longRequirement = { ...requirement, id, version: 12, summary: '一个稍长的需求标题用于核对完整身份是否显示' };
  const rows = [{ resource_id: 'issue', label: '一个很长很长的关联任务标题使列表行尾的版本和绑定信息被截断', version: 5, bound_to_selected_version: false, requirementVersion: 9 }];
  const props = { ...common, requirement: longRequirement, rows, total: 1, width: 40, height: 10 };
  assert.match(requirementLines(longRequirement, requirementWidth(40)).join(''), /一个稍长的需求标题用于核对完整身份是否显示/);
  const list = render(<RequirementView {...props} activeTab="issues" />);
  try {
    const frame = list.lastFrame()!;
    assert.match(frame, /当前需求 v12/);
    assert.match(frame, new RegExp(`ID ${id}`));
    assert.match(frame, /Requirement.*Issue \(1\)/);
    assert.match(frame, /v5 · 绑定需求 v9/);
    assert.match(frame, /Enter 详情/);
    assert.match(frame, /Esc 需求/);
  } finally { list.unmount(); list.cleanup(); }
  const detail = { issue: { id: 'issue', version: 5, summary: rows[0].label, requirement: { id, version: 9 } }, board: { candidate_count: 1 } };
  assert.match(issueDetailLines(detail, requirementWidth(40)).join(''), /一个很长很长的关联任务标题使列表行尾的版本和绑定信息被截断/);
  const page = render(<RequirementView {...props} activeTab="issues" issueDetail={detail} />);
  try {
    assert.match(page.lastFrame()!, /Issue 详情 · v5/);
    assert.match(page.lastFrame()!, /Enter 候选 · Esc 列表/);
  } finally { page.unmount(); page.cleanup(); }
});
