import { validateCompletionRecord, type CompletionRecord } from './completion.js';
import {RETIRED_RUNTIME_KINDS, validateRuntimeRecord, type RuntimeRecord} from "./runtime-record.js";
import {isSyncRecord, syncData, syncTerminal} from "./devrun-sync-record.js";

import {validateEvalRecord, type EvalKind, type EvalRecord} from "./evaluation.js";
import {validSelectionSnapshot, type SelectionRecord} from "./selection.js";
import {createHash} from "node:crypto";

import {resolve} from "node:path";
import {deflateSync} from "node:zlib";
import { isSha256, isUUIDv7, isGitOID } from "./identity.js";
import {sha256, sha256Bytes} from "./canonical-json.js";
import {DomainError, idempotencyConflict, notFound, repositoryAmbiguous, storageTransient, validation, versionConflict, stateConflict} from "./errors.js";
import {validateCanonicalRemote} from "./git.js";
import {hasForeignKeyConflict, readActiveRepositoryRemoteBindings, repositoryIdsByMatchKey} from "./sql-repository-match.js";

import {type SQLClient} from "./sql-client.js";

import {decisionDetails, validateDecision, type Baseline, type Candidate, type Decision, type DevRun, type Goal, type IntentLink, type IssueRevision, type RequirementRevision, validateBaseline, validateIssueIntentLinks, validateIssueInput, validateRequirementInput} from "./domain.js";

import type {EvalListFilter, IssueRecord, IssueRevisionRecord, Operation, OperationReplay, RepositoryRecord, RepositoryRemoteBinding, RepositoryRemoteRecord, RequirementRecord, RevisionRecord, Store} from "./store-types.js";

export const PROTOCOL_VERSION = 1;
export const REMOTE_NORMALIZATION_VERSION = 1;
export const MINIMUM_CLI_VERSION = "0.1.0";
const CLI_VERSION = "0.1.0";
import { asText, asOptionalText, asBuffer, asDigestBuffer, json, timestamp, isDuplicateKeyError, isolateStatement, requireRow, parseAttribution, parseDate, safeInteger, decodeArtifactChunks, persistedArtifactError, persistedRecordError, storedOperation, validateContiguousOrdinals, StoredOperationRow, storedLedgerFacts } from "./sql-shared.js";

export abstract class SqlTxCore {
  // Implemented further down the chain (SqlTxWork); declared here because
  // the runtime-record methods in this class call them.
  abstract assertDevRunNotSyncing(devRunId: string): Promise<void>;
  abstract lockDevRun(devRunId: string): Promise<void>;
  protected abstract lockedRuntimeChildren(kind: string, parentId: string): Promise<RuntimeRecord[]>;
  abstract getDevRun(devRunId: string): Promise<DevRun>;

  protected nowValue?: string;
  // Whether the optional quality-review table exists, learned on the first Verification read.
  protected qualityTable?: "present" | "absent";

  /** Run a statement whose failure the caller handles and continues from; see isolateStatement. */
  protected recoverable<T>(statement: () => Promise<T>): Promise<T> { return isolateStatement(this.client, statement); }

  // One private dependency projection, bounded independently of report count.
  // It is never exposed to callers and contains no Candidate patch/report body.
  protected verificationContext?: {
    candidateId: string;
    resultTreeOID: string;
    blindContextDigest: string;
    issueRevision: IssueRevision;
  };
  constructor(protected readonly client: SQLClient, protected readonly readSnapshot = false, protected readonly hasTargetBranches = true) {}

  protected evalFromRow<K extends EvalKind>(row: Record<string, unknown>): EvalRecord<K> {
    try {
      const record = JSON.parse(asText(row.record_json)) as EvalRecord<K>;
      validateEvalRecord(record);
      if (sha256(record) !== asText(row.record_digest) || record.id !== asText(row.id) || record.kind !== asText(row.kind) || record.version !== Number(row.version) || (record.parent_id ?? null) !== (row.parent_id ?? null)) throw new Error("Eval revision identity or digest mismatch");
      if (!isUUIDv7(record.id) || !Number.isSafeInteger(record.version) || record.version < 1) throw new Error("Invalid Eval revision");
      parseDate(record.created_at); parseAttribution(JSON.stringify(record.attribution));
      return record;
    } catch (error) { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Eval revision is invalid", false, { reason: String(error).slice(0, 4096) }); }
  }

  async putEvalBlob(bytes: Buffer): Promise<string> {
    if (bytes.length > 32 * 1024 * 1024) throw validation("evidence", "maximum evidence file size is 32 MiB");
    const digest = sha256Bytes(bytes);
    const existing = await this.client.get("SELECT digest FROM eval_blobs WHERE digest = ?", [digest]);
    if (existing) { if (!(await this.getEvalBlob(digest)).equals(bytes)) throw validation("evidence", "digest collision"); return digest; }
    const compressed = deflateSync(bytes); const chunks: Buffer[] = [];
    for (let n = 0; n < compressed.length; n += 1024 * 1024) chunks.push(compressed.subarray(n, n + 1024 * 1024));
    await this.client.run("INSERT INTO eval_blobs (digest, size, chunk_count) VALUES (?, ?, ?)", [digest, bytes.length, chunks.length]);
    for (let n = 0; n < chunks.length; n++) await this.client.run("INSERT INTO eval_blob_chunks (digest, ordinal, bytes) VALUES (?, ?, ?)", [digest, n, chunks[n]]);
    return digest;
  }

  async getEvalBlob(digest: string): Promise<Buffer> {
    if (!isSha256(digest)) throw validation("digest", "invalid evidence digest");
    const meta = await this.client.get<{ size: unknown; chunk_count: unknown }>("SELECT size, chunk_count FROM eval_blobs WHERE digest = ?", [digest]);
    if (!meta) throw notFound("eval_blob", digest);
    const rows = await this.client.all<{ ordinal: unknown; bytes: unknown }>("SELECT ordinal, bytes FROM eval_blob_chunks WHERE digest = ? ORDER BY ordinal", [digest]);
    if (rows.length !== safeInteger(meta.chunk_count, "chunk_count", 1) || rows.some((r, n) => safeInteger(r.ordinal, "ordinal") !== n)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "evidence chunks are missing or reordered");
    return decodeArtifactChunks(rows.map(r => asBuffer(r.bytes)), safeInteger(meta.size, "size"), digest);
  }

  protected runtimeRecord(row: Record<string, unknown>): RuntimeRecord {
    try {
      const record = JSON.parse(asText(row.record_json)) as RuntimeRecord;
      validateRuntimeRecord(record);
      if (isSyncRecord(record)) syncData(record);
      if (record.id !== row.id || record.kind !== row.kind || record.version !== Number(row.version) || (record.parent_id ?? null) !== row.parent_id || sha256(record) !== row.record_digest) throw new Error("digest or identity mismatch");
      return record;
    } catch { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "runtime record integrity check failed"); }
  }
  async getRuntimeRecord(kind: string, id: string): Promise<RuntimeRecord | undefined> {
    if (RETIRED_RUNTIME_KINDS.has(kind)) return undefined;
    const row = await this.client.get<Record<string, unknown>>("SELECT * FROM runtime_records WHERE kind = ? AND id = ?", [kind, id]);
    if (row && await this.retiredRuntimeOwner(row)) return undefined;
    return row ? this.runtimeRecord(row) : undefined;
  }
  private async retiredRuntimeOwner(row: { kind?: unknown; parent_id?: unknown }): Promise<boolean> {
    if (row.kind !== "runtime_operation" || !row.parent_id) return false;
    const owner = await this.client.get<{kind: unknown}>("SELECT kind FROM runtime_records WHERE id = ?", [row.parent_id]);
    return !!owner && RETIRED_RUNTIME_KINDS.has(String(owner.kind));
  }
  async lockRuntimeRecord(kind: string, id: string): Promise<void> {
    const suffix = this.client.dialect.forUpdate;
    requireRow(await this.client.get("SELECT id FROM runtime_records WHERE kind = ? AND id = ?" + suffix, [kind, id]), kind, id);
  }
  async listRuntimeRecords(kind: string, parentId?: string): Promise<RuntimeRecord[]> {
    if (RETIRED_RUNTIME_KINDS.has(kind)) return [];
    const rows = await this.client.all<Record<string, unknown>>("SELECT * FROM runtime_records WHERE kind = ?" + (parentId === undefined ? "" : " AND parent_id = ?") + " ORDER BY id", parentId === undefined ? [kind] : [kind, parentId]);
    const active: RuntimeRecord[] = [];
    for (const row of rows) if (!await this.retiredRuntimeOwner(row)) active.push(this.runtimeRecord(row));
    return active;
  }
  async saveRuntimeRecord(record: RuntimeRecord, expectedVersion: number): Promise<void> {
    validateRuntimeRecord(record);
    if (await this.retiredRuntimeOwner(record)) throw validation("runtime_record", "retired environment operations are no longer writable");
    if (isSyncRecord(record)) syncData(record);
    if (record.version !== expectedVersion + 1) throw validation("version", "must increment runtime version");
    const current = await this.client.get<{ version: unknown; kind: unknown; parent_id:unknown }>("SELECT version, kind, parent_id FROM runtime_records WHERE id = ?", [record.id]);
    const actual = Number(current?.version ?? 0);
    if (actual !== expectedVersion) throw versionConflict(record.kind, record.id, expectedVersion, actual);
    if (current && current.kind !== record.kind) throw validation("kind", "cannot change runtime identity type");
    if (current && current.parent_id !== (record.parent_id ?? null)) throw validation("parent_id", "cannot change runtime ownership");
    const previousRuntime = current && record.kind === "runtime_operation" ? await this.getRuntimeRecord(record.kind, record.id) : undefined;
    if (previousRuntime && isSyncRecord(previousRuntime) && !isSyncRecord(record)) throw validation("sync", "cannot erase sync record identity");
    if (isSyncRecord(record)) {
      const next = syncData(record);
      await this.lockDevRun(next.dev_run_id);
      const rows = await this.lockedRuntimeChildren("runtime_operation", next.dev_run_id);
      const old = rows.find(row => row.id === record.id);
      if (old) {
        if (old.version !== expectedVersion) throw versionConflict("sync", record.id, expectedVersion, old.version);
        const previous = syncData(old);
        const allowed: Record<string, string[]> = { reserved: ["prepared", "abandoning"], prepared: ["applying", "abandoning"], applying: ["resolving", "abandoning"], resolving: ["completing", "abandoning"], completing: ["completed", "abandoning"], abandoning: ["abandoned"], completed: [], abandoned: [] };
        if (!allowed[previous.phase]!.includes(next.phase)) throw stateConflict("sync", record.id, "invalid sync transition or immutable terminal receipt");
        for (const key of ["dev_run_id", "original_base", "target", "run_version", "created_at", "attribution", "recovery"] as const) {
          if (sha256(previous[key]) !== sha256(next[key])) throw validation("sync", "sync ownership, base and recovery identity are immutable");
        }
        if (previous.source_head !== next.source_head) throw validation("sync", "reserved source HEAD is immutable");
        if (previous.material_digest !== undefined && previous.material_digest !== next.material_digest) throw validation("sync", "recovery material digest is immutable");
        if (previous.conflicts !== undefined && sha256(previous.conflicts) !== sha256(next.conflicts)) throw validation("sync", "conflict paths are immutable");
      } else {
        const run = await this.getDevRun(next.dev_run_id);
        if (!!run.development !== !!next.source_head) throw validation("sync", "managed branch reservation requires a fixed expected source HEAD; legacy records cannot invent it");
        if (next.phase !== "reserved" || run.state !== "open" || run.version !== next.run_version || run.base_commit !== next.original_base) throw validation("sync", "sync must be reserved with the matching DevRun version");
        if (rows.some(row => isSyncRecord(row) && !syncTerminal(syncData(row)))) throw stateConflict("sync", record.id, "another sync is already pending");
      }
    }
    if (!current) await this.client.run("INSERT INTO runtime_records (id, kind, parent_id, version, record_digest, record_json) VALUES (?, ?, ?, ?, ?, ?)", [record.id, record.kind, record.parent_id ?? null, record.version, sha256(record), JSON.stringify(record)]);
    else await this.client.run("UPDATE runtime_records SET parent_id = ?, version = ?, record_digest = ?, record_json = ? WHERE id = ? AND version = ?", [record.parent_id ?? null, record.version, sha256(record), JSON.stringify(record), record.id, expectedVersion]);
  }

