import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeRemote } from "./git.js";

/** No mutable branch names are accepted anywhere in an archive binding. */
export interface GitArchiveBinding {
  repository_id: string;
  canonical_remote: string;
  archive_ref: string;
  source_commit: string;
  ordered_parents: string[];
  result_tree: string;
  base_commit: string;
  /** Additional historical endpoints which must be reachable from source. */
  retained_commits?: string[];
}
export interface ArchiveProtectionEvidence {
  format: "grounds.archive-protection/v1";
  repository_id: string;
  canonical_remote: string;
  ref_namespace: "refs/tags/grounds/candidates/" | "refs/tags/grounds/deliveries/";
  source: { kind: "verified-deployment-config" | "platform-api"; locator: string; revision: string; verified_by: string };
  observed_at: string;
  valid_until: string;
  currently_applicable: boolean;
  archive_identity_can_create: boolean;
  ordinary_identity_cannot_update: boolean;
  ordinary_identity_cannot_delete: boolean;
  team_can_read_by_ref: boolean;
  repository_backup: "verified" | "unknown";
  database_backup: "verified" | "unknown";
}
/** A platform adapter or an explicitly verified, reread deployment policy. Never a prior receipt. */
export type ArchivePolicyCheck = (binding: Readonly<GitArchiveBinding>, observedAt: string) => ArchiveProtectionEvidence | Promise<ArchiveProtectionEvidence>;
export interface ArchiveProtectionDiagnosis { state: string; repository_id: string; instance: string; project_id?: number; unknowns: string[]; recovery: string[] }
export class ArchiveProtectionUnavailable extends Error {
  constructor(readonly diagnosis: ArchiveProtectionDiagnosis) { super("Archive protection could not be confirmed"); }
}
export type GitArchiveStatus = "confirmed" | "missing" | "conflict" | "unreadable" | "incomplete" | "unknown";
export interface GitArchiveObservation {
  format: "grounds.git-archive-observation/v1";
  status: GitArchiveStatus;
  observed_at: string;
  binding: GitArchiveBinding;
  reason?: string;
  remote_source_commit?: string;
  integrity?: "complete";
  protection?: ArchiveProtectionEvidence;
  protection_diagnosis?: ArchiveProtectionDiagnosis;
}
export type GitArchiveReceipt = GitArchiveObservation;
export type ArchiveProtectionPolicy = ArchiveProtectionEvidence;
export interface GitArchiveOptions { allowLocalTransport?: boolean; timeoutMs?: number }
const raw = (oid: string): string => oid.replace(/^sha(?:1|256):/, "");
const qualified = (oid: string): string => `${oid.length === 64 ? "sha256" : "sha1"}:${oid}`;
const oidPattern = /^(?:sha1:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/;
const now = (): string => new Date().toISOString();

/** Git stderr can contain credential-bearing URLs. Public errors use fixed reasons only. */
class ArchiveIdentityError extends Error {}
class ArchiveGitError extends Error {
  constructor(readonly kind: "unreadable" | "unknown" | "incomplete") { super(`Archive Git operation ${kind}`); }
}
function git(cwd: string, args: string[], options: GitArchiveOptions = {}): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    return execFileSync("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.interactive=false", "-c", `protocol.file.allow=${options.allowLocalTransport ? "always" : "never"}`, ...args], {
      cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
      timeout: options.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8").trimEnd();
  } catch (error) {
    const e = error as { code?: string; stderr?: Buffer };
    if (e.code === "ETIMEDOUT" || e.code === "ENOBUFS") throw new ArchiveGitError("unknown");
    const message = String(e.stderr ?? "");
    if (/Authentication failed|Permission denied|access denied|not authorized|could not read Username|does not appear to be a git repository|repository .* not found/i.test(message)) throw new ArchiveGitError("unreadable");
    if (/Could not resolve|Connection refused|Connection timed out|Could not read from remote|network is unreachable|remote end hung up|RPC failed/i.test(message)) throw new ArchiveGitError("unknown");
    throw new ArchiveGitError("incomplete");
  }
}
function safeRemote(value: string, options: GitArchiveOptions): string {
  if (options.allowLocalTransport && (value.startsWith("file://") || value.startsWith("/"))) {
    const path = value.startsWith("file://") ? fileURLToPath(value) : value;
    return pathToFileURL(realpathSync(path)).href;
  }
  return normalizeRemote(value);
}
export function validateGitArchiveBinding(binding: GitArchiveBinding, options: GitArchiveOptions = {}): void {
  if (!binding || !binding.repository_id || !binding.canonical_remote || !Array.isArray(binding.ordered_parents)) throw new Error("Invalid archive binding");
  if (safeRemote(binding.canonical_remote, options) !== binding.canonical_remote) throw new Error("Archive repository identity must be canonical and credential-free");
  if (!/^refs\/tags\/grounds\/(?:candidates|deliveries)\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(binding.archive_ref)) throw new Error("Invalid complete archive ref");
  for (const oid of [binding.source_commit, binding.result_tree, binding.base_commit, ...binding.ordered_parents, ...(binding.retained_commits ?? [])]) {
    if (!oidPattern.test(oid) || oid.split(":")[0] !== binding.source_commit.split(":")[0]) throw new Error("Archive requires fixed, same-format qualified OIDs");
  }
}
export function gitArchiveRequestDigest(binding: GitArchiveBinding): string {
  return `sha256:${createHash("sha256").update(JSON.stringify([binding.repository_id, binding.canonical_remote, binding.archive_ref, binding.source_commit, binding.ordered_parents, binding.result_tree, binding.base_commit, binding.retained_commits ?? []])).digest("hex")}`;
}
export function validateArchiveProtectionEvidence(evidence: ArchiveProtectionEvidence, binding: GitArchiveBinding, observedAt = now()): void {
  const at = Date.parse(observedAt), seen = Date.parse(evidence?.observed_at), until = Date.parse(evidence?.valid_until);
  if (!evidence || evidence.format !== "grounds.archive-protection/v1" || evidence.repository_id !== binding.repository_id || evidence.canonical_remote !== binding.canonical_remote
    || !["refs/tags/grounds/candidates/", "refs/tags/grounds/deliveries/"].includes(evidence.ref_namespace)
    || !binding.archive_ref.startsWith(evidence.ref_namespace)) throw new Error("Archive protection evidence scope mismatch");
  if (!Number.isFinite(at) || !Number.isFinite(seen) || !Number.isFinite(until) || seen > at || until <= at || seen >= until || !evidence.currently_applicable) throw new Error("Archive protection evidence expired or applicability unknown");
  if (!evidence.source || !["verified-deployment-config", "platform-api"].includes(evidence.source.kind) || !evidence.source.locator?.trim() || !evidence.source.revision?.trim() || !evidence.source.verified_by?.trim()) throw new Error("Archive protection evidence lacks verifiable provenance");
  if (![evidence.archive_identity_can_create, evidence.ordinary_identity_cannot_update, evidence.ordinary_identity_cannot_delete, evidence.team_can_read_by_ref].every(value => value === true)) throw new Error("Archive protection or team read permission is unverified");
  if (!/^(verified|unknown)$/.test(evidence.repository_backup) || !/^(verified|unknown)$/.test(evidence.database_backup)) throw new Error("Archive backup prerequisites must be explicitly reported");
  // Persisted receipts must not contain URL credentials or credential material.
  if (/\b(?:https?|ssh):\/\/[^\s/]*@|[?&](?:token|access_token|password|secret|api_key)=/i.test(JSON.stringify(evidence.source))) throw new Error("Archive evidence source contains credentials");
}
/** Read an operator-verified configuration on every call; policy deployment owns its authenticity.
 * The locator names a separately inspectable deployment source; revision and bounded validity
 * express the operator's current verification, not an inference from a successful push.
 */
