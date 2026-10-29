import { decodeInstanceReference, decodeEnvironmentMetrics, type InstanceReference, type EnvironmentMetrics } from './eval-environment.js';
import { object, textValue, refValue, idValue, timestampValue, type Ref } from './evaluation.js';
import { validation } from './errors.js';
import { isSha256 } from './identity.js';

export interface QADraft {
  format: 'grounds.eval-qa/v1';
  name: string;
  question: string;
  instructions: string;
  rubric: string;
  reference_answer?: string;
  required_points: string[];
  forbidden_claims: string[];
  references: string[];
  source: { identity: string; repository: string; revision: string; path: string; digest: string; record: Record<string, unknown> };
}
export interface QAArtifact {
  format: 'grounds.eval-artifact/v1';
  run_id: string;
  qa: Ref;
  answer: string;
  citations: { content: string; locator: string }[];
  execution: {
    session_id: string; started_at: string; finished_at: string;
    status: 'completed' | 'error'; exit_code: number;
    declared: Record<string, unknown>; observed: Record<string, unknown>;
  };
  capture: { coverage: 'complete' | 'partial' | 'missing'; limitations: string[] };
  files: { name: string; digest: string; size: number }[];
  environment?: InstanceReference;
  metrics?: EnvironmentMetrics;
}
const strings = (v: unknown, field: string): string[] => {
  if (!Array.isArray(v) || v.length > 1000) throw validation(field, 'expected at most 1000 strings');
  return v.map(x => textValue(x, field));
};
const map = (v: unknown, field: string): Record<string, unknown> => {
  if (!v || Array.isArray(v) || typeof v !== 'object' || Buffer.byteLength(JSON.stringify(v)) > 65536) throw validation(field, 'expected an object up to 64 KiB');
  return v as Record<string, unknown>;
};
export const decodeQA = (v: unknown): QADraft => {
  const o = object(v, ['format', 'name', 'question', 'instructions', 'rubric', 'required_points', 'forbidden_claims', 'references', 'source'], ['reference_answer']);
  if (o.format !== 'grounds.eval-qa/v1') throw validation('format', 'expected grounds.eval-qa/v1');
  const s = object(o.source, ['identity', 'repository', 'revision', 'path', 'digest', 'record']);
  if (!isSha256(s.digest)) throw validation('source.digest', 'expected sha256');
  return { format: o.format, name: textValue(o.name, 'name', 1024), question: textValue(o.question), instructions: textValue(o.instructions), rubric: textValue(o.rubric), ...(o.reference_answer === undefined ? {} : { reference_answer: textValue(o.reference_answer) }), required_points: strings(o.required_points, 'required_points'), forbidden_claims: strings(o.forbidden_claims, 'forbidden_claims'), references: strings(o.references, 'references'), source: { identity: textValue(s.identity), repository: textValue(s.repository), revision: textValue(s.revision), path: textValue(s.path), digest: s.digest, record: map(s.record, 'source.record') } };
};
export const decodeQAArtifact = (v: unknown): QAArtifact => {
  const o = object(v, ['format', 'run_id', 'qa', 'answer', 'citations', 'execution', 'capture', 'files'], ['environment','metrics']);
  if (o.format !== 'grounds.eval-artifact/v1') throw validation('format', 'expected grounds.eval-artifact/v1');
  if (typeof o.answer !== 'string' || Buffer.byteLength(o.answer) > 65536) throw validation('answer', 'expected text up to 64 KiB');
  if (!Array.isArray(o.citations) || o.citations.length > 100) throw validation('citations', 'expected at most 100 citations');
  const citations = o.citations.map(v => { const c = object(v, ['content', 'locator']); return { content: textValue(c.content), locator: textValue(c.locator) }; });
  const details = decodeEvidenceDetails(o);
  if (details.execution.status === 'completed' && !o.answer.trim()) throw validation('answer', 'completed execution needs an answer');
  return { format: o.format, run_id: idValue(o.run_id), qa: refValue(o.qa), answer: o.answer, citations, ...details };
};

function decodeEvidenceDetails(o: Record<string, unknown>): Pick<QAArtifact, 'execution' | 'capture' | 'files' | 'environment' | 'metrics'> {
  const e = object(o.execution, ['session_id', 'started_at', 'finished_at', 'status', 'exit_code', 'declared', 'observed']);
  if (!['completed', 'error'].includes(String(e.status)) || !Number.isSafeInteger(e.exit_code)) throw validation('execution', 'invalid process status');
  if (timestampValue(e.finished_at) < timestampValue(e.started_at)) throw validation('execution', 'negative duration');
  if (e.status === 'completed' && e.exit_code !== 0) throw validation('execution', 'completed execution needs successful exit');
  const c = object(o.capture, ['coverage', 'limitations']);
  if (!['complete', 'partial', 'missing'].includes(String(c.coverage))) throw validation('coverage', 'invalid coverage');
  const limitations = strings(c.limitations, 'limitations');
  if (c.coverage !== 'complete' && !limitations.length) throw validation('limitations', 'explain missing evidence');
  if (!Array.isArray(o.files) || o.files.length > 100) throw validation('files', 'expected at most 100 evidence files');
  const files = o.files.map(v => { const f = object(v, ['name', 'digest', 'size']); if (typeof f.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(f.name) || !isSha256(f.digest) || !Number.isSafeInteger(f.size) || Number(f.size) < 0 || Number(f.size) > 32 * 1024 * 1024) throw validation('files', 'invalid name, digest or size (32 MiB maximum per file)'); return { name: f.name, digest: f.digest, size: Number(f.size) }; });
  if (new Set(files.map(f => f.name)).size !== files.length) throw validation('files', 'duplicate names');
  if (files.reduce((n, f) => n + f.size, 0) > 128 * 1024 * 1024) throw validation('files', 'maximum bundle size is 128 MiB');
  if (c.coverage === 'complete' && !files.length) throw validation('files', 'complete capture requires evidence');
  return { execution: { session_id: textValue(e.session_id), started_at: e.started_at as string, finished_at: e.finished_at as string, status: e.status as 'completed' | 'error', exit_code: e.exit_code as number, declared: map(e.declared, 'declared'), observed: map(e.observed, 'observed') }, capture: { coverage: c.coverage as QAArtifact['capture']['coverage'], limitations }, files, ...(o.environment ? {environment:decodeInstanceReference(o.environment)} : {}), ...(o.metrics ? {metrics:decodeEnvironmentMetrics(o.metrics)} : {}) };
}

export type QAGradingEvidence = Pick<QAArtifact, 'execution' | 'capture' | 'files' | 'environment' | 'metrics'> & { format: 'grounds.eval-grading-evidence/v1'; execution_id: string; context_digest: string };
export const decodeQAGradingEvidence = (v: unknown): QAGradingEvidence => {
  const o = object(v, ['format', 'execution_id', 'context_digest', 'execution', 'capture', 'files'], ['environment','metrics']);
  if (o.format !== 'grounds.eval-grading-evidence/v1' || !isSha256(o.context_digest)) throw validation('grading_evidence', 'invalid format or context digest');
  return { format: o.format, execution_id: idValue(o.execution_id), context_digest: o.context_digest, ...decodeEvidenceDetails(o) };
};
