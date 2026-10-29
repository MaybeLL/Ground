import { assertNoTrackedGroundsRuntime, isPrivateGroundsPath } from "./grounds-exclude.js";
import type { DeliveryReceipt } from "./selection.js";
import { runGit as git, runGitWithEnv } from "./git-command.js";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { DomainError, validation, baselineUnavailable, repositoryAmbiguous, repositoryNotResolved, worktreeMismatch } from "./errors.js";
import { CandidateArtifact, CandidateFile, validateBaseline } from "./domain.js";
import { isGitOID, isSha256, isUUIDv7, qualifiedOID } from "./identity.js";
import { sha256Bytes } from "./canonical-json.js";
import { assertCapturableSubmodules } from "./git-submodules.js";

export interface GitRemote {
  name: string;
  raw_url: string;
  canonical: string;
}

export interface LocalRepository {
  root: string;
  remotes: GitRemote[];
}

export type WorktreeMode = "existing" | "review" | "delivery";
export interface ReviewWorktreeMarker {
  format: "patchledger.review-worktree/v1";
  database_id: string;
  candidate_id: string;
  repository_id: string;
  baseline_oid: string;
  result_tree_oid: string;
  patch_digest: string;
}
export interface MaterializeWorktreeOptions { source_commit?: string; source_path: string; target_path: string; mode: WorktreeMode; branch?: string; baseline_oid: string; patch: Buffer; expected_tree_oid: string; review_marker?: ReviewWorktreeMarker }
export interface MaterializedWorktree { target_path: string; mode: WorktreeMode; branch?: string }

const gitText = (cwd: string, args: string[], indexPath?: string): string => git(cwd, args, indexPath).toString("utf8");

const reviewMarkerPath = (worktreePath: string): string => {
  const root = discoverRepository(worktreePath).root;
  const raw = gitText(root, ["rev-parse", "--git-path", "grounds-review.json"]).trim();
  if (!raw) throw worktreeMismatch("", "Git did not resolve review worktree metadata");
  return resolve(root, raw);
};

const validReviewMarker = (value: unknown): value is ReviewWorktreeMarker => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  const expected = ["baseline_oid", "candidate_id", "database_id", "format", "patch_digest", "repository_id", "result_tree_oid"];
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    && marker.format === "patchledger.review-worktree/v1"
    && typeof marker.database_id === "string" && isUUIDv7(marker.database_id)
    && typeof marker.candidate_id === "string" && isUUIDv7(marker.candidate_id)
    && typeof marker.repository_id === "string" && isUUIDv7(marker.repository_id)
    && typeof marker.baseline_oid === "string" && isGitOID(marker.baseline_oid)
    && typeof marker.result_tree_oid === "string" && isGitOID(marker.result_tree_oid)
    && typeof marker.patch_digest === "string" && isSha256(marker.patch_digest);
};

export const readReviewWorktreeMarker = (worktreePath = "."): ReviewWorktreeMarker | undefined => {
  let path: string;
  try { path = reviewMarkerPath(worktreePath); }
  catch { return undefined; }
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw worktreeMismatch("", "review worktree metadata is not valid JSON"); }
  if (!validReviewMarker(parsed)) throw worktreeMismatch("", "review worktree metadata does not match patchledger.review-worktree/v1");
  return parsed;
};

/**
 * A review worktree starts at the fixed Git Candidate. Before treating a
 * current worktree line as a Candidate location, re-capture its content. The marker
 * identifies the materialized Candidate but cannot prove the user has not
 * edited its files since then.
 */
export const assertReviewWorktreeCandidateArtifact = (worktreePath: string, marker: ReviewWorktreeMarker): void => {
  const artifact = captureArtifact(worktreePath, marker.baseline_oid);
  if (artifact.result_tree_oid !== marker.result_tree_oid || artifact.patch_digest !== marker.patch_digest) {
    throw worktreeMismatch(marker.candidate_id, "review worktree content has drifted from the Candidate artifact; restore it or query the Candidate explicitly");
  }
};

const writeReviewWorktreeMarker = (worktreePath: string, marker: ReviewWorktreeMarker): void => {
  if (!validReviewMarker(marker)) throw validation("review_marker", "must match patchledger.review-worktree/v1");
  const path = reviewMarkerPath(worktreePath);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
};

/** Stored under the worktree-specific Git directory, never in captured source. */
export const writeDeliveryReceipt = (worktreePath: string, receipt: DeliveryReceipt): string => {
  try {
    const root = discoverRepository(worktreePath).root;
    const raw = gitText(root, ["rev-parse", "--git-path", "grounds-delivery.json"]).trim();
    if (!raw) throw new Error("Git did not resolve the receipt path");
    const path = resolve(root, raw);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally { if (existsSync(temporary)) rmSync(temporary); }
    return path;
  } catch {
    throw worktreeMismatch(receipt.candidate_id, `Delivery worktree was created at ${worktreePath}, but its receipt could not be saved. The directory is retained; do not treat delivery preparation as complete.`);
  }
};

const scpLike = (value: string): boolean => !value.includes("://") && (value.match(/@/g) ?? []).length === 1 && value.indexOf(":") > value.indexOf("@");

