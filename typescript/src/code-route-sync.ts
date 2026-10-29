import { join } from "node:path";
import { CodeWorkspaceRoutes } from "./code-workspace-route.js";
import { CodeWorkspaces } from "./code-workspace.js";
import type { SyncWorkspace } from "./devrun-sync-service.js";
import { syncData, syncTerminal } from "./devrun-sync-record.js";
import { validation } from "./errors.js";
import { newUUIDv7 } from "./identity.js";
import type { Store } from "./store-types.js";
import { releaseLocalSyncIndex } from "./sync-worktree.js";

/** Reuses merge recovery with the route fence, SQL reservation and Repo mutex.
 * The creation base remains immutable; the DevRun owns the current base. */
export class CodeRouteSyncWorkspace implements SyncWorkspace {
  constructor(private readonly store: Store, readonly repositoryRoot: string) {}

  withSyncWorktree: SyncWorkspace["withSyncWorktree"] = async (runId, syncId, perform) => {
    const routes = new CodeWorkspaceRoutes(this.store), route = await routes.forDevRun(runId);
    if (!route) throw validation("route", "DevRun has no code Workspace route");
    const instance = await new CodeWorkspaces(this.store).instance(route.instance_id);
    const directory = join(instance.data_root!, "runtime", "route-sync", route.route_id, syncId);
    return routes.sync(route.route_id, runId, this.repositoryRoot, syncId, path => perform({
      path, directory,
      // Persistent ownership is the route fence plus the canonical SQL sync.
      // No second mutable base or lifecycle journal needs to be reconciled.
      mark: phase => { if (phase === "active") releaseLocalSyncIndex(directory); },
    }));
  };

  async withStatus<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const rows = await this.store.read(tx => tx.listRuntimeRecords("runtime_operation", runId));
    const pending = rows.find(row => row.data.format === "grounds.devrun-sync/v1" && !syncTerminal(syncData(row)));
    return this.withSyncWorktree(runId, pending?.id ?? newUUIDv7(), action);
  }
}
