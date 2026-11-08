/** Where a delivered commit is kept, and how it is put back in front of the next worker. */
export type CodeArchiveResult =
  | { readonly status: "confirmed"; readonly receipt: string; readonly commit: string }
  | { readonly status: "conflict" | "invalid" | "unavailable"; readonly reason: string };
export type CodeFetchResult =
  | { readonly status: "fetched"; readonly commit: string }
  | { readonly status: "missing" | "unavailable"; readonly reason: string };

/** Policy evidence supplied by the repository operator. Plain Git does not expose server rules. */
export type ArchiveProtection = { readonly level: "protected" | "unprotected"; readonly evidence: string };
export type RecordedProtection = ArchiveProtection | { readonly level: "unknown" };

/** A live integrity observation. Unknown denotes an observation failure, not evidence of loss. */
export interface ArchiveObservation {
  readonly id: string;
  readonly status: "intact" | "ref-changed" | "unavailable" | null;
  readonly protection: RecordedProtection;
  readonly tag: "unchanged" | "moved" | "missing" | "unknown";
  readonly recordedCommit?: string;
  readonly remoteCommit?: string;
}

export type RepairIdentity = { originalId: string; originalReceipt: string; archiveId: string };
export type RepairInput = RepairIdentity & { repositoryPath: string; earlierReceipts: readonly string[] };

/** Immutable bytes read from a regular file in a frozen delivery, never from the working tree. */
export type ArchivedFile =
  | { readonly status: "read"; readonly commit: string; readonly blob: string; readonly executable?:true; bytes: Uint8Array }
  | { readonly status: "missing" | "unavailable" | "invalid"; readonly reason: string };

export type ArchivedDigest = { status: "read"; digest: string } | Exclude<ArchivedFile, { status: "read" }>;
export type ArchivedFiles = { status: "read"; files: Map<string, Extract<ArchivedFile, { status: "read" }>> } | Exclude<ArchivedFile, { status: "read" }>;
export interface CodeArchivePort {
  recordedCommit(item:{id:string;receipt:string}):string | undefined;
  fileDigest(repositoryPath: string, item: { id: string; receipt: string }, path: string): Promise<ArchivedDigest>;
  readFiles(repositoryPath: string, item: { id: string; receipt: string }, paths: readonly string[]): Promise<ArchivedFiles>;
  readFile(repositoryPath: string, item: { id: string; receipt: string }, path: string): Promise<ArchivedFile>;
  repair(input: RepairInput): Promise<CodeArchiveResult>;
  inspectRepair(identity: RepairIdentity): Promise<CodeArchiveResult>;
  inspect(repositoryPath: string, item: { id: string; receipt: string }): Promise<ArchiveObservation>;
  /** The full identity of a commit-ish in the repository, or undefined when it names no commit. */
  resolveCommit(repositoryPath: string, commitish: string): Promise<string | undefined>;
  /** Keep the commit on the remote under the delivery identity and read it back. Repeating it for the same commit is harmless. */
  archive(input: { observeOnly?:boolean; repositoryPath: string; remote: string; deliveryId: string; commit: string; previousReceipt?: string; protection?: ArchiveProtection; reservePublication?:(receipt:string)=>Promise<boolean> }): Promise<CodeArchiveResult>;
  /** Bring the commit a receipt describes into the repository, checking it is the one the receipt names. */
  fetch(input: { repositoryPath: string; receipt: string }): Promise<CodeFetchResult>;
}

/** A private working copy for one run: its own directory and branch, started at a given commit. */
export class WorktreeConflict extends Error {}

export interface WorktreePort {
  repositoryIdentity(repositoryPath:string):Promise<string>;
  existingBase(input:{repositoryPath:string;runId:string}):Promise<string|undefined>;
  create(input: { repositoryPath: string; runId: string; commit: string }): Promise<{ path: string; branch: string; created: boolean }>;
}

export interface WorkingWorkspacePort {
  prepare(ledgerId:string,runId:string,repositories:readonly import("../domain/index.js").MaterialRepository[]):
    Promise<{kind:"working";runId:string;path:string;created:boolean;materials:{name:string;commit:string;path:string}[]}>;
}
