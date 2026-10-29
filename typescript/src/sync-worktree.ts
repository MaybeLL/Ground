import { historyGit } from "./git-history-read.js";
import { readCommit } from "./integration-history.js";
import { assertCommittedDevelopment, assertDevelopmentBranch, type DevelopmentIdentity } from "./development-branch.js";
import { constants, closeSync, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { newUUIDv7, isGitOID } from "./identity.js";
import { sha256 } from "./canonical-json.js";
import { validation } from "./errors.js";
import { atomicPrivateWrite, digestBytes, safeRead } from "./runtime-files.js";
import { prepareSyncMerge, syncGit, type SyncMerge } from "./sync-merge.js";
import { snapshotSyncFiles, installSyncFiles, validateSyncFiles, type SyncFiles } from "./sync-files.js";

export interface LocalSync {
  format: "grounds.local-sync/v1";
  id: string;
  development?: DevelopmentIdentity;
  source_head?: string;
  already_integrated?: true;
  result_commit?: string;
  cwd: string;
  worktree_identity: string;
  mutation_started?: true;
  base: string;
  target: string;
  phase: "preparing" | "prepared" | "applying" | "resolving" | "completing" | "abandoning" | "abandoned";
  original?: SyncFiles;
  original_index?: string;
  desired?: SyncFiles;
  desired_index?: string;
  merge?: SyncMerge;
  receipt?: { head: string; index?: string; files: string; digest: string };
  saved_edits: string[];
}
export type SyncCheckpoint = (step: string) => void;
const noop: SyncCheckpoint = () => {};
const raw = (oid: string): string => { if (!isGitOID(oid)) throw validation("sync.commit", "qualified OID required"); return oid.slice(oid.indexOf(":") + 1); };
const qualify = (oid: string): string => `${oid.length === 64 ? "sha256" : "sha1"}:${oid}`;
const text = (cwd: string, args: string[]): string => syncGit(cwd, args).toString("utf8").trim();
const names = (cwd: string): string[] => [...new Set(new TextDecoder("utf-8", { fatal: true }).decode(syncGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], undefined, false, true)).split("\0").filter(Boolean))].sort();
const indexPath = (cwd: string): string => text(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
// Index publication intentionally uses a journaled hard link. Do not relax the
// general recovery/blob reader's single-link rule for this Git metadata case.
const readGitIndex = (path: string): Buffer => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 64n * 1024n * 1024n) throw validation("sync.index", "unsupported Git index");
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw validation("sync.index", "index changed while reading");
    return bytes;
  } finally { closeSync(fd); }
};
const readIndex = (cwd: string): Buffer | undefined => existsSync(indexPath(cwd)) ? readGitIndex(indexPath(cwd)) : undefined;
const indexDigest = (cwd: string): string | undefined => { const bytes = readIndex(cwd); return bytes ? digestBytes(bytes) : undefined; };
const head = (cwd: string): string => qualify(text(cwd, ["rev-parse", "HEAD"]));
const save = (directory: string, journal: LocalSync): void => {
  const clean = JSON.parse(JSON.stringify(journal)) as LocalSync;
  const bytes = JSON.stringify({ journal: clean, digest: sha256(clean) });
  if (Buffer.byteLength(bytes) > (clean.mutation_started ? 16 : 8) * 1024 * 1024) throw validation("sync.journal", "recovery journal exceeds its bounded size; material retained");
  atomicPrivateWrite(join(directory, "journal.json"), bytes);
};
export function readLocalSync(directory: string): LocalSync {
  const saved = JSON.parse(safeRead(join(directory, "journal.json"), 16 * 1024 * 1024).toString());
  const j = saved.journal as LocalSync;
  if (!j || j.format !== "grounds.local-sync/v1" || saved.digest !== sha256(j) || !Array.isArray(j.saved_edits)) throw validation("sync.journal", "invalid local recovery journal");
  raw(j.base); raw(j.target);
  const identity = lstatSync(j.cwd, { bigint: true });
  if (realpathSync(j.cwd) !== j.cwd || !identity.isDirectory() || `${identity.dev}:${identity.ino}` !== j.worktree_identity) throw validation("sync.journal", "worktree identity path changed");
  if (j.original) validateSyncFiles(j.original);
  if (j.desired) validateSyncFiles(j.desired);
  return j;
}
const saveIndex = (directory: string, cwd: string): string | undefined => {
  const bytes = readIndex(cwd);
  if (!bytes) return undefined;
  atomicPrivateWrite(join(directory, "index"), bytes); return digestBytes(bytes);
};
const assertHead = (j: LocalSync): void => {
  if (j.development) { assertDevelopmentBranch(j.cwd, j.development); if (![j.source_head, j.result_commit].includes(head(j.cwd))) throw validation("sync.head", "managed source HEAD changed; retain recovery materials"); return; }
  if (![j.base, j.target].includes(head(j.cwd)) || text(j.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) !== "HEAD") throw validation("sync.head", "unexpected HEAD or attached branch; preserve recovery inputs");
};

