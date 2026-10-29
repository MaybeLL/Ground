import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { captureArtifact, materializeCandidateWorktree } from './git.js';
import { DomainError, validation } from './errors.js';
import type { CandidateMaterialization } from './module.js';
import type { EvalEvidence, GraderDraft, Outcome } from './evaluation.js';
import { runGraderProcess, type ProcessResult, type ProcessRunner } from './eval-process.js';

export type UnitTestDefinition = Extract<GraderDraft['definition'], { type: 'unit_test' }>;
type Judgment =
  | { status: 'completed'; outcome: Outcome; explanation: string }
  | { status: 'error' | 'not_executed'; explanation: string };
export type GraderAssessment = Judgment & { evidence: EvalEvidence[] };
export interface UnitTestRequest {
  candidate: CandidateMaterialization;
  definition: UnitTestDefinition;
  source: string;
}
export type UnitTestAdapter = (request: UnitTestRequest) => Promise<GraderAssessment>;

/** Exit zero alone is insufficient: the selected test must actually finish. */
export const interpretGoResult = (testName: string, result: ProcessResult): Judgment => {
  if (result.error) return { status: 'error', explanation: result.error };
  const events: { Action?: string; Test?: string }[] = [];
  try {
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid event');
      const fields = event as { Action?: unknown; Test?: unknown };
      if (typeof fields.Action !== 'string' || (fields.Test !== undefined && typeof fields.Test !== 'string')) throw new Error('invalid event');
      events.push(fields as { Action: string; Test?: string });
    }
  } catch {
    return { status: 'error', explanation: 'Go did not produce a complete JSON event stream' };
  }
  const root = events.filter(event => event.Test === testName);
  const ran = root.some(event => event.Action === 'run');
  if (result.exit_code !== 0 && !ran) return { status: 'error', explanation: 'Compilation or setup failed before the selected test ran' };
  if (!ran || root.some(event => event.Action === 'skip')) return { status: 'not_executed', explanation: 'The selected test did not run or was skipped' };
  if (root.some(event => event.Action === 'fail')) return { status: 'completed', outcome: { kind: 'decision', verdict: 'fail' }, explanation: 'The selected test ran and failed; inspect test evidence for the violated expectation' };
  if (events.some(event => event.Action === 'skip' && event.Test?.startsWith(testName + '/'))) return { status: 'not_executed', explanation: 'A selected table-driven subtest was skipped; coverage is incomplete' };
  if (result.exit_code === 0 && root.some(event => event.Action === 'pass')) return { status: 'completed', outcome: { kind: 'decision', verdict: 'pass' }, explanation: 'The selected test ran and passed' };
  return { status: 'error', explanation: 'Compilation, setup, or execution did not complete; no Candidate verdict was inferred' };
};

/** Preserve the bounded raw streams in UTF-8-safe pieces accepted by Evidence. */
const processEvidence = (args: string[], cwd: string, result: ProcessResult): EvalEvidence[] => {
  const evidence: EvalEvidence[] = [{ kind: 'command', content: JSON.stringify({ command: ['go', ...args], cwd, exit_code: result.exit_code, ...(result.error ? { error: result.error } : {}) }) }];
  for (const [stream, output] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
    // 15,000 UTF-16 units occupy at most 45,000 UTF-8 bytes; keep surrogate pairs intact.
    let part = 0;
    for (let offset = 0; offset < output.length;) {
      let end = Math.min(offset + 15000, output.length);
      if (end < output.length && /[\uD800-\uDBFF]/.test(output[end - 1])) end--;
      evidence.push({ kind: 'command', content: `${stream} part ${++part}\n${output.slice(offset, end)}` });
      offset = end;
    }
  }
  return evidence;
};

const testDirectory = (target: string, packagePath: string): string => {
  let directory = target;
  for (const segment of ['', ...(packagePath === '.' ? [] : packagePath.split('/'))]) {
    directory = join(directory, segment);
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw validation('package', 'test package must be a real directory inside the Candidate');
  }
  return directory;
};

