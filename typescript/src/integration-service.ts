import { assertHistoryRepository, historyGit, rawOID } from "./git-history.js";
import { sha256 } from "./canonical-json.js";
import { type Attribution, type TargetBranch, validateAttribution, validateTargetBranchSpec } from "./domain.js";
import { DomainError, validation } from "./errors.js";
import { isGitOID, isUUIDv7, newUUIDv7 } from "./identity.js";
import { bindDegradedMerge, degradedMergeBindingMatches, evaluateIntegrationGate, evaluateLanding, type DegradedMergeBinding, type GateInput, type LandingSource } from "./integration-gate.js";
import { inspectLandingTargetPredecessor, locateFirstParentLanding, readCommit, type LandingTargetPredecessor } from "./integration-history.js";
import { observeBranch, targetRelation, type BranchObservation } from "./integration-observation.js";
import { indexCandidateChanges } from "./change-index.js";
import { validateTargetBranch } from "./target-branch.js";
import { verificationSetSummary } from "./module.js";
import type { VerificationSetSummary } from "./review.js";
import type { Store, Tx } from "./store-types.js";

export interface AdoptionBinding {
  format: "grounds.adoption-binding/v1";
  repository_id: string; candidate_id: string; source_commit: string; landed_commit: string;
  target: TargetBranch; method: "ff" | "merge" | "squash";
  /** Actual target ref value before the claimed update, bound to the same adoption source. */
  target_predecessor?: string;
  source: { kind: "user_confirmation" | "merged_mr"; reference: string };
}
export function validateAdoptionBinding(binding: AdoptionBinding): void {
  if (!binding || binding.format !== "grounds.adoption-binding/v1" || !isUUIDv7(binding.repository_id) || !isUUIDv7(binding.candidate_id) ||
    !isGitOID(binding.source_commit) || !isGitOID(binding.landed_commit) || (binding.target_predecessor !== undefined && !isGitOID(binding.target_predecessor)) || !["ff", "merge", "squash"].includes(binding.method) ||
    !binding.source || !["user_confirmation", "merged_mr"].includes(binding.source.kind) || typeof binding.source.reference !== "string" ||
    !binding.source.reference.trim() || binding.source.reference.length > 4096 || Object.keys(binding.source).sort().join(",") !== "kind,reference" || Object.keys(binding).some(k => !["format", "repository_id", "candidate_id", "source_commit", "landed_commit", "target", "method", "source", "target_predecessor"].includes(k))) throw validation("adoption", "requires explicit Repository, target, Candidate, source, actual landing and adoption source binding");
  validateTargetBranchSpec(binding.target);
}
export interface IntegrationActor { operation_id: string; attribution: Attribution }
export interface GateRequest { candidate_id: string; selection_id: string; selection_version: number; source: TargetBranch; source_commit: string; refresh: boolean }
export interface IntegrationVerification {
  candidate_id: string;
  selection: { id?: string; version: number; candidate_id?: string };
  current_verification: VerificationSetSummary;
  at_selection?: VerificationSetSummary;
  verification_changed: boolean | null;
}
export interface GateObservation {
  request: GateRequest;
  input: GateInput;
  decision: ReturnType<typeof evaluateIntegrationGate>;
  target_observation: BranchObservation;
  source_observation: BranchObservation;
  verification: IntegrationVerification;
}
export interface IntegrationRecord {
  id: string;
  kind: "gate" | "authorization" | "consumption" | "landing";
  candidate_id: string;
  created_at: string;
  attribution: Attribution;
  gate?: GateObservation;
  based_on?: string;
  binding?: DegradedMergeBinding;
  reason?: string;
  disclosure?: "landed_code_is_unverified";
  landing?: { target_predecessor?: LandingTargetPredecessor; actual_landing?: import("./integration-gate.js").CommitIdentity; adoption?: AdoptionBinding; history_sensitive_verification?: "requires_landing_context" | "candidate_context" | "unknown"; provenance?: LandingSource; supplied_commit?: string; delivery_link_eligibility: "eligible" | "no_supported_text_changes" | "not_exact_artifact"; target_observation: BranchObservation; decision: ReturnType<typeof evaluateLanding>; verification: IntegrationVerification };
}
const id = (name: string, value: string): void => { if (!isUUIDv7(value)) throw validation(name, "requires a UUIDv7"); };
const validateActor = (actor: IntegrationActor): void => { id("operation_id", actor.operation_id); validateAttribution(actor.attribution); };
const conflict = (reason: string): never => { throw new DomainError("STATE_CONFLICT", reason, false, { reason }); };
// Public command identifiers persisted in idempotency records, not credentials.
function operationCommand(kind: IntegrationRecord["kind"]): string {
  switch (kind) {
    case "gate": return "integration.observe";
    case "authorization": return "integration.authorize";
    case "consumption": return "integration.consume";
    case "landing": return "integration.landing";
    default: {
      const unsupported: never = kind;
      throw validation("integration.kind", `unsupported record kind: ${unsupported}`);
    }
  }
}
const envelope = (record: IntegrationRecord, operationId: string) => JSON.stringify({ format: "patchledger.cli/v1", ok: true, operation_id: operationId, data: { result_type: "patchledger.result.integration/v1", command: operationCommand(record.kind), record }, warnings: [] });

