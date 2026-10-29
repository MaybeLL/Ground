import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { archiveCLITransport } from "./archive-cli-fixture.js";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";
import { git } from "../src/env-git.js";
import { CodeRouteExecutions } from "../src/code-route-execution.js";
import { DockerRouteEngine } from "../src/code-route-docker.js";
import { CodeRouteRequests } from "../src/code-route-requests.js";
import { docker } from "../src/env-docker.js";

const cliEntry = process.env.GROUNDS_CODE_EXECUTION_TEST_CLI
  ? [process.env.GROUNDS_CODE_EXECUTION_TEST_CLI]
  : ["--import", "tsx", fileURLToPath(new URL("../src/main.ts", import.meta.url))];

test("public execution CLI starts once, serves managed Git, and retains a stopped execution result", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 240_000,
}, async t => {
  const x = await executionFixture(t), config = join(x.root, "cli-config.json"), file = join(x.root, "start.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  writeFileSync(file, JSON.stringify({ image: process.env.GROUNDS_CODE_DOCKER_IMAGE, mode: "development",
    argv: ["sh", "-ec", `echo 'CLI autonomous edit' > service.txt
grounds-git --timeout 180 stage service.txt
grounds-git --timeout 180 commit -m 'CLI commit' --author-name Agent --author-email agent@example.invalid`] }));
  const invoke = async (...args: string[]) => {
    const result = spawnSync(process.execPath, [...cliEntry, "code-workspace", ...args, "--config", config, "--json"],
      { encoding: "utf8", timeout: 90_000 });
    assert.equal(result.error, undefined, result.stderr);
    const code = result.status, envelope = JSON.parse(result.stdout);
    assertContract("cli-envelope.schema.json", envelope);
    return { code, envelope };
  };
  const id = newUUIDv7(), route = x.route.route_id;
  const request = ["execution-start", route, "--file", file, "--operation-id", id, "--agent-id", "fixture", "--agent-name", "Fixture"];
  try {
    const started = await invoke(...request);
    assert.equal(started.code, 0, JSON.stringify(started.envelope));
    assert.equal(started.envelope.data.execution.execution_id, id);
    assert.deepEqual((await invoke(...request)).envelope.data, started.envelope.data, "a replay must not launch another container");
    const shown = await invoke("execution-show", route, id);
    assert.deepEqual(shown.envelope.data.execution, started.envelope.data.execution);
    const savedOnly = await invoke("execution-show", route, id, "--refresh=false");
    assert.equal(savedOnly.envelope.data.observation, undefined, "explicit false must not observe Docker");
    const fresh = await invoke("execution-show", route, id, "--refresh");
    assert.equal(fresh.envelope.data.observation.state, "running");
    const served = await invoke("execution-serve", route, id);
    assert.equal(served.code, 0, JSON.stringify(served.envelope));
    assert.deepEqual(served.envelope.data.outcome, { reason: "exited", exit_code: 0 });
    assert.equal(served.envelope.data.execution.state, "stopped");
    assert.equal(git(["show", "HEAD:service.txt"], { cwd: x.route.path }), "CLI autonomous edit");
    assert.equal(git(["rev-list", "--count", `${x.firstCommit.split(":")[1]}..HEAD`], { cwd: x.route.path }), "1");
    const stopped = await invoke("execution-stop", route, id);
    assert.equal(stopped.code, 0);
    assert.equal(stopped.envelope.data.execution.exit_code, 0);
    assert.equal((await invoke("execution-show", route, id)).envelope.data.execution.state, "stopped");
    // The public host CLI seals the exact container-produced commit only after
    // execution release; all remote writes use the isolated test SSH server.
    const transport = archiveCLITransport(t, x.root, x.remote, x.ledger.repository.repository_id);
    git(["config", "--unset-all", `url.file://${x.remote}.insteadOf`], { cwd: x.route.path });
    const candidateCLI = (...args: string[]) => {
      const result = spawnSync(process.execPath, [...cliEntry, "candidate", ...args,
        "--cwd", x.route.path, "--config", config, "--json"], { encoding: "utf8", timeout: 90_000 });
      assert.equal(result.error, undefined, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(result.status, 0, JSON.stringify(envelope));
      assertContract("cli-envelope.schema.json", envelope);
      return envelope.data;
    };
    const form = candidateCLI("template", "--dev-run", x.route.dev_run_id!).submission;
    form.explanation = "Archive the original container development commit";
    for (const claim of form.claims) {
      claim.explanation = "Implemented";
      for (const criterion of claim.criteria) criterion.explanation = "Verified exact source";
    }
    for (const rationale of form.change_rationales) {
      rationale.target_refs = [{ type: "criterion", id: form.claims[0].criteria[0].criterion_id }];
      rationale.rationale = "Implements this issue";
    }
    const submissionFile = join(x.root, "candidate.json"); writeFileSync(submissionFile, JSON.stringify(form));
    const submitArgs = ["submit", "--dev-run", x.route.dev_run_id!, "--expected-version", "1", "--file", submissionFile,
      "--archive-policy", transport.policy(), "--operation-id", newUUIDv7(), "--agent-id", "fixture", "--agent-name", "Fixture"];
    const candidate = candidateCLI(...submitArgs);
    assert.equal(candidate.source.commit, `sha1:${git(["rev-parse", "HEAD"], { cwd: x.route.path })}`);
    assert.equal(git(["rev-parse", `refs/tags/grounds/candidates/${candidate.candidate_id}`], { gitDir: x.remote }), candidate.source.commit.slice(5));
    assert.deepEqual(candidateCLI(...submitArgs), candidate);

  } finally {
    const service = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
    const existing = await service.show({ route_id: route, execution_id: id }).catch(() => undefined);
    if (existing) await service.stop({ route_id: route, execution_id: id });
  }
});

