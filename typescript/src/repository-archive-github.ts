import { execFileSync } from "node:child_process";
import { sha256Bytes } from "./canonical-json.js";
import { apiID, apiRecord, GitLabFailure, type GitLabAPI, type GitLabRequestObservation } from "./gitlab-api.js";
import { ARCHIVE_NAMESPACES, type NamespacePolicy } from "./gitlab-tag-policy.js";

/** REST contract: https://docs.github.com/en/rest/repos/rules
 * GitHub.com only: credentials never follow a remote-selected API host or redirect. */
export class GitHubArchiveClient implements GitLabAPI {
  readonly observations: GitLabRequestObservation[] = [];
  private token?: string;
  private readonly started = Date.now();
  constructor(private readonly credential = (): string => {
    if (process.env.GROUNDS_GITHUB_TOKEN !== undefined) return process.env.GROUNDS_GITHUB_TOKEN;
    try {
      const env = { ...process.env };
      for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]) delete env[key];
      return execFileSync("gh", ["auth", "token", "--hostname", "github.com"], { env, encoding: "utf8", timeout: 5000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch { throw new GitLabFailure("credentials_missing"); }
  }) {}
  async get(path: string): Promise<unknown> {
    if (!/^\/[a-zA-Z0-9_/%?=&.:-]+$/.test(path) || path.includes("..") || path.startsWith("//")) throw new GitLabFailure("invalid_response");
    if (this.observations.length >= 128) throw new GitLabFailure("policy_too_complex");
    this.token ??= this.credential();
    if (!this.token.trim()) throw new GitLabFailure("credentials_missing");
    const remaining = 30000 - (Date.now() - this.started);
    if (remaining <= 0) throw new GitLabFailure("timeout");
    const signal = AbortSignal.timeout(Math.min(10000, remaining));
    const observation: GitLabRequestObservation = { method: "GET", path, status: 0 };
    this.observations.push(observation);
    try {
      const response = await fetch(`https://api.github.com${path}`, { redirect: "error", signal, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
      observation.status = response.status;
      if (!response.ok) { await response.body?.cancel(); throw new GitLabFailure(response.status === 401 ? "authentication_failed" : response.status === 403 ? "api_forbidden" : response.status === 404 ? "api_not_found" : "api_failed"); }
      const reader = response.body?.getReader();
      if (!reader) throw new GitLabFailure("invalid_response");
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) { await reader.cancel(); throw new GitLabFailure("invalid_response"); } chunks.push(value); } } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks); observation.response_digest = sha256Bytes(bytes);
      try { return JSON.parse(bytes.toString("utf8")); } catch { throw new GitLabFailure("invalid_response"); }
    } catch (error) { if (error instanceof GitLabFailure) throw error; throw new GitLabFailure(signal.aborted ? "timeout" : "network_failed"); }
  }
  async list(path: string): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const rows = await this.get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(rows) || rows.length > 100) throw new GitLabFailure("invalid_response");
      result.push(...rows); if (rows.length < 100) return result;
    }
    throw new GitLabFailure("policy_too_complex");
  }
}

/** Archive IDs contain no slash (candidate-git-archive.validateBinding), so GitHub
 * fnmatch `namespace/*` covers the complete supported archive ID language.
 * Bounded proof: full namespaces, no exclusions/bypass, no creation restrictions.
 * Unsupported active tag/push policies never silently grant creation permission. */
export function githubArchiveNamespaces(rulesets: unknown[], canPush: boolean): NamespacePolicy[] {
  const rules = rulesets.map(apiRecord).filter(row => {
    if (!["active", "disabled", "evaluate"].includes(String(row.enforcement)) || !["branch", "tag", "push", "repository"].includes(String(row.target))) throw new GitLabFailure("invalid_response");
    if (row.enforcement !== "active" || row.target === "branch") return false;
    if (row.target !== "tag") throw new GitLabFailure("policy_too_complex");
    return true;
  });
  const applicable: Record<string, unknown>[] = [];
  for (const row of rules) {
    apiID(row.id);
    const conditions = apiRecord(row.conditions);
    if (Object.keys(conditions).some(key => key !== "ref_name")) throw new GitLabFailure("policy_too_complex");
    const condition = apiRecord(conditions.ref_name);
    if (Object.keys(condition).some(key => key !== "include" && key !== "exclude")) throw new GitLabFailure("policy_too_complex");
    if (!Array.isArray(condition.include) || !condition.include.length || !condition.include.every(p => typeof p === "string") || !Array.isArray(condition.exclude)) throw new GitLabFailure("invalid_response");
    // A separate release-tag rule (for example refs/tags/v*) cannot affect an
    // archive whose literal prefix diverges before the only optional wildcard.
    // Do not generalize this proof to fnmatch brackets, escapes, or mixed includes.
    const disjoint = condition.include.every(pattern => {
      if (!/^refs\/tags\/[a-zA-Z0-9._-]+\*?$/.test(pattern)) return false;
      const prefix = pattern.replace(/\*$/, "");
      return ARCHIVE_NAMESPACES.every(namespace => !namespace.startsWith(prefix) && !prefix.startsWith(namespace));
    });
    if (disjoint) continue;
    if (!Array.isArray(row.bypass_actors)) throw new GitLabFailure("invalid_response");
    if (row.bypass_actors.length) throw new GitLabFailure("policy_too_complex");
    if (condition.exclude.length || condition.include.some(p => p !== "~ALL" && !ARCHIVE_NAMESPACES.some(n => p === n + "*" || p === n + "**"))) throw new GitLabFailure("policy_too_complex");
    if (!Array.isArray(row.rules)) throw new GitLabFailure("invalid_response");
    for (const value of row.rules) {
      const rule = apiRecord(value);
      if (!["update", "deletion", "non_fast_forward"].includes(String(rule.type)) || Object.keys(rule).some(key => key !== "type" && key !== "parameters")) throw new GitLabFailure("policy_too_complex");
      if (rule.parameters !== undefined) {
        const parameters = apiRecord(rule.parameters);
        if (Object.keys(parameters).some(key => rule.type !== "update" || key !== "update_allows_fetch_and_merge" || parameters[key] !== false)) throw new GitLabFailure("policy_too_complex");
      }
    }
    applicable.push(row);
  }
  return ARCHIVE_NAMESPACES.map(namespace => {
    const matching = applicable.filter(row => (apiRecord(apiRecord(row.conditions).ref_name).include as string[]).some(p => p === "~ALL" || p === namespace + "*" || p === namespace + "**"));
    const types = matching.flatMap(row => (row.rules as unknown[]).map(rule => apiRecord(rule).type));
    const update = types.includes("update"), deletion = types.includes("deletion"), confirmed = update && deletion;
    return { ref_namespace: namespace, tag_pattern: namespace.slice(10) + "*", protection: confirmed ? "confirmed" : "missing", current_user_can_create: canPush, developer_can_create: canPush,
      ordinary_developer_cannot_update: update, ordinary_developer_cannot_delete: deletion, maintainer_delete: "forbidden_by_ruleset", matches: [], default_difference: confirmed ? "recommended" : "missing" };
  });
}
