import { GitHubArchiveClient, githubArchiveNamespaces } from "./repository-archive-github.js";
import { repositorySetting, repositorySettingID } from "./repository-settings.js";
import { sha256 } from "./canonical-json.js";
import { ArchiveProtectionUnavailable, type ArchivePolicyCheck, type ArchiveProtectionEvidence, type GitArchiveBinding } from "./candidate-git-archive.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { DomainError, validation } from "./errors.js";
import { normalizeRemote } from "./git.js";
import { isUUIDv7 } from "./identity.js";
import { apiID, apiRecord, GitLabClient, GitLabFailure, gitLabInstance, type GitLabAPI, type GitLabRequestObservation } from "./gitlab-api.js";
import { ARCHIVE_NAMESPACES, decodeTagRules, evaluateNamespace, type GitLabActor, type NamespacePolicy } from "./gitlab-tag-policy.js";
import type { RuntimeRecord } from "./runtime-record.js";
import type { RepositoryRecord, Store } from "./store-types.js";

export interface RepositoryArchiveBinding {
  format: "grounds.repository-archive-binding/v1";
  repository_id: string;
  canonical_remote: string;
  instance: string;
  project_id: number;
  project_path: string;
  ref_namespaces: typeof ARCHIVE_NAMESPACES;
  initial_policy_digest: string;
  bound_at: string;
  attribution: Attribution;
}
export type ArchiveAccessState = "ready" | "unbound" | "needs_configuration" | "permission_denied" | "binding_changed" | "unknown";
export interface ArchiveAccessReport {
  format: "grounds.repository-archive-check/v1";
  repository_id: string;
  canonical_remote: string;
  instance: string;
  project_path: string;
  project_id?: number;
  checked_at: string;
  valid_until: string;
  source: "live_gitlab_api" | "live_github_api";
  state: ArchiveAccessState;
  configuration: "ready" | "needs_configuration" | "unknown";
  binding_version: number;
  binding?: RepositoryArchiveBinding;
  gitlab_version?: string;
  actor?: GitLabActor;
  namespaces: NamespacePolicy[];
  requests: GitLabRequestObservation[];
  policy_digest?: string;
  drift: "unchanged" | "changed" | "not_compared";
  unknowns: string[];
  recovery: string[];
}

const recoveryFor = (reason: string): string => ({
  credentials_missing: "为所选GitLab实例配置当前用户的Git credential/glab登录，或同时设置GROUNDS_GITLAB_INSTANCE与私有GROUNDS_GITLAB_TOKEN，再重新检查。",
  authentication_failed: "当前实例凭据失效；重新认证当前用户后运行 repository archive-check，不复用其他实例或用户的凭据。",
  api_forbidden: "当前用户无权读取所需API；由管理员授予必要只读权限后复查，或显式使用有时效、来源可复核的 --archive-policy 运维核验。",
  api_not_found: "核对实例、项目路径、成员身份及项目是否转移；确认后显式重新绑定。",
  unsupported_version: "当前版本尚未支持核验；使用受支持的GitLab版本或显式运维核验，不把未知能力当作通过。",
  network_failed: "恢复当前实例网络/TLS连接后重新检查；离线时仅能显式使用有效运维核验。",
  timeout: "当前实例API超时；恢复服务后显式复查，不沿用缓存成功。",
  binding_changed: "项目ID、路径、remote或实例与已有绑定不同；核对是否转移/重建，确认所选项目后用当前 --expected-version 显式 archive-bind。",
  policy_too_complex: "保护规则组合超出有界核验能力；由管理员审阅并简化规则，或提供可复核的显式运维核验。",
}[reason] ?? "无法确认完整GitLab事实；检查API能力、返回格式及权限后显式复查，未知状态不能放行归档。");

function projectPath(remote: string, instance: string): string {
  const canonical = normalizeRemote(remote), url = new URL(canonical), base = new URL(instance);
  if (url.hostname !== base.hostname || (["http:", "https:"].includes(url.protocol) && url.port !== base.port)) throw validation("instance", "instance must match the selected repository host and HTTP port");
  let path = decodeURIComponent(url.pathname).replace(/^\//, "");
  const prefix = base.pathname.replace(/^\/+|\/+$/g, "");
  if (prefix && ["http:", "https:"].includes(url.protocol)) {
    if (!path.startsWith(prefix + "/")) throw validation("instance", "repository is outside this instance path");
    path = path.slice(prefix.length + 1);
  }
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(path) || path.split("/").some(part => part === "." || part === "..")) throw validation("remote", "GitLab group/project path is required");
  return path;
}

