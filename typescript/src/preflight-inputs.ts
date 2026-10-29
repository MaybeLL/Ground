import { existsSync } from "node:fs";
import { sha256, sha256Bytes } from "./canonical-json.js";
import { captureArtifact, resolveBaseline } from "./git.js";
import { assertNoHistoryFilters } from "./git-history.js";
import { branchGit, unfinishedOperationPaths } from "./development-branch.js";
import { workspaceIdentity } from "./workspace-provider.js";
import { DevWorktreeModule } from "./dev-worktree.js";
import { newUUIDv7 } from "./identity.js";
import { DomainError } from "./errors.js";
import { PREPARATION_FORMAT } from "./preflight-admission.js";
import type { Store, Tx } from "./store-types.js";
import { CodeWorkspaceRoutes } from "./code-workspace-route.js";

export interface PreflightRunInputs {
  dev_run_id: string;
  dev_run_version: number;
  base_commit: string;
  parent_candidate_id?: string;
  parent_result_tree?: string;
  parent_patch_digest?: string;
  preparation_id?: string;
  source_head: string;
  source_tree: string;
  input_digest: string;
  sync_digest: string;
  workspace_identity: string;
}

const fail = (id: string, reason: string): never => {
  throw new DomainError("STATE_CONFLICT", reason, false, { resource_id: id, reason });
};

export async function capturePreflightInputs(tx: Tx, devRunId: string, path: string): Promise<PreflightRunInputs> {
  const run = await tx.getDevRun(devRunId);
  if (run.state !== "open") fail(devRunId, "preflight input capture requires an open DevRun");
  const revision = await tx.getIssueRevisionById(run.issue_revision_id);
  const base = run.base_commit ?? revision.baseline.git_oid;
  if (unfinishedOperationPaths(path).some(p => existsSync(p)) || branchGit(path, ["ls-files", "-u", "-z"]).length) {
    fail(devRunId, "complete the Git operation before evaluating development inputs");
  }
  new TextDecoder("utf-8", { fatal: true }).decode(branchGit(path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
  assertNoHistoryFilters(path);
  const records = await tx.listRuntimeRecords("runtime_operation", devRunId);
  const syncs = records.filter(row => row.data.format === "grounds.devrun-sync/v1");
  if (syncs.some(row => !["completed", "abandoned"].includes(String(row.data.phase)))) fail(devRunId, "complete or abandon the pending sync before evaluating inputs");
  const preparation = records.filter(row => row.data.format === PREPARATION_FORMAT)
    .sort((a, b) => Number(b.data.transition_seq ?? 0) - Number(a.data.transition_seq ?? 0) || b.id.localeCompare(a.id))[0];
  const parent = run.refines_candidate_id ? (await tx.getCandidate(run.refines_candidate_id)).candidate : undefined;
  const head = resolveBaseline(path, "HEAD");
  const index = sha256Bytes(branchGit(path, ["ls-files", "--stage", "-z"]));
  const route = run.development ? await tx.getRuntimeRecord("runtime_operation", run.development.workspace_id) : undefined;
  // New code routes keep control files outside the worktree. Use the existing
  // runtime-excluding capture mode without requiring a source .gitignore edit.
  const codeRoute = route?.data.format === "grounds.code-workspace-route/v1" && route.data.dev_run_id === run.id;
  const artifact = captureArtifact(path, base, codeRoute);
  if (head !== resolveBaseline(path, "HEAD") || index !== sha256Bytes(branchGit(path, ["ls-files", "--stage", "-z"]))) fail(devRunId, "development inputs changed during observation");
  return {
    dev_run_id: run.id, dev_run_version: run.version, base_commit: base,
    ...(parent ? { parent_candidate_id: parent.id, parent_result_tree: parent.result_tree_oid, parent_patch_digest: parent.patch_digest } : {}),
    ...(preparation ? { preparation_id: preparation.id } : {}),
    source_head: head, source_tree: artifact.result_tree_oid,
    input_digest: sha256({ head, index, tree: artifact.result_tree_oid, patch: artifact.patch_digest }),
    sync_digest: sha256(syncs.map(row => ({ id: row.id, version: row.version, data: row.data })).sort((a, b) => a.id.localeCompare(b.id))),
    workspace_identity: sha256({ path, identity: workspaceIdentity(path) }),
  };
}

export async function withPreflightScene<T>(store: Store, root: string, devRunId: string, action: (path: string) => Promise<T>): Promise<T> {
  const routeId = await store.read(async tx => {
    const run = await tx.getDevRun(devRunId);
    if (!run.development) return undefined;
    const row = await tx.getRuntimeRecord("runtime_operation", run.development.workspace_id);
    return row?.data.format === "grounds.code-workspace-route/v1" ? row.id : undefined;
  });
  if (routeId) return new CodeWorkspaceRoutes(store).capture(routeId, devRunId, root, action);
  const metadata = await store.open();
  const worktrees = new DevWorktreeModule(root, metadata.database_id, newUUIDv7, store);
  return worktrees.capture(devRunId, action);
}

export async function withPreflightInputs<T>(store: Store, root: string, devRunId: string,
  action: (inputs: PreflightRunInputs, path: string) => Promise<T>): Promise<T> {
  return withPreflightScene(store, root, devRunId, async path => {
    const before = await store.read(tx => capturePreflightInputs(tx, devRunId, path));
    const after = await store.read(tx => capturePreflightInputs(tx, devRunId, path));
    if (sha256(before) !== sha256(after)) fail(devRunId, "development inputs changed during observation");
    return action(after, path);
  });
}