/** Append-only facts use the established transactional ledger, not a second audit store. */
export class IntegrationService {
  constructor(private readonly store: Store, private readonly cwd: string) {}

  private async subject(tx: Tx, candidateId: string) {
    const record = await tx.getCandidate(candidateId);
    const revision = await tx.getIssueRevisionById(record.candidate.issue_revision_id);
    if (!revision.target_branch || !record.candidate.base_commit) throw validation("candidate", "integration requires a target-flow Candidate; legacy and pinned Eval flows do not use this gate");
    const issue = await tx.getIssue(revision.issue_id);
    const remoteRows = await tx.listRepositoryRemotes(issue.repository_id);
    // Exact matching keeps retired aliases (historical identity); key matching
    // must use active remotes only, since a retired alias must not resurrect as
    // a transport-agnostic match.
    const remotes = remoteRows.map(remote => remote.remote);
    const activeRemotes = remoteRows.filter(remote => remote.state === "active").map(remote => remote.remote);
    return { record, revision, issue, remotes, activeRemotes, target: revision.target_branch, artifact: { candidate_id: candidateId, ...(record.candidate.source ? { source_commit: record.candidate.source.commit } : {}), base_commit: record.candidate.base_commit, result_tree_oid: record.candidate.result_tree_oid } };
  }

  private async selection(tx: Tx, revisionId: string, candidateId: string): Promise<IntegrationVerification> {
    await tx.lockIssueSelection(revisionId);
    await tx.lockCandidateVerifications(candidateId);
    const selected = await tx.getSelection(revisionId);
    const current = await verificationSetSummary(tx, candidateId);
    const snapshot = selected?.candidate_id === candidateId ? selected.verification_at_selection : undefined;
    return { candidate_id: candidateId,
      selection: { version: selected?.version ?? 0, ...(selected ? { id: selected.id, ...(selected.candidate_id ? { candidate_id: selected.candidate_id } : {}) } : {}) },
      current_verification: current, ...(snapshot ? { at_selection: snapshot } : {}), verification_changed: snapshot ? snapshot.digest !== current.digest : null };
  }

  private validateRequest(request: GateRequest): void {
    id("candidate", request.candidate_id); id("selection", request.selection_id);
    if (!Number.isSafeInteger(request.selection_version) || request.selection_version < 1) throw validation("selection_version", "must be a positive integer");
    if (!isGitOID(request.source_commit)) throw validation("source_commit", "requires a qualified Git OID");
    if (typeof request.refresh !== "boolean") throw validation("refresh", "must be boolean");
    validateTargetBranchSpec(request.source);
  }

  private async collect(request: GateRequest) {
    this.validateRequest(request);
    const subject = await this.store.read(tx => this.subject(tx, request.candidate_id));
    if (request.source.ref === subject.target.ref) throw validation("source", "source and target must be different branches of the Repository");
    validateTargetBranch(this.cwd, subject.target, subject.remotes, subject.activeRemotes);
    validateTargetBranch(this.cwd, request.source, subject.remotes, subject.activeRemotes);
    const target = observeBranch(this.cwd, subject.target, subject.remotes, request.refresh, subject.activeRemotes);
    const source = observeBranch(this.cwd, request.source, subject.remotes, request.refresh, subject.activeRemotes);
    const relation = target.commit ? targetRelation(this.cwd, subject.artifact.base_commit, target.commit.oid) : "unknown";
    return { subject, target, source, relation };
  }

