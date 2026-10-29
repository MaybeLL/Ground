import { decodeExperimentEnvironment, validateBinding, type InstanceReference } from './eval-environment.js';
import { isDeepStrictEqual } from 'node:util';
import { decodeQA, decodeQAArtifact, decodeQAGradingEvidence, type QAArtifact } from './eval-qa.js';
import { sha256Bytes } from './canonical-json.js';
import { requireReadyQA } from './qa-readiness.js';
import { startDevRunInTransaction, abandonDevRunInTransaction } from './devrun-lifecycle.js';
import { sha256 } from './canonical-json.js';
import { newUUIDv7 } from './identity.js';
import { validateAttribution, type Attribution } from './domain.js';
import { stateConflict, validation, versionConflict } from './errors.js';
import type { Store, Tx, ReadTx } from './store-types.js';
import { buildEvalFilter, readEvalSummaryPage, type EvalListPage, type EvalListRequest } from './eval-list.js';
import { decodeGrader, decodeSubject, decodeTask, decodeSubmission, idValue, versionValue, textValue, type EvalKind, type EvalRecord, type EvalData, type Ref, type Duration } from './evaluation.js';

export interface EvalWrite { operation_id: string; attribution: Attribution }
const same = (a: Ref, b: Ref): boolean => a.id === b.id && a.version === b.version;
const requireOpen = (r: EvalRecord<'run'>): void => { if (r.data.state !== 'open') throw stateConflict('eval_run', r.id, r.data.state); };


/** Keep treatment metadata out of the grader's input; original artifact stays in SQL. */
function gradingArtifact(artifact: QAArtifact): QAArtifact {
  const { environment, metrics, ...packet } = artifact;
  return { ...packet, execution: { ...packet.execution, declared: {}, observed: {} },
    files: packet.files.filter(f => ['events.jsonl', 'tools.jsonl', 'material-evidence.json'].includes(f.name)) };
}