// WHATWG URL normalizes literal dot segments while parsing, so retain the
// original path spelling for the canonicality check.
const rawURLPath = (value: string): string => {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return "";
  const authorityEnd = value.slice(schemeEnd + 3).search(/[\/?#]/);
  if (authorityEnd < 0) return "";
  const start = schemeEnd + 3 + authorityEnd;
  const suffix = value.slice(start);
  const query = suffix.search(/[?#]/);
  return query < 0 ? suffix : suffix.slice(0, query);
};

// URL parsers intentionally leave malformed percent escapes in pathnames so
// callers can decide how to handle them.  A persisted canonical remote must
// never contain such a spelling: it is neither a valid URI path nor stable
// across Git/URL implementations.  Validate the original escaped spelling
// before applying any path normalization.
const validateEscapedPath = (path: string, field: string): void => {
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] !== "%") continue;
    if (index + 2 >= path.length || !/^[0-9A-Fa-f]{2}$/.test(path.slice(index + 1, index + 3))) {
      throw validation(field, "remote path contains an invalid percent escape");
    }
    index += 2;
  }
};

export const normalizeRemote = (raw: string): string => {
  if (typeof raw !== "string") throw validation("remote", "must be a string");
  const value = raw.trim();
  if (!value) throw validation("remote", "must not be empty");
  if (scpLike(value)) {
    const at = value.indexOf("@");
    const colon = value.indexOf(":", at + 1);
    return normalizeRemoteParts("ssh", value.slice(0, at), value.slice(at + 1, colon), "", value.slice(colon + 1));
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw validation("remote", "must be an SSH, HTTP, or HTTPS remote URL");
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!["ssh", "http", "https", "git"].includes(scheme)) throw validation("remote", "unsupported transport");
  if (parsed.search || parsed.hash) throw validation("remote", "query and fragment are not supported in a repository remote");
  // HTTP(S) userinfo may contain a token from a local credential helper. It
  // identifies no repository and must be discarded before persistence. SSH
  // usernames are retained as part of the transport identity; SSH passwords
  // are rejected because they should never cross the CLI boundary.
  let user = "";
  if (scheme === "ssh" && (parsed.username || parsed.password)) {
    if (parsed.password) throw validation("remote", "SSH passwords are not supported in a repository remote");
    try { user = decodeURIComponent(parsed.username); }
    catch { throw validation("remote", "SSH username is not valid URL encoding"); }
  }
  const originalPath = rawURLPath(value) || parsed.pathname;
  // Check the spelling before WHATWG URL parsing can collapse dot segments;
  // the normalized pathname is used only after that check so literal spaces
  // and Unicode are encoded consistently with Git path representation.
  validateEscapedPath(originalPath, "remote");
  const originalCleanPath = originalPath.replace(/^\/+|\/+$/g, "");
  if (!originalCleanPath || originalCleanPath === "." || posix.normalize(`/${originalCleanPath}`) !== `/${originalCleanPath}`) throw validation("remote", "remote path is invalid");
  return normalizeRemoteParts(scheme, user, parsed.hostname, parsed.port, parsed.pathname);
};

const normalizeRemoteParts = (scheme: string, user: string, host: string, port: string, rawPath: string): string => {
  if (!host) throw validation("remote", "remote host must not be empty");
  if (/[\/@:]/.test(user)) throw validation("remote", "remote user is invalid");
  validateEscapedPath(rawPath, "remote");
  // WHATWG URL retains brackets in URL.hostname for IPv6 literals; strip
  // them before formatHost adds the single canonical pair back.
  const lowerHost = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!netHost(lowerHost)) throw validation("remote", "remote host is invalid");
  let cleanPath = rawPath.replace(/^\/+|\/+$/g, "");
  if (cleanPath.endsWith(".git")) cleanPath = cleanPath.slice(0, -4);
  if (!cleanPath || cleanPath === "." || posix.normalize(`/${cleanPath}`) !== `/${cleanPath}`) throw validation("remote", "remote path is invalid");
  if ((scheme === "ssh" && port === "22") || (scheme === "http" && port === "80") || (scheme === "https" && port === "443")) port = "";
  const authority = `${user ? `${user}@` : ""}${formatHost(lowerHost, port)}`;
  return `${scheme}://${authority}/${cleanPath}`;
};

