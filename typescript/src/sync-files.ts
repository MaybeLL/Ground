import { closeSync, fstatSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./canonical-json.js";
import { validation } from "./errors.js";
import { newUUIDv7 } from "./identity.js";
import { atomicPrivateWrite, digestBytes, privateDirectory, safeRead, safeReadOpened } from "./runtime-files.js";
import { safeTree, safeTreeWrite } from "./safe-tree.js";
import { isEnvironmentDefinitionPath } from "./grounds-exclude.js";

type Entry = { kind: "file"; mode: number; digest: string; size: number } | { kind: "link"; target: string } | { kind: "directory" };
export interface SyncFiles { format: "grounds.sync-files/v1"; entries: Record<string, Entry>; digest: string }
const bad = (reason: string): never => { throw validation("sync.files", reason); };
const environmentAncestor = (path: string): boolean => path === ".grounds" || path === ".grounds/environments";
export function syncPath(path: string): string {
  if (!path || path.length > 4096 || path.includes("\0") || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) bad("unsafe or reserved recovery path");
  if (path.split("/").some(p => p.toLowerCase() === ".grounds") && !isEnvironmentDefinitionPath(path) && !environmentAncestor(path)) bad("unsafe or reserved recovery path");
  return path;
}
const signature = (entries: Record<string, Entry>): string => sha256(entries);
export function validateSyncFiles(value: SyncFiles): SyncFiles {
  if (value.format !== "grounds.sync-files/v1" || !value.entries || Array.isArray(value.entries) || Object.keys(value.entries).length > 100000 || value.digest !== signature(value.entries)) bad("snapshot integrity mismatch");
  for (const [path, entry] of Object.entries(value.entries)) {
    syncPath(path);
    if (!entry || !["file", "link", "directory"].includes(entry.kind)) bad("unsupported snapshot entry");
    if (environmentAncestor(path) && entry.kind !== "directory") bad("environment declaration ancestors must be directories");
    if (isEnvironmentDefinitionPath(path) && entry.kind !== "file") bad("environment declarations must be regular files");
    if (entry.kind === "file" && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !/^sha256:[a-f0-9]{64}$/.test(entry.digest) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024)) bad("invalid file metadata");
    if (entry.kind === "link" && (typeof entry.target !== "string" || !entry.target || entry.target.includes("\0"))) bad("invalid link metadata");
    let parent = dirname(path);
    while (parent !== ".") {
      if (value.entries[parent]?.kind !== "directory") bad("snapshot parent is missing or is a symlink");
      parent = dirname(parent);
    }
  }
  return value;
}
const blobPath = (directory: string, digest: string): string => join(directory, "blobs", digest.slice(7));

/** Capture selected paths using pinned no-follow descriptors, retaining raw bytes and permission bits. */
export function snapshotSyncFiles(cwd: string, paths: string[], directory?: string): SyncFiles {
  const selected = new Set(paths.map(syncPath)), ancestors = new Set<string>();
  for (const path of selected) { let parent = dirname(path); while (parent !== ".") { ancestors.add(parent); parent = dirname(parent); } }
  if (directory) mkdirSync(join(directory, "blobs"), { recursive: true, mode: 0o700 });
  const root = safeTree.openDirectory(cwd), rootStat = fstatSync(root, { bigint: true });
  const scan = (save: boolean): Record<string, Entry> => {
    const entries: Record<string, Entry> = Object.create(null);
    let count = 0, total = 0;
    const walk = (fd: number, prefix: string): number => {
      let found = 0;
      for (const name of safeTree.directoryEntries(fd).sort()) {
        const path = prefix ? prefix + "/" + name : name;
        if (!selected.has(path) && !ancestors.has(path)) continue;
        syncPath(path);
        if (++count > 100000) bad("too many recovery entries");
        const st = safeTree.entryStat(fd, name);
        if (environmentAncestor(path) && st.kind !== "directory") bad("environment declaration ancestors must be directories");
        if (isEnvironmentDefinitionPath(path) && st.kind !== "file") bad("environment declarations must be regular files");
        if (st.kind === "directory") {
          entries[path] = { kind: "directory" };
          const child = safeTree.openEntry(fd, name, true);
          try {
            const opened = fstatSync(child, { bigint: true });
            if (`${opened.dev}:${opened.ino}` !== st.identity) bad("directory changed during snapshot");
            const nested = walk(child, path);
            if (selected.has(path) || nested) found += nested + 1;
            else delete entries[path];
          } finally { closeSync(child); }
        } else if (st.kind === "link") {
          found++;
          entries[path] = { kind: "link", target: safeTree.entryLink(fd, name) };
          if (safeTree.entryStat(fd, name).identity !== st.identity) bad("symlink changed during snapshot");
        } else {
          if (st.kind !== "file" || st.nlink !== 1 || (st.mode & 0o7000) !== 0 || st.size > 64 * 1024 * 1024 || (total += st.size) > 256 * 1024 * 1024) bad("unsupported or oversized recovery input");
          const file = safeTree.openEntry(fd, name, false);
          try {
            const before = fstatSync(file, { bigint: true });
            if (`${before.dev}:${before.ino}` !== st.identity || Number(before.mode) !== st.mode) bad("file changed before snapshot");
            const bytes = safeReadOpened(file, 64 * 1024 * 1024), after = fstatSync(file, { bigint: true });
            if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) bad("file changed while reading snapshot");
            const digest = digestBytes(bytes);
            found++;
            entries[path] = { kind: "file", mode: st.mode & 0o777, digest, size: bytes.length };
            if (save && directory) atomicPrivateWrite(blobPath(directory, digest), bytes);
          } finally { closeSync(file); }
        }
      }
      return found;
    };
    walk(root, ""); return entries;
  };
  try {
    const entries = scan(Boolean(directory)), after = scan(false), now = lstatSync(cwd, { bigint: true });
    if (signature(entries) !== signature(after) || !now.isDirectory() || now.dev !== rootStat.dev || now.ino !== rootStat.ino) bad("worktree changed during snapshot");
    const snapshot: SyncFiles = { format: "grounds.sync-files/v1", entries, digest: signature(entries) };
    validateSyncFiles(snapshot);
    if (directory) atomicPrivateWrite(join(directory, "files.json"), JSON.stringify(snapshot));
    return snapshot;
  } finally { closeSync(root); }
}

