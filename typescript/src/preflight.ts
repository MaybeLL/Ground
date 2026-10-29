import { canonicalBytes, sha256 } from "./canonical-json.js";
import { validateAttribution, type Attribution, type TargetBranch } from "./domain.js";
import { validation, DomainError } from "./errors.js";
import { isGitOID, isUUIDv7 } from "./identity.js";
import { observeBranch } from "./integration-observation.js";
import { validateTargetBranch } from "./target-branch.js";
import type { RuntimeRecord } from "./runtime-record.js";
import { runtimeGet } from "./runtime-record.js";
import type { Store, Tx } from "./store-types.js";
import { ADMISSION_FORMAT, PREPARATION_FORMAT, nextPreflightTransition } from "./preflight-admission.js";
import { capturePreflightInputs, withPreflightInputs, withPreflightScene, type PreflightRunInputs } from "./preflight-inputs.js";
import { devRunPreflightView } from "./preflight-view.js";
import { assessmentData, observationData, cleanPreflight as clean, preflightConflict as conflict, preflightReplay, savePreflightOperation, enforcePublishGate, enforceStartGate, latestAssessment } from "./preflight-records.js";
import { ASSESSMENT_FORMAT, OBSERVATION_FORMAT, type ObserveInput, type AssessInput, type AdmitInput, type PreflightActor, type PreflightObservationBinds, type PreflightObservationData, type PreflightAssessmentData, type PreflightAdmissionData, type PublishGateInput, type StartGateInput, type PreflightCoordinator, type PreflightMatch, type DevRunPreflight } from "./preflight-types.js";
export * from "./preflight-types.js";
export * from "./preflight-bindings.js";
export { ADMISSION_FORMAT, PREPARATION_FORMAT, assessmentData, observationData, enforcePublishGate, enforceStartGate };

const TARGET_TYPES = new Set(["goal", "constraint", "criterion", "requirement", "outcome", "decision"]);
const actorCheck = (actor: PreflightActor): void => {
  if (!isUUIDv7(actor.operation_id)) throw validation("operation_id", "UUIDv7 required");
  validateAttribution(actor.attribution);
};
const same = (a: unknown, b: unknown): boolean => sha256(clean(a)) === sha256(clean(b));
const runBinding = (binds: PreflightObservationBinds): PreflightRunInputs => ({
  dev_run_id: binds.dev_run_id!, dev_run_version: binds.dev_run_version!, base_commit: binds.base_commit!,
  ...(binds.parent_candidate_id ? { parent_candidate_id: binds.parent_candidate_id, parent_result_tree: binds.parent_result_tree!, parent_patch_digest: binds.parent_patch_digest! } : {}),
  ...(binds.preparation_id ? { preparation_id: binds.preparation_id } : {}),
  source_head: binds.source_head!, source_tree: binds.source_tree!, input_digest: binds.input_digest!,
  sync_digest: binds.sync_digest!, workspace_identity: binds.workspace_identity!,
});

export async function savePreparation(tx: Tx, id: string, devRunId: string, attribution: Attribution): Promise<RuntimeRecord> {
  await tx.lockDevRun(devRunId);
  const row: RuntimeRecord = { id, kind: "runtime_operation", parent_id: devRunId, version: 1,
    data: { format: PREPARATION_FORMAT, dev_run_id: devRunId, transition_seq: await nextPreflightTransition(tx, devRunId), prepared_at: await tx.now(), attribution } };
  await tx.saveRuntimeRecord(row, 0);
  return row;
}
export async function saveAdmission(tx: Tx, id: string, devRunId: string, match: PreflightMatch,
  attribution: Attribution, inputs?: PreflightRunInputs): Promise<RuntimeRecord> {
  await tx.lockDevRun(devRunId);
  const run = await tx.getDevRun(devRunId), revision = await tx.getIssueRevisionById(run.issue_revision_id);
  const assessed = assessmentData(await runtimeGet(tx, "runtime_operation", match.assessment_id));
  const observed = observationData(await runtimeGet(tx, "runtime_operation", match.observation_id));
  const latest = await latestAssessment(tx, match.observation_id);
  const base = run.base_commit ?? revision.baseline.git_oid;
  if (latest?.id !== match.assessment_id || assessed.assessment !== "applicable" || assessed.observation_id !== match.observation_id
    || observed.phase !== "start" || observed.binds.issue_revision_id !== revision.id || assessed.target_commit !== base
    || !observed.observation.refreshed || observed.observation.commit?.oid !== base || match.target_commit !== base) conflict("admission inputs no longer match the checked assessment");
  const data: PreflightAdmissionData = { format: ADMISSION_FORMAT, dev_run_id: run.id, issue_revision_id: revision.id,
    observation_id: match.observation_id, assessment_id: match.assessment_id, assessment: "applicable", target_commit: base,
    base_commit: base, definition_commit: revision.baseline.git_oid, transition_seq: await nextPreflightTransition(tx, run.id),
    ...(inputs ? { input_binding: inputs } : {}), admitted_at: await tx.now(), attribution };
  const record: RuntimeRecord = { id, kind: "runtime_operation", parent_id: run.id, version: 1, data: clean(data) as unknown as Record<string, unknown> };
  await tx.saveRuntimeRecord(record, 0);
  return record;
}

