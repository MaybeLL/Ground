import { sha256 } from "./canonical-json.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { DomainError, notFound, validation, worktreeMismatch } from "./errors.js";
import { isGitOID, isUUIDv7, newUUIDv7 } from "./identity.js";
import type { RepositoryRecord, Store } from "./store-types.js";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, gitTry } from "./env-git.js";
import { atomicPrivateWrite, privateDirectory, safeRead, withRuntimeLock } from "./runtime-files.js";
import type { GitArchiveBinding } from "./candidate-git-archive.js";
import { assertSupportedCandidateArtifact, validateGitArtifactCandidateBinding } from "./git-artifact-storage.js";

export interface WorkspaceRestoration {
  source_instance_id: string;
  candidate_id: string;
  context_policy: "original";
  source_commit: string;
  archive_binding: GitArchiveBinding;
  baselines: Pick<WorkspaceBaseline, "repository_id" | "alias" | "commit" | "tree">[];
}

export interface WorkspaceBaseline {
  repository_id: string;
  alias: string;
  commit: string;
  tree: string;
  path: string;
  refresh: "fetched" | "cached";
  materialized: boolean;
}

export interface WorkspaceConfiguration {
  name: string;
  repositories: { repository_id: string; alias: string; revision: { branch: string } | { commit: string } }[];
}

export interface WorkspaceConfigurationVersion {
  format: "grounds.workspace-configuration/v1";
  configuration_id: string;
  revision_id: string;
  version: number;
  configuration: WorkspaceConfiguration;
  digest: string;
  attribution: Attribution;
  created_at: string;
}

export interface CodeWorkspaceLifecycle {
  state: "ended" | "code_reclaimed";
  version: number;
  ended_at: string;
  cleanup_operation_id?: string;
  retention_days: number;
  retain_until: string;
  pinned: boolean;
  attribution: Attribution;
}

export interface CodeWorkspaceInstance {
  format: "grounds.code-workspace-instance/v1";
  instance_id: string;
  database_id: string;
  host_id: string;
  issue_id: string;
  issue_version: number;
  issue_revision_id: string;
  target_repository_id: string;
  configuration: WorkspaceConfigurationVersion;
  state: "preparing" | "prepared" | "blocked";
  baselines: WorkspaceBaseline[];
  lifecycle?: CodeWorkspaceLifecycle;
  restoration?: WorkspaceRestoration;
  data_root?: string;
  execution_enabled: false;
  attribution: Attribution;
  created_at: string;
}

function fields(value: unknown, allowed: string[], field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw validation(field, "requires an object with supported fields only");
}

function validateConfiguration(configuration: WorkspaceConfiguration): void {
  fields(configuration, ["name", "repositories"], "configuration");
  if (typeof configuration.name !== "string" || !configuration.name.trim() || configuration.name.length > 200) throw validation("name", "requires a name of at most 200 characters");
  if (!Array.isArray(configuration.repositories) || !configuration.repositories.length || configuration.repositories.length > 32) throw validation("repositories", "requires 1 to 32 repository selections");
  const aliases = new Set<string>(), repositories = new Set<string>();
  for (const repo of configuration.repositories) {
    fields(repo, ["repository_id", "alias", "revision"], "repository");
    if (!isUUIDv7(repo.repository_id) || typeof repo.alias !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(repo.alias)) throw validation("repository", "requires a Repository UUIDv7 and a lowercase directory alias");
    if (aliases.has(repo.alias) || repositories.has(repo.repository_id)) throw validation("repositories", "repository identities and aliases must be unique");
    aliases.add(repo.alias); repositories.add(repo.repository_id);
    fields(repo.revision, ["branch", "commit"], "revision");
    if (Object.keys(repo.revision).length !== 1) throw validation("revision", "select exactly one branch or fixed commit");
    if ("commit" in repo.revision) {
      if (!isGitOID(repo.revision.commit)) throw validation("commit", "requires a qualified exact Git commit OID");
    } else {
      const branch = repo.revision.branch;
      if (typeof branch !== "string" || branch.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) throw validation("branch", "requires a supported Git branch name");
    }
  }
}

