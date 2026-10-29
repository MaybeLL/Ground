import assert from "node:assert/strict";
import { test } from "node:test";
import { openSync, closeSync, writeFileSync, renameSync, mkdtempSync, rmSync, fstatSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRead, safeReadOpened } from "../src/runtime-files.js";
import { DomainError } from "../src/errors.js";

/** Reproduce the interleaving where `atomicPrivateWrite` replaces the path
 * between a reader's `open` and its first `fstat`: the reader then holds an
 * inode whose link count is 0, which must not be reported as a hard link. */
test("a path replaced while open is re-read instead of being rejected as a hard link", () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-safe-read-"));
  try {
    const path = join(root, "registry.json"), incoming = join(root, "incoming");
    writeFileSync(path, '{"generation":1}');
    // Hold a descriptor on the current inode, then atomically replace the path.
    const stale = openSync(path, "r");
    try {
      writeFileSync(incoming, '{"generation":2}');
      renameSync(incoming, path);
      assert.equal(fstatSync(stale).nlink, 0, "the replaced inode has no directory entry");
      assert.throws(
        () => safeReadOpened(stale),
        (error: unknown) => error instanceof DomainError && (error.details as { reason?: string }).reason === "file was replaced while reading",
      );
    } finally { closeSync(stale); }
    // The path-based read must follow the replacement and return the new bytes.
    assert.deepEqual(JSON.parse(safeRead(path).toString()), { generation: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A genuine hard link must still be rejected: the guard exists so a managed
 * file cannot be aliased outside the private directory. */
test("a file with a second hard link is still refused", () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-safe-read-link-"));
  try {
    const path = join(root, "linked.json"), alias = join(root, "alias.json");
    writeFileSync(path, "{}");
    linkSync(path, alias);
    assert.throws(
      () => safeRead(path),
      (error: unknown) => error instanceof DomainError && (error.details as { reason?: string }).reason === "expected bounded regular file without hard links",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
