import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { CodeRouteExecutions, type RouteExecution } from "../src/code-route-execution.js";
import { DockerRouteEngine } from "../src/code-route-docker.js";
import { docker } from "../src/env-docker.js";
import { newUUIDv7 } from "../src/identity.js";
import { git } from "../src/env-git.js";
import { assertContract } from "./schema-fixture.js";
import { runCLI } from "../src/cli.js";
import { PreflightService } from "../src/preflight.js";
import { CodeRouteGit } from "../src/code-route-git.js";

// A real query from the execution container, using only Python's standard library.
const query = (sql: string) => `import os,socket,struct
s=socket.create_connection((os.environ['PGHOST'],int(os.environ['PGPORT'])),5)
s.settimeout(10)
def read(n):
 b=b''
 while len(b)<n:
  c=s.recv(n-len(b))
  assert c,'unexpected EOF'
  b+=c
 return b
def ready():
 while True:
  kind=read(1); data=read(struct.unpack('!I',read(4))[0]-4)
  assert kind!=b'E',data
  if kind==b'Z': break
body=struct.pack('!I',196608)+b'user\\0postgres\\0database\\0task\\0\\0'
s.sendall(struct.pack('!I',len(body)+4)+body);ready()
body=${JSON.stringify(sql)}.encode()+b'\\0'
s.sendall(b'Q'+struct.pack('!I',len(body)+4)+body);ready()
open('/workspace/runtime-result.txt','w').write('service query succeeded')
`;

test("real runtime connects to private PostgreSQL and rebuilding execution preserves service data and code", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const requests: { route_id: string; execution_id: string }[] = [];
  const dependencies: { network_id: string; container_id: string; volume_name: string }[] = [];
  t.after(async () => {
    for (const ref of requests) { try { await executions.stop(ref); } catch {} }
    // Only this test's recorded exact resources, never engine-wide prune.
    for (const dependency of dependencies) {
      docker(["rm", dependency.container_id]); docker(["volume", "rm", dependency.volume_name]); docker(["network", "rm", dependency.network_id]);
    }
  });
  const x = await executionFixture(t), engine = new DockerRouteEngine(), executions = new CodeRouteExecutions(x.ledger.store, engine);
  const environments = new RepositoryEnvironments(x.ledger.store);
  const version = await environments.save({ ...actor(), environment_id: newUUIDv7(), expected_version: 0,
    repository_id: x.route.repository_id, configuration: { name: "postgres integration", image: process.env.GROUNDS_CODE_DOCKER_IMAGE!,
      postgres: { image: process.env.GROUNDS_CODE_POSTGRES_IMAGE! } } });
  const before = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  const config = join(x.root, "cli.json"), file = join(x.root, "execution.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const execute = async (revision: string, sql: string) => {
    const request = { ...actor(), route_id: x.route.route_id, environment_revision_id: revision,
      mode: "development" as const, argv: ["python3", "-c", query(sql)] };
    const ref = { route_id: request.route_id, execution_id: request.operation_id }; requests.push(ref);
    writeFileSync(file, JSON.stringify({ environment_revision_id: revision, mode: request.mode, argv: request.argv }));
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", "execution-start", request.route_id, "--file", file,
      "--operation-id", request.operation_id, "--config", config, "--agent-id", "fixture", "--agent-name", "Fixture", "--json"],
      { stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n"));
    assert.equal(code, 0, JSON.stringify(envelope));
    assertContract("cli-envelope.schema.json", envelope);
    const run = envelope.data.execution;
    assertContract("code-execution.schema.json#/$defs/execution", run);
    assert.ok(run.dependency);
    if (!dependencies.some(d => d.container_id === run.dependency!.container_id)) dependencies.push(run.dependency!);
    for (let i = 0; i < 40; i++) {
      const observation = await executions.observe(ref);
      if (observation.status.state === "exited") {
        assert.equal(observation.status.exit_code, 0, docker(["logs", run.container_id!]));
        await executions.stop(ref);
        return run;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.fail("execution did not exit");
  };
  const first = await execute(version.revision_id, "CREATE TABLE retained(value text); INSERT INTO retained VALUES ('original');");
  const service = JSON.parse(docker(["inspect", first.dependency!.container_id]))[0];
  assert.equal(service.State.Running, false);
  assert.deepEqual(service.HostConfig.PortBindings, {});
  assert.equal(JSON.parse(docker(["network", "inspect", first.dependency!.network_id]))[0].Internal, true);
  const managedGit = new CodeRouteGit(x.ledger.store, x.route.route_id);
  await managedGit.apply({ ...actor(), action: "stage", snapshot: await managedGit.snapshot(["runtime-result.txt"]) });
  await managedGit.apply({ ...actor(), action: "commit", snapshot: await managedGit.snapshot([]),
    message: "Record successful service test", author: { name: "Fixture", email: "fixture@example.invalid" } });
  const developedCommit = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  assert.notEqual(developedCommit, before);
  const secondVersion = await environments.save({ ...actor(), environment_id: version.environment_id,
    repository_id: version.repository_id, expected_version: 1,
    configuration: { ...version.configuration, image: process.env.GROUNDS_CODE_REPLACEMENT_IMAGE!, name: "rebuild execution" } });
  await x.admit();
  const second = await execute(secondVersion.revision_id, "DO $$ BEGIN IF (SELECT value FROM retained) <> 'original' THEN RAISE EXCEPTION 'data lost'; END IF; END $$;");
  assert.notEqual(first.container_id, second.container_id);
  assert.notEqual(first.image, second.image);
  assert.deepEqual(second.dependency, first.dependency);
  assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), developedCommit);
  assert.equal(git(["show", "HEAD:runtime-result.txt"], { cwd: x.route.path }), "service query succeeded");
  assert.equal(readFileSync(join(x.route.path, "runtime-result.txt"), "utf8"), "service query succeeded");
  assert.deepEqual((await executions.show(requests[0]!)).environment, version);
});