function bindingData(row: RuntimeRecord | undefined, repositoryID: string): RepositoryArchiveBinding | undefined {
  if (!row) return undefined;
  const data = row.data as unknown as RepositoryArchiveBinding;
  if ((row.id !== repositoryID && row.id !== repositorySettingID(repositoryID, "archive-binding")) || row.parent_id !== repositoryID || row.kind !== "runtime_operation" || data.format !== "grounds.repository-archive-binding/v1" || data.repository_id !== repositoryID
    || !isUUIDv7(repositoryID) || typeof data.instance !== "string" || gitLabInstance(data.instance) !== data.instance || !Number.isSafeInteger(data.project_id) || data.project_id < 1
    || typeof data.canonical_remote !== "string" || typeof data.project_path !== "string" || projectPath(data.canonical_remote, data.instance) !== data.project_path
    || JSON.stringify(data.ref_namespaces) !== JSON.stringify(ARCHIVE_NAMESPACES) || !/^sha256:[a-f0-9]{64}$/.test(data.initial_policy_digest)
    || !Number.isFinite(Date.parse(data.bound_at)) || !data.attribution) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Repository archive binding is invalid");
  return data;
}

function role(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const level = apiRecord(value).access_level;
  if (typeof level !== "number" || !Number.isSafeInteger(level) || level < 0 || level > 50) throw new GitLabFailure("invalid_response");
  return level;
}

function unexpired(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)) throw new GitLabFailure("invalid_response");
  const expires = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(expires) || new Date(expires).toISOString().slice(0, 10) !== value) throw new GitLabFailure("invalid_response");
  // Do not extend a date-only grant through the expiry day when the server's
  // effective removal time is not available to this API observer.
  return expires > Date.now();
}

/** Derive the same state and guidance from a successful API snapshot both
 * during checks and after a rebind. Saving identity cannot resolve permissions. */
function withAccessState(report: ArchiveAccessReport, changed = false): ArchiveAccessReport {
  const unknownPermission = report.namespaces.some(namespace => namespace.current_user_can_create === "unknown");
  const state: ArchiveAccessState = changed ? "binding_changed"
    : report.configuration === "unknown" ? "unknown"
    : report.configuration !== "ready" ? "needs_configuration"
    : unknownPermission ? "unknown"
    : report.namespaces.some(namespace => namespace.current_user_can_create !== true) ? "permission_denied" : report.binding ? "ready" : "unbound";
  const unknowns: string[] = [], recovery: string[] = [];
  if (changed) { unknowns.push("binding_changed"); recovery.push(recoveryFor("binding_changed")); }
  // Preserve uncertainty even while identity drift is the primary state.
  if (unknownPermission) { unknowns.push("group_create_permission_unknown"); recovery.push(recoveryFor("api_forbidden")); }
  if (state === "needs_configuration") recovery.push("请项目Maintainer/Owner按 archive-guide 在GitLab设置两个命名空间，再显式 archive-check；Grounds不会更改规则或角色。");
  if (state === "permission_denied") recovery.push("保留项目现有更严格策略；使用实际获准创建的项目身份，或联系管理员审阅所需条件后复查。");
  if (state === "unbound") recovery.push(`核对实例/项目后运行 grounds repository archive-bind --repository ${report.repository_id} --expected-version 0。`);
  return { ...report, state, unknowns, recovery };
}

/** Bindings are shared identity facts, not shared authorization or cached success.
 * This uses the existing versioned runtime_operation store; no schema migration
 * or rewriting of Candidates, receipts, signatures or old contracts is needed.
 */
export class RepositoryArchiveAccess {
  constructor(private readonly store: Store, private readonly client: (instance: string) => GitLabAPI = instance => new GitLabClient(instance), private readonly githubClient: () => GitLabAPI = () => new GitHubArchiveClient()) {}

