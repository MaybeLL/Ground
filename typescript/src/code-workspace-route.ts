import { codeRouteFencePath, hasCodeRouteFence, assertRoutePreparing, routeFenceIdentity } from "./code-route-fence.js";
import { assertRoutePaused, type PausedRouteBinding } from "./code-route-fence.js";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodeWorkspaces } from "./code-workspace.js";
import { sha256 } from "./canonical-json.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { assertDevelopmentBranch, developmentBranchName, type DevelopmentIdentity } from "./development-branch.js";
import { DomainError, notFound, validation, worktreeMismatch } from "./errors.js";
import { git, gitTry } from "./env-git.js";
import { isUUIDv7 } from "./identity.js";
import { atomicPrivateWrite, privateDirectory, safeRead, withRuntimeLock } from "./runtime-files.js";
import type { Store } from "./store-types.js";
import { startDevRunInTransaction } from "./devrun-lifecycle.js";
import { savePreparation } from "./preflight.js";
import { assertTargetBase } from "./target-branch.js";
import { syncData, syncTerminal } from "./devrun-sync-record.js";
import { fetchGitArchive } from "./candidate-git-archive.js";

export interface CodeWorkspaceRoute {
  format: "grounds.code-workspace-route/v1";
  route_id: string;
  instance_id: string;
  database_id: string;
  host_id: string;
  repository_id: string;
  issue_revision_id: string;
  development: DevelopmentIdentity;
  base_commit: string;
  restoration?: { candidate_id: string; source_commit: string };
  path: string;
  request_digest: string;
  state: "preparing" | "prepared" | "blocked";
  execution_enabled: false;
  dev_run_id?: string;
  attribution: Attribution;
  created_at: string;
}
export interface PrepareCodeRoute {
  instance_id: string; operation_id: string; host_id: string;
  data_root: string; issue_slug: string; attribution: Attribution;
}

/** Prepares code only. A route record does not grant DevRun admission or execution. */
export class CodeWorkspaceRoutes {
  constructor(private readonly store: Store) {}

  async show(id: string): Promise<CodeWorkspaceRoute> {
    if (!isUUIDv7(id)) throw validation("route_id", "requires UUIDv7");
    const row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", id));
    if (!row || row.data.format !== "grounds.code-workspace-route/v1") throw notFound("config", id);
    return row.data as unknown as CodeWorkspaceRoute;
  }

  /** Resolve from authoritative DevRun identity, never from a caller's path marker. */
  async forDevRun(devRunId: string): Promise<CodeWorkspaceRoute | undefined> {
    const row = await this.store.read(async tx => {
      const run = await tx.getDevRun(devRunId);
      return run.development ? tx.getRuntimeRecord("runtime_operation", run.development.workspace_id) : undefined;
    });
    return row?.data.format === "grounds.code-workspace-route/v1" ? this.show(row.id) : undefined;
  }

