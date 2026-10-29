import assert from "node:assert/strict";
import { test } from "node:test";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { RepositoryEnvironmentChecks } from "../src/repository-environment-check.js";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { CodeRouteExecutions, type RouteEngine, type RouteExecution, type RouteEngineStatus } from "../src/code-route-execution.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";

test("environment check and default controls expose explicit public CLI help", async () => {
  for (const action of ["environment-check", "environment-check-show", "environment-set-default", "environment-default"]) {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", action, "--help", "--json"], { stdout: line => lines.push(line), stderr: () => {} });
    assert.equal(code, 0, lines.join("\n"));
    assertContract("cli-envelope.schema.json", JSON.parse(lines.join("\n")));
  }
});

class CheckEngine implements RouteEngine {
  exitCode = 0;
  stopUnknown = false;
  id = "check-engine";
  containers = new Set<string>();
  async identity() { return this.id; }
  async platform() { return "linux/amd64"; }
  async create(run: RouteExecution) { this.containers.add(run.execution_id); return run.execution_id; }
  async find(run: RouteExecution) { return this.containers.has(run.execution_id) ? run.execution_id : undefined; }
  async start(_run: RouteExecution) {}
  async status(_run: RouteExecution): Promise<RouteEngineStatus> { return { state: "exited", exit_code: this.exitCode }; }
  async removeStopped(run: RouteExecution) { if (this.stopUnknown) throw new Error("stop unknown"); this.containers.delete(run.execution_id); }
}

test("only a stopped successful environment check can explicitly replace the Repo default", async t => {
  const x = await executionFixture(t), versions = new RepositoryEnvironments(x.ledger.store), engine = new CheckEngine();
  const checks = new RepositoryEnvironmentChecks(x.ledger.store, engine);
  const v1 = await versions.save({ ...actor(), environment_id: newUUIDv7(), repository_id: x.route.repository_id,
    expected_version: 0, configuration: { name: "dev", image: `sha256:${"1".repeat(64)}` } });
  const request = { ...actor(), route_id: x.route.route_id, environment_revision_id: v1.revision_id };
  engine.stopUnknown = true;
  const pending = await checks.check(request);
  assert.equal(pending.state, "needs-recovery");
  await assert.rejects(versions.setDefault({ ...actor(), repository_id: x.route.repository_id, check_id: pending.check_id, expected_version: 0 }));
  engine.stopUnknown = false;
  const passed = await checks.check(request);
  assert.equal(passed.state, "passed");
  assert.equal(passed.platform, "linux/amd64");
  assert.equal(engine.containers.size, 0);
  await assert.rejects(versions.default(x.route.repository_id), { code: "NOT_FOUND" });
  const promotion = { ...actor(), repository_id: x.route.repository_id, check_id: passed.check_id, expected_version: 0 };
  const selected = await versions.setDefault(promotion);
  assert.equal(selected.revision_id, v1.revision_id);
  assert.equal(selected.version, 1);
  const v2 = await versions.save({ ...actor(), environment_id: v1.environment_id, repository_id: x.route.repository_id,
    expected_version: 1, configuration: { ...v1.configuration, image: `sha256:${"2".repeat(64)}` } });
  assert.deepEqual(await versions.default(x.route.repository_id), selected);
  engine.exitCode = 1;
  const failure = await checks.check({ ...actor(), route_id: request.route_id, environment_revision_id: v2.revision_id });
  assert.equal(failure.state, "failed");
  await assert.rejects(versions.setDefault({ ...promotion, ...actor(), expected_version: 1, check_id: failure.check_id }));
  assert.deepEqual(await versions.default(x.route.repository_id), selected);
  engine.exitCode = 0;
  const next = await checks.check({ ...actor(), route_id: request.route_id, environment_revision_id: v2.revision_id });
  const choices = await Promise.allSettled([1, 2].map(() => versions.setDefault({ ...actor(), repository_id: x.route.repository_id,
    expected_version: 1, check_id: next.check_id })));
  assert.equal(choices.filter(value => value.status === "fulfilled").length, 1);
  assert.equal((await versions.default(x.route.repository_id)).revision_id, v2.revision_id);
  assert.deepEqual(await versions.setDefault(promotion), selected, "old replay must not revert the new default");
  assert.deepEqual(await checks.check(request), passed);
  await assert.rejects(checks.check({ ...request, environment_revision_id: v2.revision_id }));
  assert.deepEqual((await x.ledger.store.inspectIntegrity()).report, { valid: true, issues: [] });
});

test("default resolution pins each execution and historical replay cannot adopt a later promotion", async t => {
  const x = await executionFixture(t), versions = new RepositoryEnvironments(x.ledger.store), engine = new CheckEngine();
  const checks = new RepositoryEnvironmentChecks(x.ledger.store, engine), executions = new CodeRouteExecutions(x.ledger.store, engine);
  const first = await versions.save({ ...actor(), environment_id: newUUIDv7(), repository_id: x.route.repository_id,
    expected_version: 0, configuration: { name: "dev", image: `sha256:${"1".repeat(64)}` } });
  const second = await versions.save({ ...actor(), environment_id: first.environment_id, repository_id: x.route.repository_id,
    expected_version: 1, configuration: { ...first.configuration, image: `sha256:${"2".repeat(64)}` } });
  const a = await checks.check({ ...actor(), route_id: x.route.route_id, environment_revision_id: first.revision_id });
  const b = await checks.check({ ...actor(), route_id: x.route.route_id, environment_revision_id: second.revision_id });
  await versions.setDefault({ ...actor(), repository_id: x.route.repository_id, check_id: a.check_id, expected_version: 0 });
  const request = { ...actor(), route_id: x.route.route_id, environment_default: true as const, argv: ["true"] };
  const run = await executions.start(request);
  assert.equal(run.environment!.revision_id, first.revision_id);
  assert.equal(run.environment_default!.version, 1);
  await versions.setDefault({ ...actor(), repository_id: x.route.repository_id, check_id: b.check_id, expected_version: 1 });
  assert.deepEqual(await executions.start(request), run);
  assert.equal((await executions.show({ route_id: run.route_id, execution_id: run.execution_id })).image, first.configuration.image);
  await executions.stop({ route_id: run.route_id, execution_id: run.execution_id });
  const next = await executions.start({ ...request, ...actor() });
  assert.equal(next.environment!.revision_id, second.revision_id);
  assert.equal(next.environment_default!.version, 2);
  await executions.stop({ route_id: next.route_id, execution_id: next.execution_id });
  await assert.rejects(executions.start({ ...request, ...actor(), image: first.configuration.image }));
  await assert.rejects(executions.start({ ...request, ...actor(), environment_revision_id: first.revision_id }));
  const other = await x.ledger.module.registerRepository({ ...actor(), canonical_remote: "ssh://git@example.test/team/foreign" });
  await assert.rejects(versions.setDefault({ ...actor(), repository_id: other.result.repository_id, check_id: a.check_id, expected_version: 0 }));
});