const netHost = (host: string): boolean => !/\s/.test(host) && host.length > 0;
const formatHost = (host: string, port: string): string => (port ? (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`) : (host.includes(":") ? `[${host}]` : host));

/** Validate the representation accepted by the domain/store seam.  CLI
 * callers normalize user-facing Git URLs first; direct Module callers must
 * still be unable to persist a second spelling of the same Repository. */
export const validateCanonicalRemote = (value: string): void => {
  if (typeof value !== "string") throw validation("canonical_remote", "must be a string");
  if (!value || value.trim() !== value || Buffer.byteLength(value, "utf8") > 4096) throw validation("canonical_remote", "must be a canonical remote");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw validation("canonical_remote", "must be a canonical remote"); }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (parsed.protocol !== `${scheme}:` || !["ssh", "http", "https", "git"].includes(scheme) || parsed.search || parsed.hash) throw validation("canonical_remote", "must use a supported canonical transport");
  if (parsed.username || parsed.password) {
    if (scheme !== "ssh" || parsed.password) throw validation("canonical_remote", "credentials are not allowed and only SSH may contain a username");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host || (isIP(host) === 0 && host !== host.toLowerCase()) || !netHost(host)) throw validation("canonical_remote", "host must be lowercase");
  const port = parsed.port;
  if ((scheme === "ssh" && port === "22") || (scheme === "http" && port === "80") || (scheme === "https" && port === "443")) throw validation("canonical_remote", "must omit the transport default port");
  const originalPath = rawURLPath(value) || parsed.pathname;
  validateEscapedPath(originalPath, "canonical_remote");
  const originalCleanPath = originalPath.replace(/^\/+|\/+$/g, "");
  if (!originalCleanPath || originalCleanPath === "." || posix.normalize(`/${originalCleanPath}`) !== `/${originalCleanPath}`) throw validation("canonical_remote", "has a non-canonical repository path");
  const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  validateEscapedPath(path, "canonical_remote");
  if (!path || path.endsWith(".git") || posix.normalize(`/${path}`) !== `/${path}`) throw validation("canonical_remote", "has a non-canonical repository path");
  let user = "";
  if (parsed.username) {
    try { user = decodeURIComponent(parsed.username); }
    catch { throw validation("canonical_remote", "SSH username is not valid URL encoding"); }
  }
  const expected = `${scheme}://${user ? `${user}@` : ""}${formatHost(host, port)}/${path}`;
  if (value !== expected) throw validation("canonical_remote", "must use the normalized remote representation");
};

export const discoverRepository = (worktreePath = "."): LocalRepository => {
  let root: string;
  try {
    root = gitText(worktreePath, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw repositoryNotResolved("current directory is not inside a Git worktree");
  }
  let namesOutput: string;
  try { namesOutput = gitText(root, ["remote"]); }
  catch { throw repositoryNotResolved("Git remotes could not be inspected"); }
  const names = namesOutput.trim().split(/\r?\n/).filter(Boolean);
  const remotes: GitRemote[] = [];
  for (const name of names) {
    let raw: string;
    try { raw = gitText(root, ["config", "--get-all", `remote.${name}.url`]).trim(); if (raw.includes("\n")) throw new Error("ambiguous fetch URLs"); }
    catch { throw repositoryNotResolved(`Git remote ${name} could not be read`); }
    try {
      remotes.push({ name, raw_url: raw, canonical: normalizeRemote(raw) });
    } catch {
      // Unsupported remotes do not prevent another supported remote from
      // identifying the clone.
    }
  }
  return { root, remotes };
};

export const selectRemote = (repository: LocalRepository, name = ""): GitRemote => {
  if (name) {
    const selected = repository.remotes.find((remote) => remote.name === name);
    if (!selected) throw repositoryNotResolved("requested --remote is absent or unsupported in the current clone");
    return selected;
  }
  if (repository.remotes.length === 1) return repository.remotes[0];
  if (repository.remotes.length === 0) throw repositoryNotResolved("current clone has no supported Git remote");
  throw repositoryAmbiguous("current clone has multiple remotes; pass --remote NAME");
};

export const resolveBaseline = (worktreePath = ".", reference = "HEAD"): string => {
  try {
    const requested = reference || "HEAD"; const qualified = isGitOID(requested); const rawReference = qualified ? requested.slice(requested.indexOf(":") + 1) : requested;
    // One process answers both questions; Git's output order is not specified, so lines are told apart by content.
    const lines = gitText(worktreePath, ["rev-parse", "--verify", `${rawReference}^{commit}`, "--show-object-format"]).trim().split(/\r?\n/);
    const format = lines.find(line => line === "sha1" || line === "sha256"), oid = lines.find(line => line !== format);
    if (lines.length !== 2 || !format || !oid) throw new Error("unexpected rev-parse output");
    const result = qualifiedOID(format, oid); if (qualified && result !== requested) throw new Error("qualified Git OID uses a different object format"); return result;
  } catch {
    throw baselineUnavailable(`Git could not resolve ${reference || "HEAD"} to a commit`);
  }
};

/** Local remote names that denote any of `registeredRemotes`.  An exact
 * canonical match always wins; otherwise a remote matches when its
 * transport-agnostic key equals a registered remote's key, so a clone whose
 * origin is spelled over https still binds to a Repository registered over ssh
 * (and vice versa). */
export const matchingRemoteNames = (repository: LocalRepository, registeredRemotes: string[]): string[] => {
  const keys = new Set<string>();
  for (const remote of registeredRemotes) { const key = repositoryMatchKey(remote); if (key !== undefined) keys.add(key); }
  return repository.remotes.filter((remote) => registeredRemotes.includes(remote.canonical)
    || ((): boolean => { const key = repositoryMatchKey(remote.canonical); return key !== undefined && keys.has(key); })()).map((remote) => remote.name);
};

/** Comparison-only key that decides whether two canonical remotes denote the
 * same Repository regardless of transport.  It is derived by string rules from
 * a value that already passed `validateCanonicalRemote` (never persisted, never
 * a stored identity), and deliberately keeps only the lowercase host and the
 * normalized path: protocol, SSH username, and ssh/git ports are ignored so the
 * same host and path stay one Repository across ssh://, scp-like, http(s) and
 * git:// spellings.  An http(s) remote with a non-default port additionally
 * keeps that port and only interoperates with http(s) on the same host and
 * port, so distinct local services are not merged.  A local part that the
 * canonical form cannot carry (no scheme delimiter or no path) has no key. */
export const repositoryMatchKey = (canonical: string): string | undefined => {
  const schemeEnd = canonical.indexOf("://");
  if (schemeEnd <= 0) return undefined;
  const scheme = canonical.slice(0, schemeEnd).toLowerCase();
  const rest = canonical.slice(schemeEnd + 3);
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  const authority = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (!path) return undefined;
  const at = authority.lastIndexOf("@");
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  let host: string;
  let port = "";
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return undefined;
    host = hostPort.slice(1, close);
    port = hostPort.slice(close + 1).replace(/^:/, "");
  } else {
    const colon = hostPort.lastIndexOf(":");
    if (colon >= 0) { host = hostPort.slice(0, colon); port = hostPort.slice(colon + 1); } else host = hostPort;
  }
  if (!host) return undefined;
  host = host.toLowerCase();
  // A non-default http(s) port is part of the key and only matches http(s) on
  // the same host and port; every other transport collapses to host + path.
  if ((scheme === "http" || scheme === "https") && port) return JSON.stringify(["http-port", host, port, path]);
  return JSON.stringify(["host-path", host, path]);
};

export const remoteTrackingReachable = (worktreePath: string, oid: string, remoteNames: string[]): boolean => {
  if (typeof worktreePath !== "string") throw validation("worktree", "must be a string");
  if (typeof oid !== "string") throw validation("baseline", "must be a string");
  if (!Array.isArray(remoteNames) || remoteNames.some((name) => typeof name !== "string" || !name || name.includes("\0"))) throw validation("remote", "remote names must be non-empty strings");
  const plain = plainOID(oid);
  for (const name of remoteNames) {
    // A failed Git inspection is an operational error, not evidence that the
    // baseline is merely unpublished.  Propagating it keeps the CLI from
    // silently weakening the baseline guarantee when Git itself is broken.
    try {
      if (gitText(worktreePath, ["for-each-ref", "--format=%(refname:short)", "--contains", plain, `refs/remotes/${name}`]).trim()) return true;
    } catch {
      throw baselineUnavailable("Git could not inspect remote-tracking references");
    }
  }
  return false;
};

const plainOID = (qualified: string): string => {
  if (!isGitOID(qualified)) throw baselineUnavailable("baseline must be an algorithm-prefixed Git object ID");
  return qualified.slice(qualified.indexOf(":") + 1);
};

const canBackquote = (value: string): boolean => {
  if (value.includes("`")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // A BOM is invisible and must be quoted even though it is otherwise valid
    // UTF-8 text.
    if (code === 0xfeff) return false;
    if (code === 0x0a || code === 0x0d || code === 0x7f || (code < 0x20 && code !== 0x09)) return false;
  }
  return true;
};

const hexByte = (value: number): string => value.toString(16).padStart(2, "0");
const hexWord = (value: number, width: number): string => value.toString(16).padStart(width, "0");

// Escape rare paths that cannot be represented as readable text. Invalid UTF-8
// is escaped byte-by-byte so the display snapshot remains faithful to Git's
// raw path bytes.
const quoteToASCII = (value: Buffer): string => {
  let output = '"';
  for (let index = 0; index < value.length;) {
    const byte = value[index];
    if (byte < 0x80) {
      if (byte === 0x08) output += "\\b";
      else if (byte === 0x09) output += "\\t";
      else if (byte === 0x0a) output += "\\n";
      else if (byte === 0x0c) output += "\\f";
      else if (byte === 0x0d) output += "\\r";
      else if (byte === 0x07) output += "\\a";
      else if (byte === 0x0b) output += "\\v";
      else if (byte < 0x20 || byte === 0x7f) output += `\\x${hexByte(byte)}`;
      else if (byte === 0x5c) output += "\\\\";
      else if (byte === 0x22) output += '\\"';
      else output += String.fromCharCode(byte);
      index += 1;
      continue;
    }
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 0;
    let codePoint = 0;
    let valid = length > 0 && index + length <= value.length;
    if (valid) {
      const first = byte & (length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07);
      codePoint = first;
      for (let offset = 1; offset < length; offset += 1) {
        const continuation = value[index + offset];
        if ((continuation & 0xc0) !== 0x80) { valid = false; break; }
        codePoint = (codePoint << 6) | (continuation & 0x3f);
      }
      if (codePoint < (length === 2 ? 0x80 : length === 3 ? 0x800 : 0x10000) || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) valid = false;
    }
    if (!valid) { output += `\\x${hexByte(byte)}`; index += 1; continue; }
    output += codePoint <= 0xffff ? `\\u${hexWord(codePoint, 4)}` : `\\U${hexWord(codePoint, 8)}`;
    index += length;
  }
  return `${output}"`;
};

const displayPath = (value: Buffer): string => {
  const text = value.toString("utf8");
  if (Buffer.from(text, "utf8").equals(value) && value.length <= 4096 && canBackquote(text)) return text;
  return quoteToASCII(value);
};

const parseModeRecords = (output: Buffer, kind: "tree" | "index"): Map<string, string> => {
  const modes = new Map<string, string>();
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0x00, offset);
    const recordEnd = end < 0 ? output.length : end;
    const record = output.subarray(offset, recordEnd);
    offset = end < 0 ? output.length : end + 1;
    if (!record.length) continue;
    const tab = record.indexOf(0x09);
    if (tab < 6) throw new Error(`malformed Git ${kind} mode record`);
    const mode = record.subarray(0, 6).toString("ascii");
    if (!/^\d{6}$/.test(mode)) throw new Error(`invalid Git ${kind} mode ${mode}`);
    const path = record.subarray(tab + 1);
    if (!path.length || path.includes(0)) throw new Error(`invalid Git ${kind} mode path`);
    // An unmerged index may contain several stages for one path.  The
    // temporary capture index is expected to be resolved, but retaining the
    // first record makes this parser deterministic if Git ever reports more
    // than one entry.
    const key = path.toString("hex");
    if (!modes.has(key)) modes.set(key, mode);
  }
  return modes;
};