  async bindDevRun(input: { execution_mode?: import("./development-mode.js").DevelopmentModeSelection; route_id: string; operation_id: string; host_id: string; data_root: string; attribution: Attribution }): Promise<CodeWorkspaceRoute> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id)) throw validation("operation_id", "requires UUIDv7");
    validateAttribution(request.attribution);
    const route = await this.show(request.route_id);
    const root = resolve(request.data_root);
    const owner = await new CodeWorkspaces(this.store).instance(route.instance_id);
    if (owner.host_id !== request.host_id || owner.data_root !== root) throw validation("instance", "host or data root differs from the recorded instance");
    return withRuntimeLock(join(root, "runtime"), `code-route:${route.route_id}`, async () => {
      const current = await this.show(route.route_id);
      const instance = await new CodeWorkspaces(this.store).inspectPreparedInstance({ instance_id: current.instance_id, host_id: request.host_id, data_root: root });
      if (current.state !== "prepared" || current.host_id !== request.host_id || current.database_id !== instance.database_id
        || current.repository_id !== instance.target_repository_id || current.issue_revision_id !== instance.issue_revision_id
        || current.path !== join(root, "workspaces", instance.instance_id, "development", current.route_id)) throw worktreeMismatch("", "route no longer matches its prepared instance");
      assertRoutePreparing(current);
      assertDevelopmentBranch(current.path, current.development);
      if (git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: current.path }) !== join(root, "cache", "repos", current.repository_id)
        || git(["rev-parse", "HEAD"], { cwd: current.path }) !== (current.restoration?.source_commit ?? current.base_commit).split(":")[1]) throw worktreeMismatch("", "route Git identity or prepared source changed");
      if (current.restoration?.candidate_id !== instance.restoration?.candidate_id
        || current.restoration?.source_commit !== instance.restoration?.source_commit) throw worktreeMismatch("", "route restoration differs from its instance");
      return this.store.write(async tx => {
        const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.route-bind", request_hash: sha256(request) });
        if (replay) return JSON.parse(replay.result_json) as CodeWorkspaceRoute;
        await tx.lockRuntimeRecord("runtime_operation", current.route_id);
        const row = (await tx.getRuntimeRecord("runtime_operation", current.route_id))!;
        if (row.data.dev_run_id) throw new DomainError("STATE_CONFLICT", "Route already belongs to a DevRun");
        const revision = await tx.getIssueRevisionById(current.issue_revision_id);
        const issue = await tx.getIssue(revision.issue_id);
        const repository = await tx.getRepository(issue.repository_id);
        if (!revision.target_branch) throw validation("target_branch", "new code routes require a declared target flow");
        assertTargetBase(current.path, revision.target_branch, (await tx.listRepositoryRemotes(repository.id)).map(item => item.remote), current.base_commit);
        let frozenVerifications: string[] | undefined;
        if (current.restoration) {
          const parent = await tx.findCandidateArtifactRef({ candidate_id: current.restoration.candidate_id });
          if (!parent || parent.issue_revision_id !== revision.id || parent.base_commit !== current.base_commit
            || parent.source?.commit !== current.restoration.source_commit) throw validation("restoration", "Candidate no longer matches the route's fixed source");
          await tx.lockCandidateVerifications(parent.candidate_id);
          const page = await tx.listVerificationSummariesPage(parent.candidate_id, "", 256);
          if (page.more) throw new DomainError("ARTIFACT_TOO_LARGE", "refinement cannot freeze more than 256 Verifications");
          if (page.rows.some(item => item.candidate_id !== parent.candidate_id || !["qualified", "rejected", "inconclusive"].includes(item.overall_verdict))
            || new Set(page.rows.map(item => item.id)).size !== page.rows.length) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Invalid refinement Verification snapshot");
          frozenVerifications = page.rows.map(item => item.id);
        }
        await startDevRunInTransaction(tx, { ...request, id: request.operation_id, issue_revision: revision,
          requirement_revision: await tx.getRequirementRevision(issue.requirement_id, revision.requirement_revision_id),
          repository_id: repository.id, repository_remote_snapshot: repository.canonical_remote,
          development: current.development, base_commit: current.base_commit,
          ...(current.restoration ? { refines_candidate_id: current.restoration.candidate_id } : {}) });
        if (frozenVerifications) await tx.createDevRunRefinementVerifications(request.operation_id, frozenVerifications);
        await savePreparation(tx, request.operation_id, request.operation_id, request.attribution);
        const bound = { ...current, dev_run_id: request.operation_id };
        await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...bound } }, row.version);
        await tx.completeOperation(request.operation_id, JSON.stringify(bound));
        return bound;
      });
    });
  }

  /** Serialized access with the existing preparation or exact paused-execution ownership. */
  async capture<T>(routeId: string, devRunId: string, cwd: string, action: (path: string) => Promise<T>, repositories: "target" | "all" = "target", gitOperationId?: string, paused?: PausedRouteBinding): Promise<T> {
    return this.captureRoute(routeId, devRunId, cwd, action, repositories, gitOperationId, paused);
  }

  /** Only a checked Candidate replay may read a submitted route; it never grants Git execution. */
  async captureCandidate<T>(routeId: string, devRunId: string, cwd: string, replay: boolean, action: (path: string) => Promise<T>): Promise<T> {
    return this.captureRoute(routeId, devRunId, cwd, action, "target", undefined, undefined, replay ? "submitted" : undefined);
  }

  /** Abandon changes only the run record; existing code and unarchived work remain. */
  async abandon<T>(routeId: string, devRunId: string, cwd: string, action: () => Promise<T>): Promise<T> {
    return this.captureRoute(routeId, devRunId, cwd, action, "target", undefined, undefined, "abandoned");
  }

  /** A durable sync reservation excludes all other managed writes and execution. */
  async sync<T>(routeId: string, devRunId: string, cwd: string, syncId: string, action: (path: string) => Promise<T>): Promise<T> {
    if (!isUUIDv7(syncId)) throw validation("sync_id", "requires UUIDv7");
    return this.captureRoute(routeId, devRunId, cwd, action, "target", undefined, undefined, undefined, syncId);
  }

  private async captureRoute<T>(routeId: string, devRunId: string, cwd: string, action: (path: string) => Promise<T>, repositories: "target" | "all", gitOperationId?: string, paused?: PausedRouteBinding, terminalReplay?: "submitted" | "abandoned", syncId?: string): Promise<T> {
    const observed = await this.show(routeId);
    const instance = await new CodeWorkspaces(this.store).instance(observed.instance_id);
    const root = instance.data_root;
    if (!root || safeRead(join(root, "runtime", "host-id"), 128).toString().trim() !== instance.host_id
      || realpathSync(cwd) !== observed.path) throw worktreeMismatch(devRunId, "observe this route on its recorded host from its root directory");
    const ids = repositories === "all" ? [...new Set(instance.baselines.map(item => item.repository_id))].sort() : [observed.repository_id];
    const locked = (index: number, action: () => Promise<T>): Promise<T> => index === ids.length ? action()
      : withRuntimeLock(join(root, "runtime"), `repository:${ids[index]}`, () => locked(index + 1, action), 30_000);
    return withRuntimeLock(join(root, "runtime"), `code-route:${routeId}`, () =>
      locked(0, async () => {
        const route = await this.show(routeId);
        await new CodeWorkspaces(this.store).inspectPreparedInstance({ instance_id: instance.instance_id, host_id: instance.host_id, data_root: root });
        const run = await this.store.read(tx => tx.getDevRun(devRunId));
        if (route.state !== "prepared" || route.dev_run_id !== run.id || (run.state !== "open" && run.state !== terminalReplay)
          || route.database_id !== (await this.store.open()).database_id || route.host_id !== instance.host_id
          || route.repository_id !== instance.target_repository_id || route.issue_revision_id !== run.issue_revision_id
          || route.issue_revision_id !== instance.issue_revision_id || sha256(run.development) !== sha256(route.development)
          || run.initial_base_commit !== route.base_commit || route.path !== join(root, "workspaces", instance.instance_id, "development", routeId)) throw worktreeMismatch(devRunId, "route and DevRun binding no longer match");
        const operations = await this.store.read(tx => tx.listRuntimeRecords("runtime_operation", devRunId));
        if (operations.some(row => row.data.format === "grounds.devrun-sync/v1" && !syncTerminal(syncData(row)) && row.id !== syncId))
          throw new DomainError("STATE_CONFLICT", "Complete or abandon the pending route sync before Git writes, admission or execution");
        if (paused) assertRoutePaused(route, paused, gitOperationId);
        else assertRoutePreparing(route, gitOperationId);
        assertDevelopmentBranch(route.path, route.development);
        if (realpathSync(route.path) !== route.path || git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: route.path }) !== join(root, "cache", "repos", route.repository_id)) throw worktreeMismatch(devRunId, "route Git storage changed");
        return action(route.path);
      }));
  }

  async prepare(input: PrepareCodeRoute): Promise<CodeWorkspaceRoute> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id)) throw validation("operation_id", "requires UUIDv7");
    validateAttribution(request.attribution);
    const development: DevelopmentIdentity = { format: "grounds.development-branch/v1", workspace_id: request.operation_id,
      branch: developmentBranchName(request.issue_slug, request.operation_id) };
    const workspaces = new CodeWorkspaces(this.store);
    const observed = await workspaces.instance(request.instance_id);
    if (observed.state !== "prepared" || !observed.data_root) throw new DomainError("STATE_CONFLICT", "Prepare the code Workspace before creating a route");
    const root = resolve(request.data_root);
    if (observed.host_id !== request.host_id || observed.data_root !== root) throw validation("instance", "host or data root differs from the recorded instance");
    return withRuntimeLock(join(root, "runtime"), `code-route:${request.operation_id}`, () =>
      withRuntimeLock(join(root, "runtime"), `repository:${observed.target_repository_id}`, async () => {
        const instance = await workspaces.inspectPreparedInstance({ instance_id: request.instance_id, host_id: request.host_id, data_root: root });
        const baseline = instance.baselines.find(item => item.repository_id === instance.target_repository_id)!;
        const directory = join(root, "workspaces", instance.instance_id, "development");
        const path = join(directory, request.operation_id);
        const cache = join(root, "cache", "repos", instance.target_repository_id);
        if (instance.restoration) {
          const observation = fetchGitArchive(cache, instance.restoration.archive_binding);
          if (observation.status !== "confirmed" || observation.integrity !== "complete") throw new DomainError("BASELINE_UNAVAILABLE", "Candidate archive could not be restored with complete fixed history; retry without changing its identity");
        }
        const route = await this.store.write(async tx => {
          const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.route-prepare", request_hash: sha256(request) });
          if (replay) {
            const row = await tx.getRuntimeRecord("runtime_operation", request.operation_id);
            if (!row || row.data.format !== "grounds.code-workspace-route/v1") throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Route reservation is missing");
            return row.data as unknown as CodeWorkspaceRoute;
          }
          if (lstatSync(path, { throwIfNoEntry: false }) || hasCodeRouteFence(path)
            || gitTry(["rev-parse", "--verify", `refs/heads/${development.branch}`], { gitDir: cache })) throw worktreeMismatch("", "new route path, branch or reservation is already occupied; preserve it");
          const route: CodeWorkspaceRoute = { format: "grounds.code-workspace-route/v1", route_id: request.operation_id,
            instance_id: instance.instance_id, database_id: instance.database_id, host_id: instance.host_id,
            repository_id: instance.target_repository_id, issue_revision_id: instance.issue_revision_id, development,
            base_commit: instance.restoration?.archive_binding.base_commit ?? baseline.commit, path, request_digest: sha256(request), state: "preparing", execution_enabled: false,
            ...(instance.restoration ? { restoration: { candidate_id: instance.restoration.candidate_id, source_commit: instance.restoration.source_commit } } : {}),
            attribution: request.attribution, created_at: await tx.now() };
          await tx.saveRuntimeRecord({ kind: "runtime_operation", id: route.route_id, parent_id: route.instance_id, version: 1, data: { ...route } }, 0);
          // Complete allocation, not materialization: retry consults the live route record.
          await tx.completeOperation(request.operation_id, JSON.stringify({ route_id: route.route_id }));
          return route;
        });
        const persist = async () => this.store.write(async tx => {
          const row = (await tx.getRuntimeRecord("runtime_operation", route.route_id))!;
          await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...route } }, row.version);
        });
        if (hasCodeRouteFence(path)) assertRoutePreparing(route);
        try {
          privateDirectory(directory);
          const fence = routeFenceIdentity(route);
          if (hasCodeRouteFence(path)) {
            assertRoutePreparing(route);
          } else {
            if (lstatSync(path, { throwIfNoEntry: false }) || route.state === "prepared") throw worktreeMismatch("", "existing route lost its preparation reservation; explicit recovery is required");
            atomicPrivateWrite(codeRouteFencePath(path), JSON.stringify(fence));
          }
          const start = route.restoration?.source_commit ?? route.base_commit;
          if (!existsSync(path)) git(["worktree", "add", "-b", development.branch, "--", path, start.split(":")[1]!], { gitDir: cache });
          assertDevelopmentBranch(path, route.development);
          if (git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path }) !== cache
            || git(["rev-parse", "HEAD"], { cwd: path }) !== start.split(":")[1]) throw worktreeMismatch("", "route Git identity or prepared source changed; preserve it");
          route.state = "prepared";
          await persist();
          return route;
        } catch (error) {
          route.state = "blocked";
          await persist();
          throw error;
        }
      }, 30_000));
  }
}