  private async repository(id: string): Promise<RepositoryRecord> {
    if (!isUUIDv7(id)) throw validation("repository", "UUIDv7 required");
    return this.store.read(tx => tx.getRepository(id));
  }
  async status(id: string) {
    const repository = await this.repository(id), row = await this.store.read(tx => repositorySetting(tx, id, "archive-binding"));
    const binding = bindingData(row, id);
    return { repository_id: id, canonical_remote: repository.canonical_remote, binding_version: row?.version ?? 0,
      state: binding ? binding.canonical_remote === repository.canonical_remote ? "not_checked" : "binding_changed" : "unbound",
      ...(binding ? { binding } : {}), authorization: "unknown", recovery: [`grounds repository archive-check --repository ${id}`] };
  }

  async check(id: string, selectedInstance?: string): Promise<ArchiveAccessReport> {
    const repository = await this.repository(id), row = await this.store.read(tx => repositorySetting(tx, id, "archive-binding")), binding = bindingData(row, id);
    const remote = new URL(repository.canonical_remote);
    const instance = gitLabInstance(selectedInstance ?? binding?.instance ?? `https://${["http:", "https:"].includes(remote.protocol) ? remote.host : remote.hostname}`);
    const path = projectPath(repository.canonical_remote, instance);
    const github = remote.hostname === "github.com";
    if (github && (instance !== "https://github.com" || path.split("/").length !== 2)) throw validation("instance", "GitHub.com requires https://github.com and owner/repository");
    const client = github ? this.githubClient() : this.client(instance);
    const at = new Date().toISOString();
    const report: ArchiveAccessReport = {
      format: "grounds.repository-archive-check/v1", repository_id: id, canonical_remote: repository.canonical_remote, instance, project_path: path,
      checked_at: at, valid_until: new Date(Date.parse(at) + 60_000).toISOString(), source: github ? "live_github_api" : "live_gitlab_api", state: "unknown", configuration: "unknown",
      binding_version: row?.version ?? 0, ...(binding ? { binding } : {}), namespaces: [], requests: client.observations, drift: "not_compared", unknowns: [], recovery: [],
    };
    try {
      if (github) {
        const user = apiRecord(await client.get("/user")), userID = apiID(user.id);
        if (typeof user.login !== "string" || !/^[a-zA-Z0-9-]{1,39}$/.test(user.login)) throw new GitLabFailure("invalid_response");
        const project = apiRecord(await client.get(`/repos/${path}`));
        report.project_id = apiID(project.id);
        if (typeof project.full_name !== "string" || project.full_name.toLowerCase() !== path.toLowerCase() || typeof project.html_url !== "string" || project.html_url.toLowerCase() !== `${instance}/${path}`.toLowerCase() || project.archived !== false || project.disabled !== false) throw new GitLabFailure("invalid_response");
        const permissions = apiRecord(project.permissions);
        if (typeof permissions.push !== "boolean" || permissions.pull !== true) throw new GitLabFailure("invalid_response");
        report.actor = { id: userID, username: user.login, access_level: permissions.push ? 30 : 10 };
        const listed = await client.list(`/repos/${path}/rulesets?includes_parents=true`);
        const rules: unknown[] = [], ids = new Set<number>();
        for (const value of listed) {
          const item = apiRecord(value), ruleID = apiID(item.id);
          if (ids.has(ruleID)) throw new GitLabFailure("invalid_response"); ids.add(ruleID);
          const detail = apiRecord(await client.get(`/repos/${path}/rulesets/${ruleID}`));
          if (detail.id !== ruleID || detail.target !== item.target || detail.enforcement !== item.enforcement || !["Repository", "Organization", "Enterprise"].includes(String(item.source_type)) || typeof item.source !== "string" || detail.source_type !== item.source_type || detail.source !== item.source) throw new GitLabFailure("invalid_response");
          rules.push(detail);
        }
        report.namespaces = githubArchiveNamespaces(rules, permissions.push);
        report.policy_digest = sha256({ instance, project_id: report.project_id, project_path: path, rules });
        report.drift = binding ? binding.initial_policy_digest === report.policy_digest ? "unchanged" : "changed" : "not_compared";
        report.configuration = report.namespaces.every(namespace => namespace.protection === "confirmed") ? "ready" : "needs_configuration";
        const changed = !!binding && (binding.instance !== instance || binding.project_id !== report.project_id || binding.project_path !== path || binding.canonical_remote !== repository.canonical_remote);
        Object.assign(report, withAccessState(report, changed));
        report.recovery = report.recovery.map(message => message.replaceAll("GitLab", "GitHub").replaceAll("Maintainer/Owner", "repository administrator"));
      } else {
      const version = apiRecord(await client.get("/version"));
      if (typeof version.version !== "string" || !/^(14\.(?:1[0-9]|[2-9][0-9])|1[5-8]\.\d+)\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(version.version)) throw new GitLabFailure("unsupported_version");
      report.gitlab_version = version.version;
      // Protected tags used direct group membership through GitLab 17.1.
      // From 17.2, EE::ProtectedRefAccess also requires Developer in the
      // directly invited group and its project link (not the project role).
      const [major, minor] = version.version.split(".").map(Number);
      const developerGroupGrant = major! > 17 || major === 17 && minor! >= 2;
      const user = apiRecord(await client.get("/user")), userID = apiID(user.id);
      if (typeof user.username !== "string" || !/^[a-zA-Z0-9_.-]{1,255}$/.test(user.username) || user.state !== "active") throw new GitLabFailure("authentication_failed");
      const project = apiRecord(await client.get(`/projects/${encodeURIComponent(path)}`));
      report.project_id = apiID(project.id);
      if (project.path_with_namespace !== path || typeof project.web_url !== "string" || project.web_url.replace(/\/$/, "") !== `${instance}/${path}`) throw new GitLabFailure("invalid_response");
      // Redirected project paths, transferred/recreated projects and explicit instance
      // changes must never silently reuse the old project-scoped binding.
      const changed = !!binding && (binding.instance !== instance || binding.project_id !== report.project_id || binding.project_path !== path || binding.canonical_remote !== repository.canonical_remote);
      // Project.permissions describes direct/owning-group memberships, not the
      // effective role from invited groups. Ask for this principal's highest
      // project membership (including inherited/invited sources) instead.
      const member = apiRecord(await client.get(`/projects/${report.project_id}/members/all/${userID}`));
      if (member.id !== userID) throw new GitLabFailure("invalid_response");
      const memberRole = role(member);
      const active = (member.state === undefined || member.state === "active") && (member.membership_state === undefined || member.membership_state === "active");
      const access = active && unexpired(member.expires_at) ? memberRole : 0;
      report.actor = { id: userID, username: user.username, access_level: access };
      if (project.archived !== false || !["enabled", "private"].includes(String(project.repository_access_level))) throw new GitLabFailure("invalid_response");
      const rules = decodeTagRules(await client.list(`/projects/${report.project_id}/protected_tags`));
      const groups = new Map<number, boolean | "unknown">();
      const shared = project.shared_with_groups;
      // Resolve only grants that could matter; a missing/private group remains unknown.
      const initial = ARCHIVE_NAMESPACES.map(namespace => evaluateNamespace(namespace, rules, report.actor!));
      const relevant = initial.flatMap(namespace => namespace.matches.flatMap(match => match.rule.create_access_levels));
      for (const grant of relevant) if (grant.group_id !== undefined && !groups.has(grant.group_id)) {
        if (groups.size >= 64) throw new GitLabFailure("policy_too_complex");
        const share = developerGroupGrant && Array.isArray(shared) ? shared.map(apiRecord).find(item => item.group_id === grant.group_id) : undefined;
        if (developerGroupGrant && (!share || typeof share.group_access_level !== "number" || share.group_access_level < 30)) { groups.set(grant.group_id, false); continue; }
        try {
          if (share && !unexpired(share.expires_at)) { groups.set(grant.group_id, false); continue; }
          const member = apiRecord(await client.get(`/groups/${grant.group_id}/members/${userID}`));
          if (member.id !== userID) throw new GitLabFailure("invalid_response");
          groups.set(grant.group_id, role(member) >= (developerGroupGrant ? 30 : 10) && unexpired(member.expires_at));
        } catch (error) { groups.set(grant.group_id, error instanceof GitLabFailure && error.code === "api_not_found" ? false : "unknown"); }
      }
      report.namespaces = ARCHIVE_NAMESPACES.map(namespace => evaluateNamespace(namespace, rules, report.actor!, groups));
      report.policy_digest = sha256({ instance, project_id: report.project_id, project_path: path, rules, repository_access_level: project.repository_access_level });
      report.drift = binding ? binding.initial_policy_digest === report.policy_digest ? "unchanged" : "changed" : "not_compared";
      report.configuration = report.namespaces.every(namespace => namespace.protection === "confirmed") ? "ready" : "needs_configuration";
      Object.assign(report, withAccessState(report, changed));
      }
    } catch (error) {
      const reason = error instanceof GitLabFailure ? error.code : "invalid_response";
      report.state = "unknown"; report.unknowns.push(reason); report.recovery.push(github ? `GitHub archive check failed (${reason}). Authenticate using gh auth login --hostname github.com or GROUNDS_GITHUB_TOKEN. Check repository permissions and Settings > Rules. Private repository rulesets may require a paid GitHub plan. Missing API access and unsupported policies never authorize archives; re-run archive-check after resolving the issue.` : recoveryFor(reason));
    }
    // The check interval includes all reads; its short validity is informational.
    // Authorization is re-read on every pre/post archive policy callback.
    report.checked_at = new Date().toISOString();
    report.valid_until = new Date(Date.parse(report.checked_at) + 60_000).toISOString();
    return report;
  }

