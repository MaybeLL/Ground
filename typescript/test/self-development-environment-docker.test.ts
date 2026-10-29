import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { CodeRouteExecutions } from "../src/code-route-execution.js";
import { CodeRouteController } from "../src/code-route-controller.js";
import { DockerRouteEngine } from "../src/code-route-docker.js";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { RepositoryEnvironmentChecks } from "../src/repository-environment-check.js";
import { newUUIDv7 } from "../src/identity.js";
import { runCLI } from "../src/cli.js";

// Explicit opt-in: uses a fixed local image and a disposable fixture ledger only.
test("Grounds builds and tests its fixed source in an offline managed development container", {
  skip: !process.env.GROUNDS_SELF_DEV_IMAGE && !process.env.GROUNDS_SELF_DEV_RECIPE_SOURCE, timeout: 1_200_000,
}, async t => {
  const seed = process.env.GROUNDS_SELF_DEV_SOURCE;
  assert.ok(seed, "GROUNDS_SELF_DEV_SOURCE must be a clean source export");
  const output = process.env.GROUNDS_SELF_DEV_LOG_DIR;
  assert.ok(output, "GROUNDS_SELF_DEV_LOG_DIR preserves original acceptance logs");
  mkdirSync(output, { recursive: true });
  const x = await executionFixture(t, undefined, false, false, seed);
  const engine = new DockerRouteEngine(), environments = new RepositoryEnvironments(x.ledger.store);
  let environment;
  if (process.env.GROUNDS_SELF_DEV_RECIPE_SOURCE) {
    const config = join(x.root, "recipe-ledger.json"), file = join(x.root, "recipe-request.json");
    writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
      expected_database_id: (await x.ledger.store.open()).database_id } }));
    const invoke = async (args: string[]) => { const lines: string[] = [];
      const code = await runCLI(["code-workspace", ...args, "--config", config, "--json", "--agent-id", "fixture", "--agent-name", "Fixture"], { stdout: line => lines.push(line), stderr: () => {} });
      const result = JSON.parse(lines.join("\n")); assert.equal(code, 0, JSON.stringify(result)); return result.data; };
    writeFileSync(file, JSON.stringify({ name: "Grounds self development", dockerfile: "scripts/dev-environment/Dockerfile", files: [
      "scripts/dev-environment/Dockerfile", "scripts/dev-environment/grounds-dev", "scripts/dev-environment/dependency-fingerprint.mjs", "typescript/package.json", "typescript/package-lock.json",
      "typescript/binding.gyp", "typescript/native/peercred.c", "typescript/native/host-process.c", "typescript/native/safe-tree.c",
      "typescript/vendor/THIRD-PARTY-NOTICES.md", "typescript/vendor/mermaid.min.js", "tui/package.json", "tui/package-lock.json",
    ] }));
    const recipe = (await invoke(["recipe-save", newUUIDv7(), "--repository", x.route.repository_id, "--expected-version", "0",
      "--directory", process.env.GROUNDS_SELF_DEV_RECIPE_SOURCE, "--file", file])).recipe;
    writeFileSync(file, JSON.stringify({ build_args: { GROUNDS_DEV_UID: String(process.getuid!()), GROUNDS_DEV_GID: String(process.getgid!()) },
      target: { environment_id: newUUIDv7(), expected_version: 0, configuration: { name: "Grounds self development" } } }));
    const preparationId = newUUIDv7();
    const prepared = (await invoke(["recipe-prepare", recipe.revision_id, "--file", file, "--data-root", x.dataRoot, "--operation-id", preparationId])).preparation;
    writeFileSync(resolve(output, "recipe-preparation.json"), JSON.stringify(prepared, null, 2));
    writeFileSync(resolve(output, "recipe-build.log"), readFileSync(join(x.dataRoot, "runtime", "development-builds", preparationId, "build.log")));
    environment = await environments.revision(prepared.environment_revision_id);
    t.after(() => execFileSync("docker", ["image", "rm", `grounds-development-build:${preparationId}`], { stdio: "pipe" }));
  } else environment = await environments.save({ ...actor(), environment_id: newUUIDv7(),
    repository_id: x.route.repository_id, expected_version: 0,
    configuration: { name: "Grounds self development acceptance", image: process.env.GROUNDS_SELF_DEV_IMAGE! } });
  const check = await new RepositoryEnvironmentChecks(x.ledger.store, engine).check({ ...actor(),
    route_id: x.route.route_id, environment_revision_id: environment.revision_id });
  writeFileSync(resolve(output, "environment-check.json"), JSON.stringify(check, null, 2));
  assert.equal(check.state, "passed", JSON.stringify(check));
  await environments.setDefault({ ...actor(), repository_id: x.route.repository_id, check_id: check.check_id, expected_version: 0 });
  const executions = new CodeRouteExecutions(x.ledger.store, engine);
  // First initialization must also accept a release-only mismatch with the image.
  const initialize = await executions.start({ ...actor(), route_id: x.route.route_id,
    environment_default: true, mode: "development", argv: ["python3", "-c", `
import json, pathlib, subprocess
originals={}
try:
    for project in ['typescript', 'tui']:
        for name in ['package.json', 'package-lock.json']:
            p=pathlib.Path(project)/name
            originals[p]=p.read_bytes()
            data=json.loads(originals[p]); data['version']='0.0.0-release-only-test'
            if name=='package-lock.json': data['packages']['']['version']=data['version']
            p.write_text(json.dumps(data))
    result=subprocess.run(['grounds-dev','node','--version'],capture_output=True,text=True)
    assert result.returncode==0, result.stderr
    for project in ['typescript', 'tui']:
        assert (pathlib.Path(project)/'node_modules/.grounds-image-lock').read_text().startswith('grounds-dependencies-v1:')
finally:
    for p, original in originals.items(): p.write_bytes(original)
`] });
  const initializeRef = { route_id: initialize.route_id, execution_id: initialize.execution_id };
  try {
    assert.deepEqual(await new CodeRouteController(x.ledger.store, engine).serve(initializeRef, { signal: t.signal }),
      { reason: "exited", exit_code: 0 });
  } finally { await executions.stop(initializeRef); }
  const guard = await executions.start({ ...actor(), route_id: x.route.route_id,
    environment_revision_id: environment.revision_id, mode: "development", argv: ["python3", "-c", `
import hashlib, json, pathlib, subprocess
p=pathlib.Path('typescript/package-lock.json')
original=p.read_bytes()
marker=pathlib.Path('typescript/node_modules/.grounds-image-lock')
saved_marker=marker.read_bytes()
def run(): return subprocess.run(['grounds-dev','node','--version'],capture_output=True,text=True)
try:
    data=json.loads(original)
    data['version']=data['packages']['']['version']='0.0.0-release-only-test'
    p.write_text(json.dumps(data))
    result=run(); assert result.returncode==0, result.stderr
    assert marker.read_bytes()==saved_marker
    data['packages']['']['dependencies']['mysql2']='0.0.0'
    p.write_text(json.dumps(data))
    result=run(); assert result.returncode==2, result
    assert 'Dependency inputs changed' in result.stderr, result.stderr
    p.write_bytes(original)
    for bad in [b'unmanaged', hashlib.sha256(original).hexdigest().encode()]:
        marker.write_bytes(bad)
        result=run(); assert result.returncode==2, result
        assert 'Unmanaged or stale dependencies' in result.stderr, result.stderr
        assert marker.read_bytes()==bad
finally:
    p.write_bytes(original)
    marker.write_bytes(saved_marker)
`] });
  const guardRef = { route_id: guard.route_id, execution_id: guard.execution_id };
  try {
    assert.deepEqual(await new CodeRouteController(x.ledger.store, engine).serve(guardRef, { signal: t.signal }),
      { reason: "exited", exit_code: 0 });
  } finally { await executions.stop(guardRef); }
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, environment_default: true,
    mode: "development", argv: ["sh", "-ec", "mkdir -p node_modules; exec grounds-dev smoke >node_modules/self-development.log 2>&1"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id };
  try {
    const inspected = JSON.parse(execFileSync("docker", ["inspect", run.container_id!], { encoding: "utf8" }))[0];
    assert.equal(inspected.HostConfig.NetworkMode, "none");
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
    assert.ok(inspected.Mounts.every((m: { Destination: string }) => !m.Destination.includes("docker.sock")));
    const result = await new CodeRouteController(x.ledger.store, engine).serve(ref, { signal: t.signal });
    const log = readFileSync(join(x.route.path, "node_modules/self-development.log"), "utf8");
    writeFileSync(resolve(output, "managed-smoke.log"), log);
    writeFileSync(resolve(output, "managed-result.json"), JSON.stringify({ result, image: run.image,
      environment_revision: environment.revision_id, temporary_ledger: true,
      network: inspected.HostConfig.NetworkMode, memory_bytes: inspected.HostConfig.Memory,
      pids_limit: inspected.HostConfig.PidsLimit }, null, 2));
    assert.deepEqual(result, { reason: "exited", exit_code: 0 }, log.slice(-6000));
    assert.equal((await executions.show(ref)).state, "stopped");
  } finally { await executions.stop(ref); }
});
