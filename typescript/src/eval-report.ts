import type { EvalModule } from './eval-module.js';
type Report = Awaited<ReturnType<EvalModule['report']>>;
const quote = (s: string): string => s.split('\n').map(line => '> ' + line).join('\n');
export const renderEvalReport = (report: Report): string => {
  const lines = ['# Evaluation report', '', quote(report.experiment.data.subject.name), '', quote(report.experiment.data.subject.description), '', `Experiment: ${report.experiment.id}`, `Snapshot: ${report.snapshot.id} (suite version ${report.snapshot.data.suite.version})`, '', `Planned tasks: ${report.tasks.length}. Results below retain every run; no overall score is computed.`, ''];
  if (report.environment) {
    lines.push('## Environment execution', '', `Owned shared preparation: ${report.environment.owned_preparation_duration_ms} ms (each preparation attempt counted once).`, '');
    for (const p of report.environment.attempts) {
      lines.push(`Preparation: ${p.id}, attempt ${p.data.attempt}; ${p.data.state}; ${p.data.duration_ms} ms; cost owner ${p.data.experiment_ids[0]}.`);
      if (p.data.result?.error) lines.push(quote(`${p.data.result.error.stage}: ${p.data.result.error.message}`));
      for (const source of p.data.result?.sources ?? []) lines.push(quote(`Source: ${source.role} ${source.identity}; revision ${source.revision}${source.branch ? '; branch '+source.branch : ''}`));
    }
    for (const i of report.environment.instances) lines.push(`Instance: ${i.id}; run ${i.data.run_id}; ${i.data.role}; ${i.data.state}; validity ${i.data.validity}; release ${i.data.release}; setup increment ${i.data.duration_ms} ms.${i.data.reason ? ' '+i.data.reason : ''}`);
    lines.push('');
  }
  const revisions = new Set<string>();
  for (const task of report.tasks) for (const entry of task.runs) {
    const values = entry.artifact?.data.execution.observed.graph_revisions;
    if (Array.isArray(values)) for (const value of values) if (typeof value === 'string') revisions.add(value);
  }
  if (report.tasks.some(t => t.task.qa)) {
    lines.push(`Observed QA knowledge revisions: ${[...revisions].sort().join(', ') || 'unavailable'}.`);
    if (revisions.size > 1) lines.push('Knowledge revision drift: this experiment does not share one fixed observed knowledge revision.');
    lines.push('');
  }
  for (const notice of report.notices) lines.push(`Grader advisory: ${notice.data.grader.id} v${notice.data.grader.version} (${notice.created_at})`, '', quote(notice.data.reason), '');
  for (const entry of report.tasks) {
    lines.push('## Task', '', quote(entry.task.name), '', entry.task.qa ? `QA: ${entry.task.qa.id} v${entry.task.qa.version}` : `Issue: ${entry.task.issue.id} v${entry.task.issue.version}`, '');
    if (!entry.runs.length) lines.push('Not started.', '');
    for (const { run, result, artifact, executions } of entry.runs) {
      lines.push(`### Run ${run.id}`, '', `Mode: ${run.data.mode}. State: ${run.data.state}.`, '');
      if (artifact) {
        const a = artifact.data;
        if (report.environment) lines.push(`Original answer provenance: ${a.environment ? 'recorded' : 'unknown'}.`);
        if (a.metrics) lines.push(`Answer duration: ${a.metrics.duration_ms} ms; tokens: ${JSON.stringify(a.metrics.usage)} (${run.data.mode === 'qa_regrade' ? 'original answer; no new answering cost' : 'this answer'}).`);
 lines.push(`Artifact: ${artifact.id}`, `Answer input QA: ${a.qa.id} v${a.qa.version}`, `Answer execution: ${a.execution.status}; exit ${a.execution.exit_code}`, `Capture: ${a.capture.coverage}`, ...a.capture.limitations.map(x => `Capture limitation: ${x}`), '', 'Declared configuration:', '', quote(JSON.stringify(a.execution.declared)), '', 'Observed configuration:', '', quote(JSON.stringify(a.execution.observed)), '', 'Answer:', '', quote(a.answer || '(no answer)'), '', ...a.files.map(f => `Evidence: ${f.name} (${f.size} bytes; ${f.digest})`), '');
      }
      if (!result) { lines.push('Still open; no formal EvalResult.', ''); continue; }
      const r = result.data; const d = r.development_duration;
      if (r.answering_duration_ms !== undefined) lines.push(`Answering duration: ${r.answering_duration_ms} ms`);
      if (r.mode === 'qa_regrade') lines.push('Regrade: reuses the original answer and trace; not a new answering sample.');
      lines.push(`Result: ${result.id}`);
      if (!entry.task.qa) lines.push(`Candidate: ${r.candidate_id ?? 'none'}`, d.kind === 'unknown' ? `Development duration: unknown (${d.reason})` : `Development duration: ${d.duration_ms} ms (${d.kind}; DevRun ${d.source_dev_run_id})`);
      lines.push('');
      if (r.reason) lines.push(quote(r.reason), '');
      for (const item of r.graders) {
        const g = entry.graders.find(g => g.id === item.grader.id)!;
        lines.push(`#### Grader ${g.id} v${g.version}`, '', quote(g.data.name), '', quote(g.data.scope.kind === 'diagnostic' ? `Diagnostic: ${g.data.scope.name}` : `Criteria: ${g.data.scope.criterion_ids.join(', ')}`), '', `Type: ${g.data.definition.type}`, '', 'Definition limitations:', '', quote(g.data.limitations), '');
        if (entry.task.qa) {
          const evidence = executions?.find(e => e.id === item.execution_id)?.data.grading_evidence;
          if (evidence?.metrics) lines.push(`Grading duration: ${evidence.metrics.duration_ms} ms; tokens: ${JSON.stringify(evidence.metrics.usage)}.`);
          if (evidence) lines.push(`Grading session: ${evidence.execution.session_id}`, `Grading duration: ${Date.parse(evidence.execution.finished_at) - Date.parse(evidence.execution.started_at)} ms`, `Grading capture: ${evidence.capture.coverage}`, ...evidence.capture.limitations.map(x => `Grading capture limitation: ${x}`), '', 'Grading declared configuration:', '', quote(JSON.stringify(evidence.execution.declared)), '', 'Grading observed configuration:', '', quote(JSON.stringify(evidence.execution.observed)), '', ...evidence.files.map(f => `Grading evidence: ${f.name} (${f.size} bytes; ${f.digest})`), `Export: grounds eval grader evidence-export ${item.execution_id} --out NEW_DIRECTORY`, '');
          else lines.push('Grading execution evidence: unavailable (not attached).', '');
        }
        const s = item.submission;
        if (!s) { lines.push(`Missing: ${item.missing_reason}`, ''); continue; }
        const o = s.outcome;
        lines.push(`Execution: ${s.status}`, o?.kind === 'decision' || o?.kind === 'qa_decision' ? `Verdict: ${o.verdict}` : o?.kind === 'score' ? `Score: ${o.value}` : o?.kind === 'inconclusive' ? `Inconclusive: ${o.reason}` : 'No quality judgment.', '');
        const spec = g.data.result_spec;
        if (spec.kind === 'score') lines.push(`Scale: ${spec.min}–${spec.max}; higher is ${spec.higher_is_better ? 'better' : 'worse'}.`, '', quote(spec.rubric), '');
        lines.push(quote(s.explanation), '');
        for (const e of s.evidence) lines.push(`Evidence (${e.kind}):`, '', quote(e.content), '');
      }
    }
  }
  return lines.join('\n') + '\n';
};
