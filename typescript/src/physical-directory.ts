import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { sha256 } from "./canonical-json.js";
import { atomicPrivateWrite, overlaps, safeRead } from "./runtime-files.js";
import { runtimeError } from "./runtime-record.js";

/** Host-local ownership, not a ledger projection. Missing owners never expire a claim.
 * Every read/check/write below requires the shared directory-registry mutex.
 * Environment controllers take their root mutex BEFORE that mutex; readers never
 * acquire an environment controller lock or contact its ledger.
 */
export interface PhysicalDirectoryClaim {
  kind: "environment" | "sync";
  owner: string;
  id: string;
  directory: string;
  identity: string;
}
const file = (root: string) => join(root, "physical-directory-registry.json");
const key = (claim: PhysicalDirectoryClaim) => sha256([claim.kind, claim.owner, claim.id]);
export function physicalIdentity(directory: string): string {
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory)
    throw runtimeError("physical directory must be a canonical real directory");
  return `${stat.dev}:${stat.ino}`;
}
export function physicalClaims(root: string): Record<string, PhysicalDirectoryClaim> {
  const claims = existsSync(file(root)) ? JSON.parse(safeRead(file(root), 1024 * 1024).toString()) : {};
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw runtimeError("invalid physical directory registry");
  for (const [id, c] of Object.entries(claims) as [string, PhysicalDirectoryClaim][]) {
    if (!c || !["environment", "sync"].includes(c.kind) || typeof c.owner !== "string" || !c.owner ||
      typeof c.id !== "string" || !c.id || typeof c.directory !== "string" || !isAbsolute(c.directory) ||
      resolve(c.directory) !== c.directory || typeof c.identity !== "string" || !/^\d+:\d+$/.test(c.identity) || key(c) !== id)
      throw runtimeError("invalid physical directory claim");
  }
  return claims;
}
export function assertPhysicalDirectoryFree(directory: string, root: string, except?: PhysicalDirectoryClaim, kinds: readonly PhysicalDirectoryClaim["kind"][] = ["environment", "sync"]): void {
  const identity = existsSync(directory) ? physicalIdentity(directory) : undefined;
  for (const c of Object.values(physicalClaims(root))) {
    if (!kinds.includes(c.kind)) continue;
    if (except && key(c) === key(except) && sha256(c) === sha256(except)) continue;
    if (overlaps(c.directory, directory) || c.identity === identity)
      throw runtimeError(`directory has a persistent environment lease or pending sync (${c.kind} ${c.id}, owner ${c.owner}); explicitly release or recover its owner`, c.id, "busy");
  }
}
export function reservePhysicalDirectory(root: string, claim: PhysicalDirectoryClaim): void {
  if (physicalIdentity(claim.directory) !== claim.identity) throw runtimeError("physical directory identity changed");
  const claims = physicalClaims(root), old = claims[key(claim)];
  if (old && sha256(old) !== sha256(claim)) throw runtimeError("physical reservation identity changed");
  assertPhysicalDirectoryFree(claim.directory, root, claim);
  claims[key(claim)] = claim;
  const bytes = JSON.stringify(claims);
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw runtimeError("physical directory registry is full; explicitly release completed owners");
  atomicPrivateWrite(file(root), bytes);
}
/** Only a controller with authoritative terminal evidence may call this. */
export function releasePhysicalDirectory(root: string, claim: PhysicalDirectoryClaim): void {
  const claims = physicalClaims(root), old = claims[key(claim)];
  if (!old) return;
  if (sha256(old) !== sha256(claim)) throw runtimeError("physical reservation identity changed; retain occupancy");
  delete claims[key(claim)];
  atomicPrivateWrite(file(root), JSON.stringify(claims));
}
