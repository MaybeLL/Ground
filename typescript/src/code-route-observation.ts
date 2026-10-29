import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CodeWorkspaceRoutes } from "./code-workspace-route.js";
import { CodeWorkspaces } from "./code-workspace.js";
import { readRouteControl } from "./code-route-fence.js";
import { assertDevelopmentBranch, unfinishedOperationPaths } from "./development-branch.js";
import { sha256 } from "./canonical-json.js";
import { git } from "./env-git.js";
import { safeRead } from "./runtime-files.js";
import type { LocalObservation } from "./dev-worktree.js";
import type { Store } from "./store-types.js";

/** Observes the SQL-owned route without creating host markers, taking leases,
 * refreshing Git, or granting permission to a legacy worktree writer. */
export async function observeCodeRoute(store: Store, runId: string): Promise<(LocalObservation & { route_leased?: boolean }) | undefined> {
  const route = await new CodeWorkspaceRoutes(store).forDevRun(runId);
  if (!route) return undefined;
  try {
    const instance = await new CodeWorkspaces(store).instance(route.instance_id);
    const run = await store.read(tx => tx.getDevRun(runId));
    const root = instance.data_root;
    if (!root || !existsSync(join(root, "runtime", "host-id"))
      || safeRead(join(root, "runtime", "host-id"), 128).toString().trim() !== instance.host_id)
      return { view: { status: "missing", reason: "not_available_on_this_machine" } };
    if (route.database_id !== (await store.open()).database_id || route.database_id !== instance.database_id
      || route.host_id !== instance.host_id || route.dev_run_id !== runId
      || route.repository_id !== instance.target_repository_id || route.issue_revision_id !== instance.issue_revision_id
      || route.issue_revision_id !== run.issue_revision_id || sha256(route.development) !== sha256(run.development)
      || run.initial_base_commit !== route.base_commit
      || route.path !== join(root, "workspaces", instance.instance_id, "development", route.route_id))
      throw new Error("Workspace route and DevRun identity differ");
    if (instance.lifecycle?.state === "code_reclaimed") {
      if (existsSync(route.path)) throw new Error("a directory exists at the reclaimed route path; preserve it for inspection");
      return { view: { status: "removed" } };
    }
    if (!existsSync(route.path)) return { view: { status: "missing", reason: "local_worktree_deleted" } };
    if (route.state !== "prepared" || realpathSync(route.path) !== route.path || !lstatSync(route.path).isDirectory())
      throw new Error("Workspace route is not a prepared physical directory");
    const control = readRouteControl(route);
    assertDevelopmentBranch(route.path, route.development);
    const options = { cwd: route.path, env: { GIT_OPTIONAL_LOCKS: "0" } };
    if (git(["rev-parse", "--path-format=absolute", "--git-common-dir"], options) !== join(root, "cache", "repos", route.repository_id))
      throw new Error("Workspace route Git storage differs");
    return { view: { status: "available", path: route.path, development: route.development,
      head: `${git(["rev-parse", "--show-object-format"], options)}:${git(["rev-parse", "HEAD"], options)}`,
      working_tree_dirty: !!git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], options),
      git_operation_in_progress: unfinishedOperationPaths(route.path).some(path => existsSync(path)),
      active_dev_run_id: runId, owner_phase: "active", initial_base_commit: route.base_commit, base_commit: run.base_commit },
      route_leased: !!control.execution_id, journal: { lifecycle: run.state === "open" ? "active" : run.state, recognized: true } };
  } catch (error) {
    return { view: { status: "invalid", reason: (error instanceof Error ? error.message : String(error)).slice(0, 4096) } };
  }
}
