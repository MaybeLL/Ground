import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { snapshotSyncFiles, installSyncFiles } from "../src/sync-files.js";
import { safeTreeWrite } from "../src/safe-tree.js";

function fixture(t: { after: (f: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-file-install-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "source"), desired = join(root, "desired"), store = join(root, "store"); mkdirSync(cwd); mkdirSync(desired);
  return { root, cwd, desired, store };
}

test("a removed tracked directory keeps ignored local files; directory/file replacement is no-follow", t => {
  const x = fixture(t); mkdirSync(join(x.cwd, "old")); writeFileSync(join(x.cwd, "old", "tracked"), "old"); writeFileSync(join(x.cwd, "old", "ignored"), "retained");
  const before = snapshotSyncFiles(x.cwd, ["old/tracked"]), after = snapshotSyncFiles(x.desired, [], x.store);
  installSyncFiles(x.cwd, before, after, x.store);
  assert.equal(readFileSync(join(x.cwd, "old", "ignored"), "utf8"), "retained");
});

test("a symlink-swapped destination ancestor cannot redirect sync writes outside the worktree", t => {
  const x = fixture(t), outside = join(x.root, "outside"); mkdirSync(outside);
  mkdirSync(join(x.desired, "dir")); writeFileSync(join(x.desired, "dir", "file"), "desired");
  const before = snapshotSyncFiles(x.cwd, []), after = snapshotSyncFiles(x.desired, ["dir/file"], x.store);
  assert.throws(() => installSyncFiles(x.cwd, before, after, x.store, path => {
    if (path === "dir") { rmSync(join(x.cwd, "dir"), { recursive: true }); symlinkSync(outside, join(x.cwd, "dir")); }
  }));
  assert.throws(() => readFileSync(join(outside, "file")));
});

test("an editor saving after the original entry was parked cannot be overwritten", t => {
  const x = fixture(t); writeFileSync(join(x.cwd, "file"), "original"); writeFileSync(join(x.desired, "file"), "desired");
  const before = snapshotSyncFiles(x.cwd, ["file"]), after = snapshotSyncFiles(x.desired, ["file"], x.store);
  const park = safeTreeWrite.parkEntry;
  t.mock.method(safeTreeWrite, "parkEntry", (...args: Parameters<typeof park>) => { park(...args); writeFileSync(join(x.cwd, "file"), "late editor save"); });
  assert.throws(() => installSyncFiles(x.cwd, before, after, x.store));
  assert.equal(readFileSync(join(x.cwd, "file"), "utf8"), "late editor save");
  const displaced = join(x.store, "displaced");
  const metadata = JSON.parse(readFileSync(join(displaced, readdirSync(displaced).find(name => name.endsWith(".json"))!), "utf8"));
  assert.equal(metadata.path, "file"); assert.equal(readFileSync(join(displaced, metadata.entry), "utf8"), "original");
});

test("corrupt blobs and late file edits fail closed, retaining the edited bytes", t => {
  const x = fixture(t);
  writeFileSync(join(x.cwd, "a"), "old-a"); writeFileSync(join(x.cwd, "b"), "old-b");
  writeFileSync(join(x.desired, "a"), "new-a"); writeFileSync(join(x.desired, "b"), "new-b");
  const before = snapshotSyncFiles(x.cwd, ["a", "b"]), after = snapshotSyncFiles(x.desired, ["a", "b"], x.store);
  assert.throws(() => installSyncFiles(x.cwd, before, after, x.store, path => { if (path === "a") writeFileSync(join(x.cwd, "b"), "user edited"); }));
  assert.equal(readFileSync(join(x.cwd, "b"), "utf8"), "user edited");
  const current = snapshotSyncFiles(x.cwd, ["a", "b"]);
  const file = after.entries.a; assert.ok(file?.kind === "file"); writeFileSync(join(x.store, "blobs", file.digest.slice(7)), "corrupt");
  assert.throws(() => installSyncFiles(x.cwd, current, after, x.store));
  assert.equal(readFileSync(join(x.cwd, "b"), "utf8"), "user edited");
});

test("sync recovers versioned environment YAML without capturing private Grounds siblings", t => {
  const x = fixture(t), path = ".grounds/environments/dev.yaml";
  for (const directory of [x.cwd, x.desired]) mkdirSync(join(directory, ".grounds/environments"), { recursive: true });
  mkdirSync(join(x.cwd, ".grounds/runtime"));
  writeFileSync(join(x.cwd, ".grounds/runtime/private.json"), "private-runtime");
  writeFileSync(join(x.cwd, path), "name: dev\nbackend: host\n");
  writeFileSync(join(x.desired, path), "name: dev\nbackend: docker\n");
  const before = snapshotSyncFiles(x.cwd, [path]), after = snapshotSyncFiles(x.desired, [path], x.store);
  assert.deepEqual(Object.keys(before.entries), [".grounds", ".grounds/environments", path]);
  installSyncFiles(x.cwd, before, after, x.store);
  assert.equal(readFileSync(join(x.cwd, path), "utf8"), "name: dev\nbackend: docker\n");
  assert.equal(readFileSync(join(x.cwd, ".grounds/runtime/private.json"), "utf8"), "private-runtime");
  for (const reserved of [".grounds/runtime/private.json", ".grounds/authoring/draft.json", ".grounds/environments/nested/dev.yaml", "other/.grounds/environments/dev.yaml", ".GROUNDS/environments/dev.yaml", ".git/config"]) {
    assert.throws(() => snapshotSyncFiles(x.cwd, [reserved]), undefined, reserved);
  }
});

test("environment declaration recovery cannot treat its private ancestors as links or files", t => {
  const x = fixture(t);
  symlinkSync(x.desired, join(x.cwd, ".grounds"));
  assert.throws(() => snapshotSyncFiles(x.cwd, [".grounds/environments/dev.yaml"]));
  rmSync(join(x.cwd, ".grounds"));
  mkdirSync(join(x.cwd, ".grounds/environments"), { recursive: true });
  symlinkSync(join(x.root, "outside.yaml"), join(x.cwd, ".grounds/environments/dev.yaml"));
  assert.throws(() => snapshotSyncFiles(x.cwd, [".grounds/environments/dev.yaml"]));
});
