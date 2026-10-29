import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installationStatus } from "../src/installation-status.js";
import { bundledPluginRoot, installGroundsSkills, skillNames } from "../src/skill-installer.js";
import { cliVersion } from "../src/runtime-version.js";
import { assertContract } from "./schema-fixture.js";
import { runCLI } from "../src/cli.js";

test("doctor identifies stale managed skills and emits an executable repair", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-doctor-"));
  try {
    installGroundsSkills(directory, bundledPluginRoot(), false, directory, "0.1.6");
    const result = installationStatus(directory, () => cliVersion());
    assert.equal(result.cli.status, "current");
    assert.equal(result.skills.status, "outdated");
    assert.equal(result.skills.details.length, skillNames.length);
    assert.equal(result.skills.details[0].name, "grounds");
    assert.equal(result.skills.installed_version, "0.1.6");
    assert.equal(result.upgrade_required, true);
    assert.match(result.recommended_commands[0], /grounds install skill/);
    const { warnings: _warnings, ...commandResult } = result;
    assertContract("command-results.schema.json", commandResult);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("doctor recommends upgrading both CLI and skills when registry is newer", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-doctor-"));
  try {
    installGroundsSkills(directory, bundledPluginRoot());
    const [major, minor, patch] = cliVersion().split(".").map(Number);
    const latest = `${major}.${minor}.${patch + 1}`;
    const result = installationStatus(directory, () => latest);
    assert.equal(result.cli.status, "outdated");
    assert.equal(result.skills.status, "current");
    assert.equal(result.upgrade_required, true);
    assert.equal(result.recommended_commands.length, 2);
    assert.match(result.recommended_commands[0], /npm install --global/);
    assert.match(result.recommended_commands[1], /grounds install skill/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("doctor reports a missing development skill", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-doctor-four-skills-"));
  try {
    installGroundsSkills(directory, bundledPluginRoot());
    rmSync(join(directory, "grounds"), { recursive: true });

    const result = installationStatus(directory, () => cliVersion());
    assert.equal(result.skills.status, "mixed");
    assert.equal(result.skills.details[0].name, "grounds");
    assert.equal(result.skills.details[0].status, "missing");
    assert.equal(result.upgrade_required, true);
    assert.match(result.recommended_commands[0], /grounds install skill/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("doctor degrades registry failures to a non-blocking diagnostic", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-doctor-"));
  try {
    installGroundsSkills(directory, bundledPluginRoot());
    const result = installationStatus(directory, () => { throw new Error("offline"); });
    assert.equal(result.cli.status, "unknown");
    assert.equal(result.skills.status, "current");
    assert.equal(result.upgrade_required, false);
    assert.equal(result.warnings[0].code, "REGISTRY_VERSION_UNAVAILABLE");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const missing of ["grounds-eval", "grounds-knowledge-improve"]) test(`doctor detects missing ${missing} and reinstall completes the installation`, () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-eval-upgrade-"));
  try {
    installGroundsSkills(directory, bundledPluginRoot());
    rmSync(join(directory, missing), { recursive: true });
    const before = installationStatus(directory, () => cliVersion());
    assert.equal(before.skills.details.find((skill) => skill.name === missing)?.status, "missing");
    assert.equal(before.upgrade_required, true);
    const { warnings: _warnings, ...result } = before;
    assertContract("command-results.schema.json", result);
    installGroundsSkills(directory, bundledPluginRoot());
    const after = installationStatus(directory, () => cliVersion());
    assert.equal(after.skills.status, "current");
    assert.equal(after.upgrade_required, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("doctor rejects an explicitly empty managed skills path", async () => {
  const output: string[] = [];
  const exit = await runCLI(["doctor", "--skills-path=", "--json"], { stdout: (line) => output.push(line), stderr: () => undefined });
  assert.equal(exit, 2);
  const envelope = JSON.parse(output[0]) as { error: { details: { field: string } } };
  assert.equal(envelope.error.details.field, "skills-path");
});
