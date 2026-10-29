import { decodeEnvironment, decodeEnvironmentCheck, decodePreparation, decodeInstance, decodeExperimentEnvironment, type EnvironmentDefinition, type EnvironmentCheck, type Preparation, type EnvironmentInstance, type ExperimentEnvironment } from './eval-environment.js';
import { decodeQA, decodeQAArtifact, decodeQAGradingEvidence, type QAGradingEvidence, type QADraft, type QAArtifact } from './eval-qa.js';
import { safeYAMLToJS } from './yaml-safe.js';
import { validation } from './errors.js';
import { isUUIDv7, isSha256, isGitOID } from './identity.js';
import { validateAttribution, type Attribution } from './domain.js';

/**
 * JSON syntax plus the existing duplicate-key, UTF-8 and null safeguards.
 *
 * `allowNulls` is off by default: the input model treats an explicit null as
 * illegal and expresses optional fields by omission.  Only the QA artifact and
 * grading-evidence inputs opt in, because their contract declares nullable
 * fields (`eval.schema.json`: `environmentMetrics.usage` may be null) and an
 * evidence document already recorded with a null must still re-read.
 */
export const decodeEvalJSON = (bytes: Buffer, options: { allowNulls?: boolean } = {}): unknown => {
  if (bytes.length > 2 * 1024 * 1024) throw validation('file', 'maximum is 2 MiB');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw validation('file', 'must be valid UTF-8 JSON'); }
  safeYAMLToJS(bytes, 'file', options);
  return value;
};

export type EvalKind = 'environment' | 'envcheck' | 'preparation' | 'instance' | 'qa' | 'artifact' | 'grader' | 'suite' | 'snapshot' | 'experiment' | 'run' | 'execution' | 'result' | 'notice';
export interface Ref { id: string; version: number }
export type ResultSpec = { kind: 'qa_decision' } | { kind: 'decision' } | { kind: 'score'; min: number; max: number; higher_is_better: boolean; rubric: string };
interface GraderBase {
  name: string;
  scope: { kind: 'criterion'; criterion_ids: string[] } | { kind: 'diagnostic'; name: string };
  result_spec: ResultSpec;
  definition: { type: 'agent'; instructions: string } | {
    type: 'unit_test'; adapter: 'go'; package: string; test_name: string; timeout_seconds: number;
    files: { path: string; content: string }[];
  };
  limitations: string;
}
export type GraderDraft = GraderBase & ({ format: 'patchledger.eval-grader/v1'; issue: Ref; qa?: never } | { format: 'grounds.eval-grader/v1'; qa: Ref; issue?: never });
export type TaskDraft = { name: string; graders: Ref[] } & ({ issue: Ref; qa?: never; kind?: never } | { kind: 'qa'; qa: Ref; issue?: never });
export type EvalTask = TaskDraft & { id: string };
export interface Subject { name: string; description: string }
export type Outcome = { kind: 'qa_decision'; verdict: 'pass' | 'partial' | 'fail' } | { kind: 'decision'; verdict: 'pass' | 'fail' } | { kind: 'score'; value: number } | { kind: 'inconclusive'; reason: string };
export interface EvalEvidence { kind: 'command' | 'observation' | 'test_source'; content: string }
interface GraderSubmissionBase {
  format: 'patchledger.eval-grader-submission/v1' | 'grounds.eval-grader-submission/v1';
  execution_id: string;
  context_digest: string;
  explanation: string;
  evidence: EvalEvidence[];
}
export type GraderSubmission = GraderSubmissionBase & (
  | { status: 'completed'; outcome: Outcome }
  | { status: 'error' | 'not_executed'; outcome?: never }
);
export type EvalRunData = { experiment_id: string; task: EvalTask; rerun_of?: string; artifact_id?: string } & (
  | { mode: 'answer'; dev_run_id?: never; candidate_id?: never }
  | { mode: 'qa_regrade'; dev_run_id?: never; candidate_id?: never }
  | { mode: 'develop'; dev_run_id: string; candidate_id?: string }
  | { mode: 'regrade'; candidate_id: string; dev_run_id?: never }
) & (
  | { state: 'open'; result_id?: never }
  | { state: 'closed'; result_id: string }
);
export type Duration = { kind: 'measured' | 'referenced'; started_at: string; finished_at: string; duration_ms: number; source_dev_run_id: string } | { kind: 'unknown'; reason: string };
export interface EvalData {
  environment: EnvironmentDefinition;
  envcheck: EnvironmentCheck;
  preparation: Preparation;
  instance: EnvironmentInstance;
  qa: QADraft;
  artifact: QAArtifact;
  notice: { grader: Ref; reason: string };
  grader: GraderDraft;
  suite: { name: string; tasks: EvalTask[] };
  snapshot: { suite: Ref; name: string; tasks: EvalTask[] };
  experiment: { snapshot_id: string; subject: Subject; environment?: ExperimentEnvironment };
  run: EvalRunData;
  execution: { run_id: string; grader: Ref; candidate_id?: string; result_tree_oid?: string; artifact_id?: string; context_digest: string; unit_execution_started?: boolean; grading_evidence?: QAGradingEvidence; submission?: GraderSubmission };
  result: { run_id: string; experiment_id: string; task: EvalTask; mode: 'develop' | 'regrade' | 'answer' | 'qa_regrade'; candidate_id?: string; artifact_id?: string; answering_duration_ms?: number; development_duration: Duration; reason?: string; graders: { grader: Ref; execution_id?: string; submission?: GraderSubmission; missing_reason?: string }[] };
}
export interface EvalRecord<K extends EvalKind = EvalKind> {
  id: string; kind: K; version: number; parent_id?: string; created_at: string; attribution: Attribution; data: EvalData[K];
}

