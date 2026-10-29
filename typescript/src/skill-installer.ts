import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validation } from "./errors.js";
import { cliVersion } from "./runtime-version.js";
import { assembleSkillAssets, isSkillAssetsRoot, skillNames, type SkillName } from "./skill-assets.js";

export { skillNames } from "./skill-assets.js";

export const legacySkillNames = [
  "grounds-define",
  "grounds-develop",
  "grounds-verify",
  "grounds-deliver",
  "grounds-guide",
  "grounds-eval-author",
  "grounds-eval-run",
  "grounds-export-confluence",

  "patchledger-define",
  "patchledger-develop",
  "patchledger-verify",
  "patchledger-deliver",
  "patchledger-guide",
  "patchledger-eval-author",
  "patchledger-eval-run",
  "patchledger-export-confluence",
  "patchledger-refine",
  "patchledger-model-work",
  "patchledger-develop-candidate",
  "patchledger-verify-candidate",
  "patchledger-compare-deliver",
] as const;

const markerName = ".grounds-managed.json";
const markerFormat = "patchledger.skill-install/v1";
const legacyMarkerName = ".patchledger-managed.json";

interface Marker {
  format: typeof markerFormat;
  skill: string;
  package_version?: string;
}

export interface InstalledSkill {
  name: string;
  path: string;
}

export interface SkillInstallResult {
  result_type: "patchledger.result.skill-install/v1";
  command: "install.skill";
  target_path: string;
  skills: InstalledSkill[];
}

export const defaultSkillsDirectory = (home = homedir()): string => join(home, ".agents", "skills");

export const bundledPluginRoot = (): string => {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../assets/grounds"),
    resolve(moduleDirectory, "../../plugins/grounds"),
    resolve(moduleDirectory, "../../../plugins/grounds"),
  ];
  const found = candidates.find(isSkillAssetsRoot);
  if (!found) throw validation("skill", "bundled Grounds skills are unavailable; reinstall the CLI package");
  return found;
};

const readMarker = (directory: string, skill: string): Marker | undefined => {
  for (const name of [markerName, legacyMarkerName]) {
    const markerPath = join(directory, name);
    if (!existsSync(markerPath)) continue;
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<Marker>;
      if (marker.format === markerFormat && marker.skill === skill) return marker as Marker;
    } catch {
      // A malformed marker does not prove ownership. Refuse replacement below.
    }
  }
  return undefined;
};

const pathExists = (path: string): boolean => {
  try { lstatSync(path); return true; } catch { return false; }
};

const validateExistingDestination = (directory: string, skill: string): void => {
  if (!pathExists(directory)) return;
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !readMarker(directory, skill)) {
    throw validation("path", `refusing to overwrite unmanaged skill destination: ${directory}`);
  }
};

const validateLegacyDestination = (directory: string, skill: string): void => {
  if (!pathExists(directory)) return;
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !readMarker(directory, skill)) {
    throw validation("path", `refusing to remove unmanaged legacy skill destination: ${directory}`);
  }
};

const symlinkPointsTo = (link: string, expected: string): boolean => {
  try { return resolve(dirname(link), readlinkSync(link)) === resolve(expected); } catch { return false; }
};

const stageSkill = (pluginRoot: string, stagingRoot: string, skill: SkillName, packageVersion: string): string => {
  const staged = join(stagingRoot, skill);
  assembleSkillAssets(pluginRoot, skill, staged);
  writeFileSync(join(staged, markerName), JSON.stringify({ format: markerFormat, skill, package_version: packageVersion }, null, 2) + "\n", { mode: 0o644 });
  return staged;
};

