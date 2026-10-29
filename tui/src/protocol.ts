import { z } from 'zod';

// Match the largest supported Change Index collection; reject before parsing elements.
export const boundedArray = <T extends z.ZodType>(element: T, minimum = 0) => z.unknown().superRefine((value, context) => {
  if (Array.isArray(value) && value.length > 100_000)
    context.addIssue({ code: 'too_big', origin: 'array', maximum: 100_000, inclusive: true });
}).pipe(z.array(element).min(minimum));

export type Data = Record<string, unknown>;
const object = z.looseObject({});
const id = z.string().min(1);
const version = z.looseObject({ id, version: z.number().int().positive() });
const resource = z.looseObject({ resource_id: id, label: z.string() });
const archiveBinding = z.looseObject({ repository_id: id, canonical_remote: id, archive_ref: id, source_commit: id, ordered_parents: boundedArray(id), result_tree: id, base_commit: id });
const archiveObservation = z.looseObject({ format: z.literal('grounds.git-archive-observation/v1'), status: z.enum(['confirmed', 'missing', 'conflict', 'unreadable', 'incomplete', 'unknown']), observed_at: id, binding: archiveBinding });
const gitArtifact = z.looseObject({ format: z.literal('grounds.git-commit-artifact/v1'), generator_version: z.literal('grounds.canonical-git-diff/v1'), binding: archiveBinding, receipt: archiveObservation });
const preflightBlockers = boundedArray(z.looseObject({ code: id, detail: z.string().optional() }));
const preflight = z.looseObject({
  state: z.enum(['missing', 'preparing', 'admitted']), code: id, summary: z.string().optional(),
  blocking: preflightBlockers.optional(), required_inputs: object.optional(),
  next_commands: boundedArray(z.string()), admission: object.optional(),
});
const devRunPreflight = preflight.extend({
  summary: z.string(), blocking: preflightBlockers,
  required_inputs: z.looseObject({ repository_id: id, issue_id: id, issue_version: z.number().int().positive(),
    target: z.looseObject({ remote: id, ref: z.string().startsWith('refs/heads/') }), base_commit: id, observed_commit: id.optional() }),
  admission: z.looseObject({ admitted_at: id, target_commit: id, base_commit: id }).optional(),
});
const candidate = z.looseObject({ candidate_id: id, issue: version, file_manifest: boundedArray(object), manifest_digest: id, git_artifact: gitArtifact.optional() });
const set = z.looseObject({ count: z.number().int().nonnegative(), digest: id, standing: id,
  verdict_counts: z.object({ qualified: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(), inconclusive: z.number().int().nonnegative() }), reports_included: z.literal(false) });
