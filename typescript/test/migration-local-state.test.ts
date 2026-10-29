import test from "node:test";
import { sha256 } from "../src/canonical-json.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLocalBindings, applyLocalBindings } from "../src/migration-local-state.js";

test("sync recovery code stays opaque while live and corrupt metadata still block migration", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-sync-migration-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "old"), target = join(root, "new");
  const run = join(source, "devruns", "run"), recovery = join(run, "sync", "operation");
  const journal = { format: "grounds.local-sync/v1", phase: "abandoned", saved_edits: [] };
  mkdirSync(recovery, { recursive: true });
  writeFileSync(join(recovery, "journal.json"), JSON.stringify({ journal, digest: sha256(journal) }));
  const conflict = "<<<<<<< original\n{}\n=======\n[]\n>>>>>>> target";
  for (const name of ["desired-worktree", "merge"]) {
    mkdirSync(join(recovery, name));
    writeFileSync(join(recovery, name, "package-lock.json"), conflict);
    writeFileSync(join(recovery, name, "pending.json"), "application data");
    writeFileSync(join(recovery, name, "run.json"), JSON.stringify({ format: "grounds.environment/v1", state: "ready" }));
  }
  const marker = join(run, "worktree.json");
  writeFileSync(marker, JSON.stringify({ format: "patchledger.local-dev-worktree/v3", lifecycle: "active", worktree_path: join(source, "code") }));
  const mappings = [{ source, target }];
  const changes = inspectLocalBindings([source], [], mappings);
  assert.equal(changes.length, 1);
  cpSync(source, target, { recursive: true });
  applyLocalBindings(changes);
  assert.equal(readFileSync(join(target, "devruns/run/sync/operation/desired-worktree/package-lock.json"), "utf8"), conflict);
  assert.equal(readFileSync(join(target, "devruns/run/sync/operation/journal.json"), "utf8"), readFileSync(join(recovery, "journal.json"), "utf8"));
  writeFileSync(marker, JSON.stringify({ format: "patchledger.local-dev-worktree/v3", lifecycle: "sync_interrupted", worktree_path: join(source, "code") }));
  assert.throws(() => inspectLocalBindings([source], [], mappings));
  writeFileSync(marker, "invalid managed JSON");
  assert.throws(() => inspectLocalBindings([source], [], mappings));
  writeFileSync(marker, "{}");
  writeFileSync(join(recovery, "journal.json"), JSON.stringify({ journal, digest: "wrong" }));
  assert.throws(() => inspectLocalBindings([source], [], mappings));
  rmSync(join(recovery, "journal.json"));
  assert.throws(() => inspectLocalBindings([source], [], mappings), "directory name alone cannot hide invalid metadata");
  writeFileSync(join(recovery, "journal.json"), JSON.stringify({ journal: { format: "other/v1" } }));
  assert.throws(() => inspectLocalBindings([source], [], mappings));
});

test("local migration updates only live bindings and never rewrites checkout or review evidence", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-local-migration-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "old"), target = join(root, "new");
  const checkout = join(source, "checkout"); mkdirSync(checkout, { recursive: true });
  const data = { format: "grounds.local-development-worktree/v1", lifecycle: "active", worktree_path: checkout };
  const bytes = JSON.stringify(data);
  writeFileSync(join(source, "run.json"), bytes); writeFileSync(join(checkout, "application.json"), bytes);
  mkdirSync(join(source, "reviews")); writeFileSync(join(source, "reviews", "evidence.json"), bytes);
  const changes = inspectLocalBindings([source], [checkout], [{ source, target }]);
  assert.equal(changes.length, 1);
  cpSync(source, target, { recursive: true });
  applyLocalBindings(changes); applyLocalBindings(changes);
  assert.equal(JSON.parse(readFileSync(join(target, "run.json"), "utf8")).worktree_path, join(target, "checkout"));
  assert.equal(readFileSync(join(target, "checkout", "application.json"), "utf8"), bytes);
  assert.equal(readFileSync(join(target, "reviews", "evidence.json"), "utf8"), bytes);
  assert.equal(readFileSync(join(source, "run.json"), "utf8"), bytes);
});

test("pending operation or changed binding prevents cutover", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-local-conflict-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "old"), target = join(root, "new"); mkdirSync(source);
  writeFileSync(join(source, "pending.json"), "{}");
  assert.throws(() => inspectLocalBindings([source], [], [{ source, target }]));
  assert.equal(existsSync(target), false);
  rmSync(join(source, "pending.json"));
  writeFileSync(join(source, "run.json"), JSON.stringify({ format: "grounds.development-branch/v1", path: join(source, "code") }));
  const changes = inspectLocalBindings([source], [], [{ source, target }]);
  cpSync(source, target, { recursive: true }); writeFileSync(join(target, "run.json"), "changed");
  assert.throws(() => applyLocalBindings(changes));
  assert.equal(readFileSync(join(target, "run.json"), "utf8"), "changed");
});

test("released environment log pointers move without rewriting captured command evidence", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-migration-env-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "old"), target = join(root, "new"); mkdirSync(source);
  const run = { format: "grounds.environment-run/v1", directory: source, state: "succeeded", termination: "confirmed", cleanup: "complete", argv: ["echo", source] };
  writeFileSync(join(source, "run.json"), JSON.stringify(run)); writeFileSync(join(source, "output.log"), "original captured output");
  const changes = inspectLocalBindings([source], [], [{ source, target }]);
  cpSync(source, target, { recursive: true }); applyLocalBindings(changes);
  const moved = JSON.parse(readFileSync(join(target, "run.json"), "utf8"));
  assert.equal(readFileSync(join(moved.directory, "output.log"), "utf8"), "original captured output");
  assert.deepEqual(moved.argv, run.argv);
  writeFileSync(join(source, "run.json"), JSON.stringify({ ...run, cleanup: "pending" }));
  assert.throws(() => inspectLocalBindings([source], [], [{ source, target }]));
});