export class PreflightService {
  constructor(private readonly store: Store, private readonly repositoryRoot: string) {}

  private async resolve(input: ObserveInput | { repository_id?: string; canonical_remote?: string; issue_id?: string; issue_revision_id?: string; target?: TargetBranch; dev_run_id?: string }) {
    return this.store.read(async tx => {
      const run = input.dev_run_id ? await tx.getDevRun(input.dev_run_id) : undefined;
      const revision = run ? await tx.getIssueRevisionById(run.issue_revision_id)
        : input.issue_id ? input.issue_revision_id ? await tx.getIssueRevision(input.issue_id, input.issue_revision_id) : await tx.getCurrentIssueRevision(input.issue_id) : undefined;
      const issue = revision ? await tx.getIssue(revision.issue_id) : undefined;
      if (input.issue_id && issue && input.issue_id !== issue.id) throw validation("issue", "does not match the DevRun");
      if (input.issue_revision_id && revision && input.issue_revision_id !== revision.id) throw validation("issue-version", "does not match the DevRun");
      if (input.repository_id && issue && input.repository_id !== issue.repository_id) throw validation("repository", "does not match the Issue");
      const requestedRepository = issue?.repository_id ?? input.repository_id;
      const found = requestedRepository ? await tx.getRepository(requestedRepository) : input.canonical_remote
        ? await tx.findRepositoryByRemote(input.canonical_remote).catch(error => {
          if (error instanceof DomainError && error.code === "NOT_FOUND") return undefined;
          throw error;
        }) : undefined;
      const canonical = found?.canonical_remote ?? input.canonical_remote;
      if (!canonical) throw validation("repository", "registered Repository or canonical remote required");
      const target = revision?.target_branch ?? input.target;
      if (!target || (revision && !revision.target_branch)) throw validation("target_branch", "a declared target flow is required");
      if (input.target && !same(target, input.target)) throw validation("target_branch", "does not match the sealed target");
      const remotes = found ? (await tx.listRepositoryRemotes(found.id)).map(value => value.remote) : [canonical];
      return { repositoryId: found?.id, canonical, remotes, target, run, revision, issue };
    });
  }