  private async gate(tx: Tx, request: GateRequest, observed: Awaited<ReturnType<IntegrationService["collect"]>>): Promise<GateObservation> {
    const verification = await this.selection(tx, observed.subject.revision.id, request.candidate_id);
    const input: GateInput = {
      artifact: observed.subject.artifact,
      expected_selection: { id: request.selection_id, version: request.selection_version, candidate_id: request.candidate_id },
      current_selection: verification.selection.id && verification.selection.candidate_id ? { id: verification.selection.id, version: verification.selection.version, candidate_id: verification.selection.candidate_id } : null,
      expected_source: request.source_commit,
      source: observed.source.commit,
      ...(observed.subject.record.candidate.source ? { source_contains_base: (() => {
        try { assertHistoryRepository(this.cwd); return !!observed.source.commit && JSON.stringify(observed.source.commit.parents) === JSON.stringify(observed.subject.record.candidate.source!.parents) && historyGit(this.cwd, ["rev-list", rawOID(observed.source.commit.oid)]).split("\n").includes(rawOID(observed.subject.artifact.base_commit)); }
        catch { return undefined; }
      })() } : {}),
      target: observed.target.commit ? { oid: observed.target.commit.oid, relation: observed.relation } : undefined,
      refreshed: observed.target.refreshed && observed.source.refreshed,
    };
    return { request, input, decision: evaluateIntegrationGate(input), target_observation: observed.target, source_observation: observed.source, verification };
  }

  private async append(tx: Tx, record: IntegrationRecord, actor: IntegrationActor): Promise<void> {
    const subject = await this.subject(tx, record.candidate_id);
    const value = JSON.stringify(record);
    if (Buffer.byteLength(value) > 48 * 1024) throw validation("integration", "record exceeds 48 KiB");
    await tx.appendLedgerEvent({ event_id: record.id, event_type: `integration.${record.kind}`, event_version: 1, operation_id: actor.operation_id,
      repository_id: subject.issue.repository_id, subject_type: "candidate", subject_id: record.candidate_id, occurred_at: record.created_at,
      attribution: actor.attribution, facts: [{ name: "record", value }, { name: "record_digest", value: sha256(record) }] });
  }