type ProjectionGit = (cwd: string, args: string[], indexPath?: string) => Buffer;
const treeModes = (root: string, baseline: string, runner: ProjectionGit = git): Map<string, string> => parseModeRecords(runner(root, ["ls-tree", "-r", "-z", baseline]), "tree");
const indexModes = (root: string, indexPath: string, runner: ProjectionGit = git): Map<string, string> => parseModeRecords(runner(root, ["ls-files", "-s", "-z"], indexPath), "index");

const manifest = (root: string, baseline: string, indexPath: string, runner: ProjectionGit = git, canonical = false): CandidateFile[] => {
  const tokens = runner(root, canonical ? [...CANONICAL_DIFF_CONFIG, "diff", "--cached", "--name-status", "-z", ...CANONICAL_DIFF_FLAGS, baseline, "--"] : ["diff", "--cached", "--name-status", "-z", "--no-ext-diff", "--find-renames=50%", "--find-copies=50%", baseline], indexPath).toString("latin1").split("\0").filter((token, index, all) => !(index === all.length - 1 && token === ""));
  // Resolve modes from NUL-delimited Git listings rather than passing a
  // decoded JavaScript string as a path argument.  Git paths are arbitrary
  // bytes; UTF-8 conversion would change non-UTF-8 names and make the mode
  // (and therefore the immutable manifest) wrong.
  const baselineModes = treeModes(root, baseline, runner);
  const capturedModes = indexModes(root, indexPath, runner);
  const files: CandidateFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const change = ({ A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type_changed" } as Record<string, string>)[status[0]];
    if (!change || index >= tokens.length) throw new Error(`unsupported Git manifest status ${status}`);
    let oldPath: Buffer | undefined;
    if (status.startsWith("R") || status.startsWith("C")) oldPath = Buffer.from(tokens[index++], "latin1");
    const pathBytes = Buffer.from(tokens[index++], "latin1");
    const file: CandidateFile = { path_bytes: pathBytes.toString("base64"), display_path: displayPath(pathBytes), change };
    if (oldPath) file.old_path_bytes = oldPath.toString("base64");
    if (change !== "added") file.old_mode = baselineModes.get((oldPath ?? pathBytes).toString("hex"));
    if (change !== "deleted") file.new_mode = capturedModes.get(pathBytes.toString("hex"));
    if (Buffer.byteLength(file.display_path, "utf8") > 4096) throw new DomainError("ARTIFACT_TOO_LARGE", "Candidate file display path exceeds 4096 bytes", false, { reason: "file display path cannot fit the versioned Candidate contract" });
    files.push(file);
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path_bytes, "base64"), Buffer.from(right.path_bytes, "base64")));
  return files;
};

