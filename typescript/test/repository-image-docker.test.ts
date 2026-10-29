import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { executionFixture } from "./code-route-execution-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { git } from "../src/env-git.js";
import { docker } from "../src/env-docker.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";
import { CodeRouteExecutions } from "../src/code-route-execution.js";
import { DockerRouteEngine } from "../src/code-route-docker.js";

test("another CLI process recovers a completed Docker build after its caller dies before recording the image", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const { codeWorkspaceFixture } = await import("./code-workspace-fixture.js");
  const { RepositoryBuildMaterials } = await import("../src/repository-build-materials.js");
  const { actor } = await import("./code-route-execution-fixture.js");
  const x = await codeWorkspaceFixture(t), id = newUUIDv7();
  git(["remote", "set-url", "origin", "ssh://git@example.test/team/repo"], { cwd: x.writer });
  writeFileSync(join(x.writer, "Dockerfile"), "FROM grounds-base\nCOPY service.txt /opt/recovery-marker\n");
  git(["add", "Dockerfile"], { cwd: x.writer }); git(["commit", "-qm", "recovery recipe"], { cwd: x.writer });
  const material = await new RepositoryBuildMaterials(x.ledger.store).capture({ ...actor(), repository_id: x.ledger.repository.repository_id,
    source: x.writer, commit: `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`, dockerfile: "Dockerfile", files: ["Dockerfile", "service.txt"] });
  const config = join(x.root, "config.json"), marker = join(x.root, "image-observed"), shim = join(x.root, "docker-gate");
  const dispatches = join(x.root, "build-dispatches");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  mkdirSync(shim);
  const realDocker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
  const label = `label=grounds.image-preparation=${id}`;
  // Withhold the real image lookup only after the daemon has built the image.
  writeFileSync(join(shim, "docker"), `#!${process.execPath}\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');const a=process.argv.slice(2);if(a[0]==='image'&&a[1]==='tag')fs.appendFileSync(${JSON.stringify(dispatches)},JSON.stringify(a)+'\\n');const r=spawnSync(${JSON.stringify(realDocker)},a,{encoding:'utf8'});if(r.status===0&&a[0]==='image'&&a[1]==='ls'&&a.includes(${JSON.stringify(label)})&&r.stdout.trim()&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},r.stdout);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}fs.writeFileSync(1,r.stdout||'');fs.writeFileSync(2,r.stderr||'');process.exitCode=r.status??98;\n`, { mode: 0o700 });
  const childEnv = { ...process.env, PATH: shim + ":" + process.env.PATH };
  const entry = ["--import", "tsx", fileURLToPath(new URL("../src/main.ts", import.meta.url)), "code-workspace"];
  const base = ["--config", config, "--json"];
  const prepare = (operation: string) => ["image-prepare", material.material_id, "--base-image", process.env.GROUNDS_CODE_DOCKER_IMAGE!,
    "--data-root", x.dataRoot, "--operation-id", operation, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const invoke = (args: string[], expected = 0) => {
    const result = spawnSync(process.execPath, [...entry, ...args, ...base], { env: childEnv, encoding: "utf8", timeout: 30000 });
    assert.equal(result.error, undefined, result.stderr);
    const envelope = JSON.parse(result.stdout); assertContract("cli-envelope.schema.json", envelope);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (expected) assert.equal(envelope.error.code, "STATE_CONFLICT");
    return expected ? envelope.error : envelope.data;
  };
  const child = spawn(process.execPath, [...entry, ...prepare(id), ...base], { detached: true,
    env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  const closed = once(child, "close");
  try {
    const deadline = Date.now() + 60000;
    while (!existsSync(marker) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
    assert.ok(existsSync(marker), "build completion gate was not reached: " + output);
    const image = readFileSync(marker, "utf8").trim(); assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const directory = join(x.dataRoot, "runtime", "image-preparations", id);
    const log = readFileSync(join(directory, "build.log")); assert.ok(log.length);
    assert.equal(invoke(["image-show", id]).preparation.state, "building");
    invoke(prepare(id), 4); invoke(prepare(newUUIDv7()), 4);
    process.kill(-child.pid!, "SIGKILL"); assert.equal((await closed)[1], "SIGKILL");
    invoke(prepare(newUUIDv7()), 4);
    const ready = invoke(prepare(id)).preparation;
    assert.equal(ready.state, "ready"); assert.equal(ready.image, image);
    assert.deepEqual(invoke(prepare(id)).preparation, ready);
    assert.equal(docker(["image", "ls", "--no-trunc", "-q", "--filter", label]), image);
    assert.deepEqual(readFileSync(join(directory, "build.log")), log, "recovery did not dispatch another build");
    assert.equal(readFileSync(dispatches, "utf8").trim().split("\n").length, 1, "build dispatch prelude ran exactly once across all CLI processes");
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
    await closed;
    for (const image of docker(["image", "ls", "--no-trunc", "-q", "--filter", label]).split("\n").filter(Boolean)) docker(["image", "rm", image]);
    const tag = `grounds-build-base:${id}`;
    if (docker(["image", "ls", "-q", tag])) docker(["image", "rm", tag]);
  }
});

test("real public CLI builds frozen Git materials, reuses the image and checks the linked environment", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const builds: string[] = [], images = new Set<string>(), runs: string[] = [];
  t.after(async () => {
    for (const id of runs) await executions.stop({ route_id: x.route.route_id, execution_id: id });
    for (const image of images) docker(["image", "rm", image]);
    for (const id of builds) {
      const tag = `grounds-build-base:${id}`;
      const names = docker(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}", tag]);
      if (names) docker(["image", "rm", tag]);
    }
  });
  const x = await executionFixture(t), executions = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
  const config = join(x.root, "config.json"), file = join(x.root, "input.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const invoke = async (args: string[], write = true) => {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", ...args, "--config", config, "--json",
      ...(write ? ["--agent-id", "fixture", "--agent-name", "Fixture"] : [])], { stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n"));
    assert.equal(code, 0, JSON.stringify(envelope)); assertContract("cli-envelope.schema.json", envelope);
    return envelope.data;
  };
  writeFileSync(join(x.writer, "Dockerfile"), 'FROM grounds-base\nCOPY service.txt /opt/build-marker\nCOPY . /opt/context\nRUN test ! -e /opt/context/.grounds-build-recipe\nRUN test "$(cat /opt/build-marker)" = "first version"\n');
  git(["add", "Dockerfile"], { cwd: x.writer }); git(["commit", "-qm", "build inputs"], { cwd: x.writer });
  writeFileSync(file, JSON.stringify({ commit: `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`,
    dockerfile: "Dockerfile", files: ["Dockerfile", "service.txt"] }));
  const material = (await invoke(["build-material-capture", x.route.repository_id, "--directory", x.writer,
    "--file", file, "--operation-id", newUUIDv7()])).material;
  writeFileSync(join(x.writer, "service.txt"), "changed after capture\n");
  assert.deepEqual((await invoke(["build-material-show", material.material_id], false)).material, material);
  const prepare = async () => {
    const id = newUUIDv7(); builds.push(id);
    const args = ["image-prepare", material.material_id, "--base-image", process.env.GROUNDS_CODE_DOCKER_IMAGE!,
      "--data-root", x.dataRoot, "--operation-id", id];
    const ready = (await invoke(args)).preparation;
    assert.equal(ready.state, "ready"); images.add(ready.image);
    assert.deepEqual((await invoke(args)).preparation, ready);
    assert.deepEqual((await invoke(["image-show", id], false)).preparation, ready);
    return ready;
  };
  const first = await prepare(), reused = await prepare();
  assert.equal(first.reused, false); assert.equal(reused.reused, true); assert.equal(reused.image, first.image);
  writeFileSync(file, JSON.stringify({ name: "built from Git", image: first.image, preparation_id: first.preparation_id }));
  const version = (await invoke(["environment-save", newUUIDv7(), "--repository", x.route.repository_id,
    "--expected-version", "0", "--file", file, "--operation-id", newUUIDv7()])).environment;
  const cleanupID = newUUIDv7();
  const cleaned = (await invoke(["image-cleanup", first.preparation_id, "--operation-id", cleanupID])).preparation;
  assert.equal(cleaned.cleanup.state, "complete"); assert.equal(cleaned.image, first.image);
  assert.equal(existsSync(join(x.dataRoot, "runtime", "image-preparations", first.preparation_id, "context")), false);
  assert.ok(readFileSync(join(x.dataRoot, "runtime", "image-preparations", first.preparation_id, "build.log")).length);
  assert.deepEqual((await invoke(["image-cleanup", first.preparation_id, "--operation-id", cleanupID])).preparation, cleaned);
  const checkID = newUUIDv7(); runs.push(checkID);
  const check = (await invoke(["environment-check", x.route.route_id, "--revision", version.revision_id, "--operation-id", checkID])).check;
  assert.equal(check.state, "passed"); assert.equal(check.environment.configuration.preparation_id, first.preparation_id);
  const runID = newUUIDv7(); runs.push(runID);
  writeFileSync(file, JSON.stringify({ environment_revision_id: version.revision_id,
    argv: ["python3", "-I", "-c", "assert open('/opt/build-marker').read() == 'first version\\n'"] }));
  await invoke(["execution-start", x.route.route_id, "--file", file, "--operation-id", runID]);
  for (let i = 0; i < 30; i++) {
    const result = await executions.observe({ route_id: x.route.route_id, execution_id: runID });
    if (result.execution.exit_code !== undefined) { assert.equal(result.execution.exit_code, 0); return; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.fail("built image execution did not exit");
});

test("real daemon failure is terminal and a new preparation may retry the same fixed recipe", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const { codeWorkspaceFixture } = await import("./code-workspace-fixture.js");
  const { RepositoryBuildMaterials } = await import("../src/repository-build-materials.js");
  const { RepositoryImagePreparations } = await import("../src/repository-image-preparation.js");
  const { DockerImageBuildEngine } = await import("../src/repository-image-docker.js");
  const { actor } = await import("./code-route-execution-fixture.js");
  const ids: string[] = [];
  t.after(() => { for (const id of ids) {
    const tag = `grounds-build-base:${id}`;
    if (docker(["image", "ls", "-q", tag])) docker(["image", "rm", tag]);
  } });
  const x = await codeWorkspaceFixture(t);
  git(["remote", "set-url", "origin", "ssh://git@example.test/team/repo"], { cwd: x.writer });
  writeFileSync(join(x.writer, "Dockerfile"), "FROM grounds-base\nRUN exit 17\n");
  git(["add", "Dockerfile"], { cwd: x.writer }); git(["commit", "-qm", "failing recipe"], { cwd: x.writer });
  const material = await new RepositoryBuildMaterials(x.ledger.store).capture({ ...actor(), repository_id: x.ledger.repository.repository_id,
    source: x.writer, commit: `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`, dockerfile: "Dockerfile", files: ["Dockerfile"] });
  const service = new RepositoryImagePreparations(x.ledger.store, new DockerImageBuildEngine());
  const request = { ...actor(), material_id: material.material_id, base_image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, data_root: x.dataRoot };
  ids.push(request.operation_id);
  const failed = await service.prepare(request);
  assert.equal(failed.state, "failed");
  assert.deepEqual(await service.prepare(request), failed);
  const cleaned = await service.cleanup({ ...actor(), preparation_id: request.operation_id });
  assert.equal(cleaned.cleanup?.state, "complete");
  const directory = join(x.dataRoot, "runtime", "image-preparations", request.operation_id);
  assert.equal(existsSync(join(directory, "context")), false);
  assert.ok(readFileSync(join(directory, "build.log"), "utf8").includes("non-zero code: 17"));
  assert.ok(existsSync(join(directory, "build-failure.json")));
  const retry = { ...request, ...actor() }; ids.push(retry.operation_id);
  assert.equal((await service.prepare(retry)).state, "failed", "new attempt dispatches and receives its own terminal failure");
});

test("real in-flight cancellation waits for completion and preserves the late image while reclaiming inputs", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const { codeWorkspaceFixture } = await import("./code-workspace-fixture.js");
  const { RepositoryBuildMaterials } = await import("../src/repository-build-materials.js");
  const { RepositoryImagePreparations } = await import("../src/repository-image-preparation.js");
  const { DockerImageBuildEngine } = await import("../src/repository-image-docker.js");
  const { actor } = await import("./code-route-execution-fixture.js");
  const id = newUUIDv7();
  let image: string | undefined;
  t.after(() => {
    if (image) docker(["image", "rm", image]);
    const tag = `grounds-build-base:${id}`;
    if (docker(["image", "ls", "-q", tag])) docker(["image", "rm", tag]);
  });
  const x = await codeWorkspaceFixture(t);
  git(["remote", "set-url", "origin", "ssh://git@example.test/team/repo"], { cwd: x.writer });
  writeFileSync(join(x.writer, "Dockerfile"), "FROM grounds-base\nRUN sleep 2\n");
  git(["add", "Dockerfile"], { cwd: x.writer }); git(["commit", "-qm", "slow recipe"], { cwd: x.writer });
  const material = await new RepositoryBuildMaterials(x.ledger.store).capture({ ...actor(), repository_id: x.ledger.repository.repository_id,
    source: x.writer, commit: `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`, dockerfile: "Dockerfile", files: ["Dockerfile"] });
  const service = new RepositoryImagePreparations(x.ledger.store, new DockerImageBuildEngine());
  const request = { ...actor(), operation_id: id, material_id: material.material_id, base_image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, data_root: x.dataRoot };
  const running = service.prepare(request);
  try {
    let building = false;
    for (let i = 0; i < 100; i++) {
      const status = await service.show(id).catch(error => { if (error.code === "NOT_FOUND") return undefined; throw error; });
      if (status?.state === "building") { building = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(building, "build dispatch observed");
    const pending = await service.cancel({ ...actor(), preparation_id: id });
    assert.equal(pending.state, "building"); assert.ok(pending.cancellation);
    const cancelled = await running; image = cancelled.image;
    assert.equal(cancelled.state, "cancelled"); assert.ok(image);
    assert.deepEqual(await service.prepare(request), cancelled);
    const cleaned = await service.cleanup({ ...actor(), preparation_id: id });
    assert.equal(cleaned.cleanup?.state, "complete");
    assert.equal(docker(["image", "inspect", image!, "--format", "{{.Id}}"]), image);
    assert.equal(existsSync(join(x.dataRoot, "runtime", "image-preparations", id, "context")), false);
  } finally { image ??= (await running).image; }
});
