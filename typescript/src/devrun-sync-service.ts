import { resolveBaseline } from "./git.js";
import { existsSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { sha256 } from "./canonical-json.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { validation, DomainError } from "./errors.js";
import { isGitOID, isUUIDv7, newUUIDv7 } from "./identity.js";
import type { Store, Tx } from "./store-types.js";
import { type RuntimeRecord, runtimeGet } from "./runtime-record.js";
import type { DevWorktreeModule } from "./dev-worktree.js";
import { syncData, syncTerminal, type DevRunSync } from "./devrun-sync-record.js";
import { observeBranch, targetRelation } from "./integration-observation.js";
import { assertTargetBase } from "./target-branch.js";
import { savePreparation } from "./preflight.js";
import { prepareLocalSync, initializeLocalSync, readLocalSync, applyLocalSync, completeLocalSync, abandonLocalSync, type LocalSync, type SyncCheckpoint } from "./sync-worktree.js";

interface Actor { operation_id: string; attribution: Attribution }
type Decisions = { path: string; explanation: string }[];
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
const actorCheck = (actor: Actor): void => { if (!isUUIDv7(actor.operation_id)) throw validation("operation_id", "UUIDv7 required"); validateAttribution(actor.attribution); };

export interface SyncWorkspace {
  repositoryRoot: string;
  withSyncWorktree: DevWorktreeModule["withSyncWorktree"];
  inspect?: DevWorktreeModule["inspect"];
  withStatus?<T>(runId: string, action: () => Promise<T>): Promise<T>;
}

/** Coordinates the existing per-DevRun local mutex, durable SQL fence and file journal. */
export class DevRunSyncService {
  private readonly host = `${hostname()}:${process.getuid?.() ?? "unknown"}`;
  constructor(private readonly store: Store, private readonly worktrees: SyncWorkspace, private readonly checkpoint: SyncCheckpoint = () => {}) {}

  async show(id: string): Promise<RuntimeRecord> {
    const row = await this.store.read(tx => runtimeGet(tx, "runtime_operation", id)); syncData(row); return row;
  }
  private async subject(tx: Tx, runId: string) {
    const run = await tx.getDevRun(runId), revision = await tx.getIssueRevisionById(run.issue_revision_id);
    if (!revision.target_branch || !run.base_commit) throw validation("sync", "historical and pinned Eval flows cannot sync; a target-flow DevRun is required");
    const issue = await tx.getIssue(revision.issue_id), remoteRows = await tx.listRepositoryRemotes(issue.repository_id);
    // Retired aliases stay for exact matching only; key matching uses active remotes.
    const remotes = remoteRows.map(r => r.remote);
    const activeRemotes = remoteRows.filter(r => r.state === "active").map(r => r.remote);
    return { run, revision, target: revision.target_branch, repository_id: issue.repository_id, remotes, activeRemotes };
  }
  async status(runId: string, refresh = false) {
    const read = async () => {
      const subject = await this.store.read(tx => this.subject(tx, runId));
      const observation = observeBranch(this.worktrees.repositoryRoot, subject.target, subject.remotes, refresh, subject.activeRemotes);
      const rows = await this.store.read(tx => tx.listRuntimeRecords("runtime_operation", runId));
      return { dev_run_id: runId, base_commit: subject.run.base_commit!, ...(subject.run.development ? { development: subject.run.development, ...(this.worktrees.inspect ? { local_worktree: this.worktrees.inspect(runId) } : {}) } : {}), target_observation: observation,
        relation: observation.commit ? targetRelation(this.worktrees.repositoryRoot, subject.run.base_commit!, observation.commit.oid) : "unknown",
        syncs: rows.filter(r => r.data.format === "grounds.devrun-sync/v1").map(row => { syncData(row); return row; }) };
    };
    return this.worktrees.withStatus ? this.worktrees.withStatus(runId, read) : read();
  }
  private async audit(tx: Tx, row: RuntimeRecord, actor: Actor): Promise<void> {
    const sync = syncData(row), subject = await this.subject(tx, sync.dev_run_id);
    const points = [...JSON.stringify(row)];
    if (points.length > 96 * 4000) throw validation("sync.audit", "sync record exceeds the bounded audit envelope; preserve recovery material");
    const chunks: { name: string; value: string }[] = [];
    for (let i = 0; i < points.length; i += 4000) chunks.push({ name: `record_${String(chunks.length).padStart(3, "0")}`, value: points.slice(i, i + 4000).join("") });
    await tx.appendLedgerEvent({ event_id: newUUIDv7(), event_type: `devrun.sync.${sync.phase}`, event_version: 1, operation_id: actor.operation_id,
      repository_id: subject.repository_id, subject_type: "dev_run", subject_id: sync.dev_run_id, subject_version: subject.run.version, occurred_at: await tx.now(), attribution: actor.attribution,
      facts: [{ name: "sync_id", value: row.id }, { name: "record_parts", value: String(chunks.length) }, { name: "record_digest", value: sha256(row) }, ...chunks] });
  }
  private async operation(tx: Tx, actor: Actor, command: string, request: unknown, syncId: string): Promise<boolean> {
    const replay = await tx.reserveOperation({ id: actor.operation_id, command, request_hash: sha256(clean({ request, attribution: actor.attribution })) });
    if (!replay) await tx.completeOperation(actor.operation_id, JSON.stringify({ format: "patchledger.cli/v1", ok: true, operation_id: actor.operation_id,
      data: { result_type: "patchledger.result.devrun-sync/v1", command, sync_id: syncId }, warnings: [] }));
    return Boolean(replay);
  }
  private async advance(id: string, phase: DevRunSync["phase"], actor: Actor, fields: Record<string, unknown> = {}): Promise<RuntimeRecord> {
    return this.store.write(async tx => {
      const initial = await runtimeGet(tx, "runtime_operation", id); await tx.lockDevRun(syncData(initial).dev_run_id);
      const row = await runtimeGet(tx, "runtime_operation", id);
      if (syncData(row).phase === phase) return row;
      const old = row.version; row.version++; row.data = clean({ ...row.data, ...fields, phase });
      await tx.saveRuntimeRecord(row, old); await this.audit(tx, row, actor); return row;
    });
  }
  private async accept(id: string, version: number, actor: Actor, command: string, decisions: Decisions = []): Promise<RuntimeRecord> {
    actorCheck(actor);
    return this.store.write(async tx => {
      const row = await runtimeGet(tx, "runtime_operation", id); syncData(row);
      const replay = await this.operation(tx, actor, command, { id, version, decisions }, id);
      if (!replay && row.version !== version) conflict("sync version changed; inspect before choosing a recovery action");
      return row;
    });
  }
  private verifyLocation(row: RuntimeRecord, directory: string): void {
    const sync = syncData(row);
    if (sync.recovery.host_id !== this.host || sync.recovery.directory !== directory) conflict("return to the original sync host and recovery directory");
  }
  private material(local: LocalSync): string {
    return sha256(clean({ id: local.id, cwd: local.cwd, worktree_identity: local.worktree_identity, base: local.base, target: local.target, ...(local.development ? { development: local.development, source_head: local.source_head, already_integrated: local.already_integrated ?? false } : {}), merge: local.merge,
      original: local.original, desired: local.desired, original_index: local.original_index, desired_index: local.desired_index }));
  }
  private verifyJournal(row: RuntimeRecord, local: LocalSync, cwd: string): void {
    const sync = syncData(row);
    if (local.source_head !== sync.source_head || local.cwd !== realpathSync(cwd) || local.base !== sync.original_base || local.target !== sync.target
      || (sync.material_digest !== undefined && sync.material_digest !== this.material(local))) conflict("local recovery material does not match the canonical sync reservation; preserve it for inspection");
  }
  private async finish(row: RuntimeRecord, local: LocalSync, actor: Actor, outcome: "completed" | "abandoned", decisions: Decisions): Promise<RuntimeRecord> {
    if (!local.receipt || local.phase !== (outcome === "completed" ? "completing" : "abandoned")) conflict("a real local completion/restoration receipt is required");
    row = await this.advance(row.id, outcome === "completed" ? "completing" : "abandoning", actor, { decisions });
    this.checkpoint("before-sql-finish");
    const finished = await this.store.write(async tx => {
      await tx.finishDevRunSync(row.id, row.version, local.receipt!.digest, decisions, outcome, actor.attribution);
      const value = await runtimeGet(tx, "runtime_operation", row.id); await this.audit(tx, value, actor); return value;
    });
    this.checkpoint("after-sql-finish"); return finished;
  }
  private async ready(row: RuntimeRecord, local: LocalSync, actor: Actor): Promise<RuntimeRecord> {
    if (syncData(row).phase === "reserved") {
      if (!local.merge || !local.original || !local.desired || local.phase !== "prepared") conflict("preparation was interrupted; explicitly abandon it to retain all edits");
      row = await this.advance(row.id, "prepared", actor, { material_digest: this.material(local), conflicts: local.merge!.conflicts.map(c => c.path) });
    }
    if (syncData(row).phase === "prepared") row = await this.advance(row.id, "applying", actor);
    return row;
  }
  async start(runId: string, expectedVersion: number, target: string, refresh: boolean, actor: Actor, expectedHead?: string): Promise<RuntimeRecord> {
    actorCheck(actor);
    if (!isGitOID(target) || !refresh) throw validation("sync.target", "sync requires a qualified expected target and explicit refresh");
    return this.worktrees.withSyncWorktree(runId, actor.operation_id, async local => {
      const request = { runId, expectedVersion, target, refresh, ...(expectedHead ? { expectedHead } : {}) };
      let row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", actor.operation_id));
      if (!row) {
        const subject = await this.store.read(tx => this.subject(tx, runId));
        if (subject.run.development && (!expectedHead || !isGitOID(expectedHead) || resolveBaseline(local.path, "HEAD") !== expectedHead)) conflict("managed branch sync requires the observed --expected-head; preserve changed source and refresh the decision");
        const observed = observeBranch(this.worktrees.repositoryRoot, subject.target, subject.remotes, true, subject.activeRemotes);
        if (!observed.refreshed || observed.commit?.oid !== target) conflict("expected target differs from the refreshed observation");
        assertTargetBase(this.worktrees.repositoryRoot, subject.target, subject.remotes, subject.run.base_commit!, subject.activeRemotes);
        if (targetRelation(this.worktrees.repositoryRoot, subject.run.base_commit!, target) !== "advanced") conflict("sync can only advance from the current base");
        row = await this.store.write(async tx => {
          await this.operation(tx, actor, "devrun.sync", request, actor.operation_id);
          const record: RuntimeRecord = { id: actor.operation_id, kind: "runtime_operation", parent_id: runId, version: 1, data: {
            format: "grounds.devrun-sync/v1", dev_run_id: runId, original_base: subject.run.base_commit!, ...(subject.run.development ? { source_head: expectedHead } : {}), target, run_version: expectedVersion + 1,
            phase: "reserved", created_at: await tx.now(), attribution: actor.attribution, recovery: { host_id: this.host, directory: local.directory },
          } };
          await tx.reserveDevRunSync(record, expectedVersion);
          await savePreparation(tx, newUUIDv7(), runId, actor.attribution);
          await this.audit(tx, record, actor); return record;
        });
      } else await this.store.write(tx => this.operation(tx, actor, "devrun.sync", request, actor.operation_id));
      this.verifyLocation(row, local.directory);
      if (syncTerminal(syncData(row))) { const run = await this.store.read(tx => tx.getDevRun(runId)); local.mark("active", run.base_commit); return row; }
      local.mark("syncing");
      try {
        let journal = existsSync(join(local.directory, "journal.json")) ? readLocalSync(local.directory) : prepareLocalSync({ cwd: local.path, directory: local.directory, base: syncData(row).original_base, target, ...((await this.store.read(tx => tx.getDevRun(runId))).development ? { development: (await this.store.read(tx => tx.getDevRun(runId))).development } : {}) }, this.checkpoint);
        this.verifyJournal(row, journal, local.path);
        row = await this.ready(row, journal, actor);
        if (journal.phase === "resolving" && syncData(row).phase === "resolving") return row;
        if (journal.phase !== "prepared") conflict("sync was interrupted; explicitly complete or abandon rather than reapplying over edits");
        journal = applyLocalSync(local.directory, this.checkpoint);
        row = await this.advance(row.id, "resolving", actor);
        if (!journal.merge!.conflicts.length) {
          journal = completeLocalSync(local.directory, this.checkpoint);
          row = await this.finish(row, journal, actor, "completed", []); local.mark("active", target);
        }
        return row;
      } catch (error) { local.mark("sync_interrupted"); throw error; }
    });
  }
  async complete(id: string, version: number, decisions: Decisions, actor: Actor): Promise<RuntimeRecord> {
    let row = await this.accept(id, version, actor, "devrun.sync-complete", decisions);
    const sync = syncData(row);
    return this.worktrees.withSyncWorktree(sync.dev_run_id, id, async local => {
      if ((await this.show(id)).version !== row.version) conflict("sync changed while acquiring its local mutex; inspect the current version");
      this.verifyLocation(row, local.directory);
      if (sync.phase === "abandoned") conflict("sync was already abandoned");
      if (sync.phase === "completed") { const run = await this.store.read(tx => tx.getDevRun(sync.dev_run_id)); local.mark("active", run.base_commit); return row; }
      const subject = await this.store.read(tx => this.subject(tx, sync.dev_run_id));
      assertTargetBase(this.worktrees.repositoryRoot, subject.target, subject.remotes, sync.original_base, subject.activeRemotes);
      assertTargetBase(this.worktrees.repositoryRoot, subject.target, subject.remotes, sync.target, subject.activeRemotes);
      local.mark("syncing");
      try {
        let journal = readLocalSync(local.directory);
        this.verifyJournal(row, journal, local.path);
        row = await this.ready(row, journal, actor);
        // Validate all decisions before freezing the local completion receipt.
        syncData({ ...row, data: { ...row.data, phase: "completed", decisions, receipt_digest: `sha256:${"0".repeat(64)}`, finished_at: new Date().toISOString() } });
        if (journal.phase === "prepared") journal = applyLocalSync(local.directory, this.checkpoint);
        if (syncData(row).phase === "applying") row = await this.advance(row.id, "resolving", actor);
        journal = completeLocalSync(local.directory, this.checkpoint);
        row = await this.finish(row, journal, actor, "completed", decisions); local.mark("active", sync.target); return row;
      } catch (error) { local.mark("sync_interrupted"); throw error; }
    });
  }
  async abandon(id: string, version: number, actor: Actor): Promise<RuntimeRecord> {
    let row = await this.accept(id, version, actor, "devrun.sync-abandon"); const sync = syncData(row);
    return this.worktrees.withSyncWorktree(sync.dev_run_id, id, async local => {
      if ((await this.show(id)).version !== row.version) conflict("sync changed while acquiring its local mutex; inspect the current version");
      this.verifyLocation(row, local.directory);
      if (sync.phase === "completed") conflict("sync was already committed; do not restore a previous base");
      if (sync.phase === "abandoned") { const run = await this.store.read(tx => tx.getDevRun(sync.dev_run_id)); local.mark("active", run.base_commit); return row; }
      local.mark("syncing");
      try {
        if (!existsSync(join(local.directory, "journal.json"))) {
          if (sync.phase !== "reserved") conflict("a previously applied sync has lost its recovery journal; refuse destructive recovery");
          initializeLocalSync({ cwd: local.path, directory: local.directory, base: sync.original_base, target: sync.target, ...((await this.store.read(tx => tx.getDevRun(sync.dev_run_id))).development ? { development: (await this.store.read(tx => tx.getDevRun(sync.dev_run_id))).development } : {}) }, true);
        }
        this.verifyJournal(row, readLocalSync(local.directory), local.path);
        row = await this.advance(id, "abandoning", actor);
        const journal = abandonLocalSync(local.directory, this.checkpoint, true);
        row = await this.finish(row, journal, actor, "abandoned", syncData(row).decisions ?? []); local.mark("active", sync.original_base); return row;
      } catch (error) { local.mark("sync_interrupted"); throw error; }
    });
  }
}
