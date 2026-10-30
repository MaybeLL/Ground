import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHostProcessScope, hostProcessEnvironment, inspectHostProcessScope, signalHostProcessScope, signalHostProcessIdentity, hostProcessIdentity, signalHostProcessLeader, type HostProcessScope, type HostProcessObservation, type HostProcessIdentity } from "../src/env-process.js";

import { environmentUp, environmentDown, readEnvironment, environmentPrivateDirectory } from "../src/env-environment.js";
import { implicitHostDefinition } from "../src/env-definition.js";
import { startRun, cancelRun, reconcileRun } from "../src/env-run.js";
import { isRouteLeased } from "../src/env-route-lease.js";
import { temporary } from "./env-test-helpers.js";

const exited = (child: ChildProcess): Promise<void> => new Promise((resolve, reject) => {
  child.once("exit", () => resolve()); child.once("error", reject);
});
async function stopped(scope: HostProcessScope): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const observed = inspectHostProcessScope(scope);
    if (observed.complete && observed.processes.length === 0) return;
    await delay(20);
  }
  assert.fail("scope did not confirm stopped after its own processes exited");
}
async function completeObservation(scope: HostProcessScope): Promise<HostProcessObservation> {
  for (let i = 0; i < 100; i++) {
    const observed = inspectHostProcessScope(scope);
    if (observed.complete) return observed;
    await delay(20);
  }
  assert.fail("host process enumeration remained incomplete");
}
async function observedProcess(scope: HostProcessScope, child: ChildProcess): Promise<HostProcessIdentity> {
  for (let i = 0; i < 100; i++) {
    const found = inspectHostProcessScope(scope).processes.find(p => p.pid === child.pid);
    if (found) return found;
    await delay(20);
  }
  assert.fail("task process did not become observable in its own scope");
}
// Linux must finish PR_SET_DUMPABLE before its environment becomes unreadable.
// A fixed startup delay races loaded runners; macOS only needs the empty-env exec.
async function restrictedProcessReady(child: ChildProcess): Promise<void> {
  if (process.platform === "darwin") { await once(child, "spawn"); return; }
  const lines = createInterface({ input: child.stdout! });
  try {
    const [ready] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
    assert.equal(ready, "ready");
  } finally { lines.close(); }
}
const task = (scope: HostProcessScope): ChildProcess => spawn("python3", ["-c", "import time;time.sleep(60)"], { detached: true, stdio: "ignore", env: { ...process.env, ...hostProcessEnvironment(scope) } });

