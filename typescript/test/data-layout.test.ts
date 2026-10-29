import { DomainError } from "../src/errors.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataLayout, dataRoot, previousDataLocations } from "../src/data-layout.js";

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
    database: "/persistent/grounds/grounds.db", drafts: "/persistent/grounds/drafts",
    workspaces: "/persistent/grounds/workspaces", runtime: "/persistent/grounds/runtime",
    cache: "/persistent/grounds/cache", directoryRegistry: join(homedir(), ".grounds", "directory-registry"),
  });
  assert.throws(() => dataLayout("relative"), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.reason).includes("absolute"));
});

test("migration discovery preserves historical macOS and XDG locations", () => {
  assert.deepEqual(previousDataLocations("darwin", "/users/test", {}), {
    config: "/users/test/Library/Application Support/Grounds/config.yaml",
    data: "/users/test/Library/Application Support/Grounds",
    runtime: "/users/test/.local/share/grounds-runtime",
    directoryRegistry: "/users/test/.local/share/grounds-directory-registry",
  });
  const linux = previousDataLocations("linux", "/users/test", {
    XDG_CONFIG_HOME: "/configs", XDG_DATA_HOME: "/data", GROUNDS_RUNTIME_HOME: "/runtime",
  });
  assert.equal(linux.config, "/configs/grounds/config.yaml");
  assert.equal(linux.data, "/data/grounds");
  assert.equal(linux.runtime, "/runtime");
});

test("directory reservations remain shared when task roots differ", () => {
  assert.equal(dataLayout("/task-a").directoryRegistry, dataLayout("/task-b").directoryRegistry);
});
