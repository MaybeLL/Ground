import type { Data } from '../src/protocol.js';
import type { EvalRecord, EvalReport } from '../src/eval-protocol.js';
export const rec = (kind: string, id: string, data: Data, version = 1): EvalRecord => ({ kind, id, version, data, created_at: '2026-09-28T00:00:00Z', attribution: { kind: 'human' } });
export function evaluation(id: string, verdict = 'pass'): EvalReport {
 const task = { id: 'task', name: '恢复题目', qa: { id: 'qa', version: 1 }, graders: [{ id: 'grader', version: 1 }] };
 const grader = rec('grader', 'grader', { name: '正确性', qa: task.qa, scope: { kind: 'diagnostic', name: '正确性' }, result_spec: { kind: 'qa_decision' }, definition: { type: 'agent', instructions: '规则' } });
 return { format: 'patchledger.eval-report/v1', experiment: rec('experiment', id, { snapshot_id: 'snapshot', subject: { name: id } }), snapshot: rec('snapshot', 'snapshot', { suite: { id: 'suite', version: 2 }, tasks: [task] }), notices: [], tasks: [{ task, graders: [grader], runs: [{ run: rec('run', id + '-run', { experiment_id: id, task, mode: 'qa', state: 'closed', result_id: id + '-result', artifact_id: id + '-artifact' }), artifact: rec('artifact', id + '-artifact', { run_id: id + '-run', qa: task.qa, answer: '冻结答案', citations: [], execution: { status: 'completed' }, capture: { coverage: 'partial' } }), result: rec('result', id + '-result', { run_id: id + '-run', experiment_id: id, task, graders: [{ grader: task.graders[0], submission: { status: 'completed', outcome: { kind: 'qa_decision', verdict }, explanation: '评分依据' } }] }) }] }] };
}