  async getEvalRecord<K extends EvalKind>(kind: K, id: string, version?: number): Promise<EvalRecord<K>> {
    const row = await this.client.get<Record<string, unknown>>("SELECT id, kind, version, parent_id, record_digest, record_json FROM eval_records WHERE id = ? AND kind = ?" + (version === undefined ? " ORDER BY version DESC LIMIT 1" : " AND version = ?"), version === undefined ? [id, kind] : [id, kind, version]);
    if (!row) throw notFound("eval_" + kind, id);
    return this.evalFromRow<K>(row);
  }

  // JSON field of the immutable record body, addressed by a fixed allow-listed
  // path such as `$.data.state`.  Only exact-match filters are built on it.
  protected evalField(path: string): string {
    if (!/^\$(\.[a-z_]+)+$/.test(path)) throw validation("filter", "unsupported Eval record field");
    return this.client.dialect.jsonExtract("e.record_json", path);
  }

  protected evalWhere(kind: string, filter: EvalListFilter | undefined, args: unknown[]): string {
    let where = "e.kind = ? AND e.version = (SELECT MAX(v.version) FROM eval_records v WHERE v.id = e.id)"; args.push(kind);
    if (filter?.parent_id !== undefined) { where += " AND e.parent_id = ?"; args.push(filter.parent_id); }
    for (const field of filter?.fields ?? []) { where += ` AND ${this.evalField(field.path)} = ?`; args.push(field.value); }
    return where;
  }

  async listEvalRecords<K extends EvalKind>(kind: K, parentId?: string, fields?: EvalListFilter["fields"]): Promise<EvalRecord<K>[]> {
    const args: unknown[] = [];
    const rows = await this.client.all<Record<string, unknown>>(`SELECT e.id, e.kind, e.version, e.parent_id, e.record_digest, e.record_json FROM eval_records e WHERE ${this.evalWhere(kind, { ...(parentId === undefined ? {} : { parent_id: parentId }), ...(fields ? { fields } : {}) }, args)} ORDER BY e.id`, args);
    return rows.map(row => this.evalFromRow<K>(row));
  }

  // One page of latest record versions ordered by ID.  The ID is immutable, so
  // a version update never moves a record between pages.
  async listEvalRecordsPage<K extends EvalKind>(kind: K, filter: EvalListFilter, afterId: string, limit: number): Promise<{ rows: EvalRecord<K>[]; more: boolean }> {
    if (!Number.isInteger(limit) || limit < 1) throw validation("limit", "must be at least 1");
    const args: unknown[] = [];
    let where = this.evalWhere(kind, filter, args);
    if (afterId) { where += " AND e.id > ?"; args.push(afterId); }
    args.push(limit + 1);
    const rows = await this.client.all<Record<string, unknown>>(`SELECT e.id, e.kind, e.version, e.parent_id, e.record_digest, e.record_json FROM eval_records e WHERE ${where} ORDER BY e.id LIMIT ?`, args);
    return { rows: rows.slice(0, limit).map(row => this.evalFromRow<K>(row)), more: rows.length > limit };
  }