  async bind(input: { repository_id: string; instance?: string; expected_version: number; operation_id: string; attribution: Attribution }) {
    validateAttribution(input.attribution);
    if (!isUUIDv7(input.operation_id) || !Number.isSafeInteger(input.expected_version) || input.expected_version < 0) throw validation("archive-bind", "operation UUIDv7 and nonnegative expected-version required");
    const request = sha256({ ...input, instance: input.instance ? gitLabInstance(input.instance) : null });
    const replay = await this.store.read(tx => tx.getOperation(input.operation_id));
    if (replay) {
      if (replay.command !== "repository.archive-bind" || replay.request_hash !== request) throw new DomainError("IDEMPOTENCY_CONFLICT", "Archive binding retry differs from its original operation");
      return JSON.parse(replay.result_json);
    }
    const report = await this.check(input.repository_id, input.instance);
    if (!report.project_id || !report.policy_digest || !report.actor || report.state === "unknown") throw new DomainError("STATE_CONFLICT", "Repository platform identity could not be confirmed; binding unchanged", false, { report });
    const binding: RepositoryArchiveBinding = {
      format: "grounds.repository-archive-binding/v1", repository_id: input.repository_id, canonical_remote: report.canonical_remote, instance: report.instance,
      project_id: report.project_id, project_path: report.project_path, ref_namespaces: ARCHIVE_NAMESPACES, initial_policy_digest: report.policy_digest,
      bound_at: report.checked_at, attribution: input.attribution,
    };
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: input.operation_id, command: "repository.archive-bind", request_hash: request });
      if (replay) return JSON.parse(replay.result_json);
      const repository = await tx.getRepository(input.repository_id);
      if (repository.canonical_remote !== binding.canonical_remote) throw new DomainError("STATE_CONFLICT", "Repository changed during platform discovery; explicitly recheck");
      const old = await repositorySetting(tx, input.repository_id, "archive-binding");
      bindingData(old, input.repository_id);
      if (old) await tx.lockRuntimeRecord("runtime_operation", old.id);
      if ((old?.version ?? 0) !== input.expected_version) throw new DomainError("VERSION_CONFLICT", "Archive binding version changed; read current status before rebinding");
      const row: RuntimeRecord = { id: old?.id ?? repositorySettingID(input.repository_id, "archive-binding"), kind: "runtime_operation", parent_id: input.repository_id, version: input.expected_version + 1, data: binding as unknown as Record<string, unknown> };
      await tx.saveRuntimeRecord(row, input.expected_version);
      const result = { result_type: "grounds.result.repository-archive-access/v1", command: "repository.archive-bind", binding, binding_version: row.version,
        report: withAccessState({ ...report, binding, binding_version: row.version, drift: "unchanged" }) };
      await tx.completeOperation(input.operation_id, JSON.stringify(result)); return result;
    });
  }

  /** A new live check for each callback, including the post-push check. */
  policy(): ArchivePolicyCheck {
    return async (binding: Readonly<GitArchiveBinding>) => {
      const status = await this.status(binding.repository_id);
      if (!status.binding) throw new ArchiveProtectionUnavailable({ state: "unbound", repository_id: binding.repository_id, instance: `https://${new URL(status.canonical_remote).hostname}`, unknowns: ["project_binding_missing"], recovery: status.recovery });
      const report = await this.check(binding.repository_id);
      if (report.state !== "ready" || binding.canonical_remote !== report.canonical_remote || !report.project_id || !report.policy_digest || !report.actor) throw new ArchiveProtectionUnavailable({ state: report.state, repository_id: report.repository_id, instance: report.instance, ...(report.project_id ? { project_id: report.project_id } : {}), unknowns: report.unknowns, recovery: report.recovery });
      const namespace = report.namespaces.find(item => binding.archive_ref.startsWith(item.ref_namespace));
      if (!namespace || !report.namespaces.every(item => item.protection === "confirmed" && item.current_user_can_create === true)) throw new DomainError("STATE_CONFLICT", "Both archive namespaces must be confirmed for the current user", false, { report });
      const evidence: ArchiveProtectionEvidence = {
        format: "grounds.archive-protection/v1", repository_id: binding.repository_id, canonical_remote: report.canonical_remote, ref_namespace: namespace.ref_namespace,
        source: { kind: "platform-api", locator: report.source === "live_github_api" ? `https://api.github.com/repos/${report.project_path}/rulesets` : `${report.instance}/api/v4/projects/${report.project_id}/protected_tags`, revision: report.policy_digest, verified_by: `${report.source === "live_github_api" ? "github" : "gitlab"}-user:${report.actor.id}@${report.instance}` },
        observed_at: report.checked_at, valid_until: report.valid_until, currently_applicable: true,
        archive_identity_can_create: true, ordinary_identity_cannot_update: true, ordinary_identity_cannot_delete: true, team_can_read_by_ref: true,
        repository_backup: "unknown", database_backup: "unknown",
      };
      return evidence;
    };
  }
}

