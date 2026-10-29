import { assertContract } from "./schema-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LedgerFixture, testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { DevelopmentRecipes } from "../src/development-recipes.js";

test("a project owns immutable development recipes without Git and can update with concurrency checks", async t => {
  const ledger = await LedgerFixture.create(); t.after(() => ledger.close());
  const source = mkdtempSync(join(tmpdir(), "grounds-recipe-")); t.after(() => rmSync(source, { recursive: true, force: true }));
  const recipes = new DevelopmentRecipes(ledger.store), id = newUUIDv7();
  writeFileSync(join(source, "Dockerfile"), "FROM scratch\nCOPY file /file\n"); writeFileSync(join(source, "file"), "first\n");
  const request = { operation_id: newUUIDv7(), attribution: testAgent, recipe_id: id, repository_id: ledger.repository.repository_id,
    expected_version: 0, source, dockerfile: "Dockerfile", files: ["Dockerfile", "file"], name: "Development" };
  const first = await recipes.save(request);
  assert.equal(first.version, 1); assert.equal(first.files[1].content, Buffer.from("first\n").toString("base64"));
  writeFileSync(join(source, "file"), "second\n");
  const second = await recipes.save({ ...request, expected_version: 1, operation_id: newUUIDv7() });
  assert.equal(second.version, 2);
  await assert.rejects(recipes.save({ ...request, operation_id: newUUIDv7() }), /version|conflict/i);
  rmSync(source, { recursive: true });
  assert.deepEqual(await recipes.show(first.revision_id), first);
  assert.deepEqual(await recipes.save(request), first, "same operation replays saved bytes without reading mutable source");
  assert.equal(Object.hasOwn(first, "commit"), false);
});

test("public CLI saves and reads an internal recipe without a Git checkout", async t => {
  const { codeWorkspaceFixture } = await import("./code-workspace-fixture.js");
  const { runCLI } = await import("../src/cli.js");
  const x = await codeWorkspaceFixture(t), config = join(x.root, "config.json"), input = join(x.root, "recipe.json"), id = newUUIDv7();
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  writeFileSync(join(x.root, "Dockerfile"), "FROM scratch\n");
  writeFileSync(input, JSON.stringify({ name: "Internal", dockerfile: "Dockerfile", files: ["Dockerfile"] }));
  const call = async (args: string[]) => { const lines: string[] = []; const code = await runCLI(["code-workspace", ...args, "--config", config, "--json", ...(args[0] === "recipe-save" ? ["--agent-id", "fixture", "--agent-name", "Fixture"] : [])], { stdout: l => lines.push(l), stderr: () => {} }); const result = JSON.parse(lines.join("\n")); assert.equal(code, 0, JSON.stringify(result)); assertContract("cli-envelope.schema.json", result); return result.data; };
  const saved = await call(["recipe-save", id, "--repository", x.ledger.repository.repository_id, "--expected-version", "0", "--directory", x.root, "--file", input, "--operation-id", newUUIDv7()]);
  assert.equal(saved.recipe.name, "Internal");
  const shown = await call(["recipe-show", saved.recipe.revision_id]); assert.deepEqual(shown.recipe, saved.recipe);
});


test("recipe input rejects private paths, traversal, links and cross-repository replacement", async t => {
  const ledger = await LedgerFixture.create(); t.after(() => ledger.close());
  const root = mkdtempSync(join(tmpdir(), "grounds-recipe-boundary-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\n"); symlinkSync("Dockerfile", join(root, "link"));
  const recipes = new DevelopmentRecipes(ledger.store), request = { operation_id: newUUIDv7(), attribution: testAgent, recipe_id: newUUIDv7(), repository_id: ledger.repository.repository_id,
    expected_version: 0, source: root, name: "Dev", dockerfile: "Dockerfile", files: ["Dockerfile"] };
  for (const path of [".env", "../Dockerfile", "link", "auth.json"])
    await assert.rejects(recipes.save({ ...request, operation_id: newUUIDv7(), files: ["Dockerfile", path] }));
  const saved = await recipes.save(request);
  await assert.rejects(recipes.save({ ...request, operation_id: newUUIDv7(), repository_id: newUUIDv7(), expected_version: 1 }));
  assert.deepEqual(await recipes.show(saved.revision_id), saved);
});

test("a recipe can retain a bounded multi-megabyte build file without relaxing ordinary runtime records", async t => {
  const ledger = await LedgerFixture.create(); t.after(() => ledger.close());
  const root = mkdtempSync(join(tmpdir(), "grounds-large-recipe-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\nCOPY bundle /bundle\n"); writeFileSync(join(root, "bundle"), Buffer.alloc(2 * 1024 * 1024, 65));
  const recipes = new DevelopmentRecipes(ledger.store), request = { operation_id: newUUIDv7(), attribution: testAgent, recipe_id: newUUIDv7(), repository_id: ledger.repository.repository_id,
    expected_version: 0, source: root, name: "Large", dockerfile: "Dockerfile", files: ["Dockerfile", "bundle"] };
  const saved = await recipes.save(request), read = await recipes.show(saved.revision_id);
  assert.equal(Buffer.from(read.files[1].content, "base64").length, 2 * 1024 * 1024);
  await assert.rejects(ledger.store.write(tx => tx.saveRuntimeRecord({ id: newUUIDv7(), kind: "runtime_operation", version: 1, data: { format: "fixture", payload: "x".repeat(2 * 1024 * 1024) } }, 0)), /validation/);
});
