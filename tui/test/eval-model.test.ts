import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { evaluation } from './eval-fixtures.js';
import { checkedReport, parseEvalEnvelope, type EvalAccess } from '../src/eval-protocol.js';
import { matrixRows, differenceRows, selectedAttempt, attemptText, reports, readEvidence } from '../src/eval-model.js';
test('same-dimension changes separate improvement, regression, equality, missing and ambiguous attempts', () => {
 const base=evaluation('base','partial'),peer=evaluation('peer','pass');
 const verdict=(report:ReturnType<typeof evaluation>,value:string)=>{((report.tasks[0].runs[0].result!.data.graders as any[])[0].submission.outcome.verdict)=value;};
 assert.equal(differenceRows(base,peer,{})[0].kind,'改善');verdict(peer,'fail');assert.equal(differenceRows(base,peer,{})[0].kind,'退步');verdict(peer,'partial');assert.equal(differenceRows(base,peer,{})[0].kind,'持平');
 peer.tasks[0].runs[0].result!.data.graders=[];assert.equal(differenceRows(base,peer,{})[0].kind,'无法比较');assert.match(differenceRows(base,peer,{})[0].reason,/缺评分/);
 peer.tasks[0].runs[0].result!.data.graders=structuredClone(base.tasks[0].runs[0].result!.data.graders);
 const second=structuredClone(peer.tasks[0].runs[0]);second.run.id='another';peer.tasks[0].runs.push(second);
 assert.match(differenceRows(base,peer,{})[0].reason,/多次尝试未选择/);
 assert.equal(differenceRows(base,peer,{[`${peer.experiment.id}/task`]:'another'})[0].kind,'持平');
 assert.match(differenceRows(base,peer,{[`${peer.experiment.id}/task`]:'missing'})[0].reason,/失效/);
 peer.snapshot.id='different';assert.throws(()=>differenceRows(base,peer,{}),/Snapshot/);
});
test('score comparison honors the fixed direction and never compares different snapshots', () => {
 const base=evaluation('base'),peer=evaluation('peer');
 for(const [report,value] of [[base,2],[peer,3]] as const){
  report.tasks[0].graders[0].data.result_spec={kind:'score',min:0,max:5,higher_is_better:false,rubric:'固定分值'};
  (report.tasks[0].runs[0].result!.data.graders as any[])[0].submission.outcome={kind:'score',value};
 }
 assert.equal(differenceRows(base,peer,{})[0].kind,'退步');
 base.tasks[0].graders[0].data.result_spec.higher_is_better=true;
 peer.tasks[0].graders[0].data.result_spec.higher_is_better=true;
 assert.equal(differenceRows(base,peer,{})[0].kind,'改善');
 peer.snapshot.data.tasks=[{...peer.snapshot.data.tasks[0],name:'不同冻结题目'}];
 assert.throws(()=>differenceRows(base,peer,{}),/Snapshot/);
});
test('four groups retain raw verdicts, missing runs, explicit attempts and regrade metrics', async () => {
 const rs = ['A','B','C','D'].map((id, i) => checkedReport(evaluation(id, ['pass','partial','fail'][i]), id));
 rs[3].tasks[0].runs = [];
 assert.deepEqual(matrixRows(rs, {})[0].values, ['pass','partial','fail','未开始']);
 const t = rs[0].tasks[0], second = structuredClone(t.runs[0]); second.run.id = 'second'; t.runs.push(second);
 assert.equal(selectedAttempt(t), undefined); assert.match(matrixRows(rs, {})[0].values[0], /待选择/);
 assert.equal(selectedAttempt(t, 'second'), second);
 second.run.data.mode = 'qa_regrade'; const text = attemptText(t, second);
 assert.match(text, /不计作本次新作答/); assert.match(text, /未知/); assert.match(text, /评分依据/);
 t.runs.pop(); rs[1].snapshot.id = 'different'; rs[1].experiment.data.snapshot_id = 'different';
 await assert.rejects(reports({ read: async (_cmd, args) => rs.find(r => r.experiment.id === args![0]) } as EvalAccess, ['A','B']), /同一 Snapshot/);
});
test('malformed and cross-bound reports are rejected', () => {
 const r = evaluation('A'); r.tasks[0].runs[0].result!.data.run_id = 'other';
 assert.throws(() => checkedReport(r, 'A'), /归属/);
 const envelope = { format: 'patchledger.cli/v1', ok: true, warnings: [], data: { result_type: 'patchledger.result.eval/v1', command: 'eval.qa.list', payload: [] } };
 assert.deepEqual(parseEvalEnvelope(JSON.stringify(envelope), 0, 'qa.list'), []);
 assert.throws(() => parseEvalEnvelope(JSON.stringify(envelope), 0, 'suite.list'), /类型/);
 envelope.data.payload = [{}] as any; assert.throws(() => parseEvalEnvelope(JSON.stringify(envelope), 0, 'qa.list'), /字段/);
});
test('evidence paging verifies full digest and UTF-8 across page boundaries', async () => {
 const bytes = Buffer.from('a'.repeat(65535) + '中文证据'), digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
 const access = { read: async (_command: unknown, args: string[]) => {
  const offset = Number(args.at(-1)), end = Math.min(bytes.length, offset + 65536);
  return { kind: 'artifact', id: 'a', name: 'tools.jsonl', offset, next_offset: end === bytes.length ? null : end, size: bytes.length, digest, encoding: 'base64', content: bytes.subarray(offset, end).toString('base64') };
 } } as EvalAccess;
 assert.equal(await readEvidence(access, 'artifact', 'a', 'tools.jsonl'), bytes.toString());
 await assert.rejects(readEvidence(access, 'artifact', 'other', 'tools.jsonl'), /身份/);
});