test("host completion includes a detached reparented Python descendant, and persisted scope cancels it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-host-descendant-"));
  const scope = createHostProcessScope(); let descendant: number | undefined;
  try {
    const child = spawn("python3", ["-c", `import subprocess,sys\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nopen(sys.argv[1],'w').write(str(p.pid))`, join(directory, "pid")], { detached: true, stdio: "ignore", env: { ...process.env, ...hostProcessEnvironment(scope), GROUNDS_TEST_SECRET: "must-never-leave-native-memory" } });
    await exited(child);
    descendant = Number(readFileSync(join(directory, "pid"), "utf8"));
    process.kill(descendant, 0);
    const persisted = JSON.parse(JSON.stringify(scope)) as HostProcessScope;
    const observed = await completeObservation(persisted);
    assert.equal(observed.complete, true);
    assert.deepEqual(observed.processes.map(p => p.pid), [descendant]);
    assert.deepEqual(Object.keys(observed).sort(), ["complete", "processes"]);
    assert.deepEqual(Object.keys(observed.processes[0]).sort(), ["identity", "pid"]);
    assert.equal(JSON.stringify(observed).includes("must-never-leave-native-memory"), false);
    signalHostProcessScope(persisted, "SIGTERM");
    await stopped(persisted);
  } finally {
    for (const owned of inspectHostProcessScope(scope).processes) signalHostProcessIdentity(scope, owned, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("host signals require both the correct random scope and process birth identity", async () => {
  const own = createHostProcessScope(), other = createHostProcessScope();
  const a = task(own), b = task(other); const aDone = exited(a), bDone = exited(b);
  // An unrelated absent/inaccessible environment keeps the host census
  // incomplete. Empty macOS environments exercise the same fail-closed branch
  // without assuming that the runner enables SIP for /bin/sleep. Signal
  // authorization must still stop only the exact owned identities; their exit cannot certify a complete host-wide observation.
  const restrictedArgv = process.platform === "darwin" ? ["/bin/sleep", "60"] : ["python3", "-c", "import ctypes,time;assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0;print('ready',flush=True);time.sleep(60)"];
  const restricted = spawn(restrictedArgv[0], restrictedArgv.slice(1), { detached: true, stdio: ["ignore", "pipe", "ignore"], env: process.platform === "darwin" ? {} : { PATH: process.env.PATH } });
  const ready = restrictedProcessReady(restricted);
  const restrictedDone = exited(restricted), restrictedBirth = hostProcessIdentity(restricted.pid!);
  try {
    assert.ok(restrictedBirth);
    const [found] = await Promise.all([observedProcess(own, a), observedProcess(other, b), ready]);
    const otherBirth = hostProcessIdentity(b.pid!); assert.ok(otherBirth);
    assert.equal(signalHostProcessIdentity(own, { ...found, identity: "0:0" }, "SIGKILL"), false);
    assert.equal(signalHostProcessIdentity(other, found, "SIGKILL"), false);
    process.kill(a.pid!, 0); process.kill(b.pid!, 0);
    signalHostProcessScope(own, "SIGKILL"); await aDone;
    assert.equal(hostProcessIdentity(a.pid!), undefined);
    assert.deepEqual(inspectHostProcessScope(own), { complete: false, processes: [] });
    assert.notEqual(b.exitCode, 0); assert.equal(b.signalCode, null); process.kill(b.pid!, 0);
    assert.equal(hostProcessIdentity(b.pid!), otherBirth);
    signalHostProcessScope(other, "SIGTERM"); await bDone;
    assert.equal(hostProcessIdentity(b.pid!), undefined);
    assert.deepEqual(inspectHostProcessScope(other), { complete: false, processes: [] });
    assert.equal(hostProcessIdentity(restricted.pid!), restrictedBirth);
  } finally {
    for (const scope of [own, other]) for (const owned of inspectHostProcessScope(scope).processes) signalHostProcessIdentity(scope, owned, "SIGKILL");
    if (restrictedBirth) signalHostProcessLeader(restricted.pid!, restrictedBirth, "SIGKILL");
    await Promise.all([aDone, bDone, restrictedDone]);
  }
});

test("empty scopes can confirm and malformed or old absent scopes remain unknown", async () => {
  const scope = createHostProcessScope();
  assert.deepEqual(await completeObservation(scope), { complete: true, processes: [] });
  for (const invalid of [undefined, {}, { marker: "bad", startedAtMs: Date.now() }, { marker: scope.marker, startedAtMs: NaN }]) {
    assert.deepEqual(inspectHostProcessScope(invalid as HostProcessScope), { complete: false, processes: [] });
  }
});

test("absent or unreadable process environments retain unknown; a verified original leader can still be cancelled", async () => {
  const scope = createHostProcessScope();
  const argv = process.platform === "darwin" ? ["/bin/sleep", "60"] : ["python3", "-c", "import ctypes,time;assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0;print('ready',flush=True);time.sleep(60)"];
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", "pipe", "ignore"], env: process.platform === "darwin" ? {} : { ...process.env, ...hostProcessEnvironment(scope) } });
  const ready = restrictedProcessReady(child);
  const done = exited(child);
  const birth = hostProcessIdentity(child.pid!);
  try {
    assert.ok(birth);
    await ready;
    const observed = inspectHostProcessScope(scope);
    assert.equal(observed.complete, false, "an absent or inaccessible environment is unknown even when the OS returns argv successfully");
    assert.equal(inspectHostProcessScope(scope, { pid: child.pid!, identity: birth }).complete, false, "the original restricted leader cannot be excluded through its old controller");
    assert.equal(signalHostProcessLeader(child.pid!, "0:0", "SIGTERM"), false);
    assert.equal(signalHostProcessLeader(child.pid!, birth, "SIGTERM"), true);
    await done; await stopped(scope);
    assert.equal(signalHostProcessLeader(child.pid!, birth, "SIGKILL"), false, "a departed leader cannot authorize signalling its old PGID");
  } finally { if (birth) signalHostProcessLeader(child.pid!, birth, "SIGKILL"); await done; }
});

test("environment lifecycle retains detached descendants, cancels on recovery, then releases without affecting another task", async () => temporary(async (_root, workspace) => {
  const unrelatedScope = createHostProcessScope();
  const unrelated = task(unrelatedScope), unrelatedDone = exited(unrelated);
  const unrelatedIdentity = hostProcessIdentity(unrelated.pid!); assert.ok(unrelatedIdentity);
  let runScope: HostProcessScope | undefined;
  try {
    const environment = await environmentUp({ workspace, definition: implicitHostDefinition() });
    const execution = startRun({ environmentId: environment.id, argv: ["python3", "-c", `import subprocess,sys\np=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nopen('detached-pid','w').write(str(p.pid))`] });
    runScope = execution.run.host_scope;
    const result = await execution.done;
    assert.equal(result.state, "succeeded");
    assert.equal(result.termination, "unknown", "parent success cannot confirm that its detached descendant stopped");
    const descendant = Number(readFileSync(join(workspace, "detached-pid"), "utf8"));
    assert.ok(runScope);
    assert.ok(inspectHostProcessScope(runScope).processes.some(p => p.pid === descendant));
    assert.throws(() => environmentDown(environment.id));
    assert.equal(isRouteLeased(workspace), true);
    assert.equal(existsSync(environmentPrivateDirectory(environment.id)), true);
    assert.equal(reconcileRun(result.id).termination, "unknown");
    cancelRun(result.id);
    let recovered = reconcileRun(result.id);
    for (let i = 0; recovered.termination !== "confirmed" && i < 100; i++) {await delay(20); recovered = reconcileRun(result.id);}
    assert.equal(recovered.termination, "confirmed");
    assert.equal(isRouteLeased(workspace), true, "termination keeps occupancy until successful down");
    environmentDown(environment.id);
    assert.equal(readEnvironment(environment.id).state, "released");
    assert.equal(isRouteLeased(workspace), false);
    assert.equal(existsSync(environmentPrivateDirectory(environment.id)), false);
    assert.equal(hostProcessIdentity(unrelated.pid!), unrelatedIdentity);
    assert.equal(unrelated.signalCode, null);
    assert.ok(inspectHostProcessScope(unrelatedScope).processes.some(p => p.pid === unrelated.pid));
  } finally {
    // Cleanup only processes whose marker and exact birth still match.
    const cleanup = [];
    for (const scope of [runScope, unrelatedScope]) if (scope) {
      for (const owned of inspectHostProcessScope(scope).processes) {
        cleanup.push(owned); signalHostProcessIdentity(scope, owned, "SIGKILL");
      }
    }
    if (hostProcessIdentity(unrelated.pid!) === unrelatedIdentity) signalHostProcessLeader(unrelated.pid!, unrelatedIdentity, "SIGKILL");
    await unrelatedDone;
    // An unrelated inaccessible process may keep a scope unknown. Cleanup
    // checks only the exact owned identities, preserving any earlier failure.
    for (let i = 0; i < 100 && cleanup.some(p => hostProcessIdentity(p.pid) === p.identity); i++) await delay(20);
    assert.ok(cleanup.every(p => hostProcessIdentity(p.pid) !== p.identity), "owned cleanup identities have stopped");
  }
}));

test("a stable unrelated old parent excludes restricted newcomers only with a fixed leader on macOS", async () => {
  const controller = spawn("python3", ["-c", `import subprocess,sys\nprint('ready',flush=True)\nsys.stdin.readline()\nif sys.platform=='darwin':\n p=subprocess.Popen(['/bin/sleep','60'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={})\nelse:\n p=subprocess.Popen([sys.executable,'-c',"import ctypes,time;ctypes.CDLL(None).prctl(4,0,0,0,0);print('ready',flush=True);time.sleep(60)"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)\n p.stdout.readline()\nprint(p.pid,flush=True)\nsys.stdin.readline()\np.terminate()\np.wait()`], { detached: true, stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH } });
  const controllerDone = exited(controller);
  const controllerBirth = hostProcessIdentity(controller.pid!);
  const lines = createInterface({ input: controller.stdout! });
  let own: ChildProcess | undefined, ownDone: Promise<void> | undefined;
  let scope: HostProcessScope | undefined, leader: HostProcessIdentity | undefined;
  try {
    await once(lines, "line");
    scope = createHostProcessScope();
    own = spawn("/bin/sh", ["-c", 'exec env "$1" -e "$2"', "grounds-parent-proof", process.execPath, "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: { ...process.env, ...hostProcessEnvironment(scope) } }); ownDone = exited(own);
    const identity = hostProcessIdentity(own.pid!); assert.ok(identity);
    leader = { pid: own.pid!, identity };
    const newcomerLine = once(lines, "line"); controller.stdin!.write("start\n");
    const [newcomer] = await newcomerLine; const unrelatedPid = Number(newcomer);
    await delay(50);
    assert.equal(hostProcessIdentity(own.pid!), identity, "shell exec preserves the fixed native birth identity");
    assert.equal(inspectHostProcessScope(scope).complete, false, "without a fixed leader, an inaccessible newcomer still makes the observation unknown");
    const observed = inspectHostProcessScope(scope, leader);
    assert.equal(observed.complete, process.platform === "darwin", "only macOS can exclude a stable old non-task parent; Linux keeps its subreaper uncertainty");
    assert.ok(observed.processes.some(p => p.pid === own!.pid));
    assert.equal(inspectHostProcessScope(scope, { ...leader, identity: "0:0" }).complete, false);
    signalHostProcessScope(scope, "SIGTERM", leader); await ownDone;
    if (process.platform === "darwin") {
      const after = inspectHostProcessScope(scope, leader);
      assert.equal(after.complete, true, "a departed fixed leader does not make a proven unrelated parent into task ownership");
      assert.equal(after.processes.length, 0);
    }
    process.kill(unrelatedPid, 0);
  } finally {
    if (scope) for (const owned of inspectHostProcessScope(scope).processes) signalHostProcessIdentity(scope, owned, "SIGKILL");
    if (leader) signalHostProcessLeader(leader.pid, leader.identity, "SIGKILL");
    if (controllerBirth) signalHostProcessLeader(controller.pid!, controllerBirth, "SIGKILL");
    lines.close(); await controllerDone; await ownDone;
  }
});

test("a detached restricted orphan remains possible after reparenting to PID1", async () => {
  const scope = createHostProcessScope();
  const root = spawn("python3", ["-c", "import subprocess,sys; p=subprocess.Popen(['/bin/sleep','60'],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={} if sys.platform=='darwin' else None);print(p.pid,flush=True)"], { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...hostProcessEnvironment(scope) } });
  const done = exited(root); const rootBirth = hostProcessIdentity(root.pid!);
  let descendant: HostProcessIdentity | undefined;
  try {
    assert.ok(rootBirth);
    let stdout = ""; root.stdout!.on("data", chunk => {stdout += String(chunk);});
    await done;
    const pid = Number(stdout.trim()), identity = hostProcessIdentity(pid); assert.ok(identity);
    descendant = { pid, identity };
    if (process.platform === "darwin") assert.equal(Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim()), 1);
    const observation = inspectHostProcessScope(scope, { pid: root.pid!, identity: rootBirth });
    assert.ok(!observation.complete || observation.processes.some(p => p.pid === pid), "an orphan may not disappear from task ownership merely because its original leader exited");
    if (process.platform === "darwin") assert.equal(observation.complete, false);
  } finally {
    if (rootBirth) signalHostProcessLeader(root.pid!, rootBirth, "SIGKILL");
    if (descendant) signalHostProcessLeader(descendant.pid, descendant.identity, "SIGKILL");
    await done;
  }
});

test("traced macOS processes and nondumpable Linux processes cannot use the old-parent exclusion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-process-trace-"));
  const executable = join(directory, "process");
  const source = `#include <stdio.h>\n#include <unistd.h>\n#ifdef __APPLE__\n#include <sys/ptrace.h>\n#else\n#include <sys/prctl.h>\n#endif\nint main(void){\n#ifdef __APPLE__\nif(ptrace(PT_TRACE_ME,0,0,0)!=0)return 4;\n#else\nif(prctl(PR_SET_DUMPABLE,0,0,0,0)!=0)return 4;\n#endif\nputs("ready");fflush(stdout);sleep(60);return 0;}\n`;
  const file = join(directory, "process.c"); writeFileSync(file, source);
  execFileSync("cc", [file, "-o", executable], { stdio: "pipe" });
  // A real tracer must service waitpid/ptrace when the traced child stops;
  // Node's ordinary ChildProcess waiter is not a debugger event loop.
  const controller = spawn("python3", ["-c", `import subprocess,sys,os,signal,ctypes\nprint('ready',flush=True)\nsys.stdin.readline()\np=subprocess.Popen([sys.argv[1]],env={},start_new_session=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)\nprint(str(p.pid)+':'+p.stdout.readline().decode().strip(),flush=True)\nsys.stdin.readline()\nif sys.platform=='darwin':\n os.kill(p.pid,signal.SIGSTOP)\n os.waitpid(p.pid,os.WUNTRACED)\n if ctypes.CDLL(None).ptrace(11,p.pid,ctypes.c_void_p(1),0)!=0: raise RuntimeError('cannot detach own traced fixture')\np.terminate()\np.wait()`, executable], { detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  const controllerDone = exited(controller), controllerBirth = hostProcessIdentity(controller.pid!);
  const lines = createInterface({ input: controller.stdout! }); let errors = "";
  controller.stderr!.on("data", bytes => {errors += String(bytes);});
  let own: ChildProcess | undefined, ownDone: Promise<void> | undefined, leader: HostProcessIdentity | undefined, descendant: HostProcessIdentity | undefined;
  try {
    const [parentReady] = await once(lines, "line"); assert.equal(parentReady, "ready");
    const scope = createHostProcessScope();
    own = spawn("/bin/sh", ["-c", 'exec env "$1" -e "$2"', "grounds-parent-proof", process.execPath, "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: { ...process.env, ...hostProcessEnvironment(scope) } }); ownDone = exited(own);
    const identity = hostProcessIdentity(own.pid!); assert.ok(identity); leader = { pid: own.pid!, identity };
    const ready = once(lines, "line"); controller.stdin!.write("start\n");
    const [childReady] = await ready; const [pidText, status] = String(childReady).split(":"); assert.equal(status, "ready");
    const pid = Number(pidText), birth = hostProcessIdentity(pid); assert.ok(birth); descendant = { pid, identity: birth };
    const observed = inspectHostProcessScope(scope, leader);
    assert.equal(observed.complete, false, "tracing can reparent to a non-init process; its ancestry cannot prove unrelated ownership");
  } finally {
    controller.stdin!.write("cleanup\n");
    if (leader) signalHostProcessLeader(leader.pid, leader.identity, "SIGKILL");
    await controllerDone; await ownDone;
    if (descendant) signalHostProcessLeader(descendant.pid, descendant.identity, "SIGKILL");
    if (controllerBirth) signalHostProcessLeader(controller.pid!, controllerBirth, "SIGKILL");
    lines.close(); rmSync(directory, { recursive: true, force: true });
    assert.equal(controller.exitCode, 0, errors);
  }
});
