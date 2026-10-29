import { captureArtifact, discoverRepository } from "./git.js";
import { runGit, withIsolatedGitObjects } from "./git-command.js";
import type { LocalObservation } from "./dev-worktree.js";

/** Counts describing one local worktree, always measured relative to its HEAD (the Baseline). */
export interface LocalWorkSummary {
  tracked_modified: number;
  untracked: number;
  ignored: number;
  result_tree_oid?: string;
}

/**
 * Measure a worktree without changing it.  Every Git call runs against a
 * scratch object store with optional locks disabled, so the clone's index,
 * refs and object database are left byte-for-byte unchanged.
 */
export const summarizeLocalWork = (worktreePath: string, baselineOID: string, external: boolean, pendingSync = false): LocalWorkSummary =>
  withIsolatedGitObjects(worktreePath, () => {
    const root = discoverRepository(worktreePath).root;
    const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"]);
    let tracked = 0, untracked = 0;
    const fields = status.toString("utf8").split("\0");
    for (let index = 0; index < fields.length; index += 1) {
      const entry = fields[index];
      if (!entry) continue;
      const code = entry.slice(0, 2);
      if (code === "??") untracked += 1;
      else {
        tracked += 1;
        // Renames and copies carry their source path as a separate field.
        if (code.includes("R") || code.includes("C")) index += 1;
      }
    }
    const ignored = runGit(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).length;
    // An unmerged index has no result tree; status counts are still real local work.
    const artifact = pendingSync ? undefined : captureArtifact(root, baselineOID, external);
    return { tracked_modified: tracked, untracked, ignored, ...(artifact ? { result_tree_oid: artifact.result_tree_oid } : {}) };
  });

export type LedgerDevRunState = "open" | "submitted" | "abandoned";
export type FindingCode =
  | "open_local_ready" | "open_local_missing" | "open_local_removed" | "local_invalid" | "ledger_local_lifecycle_mismatch"
  | "sync_in_progress" | "sync_interrupted" | "sync_recovery_retained"
  | "submitted_local_dirty" | "abandoned_local_dirty" | "local_state_unrecognized" | "delivery_changed" | "route_leased";
export type FindingSeverity = "info" | "attention" | "needs_inspection";
export type Overall = "consistent" | "attention" | "needs_inspection";

export interface NextAction { action: string; description: string; requires: "none" | "authorization" }
export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  sources: Array<"ledger" | "local_worktree" | "delivery">;
  fields: Record<string, string | number | boolean>;
  next_actions: NextAction[];
}

export interface LocalFacts {
  status: "available" | "missing" | "removed" | "invalid" | "unknown";
  reason?: string;
  path?: string;
  ownership?: "external";
  journal?: { lifecycle: string; recognized: boolean };
  work?: LocalWorkSummary;
  sync_recovery?: { directory: string; count: number };
  /** Present only for a submitted DevRun whose Candidate result tree is known. */
  captured?: boolean;
  uncaptured_changes?: boolean;
}

export interface ExecutionFacts {
  /** The route lease is local state: it is held only while an execution owns the route. */
  route_leased: boolean;
}

export interface DeliveryFacts { worktrees: Array<{ target_path: string; status: string; reason: string; branch?: string }> }

const bounded = (value: string, limit = 256): string => [...value].slice(0, limit).join("");

/** Local facts for one worktree, given the ledger-side result tree used to decide whether its content is already captured. */
export const localFacts = (observation: LocalObservation, ledgerState: LedgerDevRunState, candidateResultTree: string | undefined, measure: (path: string, external: boolean) => LocalWorkSummary): LocalFacts => {
  const view = observation.view;
  const base: LocalFacts = { status: view.status, ...(observation.sync_recovery ? { sync_recovery: observation.sync_recovery } : {}), ...(observation.journal ? { journal: observation.journal } : {}), ...(observation.external ? { ownership: "external" as const } : {}) };
  if (view.status === "missing") return { ...base, reason: view.reason };
  if (view.status === "invalid") return { ...base, reason: bounded(view.reason, 4096) };
  if (view.status !== "available") return base;
  let work: LocalWorkSummary;
  try { work = measure(view.path, observation.external === true); }
  catch (error) { return { ...base, status: "unknown", path: view.path, reason: bounded(error instanceof Error ? error.message : String(error), 4096) }; }
  // Same whole-tree rule as `devrun cleanup`: a submitted DevRun whose current
  // tree equals its Candidate's result tree has nothing left uncaptured.
  const captured = ledgerState === "submitted" && candidateResultTree !== undefined && candidateResultTree === work.result_tree_oid;
  const dirty = work.tracked_modified + work.untracked > 0;
  return { ...base, path: view.path, work, ...(ledgerState === "submitted" && candidateResultTree !== undefined ? { captured } : {}), uncaptured_changes: captured ? false : dirty };
};

