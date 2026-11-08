import { nativeBinding } from "./native-binding.js";
import { execFileSync } from "node:child_process";
import {readFileSync,readlinkSync} from "node:fs";
import { randomBytes } from "node:crypto";
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
export interface HostProcessScope { marker: string; startedAtMs: number; platform?:"linux"|"darwin"; linuxBoot?:{id:string;uptimeMs:number;namespaces:string} }
export interface HostProcessIdentity { pid: number; identity: string }
export interface HostProcessObservation { complete: boolean; processes: HostProcessIdentity[] }
function linuxBootClock() {
  const id=readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();
  const uptimeMs=Math.floor(Number(readFileSync("/proc/uptime","utf8").split(" ")[0])*1000);
  if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isSafeInteger(uptimeMs) || uptimeMs<=0) throw Error("cannot read host boot clock");
  const namespaces=["time","pid","user","mnt"].map(name=>{
    try {return readlinkSync("/proc/self/ns/"+name);}
    catch (error) {
      // Kernels before Linux 5.6 do not support time namespaces.
      if (name==="time" && (error as NodeJS.ErrnoException).code==="ENOENT") return "time:initial";
      throw error;
    }
  }).join("/");
  return {id,uptimeMs,namespaces};
}
export const createHostProcessScope = (): HostProcessScope => {
  // Fail before launch when this installation cannot observe descendants.
  nativeBinding();
  if (process.platform!=="darwin" && process.platform!=="linux") throw Error("unsupported host process platform");
  return { platform:process.platform, marker: randomBytes(32).toString("hex"), startedAtMs: Date.now(), ...(process.platform==="linux" ? {linuxBoot:linuxBootClock()} : {}) };
};
const validScope = (scope: HostProcessScope): boolean => !!scope && /^[a-f0-9]{64}$/.test(scope.marker) && Number.isSafeInteger(scope.startedAtMs) && scope.startedAtMs > 0;
export function localHostScope(scope:HostProcessScope):boolean {
  if (!validScope(scope) || scope.platform!==undefined && scope.platform!==process.platform) return false;
  if (!scope.linuxBoot) return scope.platform!=="linux";
  if (process.platform!=="linux") return false;
  try {
    const clock=linuxBootClock(), recorded=scope.linuxBoot;
    return Number.isSafeInteger(recorded.uptimeMs) && recorded.uptimeMs>0 && recorded.id===clock.id &&
      recorded.namespaces===clock.namespaces && recorded.uptimeMs<=clock.uptimeMs;
  } catch {return false;}
}

export const hostProcessEnvironment = (scope: HostProcessScope): Record<string, string> => {
  if (!validScope(scope)) throw Error("invalid host process scope");
  return { GROUNDS_HOST_PROCESS_SCOPE: scope.marker };
};
/** Absence is confirmed only after a complete, stable native enumeration. Any
 * inaccessible possible descendant or enumeration failure keeps the run unknown.
 * With a fixed leader, Darwin may exclude stable untraced ancestry rooted in
 * a pre-scope non-task parent. Linux retains conservative subreaper handling. */
export const inspectHostProcessScope = (scope: HostProcessScope, leader?: HostProcessIdentity): HostProcessObservation => {
  if (!localHostScope(scope)) return {complete:false,processes:[]};
  try {
    if (scope.linuxBoot) return nativeBinding().hostProcessesSinceBoot(scope.marker,scope.linuxBoot.uptimeMs);
    return leader ? nativeBinding().hostProcesses(scope.marker, scope.startedAtMs, leader.pid, leader.identity) : nativeBinding().hostProcesses(scope.marker, scope.startedAtMs); }
  catch { return { complete: false, processes: [] }; }
};
/** Native checks birth and marker again immediately before signalling. Never
 * signal a PGID or a PID supplied without its observed birth identity. */
export const signalHostProcessIdentity = (scope: HostProcessScope, process: HostProcessIdentity, signal: "SIGTERM" | "SIGKILL"): boolean => {
  if (!localHostScope(scope)) return false;
  return nativeBinding().signalHostProcess(process.pid, process.identity, scope.marker, signal === "SIGTERM" ? 15 : 9);
};
export const signalHostProcessScope = (scope: HostProcessScope, signal: "SIGTERM" | "SIGKILL", leader?: HostProcessIdentity): HostProcessObservation => {
  const observation = inspectHostProcessScope(scope, leader);
  for (const process of observation.processes) signalHostProcessIdentity(scope, process, signal);
  return inspectHostProcessScope(scope, leader);
};

/** Read native, subsecond birth identity while the newly spawned leader lives. */
export const hostProcessIdentity = (pid: number): string | undefined => nativeBinding().hostProcessIdentity(pid);
/** Signal the original PGID only while its original leader still matches. */
export const signalHostProcessLeader = (pid: number, identity: string, signal: "SIGTERM" | "SIGKILL", scope?:HostProcessScope): boolean =>
  (!scope || localHostScope(scope)) && nativeBinding().signalHostProcessLeader(pid, identity, signal === "SIGTERM" ? 15 : 9);
