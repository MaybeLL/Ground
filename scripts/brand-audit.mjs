#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
  .toString("utf8").split("\0").filter(Boolean);
const historical = /^(docs\/adr\/|docs\/dogfooding-|docs\/experiments\/|docs\/validation\/|docs\/examples\/reviewer-first-review\.md$|tui\/CHANGELOG\.md$)/;
const compatibility = new Set([
  "typescript/src/brand-migration.ts",
  "typescript/src/config.ts",
  "typescript/src/cli.ts",
  "typescript/src/skill-installer.ts",
  "typescript/test/brand-migration.test.ts",
  "typescript/test/skill-installer.test.ts",
  "scripts/brand-audit.mjs",
]);
// Only the excluded historical data path is permitted in this new adapter.
const snapshotExclusions = new Set([
  "plugins/grounds/scripts/grounds_eval_repositories.py",
  "plugins/grounds/skills/grounds-knowledge-improve/references/repository-materials.md",
]);
const forbidden = /@example\/patchledger(?:-tui)?|\bpatchledger-tui\b|\bpatchledger-(?:define|develop|verify|deliver|guide|eval-author|eval-run|export-confluence)\b|\bPATCHLEDGER_[A-Z0-9_]+|(?:^|[\s`'"/])\.patchledger(?:\/|\b)|plugins\/patchledger|\bPatchLedger\b|(?:^|[\s`])patchledger(?=[\s`])/;
const findings = [];
let historicalDatabases = 0;

for (const file of files) {
  if (historical.test(file) || compatibility.has(file)) continue;
  let bytes;
  try { bytes = readFileSync(resolve(root, file)); } catch { continue; }
  // Preserved database snapshots contain immutable historical business and
  // protocol text, not the current public product surface. Require both the
  // archive location and SQLite signature; text disguised as .db still fails.
  if (/^archive\/db-backups\/[^/]+\/[^/]+\.db$/.test(file)
      && bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
    historicalDatabases++;
    continue;
  }
  const text = bytes.toString("utf8");
  text.split(/\r?\n/).forEach((line, index) => {
    if (!forbidden.test(line)) return;
    if (snapshotExclusions.has(file) && !forbidden.test(line.replaceAll(".patchledger", ""))) return;
    if (/migrate patchledger|migrate\.patchledger|原 PatchLedger|从 PatchLedger 更名|retired `patchledger-|退役 `patchledger-/.test(line)) return;
    if (/@example\/patchledger(?:-tui)?@0\.1\.\d+/.test(line)) return;
    if (/\/patchledger-tui --version.*`0\.1\.\d+`/.test(line)) return;
    findings.push(`${file}:${index + 1}:${line.trim()}`);
  });
}

if (findings.length) {
  console.error("brand-audit: old public PatchLedger names remain outside the allowlist:\n" + findings.join("\n"));
  process.exit(1);
}
console.log(`brand-audit: ${files.length} versioned/current files checked; ${historicalDatabases} historical SQLite archive(s) preserved without text rewriting; only stable protocol, migration, and historical uses remain.`);
