import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { captureArtifact, discoverRepository, resolveBaseline } from "./git.js";
import { credentialMaterialPath } from "./credential-material.js";
import { sha256 } from "./canonical-json.js";
import { atomicPrivateWrite, safeRead, overlaps } from "./runtime-files.js";
import { trustedGit } from "./frozen-checkout.js";
import { runtimeError } from "./runtime-record.js";
import { DomainError, validation } from "./errors.js";
import type { Store } from "./store-types.js";

export interface ExternalWorkspaceInput {
  directory: string;
  identity: string;
  baseline_oid: string;
  input_digest: string;
  result_tree_oid: string;
  changes: string[];
  dirty: boolean;
}
export function workspaceIdentity(directory: string): string {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) throw validation("workspace", "a canonical real Git root is required");
  return `${stat.dev}:${stat.ino}`;
}
export function previewExternalWorkspace(path: string, baseline: string, remote: string): ExternalWorkspaceInput {
  const directory = resolve(path), identity = workspaceIdentity(directory), repo = discoverRepository(directory);
  if (repo.root !== directory || !repo.remotes.some(r => r.canonical === remote)) throw validation("workspace", "Repository identity or Git root mismatch");
  if (resolveBaseline(directory, "HEAD") !== baseline) throw validation("workspace", "HEAD must equal the sealed Baseline");
  const status = trustedGit(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false);
  const paths: string[] = [];
  const entries = status.split("\0").filter(Boolean);
  for (let n = 0; n < entries.length; n++) {
    const entry = entries[n]; paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") paths.push(entries[++n]);
  }
  for (const path of paths) {
    const full = resolve(directory, path);
    if (!full.startsWith(directory + sep) || credentialMaterialPath(path)) throw validation("workspace", "unsafe or credential input path");
    try {
      const stat = lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || !realpathSync(full).startsWith(directory + sep)) throw validation("workspace", "special files and path escapes cannot be adopted");
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  const artifact = captureArtifact(directory, baseline, true);
  if (workspaceIdentity(directory) !== identity || trustedGit(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false) !== status || captureArtifact(directory, baseline, true).result_tree_oid !== artifact.result_tree_oid) throw runtimeError("workspace changed during input capture", undefined, "material_conflict");
  const changes = [...new Set([...paths, ...artifact.files.map(f => Buffer.from(f.path_bytes, "base64").toString())])].sort();
  if (changes.length > 65536 || Buffer.byteLength(JSON.stringify(changes)) > 512 * 1024) throw validation("workspace", "input path inventory exceeds 512 KiB or 65536 paths");
  if (changes.some(credentialMaterialPath)) throw validation("workspace", "known credential material cannot be adopted");
  return { directory, identity, baseline_oid: baseline, result_tree_oid: artifact.result_tree_oid, changes, dirty: !!status,
    input_digest: sha256({ directory, identity, baseline, tree: artifact.result_tree_oid, patch: artifact.patch_digest, status }) };
}
/** Reject external mutation around capture; no claim of locking an outside editor. */
export function captureWorkspaceArtifact(directory: string, baseline: string, remote: string) {
  const before = previewExternalWorkspace(directory, baseline, remote);
  const artifact = captureArtifact(directory, baseline, true);
  const after = previewExternalWorkspace(directory, baseline, remote);
  if (before.input_digest !== after.input_digest || artifact.result_tree_oid !== before.result_tree_oid) throw runtimeError("external workspace changed during Candidate capture", undefined, "material_conflict");
  return artifact;
}

export interface WorkspaceLease { ownership?: "managed" | "external"; database: string; run: string; directory: string; identity: string; input_digest: string; initial_changes?: string[]; result_tree_oid?: string }
export async function workspaceLeases(store: Store | undefined, database: string, root: string): Promise<Record<string, WorkspaceLease>> {
  const path = join(root, "workspace-registry.json");
  const leases: Record<string, WorkspaceLease> = existsSync(path) ? JSON.parse(safeRead(path, 1024 * 1024).toString()) : {};
  if (!leases || typeof leases !== "object" || Array.isArray(leases)) throw runtimeError("invalid workspace registry");
  for (const [key, value] of Object.entries(leases)) {
    if (value?.ownership !== undefined && !["managed", "external"].includes(value.ownership)) throw runtimeError("invalid workspace ownership");
    if (!value || value.run !== key || typeof value.database !== "string" || typeof value.directory !== "string" || typeof value.identity !== "string" || typeof value.input_digest !== "string") throw runtimeError("invalid workspace lease");
    if (!store || value.database !== database) continue;
    try { await store.read(tx => tx.getDevRun(key)); }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") throw error;
      delete leases[key]; // Caller holds directory-registry through SQL publication.
    }
  }
  atomicPrivateWrite(path, JSON.stringify(leases));
  return leases;
}
export async function checkWorkspaceReservation(store: Store, database: string, root: string, directory: string, run?: string): Promise<void> {
  const leases = await workspaceLeases(store, database, root);
  if (Object.values(leases).some(l => overlaps(l.directory, directory) && !(l.database === database && l.run === run && l.directory === directory))) throw runtimeError("workspace already has an active or unrecovered DevRun", undefined, "busy");
}