function readConfigurationVersion(value: unknown): WorkspaceConfigurationVersion {
  try {
    fields(value, ["format", "configuration_id", "revision_id", "version", "configuration", "digest", "attribution", "created_at"], "configuration snapshot");
    if (value.format !== "grounds.workspace-configuration/v1" || !isUUIDv7(value.configuration_id)
      || !isUUIDv7(value.revision_id) || !Number.isSafeInteger(value.version) || Number(value.version) < 1
      || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) throw new Error("invalid snapshot metadata");
    validateConfiguration(value.configuration as WorkspaceConfiguration);
    validateAttribution(value.attribution as Attribution);
    if (value.digest !== sha256(value.configuration)) throw new Error("configuration digest mismatch");
    return value as unknown as WorkspaceConfigurationVersion;
  } catch {
    throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Stored Workspace configuration snapshot is missing or inconsistent");
  }
}

function checkBaseline(baseline: WorkspaceBaseline, root: string, instanceId: string): void {
  const path = join(root, "workspaces", instanceId, "baselines", baseline.alias);
  const cache = join(root, "cache", "repos", baseline.repository_id);
  try {
    const administration = git(["rev-parse", "--absolute-git-dir"], { cwd: path });
    if (baseline.path !== path || !existsSync(path) || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path
      || !lstatSync(join(path, ".git")).isFile() || lstatSync(join(path, ".git")).isSymbolicLink()
      || !administration.startsWith(join(cache, "worktrees") + "/")
      || realpathSync(administration) !== administration
      || safeRead(join(administration, "gitdir"), 16 * 1024).toString("utf8").trimEnd() !== join(path, ".git")
      || gitTry(["rev-parse", "--verify", `refs/grounds/workspace-baselines/${instanceId}/${baseline.repository_id}`], { gitDir: cache }) !== baseline.commit.replace(/^sha(?:1|256):/, "")
      || git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path }) !== cache
      || gitTry(["symbolic-ref", "-q", "HEAD"], { cwd: path }) !== undefined
      || git(["rev-parse", "HEAD"], { cwd: path }) !== baseline.commit.replace(/^sha(?:1|256):/, "")
      || git(["rev-parse", "HEAD^{tree}"], { cwd: path }) !== baseline.tree.replace(/^sha(?:1|256):/, "")
      || git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: path })) throw new Error("baseline changed");
  } catch { throw worktreeMismatch("", "recorded baseline is missing or changed; preserve it for recovery"); }
}

/** Code Workspace configuration is distinct from the contract authoring workspace. */
export class CodeWorkspaces {
  constructor(private readonly store: Store, private readonly options: { repositorySource?: (repository: RepositoryRecord) => string } = {}) {}

