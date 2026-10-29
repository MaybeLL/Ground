import { assertContract } from "./schema-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { docker } from "../src/env-docker.js";
import { newUUIDv7 } from "../src/identity.js";
import { DevelopmentImageBuilder } from "../src/development-image-buildkit.js";

test("local BuildKit builds explicit inputs and another caller recovers the exact result without rebuilding", {
  skip: process.env.GROUNDS_DEVELOPMENT_IMAGE_DOCKER !== "1", timeout: 180_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "grounds-buildkit-"));
  const builder = new DevelopmentImageBuilder(), host = await builder.identity();
  const request = { preparation_id: newUUIDv7(), input_digest: "sha256:" + "a".repeat(64), ...host };
  t.after(() => {
    const image = docker(["image", "ls", "-q", `grounds-development-build:${request.preparation_id}`]);
    if (image) docker(["image", "rm", `grounds-development-build:${request.preparation_id}`]);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "Dockerfile"), 'FROM scratch\nARG MESSAGE\nLABEL fixture.message=$MESSAGE\nCOPY marker /marker\n');
  writeFileSync(join(root, "marker"), "fixed input\n");
  const image = await builder.build(request, root, "Dockerfile", { MESSAGE: "known value" }, join(root, "build.log"));
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.parse(docker(["image", "inspect", image]))[0].Config.Labels["fixture.message"], "known value");
  const log = readFileSync(join(root, "build.log"));
  assert.equal(await new DevelopmentImageBuilder().find(request), image);
  assert.deepEqual(readFileSync(join(root, "build.log")), log);
  assert.equal(await builder.verify({ ...request, input_digest: "sha256:" + "b".repeat(64) }, image), false);
});

test("public preparation survives its caller dying after a network build, without dispatching another build", {
  skip: process.env.GROUNDS_DEVELOPMENT_IMAGE_DOCKER !== "1", timeout: 180_000,
}, async t => {
  const { codeWorkspaceFixture } = await import("./code-workspace-fixture.js");
  const { runCLI } = await import("../src/cli.js");
  const { spawn, spawnSync, execFileSync } = await import("node:child_process");
  const { mkdirSync, existsSync } = await import("node:fs");
  const { once } = await import("node:events");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { fileURLToPath } = await import("node:url");
  const x = await codeWorkspaceFixture(t), operation = newUUIDv7(), config = join(x.root, "config.json"), file = join(x.root, "request.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const invoke = async (argv: string[], write = true) => { const lines: string[] = [];
    const code = await runCLI(["code-workspace", ...argv, "--config", config, "--json", ...(write ? ["--agent-id", "fixture", "--agent-name", "Fixture"] : [])], { stdout: l => lines.push(l), stderr: () => {} });
    const result = JSON.parse(lines.join("\n")); assert.equal(code, 0, JSON.stringify(result)); assertContract("cli-envelope.schema.json", result); return result.data; };
  writeFileSync(join(x.root, "Dockerfile"), `FROM node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7\nARG PROBE\nRUN echo "$PROBE" && node -e 'fetch("https://registry.npmjs.org/uuid/11.1.0").then(async r=>{if(!r.ok)throw Error(r.status);let p=await r.json();if(p.version!=="11.1.0")throw Error("version");require("fs").writeFileSync("/opt/network-probe",p.version)}).catch(e=>{console.error(e);process.exit(1)})'\n`);
  writeFileSync(file, JSON.stringify({ name: "Network probe", dockerfile: "Dockerfile", files: ["Dockerfile"] }));
  const recipe = (await invoke(["recipe-save", newUUIDv7(), "--repository", x.ledger.repository.repository_id, "--expected-version", "0", "--directory", x.root, "--file", file])).recipe;
  writeFileSync(file, JSON.stringify({ build_args: { PROBE: operation }, target: { environment_id: newUUIDv7(), expected_version: 0, configuration: { name: "Network probe" } } }));
  const shim = join(x.root, "shim"), marker = join(x.root, "built"), dispatches = join(x.root, "dispatches"); mkdirSync(shim);
  const realDocker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim(), label = `label=grounds.development-preparation=${operation}`;
  writeFileSync(join(shim, "docker"), `#!${process.execPath}\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');const a=process.argv.slice(2);if(a.includes('buildx')&&a.includes('build'))fs.appendFileSync(${JSON.stringify(dispatches)},'build\\n');const r=spawnSync(${JSON.stringify(realDocker)},a,{encoding:'utf8'});if(r.status===0&&a.includes('ls')&&a.includes(${JSON.stringify(label)})&&r.stdout.trim()&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},r.stdout);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status??98;\n`, { mode: 0o700 });
  const argv = ["recipe-prepare", recipe.revision_id, "--file", file, "--data-root", x.dataRoot, "--operation-id", operation];
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/main.ts", import.meta.url)), "code-workspace", ...argv, "--config", config, "--json", "--agent-id", "fixture", "--agent-name", "Fixture"], { detached: true, env: { ...process.env, PATH: shim + ":" + process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b); const closed = once(child, "close");
  try {
    const deadline = Date.now() + 120000;
    while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await delay(50);
    assert.ok(existsSync(marker), "completion was not observed: " + output);
    process.kill(-child.pid!, "SIGKILL"); await closed;
    const log = join(x.dataRoot, "runtime", "development-builds", operation, "build.log"), original = readFileSync(log);
    const ready = (await invoke(argv)).preparation;
    assert.equal(ready.state, "ready"); assert.ok(ready.environment_revision_id);
    assert.equal(readFileSync(dispatches, "utf8"), "build\n"); assert.deepEqual(readFileSync(log), original);
    assert.equal(docker(["run", "--rm", "--network", "none", ready.image, "cat", "/opt/network-probe"]), "11.1.0");
    const environment = (await invoke(["environment-show", ready.environment_revision_id], false)).environment;
    assert.equal(environment.configuration.image, ready.image);
    assert.equal((await x.ledger.store.inspectIntegrity()).report.valid, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid!, "SIGKILL"); await closed; }
    const tag = `grounds-development-build:${operation}`;
    if (docker(["image", "ls", "-q", tag])) docker(["image", "rm", tag]);
  }
});