const expectedJournal: Record<LedgerDevRunState, string[]> = { open: ["active", "syncing", "sync_interrupted"], submitted: ["submitted", "removed"], abandoned: ["abandoned", "removed"] };

const action = (name: string, description: string, requires: NextAction["requires"] = "none"): NextAction => ({ action: name, description, requires });

/** Work that exists only on this machine: uncaptured changes or ignored files. */
export const hasLocalRisk = (local: LocalFacts): boolean => Boolean(local.sync_recovery?.count) || (local.status === "available" && (local.uncaptured_changes === true || (local.work?.ignored ?? 0) > 0));

export const riskReasons = (local: LocalFacts): Array<"uncaptured_changes" | "ignored_files" | "sync_recovery"> => [
  ...(local.sync_recovery?.count ? ["sync_recovery" as const] : []),
  ...(local.uncaptured_changes ? ["uncaptured_changes" as const] : []),
  ...((local.work?.ignored ?? 0) > 0 ? ["ignored_files" as const] : []),
];

export const riskSummary = (devRunID: string, local: LocalFacts): string =>
  `DevRun ${devRunID} has work that exists only on this machine and is not visible in the ledger: ${local.work?.tracked_modified ?? 0} tracked modification(s), ${local.work?.untracked ?? 0} untracked file(s), ${local.work?.ignored ?? 0} ignored file(s)${local.sync_recovery ? `; ${local.sync_recovery.count} retained sync recovery directory/directories at ${local.sync_recovery.directory}` : ""}.`;

