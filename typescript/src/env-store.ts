import { existsSync, readdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { flockSync } from "fs-ext";
import { stateConflict, validation } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { atomicPrivateWrite, privateDirectory, runtimeRoot, safeRead } from "./runtime-files.js";

export const requireId = (field: string, value: string): string => {
  if (!isUUIDv7(value)) throw validation(field, "must be a UUIDv7 identifier");
  return value;
};

export const environmentStoreRoot = (): string => privateDirectory(join(runtimeRoot(), "environments"));

export const baseDirectory = (identity: string): string => {
  const hex = identity.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw validation("base_digest", "must be a sha256 digest");
  return join(environmentStoreRoot(), "bases", hex);
};

export const environmentDirectory = (id: string): string => join(environmentStoreRoot(), "instances", requireId("environment_id", id));

export const runDirectory = (environmentId: string, runId: string): string =>
  join(environmentDirectory(environmentId), "runs", requireId("run_id", runId));

export const writeRecord = (path: string, value: unknown): void => atomicPrivateWrite(path, `${JSON.stringify(value, null, 2)}\n`);

export const readRecord = <T>(path: string): T => JSON.parse(safeRead(path, 1024 * 1024).toString("utf8")) as T;

const childDirectories = (directory: string): string[] => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(directory, entry.name));
};

export const instanceDirectories = (): string[] => childDirectories(join(environmentStoreRoot(), "instances"));

/** Finds the run record for an identifier across every environment instance on this machine. */
export const findRunFile = (runId: string): string | undefined => {
  requireId("run_id", runId);
  for (const instance of instanceDirectories()) {
    const file = join(instance, "runs", runId, "run.json");
    if (existsSync(file)) return file;
  }
  return undefined;
};

export const runFilesOf = (environmentDirectoryPath: string): string[] =>
  childDirectories(join(environmentDirectoryPath, "runs")).map((directory) => join(directory, "run.json")).filter((file) => existsSync(file));

/** Short host operation lock serializes dispatch, handoff and finalization; persistent run state survives its release. */
export const withEnvironmentOperation = <T>(id: string, action: () => T): T => {
  const directory=environmentDirectory(requireId("environment_id",id));
  if(!existsSync(join(directory,"environment.json")))throw validation("environment_id","no environment with this identifier");
  const file = join(directory, "operation.lock");
  const fd = openSync(file,"a",0o600);
  try { try { flockSync(fd,"exnb"); } catch { throw stateConflict("environment",id,"another controller is updating this instance"); } return action(); }
  finally { closeSync(fd); }
};
