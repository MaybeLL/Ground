import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync, readlinkSync, existsSync, renameSync, lchmodSync, lstatSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planRelocation, stageRelocation, activateRelocation, treeDigest } from "../src/storage-relocation.js";
import { safeTreeWrite } from "../src/safe-tree.js";
import { DomainError } from "../src/errors.js";

const rejected = (e: unknown) => e instanceof DomainError && e.code === "VALIDATION_ERROR";

test("relocation preserves uncommitted bytes and symlink text, retaining originals and recovering interrupted activation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-relocate-")));
  try {
    const source = join(root, "old"), target = join(root, "new"), journal = join(root, "journal", "move.json");
    mkdirSync(source); mkdirSync(join(source, "empty"));
    writeFileSync(join(source, "code"), "uncommitted work", { mode: 0o755 });
    symlinkSync("code", join(source, "link"));
    const plan = planRelocation("test", [{ source, target }]);
    await stageRelocation(journal, plan);
    assert.equal(existsSync(target), false);
    assert.equal(readFileSync(join(source, "code"), "utf8"), "uncommitted work");
    // Power loss after retiring source but before installing target.
    renameSync(source, plan.entries[0].retired);
    await activateRelocation(journal);
    assert.equal(treeDigest(target), plan.entries[0].digest);
    assert.equal(treeDigest(plan.entries[0].retired), plan.entries[0].digest);
    assert.equal(readlinkSync(join(target, "link")), "code");
    assert.equal(existsSync(source), false);
    assert.equal((await activateRelocation(journal)).phase, "activated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source changes block all activation and partial staging can be rebuilt", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-relocate-")));
  try {
    const source = join(root, "old"), target = join(root, "new"), journal = join(root, "journal", "move.json");
    mkdirSync(source); writeFileSync(join(source, "code"), "original");
    const plan = planRelocation("test", [{ source, target }]);
    mkdirSync(join(root, "journal")); writeFileSync(journal, JSON.stringify(plan));
    mkdirSync(plan.entries[0].staged); writeFileSync(join(plan.entries[0].staged, "partial"), "interrupted copy");
    await stageRelocation(journal, plan);
    writeFileSync(join(source, "code"), "new user edit");
    await assert.rejects(activateRelocation(journal), rejected);
    assert.equal(existsSync(source), true); assert.equal(existsSync(target), false);
    assert.equal(readFileSync(join(source, "code"), "utf8"), "new user edit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("staging refuses an occupied recovery path without a matching persisted journal", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-relocate-owner-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "old"); mkdirSync(source); writeFileSync(join(source, "code"), "source");
  const plan = planRelocation("owner", [{ source, target: join(root, "new") }]);
  mkdirSync(plan.entries[0].staged); writeFileSync(join(plan.entries[0].staged, "keep"), "other writer");
  await assert.rejects(stageRelocation(join(root, "journal", "move.json"), plan), rejected);
  assert.equal(readFileSync(join(plan.entries[0].staged, "keep"), "utf8"), "other writer");
});

test("planning refuses nested moves and occupied destinations including broken symlinks", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-relocate-")));
  try {
    const source = join(root, "old"); mkdirSync(source);
    assert.throws(() => planRelocation("x", [{ source, target: join(source, "nested") }]), rejected);
    symlinkSync("missing", join(root, "new"));
    assert.throws(() => planRelocation("x", [{ source, target: join(root, "new") }]), rejected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a racing destination never replaces another writer's bytes", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-relocate-race-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "old"), target = join(root, "new"), journal = join(root, "journal", "move.json");
  writeFileSync(source, "original");
  const plan = planRelocation("race", [{ source, target }]); await stageRelocation(journal, plan);
  const original = safeTreeWrite.parkEntry;
  safeTreeWrite.parkEntry = (fd, name, to, saved) => {
    if (saved === "new") writeFileSync(target, "concurrent writer");
    return original(fd, name, to, saved);
  };
  try { await assert.rejects(activateRelocation(journal)); }
  finally { safeTreeWrite.parkEntry = original; }
  assert.equal(readFileSync(target, "utf8"), "concurrent writer");
  assert.equal(readFileSync(plan.entries[0].retired, "utf8"), "original");
  assert.equal(readFileSync(plan.entries[0].staged, "utf8"), "original");
});

test("migration preserves mixed symlink permissions and never changes their targets", { skip: process.platform !== "darwin" }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-link-migration-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), target = join(root, "target"), journal = join(root, "journal", "files.json");
  mkdirSync(source);
  const outside = join(root, "outside");
  writeFileSync(outside, "keep", { mode: 0o640 });
  writeFileSync(join(source, "code"), "original", { mode: 0o755 });
  const links: Array<[string, string, number]> = [
    ["private", "code", 0o700], ["public", "code", 0o755],
    ["dangling", "missing", 0o700], ["external", outside, 0o700],
  ];
  for (const [name, destination, mode] of links) {
    symlinkSync(destination, join(source, name));
    lchmodSync(join(source, name), mode);
  }
  const plan = planRelocation("mixed-links", [{ source, target }]);
  // Resume a previous cpSync copy with incorrect link modes, as in the real failure.
  mkdirSync(join(root, "journal")); writeFileSync(journal, JSON.stringify(plan));
  cpSync(source, plan.entries[0].staged, { recursive: true, dereference: false, verbatimSymlinks: true });
  await stageRelocation(journal, plan);
  await activateRelocation(journal);
  assert.equal(treeDigest(target), plan.entries[0].digest);
  assert.equal(treeDigest(plan.entries[0].retired), plan.entries[0].digest);
  assert.equal(lstatSync(outside).mode & 0o777, 0o640);
  assert.equal(readFileSync(outside, "utf8"), "keep");
  assert.equal(lstatSync(join(target, "code")).mode & 0o777, 0o755);
});
