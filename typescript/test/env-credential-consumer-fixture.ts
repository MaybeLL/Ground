/** Test fixture for a credential consumer using the public environment API. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { acquireCredentialSourceLocks } from "../src/env-credentials.js";

interface Reference { environment_id: string; name: string; source_file: string; state: string }
export interface BlockingReference { environment_id: string; name: string; state: string }
export type CredentialSourceDecision = {
  action: "check" | "logout";
  status: "blocked" | "ready" | "logged_out";
  reason?: "unfinished_environments" | "source_changed";
  blockers: BlockingReference[];
};
const invalidOccupancy = () => Error("credential occupancy response is invalid; retain authentication source");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** All names and environments referring to this source participate. A name is
 * a declaration label, never the authentication source's ownership identity.
 */
export const blockingCredentialReferences = (receipt: unknown, canonicalSource: string): BlockingReference[] => {
  if (!isAbsolute(canonicalSource) || !object(receipt) || receipt.ok !== true || !object(receipt.data)) throw invalidOccupancy();
  const data = receipt.data;
  if (data.result_type !== "grounds.result.environment/v1" || data.command !== "env.credential-occupancy" || !Array.isArray(data.occupancy)) throw invalidOccupancy();
  const rows: Reference[] = data.occupancy.map(entry => {
    if (!object(entry) || ["environment_id", "name", "source_file", "state"].some(key => typeof entry[key] !== "string" || entry[key].length === 0) || !isAbsolute(String(entry.source_file))) throw invalidOccupancy();
    return entry as unknown as Reference;
  });
  // The public endpoint lists unfinished instances. Unknown future state labels
  // therefore also block; authentication does not infer termination from them.
  return rows.filter(entry => resolve(entry.source_file) === canonicalSource)
    .map(({ environment_id, name, state }) => ({ environment_id, name, state }));
};

const execute = promisify(execFile);
const sourceVersion = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const credentialSourceAction = async (input: { action: "check" | "logout"; sourceFile: string; grounds: string }): Promise<CredentialSourceDecision> => {
  let source: string; let version: string;
  try { source = realpathSync(input.sourceFile); if (!statSync(source).isFile()) throw Error(); version = sourceVersion(source); }
  catch { throw Error("authentication source is unavailable; no file was deleted"); }
  const release = acquireCredentialSourceLocks([source]);
  try {
    let receipt: unknown;
    try {
      const result = await execute(input.grounds, ["env", "credential-occupancy", "--json"], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      receipt = JSON.parse(result.stdout);
    } catch { throw Error("credential occupancy is unavailable; retain authentication source"); }
    const blockers = blockingCredentialReferences(receipt, source);
    if (blockers.length) return { action: input.action, status: "blocked", reason: "unfinished_environments", blockers };
    try { if (sourceVersion(source) !== version) return { action: input.action, status: "blocked", reason: "source_changed", blockers: [] }; }
    catch { throw Error("authentication source changed while checking; no file was deleted"); }
    if (input.action === "check") return { action: input.action, status: "ready", blockers: [] };
    // The shared source lock spans this await and unlink. Preparation publishes
    // its occupancy under the same lock; another source never participates.
    unlinkSync(source);
    return { action: input.action, status: "logged_out", blockers: [] };
  } finally { release(); }
};

