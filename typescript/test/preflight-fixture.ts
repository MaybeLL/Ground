import { newUUIDv7 } from "../src/identity.js";
import { PreflightService, contentDigestFor, issueWriteBinding, type PublishBinding } from "../src/preflight.js";
import type { TargetBranch } from "../src/domain.js";
import type { Module, ReviseIssueCommand } from "../src/module.js";
import type { Store } from "../src/store-types.js";
import { ledgerOnlyPreflightCoordinator, testAgent } from "./fixture.js";
import { nextPreflightTransition, PREPARATION_FORMAT } from "../src/preflight-admission.js";

export { ledgerOnlyPreflightCoordinator };

/**
 * Seed the complete, already-valid admission a ledger-only fixture needs so its
 * real `submitCandidate` / `candidateSubmissionTemplate` / refinement writes
 * pass `assertDevRunAdmitted`. It records a start observation bound to the run's
 * symbolic inputs, an applicable assessment, and matching `input_binding`.
 * These zero-valued fingerprints stand in for an external observation only in
 * ledger-boundary tests; filesystem correctness is tested through the real CLI.
 * Any freshly recorded
 * preparation or sync supersedes it, so this is not a permanent bypass.
 */
export async function seedRunAdmission(store: Store, input: { devRunId: string }): Promise<{ observationId: string; assessmentId: string; admissionId: string }> {
  const observationId = newUUIDv7();
  const assessmentId = newUUIDv7();
  const admissionId = newUUIDv7();
  const now = new Date().toISOString();
  await store.write(async (tx) => {
    await tx.lockDevRun(input.devRunId);
    const run = await tx.getDevRun(input.devRunId);
    const revision = await tx.getIssueRevisionById(run.issue_revision_id);
    const issue = await tx.getIssue(revision.issue_id);
    const repository = await tx.getRepository(issue.repository_id);
    const target = revision.target_branch!;
    const base = run.base_commit ?? revision.baseline.git_oid;
    const parent = run.refines_candidate_id ? (await tx.getCandidate(run.refines_candidate_id)).candidate : undefined;
    const preparation = (await tx.listRuntimeRecords("runtime_operation", run.id)).filter(row => row.data.format === PREPARATION_FORMAT)
      .sort((a, b) => Number(b.data.transition_seq ?? 0) - Number(a.data.transition_seq ?? 0) || b.id.localeCompare(a.id))[0];
    const binds = {
      ...(preparation ? { preparation_id: preparation.id } : {}),
      repository_id: repository.id, canonical_remote: repository.canonical_remote,
      issue_id: issue.id, issue_version: revision.revision_number, issue_revision_id: revision.id,
      dev_run_id: run.id, dev_run_version: run.version, base_commit: base,
      ...(parent ? { parent_candidate_id: parent.id, parent_result_tree: parent.result_tree_oid, parent_patch_digest: parent.patch_digest } : {}),
      source_head: base, source_tree: base, input_digest: `sha256:${"0".repeat(64)}`, sync_digest: `sha256:${"0".repeat(64)}`, workspace_identity: `sha256:${"0".repeat(64)}`,
    };
    await tx.saveRuntimeRecord({ id: observationId, kind: "runtime_operation", parent_id: repository.id, version: 1, data: {
      format: "grounds.preflight-observation/v1", phase: "start", observed_at: now, target, tracking_ref: "",
      observation: { refreshed: true, observed_at: now, commit: { oid: base, parents: [], tree_oid: base } }, binds, attribution: testAgent,
    } }, 0);
    await tx.saveRuntimeRecord({ id: assessmentId, kind: "runtime_operation", parent_id: observationId, version: 1, data: {
      format: "grounds.preflight-assessment/v1", observation_id: observationId, assessment: "applicable", author: testAgent,
      rationale: "Ledger-only fixture: simulated reviewed input bindings", affected: [], assessed_at: now,
      assessment_seq: 1, binds, target_commit: base,
    } }, 0);
    await tx.saveRuntimeRecord({ id: admissionId, kind: "runtime_operation", parent_id: run.id, version: 1, data: {
      format: "grounds.preflight-admission/v1", dev_run_id: run.id, issue_revision_id: revision.id,
      observation_id: observationId, assessment_id: assessmentId, assessment: "applicable", target_commit: base, base_commit: base,
      definition_commit: revision.baseline.git_oid, transition_seq: await nextPreflightTransition(tx, run.id), input_binding: binds, admitted_at: now, attribution: testAgent,
    } }, 0);
  });
  return { observationId, assessmentId, admissionId };
}