test('execution failures, missing scores and open attempts never become synthetic verdicts', () => {
 const r = evaluation('A'), t = r.tasks[0], a = t.runs[0];
 a.artifact!.data.execution = { status:'error' }; assert.equal(matrixRows([r],{})[0].values[0], '作答执行失败');
 a.artifact!.data.execution = { status:'completed' }; a.result!.data.graders = []; assert.equal(matrixRows([r],{})[0].values[0], '缺评分');
 delete a.result; a.run.data.state = 'open'; assert.match(matrixRows([r],{})[0].values[0], /未结束/);
});

test('private-material QA regrades retain original artifact identity, normal answers remain strict', () => {
 const r = evaluation('A'), t = r.tasks[0], a = t.runs[0];
 t.task.qa!.version = 2; a.run.data.mode = 'qa_regrade';
 a.artifact!.data.qa = { id:'qa',version:1 }; a.artifact!.data.run_id = 'original-run';
 const checked = checkedReport(r,'A');
 const body = attemptText(checked.tasks[0],checked.tasks[0].runs[0]);
 assert.match(body,/Artifact：A-artifact/); assert.match(body,/原作答 Run：original-run/);
 assert.match(body,/原答案 QA：qa · v1/); assert.match(body,/本次评分任务 QA：qa · v2/);
 a.run.data.mode = 'answer'; assert.throws(() => checkedReport(r,'A'), /版本不匹配/);
 a.run.data.mode = 'qa_regrade'; a.artifact!.data.qa = { id:'different',version:1 };
 assert.throws(() => checkedReport(r,'A'),/版本不匹配/);
});

test('grading uses valid execution timestamps when metrics are absent, with unknown tokens', () => {
 const r = evaluation('A'), t = r.tasks[0], a = t.runs[0];
 (a.result!.data.graders as any[])[0].execution_id = 'execution';
 const evidence: any = { execution:{started_at:'2026-09-28T00:00:00Z',finished_at:'2026-09-28T00:00:02Z'}, capture:{coverage:'partial'} };
 a.executions = [{ id:'execution',kind:'execution',version:1,created_at:'now',attribution:{},data:{grading_evidence:evidence} }];
 let body = attemptText(t,a);
 assert.match(body,/评分耗时：2000 ms（记录的起止时间）/); assert.match(body,/评分 Token：未记录/);
 assert.match(body,/评分开始：2026-09-28T00:00:00Z/);
 evidence.metrics={duration_ms:0,usage:{input_tokens:5,output_tokens:1}};
 assert.match(attemptText(t,a),/评分耗时：0 ms（metrics）/);
 delete evidence.metrics; evidence.execution.finished_at='invalid';
 assert.match(attemptText(t,a),/评分耗时：未知/);
 evidence.execution.finished_at='2026-09-27T00:00:00Z';
 assert.match(attemptText(t,a),/评分耗时：未知/);
});

test('oversized evaluation collections are rejected by the protocol boundary', () => {
  const response = { format: 'patchledger.cli/v1', ok: true, warnings: [], data: {
    result_type: 'patchledger.result.eval/v1', command: 'eval.qa.list', payload: Array(100_001).fill(null)
  } };
  assert.throws(() => parseEvalEnvelope(JSON.stringify(response), 0, 'qa.list'), { code: 'PROTOCOL_ERROR' });
});
