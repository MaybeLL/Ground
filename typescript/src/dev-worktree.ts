import { repositoryDataRoot } from "./data-layout.js";
import { assertCommittedDevelopment, assertDevelopmentBranch, retainCandidateSource, branchGit, developmentPath, readDevelopmentPlan, unfinishedOperationPaths, validateDevelopment, type DevelopmentIdentity, type DevelopmentPlan } from "./development-branch.js";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { captureArtifact, createBaselineWorktree, discoverRepository, resolveBaseline } from "./git.js";
import { DomainError, validation, worktreeMismatch } from "./errors.js";
import { previewExternalWorkspace, workspaceIdentity, workspaceLeases, type ExternalWorkspaceInput } from "./workspace-provider.js";
import { atomicPrivateWrite, directoryRegistryRoot, safeRead, withRuntimeLock } from "./runtime-files.js";
import { isRouteLeased } from "./env-route-lease.js";
import { overlaps } from "./runtime-files.js";
import { assertPhysicalDirectoryFree, physicalClaims, physicalIdentity, reservePhysicalDirectory, releasePhysicalDirectory, type PhysicalDirectoryClaim } from "./physical-directory.js";
import type { Store, Tx } from "./store-types.js";
import { sha256 } from "./canonical-json.js";
import { isGitOID, isUUIDv7 } from "./identity.js";
import { readLocalSync } from "./sync-worktree.js";
import { RECEIPT_FORMAT, countEntries, readReceipt, writeReceipt, markReceiptRecorded, type WorktreeRemovalReceipt } from "./worktree-removal.js";
import type { Attribution } from "./domain.js";
import { ensureGroundsExcluded } from "./grounds-exclude.js";
import { readCommit } from "./integration-history.js";
import { assertHistoryRepository, historyGit, rawOID } from "./git-history-read.js";

const FORMAT = "patchledger.local-dev-worktree/v3";
const BRANCH_FORMAT = "grounds.local-development-worktree/v1";
const PREVIOUS_FORMAT = "patchledger.local-dev-worktree/v2";
const LEGACY_FORMAT = "patchledger.local-dev-worktree/v1";
const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_MS = 60_000;

type LocalLifecycle = "active" | "syncing" | "sync_interrupted" | "submitted" | "abandoned" | "removed";

interface LocalDevWorktree {
  development?: DevelopmentIdentity;
  previous_dev_run_id?: string;
  continuation?: "developing" | "paused" | "parallel";
  continuation_decision?: { operation_id: string; event_seq: number };
  format: typeof FORMAT | typeof BRANCH_FORMAT;
  database_id: string;
  operation_id: string;
  dev_run_id: string;
  repository_id: string;
  issue_revision_id: string;
  baseline_oid: string;
  initial_baseline_oid?: string;
  worktree_path: string;
  lifecycle: LocalLifecycle;
  sync_id?: string;
  external_input?: ExternalWorkspaceInput;
  requested_input_digest?: string;
  refines_candidate_id?: string;
  refinement_result_tree_oid?: string;
  refinement_source_commit?: string;
  refinement_source_parents?: string[];
  captured_result_tree_oid?: string;
  captured_source_commit?: string;
}

export type LocalWorktree =
  | { status: "available"; path: string; development?: DevelopmentIdentity; head?: string; working_tree_dirty?: boolean; git_operation_in_progress?: boolean; active_dev_run_id?: string; owner_phase?: "active" | "pending"; initial_base_commit?: string; definition_commit?: string; base_commit?: string; continuation?: "developing" | "paused" | "parallel"; ownership?: "external"; input_digest?: string; initial_changes?: string[]; initial_result_tree_oid?: string }
  | { status: "missing"; reason: "not_available_on_this_machine" | "local_worktree_deleted" }
  | { status: "invalid"; reason: string }
  | { status: "removed" };

export interface LocalObservation {
  view: LocalWorktree;
  /** The journal lifecycle exactly as recorded; `recognized` is false for values this version does not know. */
  journal?: { lifecycle: string; recognized: boolean };
  external?: true;
  sync_recovery?: { directory: string; count: number };
}

export interface PrepareDevWorktree {
  development_plan?: DevelopmentPlan;
  continue_from_run?: string;
  operation_id: string;
  repository_id: string;
  issue_revision_id: string;
  baseline_oid: string;
  external_workspace?: { directory: string; remote: string; input_digest?: string };
  refinement?: {
    candidate_id: string;
    result_tree_oid: string;
    patch: Buffer;
    /** Only a verified Git artifact may request exact source-history restoration. */
    source_commit?: string;
    source_parents?: string[];
  };
}

export interface StartWorktreeResult<T> {
  value: T;
  dev_run_id: string;
}

export interface CleanupWorktreeResult {
  removed: boolean;
  local_worktree: LocalWorktree;
  external_preserved?: true;
  /** Present when a managed worktree was removed (now or by an earlier interrupted run) and the ledger event is still owed. */
  removal?: WorktreeRemovalReceipt;
}

export interface CleanupRemovalRequest { operation_id: string; attribution: Attribution }

const atomicWrite = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
};

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const delay = (milliseconds: number): Promise<void> => new Promise((accept) => setTimeout(accept, milliseconds));
const boundedReason = (value: unknown): string => {
  const reason = value instanceof DomainError && typeof value.details.reason === "string" ? value.details.reason : value instanceof Error ? value.message : String(value);
  return [...reason].slice(0, 4096).join("") || "local worktree state is invalid";
};

export const commonRepositoryRoot = (path: string): string => {
  const worktree = discoverRepository(path);
  const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: worktree.root, encoding: "utf8" }).trim();
  const common = resolve(worktree.root, raw);
  return basename(common) === ".git" ? dirname(common) : worktree.root;
};

export class DevWorktreeModule {
  readonly repositoryRoot: string;
  readonly root: string;

  constructor(sourcePath: string, private readonly databaseID: string, private readonly newID: () => string, private readonly store?: Store, private readonly registryRoot?: string) {
    this.repositoryRoot = commonRepositoryRoot(sourcePath);
    this.root = join(repositoryDataRoot(this.repositoryRoot), "devruns");
  }

