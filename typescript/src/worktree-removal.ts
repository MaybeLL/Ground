import { lstatSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateAttribution, type Attribution } from "./domain.js";
import { validation } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { atomicPrivateWrite, safeRead } from "./runtime-files.js";

/**
 * Local proof that a managed worktree is being (or was) removed. It is written
 * before the files are deleted so a crash between deletion and the ledger write
 * can be completed by a later `devrun cleanup` without deleting anything twice.
 */
export interface WorktreeRemovalReceipt {
  format: typeof RECEIPT_FORMAT;
  operation_id: string;
  event_id: string;
  dev_run_id: string;
  worktree_path: string;
  discard_changes: boolean;
  entry_count: number;
  attribution: Attribution;
  recorded: boolean;
}

export const RECEIPT_FORMAT = "grounds.worktree-removal-receipt/v1";

/** Counts regular files, directories and symbolic links below `root` without following links; the root itself is excluded. */
export const countEntries = (root: string): number => {
  let count = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.isFile()) count += 1;
      else if (entry.isDirectory()) { count += 1; pending.push(join(directory, entry.name)); }
    }
  }
  return count;
};

export const receiptPath = (runDirectory: string): string => join(runDirectory, "removal-receipt.json");

export const writeReceipt = (runDirectory: string, receipt: WorktreeRemovalReceipt): void => {
  atomicPrivateWrite(receiptPath(runDirectory), JSON.stringify(receipt, null, 2) + "\n");
};

export const readReceipt = (runDirectory: string): WorktreeRemovalReceipt | undefined => {
  const path = receiptPath(runDirectory);
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw validation("worktree", "worktree removal receipt must be a real file");
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(safeRead(path, 64 * 1024).toString("utf8")) as Record<string, unknown>; }
  catch { throw validation("worktree", "worktree removal receipt is not valid JSON"); }
  const invalid = (): never => { throw validation("worktree", "worktree removal receipt is invalid"); };
  if (raw.format !== RECEIPT_FORMAT || !isUUIDv7(raw.operation_id) || !isUUIDv7(raw.event_id) || !isUUIDv7(raw.dev_run_id)) invalid();
  if (typeof raw.worktree_path !== "string" || typeof raw.discard_changes !== "boolean" || typeof raw.recorded !== "boolean") invalid();
  if (!Number.isSafeInteger(raw.entry_count) || (raw.entry_count as number) < 0) invalid();
  validateAttribution(raw.attribution as Attribution);
  return raw as unknown as WorktreeRemovalReceipt;
};

export const markReceiptRecorded = (runDirectory: string, operationID: string): void => {
  const receipt = readReceipt(runDirectory);
  if (receipt && receipt.operation_id === operationID && !receipt.recorded) writeReceipt(runDirectory, { ...receipt, recorded: true });
};
