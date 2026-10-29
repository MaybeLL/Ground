import { constants, existsSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface EntryStat {
  kind: "file" | "directory" | "link" | "other";
  mode: number;
  nlink: number;
  size: number;
  identity: string;
}
interface NativeSafeTree {
  directoryEntries(fd: number): string[];
  entryStat(fd: number, name: string): EntryStat;
  openEntry(fd: number, name: string, directory: boolean): number;
  entryLink(fd: number, name: string): string;
  replaceEntry(fd: number, name: string, bytes: Buffer, mode: number, link: boolean): void;
  removeEntry(fd: number, name: string, directory: boolean): void;
  parkEntry(fd: number, name: string, destination: number, saved: string): void;
  mkdirEntry(fd: number, name: string): void;
}
let native: NativeSafeTree | undefined;
function binding(): NativeSafeTree {
  if (native) return native;
  const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(sourceDirectory, "..", "build", "Release", "peercred.node"),
    join(sourceDirectory, "..", "..", "build", "Release", "peercred.node"),
  ];
  const path = candidates.find(existsSync);
  if (!path) throw Error("safe directory traversal binding is unavailable");
  native = createRequire(import.meta.url)(path) as NativeSafeTree;
  return native;
}
export function openDirectory(path: string): number {
  binding(); // Fail before touching a container writable tree if the native guard is absent.
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}
export const directoryEntries = (fd: number): string[] => binding().directoryEntries(fd);
export const entryStat = (fd: number, name: string): EntryStat => binding().entryStat(fd, name);
export const openEntry = (fd: number, name: string, directory: boolean): number =>
  binding().openEntry(fd, name, directory);
export const entryLink = (fd: number, name: string): string => binding().entryLink(fd, name);
/** Grouped operations keep a single, replaceable seam for deterministic race tests. */
export const safeTree = { openDirectory, directoryEntries, entryStat, openEntry, entryLink };
/** Mutation operations are separate from the read-only capture seam. */
export const safeTreeWrite = {
  replaceEntry: (fd: number, name: string, bytes: Buffer, mode: number, link = false): void => binding().replaceEntry(fd, name, bytes, mode, link),
  removeEntry: (fd: number, name: string, directory = false): void => binding().removeEntry(fd, name, directory),
  mkdirEntry: (fd: number, name: string): void => binding().mkdirEntry(fd, name),
  parkEntry: (fd: number, name: string, destination: number, saved: string): void => binding().parkEntry(fd, name, destination, saved),
};