/** Git-compatible index lock, recoverable by a pre-journaled hard-link identity. */
function installIndex(directory: string, j: LocalSync, bytes: Buffer | undefined, purpose: "apply" | "restore", checkpoint: SyncCheckpoint): void {
  const index = indexPath(j.cwd), lock = index + ".lock", lease = join(directory, `index-${purpose}.json`);
  let staging: string;
  if (existsSync(lease)) {
    const stored = JSON.parse(safeRead(lease).toString());
    if (stored.digest !== (bytes ? digestBytes(bytes) : "absent") || stored.id !== j.id || !/^index\.grounds-[a-f0-9-]+$/.test(stored.name)) throw validation("sync.index", "index recovery identity mismatch");
    staging = join(dirname(index), stored.name);
  } else {
    staging = join(dirname(index), `index.grounds-${newUUIDv7()}`);
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes ?? Buffer.alloc(0)); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(dirname(staging), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    saveLease();
  }
  function saveLease(): void { atomicPrivateWrite(lease, JSON.stringify({ id: j.id, name: staging.slice(staging.lastIndexOf("/") + 1), digest: bytes ? digestBytes(bytes) : "absent" })); }
  const same = (path: string): boolean => {
    if (!existsSync(path)) return false;
    const a = lstatSync(path, { bigint: true }), b = lstatSync(staging, { bigint: true });
    return a.isFile() && !a.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
  };
  if (digestBytes(readGitIndex(staging)) !== digestBytes(bytes ?? Buffer.alloc(0))) throw validation("sync.index", "index recovery payload changed");
  if (bytes && same(index) && !existsSync(lock)) return;
  if (existsSync(lock)) { if (!same(lock)) throw validation("sync.index", "another Git writer owns index.lock; do not remove it"); }
  else linkSync(staging, lock);
  checkpoint("index-locked");
  if (bytes) renameSync(lock, index);
  else { if (existsSync(index)) unlinkSync(index); unlinkSync(lock); }
  const fd = openSync(dirname(index), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  checkpoint("index-installed");
}

/** After SQL reaches a terminal state, release only our exact index hard link.
 * Recovery payloads and receipts remain; retries never remove another writer's lock. */
export function releaseLocalSyncIndex(directory: string): void {
  const journal = readLocalSync(directory);
  if (!journal.receipt || !["completing", "abandoned"].includes(journal.phase)) throw validation("sync.index", "terminal receipt required");
  const index = indexPath(journal.cwd);
  if (existsSync(index + ".lock")) throw validation("sync.index", "another Git writer owns index.lock");
  for (const purpose of ["apply", "restore"]) {
    const lease = join(directory, `index-${purpose}.json`);
    if (!existsSync(lease)) continue;
    const stored = JSON.parse(safeRead(lease).toString());
    if (stored.id !== journal.id || !/^index\.grounds-[a-f0-9-]+$/.test(stored.name)) throw validation("sync.index", "index recovery identity mismatch");
    const staging = join(dirname(index), stored.name);
    if (!existsSync(staging) || !existsSync(index)) continue;
    const a = lstatSync(index), b = lstatSync(staging);
    if (a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino) {
      if (digestBytes(readGitIndex(staging)) !== stored.digest) throw validation("sync.index", "index recovery payload changed");
      unlinkSync(staging);
      const fd = openSync(dirname(index), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
}

/** The caller holds the DevRun lock and SQL reservation for this whole protocol. */
export function initializeLocalSync(input: { cwd: string; directory: string; base: string; target: string; development?: DevelopmentIdentity }, reservedWithoutMutation = false): LocalSync {
  const cwd = realpathSync(input.cwd);
  if (input.development) assertCommittedDevelopment(cwd, input.development);
  if (!input.development && (head(cwd) !== input.base || text(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) !== "HEAD")) throw validation("sync.head", "sync requires the recorded detached HEAD");
  if (existsSync(input.directory) && !reservedWithoutMutation) throw validation("sync.directory", "recovery directory must be new");
  if (existsSync(join(input.directory, "journal.json"))) throw validation("sync.directory", "existing recovery journal must not be overwritten");
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const st = lstatSync(cwd, { bigint: true });
  const j: LocalSync = { format: "grounds.local-sync/v1", id: newUUIDv7(), ...(input.development ? { development: input.development, source_head: head(cwd), ...(historyGit(cwd, ["rev-list", raw(head(cwd))]).split("\n").includes(raw(input.target)) ? { already_integrated: true as const } : {}) } : {}), cwd, worktree_identity: `${st.dev}:${st.ino}`, base: input.base, target: input.target, phase: "preparing", saved_edits: [] };
  save(input.directory, j); return j;
}

export function prepareLocalSync(input: { cwd: string; directory: string; base: string; target: string; development?: DevelopmentIdentity }, checkpoint: SyncCheckpoint = noop): LocalSync {
  const j = initializeLocalSync(input), cwd = j.cwd;
  checkpoint("reserved-local");
  for (const oid of [input.base, input.target]) if (/(?:^|\n)160000 /.test(syncGit(cwd, ["ls-tree", "-r", raw(oid)]).toString("utf8"))) throw validation("sync.submodule", "this sync implementation cannot preserve a complete submodule checkout; retain the worktree and use a supported input");
  const original = join(input.directory, "original"); mkdirSync(original, { mode: 0o700 });
  j.original_index = saveIndex(original, cwd);
  j.original = snapshotSyncFiles(cwd, names(cwd), original);
  save(input.directory, j); checkpoint("original-saved");
  j.merge = prepareSyncMerge({ ...input, ...(j.source_head ? { source_head: j.source_head } : {}), directory: join(input.directory, "merge") });
  const repo = j.merge.repository, desired = join(input.directory, "desired-worktree"); mkdirSync(desired, { mode: 0o700 });
  syncGit(repo, ["read-tree", raw(j.merge.result_tree)]);
  syncGit(repo, [`--work-tree=${desired}`, "checkout-index", "--all", "--force", `--prefix=${desired}/`]);
  const desiredPaths = new TextDecoder("utf-8", { fatal: true }).decode(syncGit(repo, ["ls-tree", "-rz", "--name-only", raw(j.merge.result_tree)])).split("\0").filter(Boolean);
  j.desired = snapshotSyncFiles(desired, desiredPaths, join(input.directory, "desired"));
  for (const [path, entry] of Object.entries(j.desired.entries)) if (path.split("/").pop() === ".gitattributes" && entry.kind === "file") {
    if (/(filter|working-tree-encoding)\s*=/.test(safeRead(join(input.directory, "desired", "blobs", entry.digest.slice(7))).toString("utf8"))) throw validation("sync.attributes", "external filters and working-tree encodings require separate support");
  }
  if (j.merge.conflicts.length) {
    const zeros = "0".repeat(raw(j.base).length);
    const stages = j.merge.conflicts.map(c => `0 ${zeros}\t${c.path}\0` + c.stages.map(s => `${s.mode} ${raw(s.oid)} ${s.stage}\t${c.path}\0`).join("")).join("");
    syncGit(repo, ["update-index", "-z", "--index-info"], Buffer.from(stages));
  }
  j.desired_index = saveIndex(join(input.directory, "desired"), repo);
  const objectRoots = [raw(j.merge.result_tree), raw(j.merge.original_tree), ...j.merge.conflicts.flatMap(c => c.stages.map(s => raw(s.oid)))];
  const pack = syncGit(repo, ["pack-objects", "--stdout", "--revs"], Buffer.from([...new Set(objectRoots)].join("\n") + "\n"));
  syncGit(cwd, ["index-pack", "--stdin"], pack);
  if (indexDigest(cwd) !== j.original_index || snapshotSyncFiles(cwd, names(cwd)).digest !== j.original.digest) throw validation("sync.snapshot", "original input drifted during preparation; recovery material retained");
  j.phase = "prepared"; save(input.directory, j); checkpoint("prepared"); return j;
}

export function applyLocalSync(directory: string, checkpoint: SyncCheckpoint = noop): LocalSync {
  const j = readLocalSync(directory); assertHead(j);
  if (j.phase !== "prepared" || head(j.cwd) !== (j.source_head ?? j.base) || indexDigest(j.cwd) !== j.original_index || !j.original || !j.desired || !j.desired_index) throw validation("sync.phase", "apply requires unchanged prepared inputs; interrupted application must be inspected or abandoned");
  if (snapshotSyncFiles(j.cwd, names(j.cwd)).digest !== j.original.digest) throw validation("sync.snapshot", "edits changed after preparation");
  try { lstatSync(indexPath(j.cwd) + ".lock"); throw validation("sync.index", "another Git writer owns index.lock"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  j.phase = "applying"; j.mutation_started = true; save(directory, j); checkpoint("applying");
  installSyncFiles(j.cwd, j.original, j.desired, join(directory, "desired"), path => checkpoint("file:" + path));
  if (indexDigest(j.cwd) !== j.original_index) throw validation("sync.index", "index drifted during file application; retain recovery material");
  installIndex(directory, j, safeRead(join(directory, "desired", "index"), 64 * 1024 * 1024), "apply", checkpoint);
  if (!j.development) syncGit(j.cwd, ["update-ref", "--no-deref", "HEAD", raw(j.target), raw(j.base)]); checkpoint("head-updated");
  j.phase = "resolving"; save(directory, j); checkpoint("resolving"); return j;
}

function receipt(j: LocalSync, snapshot: SyncFiles): NonNullable<LocalSync["receipt"]> {
  const value = { head: head(j.cwd), ...(indexDigest(j.cwd) ? { index: indexDigest(j.cwd) } : {}), files: snapshot.digest };
  return { ...value, digest: sha256(value) };
}

/** Never re-applies an interrupted file mutation over later user edits. */
export function completeLocalSync(directory: string, checkpoint: SyncCheckpoint = noop): LocalSync {
  const j = readLocalSync(directory); assertHead(j);
  if (j.phase === "completing" && j.receipt) {
    if (head(j.cwd) !== (j.result_commit ?? j.target) || syncGit(j.cwd, ["ls-files", "-u", "-z"]).length) throw validation("sync.receipt", "completion requires the target HEAD and a fully resolved index");
    const current = receipt(j, snapshotSyncFiles(j.cwd, names(j.cwd)));
    if (current.digest !== j.receipt.digest) throw validation("sync.receipt", "worktree changed after completion receipt; retain edits and reconcile before finalizing SQL");
    return j;
  }
  if (j.phase === "applying") {
    if (!j.desired || snapshotSyncFiles(j.cwd, [...new Set([...names(j.cwd), ...Object.keys(j.desired.entries)])]).digest !== j.desired.digest) throw validation("sync.recovery", "application was interrupted or edited; abandon to restore safely with edits saved");
    if (![j.original_index, j.desired_index].includes(indexDigest(j.cwd))) throw validation("sync.recovery", "index changed after interruption; preserve it by abandoning sync");
    installIndex(directory, j, safeRead(join(directory, "desired", "index"), 64 * 1024 * 1024), "apply", checkpoint);
    if (!j.development && head(j.cwd) === (j.source_head ?? j.base)) syncGit(j.cwd, ["update-ref", "--no-deref", "HEAD", raw(j.target), raw(j.base)]);
    j.phase = "resolving"; save(directory, j);
  }
  if (j.phase !== "resolving" || ![j.source_head ?? j.target, ...(j.result_commit ? [j.result_commit] : [])].includes(head(j.cwd))) throw validation("sync.phase", "sync is not ready to complete");
  if (syncGit(j.cwd, ["ls-files", "-u", "-z"]).length) throw validation("sync.conflicts", "resolve every unmerged index entry before completing sync");
  const final = join(directory, "final"); mkdirSync(final, { recursive: true, mode: 0o700 });
  const files = snapshotSyncFiles(j.cwd, names(j.cwd), final); saveIndex(final, j.cwd);
  if (j.development) {
    // Journal the exact merge object before publishing the branch ref. The two
    // parents preserve normal source history and the observed target history.
    const tree = text(j.cwd, ["write-tree"]);
    j.result_commit ??= j.already_integrated ? j.source_head! : qualify(syncGit(j.cwd, ["commit-tree", tree, "-p", raw(j.source_head!), "-p", raw(j.target)], Buffer.from("Grounds target synchronization\n")).toString("utf8").trim());
    if (readCommit(j.cwd, j.result_commit).tree_oid !== qualify(tree) || (!j.already_integrated && JSON.stringify(readCommit(j.cwd, j.result_commit).parents) !== JSON.stringify([j.source_head, j.target]))) throw validation("sync.receipt", "index differs from the journaled merge object; retain edits and reconcile");
    save(directory, j); checkpoint("merge-object-saved");
    if (head(j.cwd) === j.source_head) syncGit(j.cwd, ["update-ref", `refs/heads/${j.development.branch}`, raw(j.result_commit), raw(j.source_head!)]);
    checkpoint("merge-ref-updated");
  }
  j.receipt = receipt(j, files); j.phase = "completing"; save(directory, j); checkpoint("complete-receipt"); return j;
}

export function abandonLocalSync(directory: string, checkpoint: SyncCheckpoint = noop, sqlCompletionStillPending = false): LocalSync {
  const j = readLocalSync(directory); assertHead(j);
  if (j.phase === "abandoned" && j.receipt && head(j.cwd) === (j.source_head ?? j.base)) {
    const current = snapshotSyncFiles(j.cwd, names(j.cwd));
    if (receipt(j, current).digest === j.receipt.digest && (!j.mutation_started
      || (current.digest === j.original?.digest && indexDigest(j.cwd) === j.original_index))) return j;
    // SQL may still be pending. A stale restoration receipt cannot hide edits
    // made after it: retain another snapshot and restore again below.
  }
  if (j.phase === "completing" && !sqlCompletionStillPending) throw validation("sync.phase", "completion receipt exists; reconcile SQL before choosing another outcome");
  const backupName = "edits-" + newUUIDv7(), backup = join(directory, backupName); mkdirSync(backup, { mode: 0o700 });
  const paths = [...new Set([...names(j.cwd), ...Object.keys(j.original?.entries ?? {}), ...Object.keys(j.desired?.entries ?? {})])];
  const current = snapshotSyncFiles(j.cwd, paths, backup); const savedIndex = saveIndex(backup, j.cwd);
  atomicPrivateWrite(join(backup, "head"), head(j.cwd));
  j.saved_edits.push(backupName);
  const neverApplied = !j.mutation_started;
  j.phase = "abandoning"; save(directory, j); checkpoint("edits-saved");
  if (!neverApplied) {
    if (!j.original) throw validation("sync.recovery", "original snapshot is missing; refuse destructive recovery");
    installSyncFiles(j.cwd, current, j.original, join(directory, "original"), path => checkpoint("restore:" + path));
    if (indexDigest(j.cwd) !== savedIndex) throw validation("sync.index", "index changed during restoration; preserve new edits before retrying");
    // A crashed apply may still own index.lock. Finish its known lock first,
    // then install the original bytes using a separate recovery identity.
    if (existsSync(indexPath(j.cwd) + ".lock") && existsSync(join(directory, "index-apply.json"))) installIndex(directory, j, safeRead(join(directory, "desired", "index"), 64 * 1024 * 1024), "apply", noop);
    installIndex(directory, j, j.original_index ? safeRead(join(directory, "original", "index"), 64 * 1024 * 1024) : undefined, "restore", checkpoint);
    if (j.development) {
      if (head(j.cwd) !== j.source_head) syncGit(j.cwd, ["update-ref", `refs/heads/${j.development.branch}`, raw(j.source_head!), raw(j.result_commit!)]);
    } else if (head(j.cwd) !== j.base) syncGit(j.cwd, ["update-ref", "--no-deref", "HEAD", raw(j.base), raw(j.target)]);
  }
  const restored = snapshotSyncFiles(j.cwd, names(j.cwd));
  if (!neverApplied && (restored.digest !== j.original!.digest || indexDigest(j.cwd) !== j.original_index || head(j.cwd) !== (j.source_head ?? j.base))) throw validation("sync.recovery", "restored files/index/HEAD do not match the original receipt");
  j.receipt = receipt(j, restored); j.phase = "abandoned"; save(directory, j); checkpoint("abandon-receipt"); return j;
}
