import { assertPrivateGraderTargets, removePrivateGraderFiles } from "./eval-private-files.js";
import { DomainError } from "./errors.js";
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { environmentUp, environmentDown } from './env-environment.js';
import { startRun } from './env-run.js';
import { selectEnvironmentDefinition, readEnvironmentDefinitions } from './env-definition.js';
import { captureArtifact } from './git.js';

export interface GraderProcess {
  executable: string; args: string[]; cwd: string; timeout_ms: number;
  env?: NodeJS.ProcessEnv; max_output_bytes?: number;
  workspace_root?: string; input_commit?: string; environment_name?: string;
  require_isolation?: boolean;
  private_files?: { source: string; target: string }[];
}
export interface ProcessResult { exit_code: number | null; stdout: string; stderr: string; error?: string }
export type ProcessRunner = (command: GraderProcess) => Promise<ProcessResult>;
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
const safeRelative = (value: string): boolean => !isAbsolute(value) && !value.split('/').some(p => !p || p === '.' || p === '..');

/** Evaluation uses the same preparation, execution and stop/reconcile lifecycle as development. */
export const runGraderProcess: ProcessRunner = async command => {
  let environment: Awaited<ReturnType<typeof environmentUp>> | undefined;
  let result: ProcessResult = { exit_code: null, stdout: '', stderr: '' };
  const addError = (message: string): void => {
    result.error = result.error ? `${result.error}; ${message}` : message;
  };
  try {
    const root = command.workspace_root ?? command.cwd;
    const definition = selectEnvironmentDefinition(readEnvironmentDefinitions(root), command.environment_name);
    if (command.require_isolation && definition.backend !== 'docker') throw new Error('private grading requires a Docker environment; trusted host cannot enforce material isolation');
    const files = command.private_files ?? [];
    if (files.some(file => !safeRelative(file.target))) throw new Error('private grader file must have a safe relative target');
    environment = await environmentUp({ definition, workspace: root, inputCommit: command.input_commit, materialScope: 'blind',
      fixedInputs: files.map((file, index) => ({ name: `grader-${index}`, path: file.source })) });
    const cwd = relative(root, command.cwd);
    if (cwd && !safeRelative(cwd)) throw new Error('grader cwd must remain inside its task repository');
    const container = environment.backend === 'docker';
    const workspace = container ? '/workspace' : environment.workspace;
    assertPrivateGraderTargets(environment.workspace, files.map(file => file.target));
    const copy = files.map((file, index) => `test ! -e ${quote(join(workspace, file.target))} && cp ${quote(`/inputs/grader-${index}`)} ${quote(join(workspace, file.target))} || exit 125`);
    // Only explicit Go tool controls are accepted; never inherit the host environment or credentials.
    const overrides = ['GOPROXY', 'GOSUMDB', 'GOTOOLCHAIN', 'GOWORK', 'GOFLAGS'].flatMap(key => command.env?.[key] === undefined ? [] : [`${key}=${command.env[key]}`]);
    const argv = ['env', ...overrides, command.executable, ...command.args];
    const script = [...copy, `cd ${quote(join(workspace, cwd))} || exit 125`, `exec ${argv.map(quote).join(' ')}`].join('\n');
    const run = await startRun({ environmentId: environment.id, argv: ['/bin/sh', '-c', script], timeoutMs: command.timeout_ms }).done;
    const read = (name: string) => existsSync(join(run.directory, name)) ? readFileSync(join(run.directory, name)) : Buffer.alloc(0);
    const stdout = read('stdout.log'), stderr = read('stderr.log');
    const limit = command.max_output_bytes ?? 2 * 1024 * 1024;
    result = { exit_code: run.exit_code ?? null, stdout: stdout.subarray(0,limit).toString('utf8'), stderr: stderr.subarray(0,Math.max(0,limit-stdout.length)).toString('utf8') };
    if (run.error) addError(run.error);
    if (run.exit_code === 125 || run.exit_code === 126 || run.exit_code === 127) addError(`test setup or process launch failed: ${result.stderr}`);
    if (run.state === 'timed_out') addError('test process exceeded timeout');
    if (run.log_truncated || stdout.length + stderr.length > limit) addError(`test output exceeded ${limit} bytes; captured output is incomplete`);
    if (run.termination !== 'confirmed') addError('test process termination is unknown; environment retained');
    if (container && run.termination === 'confirmed') {
      removePrivateGraderFiles(environment.workspace, files.map(file => file.target));
      if (captureArtifact(environment.workspace, `${environment.input!.commit.length===64?"sha256":"sha1"}:${environment.input!.commit}`, true).result_tree_oid !== `${environment.input!.tree.length===64?"sha256":"sha1"}:${environment.input!.tree}`) {
        addError('Candidate files changed during grading; environment retained');
      }
    }
    if (run.termination === 'confirmed' && !result.error?.includes('environment retained')) environmentDown(environment.id);
  } catch (error) {
    addError(`${error instanceof Error ? error.message : String(error)}${error instanceof DomainError && typeof error.details.reason === "string" ? `: ${error.details.reason}` : ""}${environment ? `; environment ${environment.id} retained for diagnosis` : ''}`);
  }
  return result;
};
