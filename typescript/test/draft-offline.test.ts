import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, realpathSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../src/cli.js";
import { writeConfig } from "../src/config.js";
import { newUUIDv7 } from "../src/identity.js";
import { DomainError } from "../src/errors.js";

test("draft creation, editing and repository binding need configured identity but no Git or live ledger", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-offline-")));
  const old = process.env.GROUNDS_DATA_HOME;
  process.env.GROUNDS_DATA_HOME = join(root, "data");
  const config = join(root, "config.yaml"), cwd = join(root, "empty");
  mkdirSync(cwd);
  const database = join(root, "unavailable", "ledger.db");
  const databaseId = newUUIDv7();
  writeConfig(config, { version: 2, database: { driver: "sqlite", path: database, expected_database_id: databaseId } });
  const call = (...args: string[]) => execute([...args, "--config", config, "--cwd", cwd, "--json"], { isTTY: false });
  try {
    const created = await call("draft", "new", "first") as any;
    assert.equal(created.path, join(root, "data", "drafts", databaseId, "first"));
    assert.equal(existsSync(database), false);
    const read = await call("draft", "read", "first") as any;
    assert.equal(read.manifest.repository_remote, "");
    read.draft.requirement.summary = "Offline requirement";
    const file = join(root, "edit.json"); writeFileSync(file, JSON.stringify(read.draft));
    const saved = await call("draft", "save", "first", "--file", file, "--expected-version", read.version) as any;
    assert.equal(saved.draft.requirement.summary, "Offline requirement");
    await assert.rejects(call("draft", "save", "first", "--file", file, "--expected-version", read.version), (e: unknown) => e instanceof DomainError && e.code === "VERSION_CONFLICT");
    const bound = await call("draft", "bind", "first", "--remote-url", "https://example.com/team/repo.git", "--expected-version", saved.version) as any;
    assert.ok(bound.manifest.repository_remote.includes("example.com"));
    assert.notEqual(bound.version, saved.version);
    assert.equal((await call("workspace", "read", "first") as any).version, bound.version);
    assert.equal(existsSync(database), false);
    const other = join(root, "other.yaml");
    const otherId = newUUIDv7();
    mkdirSync(join(root, "data", "drafts", otherId));
    cpSync(created.path, join(root, "data", "drafts", otherId, "first"), { recursive: true });
    writeConfig(other, { version: 2, database: { driver: "sqlite", path: database, expected_database_id: otherId } });
    await assert.rejects(execute(["draft", "read", "first", "--config", other, "--cwd", cwd]), (e: unknown) => e instanceof DomainError && e.code === "DATABASE_ID_MISMATCH");
  } finally {
    if (old === undefined) delete process.env.GROUNDS_DATA_HOME; else process.env.GROUNDS_DATA_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
});


test("draft help uses the public name and describes ledger-scoped local storage", async () => {
  const help = await execute(["draft", "--help"], { isTTY: false }) as any;
  assert.match(help.usage, /^grounds draft/);
  assert.match(help.usage, /configured ledger identity/);
  assert.doesNotMatch(help.usage, /project-local authoring Workspaces/);
  const old = await execute(["workspace", "new", "--help"], { isTTY: false }) as any;
  assert.match(old.usage, /^grounds draft new/);
});
