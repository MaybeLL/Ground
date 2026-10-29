import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeRouteExecutions, type RouteExecution } from "../src/code-route-execution.js";
import { DockerRouteEngine } from "../src/code-route-docker.js";
import { docker } from "../src/env-docker.js";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { git } from "../src/env-git.js";
import { CodeRouteRequests } from "../src/code-route-requests.js";
import { CodeRouteController } from "../src/code-route-controller.js";
import { newUUIDv7 } from "../src/identity.js";

test("real Docker continues development after a pre-journal staging rejection", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 300_000,
}, async t => {
  const x = await executionFixture(t), engine = new DockerRouteEngine(), service = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await service.start({ ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, mode: "development",
    argv: ["python3", "-c", `
import pathlib, subprocess, sys
sys.stderr = open('client-error.txt', 'w')
paths = [f'd{i}/a/b/c/d/e/f/g/file.txt' for i in range(128)]
for name in paths:
    path = pathlib.Path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('retained after rejection\\n')
head = subprocess.check_output(['git','rev-parse','HEAD'])
index = subprocess.check_output(['git','ls-files','--stage','-z'])
rejected = subprocess.run(['grounds-git','--timeout','180','stage',*paths], capture_output=True)
assert rejected.returncode == 2, rejected.stderr
assert subprocess.check_output(['git','rev-parse','HEAD']) == head
assert subprocess.check_output(['git','ls-files','--stage','-z']) == index
assert all(pathlib.Path(name).read_text() == 'retained after rejection\\n' for name in paths)
subprocess.run(['grounds-git','--timeout','180','stage',paths[0]], check=True)
subprocess.run(['grounds-git','--timeout','180','commit','-m','Continue after rejection','--author-name','Agent','--author-email','agent@example.invalid'], check=True)
` ] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, receipts: string[] = [];
  try {
    assert.deepEqual(await new CodeRouteController(x.ledger.store, engine).serve(ref, {
      onReceipt: receipt => { receipts.push(receipt.state); }, interval_ms: 20,
    }), { reason: "exited", exit_code: 0 }, readFileSync(join(x.route.path, "client-error.txt"), "utf8"));
    assert.deepEqual(receipts, ["rejected", "completed", "completed"]);
    assert.equal(git(["show", "HEAD:d0/a/b/c/d/e/f/g/file.txt"], { cwd: x.route.path }), "retained after rejection");
    assert.equal((await service.show(ref)).state, "stopped");
    assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `id=${run.container_id}`]), "");
  } finally { await service.stop(ref); }
});