/** Suggestions only. No mutating GitLab API is implemented by this feature. */
export function archiveConfigurationGuide(report: ArchiveAccessReport) {
  return {
    instance: report.instance, project_id: report.project_id ?? null, project_path: report.project_path,
    settings_url: report.source === "live_github_api" ? `${report.instance}/${report.project_path}/settings/rules` : `${report.instance}/${report.project_path}/-/settings/repository`,
    template: { format: report.source === "live_github_api" ? "grounds.github-archive-template/v1" : "grounds.gitlab-archive-template/v1", tag_patterns: ["grounds/candidates/*", "grounds/deliveries/*"], create_access_level: 30,
      existing_tag_update: "forbidden", developer_delete: "forbidden", maintainer_delete: report.source === "live_github_api" ? "forbidden_by_ruleset" : "explicit_gitlab_ui_or_api" },
    namespaces: ARCHIVE_NAMESPACES.map(namespace => {
      const current = report.namespaces.find(item => item.ref_namespace === namespace);
      return { ref_namespace: namespace, existing_rules: current?.matches ?? [], action: current?.protection === "confirmed" ? "preserve_existing_rules" : "administrator_review_required",
        suggestion: report.source === "live_github_api" ? "Administrator: configure active GitHub tag rulesets with no bypass actors, no exclusions, and update/deletion restrictions. Creation stays available to writers. Unsupported policies fail closed. Preserve stricter rules and recheck." : current?.protection === "confirmed" ? "保留已有规则；严格或自定义策略按实际用户权限使用。" : "由Maintainer/Owner在GitLab Settings > Repository > Protected tags核对已有规则后，为此完整模式配置Developer及以上创建；不要自动替换或放宽已有策略。",
        recommended_request_preview: report.source === "live_github_api" ? { method: "POST", path: `/repos/${report.project_path}/rulesets`, body: { name: "Grounds immutable archives", target: "tag", enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ARCHIVE_NAMESPACES.map(n => n + "*"), exclude: [] } }, rules: [{ type: "update" }, { type: "deletion" }] }, executed: false } : { method: "POST", path: `/projects/${report.project_id ?? ":project_id"}/protected_tags`, body: { name: namespace.slice("refs/tags/".length) + "*", create_access_level: 30 }, executed: false } };
    }),
    confirmation: "配置预览不表示已配置；管理员操作后显式重新运行 repository archive-check，只以实时读取结果判定就绪。",
  };
}
