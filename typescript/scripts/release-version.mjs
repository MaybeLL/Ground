#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, options = {}) => {
  const output = execFileSync(command, args, { cwd: packageRoot, encoding: "utf8", ...options });
  return typeof output === "string" ? output.trim() : "";
};
const git = (args, options = {}) => run("git", args, options);
const repositoryRoot = git(["rev-parse", "--show-toplevel"]);
const manifestPath = resolve(packageRoot, "package.json");
const lockPath = resolve(packageRoot, "package-lock.json");
const pluginManifestPath = resolve(repositoryRoot, "plugins/grounds/.codex-plugin/plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.version);
if (!match) throw new Error(`release-version: expected a stable semantic version, got ${manifest.version}`);

const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
const tag = `v${nextVersion}`;
if (git(["status", "--porcelain"], { cwd: repositoryRoot })) throw new Error("release-version: working tree is dirty before the version bump");
try {
  git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
  throw new Error(`release-version: tag ${tag} already exists`);
} catch (error) {
  if (error instanceof Error && error.message.startsWith("release-version: tag")) throw error;
}

run("npm", ["version", "patch", "--no-git-tag-version"]);
const bumped = JSON.parse(readFileSync(manifestPath, "utf8"));
if (bumped.version !== nextVersion) throw new Error(`release-version: npm produced ${bumped.version}, expected ${nextVersion}`);
const versionFiles = [manifestPath, lockPath];
if (existsSync(pluginManifestPath)) {
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
  pluginManifest.version = nextVersion;
  writeFileSync(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`);
  versionFiles.push(pluginManifestPath);
}

const relativeVersionFiles = versionFiles.map((path) => relative(repositoryRoot, path));
git(["add", "--", ...relativeVersionFiles], { cwd: repositoryRoot });
git(["commit", "-m", `chore: release ${tag}`, "--", ...relativeVersionFiles], { cwd: repositoryRoot, stdio: "inherit" });
git(["tag", "-a", tag, "-m", `chore: release ${tag}`], { cwd: repositoryRoot });

if (git(["status", "--porcelain"], { cwd: repositoryRoot })) throw new Error("release-version: working tree became dirty after the version commit");
const taggedCommit = git(["rev-list", "-n", "1", tag], { cwd: repositoryRoot });
const head = git(["rev-parse", "HEAD"], { cwd: repositoryRoot });
if (taggedCommit !== head) throw new Error(`release-version: ${tag} does not point at HEAD`);
console.log(`release-version: created ${tag} at ${head}`);
