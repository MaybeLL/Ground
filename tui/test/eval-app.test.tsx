import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvalApp } from '../src/eval-app.js';
import { DraftStore, newGrader, newQA } from '../src/eval-drafts.js';
import { evaluation, rec } from './eval-fixtures.js';
import type { EvalAccess } from '../src/eval-protocol.js';
const pause = () => new Promise(r => setTimeout(r, 40));
async function until(ui: ReturnType<typeof render>, text: string) { for (let i = 0; i < 80 && !ui.lastFrame()?.includes(text); i++) await pause(); assert.ok(ui.lastFrame()?.includes(text), ui.lastFrame()); }
const down = '\u001b[B', enter = '\r', escape = '\u001b';
async function press(ui: ReturnType<typeof render>, key: string, count = 1) { for (let i = 0; i < count; i++) { for (let n = 0; n < 100 && ui.lastFrame()?.includes('正在读取／保存'); n++) await pause(); ui.stdin.write(key); await pause(); } }
function fixture() {
 let writes = 0;
 const rs = ['A','B','C','D'].map(id => evaluation(id));
 const access: EvalAccess = { read: async (command, args) => command === 'experiment.list' ? rs.map(r => r.experiment) : rs.find(r => r.experiment.id === args![0]), identity: async () => ({ kind: 'human', git_name: '测试', git_email: 'test@example.test' }), database: async () => 'db', publish: async request => { writes++; return rec('qa', 'published', request.body!); } };
 return { access, rs, writes: () => writes };
}
test('experiments with the same name keep visible distinct identity in the dashboard list', async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-same-name-')),f=fixture();
 const access={...f.access,read:async(command:any,args:any)=>{
  const value=await f.access.read(command,args);
  if(command==='experiment.list')return (value as any[]).map(r=>({...r,data:{...r.data,subject:{...r.data.subject,name:'相同实验'}}}));
  return value;
 }};
 const ui=render(<EvalApp access={access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={new DraftStore(root)} width={80} height={24}/>);
 try {await until(ui,'评测工作台');assert.match(ui.lastFrame()!,/A · 相同实验/);assert.match(ui.lastFrame()!,/B · 相同实验/);}
 finally{ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});
test('experiment selection explains incompatible snapshots and preserves chosen groups', async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-snapshot-choice-')),f=fixture();
 f.rs[1].snapshot.id='other-snapshot';f.rs[1].experiment.data.snapshot_id='other-snapshot';
 const ui=render(<EvalApp access={f.access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={new DraftStore(root)} width={160} height={40}/>);
 try {
  await until(ui,'评测工作台');await press(ui,down);await press(ui,' ');await press(ui,down);await press(ui,' ');
  await until(ui,'不可比');assert.match(ui.lastFrame()!,/同一固定 Snapshot/);assert.match(ui.lastFrame()!,/已选 2 组/);
  await press(ui,'c');await until(ui,'对照需要同一 Snapshot');assert.match(ui.lastFrame()!,/已选 2 组/);
 }finally{ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});
for (const [width, height] of [[40,10],[80,24],[160,40]]) test(`Eval matrix keyboard flow at ${width}x${height} remains read-only`, async () => {
 const root = await mkdtemp(join(tmpdir(), 'eval-ui-')), f = fixture();
 const ui = render(<EvalApp access={f.access} reader={{} as any} context={{ databaseId: 'db' } as any} onExit={() => {}} onBack={() => {}} store={new DraftStore(root)} width={width} height={height}/>);
 try {
  await until(ui, '评测工作台'); await press(ui, down);
  for (let i = 0; i < 4; i++) { await press(ui, ' '); if (i < 3) await press(ui, down); }
  await press(ui, 'c'); await until(ui, '多组实验对照'); await until(ui, 'pass');
  if (width === 160) assert.match(ui.lastFrame()!, /1–4\/4/);
  else { await press(ui, '\u001b[C', 3); assert.match(ui.lastFrame()!, /4\/4/); }
  assert.ok(ui.lastFrame()!.split('\n').every(line => stringWidth(line) <= width), ui.lastFrame());
  await press(ui, enter); await until(ui, '同题各组'); await press(ui, enter); await until(ui, '逐题审阅');
  assert.equal(f.writes(), 0); await press(ui, escape); await until(ui, '同题各组');
 } finally { ui.unmount(); ui.cleanup(); await rm(root, { recursive: true, force: true }); }
});
for (const [width,height] of [[40,10],[80,24],[100,30]]) test(`draft preview and cancel are read-only; confirmation publishes once at ${width}x${height}`, async () => {
 const root = await mkdtemp(join(tmpdir(), 'eval-ui-publish-')), store = new DraftStore(root), f = fixture();
 await store.create('db', { command: 'qa.publish', body: { ...newQA(), name: '题目', question: '问题', instructions: '回答', rubric: '规则' } });
 const ui = render(<EvalApp access={f.access} reader={{} as any} context={{ databaseId: 'db' } as any} onExit={() => {}} onBack={() => {}} store={store} width={width} height={height}/>);
 try {
  await until(ui, '评测工作台'); await press(ui, down, 5); await press(ui, enter); await until(ui, 'qa.publish'); await press(ui, enter); await until(ui, '资产草稿');
  await press(ui, down, 8); await press(ui, enter); await until(ui, '发布确认');
  await press(ui, escape); await until(ui, '资产草稿'); assert.equal(f.writes(), 0); await press(ui, enter); await until(ui, '发布确认'); await press(ui, enter);
  await until(ui, '已发布'); assert.equal(f.writes(), 1);
 } finally { ui.unmount(); ui.cleanup(); await rm(root, { recursive: true, force: true }); }
});

for (const [width,height] of [[40,10],[80,24]]) test(`short input stays visible, scrollable and recoverable at ${width}x${height}`, async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-input-')),store=new DraftStore(root),f=fixture();
 const draft=await store.create('db',{command:'suite.create',name:''});
 const ui=render(<EvalApp access={f.access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={store} width={width} height={height}/>);
 try {
  await until(ui,'评测工作台'); await press(ui,down,5); await press(ui,enter); await until(ui,'suite.create');
  await press(ui,enter); await until(ui,'资产草稿'); await press(ui,enter); await press(ui,'VISIBLE_VALUE');
  await until(ui,'VISIBLE_VALUE▌'); assert.equal(f.writes(),0);
  const tail='中文*'.repeat(70)+'END';
  await press(ui,tail); await until(ui,'END▌');
  await press(ui,'\u001b[5~',10); await until(ui,'题集名称');
  await press(ui,'\u001b[6~',10); await until(ui,'END▌');
  await press(ui,escape); assert.equal((await store.load(draft.id)).publication.name,'');
  await press(ui,enter); await press(ui,'已保存'); await until(ui,'已保存▌'); await press(ui,enter); for (let i=0;i<100 && ui.lastFrame()?.includes('▌');i++) await pause(); assert.ok(!ui.lastFrame()?.includes('▌'),ui.lastFrame()); await until(ui,'已保存');
  assert.equal((await store.load(draft.id)).publication.name,'已保存'); assert.equal(f.writes(),0);
 } finally {ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});

test('pending recovery UI blocks other database and requires explicit original attribution', async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-recovery-ui-')),store=new DraftStore(root),f=fixture();
 const old=await f.access.identity(); let database='other', calls=0;
 const draft=await store.prepare(await store.create('db',{command:'suite.create',name:'恢复题集'}),old);
 await store.save({...draft,state:'pending'});
 const access={...f.access,database:async()=>database,identity:async()=>({...old,git_name:'当前用户'}),publish:async(req:any)=>{calls++;assert.deepEqual(req.attribution,old);return rec('suite','saved',{name:req.name});}};
 const ui=render(<EvalApp access={access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={store} width={80} height={24}/>);
 try {
  await until(ui,'评测工作台');await press(ui,down,5);await press(ui,enter);await until(ui,'pending');await press(ui,enter);await until(ui,'资产草稿');
  await press(ui,enter);await until(ui,'发布确认');await press(ui,enter);await until(ui,'属于另一账本');assert.equal(calls,0);
  database='db';await press(ui,enter);await until(ui,'当前归属与原请求不同');assert.equal(calls,0);
  await press(ui,down);await press(ui,enter);await until(ui,'已发布');assert.equal(calls,1);
  assert.equal((await store.load(draft.id)).request!.operationId,draft.request!.operationId);
 } finally {ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});

test('suite member review cancels without writes and resumes after restart', async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-suite-ui-')),store=new DraftStore(root),f=fixture();
 const task={kind:'qa',name:'题目',qa:{id:'qa',version:1},graders:[{id:'grader',version:1}]};
 const original=rec('suite','suite',{name:'题集',tasks:[]},2);
 const draft=await store.create('db',{command:'suite.tasks.publish',id:'suite',expectedVersion:2,body:{format:'grounds.eval-suite-members/v1',tasks:[task]}},original);
 let writes=0;const access={...f.access,publish:async(req:any)=>{writes++;assert.equal(req.command,'suite.tasks.publish');return rec('suite','suite',{name:'题集',tasks:[{...task,id:'member'}]},3);}};
 const open=()=>render(<EvalApp access={access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={store} width={80} height={24}/>);
 let ui=open();
 try {
  await until(ui,'评测工作台');await press(ui,down,5);await press(ui,enter);await until(ui,'suite.tasks.publish');await press(ui,enter);await until(ui,'题集编排');
  await press(ui,down,3);await press(ui,enter);await until(ui,'发布确认');await press(ui,escape);assert.equal(writes,0);
  ui.unmount();ui.cleanup();ui=open();await until(ui,'评测工作台');await press(ui,down,5);await press(ui,enter);await until(ui,'suite.tasks.publish');await press(ui,enter);await until(ui,'题集编排');
  await press(ui,down,3);await press(ui,enter);await until(ui,'发布确认');await press(ui,enter);await until(ui,'已发布');assert.equal(writes,1);assert.equal((await store.load(draft.id)).result?.version,3);
 }finally{ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});
test('rejected suite publication shows old, latest and draft before explicit recheck', async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-suite-conflict-')),store=new DraftStore(root),f=fixture();
 const task={kind:'qa',name:'草稿新增',qa:{id:'qa',version:1},graders:[{id:'grader',version:1}]};
 const original=rec('suite','suite',{name:'题集',tasks:[]},2);
 const latest=rec('suite','suite',{name:'题集',tasks:[{...task,id:'other',name:'其他人新增'}]},3);
 const draft=await store.create('db',{command:'suite.tasks.publish',id:'suite',expectedVersion:2,body:{format:'grounds.eval-suite-members/v1',tasks:[task]}},original);
 await store.save({...draft,state:'rejected',error:'题集版本已更新'});
 const access={...f.access,read:async(command:any,args:any)=>command==='suite.show'?latest:f.access.read(command,args)};
 const ui=render(<EvalApp access={access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={store} width={100} height={30}/>);
 try {
  await until(ui,'评测工作台');await press(ui,down,5);await press(ui,enter);await until(ui,'suite.tasks.publish');await press(ui,enter);await until(ui,'题集编排');
  await press(ui,down,4);await press(ui,enter);await until(ui,'题集冲突');assert.match(ui.lastFrame()!,/草稿基于 v2/);
  await press(ui,enter);await until(ui,'题集编排');const rebased=await store.load(draft.id);
  assert.equal(rebased.state,'editing');assert.equal(rebased.publication.expectedVersion,3);assert.equal(rebased.original?.version,3);
  assert.deepEqual(rebased.publication.body?.tasks,[task]);assert.equal(f.writes(),0);
 }finally{ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});
for (const [width,height] of [[40,10],[80,24],[160,40]]) test(`difference route filters regression at ${width}x${height} without ledger writes`, async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-difference-ui-')),f=fixture();
 ((f.rs[1].tasks[0].runs[0].result!.data.graders as any[])[0].submission.outcome.verdict)='fail';
 const ui=render(<EvalApp access={f.access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={new DraftStore(root)} width={width} height={height}/>);
 try {
  await until(ui,'评测工作台');await press(ui,down);await press(ui,' ');await press(ui,down);await press(ui,' ');await press(ui,'c');await until(ui,'多组实验对照');
  await press(ui,'d');await until(ui,'选择基线实验');await press(ui,enter);await until(ui,'选择对照实验');await press(ui,enter);await until(ui,'实验差异');
  await press(ui,':');await until(ui,'当前操作');await press(ui,enter);await until(ui,'按变化筛选');await press(ui,down,2);await press(ui,enter);await until(ui,'退步');
  await press(ui,enter);await until(ui,'同题并排');if(width>=80){await press(ui,down,12);assert.match(ui.lastFrame()!,/冻结答案/);}else await press(ui,'\u001b[C');assert.ok(ui.lastFrame()!.split('\n').every(line=>stringWidth(line)<=width),ui.lastFrame());assert.equal(f.writes(),0);
 }finally{ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});
test('late dashboard preview cannot replace a later experiment selection', async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-preview-ui-')),f=fixture();
 let release=()=>{};const stalled=new Promise<void>(resolve=>{release=resolve;});
 const access={...f.access,read:async(command:any,args:any)=>{if(command==='experiment.report'&&args[0]==='A')await stalled;return f.access.read(command,args);}};
 const ui=render(<EvalApp access={access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={new DraftStore(root)} width={100} height={30}/>);
 try {
  await until(ui,'评测工作台');await press(ui,down);await press(ui,down);await until(ui,'实验：B');release();await pause();assert.match(ui.lastFrame()!,/实验：B/);assert.doesNotMatch(ui.lastFrame()!,/实验：A/);
 }finally{release();ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});
test('suite member selection previews its frozen question and grading binding', async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-suite-preview-'));
 const suite=rec('suite','suite',{name:'题集',tasks:[{id:'member',kind:'qa',name:'题目',qa:{id:'qa',version:2},graders:[{id:'grader',version:1}]}]},3);
 const qa=rec('qa','qa',{name:'题目',question:'固定版本题面',instructions:'回答',rubric:'私有规则'},2);
 const access={read:async(command:string)=>command==='experiment.list'?[]:command==='suite.list'?[suite]:command==='suite.show'?suite:qa,identity:async()=>({kind:'human',git_name:'测试',git_email:'test@example.test'}),database:async()=> 'db',publish:async()=>suite} as EvalAccess;
 const ui=render(<EvalApp access={access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={new DraftStore(root)} width={100} height={30}/>);
 try {
  await until(ui,'评测工作台');await press(ui,enter);await until(ui,'题集与评分');assert.match(ui.lastFrame()!,/选择题集即预览/);assert.doesNotMatch(ui.lastFrame()!,/Space 选实验/);await press(ui,down);await press(ui,enter);await until(ui,'题集 · v3');await press(ui,down);await until(ui,'固定版本题面');assert.match(ui.lastFrame()!,/grader · v1/);assert.doesNotMatch(ui.lastFrame()!,/私有规则/);
 }finally{ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});

test('main dashboard directly advertises search and accepts the shortcut', async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-search-hint-')),f=fixture();
 const ui=render(<EvalApp access={f.access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={new DraftStore(root)} width={40} height={10}/>);
 try {await until(ui,'评测工作台');assert.match(ui.lastFrame()!,/\/ 搜索/);await press(ui,'/');await until(ui,'输入筛选');}
 finally{ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});

test('publishing a matching Grader restores the exact suite member and offers an explicit draft binding', async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-grader-return-')),store=new DraftStore(root),f=fixture();
 const target={id:'qa',version:2},task={kind:'qa',name:'原成员',qa:target,graders:[]};
 const suite=rec('suite','suite',{name:'题集',tasks:[]},2);
 const parent=await store.create('db',{command:'suite.tasks.publish',id:'suite',expectedVersion:2,body:{format:'grounds.eval-suite-members/v1',tasks:[task]}},suite);
 const grader={...newGrader({qa:target}),name:'新评分',scope:{kind:'diagnostic',name:'正确性'},definition:{type:'agent',instructions:'按依据评分'},limitations:'仅检查此题'};
 const child=await store.create('db',{command:'grader.publish',body:grader},undefined,parent.id,{index:0});
 const prepared=await store.prepare(child,await f.access.identity());
 await store.save({...prepared,state:'pending'});
 let writes=0;const access={...f.access,publish:async()=>{writes++;return rec('grader','new-grader',grader,1);}};
 const ui=render(<EvalApp access={access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={store} width={100} height={30}/>);
 try {
  await until(ui,'评测工作台');await press(ui,down,5);await press(ui,enter);await until(ui,'本机草稿与待恢复操作');
  await press(ui,'/');await press(ui,'grader.publish');await press(ui,enter);await press(ui,enter);await until(ui,'资产草稿');
  await press(ui,enter);await until(ui,'发布确认');await press(ui,enter);await until(ui,'编排 · 原成员');
  assert.match(ui.lastFrame()!,/绑定刚发布的 Grader v1/);assert.match(ui.lastFrame()!,/题集草稿尚未发布/);
  await press(ui,enter);await until(ui,'题集编排');
  assert.deepEqual((await store.load(parent.id)).publication.body?.tasks,[{...task,graders:[{id:'new-grader',version:1}]}]);
  assert.equal(writes,1);assert.equal((await store.load(child.id)).state,'published');
 }finally{ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});

test('matrix keeps explicit attempt through return and refresh, and still permits reselection', async () => {
 const root=await mkdtemp(join(tmpdir(),'eval-multiple-ui-')),f=fixture();
 const t=f.rs[0].tasks[0], a=structuredClone(t.runs[0]);
 a.run.id='second';a.run.data.result_id='second-result';a.run.data.artifact_id='second-artifact';
 a.result!.id='second-result';a.result!.data.run_id='second';a.artifact!.id='second-artifact';a.artifact!.data.run_id='second';
 (a.result!.data.graders as any[])[0].submission.outcome.verdict='fail';t.runs.push(a);
 const ui=render(<EvalApp access={f.access} reader={{} as any} context={{databaseId:'db'} as any} onExit={()=>{}} onBack={()=>{}} store={new DraftStore(root)} width={160} height={40}/>);
 try {
  await until(ui,'评测工作台');await press(ui,down);
  await press(ui,' ');await press(ui,down);await press(ui,' ');await press(ui,'c');await until(ui,'2 次 · 待选择');
  await press(ui,enter);await press(ui,enter);await until(ui,'选择本组尝试');await press(ui,down);await press(ui,enter);await until(ui,'逐题审阅');
  await press(ui,escape,3);await until(ui,'多组实验对照');await until(ui,'fail');
  await press(ui,'\x12');await until(ui,'fail');
  await press(ui,enter);await press(ui,enter);await until(ui,'选择本组尝试');await press(ui,enter);await until(ui,'逐题审阅');
  await press(ui,escape,3);await until(ui,'多组实验对照');assert.doesNotMatch(ui.lastFrame()!,/fail/);
 } finally {ui.unmount();ui.cleanup();await rm(root,{recursive:true,force:true});}
});
