import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { CodeWorkspaceRoute } from "./code-workspace-route.js";
import { safeRead, atomicPrivateWrite } from "./runtime-files.js";
import { sha256 } from "./canonical-json.js";
import { DomainError, worktreeMismatch } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import type { RouteExecution, RoutePause } from "./code-route-execution.js";

export interface RouteControl { generation: number; execution_id?: string }
export interface PausedRouteBinding { execution_id: string; pause_id: string; request_digest: string }
export const routeFenceIdentity = (route: CodeWorkspaceRoute) => ({
  format: "grounds.code-route-fence/v1", route_id: route.route_id, instance_id: route.instance_id,
  database_id: route.database_id, host_id: route.host_id, repository_id: route.repository_id,
  path: route.path, branch: route.development.branch, base_commit: route.base_commit, request_digest: route.request_digest,
  ...(route.restoration ? { restoration: route.restoration } : {}),
});
export function readRouteControl(route: CodeWorkspaceRoute): RouteControl {
  const { control, ...identity } = JSON.parse(safeRead(codeRouteFencePath(route.path), 16 * 1024).toString("utf8"));
  if (sha256(identity) !== sha256(routeFenceIdentity(route))) throw worktreeMismatch("", "route reservation identity changed");
  if (control === undefined) return { generation: 0 };
  if (!control || !Number.isSafeInteger(control.generation) || control.generation < 0
    || (control.execution_id !== undefined && (!isUUIDv7(control.execution_id) || control.generation === 0))
    || Object.keys(control).some(key => !["generation", "execution_id"].includes(key))) throw worktreeMismatch("", "route control is invalid");
  return control;
}
export const routeGitPendingPath = (route: CodeWorkspaceRoute): string =>
  join(resolve(route.path, "../../../.."), "runtime", "route-git", route.route_id, "pending.json");
export function assertRoutePreparing(route: CodeWorkspaceRoute, gitOperationId?: string): RouteControl {
  if (!hasCodeRouteFence(route.path)) throw worktreeMismatch("", "route preparation reservation is missing");
  const control = readRouteControl(route);
  if (control.execution_id) throw new DomainError("STATE_CONFLICT", "Route execution must be proven stopped before preparation");
  assertNoPendingRouteGit(route, gitOperationId);
  return control;
}
export function assertNoPendingRouteGit(route: CodeWorkspaceRoute, gitOperationId?: string): void {
  if (existsSync(routeGitPendingPath(route))) {
    const pending = JSON.parse(safeRead(routeGitPendingPath(route), 1024).toString());
    if (!isUUIDv7(pending.operation_id) || pending.operation_id !== gitOperationId)
      throw new DomainError("STATE_CONFLICT", "Recover the pending managed Git operation before preparation");
  }
}
export const routeExecutionPath = (route: CodeWorkspaceRoute, executionId: string): string => {
  if (!isUUIDv7(executionId)) throw worktreeMismatch("", "invalid execution ID");
  return join(resolve(route.path, "../../../.."), "runtime", "route-executions", `${executionId}.json`);
};
/** Only checks durable identity. The caller must also prove engine pause under the route lock. */
export function assertRoutePaused(route: CodeWorkspaceRoute, binding: PausedRouteBinding, gitOperationId?: string): { control: RouteControl; run: RouteExecution } {
  const control = readRouteControl(route);
  if (!isUUIDv7(binding.pause_id) || control.execution_id !== binding.execution_id)
    throw new DomainError("STATE_CONFLICT", "Paused execution no longer owns the route");
  const run = JSON.parse(safeRead(routeExecutionPath(route, binding.execution_id)).toString()) as RouteExecution;
  const path = join(resolve(route.path, "../../../.."), "runtime", "route-pauses", `${binding.pause_id}.json`);
  const window = JSON.parse(safeRead(path, 16 * 1024).toString()) as RoutePause;
  if (run.format !== "grounds.code-route-execution/v1" || run.execution_id !== binding.execution_id
    || run.route_id !== route.route_id || run.database_id !== route.database_id || run.host_id !== route.host_id
    || run.dev_run_id !== route.dev_run_id || run.code_path !== route.path || run.generation !== control.generation
    || run.pause_id !== binding.pause_id || run.state !== "paused"
    || window.format !== "grounds.code-route-pause/v1" || window.operation_id !== binding.pause_id
    || window.execution_id !== run.execution_id || window.route_id !== route.route_id || window.generation !== control.generation
    || window.database_id !== route.database_id || window.host_id !== route.host_id
    || window.request_digest !== binding.request_digest || window.state !== "paused")
    throw new DomainError("STATE_CONFLICT", "The exact pause window is not available for Git");
  assertNoPendingRouteGit(route, gitOperationId);
  return { control, run };
}
/** Caller holds the route lock. Replacement keeps the legacy exclusion continuous. */
export function writeRouteControl(route: CodeWorkspaceRoute, control: RouteControl): void {
  atomicPrivateWrite(codeRouteFencePath(route.path), JSON.stringify({ ...routeFenceIdentity(route), control }));
}

/** Outside the writable worktree; absence of a runtime process never releases it. */
export const codeRouteFencePath = (route: string): string => {
  const path = resolve(route);
  return join(dirname(path), `.${basename(path)}.grounds-route.json`);
};
// Even an unreadable or damaged fence must prevent legacy writers taking over.
export const hasCodeRouteFence = (route: string): boolean => lstatSync(codeRouteFencePath(route), { throwIfNoEntry: false }) !== undefined;

/** A caller selecting a subdirectory must not escape the owning route's fence. */
export const isWithinCodeRoute = (directory: string): boolean => {
  for (let path = resolve(directory); path !== dirname(path); path = dirname(path)) {
    if (hasCodeRouteFence(path)) return true;
  }
  return false;
};
