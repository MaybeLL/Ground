import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";
import { DockerRouteRuntime } from "../src/code-route-runtime.js";
import { test } from "node:test";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { CodeRouteExecutions } from "../src/code-route-execution.js";
import { DockerRouteEngine } from "../src/code-route-docker.js";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { docker } from "../src/env-docker.js";
import { CodeWorkspaceCleanup } from "../src/code-workspace-cleanup.js";
import { newUUIDv7 } from "../src/identity.js";

for (const fault of ["container", "network", "volume"] as const) test(`another CLI process recovers service preparation and cleanup after Docker side effects outlive their callers (${fault})`, {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 240_000,
}, async t => {
  const x = await executionFixture(t);
  const route = x.route.route_id, config = join(x.root, "process-config.json"), file = join(x.root, "start.json");
  const environment = await new RepositoryEnvironments(x.ledger.store).save({ ...actor(), environment_id: newUUIDv7(),
    repository_id: x.route.repository_id, expected_version: 0, configuration: { name: "process recovery",
      image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, postgres: { image: process.env.GROUNDS_CODE_POSTGRES_IMAGE! } } });
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  writeFileSync(file, JSON.stringify({ environment_revision_id: environment.revision_id, argv: ["true"] }));
  const entry = ["--import", "tsx", fileURLToPath(new URL("../src/main.ts", import.meta.url)), "code-workspace"];
  const base = ["--config", config, "--json"];
  const invoke = (args: string[], expected = 0) => {
    const result = spawnSync(process.execPath, [...entry, ...args, ...base], { encoding: "utf8", timeout: 90_000 });
    assert.equal(result.error, undefined, result.stderr);
    const envelope = JSON.parse(result.stdout); assertContract("cli-envelope.schema.json", envelope);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (expected) assert.equal(envelope.error.code, "STATE_CONFLICT");
    return expected ? envelope.error : envelope.data;
  };
  const children: { child: ReturnType<typeof spawn>; closed: Promise<any[]> }[] = [];
  const realDocker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
  const shim = join(x.root, "docker-reply-gate"); mkdirSync(shim);
  const gate = async (args: string[], predicate: string) => {
    const marker = join(x.root, newUUIDv7());
    // Run the real Docker command first, then withhold its reply at the OS boundary.
    writeFileSync(join(shim, "docker"), `#!${process.execPath}\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');const a=process.argv.slice(2);const r=spawnSync(${JSON.stringify(realDocker)},a,{encoding:'utf8'});if(r.status===0&&(${predicate})){fs.writeFileSync(${JSON.stringify(marker)},r.stdout);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}fs.writeFileSync(1,r.stdout||'');fs.writeFileSync(2,r.stderr||'');process.exitCode=r.status??98;\n`, { mode: 0o700 });
    const child = spawn(process.execPath, [...entry, ...args, ...base], { detached: true,
      env: { ...process.env, PATH: shim + ":" + process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
    const closed = once(child, "close"); children.push({ child, closed });
    const deadline = Date.now() + 45_000;
    while (!existsSync(marker) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
    assert.ok(existsSync(marker), "Docker fault gate was not reached: " + output);
    return { child, closed, id: readFileSync(marker, "utf8").trim() };
  };
  const start = (id: string) => ["execution-start", route, "--file", file, "--operation-id", id,
    "--agent-id", "fixture", "--agent-name", "Fixture"];
  const end = () => ["end", x.route.instance_id, "--expected-version", "0", "--retention-days", "0",
    "--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"];
  const resources = (kind: "container" | "network" | "volume") => docker(kind === "container"
    ? ["ps", "-aq", "--no-trunc", "--filter", `label=grounds.code-route=${route}`]
    : [kind, "ls", "-q", ...(kind === "network" ? ["--no-trunc"] : []), "--filter", `label=grounds.code-route=${route}`]).split("\n").filter(Boolean);
  try {
    const firstId = newUUIDv7();
    const predicate = fault === "container"
      ? `a[0]==='create'&&a.includes(${JSON.stringify(process.env.GROUNDS_CODE_POSTGRES_IMAGE)})`
      : `a[0]===${JSON.stringify(fault)}&&a[1]==='create'`;
    const first = await gate(start(firstId), `(${predicate})&&a.includes(${JSON.stringify(`grounds.code-route=${route}`)})`);
    assert.deepEqual(resources("container"), fault === "container" ? [first.id] : []);
    const networks = resources("network"), preparedVolumes = resources("volume");
    assert.equal(networks.length, 1); assert.equal(preparedVolumes.length, fault === "network" ? 0 : 1);
    if (fault === "container") assert.equal(JSON.parse(docker(["inspect", first.id]))[0].State.Status, "created");
    else assert.equal(first.id, fault === "network" ? networks[0] : preparedVolumes[0]);
    invoke(start(newUUIDv7()), 4);
    invoke(["service-cleanup-preview", route, "--execution-id", firstId], 4);
    invoke(end(), 4);
    process.kill(-first.child.pid!, "SIGKILL"); assert.equal((await first.closed)[1], "SIGKILL");
    // Replaying an uncertain start only returns its durable state; it must not redispatch Docker.
    assert.equal(invoke(start(firstId)).execution.state, "preparing-runtime");
    invoke(start(newUUIDv7()), 4);
    invoke(end(), 4);
    assert.equal(invoke(["execution-stop", route, firstId]).execution.state, "stopped");
    const nextId = newUUIDv7(), next = invoke(start(nextId)).execution;
    assert.equal(next.state, "running");
    const serviceId = next.dependency.container_id, volumes = resources("volume");
    if (fault === "container") assert.equal(serviceId, first.id);
    assert.equal(next.dependency.network_id, networks[0]); assert.equal(next.dependency.volume_name, volumes[0]);
    assert.equal(volumes.length, 1);
    if (preparedVolumes.length) assert.deepEqual(volumes, preparedVolumes);
    assert.deepEqual(resources("network"), networks); assert.deepEqual(resources("volume"), volumes);
    assert.equal(resources("container").length, 2, "exactly one dependency plus one executor");
    // An old execution's stop cannot stop the service now held by the new execution.
    invoke(["execution-stop", route, firstId]);
    assert.equal(JSON.parse(docker(["inspect", serviceId]))[0].State.Running, true);
    docker(["exec", serviceId, "sh", "-c", "printf process-recovery-data > /var/lib/postgresql/data/process-marker"]);
    invoke(["execution-stop", route, nextId]);
    await x.ledger.module.abandonDevRun({ ...actor(), dev_run_id: x.route.dev_run_id!, expected_version: 1 });
    const ended = invoke(end()).instance;
    const plan = invoke(["service-cleanup-preview", route, "--execution-id", nextId]).plan;
    assert.equal(plan.gate, "ready");
    const cleanupId = newUUIDv7();
    const cleanup = (id: string, digest = plan.plan_digest) => ["service-cleanup", route, "--execution-id", nextId,
      "--expected-version", String(ended.lifecycle.version), "--plan-digest", digest, "--operation-id", id,
      "--agent-id", "fixture", "--agent-name", "Fixture"];
    const removeNetwork = fault !== "container";
    const removing = await gate(cleanup(cleanupId), removeNetwork
      ? `a[0]==='network'&&a[1]==='rm'&&a[2]===${JSON.stringify(networks[0])}`
      : `a[0]==='rm'&&a[1]===${JSON.stringify(serviceId)}`);
    assert.deepEqual(resources("container"), []);
    assert.deepEqual(resources("network"), removeNetwork ? [] : networks); assert.deepEqual(resources("volume"), volumes);
    // Diagnostics must already be preserved when the container has gone but removal is unacknowledged.
    const directory = join(x.dataRoot, "archive", "service-cleanup", cleanupId);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.operation_id, cleanupId); assert.equal(manifest.snapshot.container_id, serviceId);
    assert.ok(manifest.review_after);
    const logs = readFileSync(join(directory, "postgres-log.json")); assert.ok(logs.length);
    invoke(cleanup(cleanupId), 4); invoke(cleanup(newUUIDv7()), 4);
    invoke(start(newUUIDv7()), 4);
    process.kill(-removing.child.pid!, "SIGKILL"); assert.equal((await removing.closed)[1], "SIGKILL");
    invoke(cleanup(newUUIDv7()), 4);
    const fresh = invoke(["service-cleanup-preview", route, "--execution-id", nextId]).plan;
    assert.equal(fresh.container.state, "removed");
    assert.equal(fresh.network.state, removeNetwork ? "removed" : "eligible");
    // A new ID is still refused even with a fresh plan, not merely because the old plan is stale.
    assert.match(invoke(cleanup(newUUIDv7(), fresh.plan_digest), 4).message, /Resume the original service cleanup operation/);
    const result = invoke(cleanup(cleanupId)).cleanup;
    assert.equal(result.container.state, "removed"); assert.equal(result.network.state, "removed");
    assert.equal(result.volume.state, "retained"); assert.equal(result.volume.name, volumes[0]);
    assert.equal(result.diagnostics.directory, directory);
    assert.deepEqual(readFileSync(join(directory, "postgres-log.json")), logs);
    assert.deepEqual(resources("container"), []); assert.deepEqual(resources("network"), []);
    assert.deepEqual(resources("volume"), volumes);
    assert.equal(docker(["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--mount",
      `type=volume,src=${volumes[0]},dst=/data,readonly`, "--entrypoint", "cat",
      process.env.GROUNDS_CODE_POSTGRES_IMAGE!, "/data/process-marker"]), "process-recovery-data");
    assert.deepEqual(invoke(cleanup(cleanupId)).cleanup, result);
    invoke(start(newUUIDv7()), 4);
  } finally {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
      await closed;
    }
    // Only disposable resources carrying this fixture's exact route label are removed.
    for (const id of resources("container")) docker(["rm", "-f", id]);
    for (const id of resources("network")) docker(["network", "rm", id]);
    for (const id of resources("volume")) docker(["volume", "rm", id]);
  }
});

test("ended Workspace service cleanup retains its volume and archives diagnostics before deleting stopped resources", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  let dependency: { container_id: string; network_id: string; volume_name: string } | undefined;
  let stop: (() => Promise<unknown>) | undefined;
  const extras: string[] = [];
  let replacementNetwork: string | undefined;
  t.after(async () => {
    await stop?.().catch(() => {});
    for (const id of extras) if (docker(["ps", "-aq", "--no-trunc"]).split("\n").includes(id)) docker(["rm", "-f", id]);
    if (replacementNetwork) docker(["network", "rm", replacementNetwork]);
    if (dependency) {
      if (docker(["ps", "-aq", "--no-trunc"]).split("\n").includes(dependency.container_id)) docker(["rm", "-f", dependency.container_id]);
      if (docker(["network", "ls", "-q", "--no-trunc"]).split("\n").includes(dependency.network_id)) docker(["network", "rm", dependency.network_id]);
      if (docker(["volume", "ls", "-q"]).split("\n").includes(dependency.volume_name)) docker(["volume", "rm", dependency.volume_name]);
    }
  });
  const x = await executionFixture(t), executions = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
  const environment = await new RepositoryEnvironments(x.ledger.store).save({ ...actor(), environment_id: actor().operation_id,
    repository_id: x.route.repository_id, expected_version: 0, configuration: { name: "cleanup test",
      image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, postgres: { image: process.env.GROUNDS_CODE_POSTGRES_IMAGE! } } });
  const request = { ...actor(), route_id: x.route.route_id, environment_revision_id: environment.revision_id, argv: ["true"] };
  const run = await executions.start(request); dependency = run.dependency!;
  stop = () => executions.stop({ route_id: x.route.route_id, execution_id: run.execution_id });
  docker(["exec", dependency.container_id, "sh", "-c", "printf retained-marker > /var/lib/postgresql/data/unique-marker"]);
  await executions.stop({ route_id: x.route.route_id, execution_id: run.execution_id });
  await x.ledger.module.abandonDevRun({ ...actor(), dev_run_id: x.route.dev_run_id!, expected_version: 1 });
  const ended = await new CodeWorkspaceCleanup(x.ledger.store).end({ ...actor(), instance_id: x.route.instance_id,
    host_id: x.route.host_id, data_root: x.dataRoot, expected_version: 0, retention_days: 0 });
  const { CodeRouteServiceCleanup } = await import("../src/code-route-service-cleanup.js");
  const service = new CodeRouteServiceCleanup(x.ledger.store);
  const location = { route_id: x.route.route_id, execution_id: run.execution_id };
  const config = join(x.root, "cli.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const invoke = async (args: string[], write = false) => {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", ...args, "--config", config, "--json",
      ...(write ? ["--agent-id", "fixture", "--agent-name", "Fixture"] : [])], { stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n"));
    assert.equal(code, 0, JSON.stringify(envelope)); assertContract("cli-envelope.schema.json", envelope); return envelope.data;
  };
  let plan = (await invoke(["service-cleanup-preview", location.route_id, "--execution-id", location.execution_id])).plan;
  assert.equal(plan.gate, "ready"); assert.equal(plan.volume.state, "retained");
  const foreign = docker(["create", "--pull", "never", "--network", "none", "--mount",
    `type=volume,src=${dependency.volume_name},dst=/var/lib/postgresql/data,readonly`, "--entrypoint", "true", process.env.GROUNDS_CODE_POSTGRES_IMAGE!]);
  extras.push(foreign);
  const occupied = await service.preview(location);
  assert.equal(occupied.gate, "blocked"); assert.ok(occupied.snapshot.blockers.includes("volume_has_other_consumers"));
  await assert.rejects(service.reclaim({ ...location, ...actor(), expected_version: ended.lifecycle!.version, plan_digest: plan.plan_digest }), /plan/);
  docker(["rm", foreign]);
  // An unexpected writable-layer file must retain the container, even though its DB uses a volume.
  docker(["start", dependency.container_id]); docker(["exec", dependency.container_id, "touch", "/unique-file"]); docker(["stop", "--time", "5", dependency.container_id]);
  assert.ok((await service.preview(location)).snapshot.blockers.includes("unpreserved_container_changes"));
  docker(["start", dependency.container_id]); docker(["exec", dependency.container_id, "rm", "/unique-file"]); docker(["stop", "--time", "5", dependency.container_id]);
  plan = await service.preview(location);
  assert.equal(plan.gate, "ready");
  const cleanup = { ...location, early: false, ...actor(), attribution: { kind: "agent" as const, agent_id: "fixture", display_name: "Fixture" }, expected_version: ended.lifecycle!.version, plan_digest: plan.plan_digest };
  let lost = true;
  const uncertain = new CodeRouteServiceCleanup(x.ledger.store, execution => {
    const actual = new DockerRouteRuntime(execution);
    return { cleanupSnapshot: () => actual.cleanupSnapshot(), reclaimService: async input => {
      const result = await actual.reclaimService(input);
      if (lost) { lost = false; throw new Error("real removal reply lost"); }
      return result;
    } };
  });
  await assert.rejects(uncertain.reclaim(cleanup), /reply lost/);
  const result = (await invoke(["service-cleanup", location.route_id, "--execution-id", location.execution_id,
    "--expected-version", String(cleanup.expected_version), "--plan-digest", cleanup.plan_digest, "--operation-id", cleanup.operation_id], true)).cleanup;
  assert.equal(result.container.state, "removed"); assert.equal(result.network.state, "removed");
  assert.equal(result.volume.state, "retained"); assert.ok(result.diagnostics);
  assert.equal(docker(["ps", "-aq", "--no-trunc"]).split("\n").includes(dependency.container_id), false);
  assert.equal(docker(["network", "ls", "-q", "--no-trunc"]).split("\n").includes(dependency.network_id), false);
  assert.ok(docker(["volume", "ls", "-q"]).split("\n").includes(dependency.volume_name));
  const manifest = JSON.parse(readFileSync(join(result.diagnostics.directory, "manifest.json"), "utf8"));
  assert.equal(manifest.operation_id, cleanup.operation_id); assert.ok(manifest.review_after);
  assert.ok(readFileSync(join(result.diagnostics.directory, "postgres-log.json")).length);
  assert.equal(docker(["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--mount",
    `type=volume,src=${dependency.volume_name},dst=/var/lib/postgresql/data,readonly`, "--entrypoint", "cat",
    process.env.GROUNDS_CODE_POSTGRES_IMAGE!, "/var/lib/postgresql/data/unique-marker"]), "retained-marker");
  const name = `grounds-dep-${plan.snapshot.key.slice(7, 47)}`;
  replacementNetwork = docker(["network", "create", "--internal", name]);
  assert.deepEqual(await service.reclaim(cleanup), result);
  assert.ok(docker(["network", "ls", "-q", "--no-trunc"]).split("\n").includes(replacementNetwork));
});
