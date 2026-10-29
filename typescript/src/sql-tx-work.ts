import { validateModeSelection } from "./development-mode.js";
import { assertSupportedCandidateArtifact, GIT_CANDIDATE_ARTIFACT_FORMAT, validateGitArtifactCandidateBinding, type GitArtifactResolver, type GitCommitArtifact } from "./git-artifact-storage.js";
import type { SQLClient } from "./sql-client.js";
import { validateDevelopment, validateSourceIdentity } from "./development-branch.js";
import {type RuntimeRecord} from "./runtime-record.js";
import {isSyncRecord, syncData, syncTerminal} from "./devrun-sync-record.js";
import {validateDeliveryLink} from "./delivery-link.js";






import {isGitOID, isSha256, isUUIDv7} from "./identity.js";
import {sha256} from "./canonical-json.js";
import {DomainError, notFound, storageTransient, validation, versionConflict, stateConflict} from "./errors.js";
import {validateCanonicalRemote} from "./git.js";





import {blindContextDigestMatches, requirementVersionForContext, blindIssueVersionForContext} from "./projections.js";
import {indexCandidateChanges, inspectChangeRationaleBindings} from "./change-index.js";
import {CANDIDATE_ARTIFACT_FORMAT, type Attribution, type Candidate, type CandidateArtifact, type ChangeRationaleInput, type DevRun, type IssueRevision, type SelfVerification, type Verification, type VerificationReportInput, validateCandidateSubmission, validateOptionalLongText, validateVerificationReport} from "./domain.js";
import {combinedVerdict, qualityOverallVerdict, validateQualityReviewReport, type QualityReviewReportInput} from "./quality-review.js";
import type {ArtifactBlob, CandidateArtifactRef, CandidateRecord, DevRunRecord, LedgerEvent, Store, VerificationRecord, VerificationSummaryItem} from "./store-types.js";

export const PROTOCOL_VERSION = 1;
export const REMOTE_NORMALIZATION_VERSION = 1;
export const MINIMUM_CLI_VERSION = "0.1.0";
const CLI_VERSION = "0.1.0";
import { asText, asOptionalText, asBuffer, json, parseJSON, isDuplicateKeyError, isMissingTableError, retryDelay, requireRow, parseAttribution, parseDate, timestampOrderKey, safeInteger, storedEvidence, evidenceColumns, verificationModeProjection, directoryModeProjection, decodeArtifactChunks, persistedArtifactError, persistedRecordError, persistedVerificationError, validateContiguousOrdinals, validatePersistedCandidateFiles, validatePersistedCandidateArtifact, validatePersistedVerificationCoverage, validatePersistedCandidateCoverage, storedLedgerFacts } from "./sql-shared.js";

import { SqlTxCore } from "./sql-tx-core.js";

import { standingFromCounts } from "./sql-shared.js";

export abstract class SqlTxWork extends SqlTxCore {
  constructor(client: SQLClient, readSnapshot = false, hasTargetBranches = true, protected readonly gitArtifactResolver?: GitArtifactResolver, protected readonly hasGitArtifacts = true) { super(client, readSnapshot, hasTargetBranches); }

  private async gitArtifactMetadata(candidateId: string): Promise<{ metadata: GitCommitArtifact; size: number }> {
    const row = await this.client.get<{ metadata_json: unknown; metadata_digest: unknown; patch_size: unknown }>("SELECT metadata_json, metadata_digest, patch_size FROM candidate_git_artifacts WHERE candidate_id = ?", [candidateId]);
    if (!row) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate Git artifact metadata is missing", false, { resource_id: candidateId });
    try {
      const metadata = parseJSON<GitCommitArtifact>(row.metadata_json);
      if (sha256(metadata) !== asText(row.metadata_digest)) throw new Error("metadata digest mismatch");
      return { metadata, size: safeInteger(row.patch_size, "candidate.patch_size") };
    } catch (error) { return persistedRecordError("candidate", candidateId, "stored Git artifact metadata is invalid", error); }
  }

  // Implemented in SqlTx (read side); createCandidate-era code calls it.
  abstract readArtifact(patchDigest: string): Promise<Buffer>;

