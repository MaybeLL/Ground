import { DomainError } from "../src/errors.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataLayout, dataRoot } from "../src/data-layout.js";

test("data root has one cross-platform default and explicit overrides win", () => {
  const old = process.env.GROUNDS_DATA_HOME;
  try {
    delete process.env.GROUNDS_DATA_HOME;
    assert.equal(dataRoot(), join(homedir(), ".grounds"));
    process.env.GROUNDS_DATA_HOME = "/mounted/grounds";
    assert.equal(dataRoot(), "/mounted/grounds");
    assert.equal(dataRoot("other", "/workspace"), "/workspace/other");
    process.env.GROUNDS_DATA_HOME = " ";
    assert.throws(() => dataRoot(), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.reason).includes("empty"));
    assert.equal(dataRoot("/explicit"), "/explicit");
  } finally {
    if (old === undefined) delete process.env.GROUNDS_DATA_HOME;
    else process.env.GROUNDS_DATA_HOME = old;
  }
});

test("all managed categories have a deterministic location without accessing disk", () => {
  assert.deepEqual(dataLayout("/persistent/grounds"), {
    root: "/persistent/grounds", config: "/persistent/grounds/config.yaml",
    database: "/persistent/grounds/grounds.db",
    workspaces: "/persistent/grounds/workspaces", runtime: "/persistent/grounds/runtime",
    cache: "/persistent/grounds/cache", directoryRegistry: join(homedir(), ".grounds", "directory-registry"),
  });
  assert.throws(() => dataLayout("relative"), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.reason).includes("absolute"));
});

test("directory reservations remain shared when task roots differ", () => {
  assert.equal(dataLayout("/task-a").directoryRegistry, dataLayout("/task-b").directoryRegistry);
});
