#!/usr/bin/env node
/**
 * Pre-publish guard: refuse to publish a version that has no corresponding
 * git tag at HEAD.  This turns the "0.1.1/0.1.2 published with no commit"
 * class of drift into a hard failure instead of a silent registry-vs-source
 * divergence.  `npm version` (used by release:patch) creates the tag, so a
 * normal release always passes; a bare `npm publish` on an un-tagged version
 * is rejected here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = manifest.version;

const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

// A tag named after the version, with or without a leading v.
const tags = run(["tag", "--points-at", "HEAD"]).split(/\r?\n/).filter(Boolean);
const matches = tags.some((tag) => tag === version || tag === `v${version}`);
if (!matches) {
  const head = run(["rev-parse", "--short", "HEAD"]);
  console.error(`release-check: HEAD (${head}) has no tag matching package.json version ${version} (tags at HEAD: ${tags.join(", ") || "none"}).`);
  console.error("release-check: publish without a matching tag risks shipping a version the git history cannot reproduce.");
  console.error('release-check: use `npm run release:patch` (bumps + tags + publishes), or tag this commit explicitly.');
  process.exit(1);
}

const dirty = run(["status", "--porcelain"]).trim();
if (dirty) {
  console.error("release-check: working tree is dirty; refusing to publish from an unreproducible state.");
  process.exit(1);
}

console.log(`release-check: version ${version} tagged at a clean HEAD; publish is reproducible.`);
