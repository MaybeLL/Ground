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

export interface FirstParentLocation {
  on_first_parent: boolean | null;
  landed?: CommitIdentity;
  first_parent_landing?: CommitIdentity;
}

/** Locate only the supplied OID, never a same-parent/same-tree lookalike. No adoption inference. */
export function locateFirstParentLanding(cwd: string, target: string, supplied: string): FirstParentLocation {
  const head = oid(target), candidate = oid(supplied);
  try {
    assertHistoryRepository(cwd);
    const landed = readCommit(cwd, candidate);
    const firstParents = text(cwd, ["rev-list", "--first-parent", head]).split("\n");
    if (firstParents.includes(candidate)) return { on_first_parent: true, landed };
    // Oldest first-parent entry containing the exact supplied commit is the actual merge entry.
    // rev-list --ancestry-path is successful even for unrelated commits (empty output).
    const descendants = new Set(text(cwd, ["rev-list", "--ancestry-path", `${candidate}..${head}`]).split("\n"));
    const actual = [...firstParents].reverse().find(commit => descendants.has(commit));
    return { on_first_parent: false, landed, ...(actual ? { first_parent_landing: readCommit(cwd, actual) } : {}) };
  } catch { return { on_first_parent: null }; }
}

/** Actual target ref transition boundary, distinct from L's first Git parent. */
export type LandingTargetPredecessor =
  | { state: "confirmed"; commit: CommitIdentity; source: "adoption_binding" | "landing_first_parent"; reason?: string }
  | { state: "unknown" | "conflict"; commit?: undefined; source?: "adoption_binding" | "landing_first_parent"; reason?: string };

/** Inspect supplied transition evidence without moving refs or inventing a gate-based predecessor. */
export function inspectLandingTargetPredecessor(cwd: string, input: {
  landed?: CommitIdentity;
  method?: "ff" | "merge" | "squash";
  adoption_bound: boolean;
  supplied_predecessor?: string;
}): LandingTargetPredecessor {
  if (!input.adoption_bound || !input.landed || !input.method) return { state: "unknown", reason: "actual_adoption_or_method_unconfirmed" };
  const { landed, method, supplied_predecessor: supplied } = input;
  if (method === "ff" && !supplied) return { state: "unknown", reason: "ff_requires_explicit_target_predecessor" };
  const inferred = method === "ff" ? undefined : landed.parents[0];
  const source = supplied ? "adoption_binding" as const : "landing_first_parent" as const;
  if (supplied === landed.oid) return { state: "conflict", source, reason: "target_predecessor_equals_landing_no_update" };
  if (!supplied && !inferred) return { state: "unknown", reason: "landing_has_no_target_parent" };
  // A merge/squash's target parent follows from the claimed merge method and
  // actual ordered parents. An explicit inconsistent assertion remains a conflict.
  if (method !== "ff" && supplied && supplied !== inferred) return { state: "conflict", source, reason: "supplied_predecessor_differs_from_landing_first_parent" };
  try {
    assertHistoryRepository(cwd);
    const predecessor = readCommit(cwd, supplied ?? inferred!);
    // Verify all trees/blobs and all parent paths; do not restrict FF ancestry
    // to first-parent history (a target can fast-forward into a merge side).
    text(cwd, ["rev-list", "--objects", "--missing=error", oid(landed.oid), oid(predecessor.oid)]);
    text(cwd, ["fsck", "--full", "--strict", "--no-reflogs", "--no-dangling", oid(landed.oid), oid(predecessor.oid)]);
    const ancestors = text(cwd, ["rev-list", oid(landed.oid)]).split("\n");
    if (!ancestors.includes(oid(predecessor.oid))) return { state: "conflict", source, reason: "target_predecessor_is_not_landing_ancestor" };
    return { state: "confirmed", source, commit: predecessor };
  } catch { return { state: "unknown", source, reason: "target_predecessor_objects_or_history_unavailable" }; }
}