export const computeFindings = (input: { ledger: LedgerDevRunState; local: LocalFacts; execution: ExecutionFacts; delivery: DeliveryFacts }): { overall: Overall; findings: Finding[] } => {
  const { ledger, local, execution, delivery } = input;
  const findings: Finding[] = [];
  const journal = local.journal;
  const add = (finding: Finding) => findings.push(finding);

  if (journal?.recognized && ["syncing", "sync_interrupted"].includes(journal.lifecycle))
    add({ code: journal.lifecycle === "syncing" ? "sync_in_progress" : "sync_interrupted", severity: "attention", sources: ["ledger", "local_worktree"], fields: { ledger_state: ledger, journal_lifecycle: journal.lifecycle }, next_actions: [action("complete_sync", "Inspect recovery state and explicitly complete sync after resolving conflicts.", "authorization"), action("abandon_sync", "Save post-sync edits and explicitly restore the original worktree and index.", "authorization")] });
  if (local.sync_recovery)
    add({ code: "sync_recovery_retained", severity: "attention", sources: ["local_worktree"], fields: { count: local.sync_recovery.count, directory: local.sync_recovery.directory }, next_actions: [action("inspect_sync_recovery", "Recovery material exists only on this machine; retain it and inspect saved edits before cleanup.")] });
  if (ledger === "open" && local.status === "available" && journal?.recognized && journal.lifecycle === "active")
    add({ code: "open_local_ready", severity: "info", sources: ["ledger", "local_worktree"], fields: { ledger_state: ledger, journal_lifecycle: journal.lifecycle }, next_actions: [action("continue_development", "Continue in the managed worktree; this view changed nothing.")] });
  if (ledger === "open" && local.status === "missing")
    add({ code: "open_local_missing", severity: "attention", sources: ["ledger", "local_worktree"], fields: { ledger_state: ledger, local_status: local.status, ...(local.reason ? { reason: local.reason } : {}) }, next_actions: [action("return_to_original_machine", "Resume on the machine that created this DevRun."), action("start_new_devrun", "Start a new DevRun for the same Issue Version.", "authorization")] });
  if (ledger === "open" && local.status === "removed")
    add({ code: "open_local_removed", severity: "attention", sources: ["ledger", "local_worktree"], fields: { ledger_state: ledger, local_status: local.status }, next_actions: [action("start_new_devrun", "The local worktree was removed; start a new DevRun for the same Issue Version.", "authorization")] });
  if (local.status === "invalid" || local.status === "unknown")
    add({ code: "local_invalid", severity: "attention", sources: ["ledger", "local_worktree"], fields: { ledger_state: ledger, ...(local.reason ? { reason: local.reason } : {}) }, next_actions: [action("inspect_manually", "Inspect the local state and worktree; do not delete .grounds/ files.")] });
  if (journal?.recognized && !expectedJournal[ledger].includes(journal.lifecycle) && !(ledger === "open" && journal.lifecycle === "removed"))
    add({ code: "ledger_local_lifecycle_mismatch", severity: "attention", sources: ["ledger", "local_worktree"], fields: { ledger_state: ledger, journal_lifecycle: journal.lifecycle }, next_actions: [action("inspect_manually", "The ledger and the local journal disagree about this DevRun; inspect before changing either side.")] });
  const dirty = hasLocalRisk(local);
  const counts = { tracked_modified: local.work?.tracked_modified ?? 0, untracked: local.work?.untracked ?? 0, ignored: local.work?.ignored ?? 0 };
  if (ledger === "submitted" && dirty)
    add({ code: "submitted_local_dirty", severity: "attention", sources: ["ledger", "local_worktree"], fields: { ledger_state: ledger, ...counts }, next_actions: [action("capture_or_export_changes", "Capture the changes in a new DevRun or export them before cleanup."), action("cleanup_discard_changes", "Remove the worktree and discard these local changes.", "authorization")] });
  if (ledger === "abandoned" && dirty)
    add({ code: "abandoned_local_dirty", severity: "attention", sources: ["ledger", "local_worktree"], fields: { ledger_state: ledger, ...counts }, next_actions: [action("export_changes", "Export anything worth keeping before cleanup."), action("cleanup_discard_changes", "Remove the worktree and discard these local changes.", "authorization")] });
  if (journal && !journal.recognized)
    add({ code: "local_state_unrecognized", severity: "needs_inspection", sources: ["local_worktree"], fields: { journal_lifecycle: journal.lifecycle }, next_actions: [action("inspect_manually", "This version does not recognise the local lifecycle value; inspect it, possibly with a newer Grounds, before acting.")] });
  const changedDelivery = delivery.worktrees.filter((worktree) => worktree.status === "changed" || worktree.status === "invalid");
  if (changedDelivery.length)
    add({ code: "delivery_changed", severity: "attention", sources: ["delivery"], fields: { count: changedDelivery.length, first_target_path: changedDelivery[0].target_path, first_status: changedDelivery[0].status }, next_actions: [action("inspect_delivery", "Run `selection inspect` for the delivery directory and preserve user work.")] });
  if (execution.route_leased) add({ code: "route_leased", severity: "attention", sources: ["local_worktree"], fields: { ledger_state: ledger }, next_actions: [action("resolve_execution", "wait for the running execution to finish, or cancel it with env cancel, before changing this route")] });
  const overall: Overall = findings.some((f) => f.severity === "needs_inspection") ? "needs_inspection" : findings.some((f) => f.severity === "attention") ? "attention" : "consistent";
  return { overall, findings };
};

/** Next actions across all findings, de-duplicated in finding order. */
export const mergeNextActions = (findings: Finding[]): NextAction[] => {
  const seen = new Set<string>();
  const merged: NextAction[] = [];
  for (const finding of findings) for (const next of finding.next_actions) if (!seen.has(next.action)) { seen.add(next.action); merged.push(next); }
  return merged;
};
