import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleSkills = join(packageRoot, "scripts/bundle-skills.mjs");

const git = (directory: string, ...args: string[]): string => execFileSync("git", args, {
  cwd: directory,
  encoding: "utf8",
}).trim();

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
