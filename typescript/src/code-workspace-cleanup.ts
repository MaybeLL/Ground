import { realpathSync, lstatSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodeWorkspaces, type CodeWorkspaceInstance, type CodeWorkspaceLifecycle } from "./code-workspace.js";
import type { CodeWorkspaceRoute } from "./code-workspace-route.js";
import { assertRoutePreparing } from "./code-route-fence.js";
import { sha256 } from "./canonical-json.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { DomainError, validation } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { safeRead, withRuntimeLock, directoryRegistryRoot } from "./runtime-files.js";
import { git, gitTry } from "./env-git.js";
import { assertPhysicalDirectoryFree, physicalIdentity } from "./physical-directory.js";
import { isRouteLeased } from "./env-route-lease.js";
import { assertNoHistoryFilters } from "./git-history.js";
import { unfinishedOperationPaths } from "./development-branch.js";
import { inspectGitArchive, validateArchiveProtectionEvidence, type ArchivePolicyCheck } from "./candidate-git-archive.js";
import type { Store } from "./store-types.js";

interface WorkspaceLocation { instance_id: string; host_id: string; data_root: string }
interface ReclaimWorkspace extends WorkspaceLocation {
  operation_id: string; expected_version: number; plan_digest: string; early?: boolean; attribution: Attribution;
}
interface CleanupJournal {
  format: "grounds.code-workspace-cleanup/v1"; operation_id: string; instance_id: string; request_digest: string;
  phase: "pending" | "completed";
  items: { resource: Resource; view: CleanupResource; phase: "pending" | "removing" | "removed" | "blocked" }[];
  result?: CleanupResult;
}
export interface CleanupResult { instance_id: string; operation_id: string; scope: "code_worktrees"; resources: CleanupResource[] }
interface EndWorkspace extends WorkspaceLocation {
  operation_id: string; expected_version: number; attribution: Attribution; retention_days?: number; pinned?: boolean;
}
interface ResourceIdentity { directory: string; administration: string; cache: string; git_dir: string; head: string; tree: string }
interface Resource { id: string; kind: "baseline" | "development"; repository_id: string; path: string; cache: string;
  commit: string; pin_commit?: string; tree?: string; branch?: string; dev_run_id?: string; restores_candidate_id?: string; pin?: string }
export interface CleanupResource {
  id: string; kind: Resource["kind"]; path: string; state: "eligible" | "blocked" | "removed";
  reason?: string; identity?: ResourceIdentity; estimated_bytes?: number;
}
export interface CleanupPlan {
  instance_id: string; lifecycle_version: number; scope: "code_worktrees";
  gate: "ready" | "retention" | "pinned"; resources: CleanupResource[]; plan_digest: string; retained_paths: string[];
}
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };

/** Explicit local lifecycle; it never deletes the shared cache or runtime evidence. */
export class CodeWorkspaceCleanup {
  constructor(private readonly store: Store, private readonly options: { policyCheck?: ArchivePolicyCheck } = {}) {}

  private async routes(instanceId: string): Promise<CodeWorkspaceRoute[]> {
    return (await this.store.read(tx => tx.listRuntimeRecords("runtime_operation", instanceId)))
      .filter(row => row.data.format === "grounds.code-workspace-route/v1")
      .map(row => row.data as unknown as CodeWorkspaceRoute).sort((a, b) => a.route_id.localeCompare(b.route_id));
  }

