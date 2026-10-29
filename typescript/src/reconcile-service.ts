import { DevWorktreeModule, type LocalObservation } from "./dev-worktree.js";
import { isRouteLeased } from "./env-route-lease.js";
import { DeliveryWorktreeModule } from "./delivery-worktree.js";
import { DomainError } from "./errors.js";
import { newUUIDv7 } from "./identity.js";
import type { Module, Warning } from "./module.js";
import { computeFindings, hasLocalRisk, localFacts, mergeNextActions, riskReasons, riskSummary, summarizeLocalWork, type LocalFacts } from "./reconcile.js";

const localSnapshot = async (module: Module, dev: DevWorktreeModule, runID: string, override?: LocalObservation): Promise<{ ledger: Awaited<ReturnType<Module["reconcileLedger"]>>; local: LocalFacts }> => {
  const ledger = await module.reconcileLedger(runID);
  const observation = override ?? dev.observe(runID);
  if (ledger.pending_sync && !["syncing", "sync_interrupted"].includes(observation.journal?.lifecycle ?? "")) observation.journal = { lifecycle: "sync_interrupted", recognized: true };
  const pendingSync = ["syncing", "sync_interrupted"].includes(observation.journal?.lifecycle ?? "");
  const local = localFacts(observation, ledger.dev_run.state, ledger.candidate?.result_tree_oid, (path, external) => summarizeLocalWork(path, ledger.baseline_oid, external || override !== undefined, pendingSync));
  return { ledger, local };
};

/** `devrun reconcile`: one read-only view over ledger, local worktree (with its route lease) and delivery directories. */
export const reconcileDevRun = async (module: Module, databaseID: string, cwd: string, runID: string, workspace?: LocalObservation & { route_leased?: boolean }): Promise<Record<string, unknown>> => {
  const dev = new DevWorktreeModule(cwd, databaseID, newUUIDv7);
  const { ledger, local } = await localSnapshot(module, dev, runID, workspace);
  const delivery = ledger.candidate ? { worktrees: new DeliveryWorktreeModule(cwd, databaseID).inspectCandidate(ledger.candidate.candidate_id) } : { worktrees: [] };
  const routeLeased = workspace?.route_leased ?? (local.path !== undefined && isRouteLeased(local.path));
  const { overall, findings } = computeFindings({ ledger: ledger.dev_run.state, local, execution: { route_leased: routeLeased }, delivery });
  if (workspace) for (const finding of findings) for (const action of finding.next_actions) {
    if (action.action.startsWith("cleanup_")) action.description = "Inspect code-workspace cleanup-preview and use Workspace lifecycle cleanup; preserve unarchived changes.";
    if (action.action === "resolve_execution") action.description = "Inspect code-workspace execution-show and explicitly stop or recover the owning execution.";
  }
  return {
    result_type: "patchledger.result.devrun-reconcile/v1",
    command: "devrun.reconcile",
    dev_run_id: runID,
    overall,
    findings,
    next_actions: mergeNextActions(findings),
    ledger: { source: "ledger", dev_run: ledger.dev_run, issue: ledger.issue, ...(ledger.candidate ? { candidate: ledger.candidate } : {}), selection: ledger.selection },
    local_worktree: {
      source: "local_worktree",
      status: local.status,
      ...(local.reason ? { reason: local.reason } : {}),
      ...(local.path ? { path: local.path } : {}),
      ...(local.ownership ? { ownership: local.ownership } : {}),
      ...(local.sync_recovery ? { sync_recovery: local.sync_recovery } : {}),
      ...(local.journal ? { journal_lifecycle: local.journal.lifecycle, journal_lifecycle_recognized: local.journal.recognized } : {}),
      ...(local.work ? { tracked_modified: local.work.tracked_modified, untracked: local.work.untracked, ignored: local.work.ignored } : {}),
      ...(local.captured === undefined ? {} : { captured_by_candidate: local.captured }),
      ...(local.uncaptured_changes === undefined ? {} : { uncaptured_changes: local.uncaptured_changes }),
    },
    route_lease: { held: routeLeased },
    delivery: { source: "delivery", worktrees: delivery.worktrees },
  };
};

/** `devrun uncommitted`: every DevRun of this clone with work that exists only on this machine. */
export const listUncommittedWork = async (module: Module, databaseID: string, cwd: string): Promise<Record<string, unknown>> => {
  const dev = new DevWorktreeModule(cwd, databaseID, newUUIDv7);
  const ids = dev.localRunIDs();
  const items: Array<Record<string, unknown>> = [];
  for (const runID of ids) {
    let snapshot;
    try { snapshot = await localSnapshot(module, dev, runID); }
    catch (error) { if (error instanceof DomainError && error.code === "NOT_FOUND") continue; throw error; }
    const { ledger, local } = snapshot;
    if (!hasLocalRisk(local)) continue;
    items.push({
      dev_run_id: runID,
      issue: ledger.issue,
      ledger_state: ledger.dev_run.state,
      path: local.path ?? local.sync_recovery!.directory,
      tracked_modified: local.work?.tracked_modified ?? null,
      untracked: local.work?.untracked ?? null,
      ignored: local.work?.ignored ?? null,
      ...(local.sync_recovery ? { sync_recovery: local.sync_recovery } : {}),
      risk_reasons: riskReasons(local),
    });
  }
  return { result_type: "patchledger.result.devrun-uncommitted/v1", command: "devrun.uncommitted", discovery_scope: "current_clone", scanned: ids.length, dev_runs: items };
};

export interface UncommittedReminder { warning: Warning; summary: string }

/** Reminder computed before `devrun cleanup` / `devrun abandon` writes anything; best effort and never blocks the command. */
export const uncommittedReminder = async (module: Module, databaseID: string, cwd: string, runID: string): Promise<UncommittedReminder | undefined> => {
  try {
    const { local } = await localSnapshot(module, new DevWorktreeModule(cwd, databaseID, newUUIDv7), runID);
    if (!hasLocalRisk(local)) return undefined;
    const summary = riskSummary(runID, local);
    return { warning: { code: "DEVRUN_UNCOMMITTED_WORK", message: summary }, summary };
  } catch { return undefined; }
};
