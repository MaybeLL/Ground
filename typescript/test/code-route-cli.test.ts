import assert from "node:assert/strict";
import { test } from "node:test";
import { runCLI } from "../src/cli.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";
import { writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { codeWorkspaceFixture } from "./code-workspace-fixture.js";

const invoke = async (...args: string[]) => {
  const lines: string[] = [];
  const code = await runCLI(["code-workspace", ...args, "--json"], { stdout: line => lines.push(line), stderr: () => {} });
  const envelope = JSON.parse(lines.join("\n"));
  assertContract("cli-envelope.schema.json", envelope);
  return { code, envelope };
};

test("execution command help exposes fixed inputs and rejects unrelated options before database access", async () => {
  for (const action of ["execution-start", "execution-show", "execution-serve", "execution-stop"]) {
    const help = await invoke(action, "--help");
    assert.equal(help.code, 0, JSON.stringify(help.envelope));
    assert.ok(JSON.stringify(help.envelope.data).includes(action));
  }
  for (const args of [["execution-start", newUUIDv7(), "--data-root", "/invalid"],
    ["execution-stop", newUUIDv7(), newUUIDv7(), "--discard-changes"],
    ["execution-serve", newUUIDv7()], ["execution-show", newUUIDv7(), newUUIDv7(), "extra"]]) {
    const result = await invoke(...args, "--config", "/does-not-exist");
    assert.equal(result.code, 2);
    assert.equal(result.envelope.error.code, "VALIDATION_ERROR");
  }
});

test("execution start rejects unsafe files and caller-selected authority before creating an execution", async t => {
  const x = await codeWorkspaceFixture(t), config = join(x.root, "cli-config.json"), file = join(x.root, "start.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const args = ["execution-start", newUUIDv7(), "--config", config, "--file", file,
    "--agent-id", "fixture", "--agent-name", "Fixture"];
  const valid = { image: `sha256:${"1".repeat(64)}`, argv: ["true"] };
  for (const content of [null, [], { ...valid, route_id: newUUIDv7() }, { ...valid, mounts: [] },
    { ...valid, attribution: {} }, { ...valid, mode: "privileged" }, { ...valid, argv: [] }]) {
    writeFileSync(file, JSON.stringify(content));
    const result = await invoke(...args);
    assert.equal(result.code, 2, JSON.stringify(result.envelope));
    assert.equal(result.envelope.error.code, "VALIDATION_ERROR");
  }
  unlinkSync(file); symlinkSync(config, file);
  assert.equal((await invoke(...args)).code, 2);
  unlinkSync(file); execFileSync("mkfifo", [file]);
  const fifo = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/main.ts", import.meta.url)),
    "code-workspace", ...args, "--json"], { encoding: "utf8", timeout: 5000 });
  assert.equal(fifo.error, undefined, "a special start file must be rejected without blocking");
  assert.equal(fifo.status, 2);
  assertContract("cli-envelope.schema.json", JSON.parse(fifo.stdout));
});