/** No recursive deletes, no path-based writes through symlinks. Caller owns the durable phase and run lock. */
export function installSyncFiles(cwd: string, before: SyncFiles, after: SyncFiles, blobDirectory: string, checkpoint: (path: string) => void = () => {}): void {
  validateSyncFiles(before); validateSyncFiles(after);
  const paths = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])];
  const current = snapshotSyncFiles(cwd, paths);
  if (current.digest !== before.digest) bad("worktree drift; snapshot current edits before any recovery retry");
  // Validate every payload before changing the first file.
  for (const entry of Object.values(after.entries)) if (entry.kind === "file") {
    const bytes = safeRead(blobPath(blobDirectory, entry.digest), 64 * 1024 * 1024);
    if (bytes.length !== entry.size || digestBytes(bytes) !== entry.digest) bad("recovery blob is missing or corrupt");
  }
  const verifyEntry = (fd: number, name: string, expected: Entry | undefined): void => {
    if (!expected) {
      if (safeTree.directoryEntries(fd).includes(name)) bad("a new entry appeared during sync; preserve it before retrying");
      return;
    }
    const st = safeTree.entryStat(fd, name);
    if (st.kind !== expected.kind) bad("entry type changed during sync");
    if (expected.kind === "link" && safeTree.entryLink(fd, name) !== expected.target) bad("link changed during sync");
    if (expected.kind === "file") {
      const file = safeTree.openEntry(fd, name, false);
      try { if ((st.mode & 0o777) !== expected.mode || digestBytes(safeReadOpened(file, 64 * 1024 * 1024)) !== expected.digest) bad("file changed during sync; preserve edits before retrying"); }
      finally { closeSync(file); }
    }
  };
  const displaced = privateDirectory(join(blobDirectory, "displaced"));
  const recoveryFd = safeTree.openDirectory(displaced);
  const park = (fd: number, name: string, path: string): void => {
    const id = newUUIDv7();
    atomicPrivateWrite(join(displaced, id + ".json"), JSON.stringify({ path, entry: id + ".data" }));
    safeTreeWrite.parkEntry(fd, name, recoveryFd, id + ".data");
  };
  const root = safeTree.openDirectory(cwd), openedRoot = fstatSync(root, { bigint: true });
  const withParent = (path: string, apply: (fd: number, name: string) => void): void => {
    const parts = syncPath(path).split("/"), name = parts.pop()!;
    let fd = root;
    const owned: number[] = [];
    try {
      for (const part of parts) { fd = safeTree.openEntry(fd, part, true); owned.push(fd); }
      const now = lstatSync(cwd, { bigint: true });
      if (!now.isDirectory() || now.dev !== openedRoot.dev || now.ino !== openedRoot.ino) bad("worktree identity changed");
      apply(fd, name);
    } finally { for (const handle of owned.reverse()) closeSync(handle); }
  };
  try {
    for (const path of Object.keys(before.entries).sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a))) {
      const prior = before.entries[path]!, next = after.entries[path];
      if (!next || next.kind !== prior.kind) {
        withParent(path, (fd, name) => {
          verifyEntry(fd, name, prior);
          if (prior.kind === "directory" && !next) {
            const child = safeTree.openEntry(fd, name, true);
            try { if (safeTree.directoryEntries(child).length) return; } finally { closeSync(child); }
          }
          if (prior.kind === "directory") safeTreeWrite.removeEntry(fd, name, true);
          else park(fd, name, path);
        }); checkpoint(path);
      }
    }
    for (const path of Object.keys(after.entries).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
      const next = after.entries[path]!, prior = before.entries[path];
      if (prior && sha256(prior) === sha256(next)) continue;
      withParent(path, (fd, name) => {
        verifyEntry(fd, name, prior?.kind === next.kind ? prior : undefined);
        if (prior?.kind === next.kind && next.kind !== "directory") park(fd, name, path);
        if (next.kind === "directory") safeTreeWrite.mkdirEntry(fd, name);
        else if (next.kind === "link") safeTreeWrite.replaceEntry(fd, name, Buffer.from(next.target), 0, true);
        else safeTreeWrite.replaceEntry(fd, name, safeRead(blobPath(blobDirectory, next.digest), 64 * 1024 * 1024), next.mode);
      });
      checkpoint(path);
    }
    const finalPaths = [...new Set([...Object.keys(after.entries), ...Object.keys(before.entries).filter(p => before.entries[p]!.kind !== "directory")])];
    if (snapshotSyncFiles(cwd, finalPaths).digest !== after.digest) bad("worktree drift during application; preserve recovery material");
  } finally { closeSync(root); closeSync(recoveryFd); }
}