/**
 * Establish the target-flow preflight a first start now requires: a refreshed
 * observation of the declared target, then an applicable assessment bound to
 * the observed commit. Tests not about the gate itself call this once in their
 * fixture so their real start stays a happy path.
 */
export async function establishPreflight(
  store: Store,
  repositoryRoot: string,
  input: { issueId: string; issueRevisionId: string; repositoryId: string },
): Promise<{ observationId: string; assessmentId: string }> {
  const service = new PreflightService(store, repositoryRoot);
  const observation = await service.observe({
    operation_id: newUUIDv7(),
    attribution: testAgent,
    phase: "start",
    refresh: true,
    repository_id: input.repositoryId,
    issue_id: input.issueId,
    issue_revision_id: input.issueRevisionId,
  });
  const assessment = await service.assess({
    operation_id: newUUIDv7(),
    attribution: testAgent,
    observation_id: observation.id,
    file: { assessment: "applicable", author: testAgent, rationale: "Reviewed the sealed contract against the refreshed target; still applicable", affected: [] },
  });
  return { observationId: observation.id, assessmentId: assessment.id };
}

/**
 * Establish the publish-phase preflight a target-Issue create/revise now needs.
 * It binds the exact declaration digest the Module gate re-checks, so the
 * fixture's real write stays a happy path.
 */
export async function establishPublishPreflight(
  store: Store,
  repositoryRoot: string,
  input: { repositoryId?: string; canonicalRemote: string; binding: PublishBinding; target: TargetBranch },
): Promise<{ observationId: string; assessmentId: string }> {
  const service = new PreflightService(store, repositoryRoot);
  const observation = await service.observe({
    operation_id: newUUIDv7(),
    attribution: testAgent,
    phase: "publish",
    refresh: true,
    ...(input.repositoryId ? { repository_id: input.repositoryId } : { canonical_remote: input.canonicalRemote }),
    target: input.target,
    content_digest: contentDigestFor(input.binding),
  });
  const assessment = await service.assess({
    operation_id: newUUIDv7(),
    attribution: testAgent,
    observation_id: observation.id,
    file: { assessment: "applicable", author: testAgent, rationale: "Reviewed the sealed declarations against the refreshed target; still applicable", affected: [] },
  });
  return { observationId: observation.id, assessmentId: assessment.id };
}

/**
 * A target-Issue `reviseIssue` preceded by the publish preflight its own write
 * binding requires. It computes the binding from the same command inputs so the
 * digest matches the Module gate exactly.
 */
export async function reviseTargetIssue(
  module: Module,
  store: Store,
  repositoryRoot: string,
  command: Omit<ReviseIssueCommand, "operation_id"> & { operation_id?: string },
): Promise<Awaited<ReturnType<Module["reviseIssue"]>>> {
  const predecessor = await module.currentIssueRevision(command.issue_id);
  const detail = await module.loadIssue(command.issue_id);
  const binding = issueWriteBinding({
    requirement_revision_id: command.requirement_revision_explicit ? command.requirement_revision_id : predecessor.requirement_revision_id,
    predecessor_requirement_revision_id: predecessor.requirement_revision_id,
    issue_id: command.issue_id,
    expected_predecessor_id: command.expected_predecessor_id,
    baseline_oid: command.baseline.git_oid,
    target_branch: command.input.target_branch,
    issue_input: command.input,
  });
  await establishPublishPreflight(store, repositoryRoot, { repositoryId: detail.repository.id, canonicalRemote: detail.repository.canonical_remote, binding, target: command.input.target_branch! });
  return module.reviseIssue({ ...command, operation_id: command.operation_id ?? newUUIDv7() });
}

/**
 * A target-Issue `reviseIssue` preceded by a seeded publish preflight. Tests
 * whose repository has no reachable remote use this: it records the same
 * refreshed-observation facts without needing network access.
 */
