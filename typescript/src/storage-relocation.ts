import { createHash } from "node:crypto";
import { closeSync, constants, cpSync, fsyncSync, lchmodSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { validation } from "./errors.js";
import { atomicPrivateWrite, privateDirectory, safeRead, withRuntimeLock } from "./runtime-files.js";
import { safeTreeWrite } from "./safe-tree.js";
import { assertManagedAncestors } from "./data-layout.js";

export interface RelocationEntry {
  source: string;
  target: string;
  retired: string;
  staged: string;
  digest: string;
}
export interface RelocationJournal {
  format: "grounds.storage-relocation/v1";
  id: string;
  phase: "planned" | "staged" | "activating" | "activated";
  entries: RelocationEntry[];
}

/** Includes symlink text without following it, empty directories and executable permissions. */
export function treeDigest(path: string): string {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  function visit(current: string, relative: string): void {
    const stat = lstatSync(current);
    const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "unsupported";
    if (kind === "unsupported") throw validation("migration", `unsupported filesystem entry: ${current}`);
    hash.update(JSON.stringify([relative, kind, stat.mode & 0o777]));
    if (kind === "link") hash.update(JSON.stringify(readlinkSync(current)));
    else if (kind === "directory") for (const name of readdirSync(current).sort()) visit(join(current, name), relative ? `${relative}/${name}` : name);
    else {
      hash.update(String(stat.size) + ":");
      const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { for (;;) { const n = readSync(fd, buffer); if (!n) break; hash.update(buffer.subarray(0, n)); } }
      finally { closeSync(fd); }
    }
  }
  visit(path, "");
  return `sha256:${hash.digest("hex")}`;
}

const existsSync = (path: string): boolean => {
  try { lstatSync(path); return true; } catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
};

const contains = (parent: string, child: string): boolean => child === parent || child.startsWith(parent + sep);

function validateJournal(value: RelocationJournal): void {
  if (!value || value.format !== "grounds.storage-relocation/v1" || !/^[a-zA-Z0-9-]{1,100}$/.test(value.id)
    || !["planned", "staged", "activating", "activated"].includes(value.phase) || !Array.isArray(value.entries))
    throw validation("migration", "invalid relocation journal");
  const paths: string[] = [];
  for (const entry of value.entries) {
    if (!entry || typeof entry.source !== "string" || typeof entry.target !== "string"
      || !isAbsolute(entry.source) || !isAbsolute(entry.target)
      || resolve(entry.source) !== entry.source || resolve(entry.target) !== entry.target
      || entry.retired !== `${entry.source}.retired-${value.id}` || entry.staged !== `${entry.target}.staged-${value.id}`
      || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) throw validation("migration", "invalid relocation entry");
    for (const path of [entry.source, entry.target, entry.retired, entry.staged]) {
      assertManagedAncestors(dirname(path));
      if (paths.some(other => contains(other, path) || contains(path, other))) throw validation("migration", "move paths overlap");
      paths.push(path);
    }
  }
}

export function durableRenameNoReplace(source: string, target: string): void {
  const from = openSync(dirname(source), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let to: number | undefined;
  try {
    to = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    safeTreeWrite.parkEntry(from, basename(source), to, basename(target));
  } finally { if (to !== undefined) closeSync(to); closeSync(from); }
}

/** Flush copied contents before the durable staged marker promises they survived a restart. */
function syncTree(path: string, source: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const original = lstatSync(source);
    if (!original.isSymbolicLink() || readlinkSync(source) !== readlinkSync(path))
      throw validation("migration", "copied symlink differs from source; originals retained");
    // cpSync creates links using the caller's umask. lchmod changes the link
    // itself, never its target (including dangling and external targets).
    if ((stat.mode & 0o777) !== (original.mode & 0o777)) lchmodSync(path, original.mode & 0o777);
    return;
  }
  if (stat.isDirectory()) for (const child of readdirSync(path)) syncTree(join(path, child), join(source, child));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (stat.isDirectory() ? constants.O_DIRECTORY : 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Filesystem half of migration. The caller must quiesce resources and repair/validate Git and ledger bindings before declaring the overall migration complete. */
export function planRelocation(id: string, moves: Array<{ source: string; target: string }>): RelocationJournal {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw validation("migration", "invalid migration identifier");
  const entries: RelocationEntry[] = moves.map(move => {
    if (!isAbsolute(move.source) || !isAbsolute(move.target)) throw validation("migration", "paths must be absolute");
    const source = resolve(move.source), target = resolve(move.target);
    const retired = `${source}.retired-${id}`, staged = `${target}.staged-${id}`;
    if (existsSync(target) || existsSync(retired) || existsSync(staged) || existsSync(source + ".migration-marker-pending")) throw validation("migration", "destination or recovery path already exists");
    if (lstatSync(source).isSymbolicLink()) throw validation("migration", "managed source root cannot be a symlink");
    return { source, target, retired, staged, digest: treeDigest(source) };
  });
  const paths = entries.flatMap(entry => [entry.source, entry.target, entry.retired, entry.staged]);
  for (let a = 0; a < paths.length; a++) for (let b = a + 1; b < paths.length; b++) {
    if (contains(paths[a], paths[b]) || contains(paths[b], paths[a])) throw validation("migration", "move paths overlap");
  }
  const journal: RelocationJournal = { format: "grounds.storage-relocation/v1", id, phase: "planned", entries };
  validateJournal(journal);
  return journal;
}

export async function stageRelocation(journalPath: string, plan: RelocationJournal): Promise<RelocationJournal> {
  validateJournal(plan);
  privateDirectory(dirname(journalPath));
  return withRuntimeLock(dirname(journalPath), "storage-relocation", async () => {
    let journal = plan;
    if (existsSync(journalPath)) {
      journal = JSON.parse(safeRead(journalPath).toString());
      validateJournal(journal);
      if (journal.format !== plan.format || journal.id !== plan.id || JSON.stringify(journal.entries) !== JSON.stringify(plan.entries)) throw validation("migration", "journal belongs to another plan");
    } else {
      if (plan.phase !== "planned" || plan.entries.some(entry => [entry.staged, entry.retired, entry.target].some(existsSync)))
        throw validation("migration", "unowned destination or recovery path exists");
      atomicPrivateWrite(journalPath, JSON.stringify(journal));
    }
    if (journal.phase !== "planned") return journal;
    for (const entry of journal.entries) {
      if (treeDigest(entry.source) !== entry.digest) throw validation("migration", "source changed after planning");
      if (existsSync(entry.staged) && treeDigest(entry.staged) !== entry.digest) {
        // Only this journal-owned staging path is regenerable; never clean originals or retired copies.
        if (lstatSync(entry.staged).isSymbolicLink()) throw validation("migration", "staging root became a symlink");
        rmSync(entry.staged, { recursive: true });
      }
      if (!existsSync(entry.staged)) {
        privateDirectory(dirname(entry.staged));
        cpSync(entry.source, entry.staged, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
      }
      syncTree(entry.staged, entry.source);
      if (treeDigest(entry.staged) !== entry.digest || treeDigest(entry.source) !== entry.digest) throw validation("migration", "staged copy is incomplete or source changed; originals retained");
    }
    journal = { ...journal, phase: "staged" };
    atomicPrivateWrite(journalPath, JSON.stringify(journal));
    return journal;
  });
}

/** Retry recognizes either side of each rename. Originals remain in named retired paths. */
export async function activateRelocation(journalPath: string): Promise<RelocationJournal> {
  return withRuntimeLock(dirname(journalPath), "storage-relocation", async () => {
    let journal = JSON.parse(safeRead(journalPath).toString()) as RelocationJournal;
    validateJournal(journal);
    if (journal.format !== "grounds.storage-relocation/v1" || !["staged", "activating", "activated"].includes(journal.phase)) throw validation("migration", "copies have not been staged");
    if (journal.phase === "activated") return journal;
    // Check every source before the first rename, including on retry.
    for (const entry of journal.entries) {
      const source = existsSync(entry.source) ? entry.source : entry.retired;
      if (treeDigest(source) !== entry.digest) throw validation("migration", "source changed before activation");
      const copy = existsSync(entry.staged) ? entry.staged : entry.target;
      if (treeDigest(copy) !== entry.digest) throw validation("migration", "copy changed before activation");
    }
    journal = { ...journal, phase: "activating" };
    atomicPrivateWrite(journalPath, JSON.stringify(journal));
    for (const entry of journal.entries) {
      if (existsSync(entry.source)) {
        if (existsSync(entry.retired)) throw validation("migration", "source and retired copy both exist");
        durableRenameNoReplace(entry.source, entry.retired);
      }
      if (existsSync(entry.staged)) {
        if (existsSync(entry.target)) throw validation("migration", "target became occupied");
        durableRenameNoReplace(entry.staged, entry.target);
      }
    }
    journal = { ...journal, phase: "activated" };
    atomicPrivateWrite(journalPath, JSON.stringify(journal));
    return journal;
  });
}
