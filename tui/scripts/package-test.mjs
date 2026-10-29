#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const expectedVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const output = mkdtempSync(join(tmpdir(), "grounds-tui-package-"));
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", output], { cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: join(output, "npm-cache") } }));
  const tarball = join(output, packed[0].filename);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  if (manifest.name !== "@maybell/grounds-tui" || manifest.version !== expectedVersion) throw new Error("unexpected Grounds TUI package identity");
  if (JSON.stringify(manifest.bin) !== JSON.stringify({ "grounds-tui": "dist/bin.js" })) throw new Error("tarball must expose only the grounds-tui executable");
  const entries = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) if (!entries.includes(`package/dist/${name}`)) throw new Error(`tarball is missing ${name}`);
  if (!entries.includes("package/dist/bin.js") || !entries.includes("package/README.md")) throw new Error("TUI tarball is incomplete");
  console.log(`package-test: ${packed[0].filename} exposes only grounds-tui.`);
} finally { rmSync(output, { recursive: true, force: true }); }