  /** Workspace -> sorted routes -> sorted repositories. Preparation never acquires these in reverse. */
  private async locked<T>(input: WorkspaceLocation, action: (instance: CodeWorkspaceInstance, routes: CodeWorkspaceRoute[]) => Promise<T>): Promise<T> {
    const service = new CodeWorkspaces(this.store), observed = await service.instance(input.instance_id);
    const root = resolve(input.data_root);
    if (observed.host_id !== input.host_id || observed.data_root !== root || realpathSync(root) !== root
      || safeRead(join(root, "runtime", "host-id"), 128).toString().trim() !== observed.host_id
      || observed.database_id !== (await this.store.open()).database_id) throw validation("instance", "requires the recorded host, database and data root");
    return withRuntimeLock(join(root, "runtime"), `workspace:${observed.instance_id}`, async () => {
      const routes = await this.routes(observed.instance_id);
      const keys = [...routes.map(route => `code-route:${route.route_id}`),
        ...[...new Set(observed.configuration.configuration.repositories.map(repo => repo.repository_id))].sort().map(id => `repository:${id}`)];
      const lock = (index: number): Promise<T> => index === keys.length ? withRuntimeLock(directoryRegistryRoot(), "directory-registry", perform)
        : withRuntimeLock(join(root, "runtime"), keys[index]!, () => lock(index + 1));
      const perform = async () => {
        const instance = await service.instance(observed.instance_id);
        if (instance.data_root !== root || instance.host_id !== input.host_id || instance.database_id !== observed.database_id
          || sha256(instance.configuration) !== sha256(observed.configuration)
          || sha256((await this.routes(instance.instance_id)).map(route => route.route_id)) !== sha256(routes.map(route => route.route_id)))
          conflict("Workspace resources changed while acquiring lifecycle ownership; retry");
        return action(instance, await this.routes(instance.instance_id));
      };
      return lock(0);
    });
  }

  private async idle(routes: CodeWorkspaceRoute[]): Promise<void> {
    for (const route of routes) {
      if (route.state !== "prepared") conflict("Recover route preparation before ending this Workspace");
      assertRoutePreparing(route);
      assertPhysicalDirectoryFree(route.path, directoryRegistryRoot());
      if (route.dev_run_id) await this.store.read(async tx => {
        const run = await tx.getDevRun(route.dev_run_id!);
        if (run.state === "open") conflict("Explicitly submit or abandon every DevRun before ending its Workspace");
        await tx.assertDevRunNotSyncing(run.id);
        const operations = await tx.listRuntimeRecords("runtime_operation", run.id);
        if (operations.some(row => row.data.format === "grounds.candidate-archive-operation/v1" && row.data.phase !== "committed"))
          conflict("Recover pending Candidate archival before ending this Workspace");
      });
    }
  }

  private async resources(instance: CodeWorkspaceInstance, routes: CodeWorkspaceRoute[]): Promise<Resource[]> {
    const root = instance.data_root!;
    for (const baseline of instance.baselines) {
      if (!baseline.materialized || baseline.path !== join(root, "workspaces", instance.instance_id, "baselines", baseline.alias))
        conflict("Baseline record does not match its managed location");
    }
    const currentBases = new Map<string, string>();
    for (const route of routes) {
      const baseline = instance.baselines.find(item => item.repository_id === route.repository_id);
      if (route.instance_id !== instance.instance_id || route.database_id !== instance.database_id || route.host_id !== instance.host_id
        || route.repository_id !== instance.target_repository_id || route.issue_revision_id !== instance.issue_revision_id
        || !baseline || (instance.restoration?.archive_binding.base_commit ?? baseline.commit) !== route.base_commit
        || route.path !== join(root, "workspaces", instance.instance_id, "development", route.route_id))
        conflict("Route record does not match its Workspace binding");
      if (route.dev_run_id) {
        const run = await this.store.read(tx => tx.getDevRun(route.dev_run_id!));
        if (run.initial_base_commit !== route.base_commit || !run.base_commit
          || sha256(run.development) !== sha256(route.development) || run.issue_revision_id !== route.issue_revision_id)
          conflict("Route and DevRun binding no longer match");
        currentBases.set(route.route_id, run.base_commit!);
      }
    }
    return [
      ...instance.baselines.map(baseline => ({ id: `baseline:${baseline.repository_id}`, kind: "baseline" as const,
        repository_id: baseline.repository_id, path: join(root, "workspaces", instance.instance_id, "baselines", baseline.alias),
        cache: join(root, "cache", "repos", baseline.repository_id), commit: baseline.commit, tree: baseline.tree,
        pin: `refs/grounds/workspace-baselines/${instance.instance_id}/${baseline.repository_id}` })),
      ...routes.map(route => ({ id: `route:${route.route_id}`, kind: "development" as const, repository_id: route.repository_id,
        path: join(root, "workspaces", instance.instance_id, "development", route.route_id),
        cache: join(root, "cache", "repos", route.repository_id), commit: currentBases.get(route.route_id) ?? route.base_commit,
        pin_commit: instance.baselines.find(item => item.repository_id === route.repository_id)!.commit,
        branch: route.development.branch, ...(route.dev_run_id ? { dev_run_id: route.dev_run_id } : {}),
        ...(route.restoration ? { restores_candidate_id: route.restoration.candidate_id } : {}),
        pin: `refs/grounds/workspace-baselines/${instance.instance_id}/${route.repository_id}` })),
    ];
  }

