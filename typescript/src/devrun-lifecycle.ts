import { validateModeSelection } from "./development-mode.js";
import { canonicalBytes } from './canonical-json.js';
import type { Attribution, DevRun, IssueRevision, RequirementRevision } from './domain.js';
import { DomainError } from './errors.js';
import { newUUIDv7 } from './identity.js';
import type { DevRunContext, RefinementContext } from './module.js';
import { issueVersionForContext, requirementVersionForContext } from './projections.js';
import type { Tx } from './store-types.js';

export const validateContextSize = (context: unknown): void => {
  if (canonicalBytes(context).length > 8 * 1024 * 1024) {
    throw new DomainError('ARTIFACT_TOO_LARGE', 'serialized context exceeds 8 MiB', false, { reason: 'context cannot be delivered to an Agent' });
  }
};
interface LifecycleActor { operation_id: string; attribution: Attribution }
interface StartInput extends LifecycleActor {
  execution_mode?: DevRun["execution_mode"];
  artifact_restoration?: DevRun["artifact_restoration"];
  development?: import("./development-branch.js").DevelopmentIdentity;
  id: string;
  base_commit?: string;
  issue_revision: IssueRevision;
  requirement_revision: RequirementRevision;
  repository_id: string;
  repository_remote_snapshot: string;
  exploration_brief?: string;
  refines_candidate_id?: string;
  refinement?: RefinementContext;
}

/** Called inside the owning operation's transaction; never commits independently. */
export async function startDevRunInTransaction(tx: Tx, input: StartInput, newId = newUUIDv7): Promise<DevRunContext> {
  if (input.execution_mode !== undefined) validateModeSelection(input.execution_mode);
  const now = await tx.now();
  const run: DevRun = {
    ...(input.execution_mode ? { execution_mode: input.execution_mode } : {}),
    ...(input.development ? { initial_base_commit: input.base_commit ?? input.issue_revision.baseline.git_oid } : {}), ...(input.artifact_restoration ? { artifact_restoration: input.artifact_restoration } : {}), ...(input.development ? { development: input.development } : {}), id: input.id, issue_revision_id: input.issue_revision.id, version: 1, state: 'open',
    repository_remote_snapshot: input.repository_remote_snapshot, created_at: now, attribution: input.attribution,
    ...(input.base_commit ? { base_commit: input.base_commit } : {}),
    ...(input.exploration_brief === undefined ? {} : { exploration_brief: input.exploration_brief }),
    ...(input.refines_candidate_id === undefined ? {} : { refines_candidate_id: input.refines_candidate_id }),
  };
  const context: DevRunContext = {
    format: 'patchledger.devrun-context/v1', generated_at: now,
    dev_run: { ...(run.execution_mode ? { execution_mode: run.execution_mode } : {}), ...(run.initial_base_commit ? { initial_base_commit: run.initial_base_commit } : {}), ...(run.artifact_restoration ? { artifact_restoration: run.artifact_restoration } : {}), ...(run.development ? { development: run.development } : {}), id: run.id, version: run.version, state: run.state, ...(run.exploration_brief === undefined ? {} : { exploration_brief: run.exploration_brief }) },
    repository: { id: input.repository_id, canonical_remote: run.repository_remote_snapshot },
    baseline: input.issue_revision.baseline,
    ...(run.base_commit ? { base_commit: run.base_commit } : {}),
    requirement: requirementVersionForContext(input.requirement_revision),
    issue: issueVersionForContext(input.issue_revision, input.requirement_revision),
    ...(input.refinement ? { refinement: input.refinement } : {}),
  };
  validateContextSize(context);
  await tx.createDevRun({ dev_run: run });
  if (input.refines_candidate_id !== undefined && input.refinement) {
    await tx.createDevRunRefinementVerifications(run.id, input.refinement.frozen_verifications.map(v => v.verification_id));
  }
  await tx.appendLedgerEvent({
    event_id: newId(), event_type: 'devrun.started', event_version: 1, operation_id: input.operation_id,
    subject_type: 'dev_run', subject_id: run.id, repository_id: input.repository_id, subject_version: run.version,
    occurred_at: now, attribution: input.attribution,
    facts: [...(run.execution_mode ? [{ name: 'execution_mode', value: JSON.stringify(run.execution_mode) }] : []), { name: 'issue_id', value: input.issue_revision.issue_id }, { name: 'issue_revision_id', value: input.issue_revision.id }, ...(input.development ? [{ name: 'development', value: JSON.stringify(input.development) }] : []), ...(input.artifact_restoration ? [{ name: 'artifact_restoration', value: JSON.stringify(input.artifact_restoration) }] : []), ...(run.initial_base_commit ? [{ name: 'initial_base_commit', value: run.initial_base_commit }] : [])],
  });
  return context;
}

export async function abandonDevRunInTransaction(tx: Tx, input: LifecycleActor & { dev_run_id: string; expected_version: number; reason?: string }, newId = newUUIDv7): Promise<{ run: DevRun; finished_at: string }> {
  const run = await tx.abandonDevRun(input.dev_run_id, input.expected_version, input.reason);
  const revision = await tx.getIssueRevisionById(run.issue_revision_id);
  const issue = await tx.getIssue(revision.issue_id);
  const finished_at = await tx.now();
  await tx.appendLedgerEvent({
    event_id: newId(), event_type: 'devrun.abandoned', event_version: 1, operation_id: input.operation_id,
    subject_type: 'dev_run', subject_id: run.id, repository_id: issue.repository_id, subject_version: run.version,
    occurred_at: finished_at, attribution: input.attribution,
    facts: [{ name: 'reason_present', value: input.reason !== undefined ? 'true' : 'false' }],
  });
  return { run, finished_at };
}
