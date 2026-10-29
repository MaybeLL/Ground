import { EnvironmentModule } from './eval-environment-module.js';
import { decodeEnvironmentCheck, decodePreparation, decodeInstance } from './eval-environment.js';
import { decodeQAArtifact, decodeQAGradingEvidence } from './eval-qa.js';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ParsedArgs } from './cli.js';
import type { Store } from './store-types.js';
import type { Attribution } from './domain.js';
import { EvalModule } from './eval-module.js';
import { evalFilterOptions } from './eval-list.js';
import { type EvalKind, versionValue, idValue, decodeEvalJSON } from './evaluation.js';
import { Module } from './module.js';
import { validation } from './errors.js';
import { DevWorktreeModule } from './dev-worktree.js';
import { newUUIDv7 } from './identity.js';
import { discoverRepository, matchingRemoteNames } from './git.js';
import { executeUnitGrader } from './eval-runner.js';
import { renderEvalReport } from './eval-report.js';

const commands: Record<string, { options: string[]; ids: number; write?: boolean }> = {
  'environment.publish': {options:['file','expected-version'],ids:-1,write:true},
  'environment.show': {options:['version'],ids:1},
  'environment.list': {options:['view','limit','cursor'],ids:0},
  'envcheck.submit': {options:['file','files'],ids:0,write:true},
  'envcheck.show': {options:['version'],ids:1},
  'envcheck.list': {options:['view','limit','cursor','environment'],ids:0},
  'envcheck.export': {options:['out','version'],ids:1},
  'preparation.submit': {options:['file','files','expected-version'],ids:-1,write:true},
  'preparation.show': {options:['version'],ids:1},
  'preparation.list': {options:['view','limit','cursor','environment'],ids:0},
  'preparation.export': {options:['out','version'],ids:1},
  'instance.submit': {options:['file','files','expected-version'],ids:-1,write:true},
  'instance.show': {options:['version'],ids:1},
  'instance.list': {options:['view','limit','cursor','run','preparation'],ids:0},
  'instance.export': {options:['out','version'],ids:1},
  'qa.publish': { options: ['file', 'expected-version'], ids: -1, write: true },
  'qa.show': { options: ['version'], ids: 1 },
  'qa.list': { options: ['view','limit','cursor'], ids: 0 },
  'artifact.submit': { options: ['file', 'files'], ids: 0, write: true },
  'artifact.show': { options: [], ids: 1 },
  'artifact.file': { options: ['name', 'offset'], ids: 1 },
  'grader.evidence-file': { options: ['name', 'offset'], ids: 1 },
  'grader.notices': { options: ['version'], ids: 1 },
  'artifact.export': { options: ['out'], ids: 1 },
  'grader.template': { options: ['issue', 'issue-version', 'type'], ids: 0 },
  'grader.publish': { options: ['file', 'expected-version'], ids: -1, write: true },
  'grader.discourage': { options: ['version', 'reason'], ids: 1, write: true },
  'grader.show': { options: ['version'], ids: 1 },
  'grader.list': { options: ['view','limit','cursor','issue','qa'], ids: 0 },
  'grader.context': { options: ['eval-run', 'grader', 'out'], ids: 0, write: true },
  'grader.execute': { options: ['eval-run', 'grader'], ids: 0, write: true },
  'grader.evidence-submit': { options: ['file', 'files'], ids: 0, write: true },
  'grader.evidence-export': { options: ['out'], ids: 1 },
  'grader.submit': { options: ['file'], ids: 0, write: true },
  'suite.create': { options: ['name'], ids: 0, write: true },
  'suite.show': { options: ['version'], ids: 1 },
  'suite.list': { options: ['view','limit','cursor'], ids: 0 },
  'suite.task.add': { options: ['expected-version', 'file'], ids: 1, write: true },
  'suite.task.update': { options: ['expected-version', 'file', 'task'], ids: 1, write: true },
  'suite.task.remove': { options: ['expected-version', 'task'], ids: 1, write: true },
  'suite.tasks.publish': { options: ['expected-version', 'file'], ids: 1, write: true },
  'snapshot.show': { options: [], ids: 1 },
  'experiment.create': { options: ['suite', 'snapshot', 'file'], ids: 0, write: true },
  'experiment.show': { options: [], ids: 1 },
  'experiment.list': { options: ['view','limit','cursor','snapshot'], ids: 0 },
  'experiment.report': { options: ['out'], ids: 1 },
  'run.start': { options: ['experiment', 'task', 'candidate', 'artifact', 'rerun-of'], ids: 0, write: true },
  'run.show': { options: [], ids: 1 },
  'run.context': { options: ['out'], ids: 1 },
  'run.list': { options: ['view','limit','cursor','experiment','state'], ids: 0 },
  'run.finish': { options: [], ids: 1, write: true },
  'run.stop': { options: ['reason'], ids: 1, write: true },
  'result.show': { options: [], ids: 1 },
  'compare': { options: ['out'], ids: 2 },
};
const keyFor = (args: ParsedArgs): { key: string; index: number } => {
  const p = args.positionals;
  const n = p[1] === 'compare' ? 2 : p[1] === 'suite' && (p[2] === 'task' || p[2] === 'tasks') ? 4 : 3;
  return { key: p.slice(1, n).join('.'), index: n };
};
export const evalNeedsOperation = (args: ParsedArgs): boolean => args.positionals[0] === 'eval' && Boolean(commands[keyFor(args).key]?.write);
export const evalHelp = (): string => 'Grounds evaluation (private coordinator commands)\n' + Object.entries(commands).map(([key, c]) => `grounds eval ${key.replaceAll('.', ' ')}${c.ids === 1 ? ' ID' : c.ids === 2 ? ' EXPERIMENT_A EXPERIMENT_B' : c.ids === -1 ? ' [ID]' : ''}${c.options.map(o => ` [--${o} VALUE]`).join('')}`).join('\n') + '\nList: default returns complete latest records. --view summary (implied by --limit/--cursor) returns bounded summaries (id, kind, version, created_at, parent, name, small state; experiment adds Run counts), --limit 1-1000 (default 100), pages ordered by ID ascending, next_cursor continues with the same filters; changed data returns retryable LIST_CHANGED (restart from page one). Filters are exact IDs: grader --issue|--qa, envcheck|preparation --environment, instance --run|--preparation, experiment --snapshot, run --experiment and --state open|closed; run list in full view requires --experiment.'
  + '\nGlobal: --config PATH --cwd CLONE --json; writes: --operation-id UUID --agent-id NAME --agent-name NAME';
