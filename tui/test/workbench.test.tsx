import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { EntryHome, Workbench } from '../src/workbench.js';
import type { Client } from '../src/client.js';
const pause = () => new Promise(r => setTimeout(r, 40));
async function press(ui: ReturnType<typeof render>, key: string) { ui.stdin.write(key); await pause(); }
for (const [width, height] of [[152,40],[80,24],[40,10]]) test(`home keeps both entries and hints within ${width}x${height}`, async () => {
 const opened: string[] = [];
 const ui = render(<EntryHome width={width} height={height} onOpen={m => opened.push(m)} onExit={() => {}} />);
 try {
  await pause();
  if (process.env.NO_COLOR !== undefined) assert.doesNotMatch(ui.lastFrame()!, /\u001b\[[0-9;]*m/);
  else if (process.env.FORCE_COLOR) { assert.match(ui.lastFrame()!, /\u001b\[36m/); assert.match(ui.lastFrame()!, /\u001b\[90m/); }
  const frame = stripAnsi(ui.lastFrame()!); const lines = frame.split('\n');
  assert.ok(lines.length <= height - 1, frame);
  assert.ok(lines.every(l => stringWidth(l) <= width), frame);
  assert.ok(lines.some(l => l.includes('需求开发') && l.includes('评测')), frame);
  assert.match(frame, /▸ 需求开发/); assert.match(frame, /Tab 选择 · Enter 进入/);
  if (width >= 80) for (const text of ['查找需求 · 查看开发进度','审阅候选 · 对照与交付','题集 · 题目 · 评分规则','运行状态 · 结果与对照']) assert.ok(frame.includes(text));
  await press(ui,'\r'); await press(ui,'\u001b[C'); assert.match(ui.lastFrame()!,/▸ 评测/); await press(ui,'\r');
  await press(ui,'\t'); await press(ui,'\r'); await press(ui,'\u001b[C'); await press(ui,'\u001b[D'); await press(ui,'\r');
  assert.deepEqual(opened,['development','evaluation','development','development']);
 } finally {ui.unmount();ui.cleanup();}
});
test('workbench enters both areas, preserves nested back, returns home and supports direct Eval', async () => {
 let writes=0, reads=0;
 const client = {context:{databaseId:'test'}, query:async () => {reads++;return {resources:[]};}, read:async () => [], publish:async () => {writes++;}, selectCandidate:async () => {writes++;}} as unknown as Client;
 const ui=render(<Workbench client={client} onExit={()=>{}} width={80} height={24}/>);
 try {
  await pause(); assert.equal(reads,0); await press(ui,'\r'); assert.match(ui.lastFrame()!,/查找需求/); assert.match(ui.lastFrame()!,/Ctrl\+G 返回首页/);
  await press(ui,'?'); await press(ui,'\x07'); assert.match(ui.lastFrame()!,/当前页面全部操作/); await press(ui,'\x1b');
  await press(ui,'\x07'); assert.match(ui.lastFrame()!,/▸ 需求开发/);
  await press(ui,'\t'); await press(ui,'\r'); assert.match(ui.lastFrame()!,/评测工作台/); assert.match(ui.lastFrame()!,/Esc 返回首页/);
  await press(ui,'\r'); assert.match(ui.lastFrame()!,/尚无题集记录/);
  await press(ui,'\x1b'); assert.match(ui.lastFrame()!,/▸ 需求开发/);
  await press(ui,'\r'); await press(ui,'\x05'); assert.match(ui.lastFrame()!,/评测工作台/); assert.equal(writes,0);
 } finally {ui.unmount();ui.cleanup();}
 const direct=render(<Workbench client={client} startEval onExit={()=>{}} width={80} height={24}/>);
 try {await pause();assert.match(direct.lastFrame()!,/评测工作台/);await press(direct,'\x1b');assert.match(direct.lastFrame()!,/▸ 需求开发/);} finally {direct.unmount();direct.cleanup();}
});