/** Evaluation invariants and immutable execution closure share the ledger transaction. */
export class EvalModule {
  constructor(protected readonly store: Store) {}
  protected async write<T>(command: string, input: unknown, actor: EvalWrite, action: (tx: Tx) => Promise<T>): Promise<T> {
    idValue(actor.operation_id); validateAttribution(actor.attribution);
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: actor.operation_id, command: `eval.${command}`, request_hash: sha256({ input, attribution: actor.attribution }) });
      if (replay) return JSON.parse(replay.result_json).data.payload as T;
      const result = await action(tx);
      await tx.completeOperation(actor.operation_id, JSON.stringify({ format: 'patchledger.cli/v1', ok: true, operation_id: actor.operation_id, data: { result_type: "patchledger.result.eval/v1", command: `eval.${command}`, payload: result }, warnings: [] }));
      return result;
    });
  }
  protected async save<K extends EvalKind>(tx: Tx, kind: K, data: EvalData[K], actor: EvalWrite, previous?: EvalRecord<K>, parentId?: string): Promise<EvalRecord<K>> {
    const parent = previous?.parent_id ?? parentId;
    const record: EvalRecord<K> = { id: previous?.id ?? newUUIDv7(), kind, version: (previous?.version ?? 0) + 1, created_at: await tx.now(), attribution: actor.attribution, data, ...(parent ? { parent_id: parent } : {}) };
    await tx.saveEvalRecord(record, previous?.version ?? 0);
    await tx.appendLedgerEvent({ event_id: newUUIDv7(), event_type: `eval.${kind}.recorded`, event_version: 1, operation_id: actor.operation_id, subject_type: `eval_${kind}`, subject_id: record.id, subject_version: record.version, occurred_at: record.created_at, attribution: actor.attribution, facts: [{ name: 'record_digest', value: sha256(record) }] });
    return record;
  }
  show<K extends EvalKind>(kind: K, id: string, version?: number): Promise<EvalRecord<K>> {
    idValue(id); if (version !== undefined) versionValue(version);
    return this.store.read(tx => tx.getEvalRecord(kind, id, version));
  }
  async list<K extends EvalKind>(kind: K, parentId?: string, filters: Record<string, string> = {}): Promise<EvalRecord<K>[]> {
    if (parentId !== undefined) idValue(parentId);
    const { filter } = buildEvalFilter(kind, filters);
    if (parentId !== undefined && filter.parent_id !== undefined && filter.parent_id !== parentId) return [];
    return this.store.read(tx => tx.listEvalRecords(kind, parentId ?? filter.parent_id, filter.fields));
  }
  /** Bounded summaries of latest records; full bodies stay behind `show`. */
  async listSummary(kind: EvalKind, filters: Record<string, string> = {}, request: EvalListRequest = {}, byteLimit?: number): Promise<EvalListPage> {
    const { filter, bound } = buildEvalFilter(kind, filters);
    return readEvalSummaryPage(this.store, kind, request, filter, bound, byteLimit);
  }
  publishQA(raw: unknown, actor: EvalWrite, update?: { id: string; expected_version: number }): Promise<EvalRecord<'qa'>> {
    const draft = decodeQA(raw);
    if (update) { idValue(update.id); versionValue(update.expected_version); }
    return this.write('qa.publish', { draft, ...(update ? { update } : {}) }, actor, async tx => {
      // New writes use the readiness gate. Immutable historical reads and
      // completed operation replay remain governed by their original receipt.
      requireReadyQA(draft);
      const matches = (await tx.listEvalRecords('qa')).filter(q => q.data.source.identity === draft.source.identity);
      const old = update ? await tx.getEvalRecord('qa', update.id) : matches[0];
      if (update && old!.version !== update.expected_version) throw versionConflict('eval_qa', update.id, update.expected_version, old!.version);
      if (old && sha256(old.data) === sha256(draft)) return old;
      if (old && !update) throw validation('source', 'source exists with changed content; publish an explicit new version');
      if (old && old.data.source.identity !== draft.source.identity) throw validation('source', 'identity is immutable');
      if (matches.some(q => q.id !== old?.id)) throw validation('source', 'duplicate source identity');
      return this.save(tx, 'qa', draft, actor, old);
    });
  }
  async publicContext(runId: string) {
    const run = await this.show('run', runId);
    if (!run.data.task.qa) throw validation('run', 'not a QA task');
    const qa = await this.show('qa', run.data.task.qa.id, run.data.task.qa.version);
    return { format: 'grounds.eval-public-task/v1', run_id: run.id, qa: run.data.task.qa, question: qa.data.question, instructions: qa.data.instructions };
  }
  submitArtifact(raw: unknown, files: Map<string, Buffer>, actor: EvalWrite): Promise<EvalRecord<'artifact'>> {
    const draft = decodeQAArtifact(raw);
    if (files.size !== draft.files.length) throw validation('files', 'evidence set must match manifest');
    for (const f of draft.files) { const bytes = files.get(f.name); if (!bytes || bytes.length !== f.size || sha256Bytes(bytes) !== f.digest) throw validation('files', 'evidence digest or size mismatch'); }
    return this.write('artifact.submit', draft, actor, async tx => {
      const run = await tx.getEvalRecord('run', draft.run_id); requireOpen(run);
      if (run.data.mode !== 'answer' || !run.data.task.qa || !same(run.data.task.qa, draft.qa)) throw validation('artifact', 'must bind a new answer attempt and its QA version');
      if (run.data.artifact_id) throw validation('artifact', 'already frozen');
      await this.checkEnvironmentEvidence(tx,run,draft.environment,'answer',undefined,draft.execution.session_id);
      if((await tx.getEvalRecord('experiment',run.data.experiment_id)).data.environment&&!draft.metrics)throw validation('metrics','environment capture requires metrics');
      if (draft.execution.session_id !== 'unavailable' && ((await tx.listEvalRecords('artifact')).some(a => a.data.execution.session_id === draft.execution.session_id) || (await tx.listEvalRecords('execution')).some(e => e.data.grading_evidence?.execution.session_id === draft.execution.session_id))) throw validation('session_id', 'a measured session may belong to only one answering attempt');
      for (const f of draft.files) await tx.putEvalBlob(files.get(f.name)!);
      const artifact = await this.save(tx, 'artifact', draft, actor, undefined, run.id);
      await this.save(tx, 'run', { ...run.data, artifact_id: artifact.id }, actor, run);
      return artifact;
    });
  }
  async evidenceFile(kind: 'artifact' | 'execution', id: string, name: string, offset = 0) {
    idValue(id); textValue(name);
    if (!Number.isSafeInteger(offset) || offset < 0) throw validation('offset', 'expected non-negative byte offset');
    return this.store.read(async tx => {
      const record = await tx.getEvalRecord(kind, id);
      const files = kind === 'artifact' ? (record.data as QAArtifact).files : (record.data as import('./evaluation.js').EvalData['execution']).grading_evidence?.files;
      const file = files?.find(f => f.name === name);
      if (!file) throw validation('name', 'evidence file is not in the frozen manifest');
      const bytes = await tx.getEvalBlob(file.digest);
      if (bytes.length !== file.size || sha256Bytes(bytes) !== file.digest) throw validation('evidence', 'frozen evidence digest or size mismatch');
      if (offset > bytes.length) throw validation('offset', 'offset exceeds evidence size');
      const end = Math.min(offset + 65536, bytes.length);
      return { kind, id, name, digest: file.digest, size: bytes.length, offset, next_offset: end < bytes.length ? end : null, encoding: 'base64' as const, content: bytes.subarray(offset, end).toString('base64') };
    });
  }
  async artifactFiles(id: string) {
    return this.store.read(async tx => {
      const artifact = await tx.getEvalRecord('artifact', id);
      return Promise.all(artifact.data.files.map(async f => ({ ...f, bytes: await tx.getEvalBlob(f.digest) })));
    });
  }
  submitGradingEvidence(raw: unknown, files: Map<string, Buffer>, actor: EvalWrite): Promise<EvalRecord<'execution'>> {
    const draft = decodeQAGradingEvidence(raw);
    if (files.size !== draft.files.length) throw validation('files', 'evidence set must match manifest');
    for (const f of draft.files) { const bytes = files.get(f.name); if (!bytes || bytes.length !== f.size || sha256Bytes(bytes) !== f.digest) throw validation('files', 'evidence digest or size mismatch'); }
    return this.write('grader.evidence-submit', draft, actor, async tx => {
      const execution = await tx.getEvalRecord('execution', draft.execution_id);
      requireOpen(await tx.getEvalRecord('run', execution.data.run_id));
      if (!execution.data.artifact_id || execution.data.context_digest !== draft.context_digest) throw validation('grading_evidence', 'must bind the reserved QA execution');
      if (execution.data.submission || execution.data.grading_evidence) throw validation('grading_evidence', 'already frozen or submitted');
      const run=await tx.getEvalRecord('run',execution.data.run_id);
      await this.checkEnvironmentEvidence(tx,run,draft.environment,'grade',execution.id,draft.execution.session_id);
      if((await tx.getEvalRecord('experiment',run.data.experiment_id)).data.environment&&!draft.metrics)throw validation('metrics','environment capture requires metrics');
      if (draft.execution.session_id !== 'unavailable') {
        const session = draft.execution.session_id;
        if ((await tx.listEvalRecords('artifact')).some(a => a.data.execution.session_id === session) || (await tx.listEvalRecords('execution')).some(e => e.data.grading_evidence?.execution.session_id === session)) throw validation('session_id', 'grading requires a fresh independent session');
      }
      for (const f of draft.files) await tx.putEvalBlob(files.get(f.name)!);
      return this.save(tx, 'execution', { ...execution.data, grading_evidence: draft }, actor, execution);
    });
  }
  async gradingEvidenceFiles(id: string) {
    return this.store.read(async tx => {
      const execution = await tx.getEvalRecord('execution', id);
      if (!execution.data.grading_evidence) throw validation('grading_evidence', 'no frozen grading evidence');
      return Promise.all(execution.data.grading_evidence.files.map(async f => ({ ...f, bytes: await tx.getEvalBlob(f.digest) })));
    });
  }
  async qaGradingContext(executionId: string) {
    const execution = await this.show('execution', executionId);
    if (!execution.data.artifact_id) throw validation('execution', 'not QA');
    const artifact = await this.show('artifact', execution.data.artifact_id);
    const run = await this.show('run', execution.data.run_id);
    const qaRef = run.data.task.qa!;
    const qa = await this.show('qa', qaRef.id, qaRef.version);
    const grader = await this.show('grader', execution.data.grader.id, execution.data.grader.version);
    // Do not expose another evaluator's submission on repeated context reads.
    return { format: 'grounds.eval-grading-context/v1', execution_id: execution.id, context_digest: execution.data.context_digest, qa_ref: qaRef, qa: qa.data, grader: grader.data, artifact: (await this.show('experiment', run.data.experiment_id)).data.environment ? gradingArtifact(artifact.data) : artifact.data };
  }
  private async checkEnvironmentEvidence(tx:Pick<ReadTx,'getEvalRecord'>,run:EvalRecord<'run'>,reference:InstanceReference|undefined,role:'answer'|'grade',executionId?:string,sessionId?:string) {
    const experiment=await tx.getEvalRecord('experiment',run.data.experiment_id);
    if(!experiment.data.environment){if(reference)throw validation('environment','legacy experiment cannot acquire environment evidence');return;}
    if(!reference)throw validation('environment','capture requires instance provenance');
    const instance=await tx.getEvalRecord('instance',reference.instance.id,reference.instance.version);
    const prep=await tx.getEvalRecord('preparation',reference.preparation.id,reference.preparation.version);
    if(instance.data.run_id!==run.id||instance.data.role!==role||instance.data.execution_id!==executionId||instance.data.preparation_id!==prep.id||prep.data.state!=='success'||instance.data.state!=='collected'||(instance.data.session_id??'unavailable')!==sessionId)throw validation('environment','capture provenance does not match this session');
    return instance;
  }
  private async finishQA(tx: Tx, run: EvalRecord<'run'>, actor: EvalWrite, reason?: string): Promise<EvalRecord<'result'>> {
    const artifact = run.data.artifact_id ? await tx.getEvalRecord('artifact', run.data.artifact_id) : undefined;
    const executions = await tx.listEvalRecords('execution', run.id);
    const graders: EvalData['result']['graders'] = run.data.task.graders.map(ref => {
      const e = executions.find(e => same(e.data.grader, ref));
      return { grader: ref, ...(e ? { execution_id: e.id } : {}), ...(e?.data.submission ? { submission: e.data.submission } : { missing_reason: reason ?? 'QA grading not executed' }) };
    });
    if (!reason && (!artifact || graders.some(g => !g.submission))) throw validation('run', 'submit artifact and every grader, or explicitly stop');
    if(!reason&&(await tx.getEvalRecord('experiment',run.data.experiment_id)).data.environment){
      if(run.data.mode==='answer'){
        const instance=await this.checkEnvironmentEvidence(tx,run,artifact!.data.environment,'answer',undefined,artifact!.data.execution.session_id);
        if(instance?.data.validity!=='valid')throw validation('environment','answer environment must be valid; otherwise stop');
      }
      for(const e of executions){const evidence=e.data.grading_evidence;
        const instance=await this.checkEnvironmentEvidence(tx,run,evidence?.environment,'grade',e.id,evidence?.execution.session_id);
        if(instance?.data.validity!=='valid')throw validation('environment','grading environment must be valid; otherwise stop');
      }
    }

    const result = await this.save(tx, 'result', { run_id: run.id, experiment_id: run.data.experiment_id, task: run.data.task, mode: run.data.mode, development_duration: { kind: 'unknown', reason: 'QA has no code development' }, ...(artifact ? { artifact_id: artifact.id } : {}), ...(artifact && run.data.mode === 'answer' ? { answering_duration_ms: artifact.data.metrics?.duration_ms ?? Date.parse(artifact.data.execution.finished_at) - Date.parse(artifact.data.execution.started_at) } : {}), ...(reason ? { reason } : {}), graders }, actor, undefined, run.id);
    await this.save(tx, 'run', { ...run.data, state: 'closed', result_id: result.id }, actor, run);
    return result;
  }
  publishGrader(raw: unknown, actor: EvalWrite, update?: { id: string; expected_version: number }): Promise<EvalRecord<'grader'>> {
    const draft = decodeGrader(raw); if (update) { idValue(update.id); versionValue(update.expected_version); }
    return this.write('grader.publish', { draft, ...(update ? { update } : {}) }, actor, async tx => {
      const issue = draft.qa ? undefined : await tx.getIssueRevisionByNumber(draft.issue.id, draft.issue.version);
      if (draft.qa) await tx.getEvalRecord('qa', draft.qa.id, draft.qa.version);
      if (draft.scope.kind === 'criterion' && issue) {
        const ids = new Set([...issue.goals, ...issue.constraints].flatMap(target => target.criteria.map(c => c.id)));
        if (draft.scope.criterion_ids.some(id => !ids.has(id))) throw validation('scope', 'Criterion must belong to the fixed Issue Version');
      }
      const old = update ? await tx.getEvalRecord('grader', update.id) : undefined;
      if (old && old.version !== update!.expected_version) throw versionConflict('eval_grader', old.id, update!.expected_version, old.version);
      if (old && (Boolean(old.data.qa) !== Boolean(draft.qa) || !same(old.data.qa ?? old.data.issue, draft.qa ?? draft.issue))) throw validation('grader', 'Grader versions must bind the same Issue Version');
      return this.save(tx, 'grader', draft, actor, old, (draft.qa ?? draft.issue).id);
    });
  }
  discourageGrader(grader: Ref, reason: string, actor: EvalWrite): Promise<EvalRecord<'notice'>> {
    idValue(grader.id); versionValue(grader.version); textValue(reason);
    return this.write('grader.discourage', { grader, reason }, actor, async tx => {
      await tx.getEvalRecord('grader', grader.id, grader.version);
      return this.save(tx, 'notice', { grader, reason }, actor, undefined, grader.id);
    });
  }
  createSuite(name: string, actor: EvalWrite): Promise<EvalRecord<'suite'>> {
    textValue(name, 'name', 1024);
    return this.write('suite.create', { name }, actor, tx => this.save(tx, 'suite', { name, tasks: [] }, actor));
  }
  changeTask(suiteId: string, expected: number, change: { type: 'add' | 'update'; task: unknown; task_id?: string } | { type: 'remove'; task_id: string }, actor: EvalWrite): Promise<EvalRecord<'suite'>> {
    idValue(suiteId); versionValue(expected); if (change.task_id) idValue(change.task_id);
    if (change.type !== 'add' && !change.task_id) throw validation('task_id', 'is required');
    const draft = change.type !== 'remove' ? decodeTask(change.task) : undefined;
    return this.write(`suite.task.${change.type}`, { suiteId, expected, ...change }, actor, async tx => {
      const suite = await tx.getEvalRecord('suite', suiteId);
      if (suite.version !== expected) throw versionConflict('eval_suite', suite.id, expected, suite.version);
      if (draft) {
        if (draft.qa) await tx.getEvalRecord('qa', draft.qa.id, draft.qa.version);
        else await tx.getIssueRevisionByNumber(draft.issue.id, draft.issue.version);
        for (const ref of draft.graders) if (!same(((g) => g.qa ?? g.issue)((await tx.getEvalRecord('grader', ref.id, ref.version)).data), draft.qa ?? draft.issue)) throw validation('graders', 'every Grader must belong to this Issue Version');
      }
      const tasks = [...suite.data.tasks];
      if (change.type === 'add') { if (tasks.length >= 1000) throw validation('tasks', 'suite limit is 1000'); tasks.push({ ...draft!, id: newUUIDv7() }); }
      else { const index = tasks.findIndex(t => t.id === change.task_id); if (index < 0) throw validation('task_id', 'task is not in this suite'); if (change.type === 'remove') tasks.splice(index, 1); else tasks[index] = { ...draft!, id: tasks[index].id }; }
      return this.save(tx, 'suite', { ...suite.data, tasks }, actor, suite);
    });
  }
  publishSuiteTasks(suiteId: string, expected: number, raw: unknown, actor: EvalWrite): Promise<EvalRecord<'suite'>> {
    idValue(suiteId); versionValue(expected);
    const input = raw as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'format,tasks' ||
        input.format !== 'grounds.eval-suite-members/v1' || !Array.isArray(input.tasks) || input.tasks.length > 1000) {
      throw validation('file', 'expected grounds.eval-suite-members/v1 with at most 1000 tasks');
    }
    const requested = input.tasks.map((value: unknown) => {
      const row = value as Record<string, unknown>;
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw validation('tasks', 'each task must be an object');
      const { id, ...draft } = row;
      return { ...(id === undefined ? {} : { id: idValue(id) }), draft: decodeTask(draft) };
    });
    return this.write('suite.tasks.publish', { suiteId, expected, tasks: requested }, actor, async tx => {
      const suite = await tx.getEvalRecord('suite', suiteId);
      if (suite.version !== expected) throw versionConflict('eval_suite', suite.id, expected, suite.version);
      const originals = new Set(suite.data.tasks.map(t => t.id));
      const reused = new Set<string>();
      const tasks = [] as typeof suite.data.tasks;
      for (const row of requested) {
        if (row.id && (!originals.has(row.id) || reused.has(row.id))) throw validation('tasks', 'member identity is unknown or duplicated');
        if (row.id) reused.add(row.id);
        const draft = row.draft;
        if (draft.qa) await tx.getEvalRecord('qa', draft.qa.id, draft.qa.version);
        else await tx.getIssueRevisionByNumber(draft.issue.id, draft.issue.version);
        for (const ref of draft.graders) {
          const grader = await tx.getEvalRecord('grader', ref.id, ref.version);
          if (!same(grader.data.qa ?? grader.data.issue!, draft.qa ?? draft.issue!)) throw validation('graders', 'every Grader must belong to the fixed task version');
        }
        tasks.push({ ...draft, id: row.id ?? newUUIDv7() });
      }
      if (isDeepStrictEqual(tasks, suite.data.tasks)) throw validation('tasks', 'no member changes to publish');
      return this.save(tx, 'suite', { ...suite.data, tasks }, actor, suite);
    });
  }
  createExperiment(source: { suite_id: string } | { snapshot_id: string }, raw: unknown, actor: EvalWrite): Promise<EvalRecord<'experiment'>> {
    const input = raw as Record<string,unknown>; const environment = input?.environment ? decodeExperimentEnvironment(input.environment) : undefined;
    const subject = decodeSubject(environment ? Object.fromEntries(Object.entries(input).filter(([k])=>k!=='environment')) : raw); idValue('suite_id' in source ? source.suite_id : source.snapshot_id);
    return this.write('experiment.create', { source, subject, ...(environment?{environment}:{}) }, actor, async tx => {
      let snapshot: EvalRecord<'snapshot'>;
      if ('suite_id' in source) {
        const suite = await tx.getEvalRecord('suite', source.suite_id);
        if (!suite.data.tasks.length) throw validation('suite', 'cannot evaluate an empty suite');
        snapshot = await this.save(tx, 'snapshot', { suite: { id: suite.id, version: suite.version }, ...suite.data }, actor, undefined, suite.id);
      } else snapshot = await tx.getEvalRecord('snapshot', source.snapshot_id);
      if(environment){if(snapshot.data.tasks.some(t=>t.kind!=='qa'))throw validation('environment','Coding environment execution is not supported yet');await validateBinding(tx,environment.answer,'answer');await validateBinding(tx,environment.grade,'grade');}
      return this.save(tx, 'experiment', { snapshot_id: snapshot.id, subject, ...(environment?{environment}:{}) }, actor, undefined, snapshot.id);
    });
  }
  async developmentTarget(experimentId: string, taskId: string) {
    idValue(experimentId); idValue(taskId);
    return this.store.read(async tx => {
      const experiment = await tx.getEvalRecord('experiment', experimentId);
      const snapshot = await tx.getEvalRecord('snapshot', experiment.data.snapshot_id);
      const task = snapshot.data.tasks.find(t => t.id === taskId);
      if (!task) throw validation('task', 'task is not in the experiment snapshot');
      if (task.qa) throw validation('task', 'QA tasks have no development target');
      const revision = await tx.getIssueRevisionByNumber(task.issue.id, task.issue.version);
      const issue = await tx.getIssue(task.issue.id);
      return { task, revision, repository: await tx.getRepository(issue.repository_id) };
    });
  }
  startRun(input: { experiment_id: string; task_id: string; candidate_id?: string; artifact_id?: string; rerun_of?: string }, actor: EvalWrite, devRunId?: string): Promise<EvalRecord<'run'>> {
    idValue(input.experiment_id); idValue(input.task_id); if (input.candidate_id) idValue(input.candidate_id); if (input.artifact_id) idValue(input.artifact_id); if (input.rerun_of) idValue(input.rerun_of); if (devRunId) idValue(devRunId);
    return this.write('run.start', input, actor, async tx => {
      const experiment = await tx.getEvalRecord('experiment', input.experiment_id);
      const snapshot = await tx.getEvalRecord('snapshot', experiment.data.snapshot_id);
      const task = snapshot.data.tasks.find(t => t.id === input.task_id);
      if (!task) throw validation('task_id', 'task is not in the frozen suite snapshot');
      const previous = (await tx.listEvalRecords('run', experiment.id)).filter(r => r.data.task.id === task.id);
      if (previous.some(r => r.data.state === 'open')) throw validation('task', 'an execution is already open; finish or stop it first');
      if (previous.length && !input.rerun_of) throw validation('rerun_of', 'explicitly name an ended run to repeat this task');
      if (input.rerun_of && !previous.some(r => r.id === input.rerun_of && r.data.state === 'closed')) throw validation('rerun_of', 'must name a closed run of this experiment task');
      let data: EvalData['run'];
      if (task.qa) {
        if (input.candidate_id || devRunId) throw validation('task', 'QA cannot own a Candidate or DevRun');
        if (input.artifact_id) {
          const artifact = await tx.getEvalRecord('artifact', input.artifact_id);
          if (!same(artifact.data.qa, task.qa)) {
            if (artifact.data.qa.id !== task.qa.id) throw validation('artifact', 'different QA identity');
            const original = await tx.getEvalRecord('qa', artifact.data.qa.id, artifact.data.qa.version);
            const current = await tx.getEvalRecord('qa', task.qa.id, task.qa.version);
            if (original.data.question !== current.data.question || original.data.instructions !== current.data.instructions) throw validation('artifact', 'public QA inputs changed; a new answer is required');
          }
          const origin = await tx.getEvalRecord('run', artifact.data.run_id);
          if (origin.data.state !== 'closed') throw validation('artifact', 'finish the source attempt before regrading');
        }
        data = { experiment_id: experiment.id, task, mode: input.artifact_id ? 'qa_regrade' : 'answer', ...(input.artifact_id ? { artifact_id: input.artifact_id } : {}), state: 'open' };
      } else {
      if (input.artifact_id) throw validation('artifact', 'Coding regrades use Candidate');
      const revision = await tx.getIssueRevisionByNumber(task.issue.id, task.issue.version);
      if (input.candidate_id) {
        const candidate = (await tx.getCandidate(input.candidate_id)).candidate;
        if (candidate.issue_revision_id !== revision.id) throw validation('candidate_id', 'Candidate belongs to a different Issue Version');
        data = { experiment_id: experiment.id, task, mode: 'regrade', candidate_id: candidate.id, state: 'open' };
      } else {
        const issue = await tx.getIssue(task.issue.id); const repository = await tx.getRepository(issue.repository_id); const id = devRunId ?? newUUIDv7();
        const requirement = await tx.getRequirementRevision(issue.requirement_id, revision.requirement_revision_id);
        await startDevRunInTransaction(tx, {
          ...actor, id, issue_revision: revision, requirement_revision: requirement,
          repository_id: repository.id, repository_remote_snapshot: repository.canonical_remote,
        });
        data = { experiment_id: experiment.id, task, mode: 'develop', dev_run_id: id, state: 'open' };
      }
      }
      if (input.rerun_of) data.rerun_of = input.rerun_of;
      return this.save(tx, 'run', data, actor, undefined, experiment.id);
    });
  }
  private async candidate(tx: Tx, run: EvalRecord<'run'>) {
    return run.data.candidate_id ? tx.getCandidate(run.data.candidate_id) : run.data.dev_run_id ? tx.getCandidateByDevRun(run.data.dev_run_id) : undefined;
  }
  reserveGrader(runId: string, graderId: string, actor: EvalWrite, action: "context" | "execute" = "context"): Promise<EvalRecord<'execution'>> {
    idValue(runId); idValue(graderId);
    return this.write(`grader.${action}`, { runId, graderId }, actor, async tx => {
      const run = await tx.getEvalRecord('run', runId); requireOpen(run);
      const ref = run.data.task.graders.find(g => g.id === graderId);
      if (!ref) throw validation('grader', 'Grader is not selected for this task');
      if (run.data.task.qa) {
        if (action !== 'context' || !run.data.artifact_id) throw validation('artifact', 'submit QA artifact before agent grading');
        const existing = (await tx.listEvalRecords('execution', runId)).find(e => e.data.grader.id === graderId);
        if (existing) return existing;
        const artifact = await tx.getEvalRecord('artifact', run.data.artifact_id);
        const grader = await tx.getEvalRecord('grader', ref.id, ref.version);
        const qa = await tx.getEvalRecord('qa', run.data.task.qa.id, run.data.task.qa.version);
        const facts = { run_id: runId, grader: ref, artifact_id: artifact.id };
        const environment = (await tx.getEvalRecord('experiment', run.data.experiment_id)).data.environment;
        return this.save(tx, 'execution', { ...facts, context_digest: sha256({ ...facts, qa: qa.data, artifact: environment ? gradingArtifact(artifact.data) : artifact.data, definition: grader.data, ...(environment ? {environment:environment.grade} : {}) }) }, actor, undefined, runId);
      }
      const candidate = await this.candidate(tx, run);
      if (!candidate) throw validation('candidate', 'development must submit a Candidate before grading');
      const existing = (await tx.listEvalRecords('execution', runId)).find(e => e.data.grader.id === graderId);
      if (existing) return existing;
      const grader = await tx.getEvalRecord('grader', ref.id, ref.version);
      const facts = { run_id: runId, grader: ref, candidate_id: candidate.candidate.id, result_tree_oid: candidate.candidate.result_tree_oid };
      return this.save(tx, 'execution', { ...facts, context_digest: sha256({ ...facts, definition: grader.data, patch_digest: candidate.candidate.patch_digest }) }, actor, undefined, runId);
    });
  }
  claimUnitExecution(id: string, actor: EvalWrite): Promise<boolean> {
    idValue(id);
    return this.write('grader.claim', { id }, actor, async tx => {
      const execution = await tx.getEvalRecord('execution', id);
      requireOpen(await tx.getEvalRecord('run', execution.data.run_id));
      if (execution.data.artifact_id) throw validation('execution', 'QA does not execute Go graders');
      if (execution.data.unit_execution_started || execution.data.submission) return false;
      await this.save(tx, 'execution', { ...execution.data, unit_execution_started: true }, actor, execution);
      return true;
    });
  }
  submitGrader(raw: unknown, actor: EvalWrite): Promise<EvalRecord<'execution'>> {
    const submission = decodeSubmission(raw);
    return this.write('grader.submit', submission, actor, async tx => {
      const execution = await tx.getEvalRecord('execution', submission.execution_id);
      const run = await tx.getEvalRecord('run', execution.data.run_id); requireOpen(run);
      if (execution.data.submission) throw validation('execution', 'already submitted; start a new EvalRun to reevaluate');
      if (execution.data.context_digest !== submission.context_digest) throw validation('context_digest', 'does not match the reserved execution');
      const grader = await tx.getEvalRecord('grader', execution.data.grader.id, execution.data.grader.version);
      if (Boolean(execution.data.artifact_id) !== (submission.format === 'grounds.eval-grader-submission/v1')) throw validation('format', 'submission type must match execution');
      if (submission.status === 'completed' && execution.data.grading_evidence?.execution.status === 'error') throw validation('status', 'failed grading execution cannot submit a quality judgment');
      const outcome = submission.outcome; const spec = grader.data.result_spec;
      if (outcome && outcome.kind !== 'inconclusive') {
        if (outcome.kind !== spec.kind) throw validation('outcome', 'does not match the frozen Grader result type');
        if (outcome.kind === 'score' && spec.kind === 'score' && (outcome.value < spec.min || outcome.value > spec.max)) throw validation('outcome.value', 'outside the frozen score scale');
      }
      return this.save(tx, 'execution', { ...execution.data, submission }, actor, execution);
    });
  }
  finishRun(runId: string, actor: EvalWrite, reason?: string): Promise<EvalRecord<'result'>> {
    idValue(runId); if (reason !== undefined) textValue(reason);
    return this.write(reason === undefined ? 'run.finish' : 'run.stop', { runId, ...(reason !== undefined ? { reason } : {}) }, actor, async tx => {
      const run = await tx.getEvalRecord('run', runId);
      if (run.data.result_id) return tx.getEvalRecord('result', run.data.result_id);
      if (run.data.mode === 'answer' || run.data.mode === 'qa_regrade') return this.finishQA(tx, run, actor, reason);
      const candidate = await this.candidate(tx, run); const executions = await tx.listEvalRecords('execution', runId);
      const development = !candidate && run.data.dev_run_id ? await tx.getDevRun(run.data.dev_run_id) : undefined;
      const completionReason = reason ?? development?.abandon_reason;
      const graders: EvalData['result']['graders'] = run.data.task.graders.map(ref => {
        const e = executions.find(e => same(e.data.grader, ref));
        return { grader: ref, ...(e ? { execution_id: e.id } : {}), ...(e?.data.submission ? { submission: e.data.submission } : { missing_reason: completionReason ?? 'Development ended without a Candidate' }) };
      });
      if (!reason) {
        if (candidate && graders.some(g => !g.submission)) throw validation('run', 'Grader results are missing; submit them or explicitly stop with a reason');
        if (!candidate && run.data.dev_run_id && (await tx.getDevRun(run.data.dev_run_id)).state === 'open') throw validation('run', 'development is still open');
      }
      let stoppedAt: string | undefined;
      if (!candidate && run.data.dev_run_id) {
        const dev = await tx.getDevRun(run.data.dev_run_id);
        if (dev.state === 'open' && reason) {
          const stopped = await abandonDevRunInTransaction(tx, { ...actor, dev_run_id: dev.id, expected_version: dev.version, reason });
          stoppedAt = stopped.finished_at;
        }
      }
      let duration: Duration = { kind: 'unknown', reason: 'No recorded development terminal time' };
      const devId = candidate?.candidate.dev_run_id ?? run.data.dev_run_id;
      if (devId) {
        const dev = await tx.getDevRun(devId); let end = candidate?.candidate.created_at ?? stoppedAt;
        if (!end && dev.state === 'abandoned') { const events = await (tx as ReadTx).listLedgerEventsPage(0, '', 'dev_run', dev.id, 1000); end = events.rows.find(e => e.event_type === 'devrun.abandoned')?.occurred_at; }
        if (end && Date.parse(end) >= Date.parse(dev.created_at)) duration = { kind: run.data.mode === 'regrade' ? 'referenced' : 'measured', started_at: dev.created_at, finished_at: end, duration_ms: Math.max(0, Date.parse(end) - Date.parse(dev.created_at)), source_dev_run_id: dev.id };
      }
      const result = await this.save(tx, 'result', { run_id: run.id, experiment_id: run.data.experiment_id, task: run.data.task, mode: run.data.mode, ...(candidate ? { candidate_id: candidate.candidate.id } : {}), development_duration: duration, ...(completionReason ? { reason: completionReason } : {}), graders }, actor, undefined, run.id);
      await this.save(tx, 'run', { ...run.data, state: 'closed', result_id: result.id, ...(candidate ? { candidate_id: candidate.candidate.id } : {}) }, actor, run);
      return result;
    });
  }
  async inspectRun(id: string) {
    idValue(id);
    return this.store.read(async tx => {
      const run = await tx.getEvalRecord('run', id);
      const executions = await tx.listEvalRecords('execution', id);
      const candidate = await this.candidate(tx, run);
      const submitted = executions.filter(e => e.data.submission).length;
      const dev = run.data.dev_run_id ? await tx.getDevRun(run.data.dev_run_id) : undefined;
      const phase = run.data.state === 'closed' ? 'closed' : !candidate && !run.data.artifact_id ? run.data.task.qa ? 'answering' : dev?.state === 'open' ? 'developing' : 'ready_to_finish' : submitted === run.data.task.graders.length ? 'ready_to_finish' : executions.length ? 'grading' : 'ready_to_grade';
      return { run, executions, progress: { phase, planned_graders: run.data.task.graders.length, submitted_graders: submitted, ...(candidate ? { candidate_id: candidate.candidate.id } : {}) } };
    });
  }
  async report(experimentId: string) {
    idValue(experimentId);
    return this.store.read(async tx => {
      const experiment = await tx.getEvalRecord('experiment', experimentId); const snapshot = await tx.getEvalRecord('snapshot', experiment.data.snapshot_id);
      const runs = await tx.listEvalRecords('run', experimentId);
      const tasks = await Promise.all(snapshot.data.tasks.map(async task => ({ task, graders: await Promise.all(task.graders.map(g => tx.getEvalRecord('grader', g.id, g.version))), runs: await Promise.all(runs.filter(r => r.data.task.id === task.id).map(async run => ({ run, ...(task.qa ? { executions: await tx.listEvalRecords('execution', run.id) } : {}), ...(run.data.artifact_id ? { artifact: await tx.getEvalRecord('artifact', run.data.artifact_id) } : {}), ...(run.data.result_id ? { result: await tx.getEvalRecord('result', run.data.result_id) } : {}) }))) })));
      const notices = (await tx.listEvalRecords('notice')).filter(n => snapshot.data.tasks.some(t => t.graders.some(g => same(g, n.data.grader))));
      const preparations = (await tx.listEvalRecords('preparation')).filter(p => p.data.experiment_ids.includes(experimentId));
      const attempts: EvalRecord<'preparation'>[] = [];
      for (const p of preparations) {
        const seen = new Set<number>();
        for (let v = 1; v <= p.version; v++) {
          const historical = await tx.getEvalRecord('preparation', p.id, v);
          if (['success','failed'].includes(historical.data.state) && !seen.has(historical.data.attempt)) {
            attempts.push(historical); seen.add(historical.data.attempt);
          }
        }
      }
      const instances = (await tx.listEvalRecords('instance')).filter(i => runs.some(r => r.id === i.data.run_id));
      const environment = experiment.data.environment ? {
        preparations, attempts, instances,
        // Only the explicit first consumer owns shared preparation cost.
        owned_preparation_duration_ms: attempts.filter(p => p.data.experiment_ids[0] === experimentId).reduce((n,p) => n+p.data.duration_ms,0),
        answers: tasks.flatMap(t => t.runs.filter(r => r.artifact).map(r => ({run_id:r.run.id, artifact_id:r.artifact!.id,
          provenance:r.artifact!.data.environment ? 'recorded' as const : 'unknown' as const,
          cost_attribution:r.run.data.mode === 'qa_regrade' ? 'original_answer' as const : 'this_run' as const,
          ...(r.artifact!.data.environment ? {reference:r.artifact!.data.environment} : {})})))
      } : undefined;
      return { format: 'patchledger.eval-report/v1' as const, experiment, snapshot, tasks, notices, ...(environment ? {environment} : {}) };
    });
  }
}
