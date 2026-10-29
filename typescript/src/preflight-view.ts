import { getCurrentAdmission, PREPARATION_FORMAT } from "./preflight-admission.js";
import { assessmentData, latestAssessment, observationData } from "./preflight-records.js";
import { OBSERVATION_FORMAT, type DevRunPreflight } from "./preflight-types.js";
import type { Tx } from "./store-types.js";

export async function devRunPreflightView(tx: Tx, devRunId: string): Promise<DevRunPreflight | undefined> {
  const run = await tx.getDevRun(devRunId);
  const revision = await tx.getIssueRevisionById(run.issue_revision_id);
  if (!revision.target_branch) return undefined;
  const issue = await tx.getIssue(revision.issue_id);
  const base = run.base_commit ?? revision.baseline.git_oid;
  const required = { repository_id: issue.repository_id, issue_id: issue.id, issue_version: revision.revision_number, target: revision.target_branch, base_commit: base };
  const records = await tx.listRuntimeRecords("runtime_operation", devRunId);
  const preparing = records.some(row => row.data.format === PREPARATION_FORMAT);
  const commands = [`grounds preflight observe --phase start --dev-run ${devRunId} --refresh`];
  const blocked = (code: string, summary: string, next = commands): DevRunPreflight => ({
    state: preparing ? "preparing" : "missing", code, summary, blocking: [{ code, detail: summary }], required_inputs: required, next_commands: next,
  });
  const admission = await getCurrentAdmission(tx, devRunId);
  if (admission) {
    const assessmentRow = await tx.getRuntimeRecord("runtime_operation", String(admission.data.assessment_id));
    const observationRow = await tx.getRuntimeRecord("runtime_operation", String(admission.data.observation_id));
    if (!assessmentRow || !observationRow) return blocked("input_mismatch", "准入来源缺失，需要重新核对");
    const assessed = assessmentData(assessmentRow), observed = observationData(observationRow);
    return { state: "admitted", code: "admitted", summary: "本轮已记录有效准入；不代表远端最新或候选验证通过", blocking: [],
      required_inputs: { ...required, observed_commit: String(admission.data.target_commit) }, next_commands: [],
      observation: { observation_id: observationRow.id, target_commit: String(admission.data.target_commit), observed_at: observed.observed_at },
      assessment: { assessment_id: assessmentRow.id, assessment: assessed.assessment, author: assessed.author, rationale: assessed.rationale, assessed_at: assessed.assessed_at },
      admission: { admitted_at: String(admission.data.admitted_at), target_commit: String(admission.data.target_commit), base_commit: String(admission.data.base_commit) },
    };
  }
  const observedRows = (await tx.listRuntimeRecords("runtime_operation", issue.repository_id))
    .filter(row => row.data.format === OBSERVATION_FORMAT)
    .filter(row => { const value = observationData(row); return value.phase === "start" && value.binds.issue_revision_id === revision.id && value.binds.dev_run_id === run.id; })
    .sort((a, b) => String(b.data.observed_at).localeCompare(String(a.data.observed_at)) || b.id.localeCompare(a.id));
  const observedRow = observedRows[0];
  if (!observedRow) return blocked("no_observation", "缺少本轮实际工作输入与目标的预检观察");
  const observation = observationData(observedRow);
  if (!observation.observation.refreshed || !observation.observation.commit || observation.observation.failure) return blocked("unrefreshed_observation", "最近一次观察没有成功刷新目标");
  if (observation.observation.commit.oid !== base) return blocked("stale_target", "目标已前进；先完成受控同步，再评估实际输入");
  const assessedRow = await latestAssessment(tx, observedRow.id);
  if (!assessedRow) return blocked("assessment_missing", "尚未评估本轮输入与目标的契约适用性", [
    ...commands, `grounds preflight assess --observation ${observedRow.id} --file assessment.json`,
  ]);
  const assessed = assessmentData(assessedRow);
  if (assessed.assessment !== "applicable") return blocked(`assessment_${assessed.assessment}`, assessed.rationale);
  return blocked("not_admitted", "已有适用性评估；正式准入仍需重新核对当前输入和目标", [
    `grounds devrun admit --dev-run ${run.id} --preflight ${assessedRow.id} --expected-version ${run.version} --refresh`,
  ]);
}
