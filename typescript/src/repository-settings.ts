import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import type { Tx } from "./store-types.js";
import type { RuntimeRecord } from "./runtime-record.js";

export type RepositorySetting = "archive-binding" | "environment-default";
const format = (setting: RepositorySetting) => `grounds.repository-${setting}/v1`;

/** Stable internal singleton keys: preserve the repository UUID timestamp and
 * derive the remaining bits from its identity and setting namespace. These are
 * storage addresses, not new public entities or creation timestamps. */
export function repositorySettingID(repositoryID: string, setting: RepositorySetting): string {
  const bytes = createHash("sha256").update(`grounds.repository-setting/v1:${setting}:${repositoryID}`).digest().subarray(0, 16);
  Buffer.from(repositoryID.replaceAll("-", ""), "hex").copy(bytes, 0, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Keep historical singleton records at their original key. Never migrate or
 * overwrite the other setting; reject ambiguous or foreign records. */
export async function repositorySetting(tx: Tx, repositoryID: string, setting: RepositorySetting): Promise<RuntimeRecord | undefined> {
  const current = await tx.getRuntimeRecord("runtime_operation", repositorySettingID(repositoryID, setting));
  const legacy = await tx.getRuntimeRecord("runtime_operation", repositoryID);
  const invalid = () => new DomainError("ARTIFACT_INTEGRITY_ERROR", "Repository setting has invalid ownership, format or duplicate identities");
  if (current && (current.data.format !== format(setting) || current.data.repository_id !== repositoryID || current.parent_id !== repositoryID)) throw invalid();
  if (legacy && (legacy.data.repository_id !== repositoryID
    || ![format("archive-binding"), format("environment-default")].includes(String(legacy.data.format))
    || (legacy.data.format === format("archive-binding") ? legacy.parent_id !== repositoryID : legacy.parent_id !== undefined))) throw invalid();
  if (legacy?.data.format === format(setting)) {
    if (current) throw invalid();
    return legacy;
  }
  return current;
}
