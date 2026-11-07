import type { Attribution } from "./domain.js";
import { validateAttribution } from "./domain.js";
import { isUUIDv7, isSha256 } from "./identity.js";
import { validation } from "./errors.js";

export interface DeliveryUnit {
  change_unit_id: string;
  path: string;
  candidate_start: number;
  commit_start: number;
  lines: number;
}
export interface DeliveryProof {
  candidate_id: string;
  repository_id: string;
  commit_oid: string;
  parent_oid: string;
  patch_digest: string;
  method: "raw-double-sided/v1";
  content: "exact_artifact" | "exact_scope";
  units: DeliveryUnit[];
}
export interface DeliveryLink extends DeliveryProof {
  id: string;
  version: number;
  state: "recorded" | "withdrawn";
  updated_at: string;
  attribution: Attribution;
  reason?: string;
}
export function validateDeliveryLink(link: DeliveryLink): void {
  const keys = ["candidate_id", "repository_id", "commit_oid", "parent_oid", "patch_digest", "method", "content", "units", "id", "version", "state", "updated_at", "attribution", "reason"];
  if (!link || typeof link !== "object" || Object.keys(link).some(k => !keys.includes(k))) throw validation("proof", "invalid delivery proof fields");
  if (!isUUIDv7(link.candidate_id) || !isUUIDv7(link.repository_id) || !isSha256(link.patch_digest)) throw validation("proof", "invalid Candidate, Repository or artifact identity");
  if (![link.commit_oid, link.parent_oid].every(s => typeof s === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s)) || link.parent_oid === link.commit_oid || link.parent_oid.length !== link.commit_oid.length) throw validation("proof", "invalid commit/parent OIDs");
  if (link.method !== "raw-double-sided/v1" || !["exact_artifact", "exact_scope"].includes(link.content)) throw validation("proof", "unsupported comparison method or content status");
  if (!Array.isArray(link.units) || !link.units.length || link.units.length > 10000 || new Set(link.units.map(u => u?.change_unit_id)).size !== link.units.length) throw validation("proof.units", "requires distinct matched units");
  for (const unit of link.units) {
    if (!unit || Object.keys(unit).sort().join() !== "candidate_start,change_unit_id,commit_start,lines,path" || !isSha256(unit.change_unit_id) || typeof unit.path !== "string" || !unit.path || unit.path.length > 4096 || unit.path.startsWith("/") || unit.path.split("/").includes("..") || unit.path.includes("\0")) throw validation("proof.units", "invalid Change Unit or path");
    if (![unit.candidate_start, unit.commit_start, unit.lines].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647) || (unit.lines > 0 && (unit.candidate_start < 1 || unit.commit_start < 1))) throw validation("proof.units", "invalid mapped range");
  }

  if (!isUUIDv7(link.id) || !Number.isSafeInteger(link.version) || link.version < 1 || link.version > 2147483647 || !["recorded", "withdrawn"].includes(link.state)) throw validation("delivery_link", "invalid identity, version or state");
  validateAttribution(link.attribution);
  if (typeof link.updated_at !== "string" || !link.updated_at.endsWith("Z") || !Number.isFinite(Date.parse(link.updated_at))) throw validation("delivery_link", "invalid timestamp");
  if ((link.reason !== undefined && (typeof link.reason !== "string" || link.reason.length > 4096)) || (link.state === "withdrawn" && !link.reason?.trim())) throw validation("delivery_link", "invalid withdrawal reason");
}
