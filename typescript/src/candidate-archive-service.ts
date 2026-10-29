import { sha256 } from "./canonical-json.js";
import { archiveGitCommit, type ArchivePolicyCheck, type GitArchiveBinding, type GitArchiveObservation, type GitArchiveOptions } from "./candidate-git-archive.js";
import { GIT_CANDIDATE_ARTIFACT_FORMAT, type GitCommitArtifact } from "./git-artifact-storage.js";
import { DomainError, validation } from "./errors.js";
import { isUUIDv7, newUUIDv7 } from "./identity.js";
import { runtimeGet, type RuntimeRecord } from "./runtime-record.js";
import type { Attribution } from "./domain.js";
import type { Store } from "./store-types.js";

export interface ArchiveOperation {
  format: "grounds.candidate-archive-operation/v1";
  purpose: "candidate_submit" | "candidate_backfill" | "landing";
  operation_id: string;
  candidate_id: string;
  owner_id: string;
  request_digest: string;
  binding: GitArchiveBinding;
  phase: "prepared" | "verified" | "committed" | "unknown" | "failed";
  attribution: Attribution;
  created_at: string;
  updated_at: string;
  receipt?: GitArchiveObservation;
  result?: unknown;
  reason?: string;
}
export function archiveOperation(row: RuntimeRecord): ArchiveOperation {
  const data = row.data as unknown as ArchiveOperation;
  if (row.kind !== "runtime_operation" || data.format !== "grounds.candidate-archive-operation/v1" || data.operation_id !== row.id || data.owner_id !== row.parent_id || !isUUIDv7(data.candidate_id)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Archive operation binding is invalid");
  return data;
}

/** SQL fences surround network work; no SQL transaction is held while Git contacts the remote. */
export class CandidateArchiveService {
  constructor(private readonly store: Store, private readonly repositoryPath: string, private readonly options: GitArchiveOptions = {}) {}

  async show(operationId: string): Promise<RuntimeRecord> {
    if (!isUUIDv7(operationId)) throw validation("operation_id", "requires a UUIDv7");
    const row = await this.store.read(tx => runtimeGet(tx, "runtime_operation", operationId));
    archiveOperation(row); return row;
  }

  async prepare(input: { operation_id: string; purpose: ArchiveOperation["purpose"]; owner_id: string; candidate_id?: string; request: unknown; binding: (candidateId: string) => GitArchiveBinding; attribution: Attribution }): Promise<RuntimeRecord> {
    if (!isUUIDv7(input.operation_id) || !isUUIDv7(input.owner_id) || (input.candidate_id && !isUUIDv7(input.candidate_id))) throw validation("archive", "fixed operation, owner and Candidate identities required");
    return this.store.write(async tx => {
      if (input.purpose === "candidate_submit") await tx.lockDevRun(input.owner_id);
      const existing = await tx.getRuntimeRecord("runtime_operation", input.operation_id);
      const candidate = existing ? archiveOperation(existing).candidate_id : input.candidate_id ?? newUUIDv7();
      const binding = input.binding(candidate);
      const request_digest = sha256({ purpose: input.purpose, owner_id: input.owner_id, candidate_id: candidate, binding, request: input.request, attribution: input.attribution });
      if (existing) {
        const old = archiveOperation(existing);
        if (old.request_digest !== request_digest || old.purpose !== input.purpose || (input.candidate_id && old.candidate_id !== input.candidate_id)) throw new DomainError("IDEMPOTENCY_CONFLICT", "Archive retry differs from the fixed operation request");
        return existing;
      }
      if (input.purpose === "candidate_submit") {
        const run = await tx.getDevRun(input.owner_id);
        if (run.state !== "open") throw new DomainError("STATE_CONFLICT", "Only an open DevRun can reserve a Candidate archive");
        await tx.assertDevRunNotSyncing(run.id);
      }
      const now = await tx.now();
      const data: ArchiveOperation = { format: "grounds.candidate-archive-operation/v1", purpose: input.purpose, operation_id: input.operation_id, owner_id: input.owner_id, candidate_id: candidate, request_digest, binding, attribution: input.attribution, phase: "prepared", created_at: now, updated_at: now };
      const row: RuntimeRecord = { id: input.operation_id, kind: "runtime_operation", parent_id: input.owner_id, version: 1, data: data as unknown as Record<string, unknown> };
      await tx.saveRuntimeRecord(row, 0); return row;
    });
  }

  private async update(operationId: string, fields: Partial<ArchiveOperation>): Promise<RuntimeRecord> {
    return this.store.write(async tx => {
      const row = await runtimeGet(tx, "runtime_operation", operationId), old = archiveOperation(row);
      if (old.phase === "committed") return row;
      if (fields.phase === "committed" && (old.phase !== "verified" || old.receipt?.status !== "confirmed" || old.receipt.integrity !== "complete" || !old.receipt.protection)) throw new DomainError("STATE_CONFLICT", "An unconfirmed archive cannot be marked committed", false, { operation_id: operationId, phase: old.phase });
      const version = row.version;
      row.version++;
      // Successful observations intentionally clear an earlier failure reason.
      // SQL canonical JSON rejects undefined, so absent optional fields must be
      // omitted rather than persisted as JavaScript undefined.
      const next = { ...old, ...fields, updated_at: await tx.now() } as unknown as Record<string, unknown>;
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      row.data = next;
      await tx.saveRuntimeRecord(row, version); return row;
    });
  }

  async verify(operationId: string, policyCheck: ArchivePolicyCheck): Promise<{ row: RuntimeRecord; artifact: GitCommitArtifact }> {
    let row = await this.show(operationId), data = archiveOperation(row);
    // A verified operation is not yet a sealed Candidate. A retry may occur
    // after its policy expired or its archive changed, so obtain fresh evidence
    // every time until the SQL business result is durably committed.
    if (data.phase !== "committed") {
      let receipt: GitArchiveObservation;
      try { receipt = await archiveGitCommit({ ...this.options, repositoryPath: this.repositoryPath, binding: data.binding, policyCheck, allowRemoteWrite: true }); }
      catch {
        await this.update(operationId, { phase: "unknown", reason: "local_identity_or_archive_operation_failed" });
        throw new DomainError("STATE_CONFLICT", "Archive operation could not be confirmed; preserve work and inspect the original operation", false, { operation_id: operationId });
      }
      row = await this.update(operationId, { phase: receipt.status === "confirmed" ? "verified" : receipt.status === "conflict" ? "failed" : "unknown", receipt, reason: receipt.reason });
      data = archiveOperation(row);
    }
    if (!data.receipt || data.receipt.status !== "confirmed") throw new DomainError("STATE_CONFLICT", "Remote archive is not confirmed; retry the original operation after resolving its diagnosis", false, { operation_id: operationId, reason: data.reason ?? data.receipt?.status ?? data.phase, ...(data.receipt?.protection_diagnosis ? { protection_diagnosis: data.receipt.protection_diagnosis } : {}) });
    return { row, artifact: { format: GIT_CANDIDATE_ARTIFACT_FORMAT, generator_version: "grounds.canonical-git-diff/v1", binding: data.binding, receipt: data.receipt } };
  }

  async committed(operationId: string, result: unknown): Promise<RuntimeRecord> {
    return this.update(operationId, { phase: "committed", result });
  }
}