test("real Docker runs the managed Git command autonomously and the controller reaps its natural exit", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 300_000,
}, async t => {
  const x = await executionFixture(t), engine = new DockerRouteEngine(), service = new CodeRouteExecutions(x.ledger.store, engine);
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: x.route.path });
  const hookMarker = join(x.root, "host-hook-executed"), filterMarker = join(x.root, "host-filter-executed");
  mkdirSync(join(common, "hooks"), { recursive: true });
  writeFileSync(join(common, "hooks", "reference-transaction"), `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o700 });
  git(["config", "filter.host-command.clean", `touch '${filterMarker}'`], { cwd: x.route.path });
  const run = await service.start({ ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, mode: "development",
    argv: ["sh", "-ec", `
      exec 2>client-error.txt
      echo 'autonomous container edit' > service.txt
      grounds-git --timeout 180 stage service.txt
      grounds-git --timeout 180 unstage service.txt
      echo '*.txt filter=host-command' > .gitattributes
      if grounds-git --timeout 180 stage service.txt; then exit 42; fi
      rm .gitattributes
      grounds-git --timeout 180 stage service.txt
      grounds-git --timeout 180 commit -m 'Automatic "commit" $literal' --author-name 'Container Agent' --author-email container@example.invalid
      git show HEAD:service.txt > result.txt
    `] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, receipts: string[] = [];
  try {
    assert.deepEqual(await new CodeRouteController(x.ledger.store, engine).serve(ref, {
      onReceipt: receipt => { receipts.push(receipt.state); }, interval_ms: 20,
    }), { reason: "exited", exit_code: 0 }, readFileSync(join(x.route.path, "client-error.txt"), "utf8"));
    assert.deepEqual(receipts, ["completed", "completed", "rejected", "completed", "completed"], readFileSync(join(x.route.path, "client-error.txt"), "utf8"));
    assert.equal(git(["show", "HEAD:service.txt"], { cwd: x.route.path }), "autonomous container edit");
    assert.equal(git(["log", "-1", "--format=%s"], { cwd: x.route.path }), 'Automatic "commit" $literal');
    assert.equal(readFileSync(join(x.route.path, "result.txt"), "utf8"), "autonomous container edit\n");
    assert.equal(existsSync(hookMarker), false, "container commits must not execute host hooks");
    assert.equal(existsSync(filterMarker), false, "container attributes must not execute host filters");
    assert.equal((await service.show(ref)).state, "stopped");
    assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `id=${run.container_id}`]), "");
  } finally { await service.stop(ref); }
});

test("real Docker development edits code and receives managed Git receipts through its isolated mailbox", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1",
}, async t => {
  const x = await executionFixture(t, undefined, true), engine = new DockerRouteEngine();
  const service = new CodeRouteExecutions(x.ledger.store, engine), channel = new CodeRouteRequests(x.ledger.store, engine);
  const start = { ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, mode: "development" as const };
  const requestId = newUUIDv7();
  const stage = JSON.stringify({ request_id: requestId, execution_id: start.operation_id, action: "stage", paths: ["service.txt"] });
  const run = await service.start({ ...start, argv: ["sh", "-ec", `
    echo 'edited inside container' > /workspace/service.txt
    printf '%s' '${stage}' > /grounds-requests/inbox/next.json
    mv /grounds-requests/inbox/next.json /grounds-requests/inbox/request.json
    until test -f /grounds-requests/outbox/response.json; do sleep 0.1; done
    cat /grounds-requests/outbox/response.json
    git show :service.txt
    sleep 120
  `] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id };
  try {
    const transport = await channel.transport(ref);
    for (let i = 0; i < 50 && !existsSync(join(transport.inbox, "request.json")); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await channel.process(ref)).state, "completed");
    for (let i = 0; i < 50 && !docker(["logs", run.container_id!]).includes("edited inside container"); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(docker(["logs", run.container_id!]), /edited inside container/);
    const inside = (...args: string[]) => docker(["exec", run.container_id!, ...args]);
    assert.equal(inside("git", "show", ":service.txt"), "edited inside container");
    assert.throws(() => inside("git", "update-ref", "refs/heads/main", "HEAD"));
    assert.throws(() => inside("sh", "-c", "echo forged > /workspace/.git"));
    assert.throws(() => inside("rm", "/workspace/.git"));
    assert.throws(() => inside("sh", "-c", "echo changed > /baselines/payments/service.txt"));
    assert.throws(() => inside("sh", "-c", "echo forged > /grounds-requests/outbox/response.json"));
    assert.throws(() => inside("cat", join(transport.root, "pending.json")));
    for (const action of ["unstage", "stage", "commit"] as const) {
      const request = { request_id: newUUIDv7(), execution_id: run.execution_id, action,
        ...(action === "commit" ? { message: "Container development", author: { name: "Container Agent", email: "container@example.invalid" } } : { paths: ["service.txt"] }) };
      inside("sh", "-ec", `printf '%s' '${JSON.stringify(request)}' > /grounds-requests/inbox/next.json; mv /grounds-requests/inbox/next.json /grounds-requests/inbox/request.json`);
      const result = await channel.process(ref);
      assert.equal(result.state, "completed");
      if (action === "unstage") assert.equal(inside("git", "diff", "--cached"), "");
      if (action === "commit") {
        assert.equal(result.state === "completed" && result.result.head, inside("git", "rev-parse", "HEAD"));
        assert.equal(inside("git", "show", "HEAD:service.txt"), "edited inside container");
      }
    }
    assert.equal(inside("git", "-C", "/baselines/orders", "rev-parse", "HEAD"), x.firstCommit.split(":")[1]);
    assert.equal(git(["rev-parse", "refs/heads/main"], { cwd: x.route.path }), x.firstCommit.split(":")[1]);
  } finally { await service.stop(ref); }
});

test("rebuilding a development container preserves staged, unstaged, untracked and ignored work", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 180_000,
}, async t => {
  const x = await executionFixture(t), engine = new DockerRouteEngine();
  const service = new CodeRouteExecutions(x.ledger.store, engine), channel = new CodeRouteRequests(x.ledger.store, engine);
  const runs: RouteExecution[] = [];
  const ref = (run: RouteExecution) => ({ route_id: run.route_id, execution_id: run.execution_id });
  const inside = (run: RouteExecution, ...args: string[]) => docker(["exec", run.container_id!, ...args]);
  const start = async () => {
    const run = await service.start({ ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!,
      mode: "development", argv: ["sleep", "180"] });
    runs.push(run); return run;
  };
  try {
    const first = await start();
    inside(first, "python3", "-c", "open('/workspace/service.txt','w').write('staged draft\\n')");
    const request = { request_id: newUUIDv7(), execution_id: first.execution_id, action: "stage", paths: ["service.txt"] };
    inside(first, "python3", "-c", "import os,sys; open('/grounds-requests/inbox/next.json','w').write(sys.argv[1]); os.rename('/grounds-requests/inbox/next.json','/grounds-requests/inbox/request.json')", JSON.stringify(request));
    assert.equal((await channel.process(ref(first))).state, "completed");
    assert.equal(inside(first, "git", "show", ":service.txt"), "staged draft");
    inside(first, "python3", "-c", `import os
from pathlib import Path
p=Path('/workspace')
(p/'service.txt').write_bytes(b'later unstaged draft\\r\\n')
(p/'draft.bin').write_bytes(bytes([0,1,2,255]))
(p/'.gitignore').write_text('ignored/\\n')
(p/'ignored').mkdir()
(p/'ignored'/'cache.bin').write_bytes(bytes([255,0,128]))
(p/'tool.sh').write_text('#!/bin/sh\\necho draft\\n')
os.chmod(p/'tool.sh',0o755)
os.symlink('draft.bin',p/'draft-link')
`);
    const stateScript = `import json,os
from pathlib import Path
p=Path('/workspace')
names=['service.txt','draft.bin','.gitignore','ignored/cache.bin','tool.sh']
print(json.dumps({'bytes':{n:(p/n).read_bytes().hex() for n in names},'mode':os.stat(p/'tool.sh').st_mode & 0o777,'link':os.readlink(p/'draft-link')}))`;
    const expected = { bytes: {
      "service.txt": Buffer.from("later unstaged draft\r\n").toString("hex"), "draft.bin": "000102ff",
      ".gitignore": Buffer.from("ignored/\n").toString("hex"), "ignored/cache.bin": "ff0080",
      "tool.sh": Buffer.from("#!/bin/sh\necho draft\n").toString("hex"),
    }, mode: 0o755, link: "draft.bin" };
    assert.deepEqual(JSON.parse(inside(first, "python3", "-c", stateScript)), expected);
    const staged = inside(first, "git", "diff", "--cached"), working = inside(first, "git", "diff");
    assert.match(staged, /staged draft/); assert.match(working, /later unstaged draft/);
    const entries = inside(first, "git", "ls-files", "--stage");
    await service.stop(ref(first));
    assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `id=${first.container_id}`]), "");
    assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "later unstaged draft\r\n");
    await x.admit();
    const second = await start();
    assert.notEqual(second.container_id, first.container_id);
    assert.notEqual(second.execution_id, first.execution_id);
    assert.deepEqual(JSON.parse(inside(second, "python3", "-c", stateScript)), expected);
    assert.equal(inside(second, "git", "show", ":service.txt"), "staged draft");
    assert.equal(inside(second, "git", "show", "HEAD:service.txt"), "first version");
    assert.equal(inside(second, "git", "rev-parse", "HEAD"), x.firstCommit.split(":")[1]);
    assert.equal(inside(second, "git", "ls-files", "--stage"), entries);
    assert.equal(inside(second, "git", "diff", "--cached"), staged);
    assert.equal(inside(second, "git", "diff"), working);
    assert.match(inside(second, "git", "ls-files", "--others", "--exclude-standard"), /draft.bin/);
    assert.equal(inside(second, "git", "check-ignore", "ignored/cache.bin"), "ignored/cache.bin");
    inside(second, "python3", "-c", "open('/workspace/service.txt','a').write('continued\\n')");
    assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "later unstaged draft\r\ncontinued\n");
  } finally { for (const run of runs.reverse()) await service.stop(ref(run)); }
});

test("real Docker resumes only after the paused Git index and commit are visible in its read view", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1",
}, async t => {
  const x = await executionFixture(t, undefined, true);
  writeFileSync(join(x.route.path, "service.txt"), "staged through the pause\n");
  await x.admit();
  class LostRefresh extends DockerRouteEngine {
    override async refreshGitView(run: RouteExecution) {
      await super.refreshGitView(run);
      throw new Error("refresh reply lost");
    }
  }
  const service = new CodeRouteExecutions(x.ledger.store, new LostRefresh());
  const recovered = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
  const run = await service.start({ ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, argv: ["sleep", "120"] });
  const ref = { route_id: run.route_id, execution_id: run.execution_id }, first = { ...ref, ...actor() };
  try {
    await service.pause(first);
    const writer = service.git(first), snapshot = await writer.snapshot(["service.txt"]);
    await writer.apply({ ...actor(), action: "stage", snapshot });
    await assert.rejects(service.resume(first), /refresh reply lost/);
    assert.equal((await service.show(ref)).git_view_dirty, true);
    assert.equal(JSON.parse(docker(["inspect", run.container_id!]))[0].State.Paused, true);
    assert.equal((await recovered.resume(first)).state, "resumed");
    assert.equal((await recovered.show(ref)).git_view_dirty, false);
    const containerGit = (...args: string[]) => docker(["exec", run.container_id!, "git", "-C", "/workspace", ...args]);
    assert.equal(containerGit("show", ":service.txt"), "staged through the pause");
    assert.match(containerGit("diff", "--cached"), /\+staged through the pause/);
    const second = { ...ref, ...actor() };
    await recovered.pause(second);
    await assert.rejects(writer.snapshot([]), { code: "STATE_CONFLICT" });
    const current = recovered.git(second);
    await assert.rejects(current.apply({ ...actor(), action: "stage", snapshot }), { code: "STATE_CONFLICT" });
    await current.apply({ ...actor(), action: "unstage", paths: ["service.txt"], snapshot: await current.snapshot([]) });
    assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "first version");
    await current.apply({ ...actor(), action: "stage", snapshot: await current.snapshot(["service.txt"]) });
    writeFileSync(join(x.route.path, "service.txt"), "unstaged edit survives\n");
    const committed = await current.apply({ ...actor(), action: "commit", snapshot: await current.snapshot([]),
      message: "Paused Git commit", author: { name: "Window author", email: "window@example.invalid" } });
    await recovered.resume(second);
    assert.equal(containerGit("rev-parse", "HEAD"), committed.head);
    assert.equal(containerGit("show", "HEAD:service.txt"), "staged through the pause");
    assert.equal(containerGit("diff", "--cached"), "");
    assert.match(containerGit("diff"), /\+unstaged edit survives/);
    assert.equal(docker(["exec", run.container_id!, "git", "-C", "/baselines/orders", "rev-parse", "HEAD"]), x.firstCommit.split(":")[1]);
    assert.equal(docker(["exec", run.container_id!, "git", "-C", "/baselines/payments", "rev-parse", "HEAD"]), x.relatedCommit!.split(":")[1]);
    assert.throws(() => containerGit("update-ref", "refs/heads/unauthorized", "HEAD"));
  } finally { await recovered.stop(ref); }
});

test("real Docker can terminate a paused execution without unpausing it and recover a lost removal reply", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1",
}, async t => {
  const x = await executionFixture(t);
  class LostRemoval extends DockerRouteEngine {
    override async removeStopped(run: RouteExecution) { await super.removeStopped(run); throw new Error("removal reply lost"); }
  }
  const service = new CodeRouteExecutions(x.ledger.store, new LostRemoval());
  const request = { ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, argv: ["sleep", "120"] };
  const run = await service.start(request), ref = { route_id: run.route_id, execution_id: run.execution_id };
  const window = { ...ref, ...actor() };
  const recovered = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
  let failure: unknown;
  try {
    await service.pause(window);
    const since = new Date().toISOString();
    await assert.rejects(service.stop(ref), /removal reply lost/);
    assert.equal((await service.show(ref)).state, "stopping");
    assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `id=${run.container_id}`]), "");
    const events = docker(["events", "--since", since, "--until", new Date().toISOString(), "--filter", `container=${run.container_id}`, "--format", "{{.Action}}"]);
    assert.match(events, /destroy/);
    assert.doesNotMatch(events, /unpause|start/);
    await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
    assert.equal((await recovered.stop(ref)).state, "stopped");
    const next = await recovered.start({ ...request, ...actor() });
    try {
      assert.equal(next.generation, run.generation + 1);
      await assert.rejects(recovered.resume(window), { code: "STATE_CONFLICT" });
      await assert.rejects(recovered.pause(window), { code: "STATE_CONFLICT" });
      assert.equal((await recovered.stop(ref)).state, "stopped");
      assert.equal(JSON.parse(docker(["inspect", next.container_id!]))[0].State.Running, true);
    } finally { await recovered.stop({ route_id: next.route_id, execution_id: next.execution_id }); }
  } catch (error) { failure = error; throw error; }
  finally {
    try { await recovered.stop(ref); }
    catch (error) {
      // Failure-only test cleanup: the ID is the exact container created above.
      if (failure && docker(["ps", "-aq", "--no-trunc", "--filter", `id=${run.container_id}`]) === run.container_id) {
        docker(["rm", "--force", "--volumes", run.container_id!]);
        await recovered.stop(ref);
      } else throw error;
    }
  }
});

test("real Docker pause freezes all writers and lost pause/resume replies recover the same window", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1",
}, async t => {
  const x = await executionFixture(t);
  class LostReplies extends DockerRouteEngine {
    losePause = true;
    loseResume = true;
    override async pause(run: RouteExecution) {
      await super.pause(run);
      if (this.losePause) throw new Error("pause reply lost");
    }
    override async resume(run: RouteExecution) {
      await super.resume(run);
      if (this.loseResume) throw new Error("resume reply lost");
    }
  }
  const engine = new LostReplies(), service = new CodeRouteExecutions(x.ledger.store, engine);
  const request = { ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!,
    argv: ["sh", "-c", "while :; do echo tick; sleep 0.05; done"] };
  const run = await service.start(request), ref = { route_id: run.route_id, execution_id: run.execution_id };
  const window = { ...ref, ...actor() };
  const count = () => docker(["logs", run.container_id!]).length;
  const wait = () => new Promise(resolve => setTimeout(resolve, 250));
  try {
    for (let i = 0; i < 20 && count() === 0; i++) await wait();
    assert.ok(count() > 0, "fixture process started");
    await assert.rejects(service.pause(window), /pause reply lost/);
    assert.equal((await service.show(ref)).state, "pausing");
    assert.equal(JSON.parse(docker(["inspect", run.container_id!]))[0].State.Paused, true);
    const before = count();
    await wait();
    assert.equal(count(), before, "all processes in the container remain frozen");
    await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
    const recovered = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
    assert.equal((await recovered.pause(window)).state, "paused");
    await assert.rejects(service.resume(window), /resume reply lost/);
    assert.equal((await service.show(ref)).state, "resuming");
    assert.equal(JSON.parse(docker(["inspect", run.container_id!]))[0].State.Paused, false);
    assert.equal((await recovered.resume(window)).state, "resumed");
    for (let i = 0; i < 10 && count() === before; i++) await wait();
    assert.ok(count() > before, "the same container continues after resume");
    const next = { ...ref, ...actor() };
    await recovered.pause(next);
    await recovered.resume(window);
    assert.equal(JSON.parse(docker(["inspect", run.container_id!]))[0].State.Paused, true);
    await recovered.resume(next);
  } finally {
    const recovered = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
    const current = await recovered.show(ref);
    if (current.pause_id) {
      const active = { ...window, operation_id: current.pause_id };
      if (current.state === "pausing") await recovered.pause(active);
      await recovered.resume(active);
    }
    await recovered.stop(ref);
  }
});

test("real Docker diagnostic enforces read-only code and safely recovers a lost start reply", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1",
}, async t => {
  const x = await executionFixture(t);
  const other = await x.routes.prepare({ ...actor(), instance_id: x.instance.instance_id,
    host_id: x.hostId, data_root: x.dataRoot, issue_slug: "other" });
  writeFileSync(join(other.path, "private-draft.txt"), "another route's uncommitted draft\n");
  git(["config", "grounds.privateSentinel", "host-only-test-value"], { cwd: x.route.path });
  class LostStartReply extends DockerRouteEngine {
    override async start(run: RouteExecution) { await super.start(run); throw new Error("lost start reply"); }
  }
  const service = new CodeRouteExecutions(x.ledger.store, new LostStartReply());
  const request = { ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!,
    argv: ["sh", "-c", "sleep 120"] };
  const ref = { route_id: request.route_id, execution_id: request.operation_id };
  let failure: unknown;
  try {
    await assert.rejects(service.start(request).catch(error => {
      if (error.code) t.diagnostic(`Start failure: ${JSON.stringify(error)}`);
      throw error;
    }), /lost start reply/);
    const run = await service.show(ref);
    assert.equal(run.state, "starting");
    assert.equal((await service.start(request)).container_id, run.container_id);
    assert.ok(run.container_id);
    const inspect = JSON.parse(docker(["inspect", run.container_id!]))[0];
    assert.equal(inspect.State.Running, true);
    assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspect.HostConfig.NetworkMode, "none");
    assert.ok(inspect.Mounts.filter((mount: { Type: string }) => mount.Type === "bind").every((mount: { RW: boolean }) => !mount.RW));
    assert.equal(inspect.Mounts.find((mount: { Destination: string }) => mount.Destination === "/workspace").RW, false);
    assert.equal(docker(["exec", run.container_id!, "cat", "/workspace/service.txt"]), "first version");
    assert.throws(() => docker(["exec", run.container_id!, "sh", "-c", "echo changed > /workspace/service.txt"]));
    assert.throws(() => docker(["exec", run.container_id!, "cat", join(other.path, "private-draft.txt")]));
    assert.throws(() => docker(["exec", run.container_id!, "cat", join(x.dataRoot, "cache", "repos", x.route.repository_id, "config")]));
    assert.throws(() => docker(["exec", run.container_id!, "test", "-S", "/var/run/docker.sock"]));
    const containerGit = (...args: string[]) => docker(["exec", run.container_id!, "git", "-C", "/workspace", ...args]);
    assert.equal(containerGit("status", "--porcelain"), "");
    assert.equal(containerGit("rev-parse", "HEAD"), x.firstCommit.split(":")[1]);
    assert.equal(containerGit("show", "HEAD:service.txt"), "first version");
    assert.equal(containerGit("branch", "--show-current"), x.route.development.branch);
    assert.throws(() => containerGit("config", "--get", "grounds.privateSentinel"));
    assert.throws(() => containerGit("branch", "unauthorized"));
    assert.throws(() => containerGit("update-ref", `refs/heads/${other.development.branch}`, "HEAD"));
    assert.throws(() => containerGit("hash-object", "-w", "/etc/hostname"));
    assert.equal(git(["rev-parse", "HEAD"], { cwd: other.path }), x.firstCommit.split(":")[1]);
    await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
    const recovered = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
    assert.equal((await recovered.stop(ref)).state, "stopped");
    assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `id=${run.container_id}`]), "");
    await x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! });
    assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "first version\n");
    assert.equal(readFileSync(join(other.path, "private-draft.txt"), "utf8"), "another route's uncommitted draft\n");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Exact test-owned identity only; failure retains the ownership record.
    try { await new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine()).stop(ref); }
    catch (error) { if (!failure) throw error; t.diagnostic(`Cleanup retained ownership: ${String(error)}`); }
  }
});

test("real Docker reads staged and unstaged route changes alongside the fixed baseline after cache GC", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1",
}, async t => {
  const x = await executionFixture(t, undefined, true);
  writeFileSync(join(x.route.path, "service.txt"), "staged version\n");
  git(["add", "service.txt"], { cwd: x.route.path });
  writeFileSync(join(x.route.path, "service.txt"), "working version\n");
  writeFileSync(join(x.route.path, "new.txt"), "untracked version\n");
  writeFileSync(join(x.route.path, "binary.dat"), Buffer.from([0, 1, 2, 3, 255]));
  writeFileSync(join(x.route.path, "tool.sh"), "#!/bin/sh\necho fixture\n");
  chmodSync(join(x.route.path, "tool.sh"), 0o755);
  symlinkSync("service.txt", join(x.route.path, "service-link"));
  git(["add", "binary.dat", "tool.sh", "service-link"], { cwd: x.route.path });
  await x.admit();
  const service = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
  const request = { ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, argv: ["sleep", "120"] };
  const run = await service.start(request);
  try {
    const containerGit = (cwd: string, ...args: string[]) => docker(["exec", run.container_id!, "git", "-C", cwd, ...args]);
    assert.equal(containerGit("/workspace", "show", ":service.txt"), "staged version");
    assert.match(containerGit("/workspace", "diff", "--cached"), /\+staged version/);
    assert.equal(docker(["exec", run.container_id!, "sh", "-c", "git -C /workspace show :binary.dat | base64"]), "AAECA/8=");
    assert.match(containerGit("/workspace", "ls-files", "--stage", "tool.sh"), /^100755 /);
    assert.match(containerGit("/workspace", "ls-files", "--stage", "service-link"), /^120000 /);
    assert.equal(containerGit("/workspace", "show", ":service-link"), "service.txt");
    assert.match(containerGit("/workspace", "diff"), /\+working version/);
    assert.match(containerGit("/workspace", "status", "--porcelain"), /MM service.txt/);
    assert.match(containerGit("/workspace", "status", "--porcelain"), /\?\? new.txt/);
    assert.equal(containerGit("/baselines/orders", "rev-parse", "HEAD"), x.firstCommit.split(":")[1]);
    assert.equal(containerGit("/baselines/orders", "show", "HEAD:service.txt"), "first version");
    assert.equal(containerGit("/baselines/orders", "status", "--porcelain"), "");
    assert.throws(() => docker(["exec", run.container_id!, "sh", "-c", "echo bad > /baselines/orders/service.txt"]));
    assert.equal(containerGit("/baselines/payments", "rev-parse", "HEAD"), x.relatedCommit!.split(":")[1]);
    assert.equal(containerGit("/baselines/payments", "show", "HEAD:service.txt"), "related service");
    assert.equal(containerGit("/baselines/payments", "status", "--porcelain"), "");
    assert.throws(() => containerGit("/baselines/payments", "update-ref", "refs/heads/unauthorized", "HEAD"));
    git(["gc", "--prune=now"], { cwd: x.route.path });
    assert.equal(containerGit("/workspace", "show", "HEAD:service.txt"), "first version");
    assert.equal(containerGit("/workspace", "show", ":service.txt"), "staged version");
  } finally { await service.stop({ route_id: request.route_id, execution_id: run.execution_id }); }
});


test("Git view rejects intent-to-add instead of presenting it as a staged file, and preparation failure is recoverable", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1",
}, async t => {
  const x = await executionFixture(t);
  writeFileSync(join(x.route.path, "planned.txt"), "not staged yet\n");
  git(["add", "--intent-to-add", "planned.txt"], { cwd: x.route.path });
  await x.admit();
  const service = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
  const request = { ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, argv: ["sleep", "120"] };
  const ref = { route_id: request.route_id, execution_id: request.operation_id };
  try {
    await assert.rejects(service.start(request), { code: "VALIDATION_ERROR", details: { field: "index", reason: "intent-to-add is not supported by the diagnostic Git view" } });
    assert.equal((await service.show(ref)).state, "intent");
    assert.equal((await service.start(request)).state, "intent", "replay must not repeat preparation or dispatch");
    assert.equal((await service.show(ref)).container_id, undefined);
    await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }));
  } finally { await service.stop(ref); }
  await x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! });
});

test("Git view refuses index flags that would hide working tree changes", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1",
}, async t => {
  const x = await executionFixture(t);
  const service = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    git(["update-index", `--${flag}`, "service.txt"], { cwd: x.route.path });
    const request = { ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, argv: ["sleep", "120"] };
    const ref = { route_id: request.route_id, execution_id: request.operation_id };
    try {
      await assert.rejects(service.start(request), { code: "VALIDATION_ERROR", details: {
        field: "index", reason: "assume-unchanged and skip-worktree are not supported by the diagnostic Git view",
      } });
      assert.equal((await service.show(ref)).state, "intent");
      assert.equal((await service.show(ref)).container_id, undefined);
    } finally {
      await service.stop(ref);
      git(["update-index", `--no-${flag}`, "service.txt"], { cwd: x.route.path });
    }
  }
});


test("Git view rejects related repository submodules until their context is supported", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1",
}, async t => {
  const x = await executionFixture(t, undefined, true, true);
  const service = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
  const request = { ...actor(), route_id: x.route.route_id, image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, argv: ["sleep", "120"] };
  const ref = { route_id: request.route_id, execution_id: request.operation_id };
  try {
    await assert.rejects(service.start(request), { code: "VALIDATION_ERROR", details: {
      field: "index", reason: "submodules are not supported by the diagnostic Git view",
    } });
    assert.equal((await service.show(ref)).state, "intent");
    assert.equal((await service.show(ref)).container_id, undefined);
  } finally { await service.stop(ref); }
});
