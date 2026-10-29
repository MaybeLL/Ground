import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCLI } from "../src/cli.js";
import { codeWorkspaceFixture } from "./code-workspace-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";

test("CLI saves and reads immutable code Workspace configurations without entering contract authoring", async t => {
  const x = await codeWorkspaceFixture(t), config = join(x.root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath, expected_database_id: (await x.ledger.store.open()).database_id } }));
  const run = async (args: string[]) => {
    const output: string[] = [];
    const code = await runCLI(["code-workspace", ...args, "--config", config, "--json"], { cwd: x.root, stdout: line => output.push(line), stderr: () => {} });
    return { code, envelope: JSON.parse(output.join("\n")) };
  };
  const file = join(x.root, "workspace-config.json");
  const configuration = { name: "Order context", repositories: [{ repository_id: x.ledger.repository.repository_id, alias: "orders", revision: { branch: "main" } }] };
  writeFileSync(file, JSON.stringify(configuration));
  const id = newUUIDv7(), operation = newUUIDv7();
  const args = ["config-save", id, "--file", file, "--expected-version", "0", "--operation-id", operation, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const saved = await run(args);
  assert.equal(saved.code, 0, JSON.stringify(saved.envelope));
  assertContract("cli-envelope.schema.json", saved.envelope);
  assert.deepEqual(saved.envelope.data.configuration.configuration, configuration);
  assert.deepEqual((await run(args)).envelope.data, saved.envelope.data);
  const shown = await run(["config-show", id, "--version", "1"]);
  assert.equal(shown.code, 0, JSON.stringify(shown.envelope));
  assertContract("cli-envelope.schema.json", shown.envelope);
  assert.deepEqual(shown.envelope.data.configuration, saved.envelope.data.configuration);
  assert.equal((await run(["config-show", id, "--allow-cached"])).code, 2, "unrelated options are rejected");
  writeFileSync(file, "{invalid JSON}");
  const invalid = await run(["config-save", newUUIDv7(), "--file", file, "--expected-version", "0", "--agent-id", "fixture", "--agent-name", "Fixture"]);
  assert.equal(invalid.code, 2, "malformed input is a validation error");
  assertContract("cli-envelope.schema.json", invalid.envelope);
});

test("CLI preparation reuses the recorded local instance and never grants execution", async t => {
  const x = await codeWorkspaceFixture(t), config = join(x.root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath, expected_database_id: (await x.ledger.store.open()).database_id } }));
  const instance = await x.create();
  const prepared = await x.service.prepareInstance({ instance_id: instance.instance_id, host_id: x.hostId, data_root: x.dataRoot });
  writeFileSync(join(x.dataRoot, "runtime", "host-id"), x.hostId);
  const output: string[] = [];
  const code = await runCLI(["code-workspace", "prepare", instance.instance_id, "--data-root", x.dataRoot, "--config", config, "--json"],
    { cwd: x.root, stdout: line => output.push(line), stderr: () => {} });
  const envelope = JSON.parse(output.join("\n"));
  assert.equal(code, 0, JSON.stringify(envelope));
  assertContract("cli-envelope.schema.json", envelope);
  assert.deepEqual(envelope.data.instance, prepared);
});

test("CLI creates an Issue instance with fixed context and reports preparation separately from execution", async t => {
  const x = await codeWorkspaceFixture(t), config = join(x.root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath, expected_database_id: (await x.ledger.store.open()).database_id } }));
  const run = async (args: string[]) => {
    const output: string[] = [];
    const code = await runCLI(["code-workspace", ...args, "--config", config, "--json"], { cwd: x.root, stdout: line => output.push(line), stderr: () => {} });
    return { code, envelope: JSON.parse(output.join("\n")) };
  };
  const request = ["create", "--configuration", x.configurationId, "--version", "1", "--issue", x.ledger.issue.issue_id,
    "--issue-version", "1", "--data-root", x.dataRoot, "--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"];
  const created = await run(request);
  assert.equal(created.code, 0, JSON.stringify(created.envelope));
  assertContract("cli-envelope.schema.json", created.envelope);
  assert.equal(created.envelope.data.instance.execution_enabled, false);
  assert.equal(created.envelope.data.instance.state, "preparing");
  assert.deepEqual((await run(request)).envelope.data, created.envelope.data);
  const shown = await run(["show", created.envelope.data.instance.instance_id]);
  assert.equal(shown.code, 0);
  assert.deepEqual(shown.envelope.data.instance, created.envelope.data.instance);
});

test("CLI prepares and reads an instance route without creating a DevRun or granting execution", async t => {
  const x = await codeWorkspaceFixture(t), config = join(x.root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath, expected_database_id: (await x.ledger.store.open()).database_id } }));
  const instance = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  writeFileSync(join(x.dataRoot, "runtime", "host-id"), x.hostId);
  const run = async (args: string[]) => {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", ...args, "--config", config, "--json"], { cwd: x.root, stdout: line => lines.push(line), stderr: () => {} });
    return { code, envelope: JSON.parse(lines.join("\n")) };
  };
  const request = ["route-prepare", instance.instance_id, "--data-root", x.dataRoot, "--issue-slug", "orders-change",
    "--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"];
  const prepared = await run(request);
  assert.equal(prepared.code, 0, JSON.stringify(prepared.envelope));
  assertContract("cli-envelope.schema.json", prepared.envelope);
  assert.equal(prepared.envelope.data.route.execution_enabled, false);
  assert.equal(prepared.envelope.data.route.instance_id, instance.instance_id);
  assert.equal(Object.hasOwn(prepared.envelope.data.route, "dev_run_id"), false);
  assert.deepEqual((await run(request)).envelope.data, prepared.envelope.data);
  const shown = await run(["route-show", prepared.envelope.data.route.route_id]);
  assert.equal(shown.code, 0);
  assertContract("cli-envelope.schema.json", shown.envelope);
  assert.deepEqual(shown.envelope.data.route, prepared.envelope.data.route);
  assert.equal((await run([...request, "--base-commit", x.firstCommit])).code, 2, "cannot silently override the fixed context base");
});
