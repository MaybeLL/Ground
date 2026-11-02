/** Where a delivered commit is kept, and how it is put back in front of the next worker. */
export type CodeArchiveResult =
  | { readonly status: "confirmed"; readonly receipt: string; readonly commit: string }
  | { readonly status: "conflict" | "invalid" | "unavailable"; readonly reason: string };
export type CodeFetchResult =
  | { readonly status: "fetched"; readonly commit: string }
  | { readonly status: "missing" | "unavailable"; readonly reason: string };

export interface CodeArchivePort {
  /** The full identity of a commit-ish in the repository, or undefined when it names no commit. */
  resolveCommit(repositoryPath: string, commitish: string): Promise<string | undefined>;
  /** Keep the commit on the remote under the delivery identity and read it back. Repeating it for the same commit is harmless. */
  archive(input: { repositoryPath: string; remote: string; deliveryId: string; commit: string }): Promise<CodeArchiveResult>;
  /** Bring the commit a receipt describes into the repository, checking it is the one the receipt names. */
  fetch(input: { repositoryPath: string; receipt: string }): Promise<CodeFetchResult>;
}

/** A private working copy for one run: its own directory and branch, started at a given commit. */
export interface WorktreePort {
  create(input: { repositoryPath: string; runId: string; commit: string }): Promise<{ path: string; branch: string; created: boolean }>;
}