  async observe(input: ObserveInput): Promise<RuntimeRecord> {
    input = structuredClone(input);
    actorCheck(input);
    if (!["definition", "publish", "start"].includes(input.phase) || typeof input.refresh !== "boolean") throw validation("phase", "requires a valid phase and explicit refresh boolean");
    if (input.scope_digest !== undefined && !/^(sha256:)?[a-f0-9]{64}$/.test(input.scope_digest)) throw validation("scope_digest", "must be the reviewed Workspace version");
    if (input.content_digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(input.content_digest)) throw validation("content_digest", "must be a canonical content digest");
    if (input.dev_run_id && input.phase !== "start") throw validation("dev-run", "actual Run inputs are only valid for start observations");
    if (input.definition_commit !== undefined && !isGitOID(input.definition_commit)) throw validation("definition_commit", "qualified Git commit OID required");
    const replay = await preflightReplay(this.store, "preflight.observe", input); if (replay) return replay;
    const subject = await this.resolve(input);
    const before = input.dev_run_id ? await withPreflightInputs(this.store, this.repositoryRoot, input.dev_run_id, async binding => binding) : undefined;
    const observed = observeBranch(this.repositoryRoot, subject.target, subject.remotes, input.refresh);
    const persist = (binding?: PreflightRunInputs) => savePreflightOperation(this.store, "preflight.observe", input, async tx => {
      if (binding) {
        await tx.lockDevRun(binding.dev_run_id);
        const run = await tx.getDevRun(binding.dev_run_id);
        const revision = await tx.getIssueRevisionById(run.issue_revision_id);
        if (run.version !== binding.dev_run_version || (run.base_commit ?? revision.baseline.git_oid) !== binding.base_commit) conflict("DevRun changed during observation");
      }
      const binds: PreflightObservationBinds = clean({ repository_id: subject.repositoryId, canonical_remote: subject.canonical,
        issue_id: subject.issue?.id, issue_version: subject.revision?.revision_number, issue_revision_id: subject.revision?.id,
        scope_digest: input.scope_digest, content_digest: input.content_digest, ...binding });
      const reference = input.phase === "definition" ? observed.commit?.oid : input.definition_commit ?? subject.revision?.baseline.git_oid;
      const data: PreflightObservationData = { format: OBSERVATION_FORMAT, phase: input.phase, observed_at: observed.observed_at,
        target: subject.target, tracking_ref: validateTargetBranch(this.repositoryRoot, subject.target, subject.remotes),
        observation: { refreshed: observed.refreshed, observed_at: observed.observed_at, ...(observed.commit ? { commit: observed.commit } : {}), ...(observed.failure ? { failure: observed.failure } : {}) },
        ...(reference ? { definition_reference: { commit_oid: reference } } : {}), binds, attribution: input.attribution };
      return { id: input.operation_id, kind: "runtime_operation", ...(subject.repositoryId ? { parent_id: subject.repositoryId } : {}), version: 1, data: clean(data) as unknown as Record<string, unknown> };
    });
    if (!input.dev_run_id) return persist();
    return withPreflightInputs(this.store, this.repositoryRoot, input.dev_run_id, async binding => {
      if (!same(before, binding)) conflict("development inputs changed while refreshing the target");
      return persist(binding);
    });
  }