test("the foreground CLI can be reattached after host termination and SIGINT safely stops its execution", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const x = await executionFixture(t), config = join(x.root, "cli-config.json"), file = join(x.root, "start.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  writeFileSync(file, JSON.stringify({ image: process.env.GROUNDS_CODE_DOCKER_IMAGE, mode: "development", argv: ["sleep", "30"] }));
  const route = x.route.route_id, id = newUUIDv7(), ref = { route_id: route, execution_id: id };
  const base = ["--config", config, "--json"];
  const children: { child: ReturnType<typeof spawn>; closed: Promise<any[]> }[] = [];
  const launch = (entry = cliEntry) => {
    const child = spawn(process.execPath, [...entry, "code-workspace", "execution-serve", route, id, ...base]);
    let output = "", errors = "";
    child.stdout.on("data", bytes => { output += bytes; });
    const closed = once(child, "close");
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("foreground command did not announce its execution")), 10_000);
      child.stderr.on("data", bytes => { errors += bytes; if (errors.includes(`execution_id: ${id}`)) { clearTimeout(timer); resolve(); } });
      child.once("close", () => { clearTimeout(timer); reject(new Error(`controller exited early: ${errors}`)); });
    });
    children.push({ child, closed });
    return { child, closed, ready, output: () => output };
  };
  try {
    const started = spawnSync(process.execPath, [...cliEntry, "code-workspace", "execution-start", route,
      "--file", file, "--operation-id", id, "--agent-id", "fixture", "--agent-name", "Fixture", ...base], { encoding: "utf8", timeout: 60_000 });
    assert.equal(started.status, 0, started.stdout + started.stderr);
    const first = launch(["--import", "tsx", fileURLToPath(new URL("../src/main.ts", import.meta.url))]);
    await first.ready;
    first.child.kill("SIGKILL"); await first.closed;
    const second = launch();
    await second.ready;
    second.child.kill("SIGINT");
    assert.equal((await second.closed)[0], 130, second.output());
    const envelope = JSON.parse(second.output());
    assertContract("cli-envelope.schema.json", envelope);
    assert.deepEqual(envelope.data.outcome, { reason: "cancelled" });
    assert.equal(envelope.data.execution.state, "stopped");
    assert.equal(envelope.data.execution.execution_id, id);
  } finally {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    const service = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
    if (await service.show(ref).catch(() => undefined)) await service.stop(ref);
  }
});