export const installGroundsSkills = (
  targetPath: string,
  pluginRoot = bundledPluginRoot(),
  link = false,
  canonicalRoot = defaultSkillsDirectory(),
  packageVersion = cliVersion(),
): SkillInstallResult => {
  const target = resolve(targetPath);
  if (!targetPath.trim()) throw validation("path", "must not be empty");
  if (!isSkillAssetsRoot(pluginRoot)) throw validation("skill", "Grounds skill source is incomplete");
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory())) {
    throw validation("path", "skill target must be a directory, not a file or symbolic link");
  }
  mkdirSync(target, { recursive: true });

  if (link) {
    // Link mode adapts a target that reads a different skills directory than
    // the cross-agent default (for example Claude Code's ~/.claude/skills).
    // The canonical install is the copy at the default directory; the target
    // gets a symlink per skill so future `install skill` updates to the
    // default directory are visible through the link without a second copy.
    for (const skill of skillNames) {
      const canonicalSkill = join(canonicalRoot, skill);
      if (!existsSync(join(canonicalSkill, "SKILL.md"))) {
        throw validation("skill", `link mode requires the canonical install at ${canonicalRoot}; run \`install skill\` there first`);
      }
    }
    for (const skill of skillNames) {
      const destination = join(target, skill);
      if (!pathExists(destination)) continue;
      const canonicalSkill = join(canonicalRoot, skill);
      if (!lstatSync(destination).isSymbolicLink() || !symlinkPointsTo(destination, canonicalSkill)) {
        throw validation("path", `refusing to overwrite existing destination for link: ${destination}`);
      }
    }
    // A linked secondary install can contain dangling links after the
    // canonical copy migrates from the old names. Remove only links whose
    // literal target is the corresponding canonical legacy path.
    const legacyLinksToRemove: string[] = [];
    for (const legacy of legacySkillNames) {
      const legacyLink = join(target, legacy);
      if (!pathExists(legacyLink)) continue;
      const expected = join(canonicalRoot, legacy);
      if (!lstatSync(legacyLink).isSymbolicLink() || !symlinkPointsTo(legacyLink, expected)) {
        throw validation("path", `refusing to remove unmanaged legacy skill link: ${legacyLink}`);
      }
      legacyLinksToRemove.push(legacyLink);
    }
    const createdLinks: string[] = [];
    const removedLinks: Array<{ path: string; target: string }> = [];
    try {
      for (const skill of skillNames) {
        const destination = join(target, skill);
        const canonicalSkill = join(canonicalRoot, skill);
        if (pathExists(destination) && realpathSync(destination) === realpathSync(canonicalSkill)) continue;
        symlinkSync(canonicalSkill, destination);
        createdLinks.push(destination);
      }
      for (const legacyLink of legacyLinksToRemove) {
        const literalTarget = readlinkSync(legacyLink);
        unlinkSync(legacyLink);
        removedLinks.push({ path: legacyLink, target: literalTarget });
      }
    } catch (error) {
      for (const destination of createdLinks.reverse()) unlinkSync(destination);
      for (const removed of removedLinks.reverse()) symlinkSync(removed.target, removed.path);
      throw error;
    }
    return {
      result_type: "patchledger.result.skill-install/v1",
      command: "install.skill",
      target_path: target,
      skills: skillNames.map((name) => ({ name, path: join(target, name) })),
    };
  }

  for (const skill of skillNames) validateExistingDestination(join(target, skill), skill);
  for (const legacy of legacySkillNames) validateLegacyDestination(join(target, legacy), legacy);

  const stagingRoot = mkdtempSync(join(target, ".grounds-install-"));
  const replacements: Array<{ destination: string; backup?: string }> = [];
  const legacyReplacements: Array<{ destination: string; backup: string }> = [];
  try {
    for (const skill of skillNames) stageSkill(pluginRoot, stagingRoot, skill, packageVersion);
    for (const legacy of legacySkillNames) {
      const destination = join(target, legacy);
      if (!pathExists(destination)) continue;
      const backup = join(stagingRoot, `.legacy-${legacy}`);
      renameSync(destination, backup);
      legacyReplacements.push({ destination, backup });
    }
    for (const skill of skillNames) {
      const destination = join(target, skill);
      const backup = pathExists(destination) ? join(stagingRoot, `.backup-${skill}`) : undefined;
      if (backup) renameSync(destination, backup);
      replacements.push({ destination, ...(backup ? { backup } : {}) });
      renameSync(join(stagingRoot, skill), destination);
    }
    for (const replacement of replacements) if (replacement.backup) rmSync(replacement.backup, { recursive: true, force: true });
  } catch (error) {
    for (const replacement of replacements.reverse()) {
      rmSync(replacement.destination, { recursive: true, force: true });
      if (replacement.backup && existsSync(replacement.backup)) renameSync(replacement.backup, replacement.destination);
    }
    for (const replacement of legacyReplacements.reverse()) {
      if (pathExists(replacement.backup)) renameSync(replacement.backup, replacement.destination);
    }
    throw error;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  return {
    result_type: "patchledger.result.skill-install/v1",
    command: "install.skill",
    target_path: target,
    skills: skillNames.map((name) => ({ name, path: join(target, name) })),
  };
};