  async createDevRun(record: DevRunRecord): Promise<void> {
    const run = record.dev_run;
    await this.client.run("INSERT INTO dev_runs (id, issue_revision_id, version, state, exploration_brief, refines_candidate_id, repository_remote_snapshot, abandon_reason, created_at, attribution_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [run.id, run.issue_revision_id, run.version, run.state, run.exploration_brief ?? null, run.refines_candidate_id ?? null, run.repository_remote_snapshot, run.abandon_reason ?? null, run.created_at, json(run.attribution)]);
    if (run.base_commit) await this.client.run("INSERT INTO dev_run_bases (dev_run_id, base_commit) VALUES (?, ?)", [run.id, run.base_commit]);
  }

  async createDevRunRefinementVerifications(devRunId: string, verificationIds: string[]): Promise<void> {
    for (const [ordinal, id] of verificationIds.entries()) await this.client.run("INSERT INTO dev_run_refinement_verifications (dev_run_id, verification_id, ordinal) VALUES (?, ?, ?)", [devRunId, id, ordinal]);
  }

  async lockCandidateVerifications(candidateId: string): Promise<void> {
    const suffix = this.client.dialect.forUpdate;
    requireRow(await this.client.get("SELECT id FROM candidates WHERE id = ?" + suffix, [candidateId]), "candidate", candidateId);
  }

  async getDeliveryLink(id: string, version?: number): Promise<import("./delivery-link.js").DeliveryLink> {
    const row = requireRow(await this.client.get(`SELECT v.record_json, v.record_digest, v.version, l.candidate_id, l.repository_id, l.commit_oid, l.version AS current_version, (SELECT MAX(h.version) FROM delivery_link_versions h WHERE h.link_id = l.id) AS latest_version, (SELECT COUNT(*) FROM delivery_link_versions h WHERE h.link_id = l.id) AS version_count FROM delivery_links l JOIN delivery_link_versions v ON v.link_id = l.id AND v.version = ${version === undefined ? "l.version" : "?"} WHERE l.id = ?`, version === undefined ? [id] : [version, id]), "delivery_link", id);
    try {
      const record = JSON.parse(asText(row.record_json)) as import("./delivery-link.js").DeliveryLink;
      validateDeliveryLink(record);
      if (version === undefined && (safeInteger(row.current_version, "delivery_link.version", 1) !== safeInteger(row.latest_version, "delivery_link.latest_version", 1) || Number(row.version_count) !== Number(row.latest_version))) throw new Error("Delivery link current pointer or version sequence is inconsistent");
      if (sha256(record) !== asText(row.record_digest) || record.id !== id || record.version !== Number(row.version) || record.candidate_id !== row.candidate_id || record.repository_id !== row.repository_id || record.commit_oid !== row.commit_oid) throw new Error("inconsistent record");
      return record;
    } catch { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Delivery link is inconsistent", false, { resource_id: id }); }
  }

  async historyCandidateIds(repositoryId: string, path: string, limit: number): Promise<string[]> {
    const bytes = Buffer.from(path);
    const rows = await this.client.all("SELECT DISTINCT c.id FROM candidates c JOIN issue_revisions ir ON ir.id = c.issue_revision_id JOIN issues i ON i.id = ir.issue_id JOIN candidate_files f ON f.candidate_id = c.id WHERE i.repository_id = ? AND (f.path_bytes = ? OR f.old_path_bytes = ?) ORDER BY c.id LIMIT ?", [repositoryId, bytes, bytes, limit]);
    return rows.map(row => asText(row.id));
  }

  async findDeliveryLink(candidateId: string, commit: string): Promise<import("./delivery-link.js").DeliveryLink | undefined> {
    const row = await this.client.get("SELECT id FROM delivery_links WHERE candidate_id = ? AND commit_oid = ?", [candidateId, commit]);
    return row ? this.getDeliveryLink(asText(row.id)) : undefined;
  }

  async listDeliveryLinks(repositoryId: string, limit: number): Promise<import("./delivery-link.js").DeliveryLink[]> {
    const rows = await this.client.all("SELECT id FROM delivery_links WHERE repository_id = ? ORDER BY id LIMIT ?", [repositoryId, limit]);
    return Promise.all(rows.map(row => this.getDeliveryLink(asText(row.id))));
  }

  async saveDeliveryLink(record: import("./delivery-link.js").DeliveryLink, expectedVersion: number): Promise<void> {
    if (expectedVersion === 0) {
      await this.client.run("INSERT INTO delivery_links (id, candidate_id, repository_id, commit_oid, version) VALUES (?, ?, ?, ?, ?)", [record.id, record.candidate_id, record.repository_id, record.commit_oid, record.version]);
    } else {
      const changed = await this.client.run("UPDATE delivery_links SET version = ? WHERE id = ? AND version = ?", [record.version, record.id, expectedVersion]);
      if (changed.changes !== 1) throw versionConflict("delivery_link", record.id, expectedVersion, (await this.getDeliveryLink(record.id)).version);
    }
    await this.client.run("INSERT INTO delivery_link_versions (link_id, version, record_digest, record_json) VALUES (?, ?, ?, ?)", [record.id, record.version, sha256(record), json(record)]);
  }

  async getDevRun(devRunId: string): Promise<DevRun> {
    const row = requireRow(await this.client.get<Record<string, unknown>>(`SELECT id, issue_revision_id, ${this.integerText("version")} AS version, state, exploration_brief, refines_candidate_id, repository_remote_snapshot, abandon_reason, created_at, attribution_json FROM dev_runs WHERE id = ?`, [devRunId]), "dev_run", devRunId);
    const resourceId = asText(row.id);
    try {
      const run: DevRun = { id: resourceId, issue_revision_id: asText(row.issue_revision_id), version: safeInteger(row.version, "version", 1), state: asText(row.state) as DevRun["state"], repository_remote_snapshot: asText(row.repository_remote_snapshot), created_at: parseDate(row.created_at), attribution: parseAttribution(row.attribution_json) };
      const base = this.hasTargetBranches ? await this.client.get<{ base_commit: unknown }>("SELECT base_commit FROM dev_run_bases WHERE dev_run_id = ?", [devRunId]) : undefined;
      if (base) { run.base_commit = asText(base.base_commit); if (!isGitOID(run.base_commit)) throw new Error("DevRun base commit is invalid"); }
      const developmentEvent = await this.client.get<{ facts_json: unknown }>("SELECT facts_json FROM ledger_events WHERE subject_type = 'dev_run' AND subject_id = ? AND event_type = 'devrun.started' ORDER BY event_seq LIMIT 1", [devRunId]);
      const mode = developmentEvent && storedLedgerFacts(developmentEvent.facts_json, devRunId).find(f => f.name === "execution_mode");
      if (mode) { const selection = JSON.parse(mode.value); validateModeSelection(selection); run.execution_mode = selection; }
      const development = developmentEvent && storedLedgerFacts(developmentEvent.facts_json, devRunId).find(f => f.name === "development");
      if (development) { run.development = JSON.parse(development.value); validateDevelopment(run.development!); }
      const initialBase = developmentEvent && storedLedgerFacts(developmentEvent.facts_json, devRunId).find(f => f.name === "initial_base_commit");
      if (initialBase) { if (!run.development || !isGitOID(initialBase.value)) throw new Error("initial development base is invalid"); run.initial_base_commit = initialBase.value; }
      if (run.development && !initialBase) throw new Error("managed branch round is missing its original development base");
      const restoration = developmentEvent && storedLedgerFacts(developmentEvent.facts_json, devRunId).find(f => f.name === "artifact_restoration");
      if (restoration) {
        const restored = JSON.parse(restoration.value);
        if (!run.development || restored.method !== "base_patch" || restored.source_history !== "not_reconstructed" || !isUUIDv7(restored.parent_candidate_id) || restored.parent_candidate_id !== asOptionalText(row.refines_candidate_id) || Object.keys(restored).sort().join(",") !== "method,parent_candidate_id,source_history") throw new Error("artifact restoration provenance is invalid");
        run.artifact_restoration = restored;
      }
      const brief = asOptionalText(row.exploration_brief); if (brief !== undefined) run.exploration_brief = brief;
      const parent = asOptionalText(row.refines_candidate_id); if (parent !== undefined) run.refines_candidate_id = parent;
      const reason = asOptionalText(row.abandon_reason); if (reason !== undefined) run.abandon_reason = reason;
      if (!isUUIDv7(run.id) || run.id !== devRunId || !isUUIDv7(run.issue_revision_id)) throw new Error("DevRun identifiers are invalid");
      if (run.state !== "open" && run.state !== "submitted" && run.state !== "abandoned") throw new Error("DevRun state is invalid");
      if (run.refines_candidate_id !== undefined) {
        if (!isUUIDv7(run.refines_candidate_id)) throw new Error("DevRun refinement parent is invalid");
        const parent = await this.client.get<{ id: unknown; issue_revision_id: unknown }>("SELECT id, issue_revision_id FROM candidates WHERE id = ?", [run.refines_candidate_id]);
        if (!parent || asText(parent.id) !== run.refines_candidate_id || asText(parent.issue_revision_id) !== run.issue_revision_id) throw new Error("DevRun refinement parent is missing or belongs to another IssueRevision");
      }
      validateCanonicalRemote(run.repository_remote_snapshot);
      validateOptionalLongText("exploration_brief", run.exploration_brief);
      validateOptionalLongText("abandon_reason", run.abandon_reason);
      // A DevRun stores the Repository remote that was visible when it was
      // started.  It may be an old alias after a Repository move, but it must
      // still belong to the Issue's Repository; otherwise a direct SQL edit
      // could make a valid-looking run point at another source identity.
      const issueRevision = await this.getIssueRevisionById(run.issue_revision_id);
      const issue = await this.getIssue(issueRevision.issue_id);
      if (issue.requirement_id !== issueRevision.requirement_id) throw new Error("DevRun IssueRevision belongs to another Requirement");
      if (run.base_commit && !issueRevision.target_branch) throw new Error("DevRun own base requires a target branch");
      const remotes = await this.readRepositoryRemotes(issue.repository_id);
      if (!remotes.some((remote) => remote.remote === run.repository_remote_snapshot)) throw new Error("DevRun remote snapshot is not a Repository remote");
      return run;
    } catch (error) {
      return persistedRecordError("dev_run", resourceId, "stored DevRun is invalid", error);
    }
  }

  async lockDevRun(devRunId: string): Promise<void> {
    // This row is the common fence, including an otherwise idle execution binding.
    // Locking reads below avoid an older MySQL repeatable-read snapshot after waiting.
    if (this.client.dialect.forUpdate) await this.client.get(`SELECT id FROM dev_runs WHERE id = ?${this.client.dialect.forUpdate}`, [devRunId]);
    else await this.client.run("UPDATE dev_runs SET version = version WHERE id = ?", [devRunId]);
  }

  protected async lockedRuntimeChildren(kind: string, parentId: string): Promise<RuntimeRecord[]> {
    const suffix = this.client.dialect.forUpdate;
    return (await this.client.all<Record<string, unknown>>("SELECT * FROM runtime_records WHERE kind = ? AND parent_id = ? ORDER BY id" + suffix, [kind, parentId])).map(row => this.runtimeRecord(row));
  }

  async assertDevRunNotSyncing(devRunId: string): Promise<void> {
    await this.lockDevRun(devRunId);
    const active = (await this.lockedRuntimeChildren("runtime_operation", devRunId)).find(row => isSyncRecord(row) && !syncTerminal(syncData(row)));
    if (active) throw new DomainError("STATE_CONFLICT", "DevRun sync is pending; explicitly complete or abandon sync first", false, { resource_id: devRunId, sync_id: active.id, reason_code: "recovery_required" });
  }

  async reserveDevRunSync(record: RuntimeRecord, expectedRunVersion: number): Promise<DevRun> {
    const sync = syncData(record);
    if (record.version !== 1 || sync.phase !== "reserved" || sync.run_version !== expectedRunVersion + 1) throw validation("sync", "a reservation must begin at the next DevRun version");
    await this.assertDevRunNotSyncing(sync.dev_run_id);
    const run = await this.getDevRun(sync.dev_run_id);
    if (run.version !== expectedRunVersion) throw versionConflict("dev_run", run.id, expectedRunVersion, run.version);
    if (run.state !== "open" || !run.base_commit || run.base_commit !== sync.original_base) throw stateConflict("dev_run", run.id, "sync requires an open target-flow DevRun at the recorded base; historical and pinned Eval flows cannot sync");
    const updated = await this.client.run("UPDATE dev_runs SET version = version + 1 WHERE id = ? AND version = ? AND state = 'open'", [run.id, expectedRunVersion]);
    if (updated.changes !== 1) throw versionConflict("dev_run", run.id, expectedRunVersion, run.version);
    await this.saveRuntimeRecord(record, 0);
    return { ...run, version: expectedRunVersion + 1 };
  }

  async finishDevRunSync(syncId: string, expectedSyncVersion: number, receiptDigest: string, decisions: { path: string; explanation: string }[], outcome: "completed" | "abandoned", attribution?: Attribution): Promise<DevRun> {
    const initial = await this.getRuntimeRecord("runtime_operation", syncId);
    if (!initial) throw notFound("sync", syncId);
    const initialData = syncData(initial);
    await this.lockDevRun(initialData.dev_run_id);
    const row = (await this.lockedRuntimeChildren("runtime_operation", initialData.dev_run_id)).find(r => r.id === syncId)!;
    if (!row || row.version !== expectedSyncVersion) throw versionConflict("sync", syncId, expectedSyncVersion, row?.version ?? 0);
    const sync = syncData(row), run = await this.getDevRun(sync.dev_run_id);
    if (sync.phase !== (outcome === "completed" ? "completing" : "abandoning")) throw stateConflict("sync", syncId, "local completion or restoration must be durably recorded before finalizing SQL");
    if (run.state !== "open" || run.version !== sync.run_version || run.base_commit !== sync.original_base) throw stateConflict("sync", syncId, "DevRun identity changed during sync; retain local recovery material");
    const updated = await this.client.run("UPDATE dev_runs SET version = version + 1 WHERE id = ? AND version = ? AND state = 'open'", [run.id, sync.run_version]);
    if (updated.changes !== 1) throw versionConflict("dev_run", run.id, sync.run_version, run.version);
    if (outcome === "completed") {
      const baseUpdate = await this.client.run("UPDATE dev_run_bases SET base_commit = ? WHERE dev_run_id = ? AND base_commit = ?", [sync.target, run.id, sync.original_base]);
      if (baseUpdate.changes !== 1) throw stateConflict("sync", syncId, "base changed during sync; recovery is required");
    }
    row.version++;
    row.data = { ...sync, phase: outcome, decisions, receipt_digest: receiptDigest, finished_at: await this.now(), finished_by: attribution ?? sync.attribution } as unknown as Record<string, unknown>;
    await this.saveRuntimeRecord(row, expectedSyncVersion);
    return { ...run, version: run.version + 1, base_commit: outcome === "completed" ? sync.target : sync.original_base };
  }

  async abandonDevRun(devRunId: string, expectedVersion: number, reason?: string): Promise<DevRun> {
    await this.assertDevRunNotSyncing(devRunId);
    const current = await this.getDevRun(devRunId);
    if (current.version !== expectedVersion) throw versionConflict("dev_run", devRunId, expectedVersion, current.version);
    if (current.state !== "open") throw stateConflict("dev_run", devRunId, "only an open DevRun can be abandoned");
    const result = await this.client.run("UPDATE dev_runs SET state = 'abandoned', version = version + 1, abandon_reason = ? WHERE id = ? AND version = ? AND state = 'open'", [reason ?? null, devRunId, expectedVersion]);
    if (result.changes !== 1) throw versionConflict("dev_run", devRunId, expectedVersion, current.version);
    return { ...current, state: "abandoned", version: current.version + 1, ...(reason === undefined ? {} : { abandon_reason: reason }) };
  }

  async putArtifact(artifact: ArtifactBlob): Promise<void> {
    throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "SQL patch artifact creation is unsupported; use a fixed Git Candidate", false, { patch_digest: artifact.patch_digest });
  }

  async putCandidateGitArtifact(candidateId: string, artifact: GitCommitArtifact): Promise<GitCommitArtifact> {
    const ref = await this.findCandidateArtifactRef({ candidate_id: candidateId });
    if (!ref) throw notFound("candidate", candidateId);
    const owner = requireRow(await this.client.get<{ repository_id: unknown; repository_remote_snapshot: unknown }>("SELECT i.repository_id, c.repository_remote_snapshot FROM candidates c JOIN issue_revisions r ON r.id = c.issue_revision_id JOIN issues i ON i.id = r.issue_id WHERE c.id = ?", [candidateId]), "candidate", candidateId);
    const baseCommit = ref.base_commit ?? (await this.getIssueRevisionById(ref.issue_revision_id)).baseline.git_oid;
    validateGitArtifactCandidateBinding(artifact, { id: candidateId, source: ref.source, base_commit: baseCommit, repository_remote_snapshot: asText(owner.repository_remote_snapshot), result_tree_oid: ref.result_tree_oid });
    if (artifact.binding.repository_id !== asText(owner.repository_id)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate archive Repository mismatch");
    if (ref.git_artifact) {
      // A resumed operation must freshly verify policy and remote objects, but
      // its new observation is not a new Candidate identity. Keep the first
      // persisted receipt and return that artifact to the operation result.
      const stored = ref.git_artifact;
      if (stored.format !== artifact.format || stored.generator_version !== artifact.generator_version || sha256(stored.binding) !== sha256(artifact.binding)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate archive identity is immutable; preserve its format, generator and binding");
      return stored;
    }
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Git Candidate archive metadata is missing; historical patch-only conversion is unsupported");
  }

  async createCandidate(record: CandidateRecord): Promise<void> {
    const candidate = record.candidate;
    assertSupportedCandidateArtifact(candidate.artifact_format, candidate.id);
    await this.assertDevRunNotSyncing(candidate.dev_run_id);
    validatePersistedCandidateArtifact(candidate, record.artifact, record.artifact.patch);
    if (candidate.artifact_format === GIT_CANDIDATE_ARTIFACT_FORMAT) {
      validateGitArtifactCandidateBinding(candidate.git_artifact!, { ...candidate, base_commit: candidate.base_commit ?? (await this.getIssueRevisionById(candidate.issue_revision_id)).baseline.git_oid });
      const owner = await this.client.get<{ repository_id: unknown }>("SELECT i.repository_id FROM issues i JOIN issue_revisions r ON r.issue_id = i.id WHERE r.id = ?", [candidate.issue_revision_id]);
      if (!owner || asText(owner.repository_id) !== candidate.git_artifact!.binding.repository_id) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate archive belongs to a different Repository");
    }
    await this.client.run("INSERT INTO candidates (id, dev_run_id, issue_revision_id, repository_remote_snapshot, submission_format, submission_explanation, patch_digest, result_tree_oid, artifact_format, blind_context_digest, created_at, attribution_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [candidate.id, candidate.dev_run_id, candidate.issue_revision_id, candidate.repository_remote_snapshot, candidate.submission.format, candidate.submission.explanation, candidate.patch_digest, candidate.result_tree_oid, candidate.artifact_format, candidate.blind_context_digest, candidate.created_at, json(candidate.attribution)]);
    if (candidate.git_artifact) await this.client.run("INSERT INTO candidate_git_artifacts (candidate_id, metadata_json, metadata_digest, patch_size) VALUES (?, ?, ?, ?)", [candidate.id, json(candidate.git_artifact), sha256(candidate.git_artifact), record.artifact.uncompressed_size]);
    if (candidate.base_commit) await this.client.run("INSERT INTO candidate_bases (candidate_id, base_commit) VALUES (?, ?)", [candidate.id, candidate.base_commit]);
    for (const [ordinal, file] of record.artifact.files.entries()) {
      await this.client.run("INSERT INTO candidate_files (candidate_id, ordinal, path_bytes, display_path, change_kind, old_path_bytes, old_mode, new_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [candidate.id, ordinal, Buffer.from(file.path_bytes, "base64"), file.display_path, file.change, file.old_path_bytes ? Buffer.from(file.old_path_bytes, "base64") : null, file.old_mode ?? null, file.new_mode ?? null]);
    }
    for (const claim of candidate.submission.claims) {
      await this.client.run("INSERT INTO candidate_claims (candidate_id, target_type, target_id, explanation) VALUES (?, ?, ?, ?)", [candidate.id, claim.target_type, claim.target_id, claim.explanation]);
      for (const criterion of claim.criteria) {
        await this.client.run("INSERT INTO candidate_claim_criteria (candidate_id, target_type, target_id, criterion_id, explanation, self_verification_json) VALUES (?, ?, ?, ?, ?, ?)", [candidate.id, claim.target_type, claim.target_id, criterion.criterion_id, criterion.explanation, criterion.self_verification ? json(criterion.self_verification) : null]);
        for (const [ordinal, evidence] of criterion.evidence.entries()) { const columns = evidenceColumns(evidence); await this.client.run("INSERT INTO candidate_evidence (candidate_id, target_type, target_id, criterion_id, ordinal, command, exit_code, output, output_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [candidate.id, claim.target_type, claim.target_id, criterion.criterion_id, ordinal, ...columns]); }
      }
    }
    if (candidate.submission.format === "patchledger.candidate-submission/v2") {
      for (const [ordinal, rationale] of candidate.submission.change_rationales.entries()) {
        await this.client.run("INSERT INTO candidate_change_rationales (candidate_id, ordinal, rationale_json) VALUES (?, ?, ?)", [candidate.id, ordinal, json(rationale)]);
      }
    }
  }

  async submitDevRun(devRunId: string, expectedVersion: number): Promise<DevRun> {
    await this.assertDevRunNotSyncing(devRunId);
    const current = await this.getDevRun(devRunId);
    if (current.version !== expectedVersion) throw versionConflict("dev_run", devRunId, expectedVersion, current.version);
    if (current.state !== "open") throw stateConflict("dev_run", devRunId, "only an open DevRun can submit a Candidate");
    const result = await this.client.run("UPDATE dev_runs SET state = 'submitted', version = version + 1 WHERE id = ? AND version = ? AND state = 'open'", [devRunId, expectedVersion]);
    if (result.changes !== 1) throw versionConflict("dev_run", devRunId, expectedVersion, current.version);
    return { ...current, state: "submitted", version: current.version + 1 };
  }

  async createVerification(record: VerificationRecord): Promise<void> {
    const verification = record.verification;
    await this.client.run("INSERT INTO verifications (id, candidate_id, result_tree_oid, blind_context_digest, overall_verdict, created_at, attribution_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [verification.id, verification.candidate_id, verification.result_tree_oid, verification.blind_context_digest, verification.overall_verdict, verification.created_at, json(verification.attribution)]);
    for (const target of record.report.assessments) for (const criterion of target.criteria) {
      await this.client.run("INSERT INTO verification_assessments (verification_id, target_type, target_id, criterion_id, independent_verdict, independent_explanation, reconciliation_relation, reconciliation_explanation, final_verdict, final_explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [verification.id, target.target_type, target.target_id, criterion.criterion_id, criterion.independent.verdict, criterion.independent.explanation, criterion.reconciliation.claim_relation, criterion.reconciliation.explanation, criterion.final.verdict, criterion.final.explanation]);
      for (const [ordinal, evidence] of criterion.independent.evidence.entries()) { const columns = evidenceColumns(evidence); await this.client.run("INSERT INTO verification_evidence (verification_id, target_type, target_id, criterion_id, ordinal, command, exit_code, output, output_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [verification.id, target.target_type, target.target_id, criterion.criterion_id, ordinal, ...columns]); }
    }
    if (record.quality) await this.client.run("INSERT INTO verification_quality_reviews (verification_id, rubric_version, overall_verdict, attribution_json, report_json) VALUES (?, ?, ?, ?, ?)", [verification.id, record.quality.report.rubric_version, qualityOverallVerdict(record.quality.report), json(record.quality.attribution), json(record.quality.report)]);
  }

  /** One row per Verification with its optional quality part joined in, so reading an ultra Verification costs no extra query.
   * Databases created before the quality table existed are read without the join. */
  protected async getVerificationRow(verificationId: string): Promise<Record<string, unknown> | undefined> {
    const columns = "v.id, v.candidate_id, v.result_tree_oid, v.blind_context_digest, v.overall_verdict, v.created_at, v.attribution_json";
    const plain = (): Promise<Record<string, unknown> | undefined> => this.client.get<Record<string, unknown>>(`SELECT ${columns} FROM verifications v WHERE v.id = ?`, [verificationId]);
    if (this.qualityTable === "absent") return plain();
    const joined = (): Promise<Record<string, unknown> | undefined> => this.client.get<Record<string, unknown>>(`SELECT ${columns}, q.verification_id AS quality_verification_id, q.rubric_version AS quality_rubric_version, q.overall_verdict AS quality_overall_verdict, q.attribution_json AS quality_attribution_json, q.report_json AS quality_report_json FROM verifications v LEFT JOIN verification_quality_reviews q ON q.verification_id = v.id WHERE v.id = ?`, [verificationId]);
    // Once the join has worked in this transaction the table is known to exist, so later reads
    // skip the savepoint that isolates a possible missing-table failure.
    if (this.qualityTable === "present") return joined();
    try {
      const row = await this.recoverable(joined);
      this.qualityTable = "present";
      return row;
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      this.qualityTable = "absent";
      return plain();
    }
  }

  /** Quality part of an ultra Verification, taken from the joined row; absent for normal mode and for databases created before it existed. */
  protected readQualityReview(verification: Verification, joined: Record<string, unknown>): VerificationRecord["quality"] {
    if (joined.quality_verification_id === null || joined.quality_verification_id === undefined) return undefined;
    const row = { rubric_version: joined.quality_rubric_version, overall_verdict: joined.quality_overall_verdict, attribution_json: joined.quality_attribution_json, report_json: joined.quality_report_json };
    try {
      const report = parseJSON<QualityReviewReportInput>(row.report_json);
      validateQualityReviewReport(report);
      if (report.candidate_id !== verification.candidate_id || report.result_tree_oid !== verification.result_tree_oid || report.blind_context_digest !== verification.blind_context_digest) throw new Error("quality review does not match its Verification");
      if (report.rubric_version !== asText(row.rubric_version) || qualityOverallVerdict(report) !== asText(row.overall_verdict)) throw new Error("stored quality verdict does not match its dimensions");
      return { report, attribution: parseAttribution(row.attribution_json) };
    } catch (error) { return persistedRecordError("verification", verification.id, "stored quality review is invalid", error); }
  }

  private async candidateFiles(candidateId: string): Promise<CandidateArtifact["files"]> {
    const files = await this.client.all<Record<string, unknown>>("SELECT ordinal, path_bytes, display_path, change_kind, old_path_bytes, old_mode, new_mode FROM candidate_files WHERE candidate_id = ? ORDER BY ordinal", [candidateId]);
    const artifactFiles = files.map((file) => ({ path_bytes: asBuffer(file.path_bytes).toString("base64"), display_path: asText(file.display_path), change: asText(file.change_kind), ...(file.old_path_bytes === null || file.old_path_bytes === undefined ? {} : { old_path_bytes: asBuffer(file.old_path_bytes).toString("base64") }), ...(file.old_mode === null || file.old_mode === undefined ? {} : { old_mode: asText(file.old_mode) }), ...(file.new_mode === null || file.new_mode === undefined ? {} : { new_mode: asText(file.new_mode) }) }));
    validatePersistedCandidateFiles(artifactFiles, candidateId, files.map((file) => file.ordinal));
    return artifactFiles;
  }

  /** Metadata and reports remain inspectable before an explicit archive fetch.
   * Historical patch-only rows fail explicitly before any artifact decoding. */
  protected async candidateMetadata(candidateId: string): Promise<{ candidate: Omit<Candidate, "submission"> & { submission: { explanation: string } }; exploration_brief?: string; refines_candidate_id?: string }> {
    const ref = await this.findCandidateArtifactRef({ candidate_id: candidateId });
    if (!ref) throw notFound("candidate", candidateId);
    assertSupportedCandidateArtifact(ref.artifact_format, candidateId);
    const row = requireRow(await this.client.get<Record<string, unknown>>("SELECT repository_remote_snapshot, submission_format, submission_explanation, blind_context_digest, created_at, attribution_json FROM candidates WHERE id = ?", [candidateId]), "candidate", candidateId);
    try {
      const run = await this.getDevRun(ref.dev_run_id);
      if (!isUUIDv7(candidateId) || !isUUIDv7(ref.dev_run_id) || !isUUIDv7(ref.issue_revision_id) || !isSha256(ref.patch_digest) || !isGitOID(ref.result_tree_oid)) throw new Error("Candidate metadata identifiers are invalid");
      const remote = asText(row.repository_remote_snapshot);
      const explanation = asText(row.submission_explanation);
      validateOptionalLongText("submission_explanation", explanation);
      if (!["patchledger.candidate-submission/v1", "patchledger.candidate-submission/v2"].includes(asText(row.submission_format))) throw new Error("Candidate submission format is invalid");
      if (run.refines_candidate_id === candidateId || run.state !== "submitted" || run.issue_revision_id !== ref.issue_revision_id || run.repository_remote_snapshot !== remote || !ref.source) throw new Error("Candidate owning development metadata is inconsistent");
      const revision = await this.getIssueRevisionById(ref.issue_revision_id);
      const issue = await this.getIssue(revision.issue_id);
      const requirement = await this.getRequirementRevision(issue.requirement_id, revision.requirement_revision_id);
      if (!ref.git_artifact || ref.git_artifact.binding.repository_id !== issue.repository_id) throw new Error("Candidate archive Repository mismatch");
      const files = await this.candidateFiles(candidateId);
      const blindDigest = asText(row.blind_context_digest);
      const subject = {
        format: ref.base_commit ? "patchledger.blind-subject/v2" : "patchledger.blind-subject/v1",
        ...(ref.base_commit ? { base_commit: ref.base_commit } : {}), candidate_id: candidateId,
        repository_id: issue.repository_id, baseline_oid: revision.baseline.git_oid,
        result_tree_oid: ref.result_tree_oid, patch_digest: ref.patch_digest, artifact_format: CANDIDATE_ARTIFACT_FORMAT,
        requirement: requirementVersionForContext(requirement), issue: blindIssueVersionForContext(revision, requirement),
        file_manifest: files.map(file => ({ path_bytes: file.path_bytes, change: file.change, ...(file.old_path_bytes === undefined ? {} : { old_path_bytes: file.old_path_bytes }), ...(file.old_mode === undefined ? {} : { old_mode: file.old_mode }), ...(file.new_mode === undefined ? {} : { new_mode: file.new_mode }) })),
      };
      if (!isSha256(blindDigest) || sha256(subject) !== blindDigest) throw new Error("Candidate blind identity does not match its metadata");
      return { candidate: { id: candidateId, dev_run_id: ref.dev_run_id, issue_revision_id: ref.issue_revision_id, repository_remote_snapshot: remote, source: ref.source, ...(ref.base_commit ? { base_commit: ref.base_commit } : {}), git_artifact: ref.git_artifact, patch_digest: ref.patch_digest, result_tree_oid: ref.result_tree_oid, artifact_format: ref.artifact_format, blind_context_digest: blindDigest, created_at: parseDate(row.created_at), attribution: parseAttribution(row.attribution_json), submission: { explanation } }, ...(run.exploration_brief ? { exploration_brief: run.exploration_brief } : {}), ...(run.refines_candidate_id ? { refines_candidate_id: run.refines_candidate_id } : {}) };
    } catch (error) { return persistedRecordError("candidate", candidateId, "stored Candidate metadata is invalid", error); }
  }

  async getCandidate(candidateId: string): Promise<CandidateRecord> {
    const row = requireRow(await this.client.get<Record<string, unknown>>(`SELECT c.id, c.dev_run_id, c.issue_revision_id, c.repository_remote_snapshot, c.submission_format, c.submission_explanation, c.patch_digest, c.result_tree_oid, c.artifact_format, c.blind_context_digest, c.created_at, c.attribution_json, d.issue_revision_id AS dev_issue_revision_id, d.state AS dev_run_state, d.repository_remote_snapshot AS dev_repository_remote_snapshot, d.exploration_brief, d.refines_candidate_id, ${this.integerText("b.uncompressed_size")} AS uncompressed_size, (SELECT ${this.integerText("e.event_seq")} FROM ledger_events e WHERE e.subject_type = 'candidate' AND e.subject_id = c.id AND e.event_type = 'candidate.submitted' ORDER BY e.event_seq LIMIT 1) AS ledger_event_seq FROM candidates c LEFT JOIN dev_runs d ON d.id = c.dev_run_id LEFT JOIN artifact_blobs b ON b.patch_digest = c.patch_digest WHERE c.id = ?`, [candidateId]), "candidate", candidateId);
    const resourceId = asText(row.id);
    assertSupportedCandidateArtifact(asText(row.artifact_format), resourceId);
    if (row.dev_run_id === null || row.dev_run_id === undefined) persistedArtifactError("Candidate DevRun is missing", resourceId);
    if (row.dev_issue_revision_id === null || row.dev_issue_revision_id === undefined || row.dev_run_state === null || row.dev_run_state === undefined || row.dev_repository_remote_snapshot === null || row.dev_repository_remote_snapshot === undefined) persistedArtifactError("Candidate DevRun binding is incomplete", resourceId);
    if (asText(row.dev_issue_revision_id) !== asText(row.issue_revision_id)) persistedArtifactError("Candidate belongs to a different IssueRevision than its DevRun", resourceId);
    if (asText(row.dev_run_state) !== "submitted") persistedArtifactError("Candidate DevRun is not submitted", resourceId);
    if (asText(row.dev_repository_remote_snapshot) !== asText(row.repository_remote_snapshot)) persistedArtifactError("Candidate remote snapshot does not match its DevRun", resourceId);
    if (asText(row.artifact_format) === CANDIDATE_ARTIFACT_FORMAT && (row.uncompressed_size === null || row.uncompressed_size === undefined)) persistedArtifactError("Candidate artifact is missing", resourceId);
    const submissionFormat = asText(row.submission_format);
    if (submissionFormat !== "patchledger.candidate-submission/v1" && submissionFormat !== "patchledger.candidate-submission/v2") persistedArtifactError("Candidate submission format is invalid", resourceId);
    const candidate: Candidate = { id: resourceId, dev_run_id: asText(row.dev_run_id), issue_revision_id: asText(row.issue_revision_id), repository_remote_snapshot: asText(row.repository_remote_snapshot), submission: { format: "patchledger.candidate-submission/v1", explanation: asText(row.submission_explanation), claims: [] }, patch_digest: asText(row.patch_digest), result_tree_oid: asText(row.result_tree_oid), artifact_format: asText(row.artifact_format), blind_context_digest: asText(row.blind_context_digest), created_at: parseDate(row.created_at), attribution: parseAttribution(row.attribution_json) };
    try {
      const base = this.hasTargetBranches ? await this.client.get<{ base_commit: unknown }>("SELECT base_commit FROM candidate_bases WHERE candidate_id = ?", [candidateId]) : undefined;
      if (base) { candidate.base_commit = asText(base.base_commit); if (!isGitOID(candidate.base_commit)) throw new Error("Candidate base commit is invalid"); }
      const sourceEvent = await this.client.get<{ facts_json: unknown }>("SELECT facts_json FROM ledger_events WHERE subject_type = 'candidate' AND subject_id = ? AND event_type = 'candidate.submitted' ORDER BY event_seq LIMIT 1", [candidateId]);
      const sourceFact = sourceEvent && storedLedgerFacts(sourceEvent.facts_json, candidateId).find(f => f.name === "development_source");
      if (sourceFact) {
        const source = JSON.parse(sourceFact.value);
        if (source.format !== "grounds.candidate-source/v1" || source.result_tree_oid !== candidate.result_tree_oid || source.patch_digest !== candidate.patch_digest || source.dev_run_id !== candidate.dev_run_id || Object.keys(source).sort().join(",") !== "commit,dev_run_id,format,parents,patch_digest,result_tree_oid") throw new Error("Candidate source is invalid or does not bind its SQL artifact");
        candidate.source = { commit: source.commit, parents: source.parents }; validateSourceIdentity(candidate.source!);
      }
      const ownerEvent = await this.client.get<{ facts_json: unknown }>("SELECT facts_json FROM ledger_events WHERE subject_type = 'dev_run' AND subject_id = ? AND event_type = 'devrun.started' ORDER BY event_seq LIMIT 1", [candidate.dev_run_id]);
      const ownerDevelopment = ownerEvent && storedLedgerFacts(ownerEvent.facts_json, candidate.dev_run_id).find(f => f.name === "development");
      if (ownerDevelopment) validateDevelopment(JSON.parse(ownerDevelopment.value));
      if (!candidate.source) throw new Error("Candidate requires a fixed Git source");
      if (!isUUIDv7(candidate.id) || candidate.id !== candidateId || !isUUIDv7(candidate.dev_run_id) || !isUUIDv7(candidate.issue_revision_id)) throw new Error("Candidate identifiers are invalid");
      validateCanonicalRemote(candidate.repository_remote_snapshot);
      if (!isSha256(candidate.patch_digest) || !isGitOID(candidate.result_tree_oid) || !isSha256(candidate.blind_context_digest)) throw new Error("Candidate artifact identifiers are invalid");
      if (candidate.artifact_format === GIT_CANDIDATE_ARTIFACT_FORMAT) {
        const git = await this.gitArtifactMetadata(candidate.id); candidate.git_artifact = git.metadata;
        validateGitArtifactCandidateBinding(git.metadata, { ...candidate, base_commit: candidate.base_commit ?? (await this.getIssueRevisionById(candidate.issue_revision_id)).baseline.git_oid });
        row.uncompressed_size = git.size;
        const owner = await this.client.get<{ repository_id: unknown }>("SELECT i.repository_id FROM issues i JOIN issue_revisions r ON r.issue_id = i.id WHERE r.id = ?", [candidate.issue_revision_id]);
        if (!owner || asText(owner.repository_id) !== git.metadata.binding.repository_id) throw new Error("Candidate archive Repository mismatch");
      }
      validateOptionalLongText("submission_explanation", candidate.submission.explanation);
    } catch (error) {
      return persistedRecordError("candidate", resourceId, "stored Candidate is invalid", error);
    }
    const artifactFiles = await this.candidateFiles(candidateId);
    let patch: Buffer;
    try {
      if (candidate.artifact_format === GIT_CANDIDATE_ARTIFACT_FORMAT) {
        if (!this.gitArtifactResolver) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate Git artifact requires locally available fixed objects; explicitly fetch its archive before loading code", false, { resource_id: candidate.id });
        const ref: CandidateArtifactRef = { candidate_id: candidate.id, dev_run_id: candidate.dev_run_id, issue_revision_id: candidate.issue_revision_id, patch_digest: candidate.patch_digest, result_tree_oid: candidate.result_tree_oid, artifact_format: candidate.artifact_format, source: candidate.source, base_commit: candidate.base_commit, git_artifact: candidate.git_artifact, patch_size: safeInteger(row.uncompressed_size, "candidate.patch_size") };
        const derived = await this.gitArtifactResolver(ref);
        validatePersistedCandidateArtifact(candidate, derived, derived.patch);
        if (sha256(derived.files) !== sha256(artifactFiles)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate Git artifact manifest differs from its immutable SQL manifest", false, { resource_id: candidate.id });
        patch = derived.patch;
      } else throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "Only Git Candidate artifacts are supported");
    } catch (error) {
      if (error instanceof DomainError && error.code === "NOT_FOUND") return persistedRecordError("candidate", resourceId, "stored Candidate artifact is missing", error);
      throw error;
    }
    const artifact: CandidateArtifact = { patch, patch_digest: candidate.patch_digest, result_tree_oid: candidate.result_tree_oid, uncompressed_size: safeInteger(row.uncompressed_size, "uncompressed_size"), files: artifactFiles };
    validatePersistedCandidateArtifact(candidate, artifact, artifact.patch);
    const claims = await this.client.all<{ target_type: unknown; target_id: unknown; explanation: unknown }>("SELECT target_type, target_id, explanation FROM candidate_claims WHERE candidate_id = ? ORDER BY target_type, target_id", [candidateId]);
    for (const claim of claims) {
      const criteria = await this.client.all<{ criterion_id: unknown; explanation: unknown; self_verification_json: unknown }>("SELECT criterion_id, explanation, self_verification_json FROM candidate_claim_criteria WHERE candidate_id = ? AND target_type = ? AND target_id = ? ORDER BY criterion_id", [candidateId, asText(claim.target_type), asText(claim.target_id)]);
      candidate.submission.claims.push({ target_type: asText(claim.target_type) as "goal" | "constraint", target_id: asText(claim.target_id), explanation: asText(claim.explanation), criteria: await Promise.all(criteria.map(async (criterion) => {
        const evidence = await this.client.all<Record<string, unknown>>(`SELECT ordinal, command, ${this.integerText("exit_code")} AS exit_code, output, output_digest FROM candidate_evidence WHERE candidate_id = ? AND target_type = ? AND target_id = ? AND criterion_id = ? ORDER BY ordinal`, [candidateId, asText(claim.target_type), asText(claim.target_id), asText(criterion.criterion_id)]);
        validateContiguousOrdinals(evidence.map((entry) => entry.ordinal), "candidate_evidence.ordinal", candidateId);
        let selfVerification: SelfVerification | undefined;
        try { if (criterion.self_verification_json != null) selfVerification = parseJSON(criterion.self_verification_json); }
        catch (error) { return persistedRecordError("candidate", resourceId, "invalid self-verification JSON", error); }
        return { criterion_id: asText(criterion.criterion_id), explanation: asText(criterion.explanation), ...(criterion.self_verification_json != null ? { self_verification: selfVerification } : {}), evidence: evidence.map((entry) => storedEvidence(entry, "candidate", candidateId)) };
      })) });
    }
    const rationaleRows = await this.client.all<{ ordinal: unknown; rationale_json: unknown }>("SELECT ordinal, rationale_json FROM candidate_change_rationales WHERE candidate_id = ? ORDER BY ordinal", [candidateId]);
    validateContiguousOrdinals(rationaleRows.map((entry) => entry.ordinal), "candidate_change_rationales.ordinal", candidateId);
    if (submissionFormat === "patchledger.candidate-submission/v1") {
      if (rationaleRows.length) persistedArtifactError("CandidateSubmission v1 contains Change Rationales", resourceId);
    } else {
      let rationales: ChangeRationaleInput[];
      try {
        rationales = rationaleRows.map((entry) => parseJSON<ChangeRationaleInput>(entry.rationale_json));
      } catch (error) {
        return persistedRecordError("candidate", resourceId, "stored Candidate Change Rationale is invalid", error);
      }
      const changeIndex = indexCandidateChanges(artifact);
      candidate.submission = {
        format: "patchledger.candidate-submission/v2",
        explanation: candidate.submission.explanation,
        claims: candidate.submission.claims,
        change_index: { format: changeIndex.format, patch_digest: changeIndex.patch_digest, units_digest: changeIndex.units_digest },
        change_rationales: rationales,
      };
    }
    try {
      validateCandidateSubmission(candidate.submission);
      const ownerBase = this.hasTargetBranches ? await this.client.get<{ base_commit: unknown }>("SELECT base_commit FROM dev_run_bases WHERE dev_run_id = ?", [candidate.dev_run_id]) : undefined;
      if (candidate.base_commit !== (ownerBase ? asText(ownerBase.base_commit) : undefined)) throw new Error("Candidate base does not match its owning DevRun");
      const issueRevision = await this.getIssueRevisionById(candidate.issue_revision_id);
      const issue = await this.getIssue(issueRevision.issue_id);
      const requirementRevision = await this.getRequirementRevision(issue.requirement_id, issueRevision.requirement_revision_id);
      const repository = await this.getRepository(issue.repository_id);
      const remotes = await this.readRepositoryRemotes(repository.id);
      if (!remotes.some((remote) => remote.remote === candidate.repository_remote_snapshot)) throw new Error("Candidate remote snapshot is not a Repository remote");
      validatePersistedCandidateCoverage(candidate.submission, issueRevision, resourceId);
      const rationaleInspection = inspectChangeRationaleBindings(candidate.submission, issueRevision, artifact);
      if (rationaleInspection.problems.length) throw new Error(rationaleInspection.problems.join("; "));
      const digestSource = {
        candidate_id: candidate.id,
        ...(candidate.base_commit ? { base_commit: candidate.base_commit } : {}),
        repository_id: repository.id,
        canonical_remote_at_submission: candidate.repository_remote_snapshot,
        result_tree_oid: candidate.result_tree_oid,
        patch_digest: candidate.patch_digest,
        requirement_revision: requirementRevision,
        issue_revision: issueRevision,
        artifact,
        submission: candidate.submission,
      };
      if (!blindContextDigestMatches(candidate.blind_context_digest, digestSource)) throw new Error("Candidate blind context digest does not match its immutable facts");
      validateOptionalLongText("exploration_brief", asOptionalText(row.exploration_brief));
      const parent = asOptionalText(row.refines_candidate_id);
      if (parent !== undefined && !isUUIDv7(parent)) throw new Error("Candidate refinement parent is invalid");
      if (parent !== undefined) {
        if (parent === candidate.id) throw new Error("Candidate refinement parent cannot be itself");
        const parentRow = await this.client.get<{ id: unknown; issue_revision_id: unknown }>("SELECT id, issue_revision_id FROM candidates WHERE id = ?", [parent]);
        if (!parentRow) throw new Error("Candidate refinement parent is missing");
        if (asText(parentRow.id) !== parent || asText(parentRow.issue_revision_id) !== candidate.issue_revision_id) throw new Error("Candidate refinement parent belongs to another IssueRevision");
      }
      if (row.ledger_event_seq !== null && row.ledger_event_seq !== undefined) safeInteger(row.ledger_event_seq, "ledger_event_seq", 1);
    } catch (error) {
      return persistedRecordError("candidate", resourceId, "stored Candidate submission is invalid", error);
    }
    return { candidate, artifact, exploration_brief: asOptionalText(row.exploration_brief), refines_candidate_id: asOptionalText(row.refines_candidate_id), ledger_event_seq: row.ledger_event_seq === null || row.ledger_event_seq === undefined ? undefined : safeInteger(row.ledger_event_seq, "ledger_event_seq", 1) };
  }

  async findCandidateArtifactRef(by: { candidate_id: string } | { dev_run_id: string }): Promise<CandidateArtifactRef | undefined> {
    const column = "candidate_id" in by ? "c.id" : "c.dev_run_id";
    const row = await this.client.get<Record<string, unknown>>(`SELECT c.id AS id, c.dev_run_id AS dev_run_id, c.issue_revision_id AS issue_revision_id, c.repository_remote_snapshot AS repository_remote_snapshot, c.patch_digest AS patch_digest, c.result_tree_oid AS result_tree_oid, c.artifact_format AS artifact_format, ${this.integerText("b.uncompressed_size")} AS patch_size FROM candidates c LEFT JOIN artifact_blobs b ON b.patch_digest = c.patch_digest WHERE ${column} = ?`, ["candidate_id" in by ? by.candidate_id : by.dev_run_id]);
    if (!row) return undefined;
    assertSupportedCandidateArtifact(asText(row.artifact_format), asText(row.id));
    const base = this.hasTargetBranches ? await this.client.get<{ base_commit: unknown }>("SELECT base_commit FROM candidate_bases WHERE candidate_id = ?", [asText(row.id)]) : undefined;
    if (base && !isGitOID(asText(base.base_commit))) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate base commit is invalid", false, { resource_id: asText(row.id) });
    const sourceEvent = await this.client.get<{ facts_json: unknown }>("SELECT facts_json FROM ledger_events WHERE subject_type = 'candidate' AND subject_id = ? AND event_type = 'candidate.submitted' ORDER BY event_seq LIMIT 1", [asText(row.id)]);
    const sourceFact = sourceEvent && storedLedgerFacts(sourceEvent.facts_json, asText(row.id)).find(f => f.name === "development_source");
    let source: import("./development-branch.js").SourceIdentity | undefined;
    if (sourceFact) {
      try {
        const fixed = JSON.parse(sourceFact.value);
        if (fixed.format !== "grounds.candidate-source/v1" || fixed.dev_run_id !== asText(row.dev_run_id) || fixed.patch_digest !== asText(row.patch_digest) || fixed.result_tree_oid !== asText(row.result_tree_oid) || Object.keys(fixed).sort().join(",") !== "commit,dev_run_id,format,parents,patch_digest,result_tree_oid") throw new Error("Candidate source does not bind its artifact");
        source = { commit: fixed.commit, parents: fixed.parents }; validateSourceIdentity(source);
      } catch (error) { return persistedRecordError("candidate", asText(row.id), "stored Candidate source is invalid", error); }
    }
    let git: { metadata: GitCommitArtifact; size: number } | undefined;
    if (asText(row.artifact_format) === GIT_CANDIDATE_ARTIFACT_FORMAT) {
      git = await this.gitArtifactMetadata(asText(row.id));
      validateGitArtifactCandidateBinding(git.metadata, { id: asText(row.id), source, base_commit: base ? asText(base.base_commit) : (await this.getIssueRevisionById(asText(row.issue_revision_id))).baseline.git_oid, repository_remote_snapshot: asText(row.repository_remote_snapshot), result_tree_oid: asText(row.result_tree_oid) });
    }
    return { ...(git ? { git_artifact: git.metadata, patch_size: git.size } : {}), ...(source ? { source } : {}), ...(base ? { base_commit: asText(base.base_commit) } : {}), candidate_id: asText(row.id), dev_run_id: asText(row.dev_run_id), issue_revision_id: asText(row.issue_revision_id), patch_digest: asText(row.patch_digest), result_tree_oid: asText(row.result_tree_oid), artifact_format: asText(row.artifact_format), ...(git || row.patch_size === null || row.patch_size === undefined ? {} : { patch_size: safeInteger(row.patch_size, "uncompressed_size") }) };
  }

  async getCandidateByDevRun(devRunId: string): Promise<CandidateRecord | undefined> {
    const row = await this.client.get<{ id: unknown }>("SELECT id FROM candidates WHERE dev_run_id = ?", [devRunId]);
    return row ? this.getCandidate(asText(row.id)) : undefined;
  }

  protected async verificationSummaryFromRow(row: Record<string, unknown>, expectedCandidateId?: string): Promise<VerificationSummaryItem> {
    const id = asText(row.id);
    const record = await this.getVerification(id);
    const candidateId = asText(row.candidate_id);
    const verdict = asText(row.overall_verdict);
    const createdAt = parseDate(row.created_at);
    const attribution = parseAttribution(row.attribution_json);
    if (record.verification.id !== id || record.verification.candidate_id !== candidateId || record.verification.overall_verdict !== verdict || record.verification.created_at !== createdAt || JSON.stringify(record.verification.attribution) !== JSON.stringify(attribution) || (expectedCandidateId !== undefined && candidateId !== expectedCandidateId)) {
      return persistedRecordError("verification", id, "stored Verification summary projection is invalid", new Error("summary projection does not match the immutable Verification"));
    }
    return { id, candidate_id: candidateId, overall_verdict: verdict, created_at: createdAt, attribution, ...verificationModeProjection(record) };
  }

  protected async verificationCounts(candidateId: string): Promise<{ total: number; qualified: number; rejected: number }> {
    const rows = await this.client.all<{ id: unknown; overall_verdict: unknown }>(`SELECT id, overall_verdict FROM verifications WHERE candidate_id = ? ORDER BY ${this.client.dialect.timeKey("created_at")}, id`, [candidateId]);
    let qualified = 0;
    let rejected = 0;
    for (const row of rows) {
      const id = asText(row.id);
      const verdict = asText(row.overall_verdict);
      const record = await this.getVerification(id);
      if (record.verification.candidate_id !== candidateId || record.verification.overall_verdict !== verdict) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Verification projection does not match its Candidate", false, { resource_type: "verification", resource_id: id });
      if (verdict === "qualified") qualified += 1;
      if (verdict === "rejected") rejected += 1;
    }
    return { total: rows.length, qualified, rejected };
  }

  async candidateStanding(candidateId: string): Promise<string> {
    // Standing is a Candidate-facing projection.  Validate the immutable
    // Candidate graph before deriving counts so damaged rows fail closed.
    await this.candidateMetadata(candidateId);
    const counts = await this.verificationCounts(candidateId);
    return standingFromCounts(counts.total, counts.qualified, counts.rejected);
  }

  async listCriterionStandings(candidateId: string, verificationIds: string[]): Promise<Record<string, string>> {
    if (verificationIds.length === 0) return {};
    for (const verificationId of verificationIds) {
      const record = await this.getVerification(verificationId);
      if (record.verification.candidate_id !== candidateId) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "frozen Verification belongs to another Candidate", false, { resource_type: "verification", resource_id: verificationId });
    }
    const placeholders = verificationIds.map(() => "?").join(",");
    const rows = await this.client.all<{ target_type: unknown; target_id: unknown; criterion_id: unknown; qualified: unknown; rejected: unknown; total: unknown }>(`SELECT va.target_type, va.target_id, va.criterion_id, count(*) AS total, COALESCE(SUM(CASE WHEN va.final_verdict = 'qualified' THEN 1 ELSE 0 END), 0) AS qualified, COALESCE(SUM(CASE WHEN va.final_verdict = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected FROM verification_assessments va JOIN verifications v ON v.id = va.verification_id WHERE v.candidate_id = ? AND va.verification_id IN (${placeholders}) GROUP BY va.target_type, va.target_id, va.criterion_id`, [candidateId, ...verificationIds]);
    const result: Record<string, string> = {};
    for (const row of rows) result[`${asText(row.target_type)}:${asText(row.target_id)}:${asText(row.criterion_id)}`] = standingFromCounts(safeInteger(row.total, "verification_total"), safeInteger(row.qualified, "qualified_verifications"), safeInteger(row.rejected, "rejected_verifications"));
    return result;
  }

  async readVerificationDirectoryPage(candidateId: string, after: string, limit: number): Promise<{ rows: VerificationSummaryItem[]; more: boolean }> {
    requireRow(await this.client.get("SELECT id FROM candidates WHERE id = ?", [candidateId]), "candidate", candidateId);
    return this.verificationSummaryPage(candidateId, after, limit, false);
  }

  async listVerificationSummariesPage(candidateId: string, after: string, limit: number): Promise<{ rows: VerificationSummaryItem[]; more: boolean }> {
    return this.verificationSummaryPage(candidateId, after, limit, true);
  }

  protected async verificationSummaryPage(candidateId: string, after: string, limit: number, verifyReports: boolean): Promise<{ rows: VerificationSummaryItem[]; more: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw validation("verification_limit", "must be between 1 and 256");
    let cursor: { key: string; id: string } | undefined;
    if (after) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(after) || after.length % 4 === 1) throw new Error("invalid cursor");
        const raw = Buffer.from(after, "base64url");
        if (!raw.length || raw.toString("base64url") !== after) throw new Error("invalid cursor");
        const decoded = raw.toString("utf8");
        const separator = decoded.indexOf("\0");
        if (separator <= 0 || separator === decoded.length - 1) throw new Error("invalid cursor");
        const createdAt = decoded.slice(0, separator);
        const id = decoded.slice(separator + 1);
        if (!Number.isFinite(Date.parse(createdAt)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(createdAt) || !isUUIDv7(id)) throw new Error("invalid cursor");
        cursor = { key: timestampOrderKey(createdAt), id };
      } catch {
        throw validation("verifications_cursor", "must be an opaque Verification page cursor");
      }
    }
    const args: unknown[] = [candidateId];
    let where = "WHERE candidate_id = ?";
    const timeKey = this.client.dialect.timeKey("created_at");
    if (cursor) {
      // Canonical RFC3339 trims fractional zeros; raw text comparison reverses
      // .1Z/.11Z and misses equivalent legacy spellings at page boundaries.
      where += ` AND (${timeKey} > ? OR (${timeKey} = ? AND id > ?))`;
      args.push(cursor.key, cursor.key, cursor.id);
    }
    args.push(limit + 1);
    const rows = await this.client.all<Record<string, unknown>>(`SELECT id, candidate_id, overall_verdict, created_at, attribution_json, (SELECT q.overall_verdict FROM verification_quality_reviews q WHERE q.verification_id = verifications.id) AS quality_verdict, (SELECT q.attribution_json FROM verification_quality_reviews q WHERE q.verification_id = verifications.id) AS quality_attribution_json FROM verifications ${where} ORDER BY ${timeKey}, id LIMIT ?`, args);
    const pageRows = rows.slice(0, limit);
    const summaries: VerificationSummaryItem[] = [];
    for (const row of pageRows) {
      if (verifyReports) summaries.push(await this.verificationSummaryFromRow(row, candidateId));
      else {
        const id = asText(row.id);
        const verdict = asText(row.overall_verdict);
        if (!isUUIDv7(id) || asText(row.candidate_id) !== candidateId || !["qualified", "rejected", "inconclusive"].includes(verdict)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "invalid Verification directory entry");
        summaries.push({ id, candidate_id: candidateId, overall_verdict: verdict, created_at: parseDate(row.created_at), attribution: parseAttribution(row.attribution_json), ...directoryModeProjection(row) });
      }
    }
    return { rows: summaries, more: rows.length > limit };
  }

  protected async verificationDependencies(candidateId: string) {
    if (this.readSnapshot && this.verificationContext?.candidateId === candidateId) return this.verificationContext;
    // Both loaders validate the complete persisted graph. Only successful reads
    // from SQLStore.read's repeatable snapshot can be reused; writes and audits
    // retain fresh reads. Switching Candidate evicts the previous projection.
    const { candidate } = await this.candidateMetadata(candidateId);
    const issueRevision = await this.getIssueRevisionById(candidate.issue_revision_id);
    const context = { candidateId: candidate.id, resultTreeOID: candidate.result_tree_oid,
      blindContextDigest: candidate.blind_context_digest, issueRevision };
    if (this.readSnapshot) this.verificationContext = context;
    return context;
  }

  async getVerification(verificationId: string): Promise<VerificationRecord> {
    const row = requireRow(await this.getVerificationRow(verificationId), "verification", verificationId);
    const verification: Verification = { id: asText(row.id), candidate_id: asText(row.candidate_id), result_tree_oid: asText(row.result_tree_oid), blind_context_digest: asText(row.blind_context_digest), overall_verdict: asText(row.overall_verdict) as Verification["overall_verdict"], created_at: parseDate(row.created_at), attribution: parseAttribution(row.attribution_json) };
    const assessments = await this.client.all<Record<string, unknown>>("SELECT target_type, target_id, criterion_id, independent_verdict, independent_explanation, reconciliation_relation, reconciliation_explanation, final_verdict, final_explanation FROM verification_assessments WHERE verification_id = ? ORDER BY target_type, target_id, criterion_id", [verificationId]);
    const targets = new Map<string, { target_type: "goal" | "constraint"; target_id: string; criteria: any[] }>();
    for (const rowAssessment of assessments) {
      const targetType = asText(rowAssessment.target_type) as "goal" | "constraint";
      const targetId = asText(rowAssessment.target_id);
      const key = `${targetType}:${targetId}`;
      let target = targets.get(key);
      if (!target) { target = { target_type: targetType, target_id: targetId, criteria: [] }; targets.set(key, target); }
      const evidence = await this.client.all<Record<string, unknown>>(`SELECT ordinal, command, ${this.integerText("exit_code")} AS exit_code, output, output_digest FROM verification_evidence WHERE verification_id = ? AND target_type = ? AND target_id = ? AND criterion_id = ? ORDER BY ordinal`, [verificationId, targetType, targetId, asText(rowAssessment.criterion_id)]);
      validateContiguousOrdinals(evidence.map((entry) => entry.ordinal), "verification_evidence.ordinal", verificationId);
      target.criteria.push({ criterion_id: asText(rowAssessment.criterion_id), independent: { verdict: asText(rowAssessment.independent_verdict), explanation: asText(rowAssessment.independent_explanation), evidence: evidence.map((entry) => storedEvidence(entry, "verification", verificationId)) }, reconciliation: { claim_relation: asText(rowAssessment.reconciliation_relation), explanation: asText(rowAssessment.reconciliation_explanation) }, final: { verdict: asText(rowAssessment.final_verdict), explanation: asText(rowAssessment.final_explanation) } });
    }
    const report: VerificationReportInput = { format: "patchledger.verification-report/v1", candidate_id: verification.candidate_id, result_tree_oid: verification.result_tree_oid, blind_context_digest: verification.blind_context_digest, assessments: [...targets.values()] };
    try { validateVerificationReport(report); } catch (error) { persistedVerificationError(verificationId, error); }
    try {
      if (verification.id !== verificationId || !isUUIDv7(verification.id) || !isUUIDv7(verification.candidate_id)) throw new Error("Verification identifiers are invalid");
      const context = await this.verificationDependencies(verification.candidate_id);
      if (context.candidateId !== verification.candidate_id || context.resultTreeOID !== verification.result_tree_oid || context.blindContextDigest !== verification.blind_context_digest) {
        throw new Error("Verification does not match its immutable Candidate artifact");
      }
      validatePersistedVerificationCoverage(report, context.issueRevision, verificationId);
    } catch (error) {
      persistedVerificationError(verificationId, error);
    }
    const quality = this.readQualityReview(verification, row);
    if (verification.overall_verdict !== combinedVerdict(report, quality?.report)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Verification verdict does not match its assessments", false, { resource_type: "verification", resource_id: verificationId });
    return { verification, report, ...(quality ? { quality } : {}) };
  }

  async appendLedgerEvent(event: LedgerEvent): Promise<void> {
    // Store ledger facts as a JSON object while the public query contract
    // exposes a deterministic sorted array. Normalize at the persistence seam.
    const facts = Object.fromEntries(event.facts.map((fact) => [fact.name, fact.value]));
    await this.client.run("INSERT INTO ledger_events (event_id, event_type, event_version, operation_id, repository_id, subject_type, subject_id, subject_version, occurred_at, attribution_json, facts_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [event.event_id, event.event_type, event.event_version, event.operation_id, event.repository_id ?? null, event.subject_type, event.subject_id, event.subject_version ?? null, event.occurred_at, json(event.attribution), json(facts)]);
  }

}