test("another process recovers exactly one accepted commit after its controller is killed after the ref update", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const x = await executionFixture(t), engine = new DockerRouteEngine();
  const executions = new CodeRouteExecutions(x.ledger.store, engine), requests = new CodeRouteRequests(x.ledger.store, engine);
  const config = join(x.root, "controller-config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!,
    mode: "development", argv: ["sleep", "180"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, transport = await requests.transport(ref);
  const publish = (value: unknown) => {
    const next = join(transport.inbox, "next.json"); writeFileSync(next, JSON.stringify(value));
    renameSync(next, join(transport.inbox, "request.json"));
  };
  const children: { child: ReturnType<typeof spawn>; closed: Promise<any[]> }[] = [];
  const launch = (args: string[], env = process.env) => {
    const child = spawn(process.execPath, args, { detached: true, env, cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { errors += data; });
    const closed = once(child, "close"); children.push({ child, closed });
    return { child, closed, output: () => output, errors: () => errors };
  };
  try {
    docker(["exec", run.container_id!, "python3", "-c", "open('/workspace/service.txt','w').write('in-flight process recovery\\n')"]);
    publish({ request_id: newUUIDv7(), execution_id: run.execution_id, action: "stage", paths: ["service.txt"] });
    assert.equal((await requests.process(ref)).state, "completed");
    const commit = { request_id: newUUIDv7(), execution_id: run.execution_id, action: "commit", message: "Recover one accepted commit",
      author: { name: "Fixture", email: "fixture@example.invalid" } };
    const shim = join(x.root, "git-reply-gate"), entered = join(x.root, "ref-updated"); mkdirSync(shim);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const branch = `refs/heads/${x.route.development.branch}`;
    // External process fault: real Git has finished updating the route ref, but its reply is withheld.
    writeFileSync(join(shim, "git"), `#!${process.execPath}\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');const a=process.argv.slice(2);const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});if(r.status===0&&a.includes('update-ref')&&a.includes(${JSON.stringify(branch)})){fs.writeFileSync(${JSON.stringify(entered)},'ref updated');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}process.exit(r.status??98);\n`, { mode: 0o700 });
    publish(commit);
    const serveArgs = [...cliEntry, "code-workspace", "execution-serve", run.route_id, run.execution_id, "--config", config, "--json"];
    const first = launch(serveArgs, { ...process.env, PATH: shim + ":" + process.env.PATH });
    const deadline = Date.now() + 30_000;
    while (!existsSync(entered) && first.child.exitCode === null && Date.now() < deadline) await delay(25);
    assert.ok(existsSync(entered), first.output() + first.errors());
    const head = git(["rev-parse", "HEAD"], { cwd: x.route.path });
    assert.notEqual(head, x.firstCommit.split(":")[1]);
    assert.equal(JSON.parse(docker(["inspect", run.container_id!]))[0].State.Paused, true);
    const competitor = spawnSync(process.execPath, serveArgs, { encoding: "utf8", timeout: 15_000 });
    assert.equal(competitor.error, undefined, competitor.stderr);
    const rejected = JSON.parse(competitor.stdout); assertContract("cli-envelope.schema.json", rejected);
    assert.notEqual(competitor.status, 0); assert.equal(rejected.error.code, "STATE_CONFLICT");
    process.kill(-first.child.pid!, "SIGKILL");
    assert.equal((await first.closed)[1], "SIGKILL");
    await assert.rejects(executions.stop(ref), { code: "STATE_CONFLICT" });
    await assert.rejects(executions.start({ ...actor(), route_id: run.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!,
      mode: "development", argv: ["sleep", "180"] }), { code: "STATE_CONFLICT" });
    publish({ ...commit, request_id: newUUIDv7(), message: "Unaccepted replacement must not be committed" });
    // A new OS process uses the public controller service and drains exactly its first recovered receipt.
    const recoveryScript = `import {SQLStore} from './src/sql-store.ts';import {CodeRouteController} from './src/code-route-controller.ts';import {DockerRouteEngine} from './src/code-route-docker.ts';const store=SQLStore.sqlite(${JSON.stringify(x.ledgerPath)});const cancel=new AbortController();const receipts=[];try{const outcome=await new CodeRouteController(store,new DockerRouteEngine()).serve(${JSON.stringify(ref)},{signal:cancel.signal,onReceipt:r=>{receipts.push(r);cancel.abort();}});console.log(JSON.stringify({outcome,receipts}));}finally{await store.close();}`;
    const second = launch(["--import", "tsx", "--input-type=module", "-e", recoveryScript]);
    assert.equal((await second.closed)[0], 0, second.output() + second.errors());
    const recovered = JSON.parse(second.output());
    assert.deepEqual(recovered.outcome, { reason: "cancelled" });
    assert.equal(recovered.receipts.length, 1);
    assert.equal(recovered.receipts[0].request_id, commit.request_id);
    assert.equal(recovered.receipts[0].state, "completed");
    assert.equal(recovered.receipts[0].result.head, head);
    assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), head);
    assert.equal(git(["rev-list", "--count", `${x.firstCommit.split(":")[1]}..HEAD`], { cwd: x.route.path }), "1");
    assert.equal(git(["show", "HEAD:service.txt"], { cwd: x.route.path }), "in-flight process recovery");
    assert.equal((await executions.show(ref)).state, "stopped");
    assert.equal(docker(["ps", "-aq", "--filter", `id=${run.container_id}`]), "");
  } finally {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
      await closed;
    }
    // Exact temporary route only, including a paused execution if an assertion failed before recovery.
    for (const container of docker(["ps", "-aq", "--filter", `label=grounds.code-route=${run.route_id}`]).split("\n").filter(Boolean))
      docker(["rm", "-f", container]);
  }
});