export async function reviseTargetIssueSeeded(
  module: Module,
  store: Store,
  command: Omit<ReviseIssueCommand, "operation_id"> & { operation_id?: string },
): Promise<Awaited<ReturnType<Module["reviseIssue"]>>> {
  const predecessor = await module.currentIssueRevision(command.issue_id);
  const detail = await module.loadIssue(command.issue_id);
  const requirementRevisionId = command.requirement_revision_explicit ? command.requirement_revision_id : predecessor.requirement_revision_id;
  const binding = issueWriteBinding({
    requirement_revision_id: requirementRevisionId,
    predecessor_requirement_revision_id: predecessor.requirement_revision_id,
    issue_id: command.issue_id,
    expected_predecessor_id: command.expected_predecessor_id,
    baseline_oid: command.baseline.git_oid,
    target_branch: command.input.target_branch,
    issue_input: command.input,
  });
  await seedPublishPreflight(store, {
    repositoryId: detail.repository.id,
    canonicalRemote: detail.repository.canonical_remote,
    contentDigest: contentDigestFor(binding),
    target: command.input.target_branch!,
    commit: command.baseline.git_oid,
  });
  return module.reviseIssue({ ...command, operation_id: command.operation_id ?? newUUIDv7() });
}

/**
 * Seed a durable, already-refreshed Issue-version start observation plus an
 * applicable assessment at `commit`, matching what `enforceStartGate` looks
 * for (`phase: "start"`, no `dev_run_id`, the Issue revision, the Repository
 * and the expected commit). For fixtures whose Module has no real worktree to
 * observe per-DevRun inputs, this expresses an existing legitimate analysis so
 * a first `startDevRun` exercises the gate's in-transaction binding checks.
 */
export async function seedStartPreflight(
  store: Store,
  input: { repositoryId: string; canonicalRemote: string; issueId: string; issueRevisionId: string; target: TargetBranch; commit: string },
): Promise<{ observationId: string; assessmentId: string }> {
  return seedPublishPreflight(store, { ...input, phase: "start" });
}

/**
 * Seed a durable, already-refreshed publish/start observation+assessment for a
 * pure SQL test with no Git repository, so its real write exercises the gate
 * with the same facts a real refresh would record.
 */
export async function seedPublishPreflight(
  store: Store,
  input: { repositoryId?: string; canonicalRemote: string; phase?: "publish" | "start"; issueId?: string; issueRevisionId?: string; contentDigest?: string; scopeDigest?: string; target: TargetBranch; commit: string },
): Promise<{ observationId: string; assessmentId: string }> {
  const observationId = newUUIDv7();
  const assessmentId = newUUIDv7();
  const now = new Date().toISOString();
  const binds = {
    ...(input.repositoryId ? { repository_id: input.repositoryId } : {}),
    canonical_remote: input.canonicalRemote,
    ...(input.issueId ? { issue_id: input.issueId } : {}),
    ...(input.issueRevisionId ? { issue_revision_id: input.issueRevisionId } : {}),
    ...(input.contentDigest ? { content_digest: input.contentDigest } : {}),
    ...(input.scopeDigest ? { scope_digest: input.scopeDigest } : {}),
  };
  await store.write(async (tx) => {
    await tx.saveRuntimeRecord({ id: observationId, kind: "runtime_operation", ...(input.repositoryId ? { parent_id: input.repositoryId } : {}), version: 1, data: {
      format: "grounds.preflight-observation/v1", phase: input.phase ?? "publish", observed_at: now, target: input.target, tracking_ref: "",
      observation: { refreshed: true, observed_at: now, commit: { oid: input.commit, parents: [], tree_oid: input.commit } }, binds, attribution: testAgent,
    } }, 0);
    await tx.saveRuntimeRecord({ id: assessmentId, kind: "runtime_operation", parent_id: observationId, version: 1, data: {
      format: "grounds.preflight-assessment/v1", observation_id: observationId, assessment: "applicable", author: testAgent, rationale: "Fixture assessment", affected: [], assessed_at: now, binds, target_commit: input.commit,
    } }, 0);
  });
  return { observationId, assessmentId };
}
