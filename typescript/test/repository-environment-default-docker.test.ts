import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { CodeRouteExecutions } from "../src/code-route-execution.js";
import { DockerRouteEngine } from "../src/code-route-docker.js";
import { docker } from "../src/env-docker.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";
import { runCLI } from "../src/cli.js";

test("real CLI checks Git/Python/PostgreSQL before explicit default promotion and preserves the default after probe failure", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const requests: { route_id: string; execution_id: string }[] = [];
  t.after(async () => {
    const dependencies = new Map<string, { container_id: string; network_id: string; volume_name: string }>();
    for (const ref of requests) {
      const stopped = await executions.stop(ref);
      if (stopped.dependency) dependencies.set(stopped.dependency.container_id, stopped.dependency);
    }
    for (const dependency of dependencies.values()) {
      docker(["rm", dependency.container_id]);
      docker(["volume", "rm", dependency.volume_name]);
      docker(["network", "rm", dependency.network_id]);
    }
  });
  const x = await executionFixture(t), environments = new RepositoryEnvironments(x.ledger.store);
  const executions = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
  // Repository files must not replace the fixed readiness probe's standard library.
  writeFileSync(join(x.route.path, "subprocess.py"), "raise RuntimeError('repository module must not run in readiness probe')\n");
  await x.admit();
  const config = join(x.root, "cli.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const invoke = async (args: string[], expectedCode = 0) => {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", ...args, "--config", config, "--json"],
      { stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n"));
    assert.equal(code, expectedCode, JSON.stringify(envelope));
    assertContract("cli-envelope.schema.json", envelope);
    return envelope.data;
  };
  const good = await environments.save({ ...actor(), environment_id: newUUIDv7(), repository_id: x.route.repository_id,
    expected_version: 0, configuration: { name: "checked local tools", image: process.env.GROUNDS_CODE_DOCKER_IMAGE!,
      postgres: { image: process.env.GROUNDS_CODE_POSTGRES_IMAGE! } } });
  const check = async (revision: string, expectedCode: number) => {
    const id = newUUIDv7(); requests.push({ route_id: x.route.route_id, execution_id: id });
    const args = ["environment-check", x.route.route_id, "--revision", revision, "--operation-id", id,
      "--agent-id", "fixture", "--agent-name", "Fixture"];
    const result = await invoke(args, expectedCode);
    assert.deepEqual((await invoke(["environment-check-show", id])).check, result.check);
    assert.deepEqual((await invoke(args, expectedCode)).check, result.check);
    assert.equal((await executions.show(requests.at(-1)!)).state, "stopped");
    return result.check;
  };
  const passed = await check(good.revision_id, 0);
  assert.equal(passed.state, "passed");
  assert.equal(passed.exit_code, 0);
  await assert.rejects(environments.default(x.route.repository_id), { code: "NOT_FOUND" });
  const selected = (await invoke(["environment-set-default", x.route.repository_id, "--check", passed.check_id,
    "--expected-version", "0", "--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"])).default;
  assert.equal(selected.revision_id, good.revision_id);
  const bad = await environments.save({ ...actor(), environment_id: good.environment_id, repository_id: x.route.repository_id,
    expected_version: 1, configuration: { ...good.configuration, image: process.env.GROUNDS_CODE_REPLACEMENT_IMAGE! } });
  const failed = await check(bad.revision_id, 1);
  assert.equal(failed.state, "failed");
  assert.equal(failed.reason, "probe-failed");
  await assert.rejects(environments.setDefault({ ...actor(), repository_id: x.route.repository_id,
    check_id: failed.check_id, expected_version: 1 }));
  assert.deepEqual((await invoke(["environment-default", x.route.repository_id])).default, selected);
  const executionID = newUUIDv7(), file = join(x.root, "start.json");
  writeFileSync(file, JSON.stringify({ environment_default: true, argv: ["git", "--version"] }));
  requests.push({ route_id: x.route.route_id, execution_id: executionID });
  const run = (await invoke(["execution-start", x.route.route_id, "--file", file, "--operation-id", executionID,
    "--agent-id", "fixture", "--agent-name", "Fixture"])).execution;
  assert.deepEqual(run.environment_default, selected);
  assert.equal(run.environment.revision_id, good.revision_id);
});
