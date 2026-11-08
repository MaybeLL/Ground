import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { flockSync, lockContended } from "../src/native-binding.js";

test("native locks distinguish contention from an invalid descriptor", () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-native-lock-"));
  const path = join(root, "lock");
  const first = openSync(path, "w");
  const second = openSync(path, "r+");
  try {
    flockSync(first, "shnb");
    flockSync(second, "shnb");
    assert.throws(() => flockSync(first, "exnb"), lockContended);
  } finally {
    closeSync(first);
    closeSync(second);
    rmSync(root, { recursive: true, force: true });
  }
  assert.throws(() => flockSync(second, "exnb"), error => (error as NodeJS.ErrnoException).code === "EBADF" && !lockContended(error));
});