export function readArchiveProtectionPolicy(path: string, binding: GitArchiveBinding, observedAt = now()): ArchiveProtectionEvidence {
  let evidence: ArchiveProtectionEvidence;
  try { evidence = JSON.parse(readFileSync(path, "utf8")) as ArchiveProtectionEvidence; }
  catch { throw new Error("Archive protection configuration unavailable or invalid"); }
  validateArchiveProtectionEvidence(evidence, binding, observedAt);
  // An operator-verification receipt is recheckable only while its separately
  // captured deployment configuration is present and matches the verified revision.
  if (evidence.source.kind === "verified-deployment-config") {
    try {
      const locator = new URL(evidence.source.locator);
      if (locator.protocol !== "file:" || !/^sha256:[a-f0-9]{64}$/.test(evidence.source.revision)) throw new Error();
      const bytes = readFileSync(fileURLToPath(locator));
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (digest !== evidence.source.revision) throw new Error();
    } catch { throw new Error("Verified deployment configuration cannot be rechecked or has changed"); }
  } else {
    throw new Error("Platform API protection requires a live policy adapter, not a saved receipt");
  }
  return evidence;
}
function assertLocalClosure(repositoryPath: string, binding: GitArchiveBinding, options: GitArchiveOptions): void {
  if (git(repositoryPath, ["rev-parse", "--is-shallow-repository"], options) === "true") throw new Error("Archive history incomplete: shallow repository");
  const configuration = git(repositoryPath, ["config", "--null", "--local", "--list"], options);
  if (configuration.split("\0").some(entry => /^extensions\.partialclone\n/i.test(entry) || /^remote\..+\.promisor\n(?:true|1|yes)$/i.test(entry))) throw new Error("Archive partial-clone history requires an explicit complete fetch");
  const grafts = git(repositoryPath, ["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"], options);
  if (existsSync(grafts)) throw new Error("Archive history cannot use local grafts");
  const commit = git(repositoryPath, ["cat-file", "commit", raw(binding.source_commit)], options);
  const header = commit.split("\n\n", 1)[0]!;
  const tree = header.match(/^tree ([a-f0-9]+)$/m)?.[1];
  const parents = [...header.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => qualified(match[1]!));
  if (qualified(tree ?? "") !== binding.result_tree || JSON.stringify(parents) !== JSON.stringify(binding.ordered_parents)) throw new ArchiveIdentityError("tree_or_ordered_parents_mismatch");
  if (git(repositoryPath, ["cat-file", "-t", raw(binding.source_commit)], options) !== "commit") throw new Error("Archive source must be an exact commit");
  for (const endpoint of [binding.base_commit, ...(binding.retained_commits ?? [])]) {
    try { git(repositoryPath, ["merge-base", "--is-ancestor", raw(endpoint), raw(binding.source_commit)], options); }
    catch { throw new Error("Archive endpoint is not retained by source history; archive it independently"); }
  }
  // Traversal checks every tree/blob, not just the source header. No promisor exemption
  // or lazy fetch is allowed. Gitlinks deliberately do not promise submodule contents.
  git(repositoryPath, ["rev-list", "--objects", "--missing=error", raw(binding.source_commit)], options);
  git(repositoryPath, ["fsck", "--full", "--strict", "--no-reflogs", "--no-dangling", raw(binding.source_commit)], options);
}
export function collectGitArchiveBinding(repositoryPath: string, input: Omit<GitArchiveBinding, "ordered_parents" | "result_tree">, options: GitArchiveOptions = {}): GitArchiveBinding {
  if (!oidPattern.test(input.source_commit)) throw new Error("Archive source must be a fixed qualified commit");
  const header = git(repositoryPath, ["cat-file", "commit", raw(input.source_commit)], options).split("\n\n", 1)[0]!;
  const binding = { ...input, result_tree: qualified(header.match(/^tree ([a-f0-9]+)$/m)?.[1] ?? ""), ordered_parents: [...header.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => qualified(match[1]!)) };
  validateGitArchiveBinding(binding, options);
  assertLocalClosure(repositoryPath, binding, options);
  return binding;
}
function observation(binding: GitArchiveBinding, status: GitArchiveStatus, reason?: string): GitArchiveObservation {
  return { format: "grounds.git-archive-observation/v1", observed_at: now(), binding: structuredClone(binding), status, ...(reason ? { reason } : {}) };
}
/** Pure local check. It deliberately never turns a historical receipt into a fresh remote check. */
export function inspectLocalGitArchive(repositoryPath: string, binding: GitArchiveBinding, options: GitArchiveOptions = {}): GitArchiveObservation {
  validateGitArchiveBinding(binding, options);
  try { assertLocalClosure(repositoryPath, binding, options); return { ...observation(binding, "confirmed"), integrity: "complete" }; }
  catch (error) { return observation(binding, error instanceof ArchiveIdentityError ? "conflict" : "incomplete", error instanceof ArchiveIdentityError ? "local_commit_identity_mismatch" : "local_objects_incomplete"); }
}
function remoteRef(cwd: string, binding: GitArchiveBinding, options: GitArchiveOptions): string | undefined {
  let output: string;
  try { output = git(cwd, ["ls-remote", "--refs", "--", binding.canonical_remote, binding.archive_ref], options); }
  catch (error) { throw new ArchiveGitError(error instanceof ArchiveGitError && error.kind === "unreadable" ? "unreadable" : "unknown"); }
  const rows = output.split("\n").filter(Boolean);
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) throw new Error("Ambiguous archive ref response");
  const [oid, ref] = rows[0]!.split("\t");
  if (ref !== binding.archive_ref || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid ?? "")) throw new Error("Invalid archive ref response");
  return qualified(oid!);
}
function isolated<T>(binding: GitArchiveBinding, options: GitArchiveOptions, run: (path: string) => T): T {
  const path = mkdtempSync(join(tmpdir(), "grounds-archive-check-"));
  try { git(path, ["init", "--bare", `--object-format=${binding.source_commit.startsWith("sha256:") ? "sha256" : "sha1"}`, "."], options); return run(path); }
  finally { rmSync(path, { recursive: true, force: true }); }
}
function fetchAndVerify(path: string, binding: GitArchiveBinding, options: GitArchiveOptions): void {
  git(path, ["fetch", "--no-tags", "--no-write-fetch-head", "--", binding.canonical_remote, `${binding.archive_ref}:refs/grounds/archive-check`], options);
  if (qualified(git(path, ["rev-parse", "refs/grounds/archive-check"], options)) !== binding.source_commit) throw new ArchiveIdentityError("remote_ref_changed_during_fetch");
  assertLocalClosure(path, binding, options);
}
/** Explicit network refresh; all objects must come from the declared remote, with no alternates. */
export function inspectGitArchive(input: { binding: GitArchiveBinding } & GitArchiveOptions): GitArchiveObservation {
  const { binding } = input;
  validateGitArchiveBinding(binding, input);
  try {
    return isolated(binding, input, path => {
      const source = remoteRef(path, binding, input);
      if (!source) return observation(binding, "missing", "remote_ref_absent");
      if (source !== binding.source_commit) return { ...observation(binding, "conflict", "remote_ref_points_to_different_object"), remote_source_commit: source };
      fetchAndVerify(path, binding, input);
      return { ...observation(binding, "confirmed"), integrity: "complete", remote_source_commit: source };
    });
  } catch (error) {
    return observation(binding, error instanceof ArchiveIdentityError ? "conflict" : error instanceof ArchiveGitError ? error.kind : "incomplete", error instanceof ArchiveIdentityError ? "remote_commit_identity_mismatch" : "remote_check_failed_or_objects_incomplete");
  }
}
/** Caller must persist its reservation before invoking. No Candidate/operation IDs are allocated here. */
export async function archiveGitCommit(input: { repositoryPath: string; binding: GitArchiveBinding; policyCheck: ArchivePolicyCheck; allowRemoteWrite?: boolean } & GitArchiveOptions): Promise<GitArchiveObservation> {
  const { binding } = input;
  validateGitArchiveBinding(binding, input);
  const at = now();
  let protection: ArchiveProtectionEvidence;
  const failedProtection = (error: unknown, reason: string): GitArchiveObservation => ({ ...observation(binding, "unknown", reason), ...(error instanceof ArchiveProtectionUnavailable ? { protection_diagnosis: error.diagnosis } : {}) });
  try { protection = await input.policyCheck(structuredClone(binding), at); validateArchiveProtectionEvidence(protection, binding, now()); }
  catch (error) { return failedProtection(error, "protection_configuration_unverified_or_inapplicable"); }
  let source: string | undefined;
  try { source = remoteRef(input.repositoryPath, binding, input); }
  catch (error) { return observation(binding, error instanceof ArchiveGitError ? error.kind : "unknown", "remote_ref_check_failed"); }
  if (source && source !== binding.source_commit) return { ...observation(binding, "conflict", "remote_ref_points_to_different_object"), remote_source_commit: source };
  if (!source) {
    if (input.allowRemoteWrite !== true) return observation(binding, "missing", "remote_write_not_enabled");
    assertLocalClosure(input.repositoryPath, binding, input);
    // Plain tag creation, no force/delete: an existing different tag wins races safely.
    try { git(input.repositoryPath, ["push", "--porcelain", "--", binding.canonical_remote, `${raw(binding.source_commit)}:${binding.archive_ref}`], input); }
    catch {
      // A lost response is never interpreted as a failed write. Re-observe first.
      const result = inspectGitArchive(input);
      if (result.status !== "confirmed") return result.status === "missing" ? observation(binding, "unknown", "push_unconfirmed_retry_original_reservation") : result;
      try { protection = await input.policyCheck(structuredClone(binding), result.observed_at); validateArchiveProtectionEvidence(protection, binding, now()); }
      catch (error) { return failedProtection(error, "remote_objects_confirmed_but_protection_recheck_failed"); }
      return { ...result, observed_at: now(), protection };
    }
  }
  const result = inspectGitArchive(input);
  if (result.status !== "confirmed") return result;
  // Recheck applicability after network work, including expiration during the push.
  try { protection = await input.policyCheck(structuredClone(binding), result.observed_at); validateArchiveProtectionEvidence(protection, binding, now()); }
  catch (error) { return failedProtection(error, "remote_objects_confirmed_but_protection_recheck_failed"); }
  return { ...result, observed_at: now(), protection };
}
/** Restore into a new caller-owned repository. On failure retain that directory for diagnosis. */
export function restoreGitArchive(input: { binding: GitArchiveBinding; destination: string; branch?: string } & GitArchiveOptions): GitArchiveObservation {
  validateGitArchiveBinding(input.binding, input);
  const destination = resolve(input.destination);
  if (existsSync(destination)) throw new Error("Archive restore requires a new destination; existing work is preserved");
  if (input.branch && (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(input.branch) || input.branch.includes("//"))) throw new Error("Invalid restoration branch");
  // Claim only the new leaf, atomically. git init must never adopt a path
  // created by another user between the existence check and initialization.
  try { mkdirSync(destination); }
  catch { throw new Error("Archive restore destination could not be exclusively created; existing work is preserved"); }
  try {
    git(destination, ["init", `--object-format=${input.binding.source_commit.startsWith("sha256:") ? "sha256" : "sha1"}`, "."], input);
    git(destination, ["remote", "add", "origin", input.binding.canonical_remote], input);
    fetchAndVerify(destination, input.binding, input);
    if (input.branch) git(destination, ["checkout", "-b", input.branch, raw(input.binding.source_commit)], input);
    else git(destination, ["checkout", "--detach", raw(input.binding.source_commit)], input);
    if (qualified(git(destination, ["rev-parse", "HEAD"], input)) !== input.binding.source_commit) throw new Error("Restored source mismatch");
    return { ...observation(input.binding, "confirmed"), integrity: "complete" };
  } catch (error) { return observation(input.binding, error instanceof ArchiveIdentityError ? "conflict" : error instanceof ArchiveGitError ? error.kind : "incomplete", error instanceof ArchiveIdentityError ? "restore_identity_mismatch_destination_retained" : "restore_incomplete_destination_retained"); }
}

