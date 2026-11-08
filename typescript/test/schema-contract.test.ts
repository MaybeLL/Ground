import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertContract } from "./schema-fixture.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const filesBelow = (directory: string): string[] => readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
  .sort();

test("bundled plugin v1 contracts exactly mirror the canonical documentation contracts", () => {
  const canonical = join(repositoryRoot, "docs/contracts/v1");
  const bundled = join(repositoryRoot, "plugins/grounds/references/contracts/v1");
  const canonicalFiles = filesBelow(canonical);
  assert.deepEqual(filesBelow(bundled), canonicalFiles);
  for (const file of canonicalFiles) {
    assert.deepEqual(readFileSync(join(bundled, file)), readFileSync(join(canonical, file)), file);
  }
});

test("standalone help satisfies the command result contract", () => {
  assertContract("command-results.schema.json", {
    result_type: "patchledger.result.help/v1",
    command: "help",
    usage: "grounds init | requirement | repository | issue | devrun | candidate | verification | ledger | db | config",
  });
});
