import { assertHistoryRepository, historyGit } from "./git-history-read.js";
import { validation } from "./errors.js";
import type { CommitIdentity } from "./integration-gate.js";

export type SnapshotRelation =
  | { kind: "ahead"; base_ahead: number; snapshot_ahead: 0 }
  | { kind: "diverged"; base_ahead: number; snapshot_ahead: number }
  | { kind: "unrelated" }
  | { kind: "unknown" };

const oid = (value: string): string => {
  const raw = value.replace(/^(sha1|sha256):/, "");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw)) throw validation("commit", "a full Git object ID is required");
  if (value.startsWith("sha1:") && raw.length !== 40 || value.startsWith("sha256:") && raw.length !== 64) {
    throw validation("commit", "Git object ID does not match its algorithm");
  }
  return raw;
};
const text = historyGit;
const qualified = (raw: string): string => `${raw.length === 64 ? "sha256" : "sha1"}:${raw}`;

/** Informational only: a snapshot does not constrain where a Candidate may start. */
export function snapshotRelation(cwd: string, snapshot: string, base: string): SnapshotRelation {
  const from = oid(snapshot), to = oid(base);
  try {
    // Reuse the trace reader's no-replace, no-lazy-fetch, no-grafts and environment guards.
    assertHistoryRepository(cwd);
    text(cwd, ["cat-file", "-e", `${from}^{commit}`]);
    text(cwd, ["cat-file", "-e", `${to}^{commit}`]);
    const [snapshotAhead, baseAhead] = text(cwd, ["rev-list", "--left-right", "--count", `${from}...${to}`]).split(/\s+/).map(Number);
    if (!Number.isSafeInteger(snapshotAhead) || !Number.isSafeInteger(baseAhead)) return { kind: "unknown" };
    if (snapshotAhead === 0) return { kind: "ahead", base_ahead: baseAhead!, snapshot_ahead: 0 };
    // Compare root sets rather than treating any failed merge-base command as 'unrelated'.
    const roots = new Set(text(cwd, ["rev-list", "--max-parents=0", from]).split("\n"));
    const related = text(cwd, ["rev-list", "--max-parents=0", to]).split("\n").some(root => roots.has(root));
    return related ? { kind: "diverged", base_ahead: baseAhead!, snapshot_ahead: snapshotAhead! } : { kind: "unrelated" };
  } catch { return { kind: "unknown" }; }
}

export function readCommit(cwd: string, commit: string): CommitIdentity {
  // cat-file reads the object, unaffected by pretty-format/show settings.
  const commitOid = oid(commit);
  const headers = text(cwd, ["cat-file", "commit", commitOid]).split("\n\n", 1)[0]!.split("\n");
  const tree = headers.find(line => line.startsWith("tree "))?.slice(5);
  if (!tree) throw validation("commit", "commit has no tree");
  return { oid: qualified(commitOid), parents: headers.filter(line => line.startsWith("parent ")).map(line => qualified(line.slice(7))), tree_oid: qualified(tree) };
}

export type LandingTargetPredecessor =
  | { state: "confirmed"; commit: CommitIdentity; source: "adoption_binding" | "landing_first_parent"; reason?: string }
  | { state: "unknown" | "conflict"; commit?: undefined; source?: "adoption_binding" | "landing_first_parent"; reason?: string };
