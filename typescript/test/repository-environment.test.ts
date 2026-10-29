import assert from "node:assert/strict";
import { test } from "node:test";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { codeWorkspaceFixture } from "./code-workspace-fixture.js";
import { actor } from "./code-route-execution-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { executionFixture } from "./code-route-execution-fixture.js";
import { CodeRouteExecutions, type RouteEngine, type RouteExecution } from "../src/code-route-execution.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

class RuntimeEngine implements RouteEngine {
  ready = false;
  stopUnknown = false;
  containers = new Set<string>();
  async identity() { return "runtime-engine"; }
  async prepareDependencies(_run: RouteExecution) { if (!this.ready) throw new Error("service is not ready"); }
  async stopDependencies(_run: RouteExecution) { if (this.stopUnknown) throw new Error("service stop unknown"); }
  async create(run: RouteExecution) { this.containers.add(run.execution_id); return run.execution_id; }
  async find(run: RouteExecution) { return this.containers.has(run.execution_id) ? run.execution_id : undefined; }
  async start(_run: RouteExecution) {}
  async removeStopped(run: RouteExecution) { this.containers.delete(run.execution_id); }
}

test("repository environment versions retain complete configuration and reject stale saves", async t => {
  const x = await codeWorkspaceFixture(t), service = new RepositoryEnvironments(x.ledger.store);
  const request = { ...actor(), environment_id: newUUIDv7(), expected_version: 0,
    repository_id: x.ledger.repository.repository_id,
    configuration: { name: "Development", image: `sha256:${"1".repeat(64)}`,
      postgres: { image: `sha256:${"2".repeat(64)}` } } };
  const first = await service.save(request);
  assert.equal(first.version, 1);
  assert.deepEqual(await service.save(request), first);
  const second = await service.save({ ...request, ...actor(), expected_version: 1,
    configuration: { ...request.configuration, image: `sha256:${"3".repeat(64)}` } });
  assert.equal(second.version, 2);
  assert.notEqual(second.revision_id, first.revision_id);
  assert.deepEqual(await new RepositoryEnvironments(x.ledger.store).revision(first.revision_id), first);
  assert.deepEqual((await service.revision(second.revision_id)).configuration, second.configuration);
  await assert.rejects(service.save({ ...request, ...actor() }));
  await assert.rejects(service.save({ ...request, configuration: { ...request.configuration, name: "changed replay" } }));
  await assert.rejects(service.save({ ...request, ...actor(), environment_id: newUUIDv7(),
    configuration: { name: "mutable", image: "postgres:16" } }));
});

test("execution pins a Repo environment and retains ownership until failed preparation is stopped", async t => {
  const x = await executionFixture(t), environments = new RepositoryEnvironments(x.ledger.store);
  const v1 = await environments.save({ ...actor(), environment_id: newUUIDv7(), expected_version: 0,
    repository_id: x.route.repository_id, configuration: { name: "dev", image: `sha256:${"1".repeat(64)}`,
      postgres: { image: `sha256:${"2".repeat(64)}` } } });
  const engine = new RuntimeEngine(), service = new CodeRouteExecutions(x.ledger.store, engine);
  const request = { ...actor(), route_id: x.route.route_id, environment_revision_id: v1.revision_id, argv: ["true"] };
  await assert.rejects(service.start(request), /service is not ready/);
  const ref = { route_id: request.route_id, execution_id: request.operation_id };
  const failed = await service.show(ref);
  assert.equal(failed.state, "preparing-runtime");
  assert.deepEqual(failed.environment, v1);
  assert.equal(engine.containers.size, 0);
  await environments.save({ ...actor(), environment_id: v1.environment_id, repository_id: v1.repository_id,
    expected_version: 1, configuration: { ...v1.configuration, image: `sha256:${"3".repeat(64)}` } });
  assert.deepEqual(await service.start(request), failed, "replay must neither upgrade the version nor retry external effects");
  await assert.rejects(service.start({ ...request, ...actor() }));
  await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
  engine.stopUnknown = true;
  await assert.rejects(service.stop(ref), /service stop unknown/);
  await assert.rejects(service.start({ ...request, ...actor() }));
  engine.stopUnknown = false;
  assert.equal((await service.stop(ref)).state, "stopped");
  engine.ready = true;
  const run = await service.start({ ...request, ...actor() });
  assert.equal(run.image, v1.configuration.image);
  assert.equal(run.state, "running");
  await service.stop({ route_id: run.route_id, execution_id: run.execution_id });
  await assert.rejects(service.start({ ...request, ...actor(), image: v1.configuration.image }));
  const other = await x.ledger.module.registerRepository({ ...actor(), canonical_remote: "ssh://git@example.test/team/another" });
  const foreign = await environments.save({ ...actor(), environment_id: newUUIDv7(), expected_version: 0,
    repository_id: other.result.repository_id, configuration: v1.configuration });
  await assert.rejects(service.start({ ...request, ...actor(), environment_revision_id: foreign.revision_id }), /another repository/);
  assert.equal(engine.containers.size, 0);
  await assert.rejects(environments.save({ ...actor(), environment_id: v1.environment_id, expected_version: 2,
    repository_id: other.result.repository_id, configuration: v1.configuration }));
});

