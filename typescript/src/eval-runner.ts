import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUUIDv7 } from './identity.js';
import { validation } from './errors.js';
import type { EvalModule, EvalWrite } from './eval-module.js';
import { decodeSubmission, idValue, type EvalRecord, type GraderSubmission } from './evaluation.js';
import type { Module } from './module.js';
import { gradeGoCandidate, type UnitTestAdapter } from './eval-go.js';

export { interpretGoResult } from './eval-go.js';

export interface GraderRecovery {
  load(executionId: string): GraderSubmission | undefined;
  save(submission: GraderSubmission): void;
  remove(executionId: string): void;
}

/** A failed ledger submission leaves the complete result available for replay. */
export class FileGraderRecovery implements GraderRecovery {
  constructor(private readonly directory = tmpdir()) {}
  private path(id: string): string { return join(this.directory, `grounds-eval-${idValue(id)}.json`); }
  load(id: string): GraderSubmission | undefined {
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    const submission = decodeSubmission(JSON.parse(readFileSync(path, 'utf8')));
    if (submission.execution_id !== id) throw validation('recovery', 'execution identity does not match the saved result');
    return submission;
  }
  save(submission: GraderSubmission): void {
    writeFileSync(this.path(submission.execution_id), JSON.stringify(submission, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  remove(id: string): void { rmSync(this.path(id), { force: true }); }
}

export interface UnitGraderDependencies {
  grade: UnitTestAdapter;
  recovery: GraderRecovery;
}
interface UnitGraderRequest {
  module: Pick<EvalModule, 'show' | 'claimUnitExecution' | 'submitGrader'>;
  work: Pick<Module, 'loadCandidateMaterialization'>;
  execution: EvalRecord<'execution'>;
  grader: EvalRecord<'grader'>;
  source: string;
  actor: EvalWrite;
}

const defaults: UnitGraderDependencies = { grade: gradeGoCandidate, recovery: new FileGraderRecovery() };

/** Orchestrates one attempt. Recovery can resubmit evidence but never reruns tests. */
export const executeUnitGrader = async (request: UnitGraderRequest, dependencies: UnitGraderDependencies = defaults): Promise<EvalRecord<'execution'>> => {
  const { module, work, execution, grader, source, actor } = request;
  const definition = grader.data.definition;
  if (definition.type !== 'unit_test') throw validation('grader', 'use grader context and submit for Agent Graders');
  if (grader.id !== execution.data.grader.id || grader.version !== execution.data.grader.version) throw validation('grader', 'definition does not match the reserved execution');
  const latest = await module.show('execution', execution.id);
  if (latest.data.submission) return latest;

  let submission = dependencies.recovery.load(execution.id);
  if (submission && (submission.execution_id !== execution.id || submission.context_digest !== execution.data.context_digest)) throw validation('recovery', 'saved result does not match the reserved Candidate and Grader');
  if (!submission) {
    if (!execution.data.candidate_id) throw validation('execution', 'unit grading requires a Candidate');
    const candidate = await work.loadCandidateMaterialization(execution.data.candidate_id);
    if (!await module.claimUnitExecution(execution.id, { ...actor, operation_id: newUUIDv7() })) {
      throw validation('execution', 'already started without recoverable evidence; stop this EvalRun and explicitly regrade');
    }
    const base = { format: 'patchledger.eval-grader-submission/v1' as const, execution_id: execution.id, context_digest: execution.data.context_digest };
    try {
      submission = { ...base, ...await dependencies.grade({ candidate, definition, source }) };
    } catch (error) {
      submission = { ...base, status: 'error', explanation: `Grader adapter failed: ${String(error).slice(0, 4000)}`, evidence: [] };
    }
    // Validate before recording a recovery file that may be imported later.
    submission = decodeSubmission(submission);
    dependencies.recovery.save(submission);
  }
  const saved = await module.submitGrader(submission, { ...actor, operation_id: newUUIDv7() });
  // A completed ledger result remains successful if best-effort local cleanup fails.
  try { dependencies.recovery.remove(execution.id); } catch { /* The ledger is authoritative; a later read will reuse it. */ }
  return saved;
};