// Versioned rules for grounds.canonical-git-diff/v1. Legacy SQL projections
// retain their original generator and are deliberately not routed through here.
const CANONICAL_DIFF_CONFIG = [
  "-c", "core.quotePath=true", "-c", "core.attributesFile=/dev/null",
  "-c", "diff.renameLimit=1000", "-c", "diff.suppressBlankEmpty=false",
  "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false",
  "-c", "diff.relative=false", "-c", "diff.submodule=short",
];
const CANONICAL_DIFF_FLAGS = [
  "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color",
  "--diff-algorithm=myers", "--no-indent-heuristic", "--unified=3", "--inter-hunk-context=0",
  "--src-prefix=a/", "--dst-prefix=b/", "--line-prefix=", "--no-relative",
  "--find-renames=50%", "--find-copies=50%", "-l1000", "--submodule=short",
];
const canonicalProjectionGit: ProjectionGit = (cwd, args, indexPath) => runGitWithEnv(cwd,
  ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", ...args],
  { ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith("GIT_")).map(key => [key, undefined])),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}),
  }, 30_000);

/** Rebuild fixed objects with canonical rules, independent of clone config and active files.
 * A caller may supply its safe, bounded runner; it must disable global/system config,
 * replacement objects, lazy fetch and inherited Git environment just like the default.
 */