test("public CLI saves and reads an immutable repository environment revision", async t => {
  const x = await codeWorkspaceFixture(t), config = join(x.root, "config.json"), file = join(x.root, "environment.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  writeFileSync(file, JSON.stringify({ name: "dev", image: `sha256:${"1".repeat(64)}` }));
  const invoke = async (...args: string[]) => {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", ...args, "--config", config, "--json"],
      { stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n"));
    assert.equal(code, 0, JSON.stringify(envelope));
    assertContract("cli-envelope.schema.json", envelope);
    return envelope.data.environment;
  };
  const environment = await invoke("environment-save", newUUIDv7(), "--repository", x.ledger.repository.repository_id,
    "--expected-version", "0", "--file", file, "--agent-id", "fixture", "--agent-name", "Fixture");
  assert.equal(environment.version, 1);
  assert.equal(environment.repository_id, x.ledger.repository.repository_id);
  assert.deepEqual(await invoke("environment-show", environment.revision_id), environment);
});

test("environment-show identifies a missing revision instead of a missing database", async t => {
  const x = await codeWorkspaceFixture(t);
  const config = join(x.root, "missing-environment-config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const id = newUUIDv7();
  const lines: string[] = [];
  const code = await runCLI(["code-workspace", "environment-show", id, "--config", config, "--json"],
    { stdout: line => lines.push(line), stderr: () => {} });
  const envelope = JSON.parse(lines.join("\n"));
  assert.equal(code, 3);
  assert.equal(envelope.error.code, "NOT_FOUND");
  assert.equal(envelope.error.retryable, false);
  assert.deepEqual(envelope.error.details, { resource_type: "environment_revision", resource_id: id });
  assertContract("cli-envelope.schema.json", envelope);
});


test("environment-show distinguishes environment identity, revision and invalid input", async t => {
  const x = await codeWorkspaceFixture(t), config = join(x.root, "lookup-config.json"), file = join(x.root, "environment.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  writeFileSync(file, JSON.stringify({ name: "lookup", image: `sha256:${"1".repeat(64)}` }));
  const invoke = async (...args: string[]) => {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", ...args, "--config", config, "--json"],
      { stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n"));
    assertContract("cli-envelope.schema.json", envelope);
    return { code, envelope };
  };
  const id = newUUIDv7();
  const saved = await invoke("environment-save", id, "--repository", x.ledger.repository.repository_id,
    "--expected-version", "0", "--file", file, "--agent-id", "fixture", "--agent-name", "Fixture");
  assert.equal(saved.code, 0);
  const environment = saved.envelope.data.environment;
  const mistaken = await invoke("environment-show", id);
  assert.equal(mistaken.code, 3);
  assert.equal(mistaken.envelope.error.code, "NOT_FOUND");
  assert.equal(mistaken.envelope.error.retryable, false);
  assert.deepEqual(mistaken.envelope.error.details, { resource_type: "environment_revision", resource_id: id });
  const found = await invoke("environment-show", environment.revision_id);
  assert.equal(found.code, 0);
  assert.deepEqual(found.envelope.data.environment, environment);
  const invalid = await invoke("environment-show", "not-a-uuid");
  assert.equal(invalid.code, 2);
  assert.equal(invalid.envelope.error.code, "VALIDATION_ERROR");
});

test("environment-default identifies a repository without a configured default", async t => {
  const x = await codeWorkspaceFixture(t);
  const config = join(x.root, "missing-default-config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const repositoryId = x.ledger.repository.repository_id;
  const lines: string[] = [];
  const code = await runCLI(["code-workspace", "environment-default", repositoryId, "--config", config, "--json"],
    { stdout: line => lines.push(line), stderr: () => {} });
  const envelope = JSON.parse(lines.join("\n"));
  assert.equal(code, 3);
  assert.equal(envelope.error.code, "NOT_FOUND");
  assert.equal(envelope.error.retryable, false);
  assert.deepEqual(envelope.error.details, { resource_type: "environment_default", resource_id: repositoryId });
  assertContract("cli-envelope.schema.json", envelope);

  const invalidLines: string[] = [];
  const invalidCode = await runCLI(["code-workspace", "environment-default", "not-a-uuid", "--config", config, "--json"],
    { stdout: line => invalidLines.push(line), stderr: () => {} });
  const invalid = JSON.parse(invalidLines.join("\n"));
  assert.equal(invalidCode, 2);
  assert.equal(invalid.error.code, "VALIDATION_ERROR");
  assertContract("cli-envelope.schema.json", invalid);
});