  private async write(kind: IntegrationRecord["kind"], request: unknown, actor: IntegrationActor, make: (tx: Tx) => Promise<Omit<IntegrationRecord, "id" | "kind" | "created_at" | "attribution">>): Promise<IntegrationRecord> {
    id("operation_id", actor.operation_id); validateAttribution(actor.attribution);
    const hash = sha256(JSON.parse(JSON.stringify({ request, attribution: actor.attribution })));
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: actor.operation_id, command: operationCommand(kind), request_hash: hash });
      if (replay) {
        if (kind === "consumption") conflict("authorization is already consumed; an unknown merge outcome must be inspected, never automatically retried");
        const saved = JSON.parse(replay.result_json).data.record as IntegrationRecord;
        if (!saved || !isUUIDv7(saved.id)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "integration replay has no record identity");
        const authoritative = await this.readRecord(tx, saved.id);
        if (sha256(saved) !== sha256(authoritative)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "integration replay differs from the ledger record");
        return authoritative;
      }
      const record: IntegrationRecord = JSON.parse(JSON.stringify({ ...await make(tx), id: newUUIDv7(), kind, created_at: await tx.now(), attribution: actor.attribution }));
      await this.append(tx, record, actor);
      await tx.completeOperation(actor.operation_id, envelope(record, actor.operation_id));
      return record;
    });
  }

  private async readRecord(tx: Tx, recordId: string): Promise<IntegrationRecord> {
    const event = await tx.getLedgerEvent(recordId);
    try {
      const record = JSON.parse(event.facts.find(fact => fact.name === "record")!.value) as IntegrationRecord;
      if (record.id !== event.event_id || record.candidate_id !== event.subject_id || event.subject_type !== "candidate" || record.created_at !== event.occurred_at
        || event.event_type !== `integration.${record.kind}` || !["gate", "authorization", "consumption", "landing"].includes(record.kind)
        || sha256(record.attribution) !== sha256(event.attribution) || sha256(record) !== event.facts.find(fact => fact.name === "record_digest")?.value) throw new Error("mismatch");
      const ref = await tx.findCandidateArtifactRef({candidate_id: record.candidate_id});
      if (ref?.git_artifact) {
        const revision = await tx.getIssueRevisionById(ref.issue_revision_id);
        const issue = await tx.getIssue(revision.issue_id);
        if (!revision.target_branch || !ref.base_commit || issue.repository_id !== event.repository_id) throw new Error("subject mismatch");
      } else await this.subject(tx, record.candidate_id);
      return record;
    } catch { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored integration record is invalid", false, { resource_id: recordId }); }
  }

  async show(recordId: string): Promise<IntegrationRecord> {
    id("record", recordId);
    return this.store.read(tx => this.readRecord(tx, recordId));
  }

  async authorizationState(authorizationId: string): Promise<"available" | "consumed"> {
    const record = await this.show(authorizationId);
    if (record.kind !== "authorization") throw validation("authorization", "requires an authorization record");
    return this.store.read(async tx => {
      const operation = await tx.getOperation(authorizationId);
      if (operation && operation.command !== "integration.single-use") throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "authorization consumption key has an unexpected owner");
      return operation ? "consumed" : "available";
    });
  }

  async observe(request: GateRequest, actor: IntegrationActor): Promise<IntegrationRecord> {
    validateActor(actor);
    const observed = await this.collect(request);
    return this.write("gate", request, actor, async tx => ({ candidate_id: request.candidate_id, gate: await this.gate(tx, request, observed) }));
  }

  async authorize(observationId: string, reason: string, actor: IntegrationActor): Promise<IntegrationRecord> {
    validateActor(actor);
    id("observation", observationId);
    if (typeof reason !== "string" || !reason.trim() || reason.length > 4096) throw validation("reason", "requires the explicit one-time user decision, at most 4096 characters");
    const observation = await this.show(observationId);
    if (observation.kind !== "gate" || !observation.gate) throw validation("observation", "requires a gate observation");
    if (!["unverified", "qualified"].includes(observation.gate.verification.current_verification.standing)) conflict("rejected, disputed or inconclusive evidence cannot be waived as an unverified exception; inspect the complete Verification set");
    const binding = bindDegradedMerge(observation.gate.input);
    return this.write("authorization", { observationId, reason }, actor, async () => ({ candidate_id: observation.candidate_id, based_on: observationId, binding, reason, disclosure: "landed_code_is_unverified" }));
  }

  /** Always performs a NEW refresh, then spends the authorization atomically. Never merges. */
  async consume(authorizationId: string, actor: IntegrationActor): Promise<IntegrationRecord> {
    validateActor(actor);
    const authorization = await this.show(authorizationId);
    if (authorization.kind !== "authorization" || !authorization.binding || !authorization.based_on) throw validation("authorization", "requires an authorization record");
    const original = await this.show(authorization.based_on);
    if (!original.gate) throw validation("authorization", "original observation is unavailable");
    const request = { ...original.gate.request, refresh: true };
    const observed = await this.collect(request);
    return this.write("consumption", { authorizationId }, actor, async tx => {
      const gate = await this.gate(tx, request, observed);
      if (!["unverified", "qualified"].includes(gate.verification.current_verification.standing) || !degradedMergeBindingMatches(authorization.binding!, gate.input)) conflict("bound facts changed or cannot be confirmed; do not merge, obtain a new decision");
      // The authorization UUID is a separate, one-shot reservation key. A new
      // caller operation ID cannot spend the same authorization a second time.
      const spent = await tx.reserveOperation({ id: authorizationId, command: "integration.single-use", request_hash: sha256({ authorizationId }) });
      if (spent) conflict("authorization already consumed");
      await tx.completeOperation(authorizationId, JSON.stringify({ format: "patchledger.cli/v1", ok: true, operation_id: authorizationId, data: { result_type: "patchledger.result.integration-token/v1", command: "integration.single-use", authorization_id: authorizationId, consumed: true }, warnings: [] }));
      return { candidate_id: authorization.candidate_id, based_on: authorizationId, binding: authorization.binding, disclosure: "landed_code_is_unverified", gate };
    });
  }

  async landing(observationId: string, options: { commit?: string; provenance?: LandingSource; refresh: boolean; adoption?: AdoptionBinding }, actor: IntegrationActor): Promise<IntegrationRecord> {
    validateActor(actor);
    const observation = await this.show(observationId);
    if (observation.kind !== "gate" || !observation.gate) throw validation("observation", "requires a gate observation");
    if (options.commit !== undefined && !isGitOID(options.commit)) throw validation("commit", "requires a qualified OID");
    if (options.provenance !== undefined && !["user", "merge_result", "target_is_source"].includes(options.provenance)) throw validation("provenance", "unknown landing source");
    if (typeof options.refresh !== "boolean") throw validation("refresh", "must be boolean");
    if (options.adoption !== undefined) validateAdoptionBinding(options.adoption);
    const subject = await this.store.read(tx => this.subject(tx, observation.candidate_id));
    const target = observeBranch(this.cwd, subject.target, subject.remotes, options.refresh, subject.activeRemotes);
    let commit = options.commit, provenance = options.provenance;
    if (!commit && target.refreshed && target.commit?.oid === observation.gate.input.expected_source) { commit = target.commit.oid; provenance = "target_is_source"; }
    if (provenance === "target_is_source" && !target.refreshed) provenance = undefined;
    const located = commit && target.commit ? locateFirstParentLanding(this.cwd, target.commit.oid, commit) : undefined;
    const hasText = indexCandidateChanges(subject.record.artifact).change_units.some(unit => unit.kind === "hunk");
    let actual = located?.landed, onFirstParent = located?.on_first_parent === true;
    let adoptionBound = false;
    const binding = options.adoption;
    if (subject.record.candidate.source && binding && target.refreshed && actual) {
      validateAdoptionBinding(binding);
      const resolved = located?.first_parent_landing ?? actual;
      const source = subject.record.candidate.source.commit;
      const same = binding.repository_id === subject.issue.repository_id && binding.candidate_id === subject.record.candidate.id &&
        binding.source_commit === source && binding.landed_commit === resolved.oid && binding.target.remote === subject.target.remote && binding.target.ref === subject.target.ref;
      let ancestry = false;
      try {
        assertHistoryRepository(this.cwd);
        const archived = subject.record.candidate.source!;
        const original = readCommit(this.cwd, source);
        const sourceMatches = original.oid === archived.commit && original.tree_oid === subject.artifact.result_tree_oid
          && JSON.stringify(original.parents) === JSON.stringify(archived.parents)
          && historyGit(this.cwd, ["rev-list", rawOID(source)]).split("\n").includes(rawOID(subject.artifact.base_commit));
        ancestry = sourceMatches && (binding.method === "squash" ? resolved.parents.length === 1 : binding.method === "ff"
          ? resolved.oid === source && locateFirstParentLanding(this.cwd, target.commit!.oid, source).on_first_parent === true
          : resolved.parents.length > 1 && resolved.parents.slice(1).some(p => historyGit(this.cwd, ["rev-list", rawOID(p)]).split("\n").includes(rawOID(source))));
      } catch { /* incomplete history is unknown */ }
      // These are explicit supplied adoption claims. We verify their Git binding,
      // not a hosting provider's MR state or signature.
      const sourceClaimMatches = binding.source.kind === "merged_mr" ? provenance === "merge_result"
        : provenance === "user" || provenance === "target_is_source";
      adoptionBound = sourceClaimMatches && same && ancestry && locateFirstParentLanding(this.cwd, target.commit!.oid, resolved.oid).on_first_parent === true;
      if (adoptionBound) { actual = resolved; onFirstParent = true; }
    }
    const decision = evaluateLanding({ artifact: subject.artifact, expected_source: observation.gate.input.expected_source,
      target_commit: target.commit?.oid ?? "", ...(provenance ? { provenance } : {}), ...(actual ? { landed: actual } : {}), on_first_parent: onFirstParent, ...(subject.record.candidate.source ? { adoption_bound: adoptionBound } : {}),
      ...(located?.first_parent_landing ? { first_parent_landing: located.first_parent_landing } : {}), has_supported_text_changes: hasText });
    const predecessor = inspectLandingTargetPredecessor(this.cwd, {
      ...(decision.identity === "trusted" && actual ? { landed: actual } : {}),
      ...(binding ? { method: binding.method, ...(binding.target_predecessor ? { supplied_predecessor: binding.target_predecessor } : {}) } : {}),
      adoption_bound: adoptionBound,
    });
    return this.write("landing", { observationId, options }, actor, async tx => ({ candidate_id: observation.candidate_id, based_on: observationId,
      landing: { target_predecessor: predecessor, ...(decision.identity === "trusted" && actual ? { actual_landing: actual } : {}), ...(binding ? { adoption: binding } : {}), history_sensitive_verification: !actual ? "unknown" as const : subject.record.candidate.source && actual.oid !== subject.record.candidate.source.commit ? "requires_landing_context" as const : "candidate_context" as const, delivery_link_eligibility: decision.delivery_link_commit ? "eligible" : decision.outcome === "exact_artifact" && !hasText ? "no_supported_text_changes" : "not_exact_artifact", ...(provenance ? { provenance } : {}), ...(commit ? { supplied_commit: commit } : {}), target_observation: target, decision, verification: await this.selection(tx, subject.revision.id, observation.candidate_id) } }));
  }
}