  // Latest Run states per Experiment, computed in the caller's read snapshot.
  async evalRunCounts(experimentIds: string[]): Promise<Record<string, { open: number; closed: number }>> {
    const counts: Record<string, { open: number; closed: number }> = Object.fromEntries(experimentIds.map(id => [id, { open: 0, closed: 0 }]));
    if (!experimentIds.length) return counts;
    const rows = await this.client.all<Record<string, unknown>>(`SELECT e.parent_id AS experiment_id, ${this.evalField("$.data.state")} AS state, ${this.integerText("count(*)")} AS total FROM eval_records e WHERE e.kind = 'run' AND e.version = (SELECT MAX(v.version) FROM eval_records v WHERE v.id = e.id) AND e.parent_id IN (${experimentIds.map(() => "?").join(", ")}) GROUP BY e.parent_id, ${this.evalField("$.data.state")}`, experimentIds);
    for (const row of rows) {
      const state = asText(row.state); const id = asText(row.experiment_id);
      if ((state !== "open" && state !== "closed") || !counts[id]) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "stored Run state is invalid", false, { resource_type: "eval_run" });
      counts[id][state] = safeInteger(row.total, "run_count");
    }
    return counts;
  }

  async ledgerHighWater(): Promise<number> {
    const row = await this.client.get<{ high_water: unknown }>("SELECT COALESCE(MAX(event_seq), 0) AS high_water FROM ledger_events");
    return safeInteger(row?.high_water ?? 0, "ledger_high_water");
  }

  async saveEvalRecord<K extends EvalKind>(record: EvalRecord<K>, expectedVersion: number): Promise<void> {
    validateEvalRecord(record);
    // Store.write already serializes writes using the database coordination lock.
    const current = await this.client.get<{ version: unknown }>("SELECT MAX(version) AS version FROM eval_records WHERE id = ?", [record.id]);
    const actual = Number(current?.version ?? 0);
    if (actual !== expectedVersion) throw versionConflict("eval_" + record.kind, record.id, expectedVersion, actual);
    if (record.version !== expectedVersion + 1) throw validation("version", "must append the next revision");
    await this.client.run("INSERT INTO eval_records (id, kind, version, parent_id, record_digest, record_json) VALUES (?, ?, ?, ?, ?, ?)", [record.id, record.kind, record.version, record.parent_id ?? null, sha256(record), JSON.stringify(record)]);
  }

  protected integerText(column: string): string {
    return this.client.dialect.integerText(column);
  }

  async now(): Promise<string> {
    if (this.nowValue) return this.nowValue;
    const row = await this.client.get<{ now_value: unknown }>(this.client.dialect.nowExpression);
    if (!row) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "database did not return an authoritative time");
    this.nowValue = parseDate(row.now_value);
    return this.nowValue;
  }

  async getOperation(operationId: string, lock = false): Promise<OperationReplay | undefined> {
    const suffix = lock ? this.client.dialect.forUpdate : "";
    const row = await this.client.get<StoredOperationRow>("SELECT command, request_hash, result_json, status FROM idempotency_records WHERE operation_id = ?" + suffix, [operationId]);
    if (!row) return undefined;
    const stored = storedOperation(row, operationId);
    if (stored.status === "pending") {
      if (stored.result_json !== null && stored.result_json !== undefined) persistedArtifactError("pending idempotency record already contains a result", operationId);
      throw storageTransient("operation reservation is still pending; retry with the same operation ID", 250);
    }
    if (stored.result_json === null || stored.result_json === undefined) persistedArtifactError("completed idempotency record is missing its result", operationId);
    return { command: stored.command, request_hash: stored.request_hash, result_json: asText(stored.result_json) };
  }

  async getDevelopmentContinuation(devRunId: string): Promise<{ operation_id: string; event_seq: number; policy: "parallel" | "paused"; expected_head: string } | undefined> {
    // Callers fence the run before applying policy. READ COMMITTED writes see
    // current facts without locking unrelated joined contract or operation rows.
    const row = await this.client.get<Record<string, unknown>>("SELECT e.event_seq, e.event_id, e.event_version, e.operation_id, e.subject_version, e.facts_json, e.repository_id, d.version AS run_version, d.state AS run_state, i.repository_id AS run_repository_id FROM ledger_events e LEFT JOIN dev_runs d ON d.id = e.subject_id LEFT JOIN issue_revisions ir ON ir.id = d.issue_revision_id LEFT JOIN issues i ON i.id = ir.issue_id WHERE e.subject_type = 'dev_run' AND e.subject_id = ? AND e.event_type = 'devrun.continuation' ORDER BY e.event_seq DESC LIMIT 1", [devRunId]);
    if (!row) return undefined;
    const invalid = (): never => { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "current development continuation is inconsistent", false, { resource_id: devRunId }); };
    const facts = storedLedgerFacts(row.facts_json, asText(row.event_id));
    const policy = facts.find(f => f.name === "policy")?.value, head = facts.find(f => f.name === "expected_head")?.value;
    const op = asText(row.operation_id);
    if (!isUUIDv7(row.event_id) || !isUUIDv7(op) || Number(row.event_version) !== 1 || !Number.isSafeInteger(Number(row.subject_version)) || Number(row.subject_version) < 1 || Number(row.subject_version) !== Number(row.run_version) || asText(row.run_state) !== "submitted" || !isUUIDv7(row.repository_id) || asText(row.repository_id) !== asText(row.run_repository_id) || facts.length !== 2 || !["parallel", "paused"].includes(policy ?? "") || !isGitOID(head)) invalid();
    // Write transactions already use READ COMMITTED. The completed receipt is
    // immutable: a nonlocking read sees it without reversing op -> run lock order.
    const operation = await this.getOperation(op);
    if (!operation || operation.command !== "devrun.continue") invalid();
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(operation!.result_json).data; } catch { return invalid(); }
    if (!receipt || receipt.result_type !== "grounds.result.development-continuation/v1" || receipt.command !== "devrun.continue" || receipt.dev_run_id !== devRunId || receipt.expected_head !== head || receipt.policy !== policy) invalid();
    return { operation_id: op, event_seq: safeInteger(row.event_seq, "continuation.event_seq", 1), policy: policy as "parallel" | "paused", expected_head: head! };
  }

  async reserveOperation(operation: Operation): Promise<OperationReplay | undefined> {
    const replay = (row: StoredOperationRow): OperationReplay => {
      const stored = storedOperation(row, operation.id);
      if (stored.command !== operation.command || stored.request_hash !== operation.request_hash) throw idempotencyConflict(stored.command, operation.request_hash, stored.request_hash);
      if (stored.status === "pending") {
        if (stored.result_json !== null && stored.result_json !== undefined) persistedArtifactError("pending idempotency record already contains a result", operation.id);
        throw storageTransient("operation reservation is still pending; retry with the same operation ID", 250);
      }
      if (stored.result_json === null || stored.result_json === undefined) persistedArtifactError("completed idempotency record is missing its result", operation.id);
      return { command: stored.command, request_hash: stored.request_hash, result_json: asText(stored.result_json) };
    };
    const suffix = this.client.dialect.forUpdate;
    const selectExisting = (): Promise<StoredOperationRow | undefined> =>
      this.client.get<StoredOperationRow>("SELECT command, request_hash, result_json, status FROM idempotency_records WHERE operation_id = ?" + suffix, [operation.id]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await selectExisting();
      if (existing) return replay(existing);
      try {
        const createdAt = await this.now();
        await this.recoverable(() => this.client.run("INSERT INTO idempotency_records (operation_id, command, request_hash, status, created_at) VALUES (?, ?, ?, 'pending', ?)", [operation.id, operation.command, operation.request_hash, createdAt]));
        return undefined;
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const raced = await selectExisting();
        if (raced) return replay(raced);
        // A competing transaction may have rolled back after the unique-key
        // check.  Re-enter the reservation loop instead of reporting a
        // permanent failure for an operation that is still available.
      }
    }
    throw storageTransient("operation reservation could not be established after concurrent retries", 250);
  }

  async completeOperation(operationId: string, resultJson: string): Promise<void> {
    const result = await this.client.run("UPDATE idempotency_records SET status = 'completed', result_json = ? WHERE operation_id = ? AND status = 'pending'", [Buffer.from(resultJson), operationId]);
    if (result.changes !== 1) throw storageTransient(`operation ${operationId} was not pending`, 250);
  }

  async getRequirementRevisionByNumber(requirementId: string, version: number): Promise<RequirementRevision> {
    const row = requireRow(await this.client.get("SELECT id FROM requirement_revisions WHERE requirement_id = ? AND revision_number = ?", [requirementId, version]), "requirement", requirementId);
    return this.getRequirementRevision(requirementId, asText(row.id));
  }

  async getIssueRevisionByNumber(issueId: string, version: number): Promise<IssueRevision> {
    const row = requireRow(await this.client.get("SELECT id FROM issue_revisions WHERE issue_id = ? AND revision_number = ?", [issueId, version]), "issue", issueId);
    return this.getIssueRevision(issueId, asText(row.id));
  }

  async lockIssueSelection(issueRevisionId: string): Promise<void> {
    const suffix = this.client.dialect.forUpdate;
    requireRow(await this.client.get("SELECT id FROM issue_revisions WHERE id = ?" + suffix, [issueRevisionId]), "issue_revision", issueRevisionId);
  }

  private completionFromRow(row: Record<string, unknown>): CompletionRecord {
    try {
      const record = JSON.parse(asText(row.record_json)) as CompletionRecord;
      validateCompletionRecord(record);
      if (record.version !== Number(row.version) || record.state !== row.state || sha256(record) !== row.record_digest) throw new Error('completion digest or projection mismatch');
      return record;
    } catch (error) { return persistedRecordError('issue', asText(row.issue_revision_id), 'stored completion is invalid', error); }
  }

  async getCompletion(issueRevisionId: string): Promise<CompletionRecord | undefined> {
    const row = await this.client.get('SELECT * FROM issue_completion_versions WHERE issue_revision_id = ? ORDER BY version DESC LIMIT 1', [issueRevisionId]);
    return row ? this.completionFromRow(row) : undefined;
  }

  async completionHistory(issueRevisionId: string): Promise<CompletionRecord[]> {
    const rows = await this.client.all('SELECT * FROM issue_completion_versions WHERE issue_revision_id = ? ORDER BY version LIMIT 1001', [issueRevisionId]);
    if (rows.length > 1000) throw new DomainError('ARTIFACT_TOO_LARGE', 'Completion history exceeds 1000 records; use ledger pagination');
    let previous: CompletionRecord | undefined;
    return rows.map((row, index) => {
      const record = this.completionFromRow(row);
      if (record.version !== index + 1 || record.state !== (index % 2 === 0 ? 'completed' : 'reopened')) throw new DomainError('ARTIFACT_INTEGRITY_ERROR', 'completion history is not contiguous');
      if (record.state === 'reopened' && sha256(record.completion) !== sha256(previous?.completion)) throw new DomainError('ARTIFACT_INTEGRITY_ERROR', 'reopen changed prior completion facts');
      previous = record;
      return record;
    });
  }

  async appendCompletion(issueRevisionId: string, record: CompletionRecord, expectedVersion: number): Promise<void> {
    validateCompletionRecord(record);
    await this.lockIssueSelection(issueRevisionId);
    const before = await this.getCompletion(issueRevisionId);
    if ((before?.version ?? 0) !== expectedVersion) throw versionConflict('completion', issueRevisionId, expectedVersion, before?.version ?? 0);
    if (record.version !== expectedVersion + 1 || record.state === before?.state || (!before && record.state !== 'completed')) throw validation('completion', 'invalid completion transition');
    await this.client.run('INSERT INTO issue_completion_versions (issue_revision_id, version, state, record_digest, record_json) VALUES (?, ?, ?, ?, ?)', [issueRevisionId, record.version, record.state, sha256(record), json(record)]);
  }

  async getSelection(issueRevisionId: string): Promise<SelectionRecord | undefined> {
    const row = await this.client.get("SELECT * FROM selections WHERE issue_revision_id = ?", [issueRevisionId]);
    if (!row) return undefined;
    try {
      const record: SelectionRecord = {
        id: asText(row.id), issue_revision_id: asText(row.issue_revision_id), version: safeInteger(row.version, "selection.version"),
        updated_at: parseDate(row.updated_at), attribution: parseAttribution(row.attribution_json),
        ...(row.candidate_id == null ? {} : { candidate_id: asText(row.candidate_id), verification_at_selection: JSON.parse(asText(row.verification_json)) }),
        ...(row.reason == null ? {} : { reason: asText(row.reason) }),
      };
      if (!isUUIDv7(record.id) || !isUUIDv7(issueRevisionId) || record.issue_revision_id !== issueRevisionId || record.version < 1 || record.version > 2147483647) throw new Error("invalid selection identity or version");
      if (record.reason !== undefined && [...record.reason].length > 4096) throw new Error("selection reason exceeds its limit");
      if (record.candidate_id !== undefined) {
        if (!isUUIDv7(record.candidate_id)) throw new Error("invalid Candidate identity");
        const binding = requireRow(await this.client.get("SELECT issue_revision_id FROM candidates WHERE id = ?", [record.candidate_id]), "candidate", record.candidate_id);
        if (asText(binding.issue_revision_id) !== issueRevisionId) throw new Error("selected Candidate belongs to another Issue Version");
        const v = record.verification_at_selection;
        if (!validSelectionSnapshot(v)) throw new Error("invalid selection verification snapshot");
      } else if (row.verification_json != null) throw new Error("unselected record has verification snapshot");
      return record;
    } catch (error) { return persistedRecordError("database", asText(row.id), "stored Selection is invalid", error); }
  }

  async saveSelection(record: SelectionRecord, expectedVersion: number): Promise<void> {
    const values = [record.candidate_id ?? null, record.version, record.updated_at, json(record.attribution), record.reason ?? null, record.verification_at_selection ? json(record.verification_at_selection) : null];
    if (expectedVersion === 0) {
      await this.client.run("INSERT INTO selections (candidate_id, version, updated_at, attribution_json, reason, verification_json, id, issue_revision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [...values, record.id, record.issue_revision_id]);
    } else {
      const result = await this.client.run("UPDATE selections SET candidate_id = ?, version = ?, updated_at = ?, attribution_json = ?, reason = ?, verification_json = ? WHERE id = ? AND issue_revision_id = ? AND version = ?", [...values, record.id, record.issue_revision_id, expectedVersion]);
      if (result.changes !== 1) throw versionConflict("selection", record.id, expectedVersion, (await this.getSelection(record.issue_revision_id))?.version ?? 0);
    }
  }

  async lockRequirement(requirementId: string): Promise<void> {
    const suffix = this.client.dialect.forUpdate;
    requireRow(await this.client.get("SELECT id FROM requirements WHERE id = ?" + suffix, [requirementId]), "requirement", requirementId);
  }

  async createRequirement(requirement: RequirementRecord, revision: RevisionRecord): Promise<void> {
    await this.client.run("INSERT INTO requirements (id, created_at, attribution_json) VALUES (?, ?, ?)", [requirement.id, timestamp(requirement.created_at), json(requirement.attribution)]);
    await this.insertRequirementRevision(revision);
  }

  async getCurrentRequirementRevision(requirementId: string): Promise<RequirementRevision> {
    const row = await this.client.get<{ id: unknown }>("SELECT revision.id FROM requirement_revisions revision WHERE revision.requirement_id = ? AND NOT EXISTS (SELECT 1 FROM requirement_revisions successor WHERE successor.predecessor_revision_id = revision.id) ORDER BY revision.revision_number DESC LIMIT 1", [requirementId]);
    if (!row) throw notFound("requirement_revision", requirementId);
    return this.getRequirementRevision(requirementId, asText(row.id));
  }

  async appendRequirementRevision(revision: RevisionRecord): Promise<void> { await this.insertRequirementRevision(revision); }

  protected async insertRequirementRevision(record: RevisionRecord): Promise<void> {
    const revision = record.revision;
    await this.client.run("INSERT INTO requirement_revisions (id, requirement_id, predecessor_revision_id, revision_number, summary, context, created_at, attribution_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [revision.id, revision.requirement_id, revision.predecessor_revision_id ?? null, revision.revision_number, revision.summary, revision.context ?? null, timestamp(record.created_at), json(record.attribution)]);
    for (const [ordinal, statement] of revision.outcomes.entries()) await this.client.run("INSERT INTO requirement_outcomes (requirement_revision_id, ordinal, statement) VALUES (?, ?, ?)", [revision.id, ordinal, statement]);
    for (const [ordinal, decision] of revision.decisions.entries()) {
      const details = decisionDetails(decision);
      await this.client.run("INSERT INTO requirement_decisions (requirement_revision_id, ordinal, statement, rationale, details_json) VALUES (?, ?, ?, ?, ?)", [revision.id, ordinal, decision.statement, decision.rationale ?? null, Object.keys(details).length ? json(details) : null]);
    }
    for (const [ordinal, question] of (revision.open_questions ?? []).entries()) await this.client.run("INSERT INTO requirement_open_questions (requirement_revision_id, ordinal, question, blocking, assumption) VALUES (?, ?, ?, ?, ?)", [revision.id, ordinal, question.question, question.blocking ? 1 : 0, question.assumption ?? null]);
  }

  async getRequirementRevision(requirementId: string, revisionId: string): Promise<RequirementRevision> {
    const row = await this.client.get<Record<string, unknown>>(`SELECT id, requirement_id, predecessor_revision_id, ${this.integerText("revision_number")} AS revision_number, summary, context, created_at, attribution_json FROM requirement_revisions WHERE requirement_id = ? AND id = ?`, [requirementId, revisionId]);
    const base = requireRow(row, "requirement_revision", revisionId);
    const outcomes = await this.client.all<{ ordinal: unknown; statement: unknown }>("SELECT ordinal, statement FROM requirement_outcomes WHERE requirement_revision_id = ? ORDER BY ordinal", [revisionId]);
    const decisions = await this.client.all<{ ordinal: unknown; statement: unknown; rationale: unknown; details_json: unknown }>("SELECT ordinal, statement, rationale, details_json FROM requirement_decisions WHERE requirement_revision_id = ? ORDER BY ordinal", [revisionId]);
    const questions = await this.client.all<{ ordinal: unknown; question: unknown; blocking: unknown; assumption: unknown }>("SELECT ordinal, question, blocking, assumption FROM requirement_open_questions WHERE requirement_revision_id = ? ORDER BY ordinal", [revisionId]);
    validateContiguousOrdinals(outcomes.map((item) => item.ordinal), "requirement_outcome.ordinal", revisionId);
    validateContiguousOrdinals(decisions.map((item) => item.ordinal), "requirement_decision.ordinal", revisionId);
    validateContiguousOrdinals(questions.map((item) => item.ordinal), "requirement_open_question.ordinal", revisionId);
    const revision: RequirementRevision = {
      id: asText(base.id), requirement_id: asText(base.requirement_id), revision_number: safeInteger(base.revision_number, "revision_number", 1),
      summary: asText(base.summary), outcomes: outcomes.map((item) => asText(item.statement)),
      decisions: decisions.map((item) => {
        try {
          const details: unknown = item.details_json == null ? {} : JSON.parse(asText(item.details_json));
          if (!details || typeof details !== "object" || Array.isArray(details) || Object.keys(details).some((key) => !["context", "options", "chosen_option", "trade_offs", "consequences"].includes(key))) throw new Error("invalid Decision details");
          const decision: Decision = { ...details, statement: asText(item.statement), ...(item.rationale == null ? {} : { rationale: asText(item.rationale) }) };
          validateDecision(decision);
          return decision;
        } catch (error) {
          return persistedRecordError("requirement_revision", revisionId, "stored Decision is invalid", error);
        }
      }),
      ...(questions.length ? { open_questions: questions.map((item) => ({ question: asText(item.question), blocking: Number(item.blocking) === 1, ...(item.assumption === null || item.assumption === undefined ? {} : { assumption: asText(item.assumption) }) })) } : {}),
    };
    if (base.predecessor_revision_id !== null && base.predecessor_revision_id !== undefined) revision.predecessor_revision_id = asText(base.predecessor_revision_id);
    if (base.context !== null && base.context !== undefined) revision.context = asText(base.context);
    if (!isUUIDv7(revision.id) || !isUUIDv7(revision.requirement_id) || !isUUIDv7(revisionId) || (revision.predecessor_revision_id !== undefined && !isUUIDv7(revision.predecessor_revision_id))) {
      persistedArtifactError("RequirementRevision identifiers are invalid", revisionId);
    }
    try {
      parseDate(base.created_at);
      parseAttribution(base.attribution_json);
      await this.validateRequirementRevisionLineage(revision);
      validateRequirementInput({ format: 1, summary: revision.summary, ...(revision.context === undefined ? {} : { context: revision.context }), outcomes: revision.outcomes, decisions: revision.decisions });
    } catch (error) {
      persistedRecordError("requirement_revision", revisionId, "stored RequirementRevision is invalid", error);
    }
    return revision;
  }

  async createRepository(repository: RepositoryRecord): Promise<void> {
    if (this.remoteIndexed) await this.client.run("INSERT INTO repositories (id, canonical_remote, canonical_remote_digest, version, created_at, attribution_json) VALUES (?, ?, ?, ?, ?, ?)", [repository.id, repository.canonical_remote, this.remoteDigest(repository.canonical_remote), repository.version, repository.created_at, json(repository.attribution)]);
    else await this.client.run("INSERT INTO repositories (id, canonical_remote, version, created_at, attribution_json) VALUES (?, ?, ?, ?, ?)", [repository.id, repository.canonical_remote, repository.version, repository.created_at, json(repository.attribution)]);
    await this.insertRemote(repository.id, repository.canonical_remote, "active");
  }

  async ensureRepository(repository: RepositoryRecord): Promise<{ repository: RepositoryRecord; created: boolean }> {
    try {
      return { repository: await this.findRepositoryByRemote(repository.canonical_remote), created: false };
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") throw error;
    }
    // No exact match: a Repository sharing this transport-agnostic key already
    // denotes the same host and path, so resolve to it rather than duplicate.
    // The scan shares the write transaction; >1 key match is a pre-existing
    // duplicate, refused instead of adding a third.
    const keyed = repositoryIdsByMatchKey(await readActiveRepositoryRemoteBindings(this.client), repository.canonical_remote);
    if (keyed.length > 1) throw repositoryAmbiguous("multiple registered repositories share this host and path; reconcile the duplicates before registering again");
    if (keyed.length === 1) return { repository: await this.getRepository(keyed[0]!), created: false };

    // A canonical remote is unique across canonical and alias rows. Use a
    // savepoint so concurrent first registration can lose the insert race
    // without aborting the surrounding Quickstart transaction.
    await this.client.exec("SAVEPOINT patchledger_ensure_repository");
    try {
      await this.createRepository(repository);
      await this.client.exec("RELEASE SAVEPOINT patchledger_ensure_repository");
      return { repository, created: true };
    } catch (error) {
      await this.client.exec("ROLLBACK TO SAVEPOINT patchledger_ensure_repository");
      await this.client.exec("RELEASE SAVEPOINT patchledger_ensure_repository");
      if (!isDuplicateKeyError(error)) throw error;
      try {
        return { repository: await this.findRepositoryByRemote(repository.canonical_remote), created: false };
      } catch (lookupError) {
        if (lookupError instanceof DomainError && lookupError.code === "NOT_FOUND") {
          throw validation("remote", "is already registered as an inactive Repository remote");
        }
        throw lookupError;
      }
    }
  }

  /** One read of every active remote (canonical and alias) so transport-agnostic
   * matching can compare by key inside a single transaction.  Retired aliases
   * are excluded: they keep history and must not match. */
  async listActiveRepositoryRemoteBindings(): Promise<RepositoryRemoteBinding[]> {
    return readActiveRepositoryRemoteBindings(this.client);
  }
  /** Reject a canonical/alias remote whose key another Repository already uses. */
  protected async assertNoForeignKeyConflict(repositoryId: string, remote: string, field: string): Promise<void> {
    if (hasForeignKeyConflict(await readActiveRepositoryRemoteBindings(this.client), repositoryId, remote)) throw validation(field, "matches another Repository's remote on the same host and path");
  }
  // The digest is an index aid for engines that cannot index an unbounded
  // remote.  The raw remote always stays in the predicate, so a colliding or
  // corrupted digest cannot resolve a different Repository.
  protected get remoteIndexed(): boolean { return this.client.dialect.needsRemoteDigest; }
  /**
   * WHERE clause and parameters that select one stored remote.  Engines that
   * index a digest also keep the raw remote in the predicate, so a colliding or
   * corrupted digest can never match a different Repository's remote.
   */
  protected remoteWhere(): string { return this.remoteIndexed ? "remote_digest = ? AND remote = ?" : "remote = ?"; }
  protected remoteParams(remote: string): unknown[] { return this.remoteIndexed ? [this.remoteDigest(remote), remote] : [remote]; }
  protected remoteDigest(remote: string): Buffer { return createHash("sha256").update(remote, "utf8").digest(); }
  protected async insertRemote(repositoryId: string, remote: string, state: "active" | "retired"): Promise<void> {
    if (this.remoteIndexed) await this.client.run("INSERT INTO repository_remotes (repository_id, remote, remote_digest, state) VALUES (?, ?, ?, ?)", [repositoryId, remote, this.remoteDigest(remote), state]);
    else await this.client.run("INSERT INTO repository_remotes (repository_id, remote, state) VALUES (?, ?, ?)", [repositoryId, remote, state]);
  }

  async findRepositoryByRemote(remote: string): Promise<RepositoryRecord> {
    // The digest is an index, not the identity.  Keep the raw remote in the
    // predicate as well so a corrupted/colliding digest cannot resolve a
    // different Repository.
    const digest = this.client.dialect.remoteDigestExpression("r.canonical_remote_digest");
    const predicate = this.remoteIndexed
      ? "rr.remote_digest = ? AND rr.remote = ?"
      : "rr.remote = ?";
    const sql = `SELECT r.id, r.canonical_remote, ${digest} AS canonical_remote_digest, ${this.integerText("r.version")} AS version, r.created_at, r.attribution_json FROM repositories r JOIN repository_remotes rr ON rr.repository_id = r.id WHERE ${predicate} AND rr.state = 'active'`;
    const repository = this.repositoryFromRow(requireRow(await this.client.get<Record<string, unknown>>(sql, this.remoteIndexed ? [this.remoteDigest(remote), remote] : [remote]), "repository", remote));
    await this.validateRepositoryRemoteBinding(repository);
    return repository;
  }

  async getRepository(repositoryId: string): Promise<RepositoryRecord> {
    const digest = this.client.dialect.remoteDigestExpression("canonical_remote_digest");
    const repository = this.repositoryFromRow(requireRow(await this.client.get<Record<string, unknown>>(`SELECT id, canonical_remote, ${digest} AS canonical_remote_digest, ${this.integerText("version")} AS version, created_at, attribution_json FROM repositories WHERE id = ?`, [repositoryId]), "repository", repositoryId));
    await this.validateRepositoryRemoteBinding(repository);
    return repository;
  }

  protected repositoryFromRow(row: Record<string, unknown>): RepositoryRecord {
    const resourceId = asText(row.id);
    try {
      const repository: RepositoryRecord = { id: resourceId, canonical_remote: asText(row.canonical_remote), version: safeInteger(row.version, "version", 1), created_at: parseDate(row.created_at), attribution: parseAttribution(row.attribution_json) };
      if (!isUUIDv7(repository.id)) throw new Error("Repository identifier is invalid");
      validateCanonicalRemote(repository.canonical_remote);
      if (this.remoteIndexed && !asDigestBuffer(row.canonical_remote_digest).equals(this.remoteDigest(repository.canonical_remote))) throw new Error("Repository canonical remote digest is invalid");
      return repository;
    } catch (error) {
      return persistedRecordError("repository", resourceId, "stored Repository is invalid", error);
    }
  }

  protected async readRepositoryRemotes(repositoryId: string): Promise<RepositoryRemoteRecord[]> {
    const digest = this.remoteIndexed ? ", remote_digest" : "";
    const rows = await this.client.all<{ remote: unknown; state: unknown; remote_digest?: unknown }>(`SELECT remote, state${digest} FROM repository_remotes WHERE repository_id = ? ORDER BY remote LIMIT 1001`, [repositoryId]);
    if (rows.length > 1000) throw new DomainError("ARTIFACT_TOO_LARGE", "Repository alias list exceeds 1,000 entries");
    try {
      const seen = new Set<string>();
      return rows.map((row) => {
        const remote = asText(row.remote);
        const state = asText(row.state);
        validateCanonicalRemote(remote);
        if (state !== "active" && state !== "retired") throw new Error("Repository alias state is invalid");
        if (this.remoteIndexed && !asDigestBuffer(row.remote_digest).equals(this.remoteDigest(remote))) throw new Error("Repository alias digest is invalid");
        if (seen.has(remote)) throw new Error("Repository alias is duplicated");
        seen.add(remote);
        return { remote, state };
      });
    } catch (error) {
      return persistedRecordError("repository", repositoryId, "stored Repository aliases are invalid", error);
    }
  }

  protected async validateRepositoryRemoteBinding(repository: RepositoryRecord): Promise<void> {
    const remotes = await this.readRepositoryRemotes(repository.id);
    if (!remotes.some((remote) => remote.remote === repository.canonical_remote && remote.state === "active")) {
      persistedRecordError("repository", repository.id, "stored Repository canonical remote is not active", new Error("canonical remote is missing or retired from repository_remotes"));
    }
  }

  async listRepositoryRemotes(repositoryId: string): Promise<RepositoryRemoteRecord[]> {
    return this.readRepositoryRemotes(repositoryId);
  }

  async createIssue(issue: IssueRecord, revision: IssueRevisionRecord): Promise<void> {
    await this.client.run("INSERT INTO issues (id, requirement_id, repository_id, created_at, attribution_json) VALUES (?, ?, ?, ?, ?)", [issue.id, issue.requirement_id, issue.repository_id, issue.created_at, json(issue.attribution)]);
    await this.insertIssueRevision(revision);
  }

  async getIssue(issueId: string): Promise<IssueRecord> {
    const row = requireRow(await this.client.get<Record<string, unknown>>("SELECT id, requirement_id, repository_id, created_at, attribution_json FROM issues WHERE id = ?", [issueId]), "issue", issueId);
    const resourceId = asText(row.id);
    try {
      const issue: IssueRecord = { id: resourceId, requirement_id: asText(row.requirement_id), repository_id: asText(row.repository_id), created_at: parseDate(row.created_at), attribution: parseAttribution(row.attribution_json) };
      if (!isUUIDv7(issue.id) || issue.id !== issueId || !isUUIDv7(issue.requirement_id) || !isUUIDv7(issue.repository_id)) throw new Error("Issue identifiers are invalid");
      return issue;
    } catch (error) {
      return persistedRecordError("issue", resourceId, "stored Issue is invalid", error);
    }
  }

  async getCurrentIssueRevision(issueId: string): Promise<IssueRevision> {
    const row = await this.client.get<{ id: unknown }>("SELECT revision.id FROM issue_revisions revision WHERE revision.issue_id = ? AND NOT EXISTS (SELECT 1 FROM issue_revisions successor WHERE successor.predecessor_revision_id = revision.id) ORDER BY revision.revision_number DESC LIMIT 1", [issueId]);
    if (!row) throw notFound("issue_revision", issueId);
    return this.getIssueRevision(issueId, asText(row.id));
  }

  async getIssueRevision(issueId: string, revisionId: string): Promise<IssueRevision> {
    const row = await this.client.get<Record<string, unknown>>(`SELECT id, issue_id, requirement_id, requirement_revision_id, predecessor_revision_id, ${this.integerText("revision_number")} AS revision_number, baseline_oid, baseline_reachability, baseline_warning, baseline_override_reason, summary, context, plan, created_at, attribution_json FROM issue_revisions WHERE issue_id = ? AND id = ?`, [issueId, revisionId]);
    return this.issueRevisionFromRow(requireRow(row, "issue_revision", revisionId));
  }

  async getIssueRevisionById(revisionId: string): Promise<IssueRevision> {
    const row = await this.client.get<Record<string, unknown>>(`SELECT id, issue_id, requirement_id, requirement_revision_id, predecessor_revision_id, ${this.integerText("revision_number")} AS revision_number, baseline_oid, baseline_reachability, baseline_warning, baseline_override_reason, summary, context, plan, created_at, attribution_json FROM issue_revisions WHERE id = ?`, [revisionId]);
    return this.issueRevisionFromRow(requireRow(row, "issue_revision", revisionId));
  }

  protected async insertIssueRevision(record: IssueRevisionRecord): Promise<void> {
    const revision = record.revision;
    await this.client.run("INSERT INTO issue_revisions (id, issue_id, requirement_id, requirement_revision_id, predecessor_revision_id, revision_number, baseline_oid, baseline_reachability, baseline_warning, baseline_override_reason, summary, context, plan, created_at, attribution_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [revision.id, revision.issue_id, revision.requirement_id, revision.requirement_revision_id, revision.predecessor_revision_id ?? null, revision.revision_number, revision.baseline.git_oid, revision.baseline.reachability, revision.baseline.warning ?? null, revision.baseline.override_reason ?? null, revision.summary, revision.context ?? null, revision.plan ?? null, record.created_at, json(record.attribution)]);
    if (revision.target_branch) await this.client.run("INSERT INTO issue_target_branches (issue_revision_id, remote_name, branch_ref) VALUES (?, ?, ?)", [revision.id, revision.target_branch.remote, revision.target_branch.ref]);
    for (const [ordinal, goal] of revision.goals.entries()) {
      await this.client.run("INSERT INTO goals (id, issue_revision_id, ordinal, statement) VALUES (?, ?, ?, ?)", [goal.id, revision.id, ordinal, goal.statement]);
      await this.insertTargetChildren(revision.id, "goal", goal.id, goal.criteria, goal.guidance, goal.traces_to ?? []);
    }
    for (const [ordinal, constraint] of revision.constraints.entries()) {
      await this.client.run("INSERT INTO constraints (id, issue_revision_id, ordinal, statement, rationale) VALUES (?, ?, ?, ?, ?)", [constraint.id, revision.id, ordinal, constraint.statement, constraint.rationale ?? null]);
      await this.insertTargetChildren(revision.id, "constraint", constraint.id, constraint.criteria, constraint.guidance, constraint.traces_to ?? []);
    }
  }

  protected async insertTargetChildren(issueRevisionId: string, targetType: "goal" | "constraint", targetId: string, criteria: { id: string; statement: string }[], guidance: string[], links: IntentLink[]): Promise<void> {
    for (const [ordinal, criterion] of criteria.entries()) await this.client.run("INSERT INTO criteria (id, issue_revision_id, target_type, target_id, ordinal, statement) VALUES (?, ?, ?, ?, ?, ?)", [criterion.id, issueRevisionId, targetType, targetId, ordinal, criterion.statement]);
    for (const [ordinal, statement] of guidance.entries()) await this.client.run("INSERT INTO target_guidance (issue_revision_id, target_type, target_id, ordinal, statement) VALUES (?, ?, ?, ?, ?)", [issueRevisionId, targetType, targetId, ordinal, statement]);
    for (const [ordinal, link] of links.entries()) await this.client.run("INSERT INTO intent_links (issue_revision_id, target_type, target_id, ordinal, intent_type, intent_ordinal) VALUES (?, ?, ?, ?, ?, ?)", [issueRevisionId, targetType, targetId, ordinal, link.type, link.ordinal]);
  }

  protected async validateRequirementRevisionLineage(revision: RequirementRevision): Promise<void> {
    const aggregate = await this.client.get<{ id: unknown }>("SELECT id FROM requirements WHERE id = ?", [revision.requirement_id]);
    if (!aggregate || asText(aggregate.id) !== revision.requirement_id || !isUUIDv7(asText(aggregate.id))) throw new Error("RequirementRevision parent Requirement is missing");
    const seen = new Set<string>([revision.id]);
    let predecessor = revision.predecessor_revision_id;
    let expectedNumber = revision.revision_number - 1;
    while (predecessor !== undefined) {
      if (expectedNumber < 1) throw new Error("RequirementRevision lineage has an invalid predecessor number");
      if (!isUUIDv7(predecessor) || seen.has(predecessor)) throw new Error("RequirementRevision lineage is cyclic or duplicated");
      const row = await this.client.get<Record<string, unknown>>(`SELECT id, requirement_id, predecessor_revision_id, ${this.integerText("revision_number")} AS revision_number FROM requirement_revisions WHERE id = ?`, [predecessor]);
      if (!row) throw new Error("RequirementRevision predecessor is missing");
      const id = asText(row.id);
      const parentRequirementId = asText(row.requirement_id);
      const number = safeInteger(row.revision_number, "revision_number", 1);
      if (id !== predecessor || !isUUIDv7(id) || parentRequirementId !== revision.requirement_id || !isUUIDv7(parentRequirementId) || number !== expectedNumber) throw new Error("RequirementRevision predecessor does not form a contiguous same-Requirement chain");
      const next = asOptionalText(row.predecessor_revision_id);
      if (next !== undefined && (!isUUIDv7(next) || seen.has(next))) throw new Error("RequirementRevision lineage is cyclic or duplicated");
      seen.add(id);
      predecessor = next;
      expectedNumber -= 1;
    }
    if (expectedNumber !== 0) throw new Error("RequirementRevision lineage does not terminate at revision 1");
  }

  protected async validateIssueRevisionLineage(revision: IssueRevision): Promise<RequirementRevision> {
    const issue = await this.client.get<{ id: unknown; requirement_id: unknown }>("SELECT id, requirement_id FROM issues WHERE id = ?", [revision.issue_id]);
    if (!issue || asText(issue.id) !== revision.issue_id || !isUUIDv7(asText(issue.id)) || asText(issue.requirement_id) !== revision.requirement_id || !isUUIDv7(asText(issue.requirement_id))) throw new Error("IssueRevision parent Issue is missing or belongs to another Requirement");
    const requirementRevision = await this.getRequirementRevision(revision.requirement_id, revision.requirement_revision_id);
    if (requirementRevision.id !== revision.requirement_revision_id || requirementRevision.requirement_id !== revision.requirement_id) throw new Error("IssueRevision RequirementRevision binding is invalid");
    const seen = new Set<string>([revision.id]);
    let predecessor = revision.predecessor_revision_id;
    let expectedNumber = revision.revision_number - 1;
    while (predecessor !== undefined) {
      if (expectedNumber < 1) throw new Error("IssueRevision lineage has an invalid predecessor number");
      if (!isUUIDv7(predecessor) || seen.has(predecessor)) throw new Error("IssueRevision lineage is cyclic or duplicated");
      const row = await this.client.get<Record<string, unknown>>(`SELECT id, issue_id, requirement_id, requirement_revision_id, predecessor_revision_id, ${this.integerText("revision_number")} AS revision_number FROM issue_revisions WHERE id = ?`, [predecessor]);
      if (!row) throw new Error("IssueRevision predecessor is missing");
      const id = asText(row.id);
      const parentIssueId = asText(row.issue_id);
      const parentRequirementId = asText(row.requirement_id);
      const parentRequirementRevisionId = asText(row.requirement_revision_id);
      const number = safeInteger(row.revision_number, "revision_number", 1);
      if (id !== predecessor || !isUUIDv7(id) || parentIssueId !== revision.issue_id || !isUUIDv7(parentIssueId) || parentRequirementId !== revision.requirement_id || !isUUIDv7(parentRequirementId) || !isUUIDv7(parentRequirementRevisionId) || number !== expectedNumber) throw new Error("IssueRevision predecessor does not form a contiguous same-Issue chain");
      const next = asOptionalText(row.predecessor_revision_id);
      if (next !== undefined && (!isUUIDv7(next) || seen.has(next))) throw new Error("IssueRevision lineage is cyclic or duplicated");
      seen.add(id);
      predecessor = next;
      expectedNumber -= 1;
    }
    if (expectedNumber !== 0) throw new Error("IssueRevision lineage does not terminate at revision 1");
    return requirementRevision;
  }

  protected async validateIssueTargetBindings(revision: IssueRevision): Promise<void> {
    const targets = new Set<string>();
    const targetIds = new Set<string>();
    for (const goal of revision.goals) {
      const key = `goal:${goal.id}`;
      if (targets.has(key) || targetIds.has(goal.id)) throw new Error("IssueRevision target IDs are duplicated");
      targets.add(key);
      targetIds.add(goal.id);
    }
    for (const constraint of revision.constraints) {
      const key = `constraint:${constraint.id}`;
      if (targets.has(key) || targetIds.has(constraint.id)) throw new Error("IssueRevision target IDs are duplicated");
      targets.add(key);
      targetIds.add(constraint.id);
    }
    const orphanCriteria = await this.client.all<{ id: unknown; target_type: unknown; target_id: unknown }>("SELECT id, target_type, target_id FROM criteria WHERE issue_revision_id = ?", [revision.id]);
    for (const row of orphanCriteria) {
      const key = `${asText(row.target_type)}:${asText(row.target_id)}`;
      if (!targets.has(key)) throw new Error("IssueRevision contains a Criterion bound to an unknown target");
    }
    const orphanGuidance = await this.client.all<{ target_type: unknown; target_id: unknown }>("SELECT target_type, target_id FROM target_guidance WHERE issue_revision_id = ?", [revision.id]);
    for (const row of orphanGuidance) {
      const key = `${asText(row.target_type)}:${asText(row.target_id)}`;
      if (!targets.has(key)) throw new Error("IssueRevision contains Guidance bound to an unknown target");
    }
    const orphanLinks = await this.client.all<{ target_type: unknown; target_id: unknown }>("SELECT target_type, target_id FROM intent_links WHERE issue_revision_id = ?", [revision.id]);
    for (const row of orphanLinks) {
      const key = `${asText(row.target_type)}:${asText(row.target_id)}`;
      if (!targets.has(key)) throw new Error("IssueRevision contains an Intent Link bound to an unknown target");
    }
  }

  protected async issueRevisionFromRow(row: Record<string, unknown>): Promise<IssueRevision> {
    const revision: IssueRevision = {
      id: asText(row.id), issue_id: asText(row.issue_id), requirement_id: asText(row.requirement_id), requirement_revision_id: asText(row.requirement_revision_id), revision_number: safeInteger(row.revision_number, "revision_number", 1),
      baseline: { git_oid: asText(row.baseline_oid), reachability: asText(row.baseline_reachability) as Baseline["reachability"] }, summary: asText(row.summary), goals: [], constraints: [],
    };
    if (row.predecessor_revision_id !== null && row.predecessor_revision_id !== undefined) revision.predecessor_revision_id = asText(row.predecessor_revision_id);
    const target = this.hasTargetBranches ? await this.client.get<{ remote_name: unknown; branch_ref: unknown }>("SELECT remote_name, branch_ref FROM issue_target_branches WHERE issue_revision_id = ?", [revision.id]) : undefined;
    if (target) revision.target_branch = { remote: asText(target.remote_name), ref: asText(target.branch_ref) };
    if (row.baseline_warning !== null && row.baseline_warning !== undefined) revision.baseline.warning = asText(row.baseline_warning);
    if (row.baseline_override_reason !== null && row.baseline_override_reason !== undefined) revision.baseline.override_reason = asText(row.baseline_override_reason);
    if (row.context !== null && row.context !== undefined) revision.context = asText(row.context);
    if (row.plan !== null && row.plan !== undefined) revision.plan = asText(row.plan);
    const goals = await this.client.all<{ id: unknown; statement: unknown; ordinal: unknown }>("SELECT id, statement, ordinal FROM goals WHERE issue_revision_id = ? ORDER BY ordinal", [revision.id]);
    const constraints = await this.client.all<{ id: unknown; statement: unknown; ordinal: unknown; rationale: unknown }>("SELECT id, statement, ordinal, rationale FROM constraints WHERE issue_revision_id = ? ORDER BY ordinal", [revision.id]);
    validateContiguousOrdinals(goals.map((goal) => goal.ordinal), "goal.ordinal", revision.id);
    validateContiguousOrdinals(constraints.map((constraint) => constraint.ordinal), "constraint.ordinal", revision.id);
    if (goals.length === 0) persistedArtifactError("IssueRevision must contain at least one Goal", revision.id);
    for (const rowGoal of goals) {
      const targetId = asText(rowGoal.id);
      const links = await this.readIntentLinks(revision.id, "goal", targetId);
      revision.goals.push({ id: targetId, statement: asText(rowGoal.statement), criteria: await this.readCriteria(revision.id, "goal", targetId), guidance: await this.readGuidance(revision.id, "goal", targetId), ...(links.length ? { traces_to: links } : {}) });
    }
    for (const rowConstraint of constraints) {
      const targetId = asText(rowConstraint.id);
      const links = await this.readIntentLinks(revision.id, "constraint", targetId);
      revision.constraints.push({ id: targetId, statement: asText(rowConstraint.statement), ...(asOptionalText(rowConstraint.rationale) === undefined ? {} : { rationale: asOptionalText(rowConstraint.rationale) }), criteria: await this.readCriteria(revision.id, "constraint", targetId), guidance: await this.readGuidance(revision.id, "constraint", targetId), ...(links.length ? { traces_to: links } : {}) });
    }
    if (![revision.id, revision.issue_id, revision.requirement_id, revision.requirement_revision_id, ...(revision.predecessor_revision_id === undefined ? [] : [revision.predecessor_revision_id]), ...revision.goals.flatMap((goal) => [goal.id, ...goal.criteria.map((criterion) => criterion.id)]), ...revision.constraints.flatMap((constraint) => [constraint.id, ...constraint.criteria.map((criterion) => criterion.id)])].every(isUUIDv7)) {
      persistedArtifactError("IssueRevision identifiers are invalid", revision.id);
    }
    try {
      parseDate(row.created_at);
      parseAttribution(row.attribution_json);
      const requirement = await this.validateIssueRevisionLineage(revision);
      await this.validateIssueTargetBindings(revision);
      validateBaseline(revision.baseline);
      validateIssueInput({ format: 1, ...(revision.target_branch ? { target_branch: revision.target_branch } : {}), summary: revision.summary, ...(revision.context === undefined ? {} : { context: revision.context }), goals: revision.goals.map((goal) => ({ statement: goal.statement, criteria: goal.criteria.map((criterion) => criterion.statement), ...(goal.traces_to ? { traces_to: goal.traces_to } : {}), ...(goal.guidance.length ? { guidance: goal.guidance } : {}) })), constraints: revision.constraints.map((constraint) => ({ statement: constraint.statement, ...(constraint.rationale === undefined ? {} : { rationale: constraint.rationale }), criteria: constraint.criteria.map((criterion) => criterion.statement), ...(constraint.traces_to ? { traces_to: constraint.traces_to } : {}), ...(constraint.guidance.length ? { guidance: constraint.guidance } : {}) })) });
      validateIssueIntentLinks(revision, requirement);
    } catch (error) {
      persistedRecordError("issue_revision", revision.id, "stored IssueRevision is invalid", error);
    }
    return revision;
  }

  protected async readCriteria(issueRevisionId: string, targetType: string, targetId: string): Promise<{ id: string; statement: string }[]> {
    const rows = await this.client.all<{ id: unknown; statement: unknown; ordinal: unknown }>("SELECT id, statement, ordinal FROM criteria WHERE issue_revision_id = ? AND target_type = ? AND target_id = ? ORDER BY ordinal", [issueRevisionId, targetType, targetId]);
    validateContiguousOrdinals(rows.map((row) => row.ordinal), "criterion.ordinal", issueRevisionId);
    if (rows.length === 0) persistedArtifactError(`IssueRevision ${targetType} ${targetId} must contain at least one Criterion`, issueRevisionId);
    return rows.map((row) => ({ id: asText(row.id), statement: asText(row.statement) }));
  }

  protected async readGuidance(issueRevisionId: string, targetType: string, targetId: string): Promise<string[]> {
    const rows = await this.client.all<{ statement: unknown; ordinal: unknown }>("SELECT statement, ordinal FROM target_guidance WHERE issue_revision_id = ? AND target_type = ? AND target_id = ? ORDER BY ordinal", [issueRevisionId, targetType, targetId]);
    validateContiguousOrdinals(rows.map((row) => row.ordinal), "guidance.ordinal", issueRevisionId);
    return rows.map((row) => asText(row.statement));
  }

  protected async readIntentLinks(issueRevisionId: string, targetType: string, targetId: string): Promise<IntentLink[]> {
    const rows = await this.client.all<{ intent_type: unknown; intent_ordinal: unknown; ordinal: unknown }>(`SELECT intent_type, ${this.integerText("intent_ordinal")} AS intent_ordinal, ${this.integerText("ordinal")} AS ordinal FROM intent_links WHERE issue_revision_id = ? AND target_type = ? AND target_id = ? ORDER BY intent_links.ordinal LIMIT 201`, [issueRevisionId, targetType, targetId]);
    if (rows.length > 200) persistedArtifactError(`IssueRevision ${targetType} ${targetId} contains too many Intent Links`, issueRevisionId);
    validateContiguousOrdinals(rows.map((row) => row.ordinal), "intent_link.ordinal", issueRevisionId);
    return rows.map((row) => ({ type: asText(row.intent_type) as IntentLink["type"], ordinal: safeInteger(row.intent_ordinal, "intent_ordinal", 1) }));
  }

  async appendIssueRevision(revision: IssueRevisionRecord): Promise<void> { await this.insertIssueRevision(revision); }

}
