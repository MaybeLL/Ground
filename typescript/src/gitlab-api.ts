import { execFileSync } from "node:child_process";
import { validation } from "./errors.js";
import { sha256Bytes } from "./canonical-json.js";

export type GitLabFailureCode = "credentials_missing" | "authentication_failed" | "api_forbidden" | "api_not_found" | "api_failed" | "network_failed" | "timeout" | "invalid_response" | "unsupported_version" | "policy_too_complex";
/** Never include transport errors, response bodies, headers or credential-helper output in errors. */
export class GitLabFailure extends Error {
  constructor(readonly code: GitLabFailureCode) { super(code); }
}
export interface GitLabCredential { token: string; source: "environment" | "git-credential" | "glab" }
export interface GitLabRequestObservation { method: "GET"; path: string; status: number; response_digest?: string }
export interface GitLabAPI {
  get(path: string): Promise<unknown>;
  list(path: string): Promise<unknown[]>;
  observations: GitLabRequestObservation[];
}

export function gitLabInstance(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw validation("instance", "requires a credential-free HTTPS GitLab instance URL"); }
  // HTTP is accepted only on literal loopback for isolated compatibility fixtures.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) throw validation("instance", "HTTPS required (HTTP only on loopback)");
  if (url.username || url.password || url.search || url.hash || !url.hostname || url.pathname.includes("%") || /[\s\\]/.test(raw)) throw validation("instance", "requires a credential-free instance URL without query or fragment");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Auth is resolved for this OS user and this instance, never stored in shared bindings.
 * Explicit environment credentials must name their instance. Generic GITLAB_TOKEN is
 * deliberately not a cross-instance fallback. Helpers retain ownership of login/logout.
 */
export function resolveGitLabCredential(instance: string): GitLabCredential {
  const expected = gitLabInstance(instance);
  if (process.env.GROUNDS_GITLAB_TOKEN !== undefined) {
    if (!process.env.GROUNDS_GITLAB_INSTANCE || gitLabInstance(process.env.GROUNDS_GITLAB_INSTANCE) !== expected || !process.env.GROUNDS_GITLAB_TOKEN.trim()) throw new GitLabFailure("credentials_missing");
    return { token: process.env.GROUNDS_GITLAB_TOKEN, source: "environment" };
  }
  const url = new URL(expected);
  if (url.pathname !== "/") throw new GitLabFailure("credentials_missing");
  // Keep helper context project/instance specific, suppress interactive prompts and stderr.
  try {
    const result = execFileSync("git", ["-c", "credential.interactive=false", "credential", "fill"], {
      input: `protocol=${url.protocol.slice(0, -1)}\nhost=${url.host}\npath=${url.pathname.replace(/^\//, "")}\n\n`,
      encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    });
    const token = result.split("\n").find(line => line.startsWith("password="))?.slice(9);
    if (token?.trim()) return { token, source: "git-credential" };
  } catch { /* An absent helper is expected; try the explicitly scoped GitLab CLI. */ }
  try {
    // glab honors generic token overrides before its host store. Remove those so an
    // unrelated shell login cannot masquerade as this instance's saved credential.
    const env = { ...process.env };
    for (const key of ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN", "GITLAB_HOST", "GL_HOST"]) delete env[key];
    const token = execFileSync("glab", ["auth", "token", "--hostname", url.host], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"], env }).trim();
    if (token) return { token, source: "glab" };
  } catch { /* Do not expose helper diagnostics or use another host's credentials. */ }
  throw new GitLabFailure("credentials_missing");
}

export class GitLabClient implements GitLabAPI {
  readonly observations: GitLabRequestObservation[] = [];
  private currentCredential?: GitLabCredential;
  private readonly startedAt = Date.now();
  constructor(readonly instance: string, private readonly credential: () => GitLabCredential = () => resolveGitLabCredential(instance), private readonly timeoutMs = 10_000) {
    if (gitLabInstance(instance) !== instance) throw validation("instance", "instance must be canonical");
  }
  private async request(path: string): Promise<{ value: unknown; next: string }> {
    if (!/^\/[a-zA-Z0-9_/%?=&.:-]+$/.test(path) || path.includes("..") || path.startsWith("//")) throw new GitLabFailure("invalid_response");
    if (this.observations.length >= 128) throw new GitLabFailure("policy_too_complex");
    // One check is one principal. An OS-store account switch between /user and
    // /projects must not combine one user's identity with another user's role.
    const { token } = this.currentCredential ??= this.credential();
    const observation: GitLabRequestObservation = { method: "GET", path, status: 0 };
    this.observations.push(observation);
    const remaining = 30_000 - (Date.now() - this.startedAt);
    if (remaining <= 0) throw new GitLabFailure("timeout");
    const signal = AbortSignal.timeout(Math.min(this.timeoutMs, remaining));
    try {
      // Archive Git work is synchronous and may outlive a server's keepalive
      // timeout. A new connection avoids reusing an idle socket whose close
      // notification could not run while Git held the event loop.
      // Git credential/glab may supply OAuth tokens. Bearer accepts OAuth and
      // personal/project/group access tokens; PRIVATE-TOKEN accepts only the latter.
      const response = await fetch(`${this.instance}/api/v4${path}`, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Connection: "close" }, redirect: "error", signal });
      observation.status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        throw new GitLabFailure(response.status === 401 ? "authentication_failed" : response.status === 403 ? "api_forbidden" : response.status === 404 ? "api_not_found" : "api_failed");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new GitLabFailure("invalid_response");
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 1024 * 1024) { await reader.cancel(); throw new GitLabFailure("invalid_response"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let value: unknown;
      const bytes = Buffer.concat(chunks);
      observation.response_digest = sha256Bytes(bytes);
      try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new GitLabFailure("invalid_response"); }
      return { value, next: response.headers.get("x-next-page") ?? "" };
    } catch (error) {
      if (error instanceof GitLabFailure) throw error;
      throw new GitLabFailure(signal.aborted ? "timeout" : "network_failed");
    }
  }
  async get(path: string): Promise<unknown> { return (await this.request(path)).value; }
  async list(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await this.request(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(result.value)) throw new GitLabFailure("invalid_response");
      rows.push(...result.value);
      if (rows.length > 1000 || result.value.length > 100) throw new GitLabFailure("invalid_response");
      if (result.next && result.next !== String(page + 1)) throw new GitLabFailure("invalid_response");
      if (!result.next && result.value.length < 100) return rows;
      // Servers without pagination headers still require an empty/short final page.
    }
    throw new GitLabFailure("invalid_response");
  }
}

export function apiRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitLabFailure("invalid_response");
  return value as Record<string, unknown>;
}
export function apiID(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new GitLabFailure("invalid_response");
  return value;
}
