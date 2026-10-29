import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWorkspaceRegistry, repairWorkspaceRegistry, requireIdleEnvironmentLeases } from "../src/migration-registry.js";
import { workspaceIdentity } from "../src/workspace-provider.js";

test("managed lease cutover changes physical identity, preserves input evidence and detects concurrent edits", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-registry-upgrade-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "old"), target = join(root, "new"), path = join(root, "registry.json");
  mkdirSync(source); mkdirSync(target);
  const mappings = [{ source, target }];
  const original = JSON.stringify({ run: { run: "run", database: "ledger", ownership: "managed", directory: source,
    identity: workspaceIdentity(source), input_digest: "historical-input" },
    unrelated: { run: "unrelated", database: "ledger", ownership: "external", directory: join(root, "unrelated"), identity: "original", input_digest: "keep" } });
  writeFileSync(path, original);
  assert.equal(inspectWorkspaceRegistry(path, mappings), original);
  repairWorkspaceRegistry(path, original, mappings);
  const next = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(next.run.directory, target); assert.equal(next.run.identity, workspaceIdentity(target));
  assert.equal(next.run.input_digest, "historical-input");
  assert.deepEqual(next.unrelated, JSON.parse(original).unrelated);
  repairWorkspaceRegistry(path, original, mappings);
  writeFileSync(path, JSON.stringify({ ...next, later: next.unrelated }));
  assert.throws(() => repairWorkspaceRegistry(path, original, mappings));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).later.input_digest, "keep");
});

test("external reservations cannot be silently relocated", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-registry-external-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "old"), path = join(root, "registry.json");
  const original = JSON.stringify({ run: { run: "run", database: "ledger", ownership: "external", directory: source, identity: "original", input_digest: "keep" } });
  writeFileSync(path, original);
  assert.throws(() => inspectWorkspaceRegistry(path, [{ source, target: join(root, "new") }]));
  assert.equal(readFileSync(path, "utf8"), original);
});

test("environment occupancy must be finalized even when its route is outside the data root", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-migration-lease-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "environment-occupancy"));
  writeFileSync(join(root, "environment-occupancy", "lease.json"), JSON.stringify({ route: "/unrelated/checkout", runDirectory: join(root, "old", "run") }));
  assert.throws(() => requireIdleEnvironmentLeases(root, [{ source: join(root, "old"), target: join(root, "new") }]));
  requireIdleEnvironmentLeases(root, [{ source: join(root, "other"), target: join(root, "new") }]);
});
