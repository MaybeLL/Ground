import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeEnvironmentCommand } from "../src/env-cli.js";
import { acquireRouteLease, assertIndependentWorkspace, isRouteLeased, releaseRouteLease, type RouteLease } from "../src/env-route-lease.js";
import { directoryRegistryLocation, withRuntimeLock } from "../src/runtime-files.js";
import { repository, temporary } from "./env-test-helpers.js";

const reservation = (directory: string) => ({ run: "old", database: "ledger", directory, identity: "device:inode", input_digest: "digest", ownership: "external" });

test("corrupt non-overlapping reservations fail closed and preserve registry bytes", async () => temporary(async (root, workspace) => {
  const registry = directoryRegistryLocation(); mkdirSync(registry);
  const file = join(registry, "workspace-registry.json");
  const valid = reservation(join(root, "unrelated"));
  const invalid: unknown[] = [{ directory: valid.directory }, { ...valid, run: "different" }, { ...valid, ownership: "unknown" }];
  for (const field of ["database", "identity", "input_digest"]) {
    const entry: Record<string, unknown> = { ...valid }; delete entry[field]; invalid.push(entry);
  }
  for (const entry of invalid) {
    const bytes = JSON.stringify({ old: entry }); writeFileSync(file, bytes);
    assert.throws(() => assertIndependentWorkspace(workspace), { code: "STATE_CONFLICT" });
    assert.equal(readFileSync(file, "utf8"), bytes);
  }
  for (const entry of [valid, { ...valid, ownership: undefined }]) {
    const bytes = JSON.stringify({ old: entry }); writeFileSync(file, bytes);
    assert.doesNotThrow(() => assertIndependentWorkspace(workspace));
    assert.equal(readFileSync(file, "utf8"), bytes);
  }
}));

test("env repository neither creates nor chmods the directory registry", async () => temporary(async (_root, workspace) => {
  repository(workspace);
  const registry = directoryRegistryLocation();
  assert.equal(existsSync(registry), false);
  await executeEnvironmentCommand({ positionals: ["env", "repository"], values: {} }, workspace);
  assert.equal(existsSync(registry), false);
  mkdirSync(registry); chmodSync(registry, 0o750);
  await executeEnvironmentCommand({ positionals: ["env", "repository"], values: {} }, workspace);
  assert.equal(statSync(registry).mode & 0o777, 0o750);
}));

test("env lease cannot publish between the legacy registry owner's check and reservation", async () => temporary(async (root, workspace) => {
  const registry = directoryRegistryLocation(), file = join(registry, "workspace-registry.json");
  let leaked: RouteLease | undefined;
  try {
    // This is the same exclusive file lock and check/publish sequence used by
    // DevWorktreeModule.start. Attempt env acquisition at the exact vulnerable gap.
    await withRuntimeLock(registry, "directory-registry", async () => {
      assert.equal(isRouteLeased(workspace), false);
      assert.throws(() => { leaked = acquireRouteLease({ route: workspace, environmentId: "env", runDirectory: join(root, "run") }); }, { code: "STATE_CONFLICT", details: { reason: "busy: another local controller holds the operation lock", reason_code: "busy" } });
      writeFileSync(file, JSON.stringify({ old: reservation(workspace) }));
    });
    const bytes = readFileSync(file);
    assert.throws(() => acquireRouteLease({ route: workspace, environmentId: "env", runDirectory: join(root, "run") }), { code: "STATE_CONFLICT" });
    assert.deepEqual(readFileSync(file), bytes);
  } finally { if (leaked) releaseRouteLease(leaked); }
}));

test("env winning the shared registry lock prevents the later legacy owner from claiming", async () => temporary(async (root, workspace) => {
  const lease = acquireRouteLease({ route: workspace, environmentId: "env", runDirectory: join(root, "run") });
  try {
    let claimed = false;
    await withRuntimeLock(directoryRegistryLocation(), "directory-registry", async () => {
      if (isRouteLeased(workspace)) return;
      claimed = true;
      writeFileSync(join(directoryRegistryLocation(), "workspace-registry.json"), JSON.stringify({ old: reservation(workspace) }));
    });
    assert.equal(claimed, false);
    assert.equal(existsSync(join(directoryRegistryLocation(), "workspace-registry.json")), false);
    assert.deepEqual(acquireRouteLease({ route: workspace, environmentId: "env", runDirectory: join(root, "run") }), lease);
  } finally { releaseRouteLease(lease); }
}));