/** Explicit fetch into a private local ref; active HEAD, index and files are untouched. */
export function fetchGitArchive(repositoryPath: string, binding: GitArchiveBinding, options: GitArchiveOptions = {}): GitArchiveObservation {
  const remote = inspectGitArchive({ binding, ...options });
  if (remote.status !== "confirmed") return remote;
  const destination = binding.archive_ref.replace("refs/tags/grounds/", "refs/grounds/");
  try {
    const refs = git(repositoryPath, ["for-each-ref", "--format=%(refname) %(objectname)", destination], options).split("\n").find(row => row.startsWith(`${destination} `))?.slice(destination.length + 1);
    if (refs && qualified(refs) !== binding.source_commit) return observation(binding, "conflict", "local_archive_ref_identity_conflict");
    git(repositoryPath, ["fetch", "--no-tags", "--no-write-fetch-head", "--", binding.canonical_remote, `${binding.archive_ref}:${destination}`], options);
    if (qualified(git(repositoryPath, ["rev-parse", destination], options)) !== binding.source_commit) return observation(binding, "conflict", "remote_ref_changed_during_fetch");
    assertLocalClosure(repositoryPath, binding, options);
    return { ...observation(binding, "confirmed"), integrity: "complete", remote_source_commit: binding.source_commit };
  } catch (error) { return observation(binding, error instanceof ArchiveIdentityError ? "conflict" : error instanceof ArchiveGitError ? error.kind : "incomplete", error instanceof ArchiveIdentityError ? "fetched_commit_identity_mismatch" : "archive_fetch_or_integrity_check_failed"); }
}
