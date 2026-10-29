import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const releaseCheck = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/release-check.mjs");
const releaseVersion = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/release-version.mjs");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleSkills = join(packageRoot, "scripts/bundle-skills.mjs");

const git = (directory: string, ...args: string[]): string => execFileSync("git", args, {
  cwd: directory,
  encoding: "utf8",
}).trim();

test("release-check enforces a clean worktree with a version-matching tag", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-release-check-"));
  try {
    mkdirSync(join(directory, "scripts"));
    copyFileSync(releaseCheck, join(directory, "scripts/release-check.mjs"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
    git(directory, "init");
    git(directory, "config", "user.name", "Grounds Test");
    git(directory, "config", "user.email", "grounds-test@example.invalid");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "fixture");

    const missingTag = spawnSync(process.execPath, [join(directory, "scripts/release-check.mjs")], { cwd: directory, encoding: "utf8" });
    assert.equal(missingTag.status, 1);
    assert.match(missingTag.stderr, /no tag matching package\.json version 1\.2\.3/);

    git(directory, "tag", "v1.2.3");
    const clean = spawnSync(process.execPath, [join(directory, "scripts/release-check.mjs")], { cwd: directory, encoding: "utf8" });
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /version 1\.2\.3 tagged at a clean HEAD/);

    writeFileSync(join(directory, "dirty.txt"), "uncommitted\n");
    const dirty = spawnSync(process.execPath, [join(directory, "scripts/release-check.mjs")], { cwd: directory, encoding: "utf8" });
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /working tree is dirty/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release-version commits and tags a package nested below the Git root", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-release-version-"));
  const packageRoot = join(directory, "typescript");
  try {
    mkdirSync(join(packageRoot, "scripts"), { recursive: true });
    copyFileSync(releaseVersion, join(packageRoot, "scripts/release-version.mjs"));
    const packageDocument = { name: "nested-release-fixture", version: "1.2.3", type: "module" };
    const lockDocument = {
      name: packageDocument.name,
      version: packageDocument.version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: packageDocument.name, version: packageDocument.version } },
    };
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify(packageDocument, null, 2));
    writeFileSync(join(packageRoot, "package-lock.json"), JSON.stringify(lockDocument, null, 2));
    git(directory, "init");
    git(directory, "config", "user.name", "Grounds Test");
    git(directory, "config", "user.email", "grounds-test@example.invalid");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "fixture");

    const result = spawnSync(process.execPath, [join(packageRoot, "scripts/release-version.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /created v1\.2\.4/);
    assert.equal(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version, "1.2.4");
    assert.equal(JSON.parse(readFileSync(join(packageRoot, "package-lock.json"), "utf8")).version, "1.2.4");
    assert.equal(git(directory, "status", "--porcelain"), "");
    assert.equal(git(directory, "tag", "--points-at", "HEAD"), "v1.2.4");
    assert.equal(git(directory, "log", "-1", "--format=%s"), "chore: release v1.2.4");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release:patch orders versioning and checks before publication", () => {
  const manifest = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"));
  assert.equal(
    manifest.scripts["release:patch"],
    "npm run release:version && npm run release:check && npm publish --registry=https://registry.invalid",
  );
});

test("skill bundle excludes local Python and platform cache artifacts", () => {
  const sourceDirectory = resolve(
    packageRoot,
    "../plugins/grounds/skills/grounds",
  );
  const sourceCache = join(sourceDirectory, "__pycache__");
  const sourcePyc = join(sourceCache, `bundle-filter-${process.pid}.pyc`);
  const bundledDirectory = join(
    packageRoot,
    "dist/assets/grounds/skills/grounds",
  );
  try {
    mkdirSync(sourceCache, { recursive: true });
    writeFileSync(sourcePyc, "derived bytecode fixture\n");

    execFileSync(process.execPath, [bundleSkills], { cwd: packageRoot });

    assert.equal(existsSync(join(bundledDirectory, "__pycache__")), false);
    assert.equal(existsSync(join(bundledDirectory, ".DS_Store")), false);
    assert.equal(existsSync(join(bundledDirectory, "SKILL.md")), true);
  } finally {
    rmSync(sourcePyc, { force: true });
  }
});