  async saveConfiguration(input: {
    operation_id?: string;
    configuration_id: string; expected_version: number;
    configuration: WorkspaceConfiguration; attribution: Attribution;
  }): Promise<WorkspaceConfigurationVersion> {
    if (!isUUIDv7(input.configuration_id) || !Number.isSafeInteger(input.expected_version) || input.expected_version < 0) throw validation("configuration", "requires UUIDv7 and nonnegative expected_version");
    validateConfiguration(input.configuration);
    validateAttribution(input.attribution);
    const request = structuredClone(input);
    const operationId = request.operation_id ?? newUUIDv7();
    if (!isUUIDv7(operationId)) throw validation("operation_id", "requires UUIDv7");
    const { operation_id: _operationId, ...body } = request;
    input = request;
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: operationId, command: "code-workspace.config-save", request_hash: sha256(body) });
      if (replay) return JSON.parse(replay.result_json) as WorkspaceConfigurationVersion;
      const current = await tx.getRuntimeRecord("runtime_operation", input.configuration_id);
      if (current && current.data.format !== "grounds.workspace-configuration-head/v1") throw validation("configuration_id", "identifier belongs to a different record type");
      if (current) await tx.lockRuntimeRecord("runtime_operation", input.configuration_id);
      for (const repo of input.configuration.repositories) await tx.getRepository(repo.repository_id);
      const revisionId = newUUIDv7();
      const result: WorkspaceConfigurationVersion = {
        format: "grounds.workspace-configuration/v1", configuration_id: input.configuration_id, revision_id: revisionId,
        version: input.expected_version + 1, configuration: input.configuration,
        digest: sha256(input.configuration), attribution: input.attribution, created_at: await tx.now(),
      };
      await tx.saveRuntimeRecord({ id: revisionId, parent_id: input.configuration_id, kind: "runtime_operation", version: 1, data: { ...result } }, 0);
      await tx.saveRuntimeRecord({ id: input.configuration_id, kind: "runtime_operation", version: result.version,
        data: { format: "grounds.workspace-configuration-head/v1", revision_id: revisionId } }, input.expected_version);
      await tx.completeOperation(operationId, JSON.stringify(result));
      return result;
    });
  }

  async configuration(id: string, version?: number): Promise<WorkspaceConfigurationVersion> {
    return this.store.read(async tx => {
      const head = await tx.getRuntimeRecord("runtime_operation", id);
      if (!head || head.data.format !== "grounds.workspace-configuration-head/v1") throw notFound("config", id);
      const row = version === undefined
        ? await tx.getRuntimeRecord("runtime_operation", String(head.data.revision_id))
        : (await tx.listRuntimeRecords("runtime_operation", id)).find(row => row.data.format === "grounds.workspace-configuration/v1" && row.data.version === version);
      if (!row || row.parent_id !== id || row.data.format !== "grounds.workspace-configuration/v1") throw notFound("config", id);
      const configuration = readConfigurationVersion(row.data);
      if (configuration.configuration_id !== id || configuration.revision_id !== row.id) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Stored Workspace configuration identity is inconsistent");
      return configuration;
    });
  }

  async createInstance(input: {
    operation_id: string; configuration_id: string; configuration_version: number;
    issue_id: string; issue_version: number; host_id: string; attribution: Attribution;
  }): Promise<CodeWorkspaceInstance> {
    for (const key of ["operation_id", "configuration_id", "issue_id"] as const) if (!isUUIDv7(input[key])) throw validation(key, "requires UUIDv7");
    if (typeof input.host_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[47][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.host_id)) throw validation("host_id", "requires a host UUID");
    for (const version of [input.configuration_version, input.issue_version]) if (!Number.isSafeInteger(version) || version < 1) throw validation("version", "requires a positive version");
    validateAttribution(input.attribution);
    const request = structuredClone(input);
    const configuration = await this.configuration(request.configuration_id, request.configuration_version);
    const metadata = await this.store.open();
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.create", request_hash: sha256(request) });
      if (replay) return JSON.parse(replay.result_json) as CodeWorkspaceInstance;
      const issue = await tx.getIssue(request.issue_id), revision = await tx.getIssueRevisionByNumber(request.issue_id, request.issue_version);
      if (!configuration.configuration.repositories.some(repo => repo.repository_id === issue.repository_id)) throw validation("configuration", "must include the Issue target repository");
      const instance: CodeWorkspaceInstance = {
        format: "grounds.code-workspace-instance/v1", instance_id: newUUIDv7(), database_id: metadata.database_id,
        host_id: request.host_id, issue_id: issue.id, issue_version: request.issue_version, issue_revision_id: revision.id,
        target_repository_id: issue.repository_id, configuration, state: "preparing", baselines: [], execution_enabled: false,
        attribution: request.attribution, created_at: await tx.now(),
      };
      await tx.saveRuntimeRecord({ id: instance.instance_id, parent_id: issue.id, kind: "runtime_operation", version: 1, data: { ...instance } }, 0);
      await tx.completeOperation(request.operation_id, JSON.stringify(instance));
      return instance;
    });
  }

  async instance(id: string): Promise<CodeWorkspaceInstance> {
    if (!isUUIDv7(id)) throw validation("instance_id", "requires UUIDv7");
    const row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", id));
    if (!row || row.data.format !== "grounds.code-workspace-instance/v1") throw notFound("config", id);
    readConfigurationVersion(row.data.configuration);
    return row.data as unknown as CodeWorkspaceInstance;
  }

  /** Allocate a new, unprepared instance. Historical records and their paths remain untouched. */
  async restoreInstance(input: { operation_id: string; source_instance_id: string; candidate_id: string;
    context_policy: "original"; host_id: string; attribution: Attribution }): Promise<CodeWorkspaceInstance> {
    const request = structuredClone(input);
    for (const key of ["operation_id", "source_instance_id", "candidate_id"] as const)
      if (!isUUIDv7(request[key])) throw validation(key, "requires UUIDv7");
    if (request.context_policy !== "original") throw validation("context_policy", "explicit original context is required");
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[47][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.host_id)) throw validation("host_id", "requires a host UUID");
    validateAttribution(request.attribution);
    const database = await this.store.open();
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.restore", request_hash: sha256(request) });
      if (replay) return JSON.parse(replay.result_json) as CodeWorkspaceInstance;
      await tx.lockRuntimeRecord("runtime_operation", request.source_instance_id);
      const row = await tx.getRuntimeRecord("runtime_operation", request.source_instance_id);
      if (row?.data.format !== "grounds.code-workspace-instance/v1") throw notFound("config", request.source_instance_id);
      const source = row!.data as unknown as CodeWorkspaceInstance;
      readConfigurationVersion(source.configuration);
      if (source.database_id !== database.database_id || source.lifecycle?.state !== "code_reclaimed" || source.lifecycle.cleanup_operation_id
        || source.state !== "prepared" || source.baselines.length !== source.configuration.configuration.repositories.length
        || source.baselines.some(item => !item.materialized)) throw new DomainError("STATE_CONFLICT", "Restore requires a fully reclaimed code instance with complete fixed context");
      const candidate = await tx.findCandidateArtifactRef({ candidate_id: request.candidate_id });
      if (!candidate) throw notFound("candidate", request.candidate_id);
      assertSupportedCandidateArtifact(candidate.artifact_format, candidate.candidate_id);
      if (!candidate.git_artifact || !candidate.source) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate has no fixed Git source");
      const run = await tx.getDevRun(candidate.dev_run_id);
      const route = run.development ? await tx.getRuntimeRecord("runtime_operation", run.development.workspace_id) : undefined;
      const revision = await tx.getIssueRevisionById(candidate.issue_revision_id);
      if (candidate.issue_revision_id !== source.issue_revision_id || revision.issue_id !== source.issue_id
        || run.issue_revision_id !== source.issue_revision_id || run.state !== "submitted"
        || route?.data.format !== "grounds.code-workspace-route/v1" || route.parent_id !== source.instance_id
        || route.data.instance_id !== source.instance_id || route.data.dev_run_id !== run.id
        || route.data.repository_id !== source.target_repository_id
        || candidate.git_artifact.binding.repository_id !== source.target_repository_id
        || run.initial_base_commit !== route.data.base_commit
        || route.data.base_commit !== (source.restoration?.archive_binding.base_commit
          ?? source.baselines.find(item => item.repository_id === source.target_repository_id)?.commit)
        || run.base_commit !== candidate.git_artifact.binding.base_commit)
        throw validation("candidate_id", "must identify a Candidate from this instance and the same fixed Issue revision and base");
      validateGitArtifactCandidateBinding(candidate.git_artifact, { id: candidate.candidate_id, source: candidate.source,
        base_commit: candidate.base_commit, result_tree_oid: candidate.result_tree_oid, repository_remote_snapshot: run.repository_remote_snapshot });
      const restoration: WorkspaceRestoration = { source_instance_id: source.instance_id, candidate_id: candidate.candidate_id,
        context_policy: "original", source_commit: candidate.source.commit, archive_binding: candidate.git_artifact.binding,
        baselines: source.baselines.map(({ repository_id, alias, commit, tree }) => ({ repository_id, alias, commit, tree })) };
      const instance: CodeWorkspaceInstance = { format: "grounds.code-workspace-instance/v1", instance_id: newUUIDv7(),
        database_id: database.database_id, host_id: request.host_id, issue_id: source.issue_id, issue_version: source.issue_version,
        issue_revision_id: source.issue_revision_id, target_repository_id: source.target_repository_id, configuration: source.configuration,
        state: "preparing", baselines: [], execution_enabled: false, restoration, attribution: request.attribution, created_at: await tx.now() };
      await tx.saveRuntimeRecord({ id: instance.instance_id, parent_id: instance.issue_id, kind: "runtime_operation", version: 1, data: { ...instance } }, 0);
      await tx.completeOperation(request.operation_id, JSON.stringify(instance));
      return instance;
    });
  }

  /** Verify fixed input without reacquiring preparation or refreshing a branch. */
  async inspectPreparedInstance(input: { instance_id: string; host_id: string; data_root: string }): Promise<CodeWorkspaceInstance> {
    const instance = await this.instance(input.instance_id);
    if (instance.host_id !== input.host_id || instance.data_root !== resolve(input.data_root)) throw validation("instance", "host or data root differs from the recorded instance");
    if (instance.lifecycle || instance.state !== "prepared" || instance.baselines.length !== instance.configuration.configuration.repositories.length
      || instance.baselines.some(baseline => !baseline.materialized)) throw new DomainError("STATE_CONFLICT", "Prepare the code Workspace before creating a route");
    for (const baseline of instance.baselines) checkBaseline(baseline, instance.data_root, instance.instance_id);
    return instance;
  }

  async prepareInstance(input: { instance_id: string; host_id: string; data_root: string; allow_cached?: boolean }): Promise<CodeWorkspaceInstance> {
    const observed = await this.instance(input.instance_id);
    if (observed.lifecycle) throw new DomainError("STATE_CONFLICT", "Ended Workspaces cannot be prepared again; preserve their lifecycle");
    const requestedRoot = resolve(input.data_root);
    if (observed.host_id !== input.host_id) throw validation("host_id", "instance belongs to a different host");
    if (observed.data_root && observed.data_root !== requestedRoot) throw validation("data_root", "instance is bound to another root; explicit migration is required");
    const root = privateDirectory(input.data_root);
    await this.store.write(async tx => {
      await tx.lockRuntimeRecord("runtime_operation", input.instance_id);
      const row = (await tx.getRuntimeRecord("runtime_operation", input.instance_id))!;
      if (row.data.host_id !== input.host_id || (row.data.data_root && row.data.data_root !== root)) throw validation("data_root", "instance binding changed");
      if (!row.data.data_root) await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...row.data, data_root: root } }, row.version);
    });
    return withRuntimeLock(join(root, "runtime"), `workspace:${input.instance_id}`, async () => {
      const instance = await this.instance(input.instance_id);
      if (instance.host_id !== input.host_id) throw validation("host_id", "instance belongs to a different host");
      if (instance.lifecycle) throw new DomainError("STATE_CONFLICT", "Workspace ended while preparing");
      instance.data_root = root;
      const persist = async () => this.store.write(async tx => {
        const row = await tx.getRuntimeRecord("runtime_operation", instance.instance_id);
        if (!row) throw notFound("config", instance.instance_id);
        await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...instance } }, row.version);
      });
      try {
        for (const configured of instance.configuration.configuration.repositories) {
          const fixed = instance.restoration?.baselines.find(item => item.repository_id === configured.repository_id);
          if (instance.restoration && (!fixed || fixed.alias !== configured.alias)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Restoration context is incomplete");
          const selection = fixed ? { ...configured, revision: { commit: fixed.commit } } : configured;
          const previous = instance.baselines.find(baseline => baseline.repository_id === selection.repository_id);
          if (previous?.materialized) {
            checkBaseline(previous, root, instance.instance_id);
            continue;
          }
          const repository = await this.store.read(tx => tx.getRepository(selection.repository_id));
          await withRuntimeLock(join(root, "runtime"), `repository:${repository.id}`, async () => {
            const cache = join(privateDirectory(join(root, "cache", "repos")), repository.id);
            const cacheEntry = lstatSync(cache, { throwIfNoEntry: false });
            if (cacheEntry && (cacheEntry.isSymbolicLink() || !cacheEntry.isDirectory())) throw validation("cache", "managed repository cache must be a real directory");
            const source = this.options.repositorySource?.(repository) ?? repository.canonical_remote;
            if (!existsSync(cache)) {
              try { git(["clone", "--bare", "--no-local", "--template=", "--", source, cache]); }
              catch { throw new DomainError("BASELINE_UNAVAILABLE", "Repository cache initialization failed; no cached input is available", false, { repository_id: repository.id }); }
            }
            // Bare clones have no remote-tracking fetch mapping by default.
            // This managed cache uses the same mapping for preparation and preflight.
            git(["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { gitDir: cache });
            const path = join(privateDirectory(join(root, "workspaces", instance.instance_id, "baselines")), selection.alias);
            let baseline = previous;
            if (!baseline) {
              const intentFile = join(root, "runtime", "workspaces", instance.instance_id, `${repository.id}.json`);
              const binding = { database_id: instance.database_id, instance_id: instance.instance_id, host_id: instance.host_id,
                repository_id: repository.id, remote: repository.canonical_remote, selection, path };
              if (existsSync(intentFile)) {
                const intent = JSON.parse(safeRead(intentFile, 64 * 1024).toString("utf8"));
                const saved = intent.baseline as WorkspaceBaseline;
                if (sha256(intent.binding) !== sha256(binding) || intent.digest !== sha256({ binding: intent.binding, baseline: saved })
                  || saved.path !== path || saved.repository_id !== repository.id || saved.alias !== selection.alias
                  || !isGitOID(saved.commit) || !isGitOID(saved.tree) || saved.materialized !== false || !["fetched", "cached"].includes(saved.refresh)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Workspace preparation intent is invalid; preserve it for recovery");
                baseline = saved;
              } else {
                let refresh: "fetched" | "cached" = "fetched";
                try { git(["fetch", "--atomic", "--prune", "--no-tags", "--", source, "+refs/heads/*:refs/remotes/origin/*"], { gitDir: cache }); }
                catch {
                  if (!input.allow_cached) throw new DomainError("BASELINE_UNAVAILABLE", "Repository refresh failed; retry or explicitly allow cached input", false, { repository_id: repository.id });
                  refresh = "cached";
                }
                const selected = "branch" in selection.revision ? `refs/remotes/origin/${selection.revision.branch}` : selection.revision.commit.replace(/^sha(?:1|256):/, "");
                const oid = gitTry(["rev-parse", "--verify", `${selected}^{commit}`], { gitDir: cache });
                if (!oid) throw new DomainError("BASELINE_UNAVAILABLE", "Selected branch or commit is unavailable in the refreshed cache", false, { repository_id: repository.id });
                const algorithm = git(["rev-parse", "--show-object-format"], { gitDir: cache });
                if ("commit" in selection.revision && selection.revision.commit !== `${algorithm}:${oid}`) throw new DomainError("BASELINE_UNAVAILABLE", "Fixed input must name the exact commit, not a tag or another object format", false, { repository_id: repository.id });
                baseline = { repository_id: repository.id, alias: selection.alias, commit: `${algorithm}:${oid}`,
                  tree: `${algorithm}:${git(["rev-parse", `${oid}^{tree}`], { gitDir: cache })}`, path, refresh, materialized: false };
                atomicPrivateWrite(intentFile, JSON.stringify({ binding, baseline, digest: sha256({ binding, baseline }) }));
              }
              const oid = baseline.commit.replace(/^sha(?:1|256):/, "");
              const pin = `refs/grounds/workspace-baselines/${instance.instance_id}/${repository.id}`;
              const pinned = gitTry(["rev-parse", "--verify", pin], { gitDir: cache });
              if (pinned !== undefined && pinned !== oid) throw worktreeMismatch("", "baseline retention ref changed; preserve it for recovery");
              if (!pinned) git(["update-ref", pin, oid, "0".repeat(oid.length)], { gitDir: cache });
              instance.baselines.push(baseline);
              await persist();
            }
            if (fixed && (baseline.commit !== fixed.commit || baseline.tree !== fixed.tree)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Restored baseline differs from its fixed original context");
            const oid = baseline.commit.replace(/^sha(?:1|256):/, "");
            if (!existsSync(path)) git(["worktree", "add", "--detach", "--", path, oid], { gitDir: cache });
            checkBaseline(baseline, root, instance.instance_id);
            baseline.materialized = true;
            await persist();
          }, 30_000);
        }
      } catch (error) {
        instance.state = "blocked";
        await persist();
        throw error;
      }
      instance.state = "prepared";
      await persist();
      return instance;
    });
  }
}