export const validateEvalArgs = (args: ParsedArgs): void => {
  const { key, index } = keyFor(args); const c = commands[key];
  if (!c) throw validation('command', 'unknown eval command; use eval --help');
  const count = args.positionals.length - index;
  if (c.ids === -1 ? count > 1 : count !== c.ids) throw validation('command', 'unexpected or missing positional IDs');
  const allowed = new Set(['config', 'cwd', 'json', ...c.options, ...(c.write ? ['operation-id', 'agent-id', 'agent-name'] : [])]);
  for (const [k, v] of Object.entries(args.values)) {
    if (!allowed.has(k)) throw validation(k, 'option is not valid for this eval command');
    if (Array.isArray(v)) throw validation(k, 'must be supplied only once');
    if (k === 'json') { if (![true, 'true', 'false'].includes(v)) throw validation(k, 'must be boolean'); }
    else if (typeof v !== 'string' || !v.trim()) throw validation(k, 'requires a value');
  }
};

export const executeEval = async (args: ParsedArgs, store: Store, cwd: string, databaseId: string, attribution: () => Attribution): Promise<unknown> => {
  const { key, index } = keyFor(args); const positional = args.positionals[index];
  const v = (k: string, required = true): string => { const value = args.values[k]; if (typeof value !== 'string' || !value.trim()) { if (required) throw validation(k, 'is required'); return ''; } return value; };
  const file = (): unknown => decodeEvalJSON(readFileSync(resolve(cwd, v('file'))));
  // QA artifact and grading-evidence documents may carry a null token usage
  // (`environmentMetrics.usage`), so they read under the nullable contract.
  const evidenceFile = (): unknown => decodeEvalJSON(readFileSync(resolve(cwd, v('file'))), { allowNulls: true });
  const actor = () => ({ operation_id: v('operation-id'), attribution: attribution() });
  const module = new EnvironmentModule(store); const work = new Module(store);
  const output = (payload: unknown) => ({ result_type: 'patchledger.result.eval/v1', command: `eval.${key}`, payload });
  const exportReport = (report: Awaited<ReturnType<EvalModule['report']>>) => {
    const out = v('out', false);
    if (!out) return report;
    const directory = resolve(cwd, out); mkdirSync(directory, { recursive: false, mode: 0o700 });
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(join(directory, 'report.md'), renderEvalReport(report), { mode: 0o600, flag: 'wx' });
    return { report, directory };
  };
  if(key==='environment.publish') {
    if(Boolean(positional)!==Boolean(v('expected-version',false)))throw validation('expected-version','required only for an explicit update');
    return output(await module.publishEnvironment(file(),actor(),positional?{id:positional,expected_version:Number(v('expected-version'))}:undefined));
  }
  if(['envcheck.submit','preparation.submit','instance.submit'].includes(key)) {
    if(Boolean(positional)!==Boolean(v('expected-version',false)))throw validation('expected-version','required only for an explicit update');
    const raw=file();const draft=key==='envcheck.submit'?decodeEnvironmentCheck(raw):key==='preparation.submit'?decodePreparation(raw):decodeInstance(raw);
    const root=realpathSync(resolve(cwd,v('files')));const files=new Map<string,Buffer>();
    for(const f of draft.files){const path=join(root,f.name);const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==f.size)throw validation('files','expected regular evidence files');files.set(f.name,readFileSync(path));}
    const update=positional?{id:positional,expected_version:Number(v('expected-version'))}:undefined;
    return output(key==='envcheck.submit'?await module.submitCheck(draft,files,actor()):key==='preparation.submit'?await module.submitPreparation(draft,files,actor(),update):await module.submitInstance(draft,files,actor(),update));
  }
  if(['envcheck.export','preparation.export','instance.export'].includes(key)) {
    const kind=key.split('.')[0] as 'envcheck'|'preparation'|'instance';const version=v('version',false)?Number(v('version')):undefined;
    const record=await module.show(kind,positional,version);const files=await module.evidenceFiles(kind,positional,version);const out=resolve(cwd,v('out'));mkdirSync(out,{mode:0o700});
    writeFileSync(join(out,'record.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600,flag:'wx'});const evidence=join(out,'files');mkdirSync(evidence,{mode:0o700});for(const f of files)writeFileSync(join(evidence,f.name),f.bytes,{mode:0o600,flag:'wx'});
    return output({record,directory:out});
  }
  if (key === 'artifact.file' || key === 'grader.evidence-file') return output(await module.evidenceFile(key === 'artifact.file' ? 'artifact' : 'execution', positional, v('name'), v('offset', false) ? Number(v('offset')) : 0));
  if (key === 'grader.notices') {
    const grader = await module.show('grader', positional, v('version', false) ? Number(v('version')) : undefined);
    return output((await module.list('notice')).filter(n => n.data.grader.id === grader.id && n.data.grader.version === grader.version));
  }
  if (key === 'qa.publish') {
    if (Boolean(positional) !== Boolean(v('expected-version', false))) throw validation('expected-version', 'required only for an explicit update');
    return output(await module.publishQA(file(), actor(), positional ? { id: positional, expected_version: Number(v('expected-version')) } : undefined));
  }
  if (key === 'artifact.submit' || key === 'grader.evidence-submit') {
    const draft = key === 'artifact.submit' ? decodeQAArtifact(evidenceFile()) : decodeQAGradingEvidence(evidenceFile()); const root = realpathSync(resolve(cwd, v('files')));
    const files = new Map<string, Buffer>();
    for (const f of draft.files) {
      const path = join(root, f.name); const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== f.size) throw validation('files', 'must be regular files matching manifest sizes');
      files.set(f.name, readFileSync(path));
    }
    return output(key === 'artifact.submit' ? await module.submitArtifact(draft, files, actor()) : await module.submitGradingEvidence(draft, files, actor()));
  }
  if (key === 'grader.evidence-export') {
    const execution = await module.show('execution', positional); const files = await module.gradingEvidenceFiles(positional);
    const out = resolve(cwd, v('out')); mkdirSync(out, { mode: 0o700 });
    writeFileSync(join(out, 'grading-evidence.json'), JSON.stringify(execution.data.grading_evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const evidence = join(out, 'files'); mkdirSync(evidence, { mode: 0o700 });
    for (const f of files) writeFileSync(join(evidence, f.name), f.bytes, { mode: 0o600, flag: 'wx' });
    return output({ execution, directory: out });
  }
  if (key === 'artifact.export') {
    const artifact = await module.show('artifact', positional); const files = await module.artifactFiles(positional);
    const out = resolve(cwd, v('out')); mkdirSync(out, { mode: 0o700 });
    writeFileSync(join(out, 'artifact.json'), JSON.stringify(artifact.data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const evidence = join(out, 'files'); mkdirSync(evidence, { mode: 0o700 });
    for (const f of files) writeFileSync(join(evidence, f.name), f.bytes, { mode: 0o600, flag: 'wx' });
    return output({ artifact, directory: out });
  }
  if (key === 'grader.template') {
    const issue = { id: idValue(v('issue')), version: versionValue(Number(v('issue-version'))) };
    await store.read(tx => tx.getIssueRevisionByNumber(issue.id, issue.version));
    const type = v('type'); if (!['agent', 'unit_test'].includes(type)) throw validation('type', 'expected agent or unit_test');
    return output({ format: 'patchledger.eval-grader/v1', issue, name: 'TODO', scope: { kind: 'diagnostic', name: 'TODO: quality dimension (use criterion scope for required behavior)' }, result_spec: { kind: 'decision' }, definition: type === 'agent' ? { type, instructions: 'TODO: observable expectations; write and run unit tests first; reason only where testing is impractical.' } : { type, adapter: 'go', package: '.', test_name: 'TestRequirement', timeout_seconds: 60, files: [{ path: 'requirement_test.go', content: 'TODO: ordinary Go test function with table-driven cases' }] }, limitations: 'Not calibrated yet' });
  }
  if (key === 'grader.publish') {
    if (Boolean(positional) !== Boolean(v('expected-version', false))) throw validation('expected-version', 'required only when publishing a new version of an existing Grader');
    return output(await module.publishGrader(file(), actor(), positional ? { id: positional, expected_version: Number(v('expected-version')) } : undefined));
  }
  if (key === 'grader.discourage') return output(await module.discourageGrader({ id: positional, version: Number(v('version')) }, v('reason'), actor()));
  if (key === 'suite.create') return output(await module.createSuite(v('name'), actor()));
  if (key === 'suite.tasks.publish') return output(await module.publishSuiteTasks(positional, Number(v('expected-version')), file(), actor()));
  if (key.startsWith('suite.task.')) {
    const type = key.split('.')[2] as 'add' | 'update' | 'remove';
    return output(await module.changeTask(positional, Number(v('expected-version')), type === 'remove' ? { type, task_id: v('task') } : { type, task: file(), ...(type === 'update' ? { task_id: v('task') } : {}) }, actor()));
  }
  if (key === 'experiment.create') {
    const suite = v('suite', false); const snapshot = v('snapshot', false);
    if (Boolean(suite) === Boolean(snapshot)) throw validation('suite', 'provide exactly one of --suite or --snapshot');
    return output(await module.createExperiment(suite ? { suite_id: suite } : { snapshot_id: snapshot }, file(), actor()));
  }
  if (key === 'run.start') {
    const input = { experiment_id: v('experiment'), task_id: v('task'), ...(v('candidate', false) ? { candidate_id: v('candidate') } : {}), ...(v('artifact', false) ? { artifact_id: v('artifact') } : {}), ...(v('rerun-of', false) ? { rerun_of: v('rerun-of') } : {}) };
    const who = actor();
    const experiment = await module.show('experiment', input.experiment_id);
    const snapshot = await module.show('snapshot', experiment.data.snapshot_id);
    if (snapshot.data.tasks.find(t => t.id === input.task_id)?.qa || input.artifact_id) return output(await module.startRun(input, who));
    if (input.candidate_id) return output(await module.startRun(input, who));
    const target = await module.developmentTarget(input.experiment_id, input.task_id);
    if (!matchingRemoteNames(discoverRepository(cwd), [target.repository.canonical_remote]).length) throw validation('cwd', 'source clone must match the Issue repository');
    const started = await new DevWorktreeModule(cwd, databaseId, newUUIDv7, store).start({ operation_id: who.operation_id, repository_id: target.repository.id, issue_revision_id: target.revision.id, baseline_oid: target.revision.baseline.git_oid }, async id => {
      const run = await module.startRun(input, who, id); return { value: run, dev_run_id: run.data.dev_run_id! };
    });
    return output({ run: started.value, local_worktree: started.local_worktree, development_context: await work.devRunContext(started.value.data.dev_run_id!, true) });
  }
  if (key === 'run.context') {
    const run = await module.show('run', positional);
    if (run.data.task.qa) {
      const packet = await module.publicContext(positional);
      if (v('out', false)) writeFileSync(resolve(cwd, v('out')), JSON.stringify(packet, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      return output(packet);
    }
    if (!run.data.dev_run_id) throw validation('run', 'regrade runs do not have development context');
    return output(await work.devRunContext(run.data.dev_run_id, true));
  }
  if (key === 'run.show') {
    return output(await module.inspectRun(positional));
  }
  if (key === 'run.finish' || key === 'run.stop') return output(await module.finishRun(positional, actor(), key === 'run.stop' ? v('reason') : undefined));
  if (key === 'grader.context' || key === 'grader.execute') {
    const run = await module.show('run', v('eval-run'));
    const selected = run.data.task.graders.find(g => g.id === v('grader'));
    if (!selected) throw validation('grader', 'not selected for this task');
    const selectedGrader = await module.show('grader', selected.id, selected.version);
    if (selectedGrader.data.definition.type !== (key === 'grader.execute' ? 'unit_test' : 'agent')) throw validation('grader', 'use execute for unit_test and context for agent');
    const who = actor(); const execution = await module.reserveGrader(v('eval-run'), v('grader'), who, key === 'grader.execute' ? 'execute' : 'context');
    const grader = await module.show('grader', execution.data.grader.id, execution.data.grader.version);
    if (key === 'grader.execute') return output(await executeUnitGrader({ module, work, execution, grader, source: cwd, actor: who }));
    if (execution.data.artifact_id) {
      const packet = await module.qaGradingContext(execution.id); const out = v('out', false);
      if (out) { const dir = resolve(cwd, out); mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, 'context.json'), JSON.stringify(packet, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); const evidence = join(dir, 'files'); mkdirSync(evidence, { mode: 0o700 }); for (const f of await module.artifactFiles(execution.data.artifact_id)) writeFileSync(join(evidence, f.name), f.bytes, { mode: 0o600, flag: 'wx' }); }
      return output(packet);
    }
    const submission_template = { format: 'patchledger.eval-grader-submission/v1', execution_id: execution.id, context_digest: execution.data.context_digest, status: 'completed', outcome: { kind: 'inconclusive', reason: 'Replace with the evidence-based outcome' }, explanation: 'Record tests and reasoning here', evidence: [] };
    const packet = { submission_template, format: 'patchledger.eval-grader-context/v1', execution, grader, candidate_context: (await work.verificationContext(execution.data.candidate_id!, 'blind')).context };
    const out = v('out', false); if (out) { const directory = resolve(cwd, out); mkdirSync(directory, { recursive: false, mode: 0o700 }); writeFileSync(join(directory, 'context.json'), JSON.stringify(packet, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); writeFileSync(join(directory, 'submission.json'), JSON.stringify(submission_template, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    return output(packet);
  }
  if (key === 'grader.submit') return output(await module.submitGrader(file(), actor()));
  if (key === 'experiment.report') return output(exportReport(await module.report(positional)));
  if (key === 'compare') {
    const reports = await Promise.all(args.positionals.slice(index).map(id => module.report(id)));
    if (reports[0].snapshot.id !== reports[1].snapshot.id) throw validation('experiments', 'comparison requires the same frozen snapshot; create other experiments with --snapshot');
    const comparison = { format: 'patchledger.eval-comparison/v1', reports };
    const out = v('out', false); if (out) { const dir = resolve(cwd, out); mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); writeFileSync(join(dir, 'comparison.md'), reports.map(renderEvalReport).join('\n---\n\n'), { flag: 'wx', mode: 0o600 }); }
    return output(comparison);
  }
  const [kind, action] = key.split('.') as [EvalKind, string];
  if (action === 'show') return output(await module.show(kind, positional, v('version', false) ? Number(v('version')) : undefined));
  if (action === 'list') {
    // Filters are exact relations only; `--view summary` (implied by --limit or
    // --cursor) returns bounded summaries, otherwise the complete latest records.
    const filters = Object.fromEntries(evalFilterOptions(kind).filter(name => v(name, false)).map(name => [name, v(name)]));
    const paging = Boolean(v('limit', false) || v('cursor', false));
    const view = v('view', false) || (paging ? 'summary' : 'full');
    if (view !== 'full' && view !== 'summary') throw validation('view', 'must be full or summary');
    if (view === 'full') {
      if (paging) throw validation(v('limit', false) ? 'limit' : 'cursor', 'requires --view summary; complete records are not paged');
      if (kind === 'run') v('experiment');
      return output(await module.list(kind, undefined, filters));
    }
    const limit = v('limit', false) ? Number(v('limit')) : undefined;
    const page = await module.listSummary(kind, filters, { ...(limit === undefined ? {} : { limit }), ...(v('cursor', false) ? { cursor: v('cursor') } : {}) });
    return { ...page, command: `eval.${key}` };
  }
  throw validation('command', 'unimplemented eval command');
};