test("parallel routes isolate SQL data and a lost preparation reply retains exclusive ownership until stop", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const requests: { route_id: string; execution_id: string }[] = [];
  const dependencies: { network_id: string; container_id: string; volume_name: string }[] = [];
  t.after(async () => {
    for (const ref of requests) { try { await executions.stop(ref); } catch {} }
    for (const dependency of dependencies) {
      docker(["rm", dependency.container_id]); docker(["volume", "rm", dependency.volume_name]); docker(["network", "rm", dependency.network_id]);
    }
  });
  const x = await executionFixture(t), engine = new DockerRouteEngine(), executions = new CodeRouteExecutions(x.ledger.store, engine);
  const prepared = await x.routes.prepare({ ...actor(), instance_id: x.instance.instance_id, host_id: x.hostId,
    data_root: x.dataRoot, issue_slug: "parallel" });
  const sibling = await x.routes.bindDevRun({ ...actor(), route_id: prepared.route_id, host_id: x.hostId, data_root: x.dataRoot });
  const preflight = new PreflightService(x.ledger.store, sibling.path);
  const observed = await preflight.observe({ ...actor(), phase: "start", dev_run_id: sibling.dev_run_id!, refresh: true });
  const assessment = await preflight.assess({ ...actor(), observation_id: observed.id,
    file: { assessment: "applicable", rationale: "Reviewed parallel route", affected: [] } });
  await preflight.admit({ ...actor(), dev_run_id: sibling.dev_run_id!, assessment_id: assessment.id, refresh: true });
  const version = await new RepositoryEnvironments(x.ledger.store).save({ ...actor(), environment_id: newUUIDv7(), expected_version: 0,
    repository_id: x.route.repository_id, configuration: { name: "parallel", image: process.env.GROUNDS_CODE_DOCKER_IMAGE!,
      postgres: { image: process.env.GROUNDS_CODE_POSTGRES_IMAGE! } } });
  const start = async (route_id: string, marker: string) => {
    const request = { ...actor(), route_id, environment_revision_id: version.revision_id, mode: "development" as const,
      argv: ["python3", "-c", query(`CREATE TABLE marker(value text); INSERT INTO marker VALUES ('${marker}');`) + "import time; time.sleep(120)\n"] };
    const ref = { route_id, execution_id: request.operation_id }; requests.push(ref);
    const run = await executions.start(request); dependencies.push(run.dependency!);
    for (let i = 0; i < 40; i++) {
      try {
        const rows = docker(["exec", run.dependency!.container_id, "psql", "-U", "postgres", "-d", "task", "-Atc", "SELECT value FROM marker"]);
        if (rows === marker) return run;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.fail("route did not initialize its own data");
  };
  const a = await start(x.route.route_id, "A"), b = await start(sibling.route_id, "B");
  assert.notEqual(a.dependency!.network_id, b.dependency!.network_id);
  assert.notEqual(a.dependency!.volume_name, b.dependency!.volume_name);
  assert.equal((await executions.observe(requests[0]!)).status.state, "running");
  assert.equal((await executions.observe(requests[1]!)).status.state, "running");
  await executions.stop(requests[0]!);
  assert.equal((await executions.observe(requests[1]!)).status.state, "running");
  assert.equal(docker(["exec", b.dependency!.container_id, "psql", "-U", "postgres", "-d", "task", "-Atc", "SELECT value FROM marker"]), "B");
  await x.admit();
  class LostReply extends DockerRouteEngine {
    override async prepareDependencies(run: RouteExecution): ReturnType<DockerRouteEngine["prepareDependencies"]> {
      await super.prepareDependencies(run); throw new Error("dependency reply lost");
    }
  }
  const lost = new CodeRouteExecutions(x.ledger.store, new LostReply());
  const request = { ...actor(), route_id: a.route_id, environment_revision_id: version.revision_id, argv: ["true"] };
  const ref = { route_id: a.route_id, execution_id: request.operation_id }; requests.push(ref);
  await assert.rejects(lost.start(request), /dependency reply lost/);
  const receipt = await lost.show(ref);
  assert.equal(receipt.state, "preparing-runtime");
  assert.equal(await engine.find(receipt), undefined);
  await assert.rejects(executions.start({ ...request, ...actor() }));
  await executions.stop(requests[0]!); // An old stop must not affect the newly reserved preparation.
  assert.equal(JSON.parse(docker(["inspect", a.dependency!.container_id]))[0].State.Running, true);
  assert.equal((await executions.stop(ref)).state, "stopped");
  assert.equal(JSON.parse(docker(["inspect", a.dependency!.container_id]))[0].State.Running, false);
  await executions.stop(requests[1]!);
  class ServiceStopsBeforeStart extends DockerRouteEngine {
    override async create(run: RouteExecution) {
      const id = await super.create(run);
      docker(["stop", "--time", "5", run.dependency!.container_id]);
      return id;
    }
  }
  const stoppedDependency = new CodeRouteExecutions(x.ledger.store, new ServiceStopsBeforeStart());
  const blocked = { ...request, ...actor() };
  const blockedRef = { route_id: blocked.route_id, execution_id: blocked.operation_id }; requests.push(blockedRef);
  await assert.rejects(stoppedDependency.start(blocked), /Dependency is no longer running/);
  const blockedRun = await executions.show(blockedRef);
  assert.equal(JSON.parse(docker(["inspect", blockedRun.container_id!]))[0].State.Status, "created");
  await executions.stop(blockedRef);
});