  private inspect(resource: Resource): { identity: ResourceIdentity; estimated_bytes: number } {
    const { path, cache } = resource;
    assertPhysicalDirectoryFree(path, directoryRegistryRoot());
    if (resource.kind === "baseline" && isRouteLeased(path)) conflict("resource_in_use");
    const directory = physicalIdentity(path), cacheIdentity = physicalIdentity(cache);
    const dotgit = lstatSync(join(path, ".git"));
    const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: path });
    if (!dotgit.isFile() || dotgit.isSymbolicLink() || dotgit.nlink !== 1
      || !gitDir.startsWith(join(cache, "worktrees") + "/") || realpathSync(gitDir) !== gitDir
      || git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path }) !== cache
      || git(["rev-parse", "--show-toplevel"], { cwd: path }) !== path
      || safeRead(join(gitDir, "gitdir"), 16384).toString().trimEnd() !== join(path, ".git")
      || existsSync(join(cache, "objects", "info", "alternates"))) conflict("resource_identity_changed");
    const head = git(["rev-parse", "HEAD"], { cwd: path }), tree = git(["rev-parse", "HEAD^{tree}"], { cwd: path });
    const branch = gitTry(["symbolic-ref", "-q", "HEAD"], { cwd: path });
    if (branch !== (resource.branch ? `refs/heads/${resource.branch}` : undefined)
      || (resource.kind === "baseline" && (head !== resource.commit.split(":")[1] || tree !== resource.tree?.split(":")[1]))) conflict("resource_identity_changed");
    if (unfinishedOperationPaths(path).some(file => existsSync(file))) conflict("unfinished_git_operation");
    const flags = git(["ls-files", "-v", "-z"], { cwd: path }).split("\0").filter(Boolean);
    const entries = git(["ls-files", "--stage", "-z"], { cwd: path }).split("\0").filter(Boolean);
    if (flags.some(entry => /^[a-zS]/.test(entry)) || entries.some(entry => !/^(100644|100755|120000) [a-f0-9]+ 0\t/.test(entry))
      || gitTry(["config", "--bool", "core.sparseCheckout"], { cwd: path }) === "true"
      || gitTry(["config", "--bool", "core.symlinks"], { cwd: path }) === "false") conflict("unsupported_worktree_state");
    assertNoHistoryFilters(path);
    if (git(["-c", "core.filemode=true", "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"], { cwd: path, env: { GIT_OPTIONAL_LOCKS: "0" } })) conflict("unpreserved_files");
    let estimated = 0, count = 0;
    const size = (entry: string): void => {
      if (++count > 100000) conflict("worktree_inventory_too_large");
      const stat = lstatSync(entry);
      if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of readdirSync(entry)) size(join(entry, name));
      else estimated += stat.size;
    };
    size(path);
    return { identity: { directory, administration: physicalIdentity(gitDir), cache: cacheIdentity, git_dir: gitDir, head, tree }, estimated_bytes: estimated };
  }

  private async preserved(resource: Resource, identity: ResourceIdentity): Promise<void> {
    const pin = gitTry(["rev-parse", "--verify", resource.pin!], { gitDir: resource.cache });
    if (pin !== (resource.pin_commit ?? resource.commit).split(":")[1]) conflict("baseline_retention_unconfirmed");
    git(["rev-list", "--objects", "--missing=error", pin!], { gitDir: resource.cache });
    if (resource.kind === "baseline") return;
    let artifact = resource.dev_run_id ? await this.store.read(tx => tx.findCandidateArtifactRef({ dev_run_id: resource.dev_run_id! })) : undefined;
    if (!artifact && resource.restores_candidate_id) artifact = await this.store.read(tx => tx.findCandidateArtifactRef({ candidate_id: resource.restores_candidate_id! }));
    if (!artifact) {
      if (identity.head !== resource.commit.split(":")[1]) conflict("unarchived_commit");
      return; // A cancelled/no-change route needs no artificial Candidate.
    }
    const binding = artifact.git_artifact?.binding;
    if (!binding || binding.repository_id !== resource.repository_id || binding.source_commit !== `sha1:${identity.head}`
      || binding.result_tree !== `sha1:${identity.tree}` || artifact.source?.commit !== binding.source_commit
      || artifact.base_commit !== binding.base_commit || binding.base_commit !== resource.commit) conflict("unarchived_commit");
    if (!this.options.policyCheck) conflict("archive_protection_unconfirmed");
    const protection = await this.options.policyCheck!(binding!, new Date().toISOString());
    validateArchiveProtectionEvidence(protection, binding!);
    const observed = inspectGitArchive({ binding: binding! });
    if (observed.status !== "confirmed" || observed.integrity !== "complete") conflict("archive_unconfirmed");
    validateArchiveProtectionEvidence(protection, binding!);
  }

  private async plan(instance: CodeWorkspaceInstance, routes: CodeWorkspaceRoute[], early = false): Promise<CleanupPlan> {
    if (!instance.lifecycle) conflict("Explicitly end the Workspace before requesting cleanup");
    await this.idle(routes);
    const resources: CleanupResource[] = [];
    const receipts = (await this.store.read(tx => tx.listRuntimeRecords("runtime_operation", instance.instance_id)))
      .filter(row => row.data.format === "grounds.code-workspace-cleanup/v1").flatMap(row => (row.data as unknown as CleanupJournal).items)
      .filter(item => item.phase === "removed");
    for (const resource of await this.resources(instance, routes)) {
      const receipt = receipts.find(item => item.resource.id === resource.id);
      if (receipt) {
        const absent = !lstatSync(resource.path, { throwIfNoEntry: false }) && !lstatSync(receipt.view.identity!.git_dir, { throwIfNoEntry: false });
        resources.push({ ...receipt.view, state: absent ? "removed" : "blocked", ...(absent ? {} : { reason: "resource_replaced_after_cleanup" }) });
        continue;
      }
      try {
        const inspected = this.inspect(resource);
        await this.preserved(resource, inspected.identity);
        resources.push({ id: resource.id, kind: resource.kind, path: resource.path, state: "eligible", ...inspected });
      } catch (error) {
        const reasons = ["unpreserved_files", "unarchived_commit", "baseline_retention_unconfirmed", "archive_unconfirmed", "archive_protection_unconfirmed", "resource_in_use", "resource_identity_changed", "unfinished_git_operation", "unsupported_worktree_state", "worktree_inventory_too_large"];
        resources.push({ id: resource.id, kind: resource.kind, path: resource.path, state: "blocked",
          reason: error instanceof DomainError && reasons.includes(error.message) ? error.message : "inspection_unconfirmed" });
      }
    }
    const lifecycle = instance.lifecycle!;
    const gate = lifecycle.pinned ? "pinned" : !early && Date.now() < Date.parse(lifecycle.retain_until) ? "retention" : "ready";
    const body = { instance_id: instance.instance_id, lifecycle_version: lifecycle.version, scope: "code_worktrees" as const, gate: gate as CleanupPlan["gate"], resources,
      retained_paths: [join(instance.data_root!, "cache"), join(instance.data_root!, "runtime"), join(instance.data_root!, "workspaces", instance.instance_id)] };
    return { ...body, plan_digest: sha256(body) };
  }

  async preview(input: WorkspaceLocation & { early?: boolean }): Promise<CleanupPlan> {
    if (input.early !== undefined && typeof input.early !== "boolean") throw validation("early", "requires boolean");
    return this.locked(input, (instance, routes) => this.plan(instance, routes, input.early));
  }

  async reclaim(input: ReclaimWorkspace): Promise<CleanupResult> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id) || !Number.isSafeInteger(request.expected_version) || request.expected_version < 1
      || typeof request.plan_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(request.plan_digest)
      || (request.early !== undefined && typeof request.early !== "boolean")) throw validation("cleanup", "requires fixed operation, lifecycle version and plan digest");
    validateAttribution(request.attribution);
    return this.locked(request, async (instance, routes) => {
      let journal: CleanupJournal | undefined;
      const existing = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
      if (existing) {
        if (existing.data.format !== "grounds.code-workspace-cleanup/v1" || existing.data.request_digest !== sha256(request)
          || existing.parent_id !== instance.instance_id) throw new DomainError("IDEMPOTENCY_CONFLICT", "Cleanup retry differs from its original request");
        journal = existing.data as unknown as CleanupJournal;
        if (journal.phase === "completed") return journal.result!; // Historical replay never touches recreated paths.
        if (instance.lifecycle?.cleanup_operation_id !== request.operation_id) conflict("Pending cleanup ownership changed");
      } else {
        if (instance.lifecycle?.cleanup_operation_id) conflict("Recover the original cleanup operation first");
        const plan = await this.plan(instance, routes, request.early);
        if (plan.lifecycle_version !== request.expected_version || plan.plan_digest !== request.plan_digest || plan.gate !== "ready")
          conflict("Cleanup plan, retention or lifecycle changed; inspect a fresh preview");
        const resources = await this.resources(instance, routes);
        journal = { format: "grounds.code-workspace-cleanup/v1", operation_id: request.operation_id, instance_id: instance.instance_id,
          request_digest: sha256(request), phase: "pending", items: plan.resources.map(view => ({ resource: resources.find(resource => resource.id === view.id)!,
            view, phase: view.state === "eligible" ? "pending" : view.state })) };
        const intent = journal;
        await this.store.write(async tx => {
          if (await tx.getOperation(request.operation_id)) conflict("Operation ID is already in use");
          await tx.lockRuntimeRecord("runtime_operation", instance.instance_id);
          const row = (await tx.getRuntimeRecord("runtime_operation", instance.instance_id))!;
          const current = row.data as unknown as CodeWorkspaceInstance;
          if (current.lifecycle?.version !== request.expected_version || current.lifecycle.cleanup_operation_id) conflict("Lifecycle changed before cleanup reservation");
          await tx.saveRuntimeRecord({ kind: "runtime_operation", id: request.operation_id, parent_id: instance.instance_id, version: 1, data: { ...intent } }, 0);
          await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...current,
            lifecycle: { ...current.lifecycle!, version: current.lifecycle!.version + 1, cleanup_operation_id: request.operation_id } } }, row.version);
        });
      }
      const currentJournal = journal;
      const save = async () => this.store.write(async tx => {
        const row = (await tx.getRuntimeRecord("runtime_operation", request.operation_id))!;
        await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...currentJournal } }, row.version);
      });
      await this.idle(routes);
      for (const item of currentJournal.items) {
        if (item.phase === "removed" || item.phase === "blocked") continue;
        const identity = item.view.identity!;
        if (item.phase === "removing" && !lstatSync(item.resource.path, { throwIfNoEntry: false })
          && !lstatSync(identity.git_dir, { throwIfNoEntry: false }) && physicalIdentity(item.resource.cache) === identity.cache) {
          item.phase = "removed"; item.view.state = "removed"; await save(); continue;
        }
        try {
          if (sha256(this.inspect(item.resource).identity) !== sha256(identity)) conflict("Resource identity changed; preserve replacement content");
          await this.preserved(item.resource, identity);
          item.phase = "removing"; await save();
          // No asynchronous work between the final local observation and Git removal.
          if (sha256(this.inspect(item.resource).identity) !== sha256(identity)) conflict("Resource identity changed before removal");
          git(["worktree", "remove", "--", item.resource.path], { gitDir: item.resource.cache });
          if (lstatSync(item.resource.path, { throwIfNoEntry: false }) || lstatSync(identity.git_dir, { throwIfNoEntry: false })) conflict("Removal could not be confirmed");
          item.phase = "removed"; item.view.state = "removed"; await save();
        } catch {
          throw new DomainError("STATE_CONFLICT", "Cleanup interrupted; preserve remaining files and retry the original operation", false, { operation_id: request.operation_id });
        }
      }
      const result: CleanupResult = { instance_id: instance.instance_id, operation_id: request.operation_id, scope: "code_worktrees", resources: currentJournal.items.map(item => item.view) };
      await this.store.write(async tx => {
        await tx.lockRuntimeRecord("runtime_operation", instance.instance_id);
        const row = (await tx.getRuntimeRecord("runtime_operation", instance.instance_id))!;
        const current = row.data as unknown as CodeWorkspaceInstance;
        if (current.lifecycle?.cleanup_operation_id !== request.operation_id) conflict("Cleanup ownership changed before completion");
        const { cleanup_operation_id: _completed, ...lifecycle } = current.lifecycle!;
        const updated = { ...current, lifecycle: { ...lifecycle, version: lifecycle.version + 1,
          state: result.resources.every(resource => resource.state === "removed") ? "code_reclaimed" : "ended" } };
        await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: updated }, row.version);
        const operation = (await tx.getRuntimeRecord("runtime_operation", request.operation_id))!;
        await tx.saveRuntimeRecord({ ...operation, version: operation.version + 1, data: { ...currentJournal, phase: "completed", result } }, operation.version);
      });
      return result;
    });
  }

  async end(input: EndWorkspace): Promise<CodeWorkspaceInstance> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id) || !Number.isSafeInteger(request.expected_version) || request.expected_version < 0
      || (request.retention_days !== undefined && (!Number.isInteger(request.retention_days) || request.retention_days < 0 || request.retention_days > 3650))
      || (request.pinned !== undefined && typeof request.pinned !== "boolean")) throw validation("lifecycle", "requires operation ID, expected lifecycle version, optional 0–3650 retention days and boolean pinned");
    validateAttribution(request.attribution);
    return this.locked(request, async (instance, routes) => {
      await this.idle(routes);
      for (const baseline of instance.baselines) {
        assertPhysicalDirectoryFree(baseline.path, directoryRegistryRoot());
        if (existsSync(baseline.path) && isRouteLeased(baseline.path)) conflict("Baseline has an unresolved environment lease");
      }
      return this.store.write(async tx => {
        const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.end", request_hash: sha256(request) });
        if (replay) return JSON.parse(replay.result_json) as CodeWorkspaceInstance;
        await tx.lockRuntimeRecord("runtime_operation", instance.instance_id);
        const row = (await tx.getRuntimeRecord("runtime_operation", instance.instance_id))!;
        const current = row.data as unknown as CodeWorkspaceInstance;
        if (current.lifecycle?.cleanup_operation_id || current.state !== "prepared" || current.lifecycle?.state === "code_reclaimed"
          || (current.lifecycle?.version ?? 0) !== request.expected_version) conflict("Workspace lifecycle version or state changed");
        const endedAt = current.lifecycle?.ended_at ?? await tx.now();
        const days = request.retention_days ?? current.lifecycle?.retention_days ?? 7;
        const lifecycle: CodeWorkspaceLifecycle = { state: "ended", version: request.expected_version + 1,
          ended_at: endedAt, retention_days: days, retain_until: new Date(Date.parse(endedAt) + days * 86400000).toISOString(),
          pinned: request.pinned ?? current.lifecycle?.pinned ?? false, attribution: request.attribution };
        const result = { ...current, lifecycle };
        await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...result } }, row.version);
        await tx.completeOperation(request.operation_id, JSON.stringify(result));
        return result;
      });
    });
  }
}
