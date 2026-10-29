import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Client } from '../../src/client.js';
import { DraftStore, newQA, newGrader } from '../../src/eval-drafts.js';
import { checkedReport, type Publication } from '../../src/eval-protocol.js';
import { reports, matrixRows, differenceRows, readEvidence, attemptText } from '../../src/eval-model.js';

test('SQLite real CLI: asset revisions, mixed fixed results, evidence and idempotent human publishing', { timeout: 360000 }, async () => {
 const root = mkdtempSync(join(tmpdir(), 'grounds-tui-eval-')), config = join(root, 'config.yaml');
 const cli = process.env.GROUNDS_RELEASE_CLI ?? resolve('../typescript/dist/src/bin.js');
 let client: Client | undefined;
 const startedAt = performance.now(); let cliMs = 0, cliCalls = 0; const ptyMs: Record<string, number> = {};
 const run = (...args: string[]): any => {
  const began = performance.now(); cliCalls++;
  try {
   const envelope = JSON.parse(execFileSync(cli, [...args, '--config', config, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 30000 }));
   assert.equal(envelope.ok, true); return envelope.data.payload ?? envelope.data;
  } finally { cliMs += performance.now() - began; }
 };
 const pty = (script: string, args: string[], env: NodeJS.ProcessEnv): string => {
  const began = performance.now();
  try { return execFileSync('python3', [script, ...args], { cwd: resolve('.'), env: { ...process.env, ...env }, encoding: 'utf8', timeout: 90000 }); }
  finally { ptyMs[script] = (ptyMs[script] ?? 0) + performance.now() - began; }
 };
 const file = (name: string, value: unknown) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path; };
 try {
  execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['config','user.name','Eval Fixture'], { cwd: root }); execFileSync('git', ['config','user.email','eval@example.test'], { cwd: root });
  run('init','--driver','sqlite','--path',join(root,'ledger.db'),'--non-interactive');
  client = await Client.open({ cli, cwd: root, config, timeout: 30000 });
  const store = new DraftStore(join(root,'grounds-tui','eval')), database = await client.database(), identity = await client.identity();
  const publish = async (p: Publication, original?: any) => { const draft = await store.prepare(await store.create(database, p, original), identity); const done = await store.send(draft, client!); const replay = await client!.publish(done.request!); assert.equal(replay.id, done.result!.id); assert.equal(replay.version, done.result!.version); assert.equal(replay.attribution.kind, 'human'); return done.result!; };
  const qa = await publish({ command: 'qa.publish', body: { ...newQA(), name:'恢复题目', question:'q'.repeat(40000), instructions:'解释步骤', rubric:'r'.repeat(40000) } });
  const grader = await publish({ command: 'grader.publish', body: { ...newGrader({ qa: {id:qa.id,version:1} }), name:'正确性', scope:{kind:'diagnostic',name:'正确性'}, definition:{type:'agent',instructions:'按规则评分'}, limitations:'合成实验' } });
  let suite = await publish({command:'suite.create',name:'测试题集'});
  suite = await publish({command:'suite.task.add',id:suite.id,expectedVersion:1,body:{kind:'qa',name:'恢复题目',qa:{id:qa.id,version:1},graders:[{id:grader.id,version:1}] }}, suite);
  const experiments: string[] = []; let snapshot = '', artifactId = '';
  for (const [i, name] of ['A','B','C','D','E'].entries()) {
   const exp = run('eval','experiment','create', ...(snapshot ? ['--snapshot',snapshot] : ['--suite',suite.id]), '--file',file('subject.json',{name,description:'合成数据，无模型调用'})); snapshot = exp.data.snapshot_id; experiments.push(exp.id);
   if (i === 3) continue;
   const started = run('eval','run','start','--experiment',exp.id,'--task',(suite.data.tasks as any[])[0].id);
   const bytes = Buffer.from('a'.repeat(65535)+'中文证据'), evidence = join(root,'evidence'+i); mkdirSync(evidence); writeFileSync(join(evidence,'tools.jsonl'),bytes);
   const artifact = run('eval','artifact','submit','--file',file('artifact.json',{ format:'grounds.eval-artifact/v1',run_id:started.id,qa:{id:qa.id,version:1},answer:'冻结答案 '+name,citations:[],execution:{session_id:'answer'+i,started_at:'2026-09-28T00:00:00Z',finished_at:'2026-09-28T00:00:01Z',exit_code:0,status:'completed',declared:{},observed:{}},capture:{coverage:'partial',limitations:['合成数据']},files:[{name:'tools.jsonl',size:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')}]}),'--files',evidence);
   artifactId = artifact.id;
   const packet = run('eval','grader','context','--eval-run',started.id,'--grader',grader.id,'--out',join(root,'grade'+i));
   run('eval','grader','submit','--file',file('grade.json',{format:'grounds.eval-grader-submission/v1',execution_id:packet.execution_id,context_digest:packet.context_digest,status:'completed',outcome:{kind:'qa_decision',verdict:['pass','partial','fail',undefined,'pass'][i]},explanation:'逐题评分依据',evidence:[{kind:'observation',content:'合成答案'}]}));
   run('eval','run','finish',started.id);
  }
  const failed = run('eval','experiment','create','--snapshot',snapshot,'--file',file('subject-failed.json',{name:'F',description:'合成作答执行失败'})); experiments.push(failed.id);
  const failedRun = run('eval','run','start','--experiment',failed.id,'--task',(suite.data.tasks as any[])[0].id);
  const failedBytes = Buffer.from('failed answer trace'), failedEvidence = join(root,'failed-evidence'); mkdirSync(failedEvidence); writeFileSync(join(failedEvidence,'tools.jsonl'),failedBytes);
  run('eval','artifact','submit','--file',file('failed-artifact.json',{format:'grounds.eval-artifact/v1',run_id:failedRun.id,qa:{id:qa.id,version:1},answer:'失败前部分输出',citations:[],execution:{session_id:'failed-answer',started_at:'2026-09-28T00:00:00Z',finished_at:'2026-09-28T00:00:01Z',exit_code:1,status:'error',declared:{},observed:{}},capture:{coverage:'partial',limitations:['合成执行失败']},files:[{name:'tools.jsonl',size:failedBytes.length,digest:'sha256:'+createHash('sha256').update(failedBytes).digest('hex')}]}),'--files',failedEvidence);
  run('eval','run','stop',failedRun.id,'--reason','合成作答执行失败');
  const multiple = run('eval','experiment','create','--snapshot',snapshot,'--file',file('subject-multiple.json',{name:'G',description:'合成多尝试'})); experiments.push(multiple.id);
  let previous='';for (let i=0;i<2;i++) { const attempt=run('eval','run','start','--experiment',multiple.id,'--task',(suite.data.tasks as any[])[0].id,...(previous?['--rerun-of',previous]:[])); run('eval','run','stop',attempt.id,'--reason','合成多尝试 '+i);previous=attempt.id; }
  const missing = run('eval','experiment','create','--snapshot',snapshot,'--file',file('subject-missing.json',{name:'H',description:'合成缺评分'})); experiments.push(missing.id);
  const missingRun = run('eval','run','start','--experiment',missing.id,'--task',(suite.data.tasks as any[])[0].id);
  run('eval','artifact','submit','--file',file('missing-artifact.json',{format:'grounds.eval-artifact/v1',run_id:missingRun.id,qa:{id:qa.id,version:1},answer:'有答案但没有评分',citations:[],execution:{session_id:'missing-grading',started_at:'2026-09-28T00:00:00Z',finished_at:'2026-09-28T00:00:01Z',exit_code:0,status:'completed',declared:{},observed:{}},capture:{coverage:'partial',limitations:['合成缺评分']},files:[{name:'tools.jsonl',size:failedBytes.length,digest:'sha256:'+createHash('sha256').update(failedBytes).digest('hex')}]}),'--files',failedEvidence);
  run('eval','run','stop',missingRun.id,'--reason','合成缺评分');
  run('eval','grader','discourage',grader.id,'--version','1','--reason','新规则更完整');
  const before = run('ledger','list');
  const notices = await client.read('grader.notices',[grader.id,'--version','1']) as any[];
  assert.equal(notices[0].data.reason,'新规则更完整'); assert.ok(notices[0].created_at);
  const rs = await reports(client,experiments); assert.deepEqual(matrixRows(rs,{})[0].values,['pass','partial','fail','未开始','pass','作答执行失败','2 次 · 待选择','缺评分']);
  const outcome = (base: number, peer: number) => differenceRows(rs[base],rs[peer],{})[0];
  assert.equal(outcome(2,0).kind,'改善');assert.equal(outcome(0,1).kind,'退步');assert.equal(outcome(0,4).kind,'持平');
  for (const index of [3,5,6,7]) assert.equal(outcome(0,index).kind,'无法比较');
  assert.match(outcome(0,3).reason,/未执行/);assert.match(outcome(0,5).reason,/作答执行失败/);assert.match(outcome(0,6).reason,/多次尝试未选择 Run/);assert.match(outcome(0,7).reason,/缺评分/);
  assert.match(await readEvidence(client,'artifact',artifactId,'tools.jsonl'),/中文证据$/);
  checkedReport(await client.read('experiment.report',[experiments[0]]),experiments[0]);
  assert.deepEqual(run('ledger','list'),before);
  const revised = await publish({command:'qa.publish',id:qa.id,expectedVersion:1,body:{...qa.data,rubric:'只修改私有评分规则'}},qa); assert.equal(revised.version,2);
  const copied = await publish({command:'qa.publish',body:revised.data},revised);
  assert.notEqual(copied.id,qa.id); assert.notEqual((copied.data.source as any).identity,(qa.data.source as any).identity);
  assert.equal((await client.read('qa.show',[qa.id,'--version','1']) as any).data.question,'q'.repeat(40000));
  assert.deepEqual((await reports(client,experiments))[0].snapshot.data,rs[0].snapshot.data);
  suite = await publish({command:'suite.task.update',id:suite.id,expectedVersion:2,taskId:(suite.data.tasks as any[])[0].id,body:{kind:'qa',name:'重命名',qa:{id:qa.id,version:1},graders:[{id:grader.id,version:1}]}},suite);
  assert.equal(suite.version,3);
  suite = await publish({command:'suite.task.remove',id:suite.id,expectedVersion:3,taskId:(suite.data.tasks as any[])[0].id},suite); assert.equal((suite.data.tasks as any[]).length,0);
  suite = await publish({command:'suite.tasks.publish',id:suite.id,expectedVersion:4,body:{format:'grounds.eval-suite-members/v1',tasks:[{kind:'qa',name:'恢复题目 A',qa:{id:qa.id,version:1},graders:[{id:grader.id,version:1}]},{kind:'qa',name:'恢复题目 B',qa:{id:qa.id,version:1},graders:[{id:grader.id,version:1}]}]}},suite);
  assert.equal(suite.version,5);assert.equal((suite.data.tasks as any[]).length,2);
  assert.equal((await client.read('suite.show',[suite.id]) as any).version,5);
  if (process.env.GROUNDS_TUI_PTY === '1') {
   const editor = join(root,'editor.mjs'); writeFileSync(editor, "import {writeFileSync} from 'node:fs'; process.stdout.write('EDITOR_HANDOFF_OK'); writeFileSync(process.argv[2], 'PTY 修改题面');");
   const draft = await store.create(database,{command:'qa.publish',body:{...newQA(),name:'PTY题',question:'原题',instructions:'回答',rubric:'规则'}});
   const result = pty('scripts/eval-pty-smoke.py',[process.execPath,resolve('dist/bin.js'),'--eval','--cli',cli,'--config',config,'--cwd',root],{XDG_STATE_HOME:root, VISUAL:process.execPath+' '+editor, GROUNDS_TUI_EVAL_DRAFTS:store.root});
   assert.match(result,/EVAL PTY PASS/);
   for (const [index, [rows, columns]] of [[40,152],[24,80],[10,40]].entries()) {
    if (process.env.GROUNDS_TUI_RECOVERY_ONLY === '1') {
     const current = await client.read('suite.show',[suite.id]) as any;
     await publish({command:'suite.tasks.publish',id:suite.id,expectedVersion:current.version,body:{format:'grounds.eval-suite-members/v1',tasks:[...current.data.tasks,{kind:'qa',name:'预置成员 '+index,qa:{id:qa.id,version:1},graders:[{id:grader.id,version:1}]}]}},current);
    } else {
     const workbench = pty('scripts/eval-workbench-pty.py',['v2','正确性',String(5+index),String(2+index),String(rows),String(columns),process.execPath,resolve('dist/bin.js'),'--eval','--cli',cli,'--config',config,'--cwd',root],{XDG_STATE_HOME:root,GROUNDS_TUI_EVAL_DRAFTS:store.root});
     assert.match(workbench,new RegExp(`WORKBENCH PTY PASS: suite v${6+index} and regression evidence at ${columns}x${rows}`));
    }
    const fromCli = run('eval','suite','show',suite.id);
    assert.equal(fromCli.version,6+index);
    assert.equal(fromCli.data.tasks.length,3+index);
    assert.deepEqual(fromCli.data.tasks[2+index].qa,{id:qa.id,version:1});
    assert.deepEqual(fromCli.data.tasks[2+index].graders,[{id:grader.id,version:1}]);
   }
   const oldSuite = await client.read('suite.show',[suite.id,'--version','7']) as any;
   const latestSuite = await client.read('suite.show',[suite.id]) as any;
   const stale = await store.create(database,{command:'suite.tasks.publish',id:suite.id,expectedVersion:7,body:{format:'grounds.eval-suite-members/v1',tasks:[...latestSuite.data.tasks,{kind:'qa',name:'冲突后新增',qa:{id:qa.id,version:1},graders:[{id:grader.id,version:1}]}]}},oldSuite);
   await store.prepare(stale,identity);
   const recovery = pty('scripts/eval-recovery-pty.py',[process.execPath,resolve('dist/bin.js'),'--eval','--cli',cli,'--config',config,'--cwd',root],{XDG_STATE_HOME:root,GROUNDS_TUI_EVAL_DRAFTS:store.root});
   assert.match(recovery,/EVAL RECOVERY PTY PASS/);
   assert.equal((await store.load(stale.id)).state,'published');
   assert.equal(run('eval','suite','show',suite.id).version,9);
   assert.equal(run('eval','suite','show',suite.id).data.tasks.length,6);
   assert.equal((await reports(client,experiments))[0].snapshot.id,rs[0].snapshot.id);
  }
  // Regrading may change private QA material without changing the original answer.
  const grade2 = await publish({command:'grader.publish',body:{...grader.data,qa:{id:qa.id,version:2}}});
  let suite2 = await publish({command:'suite.create',name:'私有规则新版'});
  suite2 = await publish({command:'suite.task.add',id:suite2.id,expectedVersion:1,body:{kind:'qa',name:'重评',qa:{id:qa.id,version:2},graders:[{id:grade2.id,version:1}]}},suite2);
  const reExp = run('eval','experiment','create','--suite',suite2.id,'--file',file('regrade-subject.json',{name:'Regrade',description:'私有规则变化'}));
  const reRun = run('eval','run','start','--experiment',reExp.id,'--task',(suite2.data.tasks as any[])[0].id,'--artifact',artifactId);
  run('eval','run','stop',reRun.id,'--reason','验证合法重评读取');
  const reReport=checkedReport(await client.read('experiment.report',[reExp.id]),reExp.id);
  assert.equal(reReport.tasks[0].runs[0].artifact!.id,artifactId);
  assert.equal((reReport.tasks[0].runs[0].artifact!.data.qa as any).version,1);
  assert.equal(reReport.tasks[0].task.qa!.version,2);
  assert.match(attemptText(reReport.tasks[0],reReport.tasks[0].runs[0]),/原答案 QA：.*v1/);
 } finally {
  const totalMs = performance.now() - startedAt;
  console.log('EVAL_TIMING ' + JSON.stringify({ totalMs: Math.round(totalMs), cliCalls, cliMs: Math.round(cliMs), ptyMs: Object.fromEntries(Object.entries(ptyMs).map(([k, v]) => [k, Math.round(v)])) }));
  await client?.close(); rmSync(root,{recursive:true,force:true});
 }
});