export const captureCommittedArtifact = (repositoryPath: string, baselineOID: string, sourceOID: string, runner: ProjectionGit = canonicalProjectionGit): CandidateArtifact => {
  const baseline = plainOID(baselineOID), source = plainOID(sourceOID);
  for (const commit of [baseline, source]) {
    const fixedPaths = runner(repositoryPath, ["ls-tree", "-r", "--name-only", "-z", commit, "--", ".grounds"]).toString("utf8").split("\0");
    if (fixedPaths.some(isPrivateGroundsPath)) throw worktreeMismatch("", "Candidate source or base tracks private Grounds runtime files");
  }
  if (baselineOID.split(":")[0] !== sourceOID.split(":")[0]) throw validation("source", "base and source must use the same object format");
  const objects = runner(repositoryPath, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]).toString("utf8").trim();
  if (/[\r\n]/.test(objects)) throw validation("repository", "object directory cannot be represented safely as a Git alternate");
  const temporary = mkdtempSync(join(tmpdir(), "grounds-commit-index-"));
  const indexPath = join(temporary, "capture-index");
  try {
    // A private bare repository sees only attributes from the fixed source index,
    // never the author's working tree or .git/info/attributes. No source object is
    // copied or written, and there is no remote/promisor to fetch from implicitly.
    runner(temporary, ["init", "--bare", "--template=", `--object-format=${sourceOID.startsWith("sha256:") ? "sha256" : "sha1"}`, "."]);
    writeFileSync(join(temporary, "objects", "info", "alternates"), objects + "\n", { mode: 0o600 });
    runner(temporary, ["read-tree", source], indexPath);
    const patch = runner(temporary, [...CANONICAL_DIFF_CONFIG, "diff", "--cached", ...CANONICAL_DIFF_FLAGS, baseline, "--"], indexPath);
    if (patch.length > 32 * 1024 * 1024) throw new DomainError("ARTIFACT_TOO_LARGE", "Candidate projection exceeds 32 MiB");
    const result_tree_oid = qualifiedOID(sourceOID.startsWith("sha256:") ? "sha256" : "sha1", runner(temporary, ["rev-parse", `${source}^{tree}`]).toString("utf8").trim());
    return { patch, patch_digest: sha256Bytes(patch), result_tree_oid, uncompressed_size: patch.length, files: manifest(temporary, baseline, indexPath, runner, true) };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
};

export const captureArtifact = (worktreePath: string, baselineOID: string, externalWorkspace = false): CandidateArtifact => {
  if (typeof worktreePath !== "string") throw validation("worktree", "must be a string");
  if (typeof baselineOID !== "string") throw validation("baseline", "must be a string");
  const root = discoverRepository(worktreePath).root;
  assertNoTrackedGroundsRuntime(root);
  let workspaceIgnored = false;
  try { git(root, ["check-ignore", "-q", "--no-index", ".grounds/.capture-probe"]); workspaceIgnored = true; } catch { /* reported below */ }
  if (!workspaceIgnored && !externalWorkspace) throw worktreeMismatch("", ".grounds must be ignored before Candidate capture");
  const baseline = plainOID(baselineOID);
  const sparse = (() => { try { return gitText(root, ["config", "--bool", "core.sparseCheckout"]).trim() === "true"; } catch { return false; } })();
  if (sparse) throw worktreeMismatch("", "sparse checkout is not supported for Candidate capture");
  assertCapturableSubmodules(root, baseline, git);
  const temporary = mkdtempSync(join(tmpdir(), "grounds-index-"));
  const indexPath = join(temporary, "index");
  try {
    try { git(root, ["read-tree", baseline], indexPath); }
    catch { throw baselineUnavailable("Git could not load the Issue baseline into the capture index"); }
    try {
      if (externalWorkspace && !workspaceIgnored) {
        const names = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], indexPath);
        const parts: Buffer[] = []; let start = 0;
        for (let n = 0; n < names.length; n++) if (names[n] === 0) {
          const name = names.subarray(start, n); start = n + 1;
          if (!name.length || isPrivateGroundsPath(name.toString("utf8"))) continue;
          parts.push(Buffer.from(":(literal)"), name, Buffer.from([0]));
        }
        const paths = join(temporary, "paths"); writeFileSync(paths, Buffer.concat(parts), { mode: 0o600 });
        git(root, ["add", "-A", "--pathspec-from-file=" + paths, "--pathspec-file-nul"], indexPath);
      } else git(root, ["add", "-A"], indexPath);
    } catch { throw worktreeMismatch("", "Git could not stage the current worktree for Candidate capture"); }
    let tree: string;
    let algorithm: string;
    let patch: Buffer;
    try {
      tree = gitText(root, ["write-tree"], indexPath).trim();
      algorithm = gitText(root, ["rev-parse", "--show-object-format"]).trim();
      // Pin Git path quoting so Change Index section/path reconciliation is
      // deterministic and cannot vary with a developer's core.quotePath.
      patch = git(root, ["-c", "core.quotePath=true", "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--find-renames=50%", "--find-copies=50%", baseline], indexPath);
    } catch { throw worktreeMismatch("", "Git could not construct the Candidate artifact"); }
    let resultTreeOID: string;
    try { resultTreeOID = qualifiedOID(algorithm, tree); }
    catch { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Git returned an invalid Candidate result tree", false, { reason: "Git write-tree returned an invalid object ID" }); }
    if (patch.length > 32 * 1024 * 1024) throw new DomainError("ARTIFACT_TOO_LARGE", "Candidate patch exceeds 32 MiB", false, { reason: "uncompressed patch exceeds 32 MiB" });
    let files: CandidateFile[];
    try { files = manifest(root, baseline, indexPath); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Git returned an invalid Candidate file manifest", false, { reason: "the captured Git manifest could not be decoded" });
    }
    if (files.some((file) => [file.path_bytes, file.old_path_bytes].some(path => path !== undefined && isPrivateGroundsPath(Buffer.from(path, "base64").toString("utf8"))))) throw worktreeMismatch("", ".grounds would be included in the Candidate artifact");
    return { patch, patch_digest: sha256Bytes(patch), result_tree_oid: resultTreeOID, uncompressed_size: patch.length, files };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

export const materializeArtifact = (worktreePath: string, baselineOID: string, patch: Buffer, expectedTreeOID: string): void => {
  throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "Base-plus-patch restoration is unsupported; materialize a fixed Git Candidate commit");
};