export const methods = {
  archiveStatus: { args: ['candidate', 'archive-status'], type: 'candidate-archive-status', resultType: 'grounds.result.candidate-archive-status/v1', command: 'candidate.archive-status', schema: z.looseObject({ candidate_id: id, artifact: gitArtifact.optional(), local_availability: archiveObservation.optional(), remote_observation: archiveObservation.optional(), remote_check: z.enum(['not_requested', 'observed']), archive_history: boundedArray(object) }) },
  selection: { args: ['selection', 'show'], type: 'selection', command: 'selection.show', schema: z.looseObject({ issue: version, selection: z.looseObject({ version: z.number().int().nonnegative(), state: z.enum(['selected', 'unselected']) }) }) },
  version: { args: ['--version'], type: 'version', command: 'version', schema: z.looseObject({ version: id }) },
  configPath: { args: ['config', 'path'], type: 'config-path', command: 'config.path', schema: z.looseObject({ config_path: id }) },
  configShow: { args: ['config', 'show'], type: 'config-show', command: 'config.show', schema: z.looseObject({ config: z.looseObject({ version: z.literal(2), database: z.looseObject({ driver: z.enum(['sqlite', 'mysql']), expected_database_id: id }) }) }) },
  dbTest: { args: ['db', 'test'], type: 'database', command: 'db.test', schema: z.looseObject({ database_id: id }) },
  requirements: { args: ['requirement', 'list'], type: 'resource-list', command: 'requirement.list', schema: z.looseObject({ resources: boundedArray(resource) }) },
  issues: { args: ['issue', 'list'], type: 'resource-list', command: 'issue.list', schema: z.looseObject({ resources: boundedArray(resource) }) },
  requirement: { args: ['requirement', 'show'], type: 'requirement-detail', command: 'requirement.show', schema: z.looseObject({ requirement: version, issues: boundedArray(z.looseObject({ issue: version })), aggregates: object }) },
  issue: { args: ['issue', 'show'], type: 'issue-detail', command: 'issue.show', schema: z.looseObject({ issue: version, requirement: version, board: z.looseObject({ preflight: preflight.optional() }) }) },
  devruns: { args: ['devrun', 'list'], type: 'resource-list', command: 'devrun.list', schema: z.looseObject({ resources: boundedArray(resource) }) },
  devrun: { args: ['devrun', 'show'], type: 'devrun-detail', command: 'devrun.show', schema: z.looseObject({ dev_run_id: id, issue: version, state: id, preflight: devRunPreflight.optional() }) },
  candidates: { args: ['candidate', 'list'], type: 'resource-list', command: 'candidate.list', schema: z.looseObject({ resources: boundedArray(resource) }) },
  candidate: { args: ['candidate', 'show'], type: 'candidate-detail', command: 'candidate.show', schema: z.looseObject({ candidate }) },
  compare: { args: ['candidate', 'compare'], type: 'candidate-comparison-summary', command: 'candidate.compare', schema: z.looseObject({ issue: version, baseline_oid: id, candidates: boundedArray(z.looseObject({ candidate_id: id, changed_files_count: z.number().int().nonnegative(), submission_explanation: z.looseObject({ preview: z.string(), truncated: z.boolean() }) }), 2) }) },
  review: { args: ['review'], type: 'review-summary', command: 'review', schema: z.looseObject({ trace: z.looseObject({ candidate: z.looseObject({ candidate_id: id }), artifact: z.looseObject({ result_tree_oid: id, git_artifact: gitArtifact.optional() }), contract: object, change_index: z.looseObject({ change_units: boundedArray(z.looseObject({ change_unit_id: id })) }), submission: object, verification_set: set }) }) },
  verifications: { args: ['verification', 'list'], type: 'verification-page', command: 'verification.list', schema: z.looseObject({ candidate_id: id, verification_set: set, verifications: boundedArray(z.looseObject({ verification_id: id, candidate_id: id, overall_verdict: id, created_at: id, attribution: object })) }) },
  verification: { args: ['verification', 'show'], type: 'verification-detail', command: 'verification.show', schema: z.looseObject({ verification_id: id, candidate_id: id, overall_verdict: id, created_at: id, attribution: object, report: z.looseObject({ candidate_id: id, result_tree_oid: id }) }) },
} as const;
export type Method = keyof typeof methods;
export class ClientError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}
export function decode(text: string, exit: number | null, method: Method | 'help' | 'selectionSet'): Data {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ClientError('PROTOCOL_ERROR', 'CLI 没有返回有效的 JSON'); }
  const envelope = z.looseObject({ format: z.literal('patchledger.cli/v1'), ok: z.boolean(), data: object.optional(),
    error: z.looseObject({ code: id, message: z.string(), retryable: z.boolean() }).optional(),
    warnings: boundedArray(z.looseObject({ code: id, message: z.string() })).optional() }).safeParse(raw);
  if (!envelope.success) throw new ClientError('PROTOCOL_ERROR', 'CLI envelope 不兼容');
  const e = envelope.data;
  if (!e.ok) {
    if (!e.error || exit === 0) throw new ClientError('PROTOCOL_ERROR', 'CLI 错误与退出码不一致');
    throw new ClientError(e.error.code, e.error.message, e.error.retryable);
  }
  if (exit !== 0 || !e.data || !e.warnings) throw new ClientError('PROTOCOL_ERROR', 'CLI 成功结果与退出码不一致');
  const descriptor = method === 'help' ? { type: 'help', command: 'help', schema: z.looseObject({ usage: z.string() }) } : method === 'selectionSet' ? { ...methods.selection, command: 'selection.set' } : methods[method];
  const expectedType = 'resultType' in descriptor ? descriptor.resultType : `patchledger.result.${descriptor.type}/v1`;
  if (e.data.result_type !== expectedType || e.data.command !== descriptor.command)
    throw new ClientError('PROTOCOL_ERROR', `CLI ${descriptor.command} 结果类型不兼容`);
  const data = descriptor.schema.safeParse(e.data);
  if (!data.success) throw new ClientError('PROTOCOL_ERROR', `CLI ${descriptor.command} 缺少必要字段`);
  return { ...data.data, warnings: e.warnings };
}