export const object = (v: unknown, required: string[], optional: string[] = [], field = 'input'): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw validation(field, 'must be an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (![...required, ...optional].includes(k)) throw validation(`${field}.${k}`, 'unknown field');
  for (const k of required) if (!(k in o)) throw validation(`${field}.${k}`, 'is required');
  return o;
};
export const textValue = (v: unknown, field = 'text', max = 65536): string => {
  if (typeof v !== 'string' || !v.trim() || Buffer.byteLength(v) > max || Buffer.from(v).toString('utf8') !== v) throw validation(field, `must be nonempty text of at most ${max} UTF-8 bytes`);
  return v;
};
export const idValue = (v: unknown): string => { if (typeof v !== 'string' || !isUUIDv7(v)) throw validation('id', 'must be a lowercase UUIDv7'); return v; };
export const versionValue = (v: unknown, min = 1): number => { if (!Number.isSafeInteger(v) || (v as number) < min) throw validation('version', `must be an integer >= ${min}`); return v as number; };
const array = (v: unknown, field: string, min = 1, max = 100): unknown[] => { if (!Array.isArray(v) || v.length < min || v.length > max) throw validation(field, `must contain ${min}..${max} items`); return v; };
const literal = (v: unknown, expected: string): void => { if (v !== expected) throw validation('format', `expected ${expected}`); };
export const refValue = (v: unknown): Ref => { const o = object(v, ['id', 'version']); return { id: idValue(o.id), version: versionValue(o.version) }; };
export const decodeSubject = (v: unknown): Subject => { const o = object(v, ['name', 'description']); return { name: textValue(o.name, 'name', 1024), description: textValue(o.description) }; };
export const decodeTask = (v: unknown): TaskDraft => {
  const qa = (v as Record<string, unknown>)?.kind === 'qa';
  const o = object(v, qa ? ['kind', 'name', 'qa', 'graders'] : ['name', 'issue', 'graders']); const graders = array(o.graders, 'graders').map(refValue);
  if (new Set(graders.map(g => g.id)).size !== graders.length) throw validation('graders', 'each Grader may appear only once');
  return qa ? { kind: 'qa', name: textValue(o.name, 'name', 1024), qa: refValue(o.qa), graders } : { name: textValue(o.name, 'name', 1024), issue: refValue(o.issue), graders };
};
export const decodeGrader = (v: unknown): GraderDraft => {
  const qa = (v as Record<string, unknown>)?.format === 'grounds.eval-grader/v1';
  const o = object(v, ['format', qa ? 'qa' : 'issue', 'name', 'scope', 'result_spec', 'definition', 'limitations']); literal(o.format, qa ? 'grounds.eval-grader/v1' : 'patchledger.eval-grader/v1');
  const s = o.result_spec as Record<string, unknown>; let result_spec: ResultSpec;
  if (qa && s?.kind === 'qa_decision') { object(s, ['kind']); result_spec = { kind: 'qa_decision' }; }
  else if (s?.kind === 'decision') { object(s, ['kind']); result_spec = { kind: 'decision' }; }
  else {
    object(s, ['kind', 'min', 'max', 'higher_is_better', 'rubric']);
    if (s.kind !== 'score' || typeof s.min !== 'number' || typeof s.max !== 'number' || !Number.isFinite(s.min) || !Number.isFinite(s.max) || s.min >= s.max || typeof s.higher_is_better !== 'boolean') throw validation('result_spec', 'invalid score scale');
    result_spec = { kind: 'score', min: s.min, max: s.max, higher_is_better: s.higher_is_better, rubric: textValue(s.rubric) };
  }
  const d = o.definition as Record<string, unknown>; let definition: GraderDraft['definition'];
  if (d?.type === 'agent') { object(d, ['type', 'instructions']); definition = { type: 'agent', instructions: textValue(d.instructions) }; }
  else {
    object(d, ['type', 'adapter', 'package', 'test_name', 'timeout_seconds', 'files']);
    if (d.type !== 'unit_test' || d.adapter !== 'go') throw validation('definition', 'supported types: agent, unit_test (Go)');
    const pkg = textValue(d.package); const name = textValue(d.test_name);
    if (!/^(\.|[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/.test(pkg) || !/^Test[A-Z0-9_][A-Za-z0-9_]*$/.test(name)) throw validation('definition', 'requires a relative package and an exact Go Test name');
    const timeout = versionValue(d.timeout_seconds); if (timeout > 300) throw validation('timeout_seconds', 'maximum is 300');
    const files = array(d.files, 'files', 1, 20).map(v => {
      const f = object(v, ['path', 'content']); const path = textValue(f.path);
      if (!/^[A-Za-z0-9_-]+_test\.go$/.test(path)) throw validation('files.path', 'must be a plain *_test.go filename inside the selected package');
      return { path, content: textValue(f.content) };
    });
    if (new Set(files.map(f => f.path)).size !== files.length) throw validation('files', 'duplicate filenames');
    if (result_spec.kind !== 'decision') throw validation('result_spec', 'Go unit tests produce decisions');
    definition = { type: 'unit_test', adapter: 'go', package: pkg, test_name: name, timeout_seconds: timeout, files };
  }
  const scopeInput = o.scope as Record<string, unknown>; let scope: GraderDraft['scope'];
  if (scopeInput?.kind === 'criterion') {
    object(scopeInput, ['kind', 'criterion_ids']);
    const ids = array(scopeInput.criterion_ids, 'criterion_ids').map(idValue);
    if (new Set(ids).size !== ids.length) throw validation('scope', 'duplicate Criterion IDs');
    scope = { kind: 'criterion', criterion_ids: ids };
  } else {
    object(scopeInput, ['kind', 'name']);
    if (scopeInput.kind !== 'diagnostic') throw validation('scope.kind', 'expected criterion or diagnostic');
    scope = { kind: 'diagnostic', name: textValue(scopeInput.name) };
  }
  if (qa && (definition.type !== 'agent' || scope.kind !== 'diagnostic' || result_spec.kind !== 'qa_decision')) throw validation('grader', 'QA requires agent diagnostic grading with qa_decision');
  return { ...(qa ? { format: 'grounds.eval-grader/v1' as const, qa: refValue(o.qa) } : { format: 'patchledger.eval-grader/v1' as const, issue: refValue(o.issue) }), name: textValue(o.name, 'name', 1024), scope, result_spec, definition, limitations: textValue(o.limitations) };
};
export const decodeSubmission = (v: unknown): GraderSubmission => {
  const o = object(v, ['format', 'execution_id', 'context_digest', 'status', 'explanation', 'evidence'], ['outcome']); if (!['patchledger.eval-grader-submission/v1', 'grounds.eval-grader-submission/v1'].includes(String(o.format))) throw validation('format', 'invalid submission format');
  if (!['completed', 'error', 'not_executed'].includes(String(o.status))) throw validation('status', 'invalid execution status');
  if (typeof o.context_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(o.context_digest)) throw validation('context_digest', 'invalid digest');
  let outcome: Outcome | undefined;
  if (o.status === 'completed') {
    const r = o.outcome as Record<string, unknown>;
    if (r?.kind === 'qa_decision' && o.format === 'grounds.eval-grader-submission/v1') { object(r, ['kind', 'verdict']); if (!['pass', 'partial', 'fail'].includes(String(r.verdict))) throw validation('verdict', 'invalid QA verdict'); outcome = { kind: 'qa_decision', verdict: r.verdict as 'pass' | 'partial' | 'fail' }; }
    else if (r?.kind === 'decision') { object(r, ['kind', 'verdict']); if (r.verdict !== 'pass' && r.verdict !== 'fail') throw validation('verdict', 'expected pass or fail'); outcome = { kind: 'decision', verdict: r.verdict }; }
    else if (r?.kind === 'score') { object(r, ['kind', 'value']); if (typeof r.value !== 'number' || !Number.isFinite(r.value)) throw validation('value', 'must be finite'); outcome = { kind: 'score', value: r.value }; }
    else { object(r, ['kind', 'reason']); if (r.kind !== 'inconclusive') throw validation('outcome', 'invalid outcome'); outcome = { kind: 'inconclusive', reason: textValue(r.reason) }; }
  } else if ('outcome' in o) throw validation('outcome', 'errors cannot carry a verdict or score');
  const evidence = array(o.evidence, 'evidence', 0).map(v => { const e = object(v, ['kind', 'content']); if (!['command', 'observation', 'test_source'].includes(String(e.kind))) throw validation('evidence.kind', 'unknown evidence kind'); return { kind: e.kind as EvalEvidence['kind'], content: textValue(e.content) }; });
  if (outcome && outcome.kind !== 'inconclusive' && evidence.length === 0) throw validation('evidence', 'a judgment requires supporting evidence');
  const base: GraderSubmissionBase = { format: o.format as GraderSubmissionBase['format'], execution_id: idValue(o.execution_id), context_digest: o.context_digest, explanation: textValue(o.explanation), evidence };
  return outcome ? { ...base, status: 'completed', outcome } : { ...base, status: o.status as 'error' | 'not_executed' };
};

export const timestampValue = (value: unknown): number => {
  const match = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.[0-9]{1,9})?Z$/.exec(value) : null;
  if (!match) throw validation('timestamp', 'must be a UTC RFC3339Nano timestamp');
  const parsed = Date.parse(value as string);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== match[1]) throw validation('timestamp', 'invalid calendar date');
  return parsed;
};
const validateTask = (value: unknown): EvalTask => {
  const task = object(value, (value as Record<string, unknown>)?.kind === 'qa' ? ['id', 'kind', 'name', 'qa', 'graders'] : ['id', 'name', 'issue', 'graders']);
  const { id, ...draft } = task; return { id: idValue(id), ...decodeTask(draft) };
};
const validateTasks = (value: unknown, minimum: number): void => {
  const tasks = array(value, 'tasks', minimum, 1000).map(validateTask);
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) throw validation('tasks', 'duplicate task IDs');
};
const validateDuration = (value: unknown): void => {
  const duration = value as Record<string, unknown>;
  if (duration?.kind === 'unknown') {
    object(duration, ['kind', 'reason']); textValue(duration.reason); return;
  }
  object(duration, ['kind', 'started_at', 'finished_at', 'duration_ms', 'source_dev_run_id']);
  if (duration.kind !== 'measured' && duration.kind !== 'referenced') throw validation('duration.kind', 'invalid duration kind');
  idValue(duration.source_dev_run_id);
  const start = timestampValue(duration.started_at); const end = timestampValue(duration.finished_at);
  if (versionValue(duration.duration_ms, 0) !== end - start) throw validation('duration_ms', 'must match nonnegative recorded development time');
};