export const createBaselineWorktree = (sourcePath: string, targetPath: string, baselineOID: string): string => {
  if (typeof sourcePath !== "string") throw validation("source_path", "must be a string");
  if (typeof targetPath !== "string") throw validation("path", "must be a string");
  if (typeof baselineOID !== "string") throw validation("baseline", "must be a string");
  if (!targetPath || !targetPath.trim()) throw validation("path", "must not be empty");
  const target = resolve(targetPath);
  if ([...target].length > 32768) throw validation("path", "must not exceed 32768 characters");
  try {
    lstatSync(target);
    throw validation("path", "must not already exist when creating a worktree");
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
  }
  const source = discoverRepository(sourcePath).root;
  const baseline = plainOID(baselineOID);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    git(source, ["worktree", "add", "--detach", target, baseline]);
  } catch (error) {
    throw worktreeMismatch("", `Git could not create a detached worktree at the Issue baseline${error instanceof Error ? `: ${error.message}` : ""}`);
  }
  return target;
};

export const materializeCandidateWorktree = (options: MaterializeWorktreeOptions): MaterializedWorktree => {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw validation("options", "must be an object");
  if (typeof options.source_path !== "string") throw validation("source_path", "must be a string");
  if (typeof options.target_path !== "string") throw validation("path", "must be a string");
  if (typeof options.baseline_oid !== "string") throw validation("baseline", "must be a string");
  if (!options.source_commit) throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "Candidate restoration requires a fixed Git source commit");
  if (!isGitOID(options.source_commit)) throw validation("source_commit", "requires a qualified Git OID");
  if (typeof options.expected_tree_oid !== "string") throw validation("result_tree_oid", "must be a string");
  if (options.branch !== undefined && typeof options.branch !== "string") throw validation("branch", "must be a string");
  if (options.review_marker !== undefined && options.mode !== "review") throw validation("review_marker", "is only valid in review mode");
  if (!(["existing", "review", "delivery"] as string[]).includes(options.mode)) throw validation("mode", "must be existing, review, or delivery");
  if (!options.target_path || !options.target_path.trim()) throw validation("path", "must not be empty");
  // target_path is part of the command-result contract for every
  // materialization mode, including an existing worktree. Validate before
  // resolving or touching Git so an oversized path cannot turn into an
  // operating-system error (or an overlong result envelope).
  if ([...options.target_path].length > 32768) throw validation("path", "must not exceed 32768 characters");
  const target = resolve(options.target_path);
  if ([...target].length > 32768) throw validation("path", "must not exceed 32768 characters");
  if (options.mode === "delivery") {
    if (!options.branch) throw validation("branch", "is required in delivery mode");
    if ([...options.branch].length > 1024) throw validation("branch", "must not exceed 1024 characters");
    if (Buffer.from(options.branch, "utf8").toString("utf8") !== options.branch) throw validation("branch", "must be valid UTF-8 text");
  } else if (options.branch !== undefined) {
    throw validation("branch", "is only valid in delivery mode");
  }
  if (options.mode === "existing") {
    if (resolveBaseline(target, "HEAD") !== options.source_commit || git(target, ["status", "--porcelain=v1", "-z"]).length || qualifiedOID(options.source_commit.split(":")[0], gitText(target, ["rev-parse", "HEAD^{tree}"]).trim()) !== options.expected_tree_oid) throw worktreeMismatch("", "existing worktree differs from the fixed Git Candidate; preserve it");
    return { target_path: target, mode: options.mode };
  }
  try {
    // lstat, unlike existsSync, also sees dangling symlinks.  A delivery or
    // review worktree must never replace an existing filesystem entry.
    lstatSync(target);
    throw validation("path", "must not already exist when creating a worktree");
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
  }
  if (options.mode === "review" && options.branch !== undefined) throw validation("branch", "is only valid in delivery mode");
  const source = discoverRepository(options.source_path).root;
  const baseline = plainOID(options.source_commit);
  if (captureCommittedArtifact(source, options.baseline_oid, options.source_commit).result_tree_oid !== options.expected_tree_oid) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "fixed Candidate source tree differs from recorded tree");
  if (options.mode === "delivery") {
    try { git(source, ["check-ref-format", "--branch", options.branch!]); }
    catch { throw validation("branch", "is not a valid Git branch name"); }
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const worktreeArguments = options.mode === "review"
    ? ["worktree", "add", "--detach", target, baseline]
    : ["worktree", "add", "-b", options.branch!, target, baseline];
  try { git(source, worktreeArguments); }
  catch { throw worktreeMismatch("", "Git could not create the requested worktree from the Candidate baseline"); }

  let materialized = false;
  try {
    if (resolveBaseline(target, "HEAD") !== options.source_commit || git(target, ["status", "--porcelain=v1", "-z"]).length || qualifiedOID(options.source_commit.split(":")[0], gitText(target, ["rev-parse", "HEAD^{tree}"]).trim()) !== options.expected_tree_oid) throw worktreeMismatch("", "existing worktree differs from the fixed Git Candidate; preserve it");
    if (options.review_marker) writeReviewWorktreeMarker(target, options.review_marker);
    materialized = true;
    return { target_path: target, mode: options.mode, ...(options.branch ? { branch: options.branch } : {}) };
  } finally {
    if (!materialized) {
      try { git(source, ["worktree", "remove", "--force", target]); } catch { /* best-effort cleanup of only the worktree created above */ }
      if (options.mode === "delivery") {
        try { git(source, ["branch", "-D", options.branch!]); } catch { /* the branch was created by this operation */ }
      }
    }
  }
};

