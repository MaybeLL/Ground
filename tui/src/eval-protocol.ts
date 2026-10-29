import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { boundedArray, ClientError, type Data } from './protocol.js';

export interface EvalRecord { id: string; kind: string; version: number; created_at: string; data: Data; attribution: Data }
export interface EvalTask { id: string; name: string; qa?: Ref; issue?: Ref; graders: Ref[] }
export interface Ref { id: string; version: number }
export interface Attempt { run: EvalRecord; artifact?: EvalRecord; result?: EvalRecord; executions?: EvalRecord[] }
export interface ReportTask { task: EvalTask; graders: EvalRecord[]; runs: Attempt[] }
export interface EvalReport { format: string; experiment: EvalRecord; snapshot: EvalRecord; tasks: ReportTask[]; notices: EvalRecord[]; environment?: Data }
export const readCommands = ['qa.list', 'qa.show', 'grader.list', 'grader.show', 'grader.notices', 'suite.list', 'suite.show', 'snapshot.show', 'experiment.list', 'experiment.show', 'experiment.report', 'artifact.show', 'artifact.file', 'grader.evidence-file'] as const;
export type EvalRead = typeof readCommands[number];
export type EvalWrite = 'qa.publish' | 'grader.publish' | 'suite.create' | 'suite.task.add' | 'suite.task.update' | 'suite.task.remove' | 'suite.tasks.publish';
export interface HumanIdentity { kind: 'human'; git_name: string; git_email: string }
export interface Publication { command: EvalWrite; id?: string; expectedVersion?: number; taskId?: string; body?: Data; name?: string }
export interface FrozenPublication extends Publication { operationId: string; databaseId: string; attribution: HumanIdentity }
export interface EvalAccess {
  qaDraft?(command: string, args?: string[], body?: Data): Promise<unknown>;
  read(command: EvalRead, args?: string[], signal?: AbortSignal): Promise<unknown>;
  publish(request: FrozenPublication): Promise<EvalRecord>;
  identity(): Promise<HumanIdentity>;
  database(): Promise<string>;
}
const id = z.string().min(1), obj = z.record(z.string(), z.unknown());
const ref = z.object({ id, version: z.number().int().positive() });
const rec = z.looseObject({ id, kind: id, version: z.number().int().positive(), created_at: id, attribution: obj, data: obj });
const task = z.looseObject({ id, name: z.string(), qa: ref.optional(), issue: ref.optional(), graders: boundedArray(ref) }).refine(v => Boolean(v.qa) !== Boolean(v.issue));
const attempt = z.looseObject({ run: rec, artifact: rec.optional(), result: rec.optional(), executions: boundedArray(rec).optional() });
const report = z.looseObject({ format: z.literal('patchledger.eval-report/v1'), experiment: rec, snapshot: rec, tasks: boundedArray(z.looseObject({ task, graders: boundedArray(rec), runs: boundedArray(attempt) })), notices: boundedArray(rec), environment: obj.optional() });
const file = z.object({ kind: z.enum(['artifact', 'execution']), id, name: id, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), size: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), next_offset: z.number().int().nonnegative().nullable(), encoding: z.literal('base64'), content: z.string().max(87384) });
export function parseEvalEnvelope(raw: string, exit: number | null, command: EvalRead | EvalWrite): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ClientError('PROTOCOL_ERROR', '评测接口未返回有效 JSON'); }
  const e = z.looseObject({ format: z.literal('patchledger.cli/v1'), ok: z.boolean(), data: obj.optional(), warnings: boundedArray(obj).optional(), error: z.looseObject({ code: id, message: z.string(), retryable: z.boolean(), details: obj.optional() }).optional() }).safeParse(parsed);
  if (!e.success) throw new ClientError('PROTOCOL_ERROR', '评测 envelope 不兼容');
  const v = e.data;
  if (!v.ok) {
    if (!v.error || exit === 0) throw new ClientError('PROTOCOL_ERROR', '错误与退出码不一致');
    throw new ClientError(v.error.code, `${v.error.message}${v.error.details ? ' · ' + JSON.stringify(v.error.details) : ''}`, v.error.retryable);
  }
  if (exit !== 0 || !v.warnings || v.data?.result_type !== 'patchledger.result.eval/v1' || v.data.command !== `eval.${command}`) throw new ClientError('PROTOCOL_ERROR', '评测结果类型不兼容');
  const schema = command === 'experiment.report' ? report : command.endsWith('.file') || command === 'grader.evidence-file' ? file : command.endsWith('.list') || command === 'grader.notices' ? boundedArray(rec) : rec;
  const result = schema.safeParse(v.data.payload);
  if (!result.success) throw new ClientError('PROTOCOL_ERROR', '评测结果缺少必要字段');
  return result.data;
}
export function fixedRecord(value: unknown, kind: string, idValue?: string, version?: number): EvalRecord {
  const r = rec.parse(value) as EvalRecord;
  if (r.kind !== kind || idValue && r.id !== idValue || version !== undefined && r.version !== version) throw new ClientError('PROTOCOL_ERROR', '评测对象身份或版本不匹配');
  return r;
}
export function checkedReport(value: unknown, experimentId: string): EvalReport {
  const r = report.parse(value) as EvalReport;
  fixedRecord(r.experiment, 'experiment', experimentId);
  fixedRecord(r.snapshot, 'snapshot', String(r.experiment.data.snapshot_id));
  const planned = r.snapshot.data.tasks as EvalTask[];
  if (!Array.isArray(planned) || planned.length !== r.tasks.length || new Set(r.tasks.map(t => t.task.id)).size !== r.tasks.length) throw new ClientError('PROTOCOL_ERROR', '报告题集不完整');
  for (const t of r.tasks) {
    const origin = planned.find(p => p.id === t.task.id);
    if (!origin || !isDeepStrictEqual(origin, t.task)) throw new ClientError('PROTOCOL_ERROR', '报告与冻结题集不匹配');
    if (t.graders.length !== t.task.graders.length || new Set(t.graders.map(g => g.id)).size !== t.graders.length) throw new ClientError('PROTOCOL_ERROR', '评分规则集合不完整');
    for (const g of t.graders) { const bound = t.task.graders.find(v => v.id === g.id); fixedRecord(g, 'grader', bound?.id, bound?.version); if (!bound) throw new ClientError('PROTOCOL_ERROR', '额外评分规则'); }
    if (new Set(t.runs.map(a => a.run.id)).size !== t.runs.length) throw new ClientError('PROTOCOL_ERROR', '重复尝试');
    for (const a of t.runs) {
      fixedRecord(a.run, 'run');
      if (a.run.data.experiment_id !== experimentId || !isDeepStrictEqual(a.run.data.task, t.task)) throw new ClientError('PROTOCOL_ERROR', '运行归属不匹配');
      if (a.result) {
        fixedRecord(a.result, 'result', String(a.run.data.result_id));
        if (a.result.data.run_id !== a.run.id || a.result.data.experiment_id !== experimentId || !isDeepStrictEqual(a.result.data.task, t.task)) throw new ClientError('PROTOCOL_ERROR', '结果归属不匹配');
      }
      if (a.artifact) {
        fixedRecord(a.artifact, 'artifact', String(a.run.data.artifact_id));
        const answerQA = ref.parse(a.artifact.data.qa);
        // The core permits a frozen answer to be regraded after private-material
        // revisions, while enforcing unchanged public question/instructions.
        const compatible = t.task.qa && answerQA.id === t.task.qa.id
          && (a.run.data.mode === 'qa_regrade' || answerQA.version === t.task.qa.version);
        if (!compatible) throw new ClientError('PROTOCOL_ERROR', '答案题目版本不匹配');
        if (a.run.data.mode !== 'qa_regrade' && a.artifact.data.run_id !== a.run.id) throw new ClientError('PROTOCOL_ERROR', '原作答运行不匹配');
      }
      for (const execution of a.executions ?? []) {
        fixedRecord(execution, 'execution');
        if (execution.data.run_id !== a.run.id || !t.task.graders.some(g => isDeepStrictEqual(g, execution.data.grader))) throw new ClientError('PROTOCOL_ERROR', '评分执行归属不匹配');
      }
    }
  }
  return r;
}
