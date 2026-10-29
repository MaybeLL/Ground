import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliVersion } from "./runtime-version.js";
import { defaultSkillsDirectory, skillNames } from "./skill-installer.js";

export const GROUNDS_PACKAGE = "@grounds-review/grounds";
export const GROUNDS_REGISTRY = "https://registry.invalid";

type VersionState = "current" | "outdated" | "ahead" | "unknown" | "missing" | "mixed";

export interface InstallationStatusResult {
  result_type: "patchledger.result.doctor/v1";
  command: "doctor";
  cli: { installed_version: string; registry_version?: string; status: VersionState };
  skills: { target_path: string; installed_version?: string; status: VersionState; details: Array<{ name: string; status: VersionState; installed_version?: string }> };
  upgrade_required: boolean;
  recommended_commands: string[];
  warnings: Array<{ code: string; message: string }>;
}

const core = (version: string): [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};

const compareVersions = (left: string, right: string): number | undefined => {
  const a = core(left); const b = core(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return left === right ? 0 : left.includes("-") && !right.includes("-") ? -1 : !left.includes("-") && right.includes("-") ? 1 : left < right ? -1 : 1;
};

const versionState = (installed: string, expected: string): VersionState => {
  const comparison = compareVersions(installed, expected);
  return comparison === undefined ? "unknown" : comparison < 0 ? "outdated" : comparison > 0 ? "ahead" : "current";
};

export const registryVersion = (): string => {
  throw new Error("Registry version checks are disabled in the review snapshot");
};

const installedSkill = (target: string, name: string): { name: string; status: VersionState; installed_version?: string } => {
  const directory = join(target, name);
  if (!existsSync(join(directory, "SKILL.md"))) return { name, status: "missing" };
  try {
    const marker = JSON.parse(readFileSync(join(directory, ".grounds-managed.json"), "utf8")) as Record<string, unknown>;
    if (marker.format !== "patchledger.skill-install/v1" || marker.skill !== name) return { name, status: "unknown" };
    if (typeof marker.package_version !== "string") return { name, status: "unknown" };
    const installed = marker.package_version;
    return { name, status: versionState(installed, cliVersion()), installed_version: installed };
  } catch { return { name, status: "unknown" }; }
};

export const installationStatus = (skillsPath = defaultSkillsDirectory(), fetchRegistryVersion: () => string = registryVersion): InstallationStatusResult => {
  const installedVersion = cliVersion();
  const warnings: InstallationStatusResult["warnings"] = [];
  let latest: string | undefined;
  try { latest = fetchRegistryVersion(); } catch (error) {
    warnings.push({ code: "REGISTRY_VERSION_UNAVAILABLE", message: `Could not check ${GROUNDS_REGISTRY}: ${error instanceof Error ? error.message : String(error)}` });
  }
  const cliState = latest === undefined ? "unknown" : versionState(installedVersion, latest);
  const target = resolve(skillsPath);
  const details = skillNames.map((name) => installedSkill(target, name));
  const versions = new Set(details.map((item) => item.installed_version).filter((item): item is string => item !== undefined));
  const states = new Set(details.map((item) => item.status));
  const skillsState: VersionState = states.size === 1 ? details[0].status : "mixed";
  const skillVersion = versions.size === 1 ? [...versions][0] : undefined;
  const upgradeRequired = cliState === "outdated" || skillsState !== "current";
  const commands: string[] = [];
  if (cliState === "outdated") commands.push(`npm install --global ${GROUNDS_PACKAGE}@${latest} --registry=${GROUNDS_REGISTRY}`);
  if (cliState === "outdated" || skillsState !== "current") commands.push(`grounds install skill ${JSON.stringify(target)}`);
  return {
    result_type: "patchledger.result.doctor/v1", command: "doctor",
    cli: { installed_version: installedVersion, ...(latest ? { registry_version: latest } : {}), status: cliState },
    skills: { target_path: target, ...(skillVersion ? { installed_version: skillVersion } : {}), status: skillsState, details },
    upgrade_required: upgradeRequired, recommended_commands: commands, warnings,
  };
};
