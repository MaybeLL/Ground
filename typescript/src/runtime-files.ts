import { dataLayout } from "./data-layout.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  constants,
  lstatSync,
  realpathSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { runtimeError } from "./runtime-record.js";
import { DomainError, validation } from "./errors.js";
export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  let cursor: string = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const st = lstatSync(cursor);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw validation("path", "symlink/non-directory in managed path");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      try {
        mkdirSync(cursor, { mode: 0o700 });
      } catch (x: any) {
        if (x.code !== "EEXIST") throw x;
      }
      const st = lstatSync(cursor);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw validation(
          "path",
          "managed directory creation raced with another writer",
        );
    }
  }
  const st = lstatSync(absolute);
  if (st.uid !== process.getuid?.())
    throw validation("path", "managed directory is owned by another user");
  chmodSync(absolute, 0o700);
  return absolute;
}
const runtimeDirectoryScope = new AsyncLocalStorage<{ runtimeHome: string; directoryRegistryHome: string }>();
/** Embedded harness seam. The installed CLI exposes no registry-root override;
 * production roots remain shared for every local user's execution surface. */
export function withRuntimeDirectories<T>(directories: { runtimeHome: string; directoryRegistryHome: string }, action: () => T): T {
  return runtimeDirectoryScope.run(directories, action);
}
export function runtimeRoot(): string {
  return privateDirectory(
    runtimeDirectoryScope.getStore()?.runtimeHome ?? process.env.GROUNDS_RUNTIME_HOME ??
      join(dataLayout().runtime, "env"),
  );
}
/** Directory reservations must be shared by every runtime root of this local user. */
export function directoryRegistryLocation(): string {
  return runtimeDirectoryScope.getStore()?.directoryRegistryHome ?? dataLayout().directoryRegistry;
}
export function directoryRegistryRoot(): string {
  return privateDirectory(directoryRegistryLocation());
}
export function digestBytes(bytes: Buffer): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
export function safeRead(path: string, maximum = 64 * 1024 * 1024): Buffer {
  // A concurrent `atomicPrivateWrite` can replace the path between `open` and
  // the first `fstat`; the reader then holds the old inode with nlink 0. Retry
  // to read the current file instead of failing the command.
  for (let attempt = 0; ; attempt += 1) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (attempt < 8 && fstatSync(fd).nlink === 0) continue;
      return safeReadOpened(fd, maximum);
    } catch (error) {
      if (attempt < 8 && error instanceof DomainError && (error.details as { reason?: unknown }).reason === REPLACED_WHILE_OPEN) continue;
      throw error;
    } finally {
      closeSync(fd);
    }
  }
}
/** Distinguishes "the path was atomically replaced while open" from a real hard link. */
const REPLACED_WHILE_OPEN = "file was replaced while reading";
/** Read an already opened no-follow file descriptor without reopening its path.
 *
 * nlink 0 means the path was replaced by `renameSync` after `open`, so the
 * descriptor now holds an unlinked inode; that is reported separately from a
 * genuine hard link (nlink > 1) so callers that pin a descriptor keep the strict
 * rule while path-based reads can retry.
 */
export function safeReadOpened(fd: number, maximum = 64 * 1024 * 1024): Buffer {
  const st = fstatSync(fd);
  if (st.nlink === 0)
    throw validation("file", REPLACED_WHILE_OPEN);
  if (!st.isFile() || st.size > maximum || st.nlink !== 1)
    throw validation(
      "file",
      "expected bounded regular file without hard links",
    );
  const bytes = readFileSync(fd),
    after = fstatSync(fd);
  if (
    bytes.length > maximum ||
    bytes.length !== st.size ||
    after.size !== st.size ||
    after.mtimeMs !== st.mtimeMs ||
    after.ctimeMs !== st.ctimeMs ||
    after.nlink !== 1
  )
    throw validation("file", after.nlink === 0 ? REPLACED_WHILE_OPEN : "file changed while reading");
  return bytes;
}
export function atomicPrivateWrite(path: string, data: Buffer | string): void {
  privateDirectory(dirname(path));
  const temp = join(dirname(path), "." + randomUUID());
  const fd = openSync(
    temp,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
/** Long-lived readers (such as draft editors) hold this until their service closes. */
export async function acquireRuntimeLease(root: string, key: string, mode: "exclusive" | "shared"): Promise<() => void> {
  const { flock } = await import("fs-ext");
  const path = join(privateDirectory(join(root, "locks")), createHash("sha256").update(key).digest("hex") + ".lock");
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise<void>((yes, no) => flock(fd, mode === "shared" ? "shnb" : "exnb", error => error ? no(error) : yes()));
  } catch {
    closeSync(fd);
    throw runtimeError("busy: another local controller holds the operation lock", undefined, "busy");
  }
  let released = false;
  return () => { if (!released) { released = true; closeSync(fd); } };
}

export async function withRuntimeLock<T>(
  root: string,
  key: string,
  fn: () => Promise<T>,
  waitMs = 0,
  mode: "exclusive" | "shared" = "exclusive",
): Promise<T> {
  const { flock } = await import("fs-ext");
  const path = join(
    privateDirectory(join(root, "locks")),
    createHash("sha256").update(key).digest("hex") + ".lock",
  );
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  const lock = (op: "exnb" | "shnb") =>
    new Promise<void>((yes, no) =>
      flock(fd, op, (err) => (err ? no(err) : yes())),
    );
  const deadline = performance.now() + waitMs;
  try {
    for (;;) {
      try {
        await lock(mode === "shared" ? "shnb" : "exnb");
        break;
      } catch (error: any) {
        const contended = ["EAGAIN", "EWOULDBLOCK"].includes(error.code);
        if (waitMs > 0 && performance.now() < deadline && contended) {
          // Never block libuv's worker pool on flock: multiple waiters can
          // otherwise starve the owner's asynchronous work. Only acquisition
          // is retried; the protected operation is invoked exactly once.
          await new Promise(resolve => setTimeout(resolve, 25));
          continue;
        }
        if (waitMs > 0 && !contended) throw error;
        throw runtimeError(
          "busy: another local controller holds the operation lock",
          undefined,
          "busy",
        );
      }
    }
    return await fn();
  } finally {
    closeSync(fd);
  }
}
export function hostIdentity(root: string): string {
  privateDirectory(root);
  const path = join(root, "host-id");
  try {
    const id = safeRead(path, 128).toString().trim();
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw validation("host_id", "invalid host identity");
    return id;
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    try {
      writeFileSync(path, randomUUID(), { flag: "wx", mode: 0o600 });
    } catch (x: any) {
      if (x.code !== "EEXIST") throw x;
    }
    return hostIdentity(root);
  }
}
export function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}
export function existingDirectory(path: string): string {
  if (!isAbsolute(path))
    throw validation("directory", "absolute path required");
  const real = realpathSync(path);
  if (!lstatSync(real).isDirectory())
    throw validation("directory", "directory required");
  return real;
}
/** Only remove our regular private files, never follow a link or recursively delete a supplied project path. */
export function removePrivateFile(path: string): void {
  const st = lstatSync(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid?.() ||
    st.nlink !== 1
  )
    throw validation("file", "not an owned private file");
  unlinkSync(path);
}
export function managedChildren(root: string): string[] {
  return readdirSync(privateDirectory(root));
}