/** Validate persisted data before trusting its TypeScript shape, even with a valid digest. */
export const validateEvalRecord = (value: unknown): void => {
  const record = object(value, ['id', 'kind', 'version', 'created_at', 'attribution', 'data'], ['parent_id']);
  idValue(record.id); versionValue(record.version); timestampValue(record.created_at);
  validateAttribution(record.attribution as Attribution);
  if (record.parent_id !== undefined) idValue(record.parent_id);
  const parent = (expected: unknown): void => {
    if (record.parent_id !== expected) throw validation('parent_id', 'does not match the record binding');
  };
  switch (record.kind) {
    case 'environment': decodeEnvironment(record.data); parent(undefined); break;
    case 'envcheck': { const d=decodeEnvironmentCheck(record.data); parent(d.environment.id); if(record.version!==1) throw validation('envcheck','immutable validation'); break; }
    case 'preparation': decodePreparation(record.data); parent(undefined); break;
    case 'instance': { const d=decodeInstance(record.data); parent(d.run_id); break; }
    case 'qa': decodeQA(record.data); parent(undefined); break;
    case 'artifact': { const a = decodeQAArtifact(record.data); parent(a.run_id); if (record.version !== 1) throw validation('artifact', 'immutable'); break; }
    case 'grader': {
      const grader = decodeGrader(record.data); parent((grader.qa ?? grader.issue).id); break;
    }
    case 'suite': {
      const data = object(record.data, ['name', 'tasks']); textValue(data.name, 'name', 1024);
      validateTasks(data.tasks, 0); parent(undefined); break;
    }
    case 'snapshot': {
      const data = object(record.data, ['suite', 'name', 'tasks']); textValue(data.name, 'name', 1024);
      parent(refValue(data.suite).id); validateTasks(data.tasks, 1); break;
    }
    case 'experiment': {
      const data = object(record.data, ['snapshot_id', 'subject'], ['environment']); parent(idValue(data.snapshot_id));
      decodeSubject(data.subject); if(data.environment) decodeExperimentEnvironment(data.environment); break;
    }
    case 'run': {
      const data = object(record.data, ['experiment_id', 'task', 'mode', 'state'], ['dev_run_id', 'candidate_id', 'artifact_id', 'rerun_of', 'result_id']);
      parent(idValue(data.experiment_id)); validateTask(data.task);
      for (const field of ['dev_run_id', 'candidate_id', 'artifact_id', 'rerun_of', 'result_id']) if (field in data) idValue(data[field]);
      if (data.mode === 'answer' || data.mode === 'qa_regrade') {
        if (validateTask(data.task).kind !== 'qa' || 'candidate_id' in data || 'dev_run_id' in data) throw validation('mode', 'QA cannot own code development');
        if (data.mode === 'qa_regrade') idValue(data.artifact_id);
      } else if (validateTask(data.task).kind === 'qa' || 'artifact_id' in data) throw validation('mode', 'invalid Coding binding');
      else if (data.mode === 'develop') idValue(data.dev_run_id);
      else if (data.mode === 'regrade') {
        idValue(data.candidate_id);
        if ('dev_run_id' in data) throw validation('dev_run_id', 'regrading cannot create development ownership');
      } else throw validation('mode', 'invalid execution mode');
      if (data.state === 'closed') idValue(data.result_id);
      else if (data.state !== 'open' || 'result_id' in data) throw validation('state', 'open runs cannot own a final result');
      break;
    }
    case 'execution': {
      const data = object(record.data, ['run_id', 'grader', 'context_digest'], ['candidate_id', 'result_tree_oid', 'artifact_id', 'unit_execution_started', 'submission', 'grading_evidence']);
      parent(idValue(data.run_id)); refValue(data.grader);
      if (data.artifact_id) { idValue(data.artifact_id); if ('candidate_id' in data || 'result_tree_oid' in data || 'unit_execution_started' in data) throw validation('execution', 'QA cannot own code execution'); }
      else { idValue(data.candidate_id); if (!isGitOID(data.result_tree_oid)) throw validation('execution', 'invalid tree'); }
      if (!isSha256(data.context_digest)) throw validation('execution', 'invalid artifact binding');
      if ('unit_execution_started' in data && data.unit_execution_started !== true) throw validation('unit_execution_started', 'only a recorded start may set this field');
      if ('grading_evidence' in data) {
        const evidence = decodeQAGradingEvidence(data.grading_evidence);
        if (!data.artifact_id || evidence.execution_id !== record.id || evidence.context_digest !== data.context_digest) throw validation('grading_evidence', 'must match QA execution');
      }
      if ('submission' in data) {
        const submission = decodeSubmission(data.submission);
        if (submission.execution_id !== record.id || submission.context_digest !== data.context_digest) throw validation('submission', 'does not match the execution');
      }
      break;
    }
    case 'result': {
      const data = object(record.data, ['run_id', 'experiment_id', 'task', 'mode', 'development_duration', 'graders'], ['candidate_id', 'artifact_id', 'answering_duration_ms', 'reason']);
      parent(idValue(data.run_id)); idValue(data.experiment_id); const task = validateTask(data.task);
      if (!['develop', 'regrade', 'answer', 'qa_regrade'].includes(String(data.mode))) throw validation('mode', 'invalid execution mode');
      if (task.kind === 'qa') {
        if (!['answer', 'qa_regrade'].includes(String(data.mode)) || 'candidate_id' in data) throw validation('result', 'invalid QA result');
        if ('artifact_id' in data || data.mode === 'qa_regrade') idValue(data.artifact_id);
        if ('answering_duration_ms' in data) { versionValue(data.answering_duration_ms, 0); if (data.mode === 'qa_regrade') throw validation('duration', 'regrade is not a new answer'); }
      } else if ('artifact_id' in data || ['answer', 'qa_regrade'].includes(String(data.mode))) throw validation('result', 'invalid Coding result');
      if ('candidate_id' in data || data.mode === 'regrade') idValue(data.candidate_id);
      if ('reason' in data) textValue(data.reason);
      validateDuration(data.development_duration);
      const rows = array(data.graders, 'graders');
      const selected = new Set(task.graders.map(g => `${g.id}:${g.version}`));
      if (rows.length !== selected.size) throw validation('graders', 'result must account for every selected Grader');
      for (const row of rows) {
        const item = object(row, ['grader'], ['execution_id', 'submission', 'missing_reason']);
        const ref = refValue(item.grader);
        if (!selected.delete(`${ref.id}:${ref.version}`)) throw validation('graders', 'duplicate or unselected Grader');
        if ('execution_id' in item) idValue(item.execution_id);
        if ('submission' in item) {
          const submission = decodeSubmission(item.submission);
          if (submission.execution_id !== item.execution_id || 'missing_reason' in item) throw validation('submission', 'invalid result execution binding');
          if (!data.candidate_id && !data.artifact_id) throw validation('candidate_id', 'grading requires a submitted Candidate');
        } else textValue(item.missing_reason, 'missing_reason');
      }
      break;
    }
    case 'notice': {
      const data = object(record.data, ['grader', 'reason']); parent(refValue(data.grader).id); textValue(data.reason); break;
    }
    default: throw validation('kind', 'unknown Eval record kind');
  }
};