export interface TreeDiff {
  patch: Buffer;
  files: number;
  insertions: number;
  deletions: number;
  binary: boolean;
  too_large: boolean;
}

const comparisonIntegrityError = (reason: string): never => {
  throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Git returned invalid Candidate comparison statistics", false, { reason });
};

export const diffTrees = (worktreePath: string, leftTreeOID: string, rightTreeOID: string): TreeDiff => {
  if (typeof worktreePath !== "string") throw validation("worktree", "must be a string");
  if (typeof leftTreeOID !== "string") throw validation("left_tree_oid", "must be a string");
  if (typeof rightTreeOID !== "string") throw validation("right_tree_oid", "must be a string");
  const root = discoverRepository(worktreePath).root;
  const left = plainOID(leftTreeOID);
  const right = plainOID(rightTreeOID);
  try {
    git(root, ["cat-file", "-e", `${left}^{tree}`]);
    git(root, ["cat-file", "-e", `${right}^{tree}`]);
  } catch {
    throw baselineUnavailable("one of the Candidate result trees is unavailable");
  }
  let rawPatch: Buffer;
  let numstat: Buffer;
  try {
    rawPatch = git(root, ["diff", "--binary", "--full-index", "--no-ext-diff", "--find-renames=50%", "--find-copies=50%", left, right]);
    numstat = git(root, ["diff", "--numstat", "-z", "--no-ext-diff", "--find-renames=50%", "--find-copies=50%", left, right]);
  } catch { throw baselineUnavailable("Git could not compare the Candidate result trees"); }
  const tooLarge = rawPatch.length > 32 * 1024 * 1024;
  const tokens = numstat.toString("latin1").split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  let files = 0; let insertions = 0; let deletions = 0; let binary = false;
  for (let index = 0; index < tokens.length;) {
    const record = tokens[index++];
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) comparisonIntegrityError("malformed Git numstat record");
    const added = record.slice(0, firstTab);
    const removed = record.slice(firstTab + 1, secondTab);
    if (added === "-" || removed === "-") binary = true;
    else {
      if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) comparisonIntegrityError("invalid Git numstat count");
      const addedCount = Number(added); const removedCount = Number(removed);
      if (!Number.isSafeInteger(addedCount) || !Number.isSafeInteger(removedCount)) comparisonIntegrityError("invalid Git numstat count");
      if (insertions > Number.MAX_SAFE_INTEGER - addedCount || deletions > Number.MAX_SAFE_INTEGER - removedCount) throw new DomainError("ARTIFACT_TOO_LARGE", "Git diff statistics exceed the safe integer range");
      insertions += addedCount; deletions += removedCount;
    }
    files += 1;
    // A rename/copy record has an empty path suffix followed by old and new
    // path tokens.  A normal record keeps its destination in the suffix;
    // tabs inside that raw path are therefore harmless.
    if (record.slice(secondTab + 1).length === 0) {
      if (index + 1 >= tokens.length) comparisonIntegrityError("malformed Git numstat rename record");
      index += 2;
    }
  }
  // Do not retain a patch that cannot be returned through the versioned
  // comparison contract.  The tree pair itself remains the stable digest
  // input, and the numstat pass above still supplies complete statistics.
  return { patch: tooLarge ? Buffer.alloc(0) : rawPatch, files, insertions, deletions, binary, too_large: tooLarge };
};
