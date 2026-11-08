import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface NativeBinding {
  tryLock(fd: number, shared: boolean): void;
  hostProcessIdentity(pid: number): string | undefined;
  signalHostProcessLeader(pid: number, identity: string, signal: number): boolean;
  hostProcesses(marker: string, startedAtMs: number, leaderPid?: number, leaderIdentity?: string): import("./env-process.js").HostProcessObservation;
  signalHostProcess(pid: number, identity: string, marker: string, signal: number): boolean;
}
let binding: NativeBinding | undefined;
export function nativeBinding(): NativeBinding {
  if (binding) return binding;
  const source = dirname(fileURLToPath(import.meta.url));
  const root = existsSync(join(source, "..", "package.json")) ? join(source, "..") : join(source, "..", "..");
  const path = join(root, "prebuilds", `${process.platform}-${process.arch}`, "peercred.node");
  if (!existsSync(path)) throw new Error(`Grounds native support is unavailable for ${process.platform}-${process.arch}; retaining resources`);
  const loaded = createRequire(import.meta.url)(path) as NativeBinding;
  for (const key of ["tryLock", "hostProcesses", "hostProcessIdentity", "signalHostProcessLeader", "signalHostProcess"] as const) {
    if (typeof loaded[key] !== "function") throw new Error(`Grounds native support lacks ${key}; retaining resources`);
  }
  return binding = loaded;
}

export const flockSync = (fd: number, mode: "exnb" | "shnb"): void => nativeBinding().tryLock(fd, mode === "shnb");

export const lockContended = (error: unknown): boolean =>
  error instanceof Error && ["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "");