  async assess(input: AssessInput): Promise<RuntimeRecord> {
    input = structuredClone(input);
    actorCheck(input);
    if (!isUUIDv7(input.observation_id)) throw validation("observation_id", "UUIDv7 required");
    const file = input.file;
    if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).some(key => !["assessment", "author", "rationale", "affected"].includes(key))) throw validation("file", "requires an assessment object with supported fields");
    if (!["applicable", "revision_required", "unknown"].includes(file.assessment)) throw validation("assessment", "must be applicable, revision_required or unknown");
    if (file.author !== undefined) {
      validateAttribution(file.author);
      if (!canonicalBytes(file.author).equals(canonicalBytes(input.attribution))) throw validation("author", "must match the writing command attribution");
    }
    if (typeof file.rationale !== "string" || !file.rationale.trim() || file.rationale.length > 65536) throw validation("rationale", "requires substantive non-empty rationale within 65536 characters");
    if (file.affected !== undefined && (!Array.isArray(file.affected) || file.affected.length > 2000)) throw validation("affected", "must be an array of at most 2000 entries");
    const affected = (file.affected ?? []).map(entry => {
      const item = entry as Record<string, unknown>;
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["target_type", "target_id", "criterion_id", "note"].includes(key))) throw validation("affected", "invalid clause reference");
      if (typeof item.target_type !== "string" || !TARGET_TYPES.has(item.target_type) || !isUUIDv7(item.target_id)) throw validation("affected", "requires a supported target type and UUIDv7 identity");
      if (item.criterion_id !== undefined && !isUUIDv7(item.criterion_id)) throw validation("affected.criterion_id", "UUIDv7 required");
      if (typeof item.note !== "string" || !item.note.trim() || item.note.length > 4096) throw validation("affected.note", "non-empty note of at most 4096 characters required");
      return clean({ target_type: item.target_type, target_id: item.target_id, ...(item.criterion_id ? { criterion_id: item.criterion_id } : {}), note: item.note }) as PreflightAssessmentData["affected"][number];
    });
    return savePreflightOperation(this.store, "preflight.assess", input, async tx => {
      await tx.lockRuntimeRecord("runtime_operation", input.observation_id);
      const observed = observationData(await runtimeGet(tx, "runtime_operation", input.observation_id));
      const previous = await latestAssessment(tx, input.observation_id);
      const data: PreflightAssessmentData = { format: ASSESSMENT_FORMAT, observation_id: input.observation_id,
        assessment: file.assessment as PreflightAssessmentData["assessment"], author: input.attribution, rationale: file.rationale,
        affected, assessed_at: await tx.now(), assessment_seq: Number(previous?.data.assessment_seq ?? 0) + 1,
        binds: observed.binds, ...(observed.observation.commit ? { target_commit: observed.observation.commit.oid } : {}) };
      return { id: input.operation_id, kind: "runtime_operation", parent_id: input.observation_id, version: 1, data: clean(data) as unknown as Record<string, unknown> };
    });
  }

  async show(id: string): Promise<RuntimeRecord> {
    if (!isUUIDv7(id)) throw validation("id", "UUIDv7 required");
    return this.store.read(async tx => {
      const record = await runtimeGet(tx, "runtime_operation", id);
      if (![OBSERVATION_FORMAT, ASSESSMENT_FORMAT, ADMISSION_FORMAT, PREPARATION_FORMAT].includes(String(record.data.format))) throw validation("id", "is not a preflight record");
      return record;
    });
  }

  private async refreshMatch(match: PreflightMatch, refresh: boolean): Promise<PreflightMatch> {
    if (refresh !== true) conflict("explicit target refresh authorization is required; pass --refresh");
    const observed = observationData(await this.show(match.observation_id));
    const subject = await this.resolve({ repository_id: observed.binds.repository_id, canonical_remote: observed.binds.canonical_remote, target: observed.target });
    const current = observeBranch(this.repositoryRoot, subject.target, subject.remotes, true);
    if (!current.refreshed || current.failure || current.commit?.oid !== match.target_commit) conflict("target changed or could not be refreshed; observe the new target and re-evaluate before proceeding", { approved_commit: match.target_commit, observed_commit: current.commit?.oid ?? "unknown" });
    return { ...match, checked_at: current.observed_at };
  }

  coordinator(options: { refresh: boolean; assessment_id?: string }): PreflightCoordinator {
    options = { ...options };
    const run = async (kind: "publish" | "start", input: PublishGateInput | StartGateInput): Promise<PreflightMatch> => {
      input = structuredClone(input);
      const selected = options.assessment_id ? assessmentData(await this.show(options.assessment_id)) : undefined;
      const wanted = selected && selected.target_commit ? { observation_id: selected.observation_id, assessment_id: options.assessment_id!, target_commit: selected.target_commit } : undefined;
      if (options.assessment_id && !wanted) conflict("selected assessment has no successfully observed target");
      const checked = await this.store.read(tx => kind === "publish" ? enforcePublishGate(tx, input as PublishGateInput, wanted) : enforceStartGate(tx, input as StartGateInput, wanted));
      const match = await this.refreshMatch(checked, options.refresh);
      return match;
    };
    return { publish: input => run("publish", input), start: input => run("start", input) };
  }

  async admit(input: AdmitInput): Promise<{ record: RuntimeRecord; data: PreflightAdmissionData }> {
    input = structuredClone(input);
    actorCheck(input);
    if (!isUUIDv7(input.dev_run_id) || !isUUIDv7(input.assessment_id)) throw validation("preflight", "DevRun and assessment UUIDv7 required");
    if (input.expected_head !== undefined && !isGitOID(input.expected_head)) throw validation("expected-head", "qualified Git commit OID required");
    if (input.expected_version !== undefined && (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1)) throw validation("expected-version", "positive DevRun version required");
    const replay = await preflightReplay(this.store, "devrun.admit", input);
    if (replay) return { record: replay, data: replay.data as unknown as PreflightAdmissionData };
    const assessed = assessmentData(await this.show(input.assessment_id));
    const observed = observationData(await this.show(assessed.observation_id));
    if (observed.phase !== "start" || observed.binds.dev_run_id !== input.dev_run_id || !observed.binds.input_digest) conflict("admission requires an observation of this DevRun's actual inputs; use preflight observe --phase start --dev-run <id> --refresh");
    if (assessed.assessment !== "applicable" || !assessed.target_commit) conflict(`assessment is ${assessed.assessment}; cannot admit`);
    const match = await this.refreshMatch({ observation_id: assessed.observation_id, assessment_id: input.assessment_id, target_commit: assessed.target_commit }, input.refresh);
    return withPreflightInputs(this.store, this.repositoryRoot, input.dev_run_id, async (captured, path) => {
      if (!same(captured, runBinding(observed.binds))) conflict("actual development inputs changed after assessment; preserve them and observe again");
      if (input.expected_head && input.expected_head !== captured.source_head) conflict("expected HEAD differs from the preparation scene");
      if (input.expected_version !== undefined && input.expected_version !== captured.dev_run_version) conflict("expected DevRun version differs from the preparation scene");
      const record = await this.store.write(async tx => {
        const requestHash = sha256(clean(input));
        const completed = await tx.reserveOperation({ id: input.operation_id, command: "devrun.admit", request_hash: requestHash });
        if (completed) return runtimeGet(tx, "runtime_operation", input.operation_id);
        await tx.lockDevRun(input.dev_run_id);
        const actual = await capturePreflightInputs(tx, input.dev_run_id, path);
        if (!same(actual, captured)) conflict("development inputs changed during admission");
        const saved = await saveAdmission(tx, input.operation_id, input.dev_run_id, match, input.attribution, actual);
        await tx.completeOperation(input.operation_id, JSON.stringify({ format: "patchledger.cli/v1", ok: true, operation_id: input.operation_id,
          data: { result_type: "grounds.result.preflight-admission/v1", command: "devrun.admit", dev_run_id: input.dev_run_id, preflight: saved, admission: saved.data }, warnings: [] }));
        return saved;
      });
      return { record, data: record.data as unknown as PreflightAdmissionData };
    });
  }

  async markPreparing(input: PreflightActor & { dev_run_id: string }): Promise<RuntimeRecord> {
    input = structuredClone(input);
    actorCheck(input);
    const replay = await preflightReplay(this.store, "devrun.prepare", input); if (replay) return replay;
    return withPreflightScene(this.store, this.repositoryRoot, input.dev_run_id, () => this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: input.operation_id, command: "devrun.prepare", request_hash: sha256(clean(input)) });
      if (replay) return runtimeGet(tx, "runtime_operation", input.operation_id);
      await tx.lockDevRun(input.dev_run_id);
      const run = await tx.getDevRun(input.dev_run_id);
      if (run.state !== "open") conflict("only an open DevRun can prepare a new development round");
      if ((await tx.listRuntimeRecords("use", run.id)).some(row => row.data.state !== "released")) conflict("release bound runtime targets before preparing a new round");
      const record = await savePreparation(tx, input.operation_id, input.dev_run_id, input.attribution);
      await tx.completeOperation(input.operation_id, JSON.stringify({ format: "patchledger.cli/v1", ok: true, operation_id: input.operation_id,
        data: { result_type: "grounds.result.preflight-preparation/v1", command: "devrun.prepare", dev_run_id: input.dev_run_id, prepare_id: record.id }, warnings: [] }));
      return record;
    }));
  }

  requirePublish(input: PublishGateInput): Promise<PreflightMatch> { return this.store.read(tx => enforcePublishGate(tx, input)); }
  requireApplicable(input: StartGateInput): Promise<PreflightMatch> { return this.store.read(tx => enforceStartGate(tx, input)); }
  devRunReadModel(id: string): Promise<DevRunPreflight | undefined> { return this.store.read(tx => devRunPreflightView(tx, id)); }
  async issueHint(issueRevisionId: string, repositoryId: string) {
    return this.store.read(async tx => {
      const revision = await tx.getIssueRevisionById(issueRevisionId);
      const issue = await tx.getIssue(revision.issue_id);
      if (issue.repository_id !== repositoryId) throw validation("repository", "does not match the Issue");
      if (!revision.target_branch) return { required: false as const };
      return { required: true as const, state: "missing" as const, code: "preflight_required", next_commands: [
        `grounds preflight observe --phase start --issue ${revision.issue_id} --issue-version ${revision.revision_number} --refresh`,
      ] };
    });
  }
}
