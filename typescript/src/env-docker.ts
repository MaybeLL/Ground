import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readRecord, environmentDirectory } from "./env-store.js";
import type { EnvironmentRequirements } from "./env-definition.js";
import { DomainError, stateConflict } from "./errors.js";

export const docker = (args: string[], timeout = 60_000): string => {
  try { return execFileSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) { throw new DomainError("ENVIRONMENT_SETUP_FAILED", "Docker operation failed; no host fallback was attempted", true, { operation: args[0], diagnostic: String((error as { stderr?: unknown }).stderr ?? "engine unavailable").slice(0, 2048) }); }
};
export const probeDocker = (): void => {
  const info = JSON.parse(docker(["info", "--format", "{{json .}}"]));
  if (info.OSType !== "linux" || info.MemoryLimit !== true || info.CpuCfsQuota !== true || info.PidsLimit !== true)
    throw new DomainError("ENVIRONMENT_CAPABILITY_UNSUPPORTED", "Docker must support Linux, CPU, memory and process limits", false, { unmet: [...(info.OSType!=="linux" ? ["workspace_write"] : []), ...(info.MemoryLimit!==true ? ["memory"] : []), ...(info.CpuCfsQuota!==true ? ["cpu"] : []), ...(info.PidsLimit!==true ? ["pids"] : [])] });
};
export const resourceArguments = (requirements: EnvironmentRequirements): string[] => ["--cpus", String(requirements.cpu), "--memory", String(requirements.memory), "--pids-limit", String(requirements.pids)];
export const assertEnvironmentEngine = (environmentId: string): void => {
  const record=readRecord<{engine_id?:string}>(join(environmentDirectory(environmentId),"environment.json"));
  if(!record.engine_id || docker(["info","--format","{{.ID}}"])!==record.engine_id) throw stateConflict("environment",environmentId,"Docker engine identity changed or cannot be proven; retain task resources");
};
export const ownedContainerExists = (id:string, environmentId:string): boolean => {
  assertEnvironmentEngine(environmentId);
  return docker(["ps","-aq","--no-trunc","--filter",`id=${id}`]).split("\n").includes(id);
};
export interface DockerState { Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean; Status: string; ExitCode: number; OOMKilled: boolean; Error: string; FinishedAt: string } }
export const inspectOwnedContainer = (id: string, environmentId: string): DockerState => {
  assertEnvironmentEngine(environmentId);
  const result = JSON.parse(docker(["inspect", id]))[0] as DockerState;
  if (result.Id !== id || result.Config.Labels["grounds.environment"] !== environmentId)
    throw stateConflict("environment", environmentId, "container ownership is unknown; retaining resources");
  return result;
};
export const stopOwnedContainer = (id: string, environmentId: string): DockerState => {
  const state = inspectOwnedContainer(id, environmentId);
  if (state.State.Running) docker(["stop", "--time", "2", id]);
  const stopped = inspectOwnedContainer(id, environmentId);
  if (stopped.State.Running) throw stateConflict("environment", environmentId, "execution has not stopped");
  return stopped;
};
export const removeOwnedContainer = (id: string, environmentId: string): void => {
  if(!ownedContainerExists(id,environmentId))return;
  const state = inspectOwnedContainer(id, environmentId);
  if (state.State.Running) throw stateConflict("environment", environmentId, "cannot remove a running container");
  docker(["rm", "--volumes", id]);
};