test("public execution CLI reports a failed container exit as a failed command and preserves its exit code", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const x = await executionFixture(t), config = join(x.root, "cli-config.json"), file = join(x.root, "start.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  writeFileSync(file, JSON.stringify({ image: process.env.GROUNDS_CODE_DOCKER_IMAGE, mode: "development", argv: ["sh", "-c", "exit 17"] }));
  const route = x.route.route_id, id = newUUIDv7(), ref = { route_id: route, execution_id: id };
  const invoke = (...args: string[]) => {
    const result = spawnSync(process.execPath, [...cliEntry, "code-workspace", ...args, "--config", config, "--json"], { encoding: "utf8", timeout: 90_000 });
    assert.equal(result.error, undefined, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assertContract("cli-envelope.schema.json", envelope);
    return { code: result.status, envelope };
  };
  try {
    assert.equal(invoke("execution-start", route, "--file", file, "--operation-id", id,
      "--agent-id", "fixture", "--agent-name", "Fixture").code, 0);
    const served = invoke("execution-serve", route, id);
    assert.equal(served.code, 1, JSON.stringify(served.envelope));
    assert.deepEqual(served.envelope.data.outcome, { reason: "exited", exit_code: 17 });
    const saved = invoke("execution-show", route, id, "--refresh");
    assert.equal(saved.code, 0);
    assert.equal(saved.envelope.data.execution.state, "stopped");
    assert.equal(saved.envelope.data.execution.exit_code, 17);
    assert.equal(saved.envelope.data.observation, undefined, "a removed container has only a saved receipt");
  } finally {
    const service = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
    if (await service.show(ref).catch(() => undefined)) await service.stop(ref);
  }
});