/** Resolve only within the immutable Candidate; never inherit a host module. */
const goModule = (target: string, directory: string): { cwd: string; mode: string; package: string } => {
  for (let cwd = directory; ; cwd = dirname(cwd)) {
    const module = lstatSync(join(cwd, 'go.mod'), { throwIfNoEntry: false });
    if (module) {
      if (!module.isFile()) throw validation('package', 'go.mod must be a regular file inside the Candidate');
      const vendor = lstatSync(join(cwd, 'vendor'), { throwIfNoEntry: false });
      if (vendor && !vendor.isDirectory()) throw validation('package', 'vendor must be a real directory inside the module');
      const path = relative(cwd, directory).split('\\').join('/');
      return { cwd, mode: vendor ? 'vendor' : 'readonly', package: path ? `./${path}` : '.' };
    }
    if (cwd === target) throw validation('package', 'no go.mod found between the test package and Candidate root');
  }
};

/** Owns temporary worktree lifetime; the runner seam also supports deterministic failures. */
export const gradeGoCandidate = async (request: UnitTestRequest, runProcess: ProcessRunner = runGraderProcess): Promise<GraderAssessment> => {
  const { candidate, definition, source } = request;
  const temporary = mkdtempSync(join(tmpdir(), 'grounds-eval-'));
  const target = join(temporary, 'candidate');
  let materialized = false;
  let evidence: EvalEvidence[] = [];
  let assessment: GraderAssessment;
  try {
    materializeCandidateWorktree({ source_path: source, target_path: target, mode: 'review', source_commit: candidate.source?.commit, baseline_oid: candidate.baseline.git_oid, patch: candidate.patch, expected_tree_oid: candidate.result_tree_oid });
    materialized = true;
    const directory = testDirectory(target, definition.package);
    const module = goModule(target, directory);
    for (const file of definition.files) writeFileSync(join(directory, file.path), file.content, { flag: 'wx', mode: 0o600 });
    const args = ['test', '-json', `-mod=${module.mode}`, '-count=1', `-timeout=${definition.timeout_seconds}s`, `-run=^${definition.test_name}$`, module.package];
    const result = await runProcess({
      executable: 'go', args, cwd: module.cwd, timeout_ms: (definition.timeout_seconds + 10) * 1000,
      workspace_root: target, input_commit: candidate.source!.commit, require_isolation: true,
      private_files: definition.files.map(file => ({ source: join(directory, file.path), target: relative(target, join(directory, file.path)) })),
      // Limit raw bytes so complete evidence fits the 100-item submission bound.
      max_output_bytes: 1024 * 1024,
      env: { GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '', GOCACHE: join(temporary, 'go-cache') },
    });
    evidence = processEvidence(args, relative(target, module.cwd) || '.', result);
    testDirectory(target, definition.package);
    for (const file of definition.files) rmSync(join(directory, file.path), { force: true });
    const after = captureArtifact(target, candidate.baseline.git_oid);
    if (after.result_tree_oid !== candidate.result_tree_oid) {
      assessment = { status: 'error', explanation: 'Candidate files changed during grading; the outcome cannot be attributed to the immutable Candidate', evidence };
    } else {
      assessment = { ...interpretGoResult(definition.test_name, result), evidence };
    }
  } catch (error) {
    const detail = error instanceof DomainError ? JSON.stringify(error.toJSON()) : String(error);
    assessment = { status: 'error', explanation: `Grader setup/execution error: ${detail.slice(0, 4000)}`, evidence };
  }
  try {
    if (materialized) execFileSync('git', ['worktree', 'remove', '--force', target], { cwd: source, stdio: 'pipe' });
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    assessment = { status: 'error', explanation: `Grader cleanup failed; temporary files preserved at ${temporary}: ${String(error).slice(0, 3000)}`, evidence: assessment.evidence };
  }
  return assessment;
};