  private ensureDirectory(path: string, label: string): void {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw validation("worktree", `${label} must be a real directory`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw validation("worktree", `${label} must be a real directory`);
  }

  private ensureSafe(): void {
    const reserved = repositoryDataRoot(this.repositoryRoot);
    this.ensureDirectory(reserved, ".grounds");
    this.ensureDirectory(this.root, ".grounds/devruns");
    ensureGroundsExcluded(this.repositoryRoot);
    this.ensureDirectory(join(this.root, ".pending"), ".grounds/devruns/.pending");
    this.ensureDirectory(join(this.root, ".operations"), ".grounds/devruns/.operations");
    this.ensureDirectory(join(this.root, ".locks"), ".grounds/devruns/.locks");
  }

  private statePath(devRunID: string): string { return join(this.root, devRunID, "state.json"); }
  private operationPath(operationID: string): string { return join(this.root, ".operations", `${operationID}.json`); }
  private pendingPath(operationID: string): string { return join(this.root, ".pending", `${operationID}.json`); }

  private decode(path: string, onUnrecognizedLifecycle?: (raw: string) => void): LocalDevWorktree {
    let raw: Record<string, unknown>;
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw validation("worktree", `local DevRun state must be a real file: ${path}`);
    try { raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
    catch { throw validation("worktree", `local DevRun state is not valid JSON: ${path}`); }
    const format = raw.format;
    let lifecycle = format === LEGACY_FORMAT ? "active" : raw.lifecycle;
    // Read-only inspection tolerates a journal lifecycle it does not know and
    // reports it verbatim; every other consumer still rejects it as invalid.
    if (onUnrecognizedLifecycle && !(["active", "syncing", "sync_interrupted", "submitted", "abandoned", "removed"] as unknown[]).includes(lifecycle)) {
      onUnrecognizedLifecycle(typeof lifecycle === "string" ? lifecycle : JSON.stringify(lifecycle) ?? "undefined");
      lifecycle = "active";
    }
    if ((format !== BRANCH_FORMAT && format !== FORMAT && format !== PREVIOUS_FORMAT && format !== LEGACY_FORMAT) || raw.database_id !== this.databaseID || !isUUIDv7(raw.operation_id) || !isUUIDv7(raw.dev_run_id) || !isUUIDv7(raw.repository_id) || !isUUIDv7(raw.issue_revision_id) || !isGitOID(raw.baseline_oid) || typeof raw.worktree_path !== "string" || !(["active", "syncing", "sync_interrupted", "submitted", "abandoned", "removed"] as unknown[]).includes(lifecycle)) throw validation("worktree", "local DevRun state is invalid or belongs to another database");
    if (raw.initial_baseline_oid !== undefined && !isGitOID(raw.initial_baseline_oid)) throw validation("worktree", "invalid initial baseline");
    if (raw.sync_id !== undefined && !isUUIDv7(raw.sync_id)) throw validation("worktree", "invalid sync identity");
    if (["syncing", "sync_interrupted"].includes(String(lifecycle)) && !isUUIDv7(raw.sync_id)) throw validation("worktree", "sync lifecycle requires a recovery identity");
    const hasRefinementCandidate = raw.refines_candidate_id !== undefined;
    const hasRefinementTree = raw.refinement_result_tree_oid !== undefined;
    if (hasRefinementCandidate !== hasRefinementTree || (hasRefinementCandidate && (!isUUIDv7(raw.refines_candidate_id) || !isGitOID(raw.refinement_result_tree_oid)))) throw validation("worktree", "local DevRun refinement state is invalid");
    if (raw.refinement_source_commit !== undefined && (!isGitOID(raw.refinement_source_commit) || !hasRefinementCandidate || format !== BRANCH_FORMAT)) throw validation("worktree", "invalid fixed refinement source");
    if (raw.refinement_source_parents !== undefined && (!raw.refinement_source_commit || !Array.isArray(raw.refinement_source_parents) || raw.refinement_source_parents.some(parent => !isGitOID(parent)))) throw validation("worktree", "invalid fixed refinement parents");
    if (raw.captured_source_commit !== undefined && !isGitOID(raw.captured_source_commit)) throw validation("worktree", "invalid captured source commit");
    if (raw.captured_result_tree_oid !== undefined && !isGitOID(raw.captured_result_tree_oid)) throw validation("worktree", "local DevRun captured result tree is invalid");
    if ((format === BRANCH_FORMAT) !== (raw.development !== undefined)) throw validation("worktree", "managed branch state requires its explicit versioned format; legacy state is not silently upgraded");
    if (raw.development !== undefined) validateDevelopment(raw.development as DevelopmentIdentity);
    if (raw.previous_dev_run_id !== undefined && !isUUIDv7(raw.previous_dev_run_id)) throw validation("worktree", "invalid previous round");
    if (raw.continuation_decision !== undefined) {
      const decision = raw.continuation_decision as Record<string, unknown>;
      if (!raw.development || !decision || Object.keys(decision).sort().join(",") !== "event_seq,operation_id" || !isUUIDv7(decision.operation_id) || !Number.isSafeInteger(decision.event_seq) || Number(decision.event_seq) < 1) throw validation("worktree", "invalid continuation decision");
    }
    const value: LocalDevWorktree = {
      ...(raw.continuation_decision ? { continuation_decision: raw.continuation_decision as LocalDevWorktree["continuation_decision"] } : {}),
      ...(raw.development ? { development: raw.development as DevelopmentIdentity, ...(typeof raw.previous_dev_run_id === "string" ? { previous_dev_run_id: raw.previous_dev_run_id } : {}), ...(raw.continuation === "parallel" ? { continuation: "parallel" } : raw.continuation === "paused" ? { continuation: "paused" } : { continuation: "developing" }) } : {}),
      format: format === BRANCH_FORMAT ? BRANCH_FORMAT : FORMAT,
      database_id: raw.database_id as string,
      operation_id: raw.operation_id as string,
      dev_run_id: raw.dev_run_id as string,
      repository_id: raw.repository_id as string,
      issue_revision_id: raw.issue_revision_id as string,
      baseline_oid: raw.baseline_oid,
      ...(typeof raw.initial_baseline_oid === "string" ? { initial_baseline_oid: raw.initial_baseline_oid } : {}),
      worktree_path: raw.worktree_path,
      lifecycle: lifecycle as LocalLifecycle,
      ...(typeof raw.sync_id === "string" ? { sync_id: raw.sync_id } : {}),
      ...(format === FORMAT && raw.external_input !== undefined ? { external_input: raw.external_input as ExternalWorkspaceInput, requested_input_digest: raw.requested_input_digest as string } : {}),
      ...(typeof raw.refines_candidate_id === "string" ? { refines_candidate_id: raw.refines_candidate_id } : {}),
      ...(typeof raw.refinement_result_tree_oid === "string" ? { refinement_result_tree_oid: raw.refinement_result_tree_oid } : {}),
      ...(typeof raw.refinement_source_commit === "string" ? { refinement_source_commit: raw.refinement_source_commit } : {}),
      ...(Array.isArray(raw.refinement_source_parents) ? { refinement_source_parents: raw.refinement_source_parents as string[] } : {}),
      ...(typeof raw.captured_source_commit === "string" ? { captured_source_commit: raw.captured_source_commit } : {}),
      ...(typeof raw.captured_result_tree_oid === "string" ? { captured_result_tree_oid: raw.captured_result_tree_oid } : {}),
    };
    const expected = value.development ? developmentPath(this.repositoryRoot, value.development) : join(this.root, value.dev_run_id, "worktree");
    if (value.external_input) {
      const e = value.external_input;
      if (!e || typeof e !== "object" || e.directory !== value.worktree_path || !isAbsolute(e.directory) || !/^\d+:\d+$/.test(e.identity) || !/^sha256:[a-f0-9]{64}$/.test(e.input_digest) || e.baseline_oid !== value.baseline_oid || !Array.isArray(e.changes) || !isGitOID(e.result_tree_oid) || typeof e.dirty !== "boolean" || typeof value.requested_input_digest !== "string") throw validation("worktree", "invalid external workspace provenance");
    } else if (resolve(value.worktree_path) !== resolve(expected)) throw validation("worktree", "local DevRun state points outside its managed directory");
    return value;
  }

  private writeState(state: LocalDevWorktree): void {
    atomicWrite(this.statePath(state.dev_run_id), json(state));
    atomicWrite(this.operationPath(state.operation_id), json(state));
  }

  private inspectState(devRunID: string, onUnrecognizedLifecycle?: (raw: string) => void): { view: LocalWorktree; state?: LocalDevWorktree } {
    const reserved = repositoryDataRoot(this.repositoryRoot);
    if (!existsSync(reserved) || !existsSync(this.root)) return { view: { status: "missing", reason: "not_available_on_this_machine" } };
    try {
      if (!lstatSync(reserved).isDirectory() || lstatSync(reserved).isSymbolicLink() || !lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) throw new Error("the local Grounds directory is not a real directory");
      const runDirectory = join(this.root, devRunID);
      if (existsSync(runDirectory) && (!lstatSync(runDirectory).isDirectory() || lstatSync(runDirectory).isSymbolicLink())) throw new Error("the managed DevRun directory is not a real directory");
      const path = this.statePath(devRunID);
      if (!existsSync(path)) return { view: { status: "missing", reason: "not_available_on_this_machine" } };
      const state = this.decode(path, onUnrecognizedLifecycle);
      if (state.dev_run_id !== devRunID) throw new Error("local DevRun state does not match the requested DevRun");
      if (state.lifecycle === "removed") return { view: { status: "removed" }, state };
      if (!existsSync(state.worktree_path)) return { view: { status: "missing", reason: "local_worktree_deleted" }, state };
      if (lstatSync(state.worktree_path).isSymbolicLink() || discoverRepository(state.worktree_path).root !== resolve(state.worktree_path)) throw new Error("managed DevRun worktree is not a real Git worktree");
      if (state.development) assertDevelopmentBranch(state.worktree_path, state.development, this.repositoryRoot);
      if (!state.development && !["syncing", "sync_interrupted"].includes(state.lifecycle)) historyGit(state.worktree_path, ["merge-base", "--is-ancestor", rawOID(state.baseline_oid), rawOID(resolveBaseline(state.worktree_path, "HEAD"))]);
      if (state.external_input && workspaceIdentity(state.worktree_path) !== state.external_input.identity) throw Error("external workspace identity changed");
      let routeOwner: { active_dev_run_id: string; owner_phase: "active" | "pending" } | undefined;
      if (state.development) {
        const owner = JSON.parse(safeRead(join(dirname(state.worktree_path), "owner.json")).toString());
        if (owner.database_id !== this.databaseID || !isUUIDv7(owner.dev_run_id) || !["active", "pending"].includes(owner.phase)) throw worktreeMismatch(devRunID, "development route owner marker is invalid");
        routeOwner = { active_dev_run_id: owner.dev_run_id, owner_phase: owner.phase };
      }
      return { view: { status: "available", path: state.worktree_path, ...(routeOwner ?? {}), ...(state.development ? { development: state.development, head: resolveBaseline(state.worktree_path, "HEAD"), working_tree_dirty: execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z"], { cwd: state.worktree_path, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).length > 0, git_operation_in_progress: unfinishedOperationPaths(state.worktree_path).some(path => existsSync(path)), initial_base_commit: state.initial_baseline_oid ?? state.baseline_oid, definition_commit: readDevelopmentPlan(this.repositoryRoot, state.development.workspace_id, this.databaseID).definition_commit, base_commit: state.baseline_oid, continuation: state.continuation ?? "developing" } : {}), ...(state.external_input ? { ownership: "external" as const, input_digest: state.external_input.input_digest, initial_changes: state.external_input.changes, initial_result_tree_oid: state.external_input.result_tree_oid } : {}) }, state };
    } catch (error) {
      return { view: { status: "invalid", reason: boundedReason(error) } };
    }
  }

  inspect(devRunID: string): LocalWorktree {
    if (!isUUIDv7(devRunID)) throw validation("dev_run_id", "must be a lowercase UUIDv7");
    return this.inspectState(devRunID).view;
  }

  async inspectAuthoritative(devRunID: string): Promise<LocalWorktree> {
    const inspected = this.inspectState(devRunID);
    if (inspected.view.status === "available" && inspected.state?.development && ["active", "submitted"].includes(inspected.state.lifecycle)) {
      try { await this.assertAuthoritativeDevelopment(inspected.state); }
      catch (error) { return { status: "invalid", reason: `continuation requires reconciliation: ${boundedReason(error)}` }; }
    }
    return inspected.view;
  }

  /**
   * Read-only observation for reconciliation.  Unlike `inspect`, a journal
   * lifecycle this version does not know is reported verbatim instead of
   * turning the whole worktree invalid.  Nothing here writes to disk.
   */
  observe(devRunID: string): LocalObservation {
    if (!isUUIDv7(devRunID)) throw validation("dev_run_id", "must be a lowercase UUIDv7");
    let unrecognized: string | undefined;
    const inspected = this.inspectState(devRunID, (raw) => { unrecognized = [...raw].slice(0, 256).join(""); });
    let journal = inspected.state ? (unrecognized !== undefined ? { lifecycle: unrecognized, recognized: false } : { lifecycle: inspected.state.lifecycle as string, recognized: true }) : undefined;
    if (journal?.lifecycle === "syncing" && inspected.state?.sync_id) {
      let activeOwner = false;
      try {
        const owner = JSON.parse(readFileSync(join(this.root, ".locks", `devrun-${devRunID}`, "owner.json"), "utf8"));
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); activeOwner = true; } catch (error: any) { activeOwner = error.code === "EPERM"; }
        }
      } catch { /* No current local controller. */ }
      if (!activeOwner) {
        try {
          const phase = readLocalSync(join(this.root, devRunID, "sync", inspected.state.sync_id)).phase;
          if (phase !== "resolving") journal = { lifecycle: "sync_interrupted", recognized: true };
        } catch { journal = { lifecycle: "sync_interrupted", recognized: true }; }
      }
    }
    const directory = join(this.root, devRunID, "sync");
    let recovery: LocalObservation["sync_recovery"];
    if (existsSync(directory) && lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink()) {
      const count = readdirSync(directory).filter(name => isUUIDv7(name)).length;
      if (count) recovery = { directory, count };
    }
    return { view: inspected.view, ...(journal ? { journal } : {}), ...(inspected.state?.external_input ? { external: true } : {}), ...(recovery ? { sync_recovery: recovery } : {}) };
  }

  /** DevRun IDs that have a local state file in this clone, without validating them. */
  localRunIDs(): string[] {
    try {
      if (!existsSync(this.root) || lstatSync(this.root).isSymbolicLink() || !lstatSync(this.root).isDirectory()) return [];
      return readdirSync(this.root).filter((name) => isUUIDv7(name) && existsSync(this.statePath(name))).sort();
    } catch { return []; }
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.ensureSafe();
    const lock = join(this.root, ".locks", key);
    const started = Date.now();
    while (true) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        atomicWrite(join(lock, "owner.json"), json({ pid: process.pid, created_at_ms: Date.now() }));
        break;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
        if (code !== "EEXIST") throw error;
        let stale = false;
        try {
          const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid?: unknown; created_at_ms?: unknown };
          const old = typeof owner.created_at_ms === "number" && Date.now() - owner.created_at_ms > STALE_LOCK_MS;
          let alive = true;
          if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid)) {
            try { process.kill(owner.pid, 0); } catch { alive = false; }
          }
          stale = old && !alive;
        } catch {
          // The process may have died after creating the lock directory but
          // before writing owner.json. Use the directory timestamp so a later
          // process can recover that orphan instead of timing out forever.
          try { stale = Date.now() - lstatSync(lock).mtimeMs > STALE_LOCK_MS; }
          catch { stale = true; }
        }
        if (stale) {
          const stalePath = `${lock}.stale-${process.pid}-${Date.now()}`;
          try { renameSync(lock, stalePath); rmSync(stalePath, { recursive: true, force: true }); } catch { /* another process recovered it */ }
          continue;
        }
        if (Date.now() - started >= LOCK_WAIT_MS) throw worktreeMismatch("", "another process is operating on this local DevRun worktree");
        await delay(25);
      }
    }
    try { return await work(); }
    finally { rmSync(lock, { recursive: true, force: true }); }
  }

  startRecovery(operationID: string): { mode: "legacy" | "branch"; development?: DevelopmentIdentity; dev_run_id: string; issue_revision_id: string } | undefined {
    if (!isUUIDv7(operationID)) throw validation("operation_id", "requires UUIDv7");
    const file = existsSync(this.operationPath(operationID)) ? this.operationPath(operationID) : this.pendingPath(operationID);
    if (!existsSync(file)) return undefined;
    const state = this.decode(file);
    if (state.operation_id !== operationID) throw worktreeMismatch(state.dev_run_id, "local start operation identity differs from its journal");
    return { mode: state.development ? "branch" : "legacy", ...(state.development ? { development: state.development } : {}), dev_run_id: state.dev_run_id, issue_revision_id: state.issue_revision_id };
  }

  private async prepare(input: PrepareDevWorktree): Promise<{ state: LocalDevWorktree; created: boolean; replayed?: true }> {
    if (input.refinement && !input.refinement.source_commit) throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "Historical patch-only refinement is unsupported; restore a fixed Git Candidate");
    if (input.refinement && (!isUUIDv7(input.refinement.candidate_id) || !isGitOID(input.refinement.result_tree_oid) || !input.refinement.source_commit)) throw validation("refinement", "requires a supported Git Candidate ID, result tree, and fixed source commit; patch-only recovery is unsupported");
    if (input.refinement?.source_commit !== undefined && (!isGitOID(input.refinement.source_commit) || !input.development_plan)) throw validation("refinement.source_commit", "exact source requires a fixed commit and managed development plan");
    if (input.refinement?.source_parents !== undefined && (!input.refinement.source_commit || !Array.isArray(input.refinement.source_parents) || input.refinement.source_parents.some(parent => !isGitOID(parent)))) throw validation("refinement.source_parents", "requires fixed source and ordered parent OIDs");
    const pendingPath = this.pendingPath(input.operation_id);
    const completedPath = this.operationPath(input.operation_id);
    const completed = existsSync(completedPath);
    const existing = completed ? this.decode(completedPath) : existsSync(pendingPath) ? this.decode(pendingPath) : undefined;
    const state: LocalDevWorktree = existing ?? {
      format: input.development_plan ? BRANCH_FORMAT : FORMAT,
      ...(input.development_plan ? { development: { format: input.development_plan.format, workspace_id: input.development_plan.workspace_id, branch: input.development_plan.branch }, ...(input.continue_from_run ? { previous_dev_run_id: input.continue_from_run } : {}) } : {}),
      database_id: this.databaseID,
      operation_id: input.operation_id,
      dev_run_id: this.newID(),
      repository_id: input.repository_id,
      issue_revision_id: input.issue_revision_id,
      baseline_oid: input.baseline_oid,
      worktree_path: "",
      lifecycle: "active",
      ...(input.refinement ? { refines_candidate_id: input.refinement.candidate_id, refinement_result_tree_oid: input.refinement.result_tree_oid, ...(input.refinement.source_commit ? { refinement_source_commit: input.refinement.source_commit } : {}), ...(input.refinement.source_parents ? { refinement_source_parents: input.refinement.source_parents } : {}) } : {}),
    };
    if (input.external_workspace) {
      if (input.refinement) throw validation("workspace", "external workspace cannot silently materialize a refinement");
      if (!existing) {
        const snapshot = previewExternalWorkspace(input.external_workspace.directory, input.baseline_oid, input.external_workspace.remote);
        if (snapshot.dirty && input.external_workspace.input_digest !== snapshot.input_digest) throw validation("input-digest", "inspect workspace and explicitly accept its current input digest before adopting dirty changes");
        if (input.external_workspace.input_digest && input.external_workspace.input_digest !== snapshot.input_digest) throw validation("input-digest", "workspace input changed after inspection");
        state.external_input = snapshot; state.requested_input_digest = input.external_workspace.input_digest ?? "";
      }
      if (!state.external_input || state.external_input.directory !== resolve(input.external_workspace.directory) || state.requested_input_digest !== (input.external_workspace.input_digest ?? "")) throw validation("operation_id", "external workspace start differs from original request");
      state.worktree_path = state.external_input.directory;
    } else {
      if (state.external_input) throw validation("operation_id", "cannot reuse external start as managed start");
      state.worktree_path = state.development ? developmentPath(this.repositoryRoot, state.development) : join(this.root, state.dev_run_id, "worktree");
    }
    if (state.operation_id !== input.operation_id || state.repository_id !== input.repository_id || state.issue_revision_id !== input.issue_revision_id || (state.initial_baseline_oid ?? state.baseline_oid) !== input.baseline_oid || state.refines_candidate_id !== input.refinement?.candidate_id || state.refinement_result_tree_oid !== input.refinement?.result_tree_oid || state.refinement_source_commit !== input.refinement?.source_commit || JSON.stringify(state.refinement_source_parents) !== JSON.stringify(input.refinement?.source_parents)) throw validation("operation_id", "pending DevRun worktree belongs to a different start request");
    if (JSON.stringify(state.development) !== JSON.stringify(input.development_plan ? { format: input.development_plan.format, workspace_id: input.development_plan.workspace_id, branch: input.development_plan.branch } : undefined) || state.previous_dev_run_id !== input.continue_from_run) throw validation("operation_id", "development plan differs from original start");
    if (input.development_plan) {
      const plan = readDevelopmentPlan(this.repositoryRoot, input.development_plan.workspace_id, this.databaseID);
      if (plan.repository_id !== input.repository_id || plan.path !== state.worktree_path) throw worktreeMismatch(state.dev_run_id, "plan Repository or location changed");
      if (input.external_workspace) throw validation("workspace", "branch development only accepts a managed plan");
    }
    if (input.continue_from_run && !completed) {
      const ownerPath = join(dirname(state.worktree_path), "owner.json");
      if (existsSync(ownerPath)) {
        const owner = JSON.parse(safeRead(ownerPath).toString());
        if (owner.database_id !== this.databaseID || ![input.continue_from_run, state.dev_run_id].includes(owner.dev_run_id) || (owner.phase === "pending" && owner.operation_id !== state.operation_id)) throw worktreeMismatch(state.dev_run_id, "route has a later owner or unrecovered start; preserve its recovery state");
      }
      const prior = this.decode(this.statePath(input.continue_from_run));
      if (!this.store || !prior.development || !["submitted", "removed"].includes(prior.lifecycle) || prior.worktree_path !== state.worktree_path || prior.issue_revision_id !== input.issue_revision_id || prior.repository_id !== input.repository_id || !input.refinement) throw worktreeMismatch(state.dev_run_id, "continuation must use a terminal parent on the same managed route and contract");
      const run = await this.store.read(tx => tx.getDevRun(prior.dev_run_id));
      if (run.state !== "submitted") throw worktreeMismatch(state.dev_run_id, "previous round is not durably submitted");
      if (existsSync(prior.worktree_path)) assertPhysicalDirectoryFree(prior.worktree_path, this.registryRoot ?? directoryRegistryRoot());
      if (existsSync(prior.worktree_path) && isRouteLeased(prior.worktree_path)) throw worktreeMismatch(state.dev_run_id, "previous round's route is still leased by an execution");
      if (existsSync(prior.worktree_path)) assertCommittedDevelopment(prior.worktree_path, prior.development);
      const tree = resolveBaseline(existsSync(prior.worktree_path) ? prior.worktree_path : this.repositoryRoot, `refs/heads/${prior.development.branch}`);
      // Continued HEAD may be ahead after an explicitly parallel author policy; preserve it.
      if (!tree) throw worktreeMismatch(state.dev_run_id, "previous route HEAD unavailable");
    }
    if (completed || state.lifecycle === "removed") return { state, created: false, replayed: true };
    if (state.refinement_source_commit) {
      // No branch or active index is touched while validating the original objects.
      assertHistoryRepository(this.repositoryRoot);
      const source = readCommit(this.repositoryRoot, state.refinement_source_commit);
      if (source.tree_oid !== state.refinement_result_tree_oid || (state.refinement_source_parents && JSON.stringify(source.parents) !== JSON.stringify(state.refinement_source_parents))) throw worktreeMismatch(state.dev_run_id, "fixed refinement source tree or ordered parents mismatch");
      try {
        historyGit(this.repositoryRoot, ["merge-base", "--is-ancestor", rawOID(state.baseline_oid), rawOID(source.oid)]);
        historyGit(this.repositoryRoot, ["rev-list", "--objects", "--missing=error", rawOID(source.oid)]);
        historyGit(this.repositoryRoot, ["fsck", "--full", "--strict", "--no-reflogs", "--no-dangling", rawOID(source.oid)]);
      } catch { throw worktreeMismatch(state.dev_run_id, "fixed refinement history is incomplete or does not retain its base; fetch the archive explicitly"); }
    }
    // Both start modes hold the shared lock; reject overlap before creating
    // a Git worktree or publishing a local/SQL ownership intent.
    const registry = this.registryRoot ?? directoryRegistryRoot();
    assertPhysicalDirectoryFree(state.worktree_path, registry);
    const leases = await workspaceLeases(this.store, this.databaseID, registry);
    if (isRouteLeased(state.worktree_path)) throw worktreeMismatch(state.dev_run_id, "the route is leased or its Git pointer is damaged; wait for it to finish or repair the route first");
    const conflictingWorkspace = Object.values(leases).some(l =>
      overlaps(l.directory, state.worktree_path) && !(l.database === this.databaseID && [state.dev_run_id, state.previous_dev_run_id].includes(l.run) && l.directory === state.worktree_path));
    if (conflictingWorkspace) throw worktreeMismatch(state.dev_run_id, "workspace overlaps an active or unrecovered owner");

    if (state.external_input) {
      if (workspaceIdentity(state.worktree_path) !== state.external_input.identity || resolveBaseline(state.worktree_path, "HEAD") !== state.baseline_oid) throw validation("workspace", "external workspace drifted");
      this.ensureDirectory(join(this.root, state.dev_run_id), "external workspace metadata");
      if (!existing) atomicWrite(pendingPath, json(state));
      atomicWrite(this.statePath(state.dev_run_id), json(state));
      return { state, created: !existing };
    }
    this.ensureDirectory(dirname(state.worktree_path), `managed directory for DevRun ${state.dev_run_id}`);
    if (existsSync(state.worktree_path) && lstatSync(state.worktree_path).isSymbolicLink()) throw validation("worktree", "managed DevRun worktree must not be a symbolic link");
    if (!existing) atomicWrite(pendingPath, json(state));
    const createdWorktree = !existsSync(state.worktree_path);
    if (createdWorktree) {
      if (state.development) {
        let occupied = false; try { execFileSync("git", ["show-ref", "--verify", `refs/heads/${state.development.branch}`], { cwd: this.repositoryRoot, stdio: "ignore" }); occupied = true; } catch { /* absent */ }
        if (occupied && !state.previous_dev_run_id) throw worktreeMismatch(state.dev_run_id, "planned branch is occupied; preserve it");
        if (occupied) branchGit(this.repositoryRoot, ["worktree", "add", "--", state.worktree_path, state.development.branch]);
        else branchGit(this.repositoryRoot, ["worktree", "add", "-b", state.development.branch, "--", state.worktree_path, (state.refinement_source_commit ?? state.baseline_oid).split(":")[1]!]);
      } else createBaselineWorktree(this.repositoryRoot, state.worktree_path, state.baseline_oid);
    } else if (state.development && !existing && !state.previous_dev_run_id) throw worktreeMismatch(state.dev_run_id, "planned path is occupied; preserve it");
    try {
      if (discoverRepository(state.worktree_path).root !== resolve(state.worktree_path) || (!state.development && resolveBaseline(state.worktree_path, "HEAD") !== state.baseline_oid)) throw validation("worktree", "managed DevRun worktree does not match its Baseline");
      if (state.development) assertDevelopmentBranch(state.worktree_path, state.development, this.repositoryRoot);
      if (state.refinement_source_commit && !state.previous_dev_run_id) {
        const source = assertCommittedDevelopment(state.worktree_path, state.development!);
        if (source.commit !== state.refinement_source_commit || readCommit(state.worktree_path, source.commit).tree_oid !== state.refinement_result_tree_oid || (state.refinement_source_parents && JSON.stringify(source.parents) !== JSON.stringify(state.refinement_source_parents))) throw worktreeMismatch(state.dev_run_id, "exact refinement worktree changed; preserve it and reconcile the original start");
      }

    } catch (error) {
      if (createdWorktree && !state.development) this.discard(state);
      throw error;
    }
    // Write the DevRun-keyed recovery record before crossing the database
    // seam. If the database commits and this process exits before complete(),
    // `devrun context` can still recover the already-created local worktree.
    atomicWrite(this.statePath(state.dev_run_id), json(state));
    if (state.development) atomicPrivateWrite(join(dirname(state.worktree_path), "owner.json"), JSON.stringify({ database_id: this.databaseID, dev_run_id: state.dev_run_id, operation_id: state.operation_id, phase: "pending" }));
    return { state, created: !existing };
  }

  private complete(state: LocalDevWorktree): void {
    this.writeState(state);
    if (state.development) atomicPrivateWrite(join(dirname(state.worktree_path), "owner.json"), JSON.stringify({ database_id: this.databaseID, dev_run_id: state.dev_run_id, operation_id: state.operation_id, phase: "active" }));
    rmSync(this.pendingPath(state.operation_id), { force: true });
  }

  private discard(state: LocalDevWorktree): void {
    if (state.external_input) {
      this.releaseWorkspaceLease(state);
      rmSync(join(this.root, state.dev_run_id), { recursive: true, force: true });
      rmSync(this.pendingPath(state.operation_id), { force: true });
      return;
    }
    const parent = resolve(dirname(state.worktree_path));
    if (!parent.startsWith(resolve(this.root) + sep)) throw validation("worktree", "managed DevRun path escapes its local root");
    if (existsSync(state.worktree_path)) {
      try { execFileSync("git", ["worktree", "remove", "--force", state.worktree_path], { cwd: this.repositoryRoot, stdio: "ignore" }); }
      catch { rmSync(this.pendingPath(state.operation_id), { force: true }); return; }
    }
    this.releaseWorkspaceLease(state);
    rmSync(parent, { recursive: true, force: true });
    rmSync(this.pendingPath(state.operation_id), { force: true });
  }

  async start<T>(input: PrepareDevWorktree, perform: (devRunID: string) => Promise<StartWorktreeResult<T>>): Promise<{ value: T; local_worktree: LocalWorktree }> {
    const performStart = async () => {
      const prepared = await this.prepare(input);
      if (prepared.replayed) {
        const replay = await perform(prepared.state.dev_run_id);
        return { value: replay.value, local_worktree: this.inspect(replay.dev_run_id) };
      }
      if (prepared.state.lifecycle !== "removed") {
        const root = this.registryRoot ?? directoryRegistryRoot();
        const leases = await workspaceLeases(this.store, this.databaseID, root);
        const state = prepared.state, identity = workspaceIdentity(state.worktree_path);
        if (state.previous_dev_run_id) delete leases[state.previous_dev_run_id];
        leases[state.dev_run_id] = {
          database: this.databaseID, run: state.dev_run_id, directory: state.worktree_path, identity,
          ownership: state.external_input ? "external" : "managed",
          input_digest: state.external_input?.input_digest ?? sha256({ directory: state.worktree_path, identity, baseline: state.baseline_oid }),
          ...(state.external_input ? { initial_changes: state.external_input.changes, result_tree_oid: state.external_input.result_tree_oid } : {}),
        };
        atomicPrivateWrite(join(root, "workspace-registry.json"), JSON.stringify(leases));
      }
      try {
        const completed = await perform(prepared.state.dev_run_id);
        if (completed.dev_run_id !== prepared.state.dev_run_id) {
          if (prepared.created) this.discard(prepared.state);
          return { value: completed.value, local_worktree: this.inspect(completed.dev_run_id) };
        }
        this.complete(prepared.state);
        return { value: completed.value, local_worktree: this.inspect(prepared.state.dev_run_id) };
      } catch (error) {
        if (prepared.created && !prepared.state.development && error instanceof DomainError && !error.retryable) this.discard(prepared.state);
        throw error;
      }
    };
    return this.withLock(`operation-${input.operation_id}`, async () => {
      if (input.external_workspace && !this.store) throw validation("workspace", "external start requires authoritative Store");
      return withRuntimeLock(this.registryRoot ?? directoryRegistryRoot(), "directory-registry", performStart);
    });
  }

  private releaseWorkspaceLease(state: LocalDevWorktree): void {
    const root = this.registryRoot ?? directoryRegistryRoot(), path = join(root, "workspace-registry.json");
    if (!existsSync(path)) return;
    const leases = JSON.parse(safeRead(path, 1024 * 1024).toString());
    const entry = leases[state.dev_run_id];
    if (entry && entry.database === this.databaseID && entry.run === state.dev_run_id && entry.directory === state.worktree_path) { delete leases[state.dev_run_id]; atomicPrivateWrite(path, JSON.stringify(leases)); }
  }

  private requireAvailable(devRunID: string): { path: string; state: LocalDevWorktree } {
    const inspected = this.inspectState(devRunID);
    if (inspected.view.status !== "available" || !inspected.state) throw worktreeMismatch(devRunID, inspected.view.status === "invalid" ? inspected.view.reason : `local worktree is ${inspected.view.status}; use the original machine or start a new DevRun`);
    if (["syncing", "sync_interrupted"].includes(inspected.state.lifecycle)) throw worktreeMismatch(devRunID, "complete or abandon pending sync before capture or submission");
    if (inspected.state.development) {
      const owner = JSON.parse(safeRead(join(dirname(inspected.state.worktree_path), "owner.json")).toString());
      if (owner.database_id !== this.databaseID || owner.dev_run_id !== devRunID || owner.phase !== "active") throw worktreeMismatch(devRunID, "route belongs to a later round or an interrupted start; reconcile that owner");
    }
    return { path: inspected.view.path, state: inspected.state };
  }

  private async assertAuthoritativeDevelopment(state: LocalDevWorktree, transaction?: Tx, checkContinuation = true): Promise<void> {
    if (!state.development || !this.store) return;
    const check = async (tx: Tx): Promise<void> => {
      const run = await tx.getDevRun(state.dev_run_id);
      if (JSON.stringify(run.development) !== JSON.stringify(state.development) || run.issue_revision_id !== state.issue_revision_id ||
        (!["syncing", "sync_interrupted"].includes(state.lifecycle) && run.base_commit !== state.baseline_oid)) throw worktreeMismatch(state.dev_run_id, "local route/contract/base differs from the authoritative DevRun; retain state and reconcile");
      if (state.lifecycle === "active" && run.state !== "open" && (checkContinuation || run.state !== "submitted")) throw worktreeMismatch(state.dev_run_id, "SQL archive or terminal state is ahead of the local marker; retry the original authorized archive operation");
      if (state.lifecycle === "submitted") {
        if (run.state !== "submitted") throw worktreeMismatch(state.dev_run_id, "the authoritative round is no longer submitted");
        const candidate = await tx.getCandidateByDevRun(state.dev_run_id);
        if (candidate?.candidate.source?.commit !== state.captured_source_commit || candidate?.candidate.result_tree_oid !== state.captured_result_tree_oid) throw worktreeMismatch(state.dev_run_id, "local archive marker differs from the immutable SQL Candidate");
        if (checkContinuation) {
          const current = await tx.getDevelopmentContinuation(state.dev_run_id);
          if (current ? state.continuation !== current.policy || (state.continuation_decision !== undefined && (state.continuation_decision.operation_id !== current.operation_id || state.continuation_decision.event_seq !== current.event_seq)) : state.continuation !== "paused" || state.continuation_decision !== undefined) throw worktreeMismatch(state.dev_run_id, "local continuation differs from the current SQL decision; retry the authorized operation to reconcile");
        }
      }
    };
    if (transaction) await check(transaction); else await this.store.read(check);
  }

  private async saveCurrentContinuation(state: LocalDevWorktree, tx: Tx, expectedHead?: string): Promise<void> {
    const current = await tx.getDevelopmentContinuation(state.dev_run_id), previous = state.continuation_decision;
    if (!current && (expectedHead !== undefined || previous !== undefined)) throw worktreeMismatch(state.dev_run_id, "current continuation is missing; retain state and reconcile");
    if (current && (resolveBaseline(state.worktree_path, "HEAD") !== current.expected_head || (expectedHead !== undefined && current.expected_head !== expectedHead))) throw worktreeMismatch(state.dev_run_id, "current continuation or HEAD cannot be verified; retain state and reconcile");
    if (previous && current && (previous.event_seq > current.event_seq || (previous.event_seq === current.event_seq && previous.operation_id !== current.operation_id))) throw worktreeMismatch(state.dev_run_id, "SQL continuation order regressed or conflicts with the saved decision");
    this.writeState({ ...state, continuation: current?.policy ?? "paused", ...(current ? { continuation_decision: { operation_id: current.operation_id, event_seq: current.event_seq } } : {}) });
  }

  /** Shared local lock for template capture, submission, sync and cleanup. */
  async capture<T>(devRunID: string, perform: (path: string) => Promise<T>): Promise<T> {
    return this.withLock(`devrun-${devRunID}`, () => withRuntimeLock(this.registryRoot ?? directoryRegistryRoot(), "directory-registry", async () => {
      const available = this.requireAvailable(devRunID);
      await this.assertAuthoritativeDevelopment(available.state);
      assertPhysicalDirectoryFree(available.path, this.registryRoot ?? directoryRegistryRoot());
      if (this.store) await this.store.write(tx => tx.assertDevRunNotSyncing(devRunID));
      return perform(available.path);
    }));
  }

  async withSyncWorktree<T>(devRunID: string, syncId: string, perform: (local: { path: string; directory: string; mark: (phase: "syncing" | "sync_interrupted" | "active", base?: string) => void }) => Promise<T>): Promise<T> {
    if (!isUUIDv7(devRunID) || !isUUIDv7(syncId)) throw validation("sync", "UUIDv7 identities required");
    return this.withLock(`devrun-${devRunID}`, () => withRuntimeLock(this.registryRoot ?? directoryRegistryRoot(), "directory-registry", async () => {
      let state = this.decode(this.statePath(devRunID));
      if (isRouteLeased(state.worktree_path)) throw worktreeMismatch(devRunID, "the route is leased or its Git pointer is damaged; wait for it to finish or repair the route before sync");
      await this.assertAuthoritativeDevelopment(state);
      if (state.development) {
        const owner = JSON.parse(safeRead(join(dirname(state.worktree_path), "owner.json")).toString());
        if (owner.dev_run_id !== devRunID || owner.database_id !== this.databaseID || owner.phase !== "active") throw worktreeMismatch(devRunID, "sync route belongs to another round or pending recovery");
        assertDevelopmentBranch(state.worktree_path, state.development, this.repositoryRoot);
      }
      if (state.external_input || !["active", "syncing", "sync_interrupted"].includes(state.lifecycle)) throw worktreeMismatch(devRunID, "sync requires an open managed worktree, not an external or terminal directory");
      if (state.sync_id && state.sync_id !== syncId) throw worktreeMismatch(devRunID, "another local sync requires recovery first");
      const registry = this.registryRoot ?? directoryRegistryRoot();
      const claim: PhysicalDirectoryClaim = { kind: "sync", owner: `${this.databaseID}:${devRunID}`, id: syncId, directory: state.worktree_path, identity: physicalIdentity(state.worktree_path) };
      // A pre-SQL crash is recoverable only with an authoritative absence read
      // under the same mutex. Offline environment callers never guess this.
      for (const old of Object.values(physicalClaims(registry))) {
        if (old.kind === "sync" && old.owner === claim.owner && old.id !== syncId && state.lifecycle === "active" && this.store &&
            !await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", old.id))) releasePhysicalDirectory(registry, old);
      }
      reservePhysicalDirectory(registry, claim);
      const mark = (phase: "syncing" | "sync_interrupted" | "active", base?: string): void => {
        if (base !== undefined && !isGitOID(base)) throw validation("sync.base", "qualified OID required");
        state = { ...state, initial_baseline_oid: state.initial_baseline_oid ?? state.baseline_oid, lifecycle: phase, ...(base ? { baseline_oid: base } : {}) };
        if (phase === "active") delete state.sync_id; else state.sync_id = syncId;
        atomicPrivateWrite(this.statePath(devRunID), json(state));
        atomicPrivateWrite(this.operationPath(state.operation_id), json(state));
        if (phase === "active") releasePhysicalDirectory(registry, claim);
      };
      try {
        const parent = join(this.root, devRunID, "sync"); this.ensureDirectory(parent, "sync recovery root");
        return await perform({ path: state.worktree_path, directory: join(parent, syncId), mark });
      } finally {
        if (state.lifecycle === "active" && this.store && !await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", syncId))) releasePhysicalDirectory(registry, claim);
      }
    }));
  }

  async submit<T extends { result_tree_oid: string; source?: { commit: string; parents: string[] }; candidate_id?: string }>(devRunID: string, perform: (path: string) => Promise<T>): Promise<T> {
    return this.withLock(`devrun-${devRunID}`, () => withRuntimeLock(this.registryRoot ?? directoryRegistryRoot(), "directory-registry", async () => {
      const available = this.requireAvailable(devRunID);
      await this.assertAuthoritativeDevelopment(available.state, undefined, false);
      assertPhysicalDirectoryFree(available.path, this.registryRoot ?? directoryRegistryRoot());
      if (this.store) await this.store.write(tx => tx.assertDevRunNotSyncing(devRunID));
      const result = await perform(available.path);
      if (available.state.development && result.source && result.candidate_id) retainCandidateSource(available.path, result.candidate_id, result.source);
      if (available.state.development) {
        if (!this.store) throw worktreeMismatch(devRunID, "managed archive recovery requires the authoritative ledger");
        await this.store.write(async tx => {
          await tx.lockDevRun(devRunID);
          const fresh = this.requireAvailable(devRunID);
          const submitted: LocalDevWorktree = { ...fresh.state, lifecycle: "submitted", ...(result.source ? { captured_source_commit: result.source.commit } : {}), captured_result_tree_oid: result.result_tree_oid };
          await this.assertAuthoritativeDevelopment(submitted, tx, false);
          if (result.source && resolveBaseline(submitted.worktree_path, "HEAD") !== result.source.commit) throw worktreeMismatch(devRunID, "HEAD changed after SQL archive; retain the marker and source audit for recovery");
          await this.saveCurrentContinuation(submitted, tx);
        });
      } else this.writeState({ ...available.state, lifecycle: "submitted", captured_result_tree_oid: result.result_tree_oid });
      return result;
    }));
  }

  async continuation<T>(devRunID: string, expectedHead: string, policy: "parallel" | "paused", perform: () => Promise<T>): Promise<T> {
    if (!["parallel", "paused"].includes(policy) || !isGitOID(expectedHead)) throw validation("continuation", "explicit policy and qualified expected HEAD required");
    return this.withLock(`devrun-${devRunID}`, () => withRuntimeLock(this.registryRoot ?? directoryRegistryRoot(), "directory-registry", async () => {
      const local = this.requireAvailable(devRunID);
      if (isRouteLeased(local.path)) throw worktreeMismatch(devRunID, "the route is leased or its Git pointer is damaged; wait for it to finish or repair the route first");
      await this.assertAuthoritativeDevelopment(local.state, undefined, false);
      if (!local.state.development || local.state.lifecycle !== "submitted") throw worktreeMismatch(devRunID, "author continuation policy requires a submitted managed branch round");
      assertPhysicalDirectoryFree(local.path, this.registryRoot ?? directoryRegistryRoot());
      if (resolveBaseline(local.path, "HEAD") !== expectedHead) throw worktreeMismatch(devRunID, "HEAD changed since the continuation decision");
      const result = await perform();
      if (!this.store) throw worktreeMismatch(devRunID, "continuation requires the authoritative ledger");
      await this.store.write(async tx => {
        await tx.lockDevRun(devRunID);
        // Reinspect under the existing local locks and the SQL row fence. No nested store calls.
        const fresh = this.requireAvailable(devRunID);
        await this.assertAuthoritativeDevelopment(fresh.state, tx, false);
        await this.saveCurrentContinuation(fresh.state, tx, expectedHead);
      });
      return result;
    }));
  }

  cleanupPreview(devRunID: string): { dev_run_id: string; local_worktree: LocalWorktree; branch?: string; risks: string[]; options: string[] } {
    const inspected = this.inspectState(devRunID), risks: string[] = [];
    if (inspected.view.status !== "available" || !inspected.state) risks.push(`local worktree is ${inspected.view.status}`);
    const state = inspected.state;
    if (state?.development && inspected.view.status === "available") {
      try { this.requireAvailable(devRunID); assertCommittedDevelopment(state.worktree_path, state.development); } catch (e) { risks.push(boundedReason(e)); }
      if (state.lifecycle === "submitted" && resolveBaseline(state.worktree_path, "HEAD") !== state.captured_source_commit) risks.push("HEAD contains commits that were not archived by this round; retain or archive the current round first");
      if (execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { cwd: state.worktree_path }).length) risks.push("ignored local materials must be preserved before cleanup");
      if (["syncing", "sync_interrupted"].includes(state.lifecycle)) risks.push("pending sync recovery is protected");
      const entries = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: this.repositoryRoot, encoding: "utf8" }).trim().split("\n\n");
      if (entries.some(entry => entry.split("\n").includes(`branch refs/heads/${state.development!.branch}`) && !entry.split("\n").includes(`worktree ${state.worktree_path}`))) risks.push("managed branch is checked out in another registered worktree; preserve both directories");
      try { assertPhysicalDirectoryFree(state.worktree_path, this.registryRoot ?? directoryRegistryRoot()); } catch (e) { risks.push(boundedReason(e)); }
    }
    return { dev_run_id: devRunID, local_worktree: inspected.view, ...(state?.development ? { branch: state.development.branch } : {}), risks, options: ["worktree", "worktree-and-branch", "keep"] };
  }

  async markAbandoned(devRunID: string): Promise<void> {
    await this.withLock(`devrun-${devRunID}`, async () => {
      const inspected = this.inspectState(devRunID);
      if (!inspected.state || inspected.view.status === "invalid" || inspected.view.status === "removed") return;
      if (["syncing", "sync_interrupted"].includes(inspected.state.lifecycle)) throw worktreeMismatch(devRunID, "pending sync must be completed or abandoned first");
      this.writeState({ ...inspected.state, lifecycle: "abandoned" });
    });
  }

  /** Called after the ledger event is durable; keeps the receipt as evidence but stops later cleanups from re-recording it. */
  markRemovalRecorded(devRunID: string, operationID: string): void { markReceiptRecorded(join(this.root, devRunID), operationID); }

  async cleanup(devRunID: string, runState: string, discardChanges: boolean, authoritativeResultTree?: string, removal?: CleanupRemovalRequest, choice: "worktree" | "worktree-and-branch" | "keep" = "worktree"): Promise<CleanupWorktreeResult> {
    if (choice === "keep") return { removed: false, local_worktree: this.inspect(devRunID) };
    if (!["worktree", "worktree-and-branch"].includes(choice)) throw validation("choice", "choose worktree, worktree-and-branch or keep");
    if (runState === "open") throw new DomainError("STATE_CONFLICT", "resource state does not permit this operation", false, { resource_type: "dev_run", resource_id: devRunID, reason: "only a submitted or abandoned DevRun worktree can be cleaned up" });
    if (runState !== "submitted" && runState !== "abandoned") throw validation("dev_run.state", "must be submitted or abandoned");
    return this.withLock(`devrun-${devRunID}`, () => withRuntimeLock(this.registryRoot ?? directoryRegistryRoot(), "directory-registry", async () => {
      const inspected = this.inspectState(devRunID);
      let recorded = inspected.state;
      if (!recorded && inspected.view.status === "invalid") { try { recorded = this.decode(this.statePath(devRunID)); } catch { /* Invalid metadata remains fenced. */ } }
      if (recorded) assertPhysicalDirectoryFree(recorded.worktree_path, this.registryRoot ?? directoryRegistryRoot());
      if (recorded && ["syncing", "sync_interrupted"].includes(recorded.lifecycle)) throw worktreeMismatch(devRunID, "pending sync recovery material cannot be cleaned up");
      const runDirectory = join(this.root, devRunID);
      const branchRemovalPath = join(runDirectory, "branch-removal.json");
      type BranchRemoval = { format: "grounds.branch-removal/v1"; operation_id: string; branch: string; expected_oid: string; choice: string; phase: "planned" | "completed" };
      let branchRemoval: BranchRemoval | undefined;
      if (recorded?.development && removal) {
        if (existsSync(branchRemovalPath)) {
          branchRemoval = JSON.parse(safeRead(branchRemovalPath).toString());
          if (branchRemoval?.format !== "grounds.branch-removal/v1" || branchRemoval.operation_id !== removal.operation_id || branchRemoval.branch !== recorded.development.branch || branchRemoval.choice !== choice || !isGitOID(branchRemoval.expected_oid)) throw worktreeMismatch(devRunID, "cleanup differs from its recorded branch-removal intent; retain it for recovery");
        } else {
          branchRemoval = { format: "grounds.branch-removal/v1", operation_id: removal.operation_id, branch: recorded.development.branch, expected_oid: recorded.captured_source_commit ?? recorded.baseline_oid, choice, phase: "planned" };
          // Persist only after the safety preview succeeds, immediately before deletion.
        }
      }
      const finishBranchRemoval = (): void => {
        if (!branchRemoval || branchRemoval.phase === "completed") return;
        if (branchRemoval.choice === "worktree-and-branch") {
          const ref = `refs/heads/${branchRemoval.branch}`;
          const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)", ref], { cwd: this.repositoryRoot, encoding: "utf8" }).trim().split("\n");
          if (refs.includes(ref)) {
            if (execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: this.repositoryRoot, encoding: "utf8" }).split("\n").includes(`branch ${ref}`)) throw worktreeMismatch(devRunID, "owned branch is checked out elsewhere; retain it");
            branchGit(this.repositoryRoot, ["update-ref", "-d", ref, branchRemoval.expected_oid.split(":")[1]!]);
          }
        }
        branchRemoval.phase = "completed"; atomicPrivateWrite(branchRemovalPath, JSON.stringify(branchRemoval));
      };
      const owed = removal ? readReceipt(runDirectory) : undefined;
      if (owed && !owed.recorded && !existsSync(owed.worktree_path)) {
        // An earlier cleanup removed the files but stopped before the ledger event: finish bookkeeping, delete nothing.
        finishBranchRemoval();
        if (recorded && recorded.lifecycle !== "removed") { this.writeState({ ...recorded, lifecycle: "removed" }); this.releaseWorkspaceLease(recorded); }
        return { removed: true, local_worktree: { status: "removed" }, removal: owed };
      }
      if (recorded?.external_input) {
        const external = recorded;
        this.releaseWorkspaceLease(external);
        this.writeState({ ...external, lifecycle: "removed" });
        return { removed: false, external_preserved: true, local_worktree: { status: "removed" } };
      }
      if (inspected.view.status === "missing" || inspected.view.status === "removed") {
        if (inspected.state) {
          finishBranchRemoval();
          this.writeState({ ...inspected.state, lifecycle: "removed" });
          this.releaseWorkspaceLease(inspected.state);
          return { removed: false, local_worktree: { status: "removed" } };
        }
        return { removed: false, local_worktree: inspected.view };
      }
      if (inspected.view.status === "invalid" || !inspected.state) throw worktreeMismatch(devRunID, inspected.view.status === "invalid" ? inspected.view.reason : "local worktree state is invalid");
      const state = inspected.state;
      await this.assertAuthoritativeDevelopment(state);
      if (state.development) {
        this.requireAvailable(devRunID);
        assertCommittedDevelopment(state.worktree_path, state.development);
        const preview = this.cleanupPreview(devRunID);
        if (preview.risks.length) throw worktreeMismatch(devRunID, preview.risks.join("; "));
        if (state.lifecycle === "abandoned" && resolveBaseline(state.worktree_path, "HEAD") !== state.baseline_oid) throw worktreeMismatch(devRunID, "abandoned route has unarchived commits; retain its branch and files");
      }
      if (!discardChanges) {
        const ignored = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { cwd: inspected.view.path });
        const artifact = captureArtifact(inspected.view.path, state.baseline_oid);
        const expectedResultTree = state.captured_result_tree_oid ?? authoritativeResultTree;
        const captured = runState === "submitted" && expectedResultTree !== undefined && expectedResultTree === artifact.result_tree_oid;
        const cleanAbandon = runState === "abandoned" && artifact.patch.length === 0;
        if (ignored.length || (!captured && !cleanAbandon)) throw worktreeMismatch(devRunID, "cleanup would discard local changes or ignored files; inspect them first or pass --discard-changes explicitly");
      }
      if (branchRemoval) atomicPrivateWrite(branchRemovalPath, JSON.stringify(branchRemoval));
      const receipt: WorktreeRemovalReceipt | undefined = removal ? { format: RECEIPT_FORMAT, operation_id: removal.operation_id, event_id: this.newID(), dev_run_id: devRunID, worktree_path: state.worktree_path, discard_changes: discardChanges, entry_count: countEntries(state.worktree_path), attribution: removal.attribution, recorded: false } : undefined;
      if (receipt) writeReceipt(runDirectory, receipt);
      execFileSync("git", ["worktree", "remove", ...(state.development ? [] : ["--force"]), state.worktree_path], { cwd: this.repositoryRoot, stdio: "ignore" });
      finishBranchRemoval();
      this.writeState({ ...state, lifecycle: "removed" });
      this.releaseWorkspaceLease(state);
      return { removed: true, local_worktree: { status: "removed" }, ...(receipt ? { removal: receipt } : {}) };
    }));
  }
}
