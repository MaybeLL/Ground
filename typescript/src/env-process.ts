import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
export const isProcessAlive = (pid: number): boolean => {try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}};
export const processIdentity = (pid: number): string | undefined => {try{return execFileSync("ps",["-p",String(pid),"-o","lstart="],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim()||undefined;}catch{return undefined;}};
/** Check the entire detached process group, including children after the original command exits. */
export const processGroupStopped = (pid: number): boolean => {
  const groups=execFileSync("ps",["-axo","pgid="],{encoding:"utf8"}).split("\n").map(s=>Number(s.trim()));
  return !groups.includes(pid);
};
export const signalProcessGroup = (pid: number, signal: NodeJS.Signals): boolean => {try{process.kill(-pid,signal);return true;}catch(error){if(["ESRCH","EPERM"].includes((error as NodeJS.ErrnoException).code??""))return false;throw error;}};

/** Persist this random scope before launch. It identifies ordinary descendants
 * even after setsid()/reparenting; host tasks remain trusted (no OS isolation). */
export interface HostProcessScope { marker: string; startedAtMs: number }
export interface HostProcessIdentity { pid: number; identity: string }
export interface HostProcessObservation { complete: boolean; processes: HostProcessIdentity[] }
interface NativeHostProcesses {
  hostProcessIdentity(pid: number): string | undefined;
  signalHostProcessLeader(pid: number, identity: string, signal: number): boolean;
  hostProcesses(marker: string, startedAtMs: number, leaderPid?: number, leaderIdentity?: string): HostProcessObservation;
  signalHostProcess(pid: number, identity: string, marker: string, signal: number): boolean;
}
let hostBinding: NativeHostProcesses | undefined;
function nativeHostProcesses(): NativeHostProcesses {
  if (hostBinding) return hostBinding;
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const path = [join(directory, "..", "build", "Release", "peercred.node"), join(directory, "..", "..", "build", "Release", "peercred.node")].find(existsSync);
  if (!path) throw Error("host process inspection binding is unavailable; retaining resources");
  const loaded = createRequire(import.meta.url)(path) as NativeHostProcesses;
  if (typeof loaded.hostProcesses !== "function" || typeof loaded.signalHostProcess !== "function" || typeof loaded.hostProcessIdentity !== "function" || typeof loaded.signalHostProcessLeader !== "function") throw Error("host process inspection binding is unavailable; retaining resources");
  return hostBinding = loaded;
}
export const createHostProcessScope = (): HostProcessScope => {
  // Fail before launch when this installation cannot observe descendants.
  nativeHostProcesses();
  return { marker: randomBytes(32).toString("hex"), startedAtMs: Date.now() };
};
const validScope = (scope: HostProcessScope): boolean => !!scope && /^[a-f0-9]{64}$/.test(scope.marker) && Number.isSafeInteger(scope.startedAtMs) && scope.startedAtMs > 0;
export const hostProcessEnvironment = (scope: HostProcessScope): Record<string, string> => {
  if (!validScope(scope)) throw Error("invalid host process scope");
  return { GROUNDS_HOST_PROCESS_SCOPE: scope.marker };
};
/** Absence is confirmed only after a complete, stable native enumeration. Any
 * inaccessible possible descendant or enumeration failure keeps the run unknown.
 * With a fixed leader, Darwin may exclude stable untraced ancestry rooted in
 * a pre-scope non-task parent. Linux retains conservative subreaper handling. */
export const inspectHostProcessScope = (scope: HostProcessScope, leader?: HostProcessIdentity): HostProcessObservation => {
  if (!validScope(scope)) return { complete: false, processes: [] };
  try { return leader ? nativeHostProcesses().hostProcesses(scope.marker, scope.startedAtMs, leader.pid, leader.identity) : nativeHostProcesses().hostProcesses(scope.marker, scope.startedAtMs); }
  catch { return { complete: false, processes: [] }; }
};
/** Native checks birth and marker again immediately before signalling. Never
 * signal a PGID or a PID supplied without its observed birth identity. */
export const signalHostProcessIdentity = (scope: HostProcessScope, process: HostProcessIdentity, signal: "SIGTERM" | "SIGKILL"): boolean => {
  if (!validScope(scope)) return false;
  return nativeHostProcesses().signalHostProcess(process.pid, process.identity, scope.marker, signal === "SIGTERM" ? 15 : 9);
};
export const signalHostProcessScope = (scope: HostProcessScope, signal: "SIGTERM" | "SIGKILL", leader?: HostProcessIdentity): HostProcessObservation => {
  const observation = inspectHostProcessScope(scope, leader);
  for (const process of observation.processes) signalHostProcessIdentity(scope, process, signal);
  return inspectHostProcessScope(scope, leader);
};

/** Read native, subsecond birth identity while the newly spawned leader lives. */
export const hostProcessIdentity = (pid: number): string | undefined => nativeHostProcesses().hostProcessIdentity(pid);
/** Signal the original PGID only while its original leader still matches. */
export const signalHostProcessLeader = (pid: number, identity: string, signal: "SIGTERM" | "SIGKILL"): boolean =>
  nativeHostProcesses().signalHostProcessLeader(pid, identity, signal === "SIGTERM" ? 15 : 9);
