import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";
import { assertContract } from "./schema-fixture.js";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { CodeRouteExecutions, type RouteExecution } from "../src/code-route-execution.js";
import { DockerRouteEngine } from "../src/code-route-docker.js";
import { PreflightService } from "../src/preflight.js";
import { CodeRouteGit } from "../src/code-route-git.js";
import { CodeRouteRequests } from "../src/code-route-requests.js";
import { runCLI } from "../src/cli.js";
import { git } from "../src/env-git.js";
import { docker } from "../src/env-docker.js";

// Real PostgreSQL protocol from the execution container; no installed driver or host proxy.
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
s.close()
print('query succeeded')
`;

test("parallel development routes reject cross-route access while each keeps working", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 300_000,
}, async t => {
  const routeIDs: string[] = [];
  t.after(() => {
    // Only this fixture's exact route labels, including resources created before lost replies.
    for (const id of routeIDs) {
      for (const container of docker(["ps", "-aq", "--no-trunc", "--filter", `label=grounds.code-route=${id}`]).split("\n").filter(Boolean))
        docker(["rm", "-f", container]);
      for (const kind of ["network", "volume"]) {
        for (const resource of docker([kind, "ls", "-q", "--filter", `label=grounds.code-route=${id}`]).split("\n").filter(Boolean))
          docker([kind, "rm", resource]);
      }
    }
  });
  const x = await executionFixture(t, undefined, true);
  routeIDs.push(x.route.route_id);
  const prepareRoute = async (slug: string) => {
    const prepared = await x.routes.prepare({ ...actor(), instance_id: x.instance.instance_id, host_id: x.hostId,
      data_root: x.dataRoot, issue_slug: slug });
    routeIDs.push(prepared.route_id);
    const route = await x.routes.bindDevRun({ ...actor(), route_id: prepared.route_id, host_id: x.hostId, data_root: x.dataRoot });
    const preflight = new PreflightService(x.ledger.store, route.path);
    const observed = await preflight.observe({ ...actor(), phase: "start", dev_run_id: route.dev_run_id!, refresh: true });
    const assessed = await preflight.assess({ ...actor(), observation_id: observed.id,
      file: { assessment: "applicable", rationale: "Reviewed independent route", affected: [] } });
    await preflight.admit({ ...actor(), dev_run_id: route.dev_run_id!, assessment_id: assessed.id, refresh: true });
    return route;
  };
  const sibling = await prepareRoute("parallel-isolation");
  // A third, completed route supplies a real immutable Candidate tag, not a named sentinel.
  const archivedRoute = await prepareRoute("archived-isolation");
  writeFileSync(join(archivedRoute.path, "service.txt"), "archived Candidate\n");
  const managed = new CodeRouteGit(x.ledger.store, archivedRoute.route_id);
  await managed.apply({ ...actor(), action: "stage", snapshot: await managed.snapshot(["service.txt"]) });
  await managed.apply({ ...actor(), action: "commit", snapshot: await managed.snapshot([]), message: "Archive isolation fixture",
    author: { name: "Fixture", email: "fixture@example.invalid" } });
  const config = join(x.root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const invoke = async (...args: string[]) => {
    const lines: string[] = [];
    const code = await runCLI([...args, "--config", config, "--json"],
      { cwd: archivedRoute.path, stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n")); assertContract("cli-envelope.schema.json", envelope);
    assert.equal(code, 0, JSON.stringify(envelope)); return envelope.data;
  };
  const transport = archiveCLITransport(t, x.root, x.remote, x.route.repository_id);
  git(["config", "--unset-all", `url.file://${x.remote}.insteadOf`], { cwd: archivedRoute.path });
  const form = (await invoke("candidate", "template", "--dev-run", archivedRoute.dev_run_id!)).submission;
  form.explanation = "Retain an archived Candidate during concurrent development";
  for (const claim of form.claims) {
    claim.explanation = "Fixture implementation";
    for (const criterion of claim.criteria) criterion.explanation = "Fixture preserves fixed context";
  }
  for (const rationale of form.change_rationales) {
    rationale.target_refs = [{ type: "criterion", id: form.claims[0].criteria[0].criterion_id }];
    rationale.rationale = "Implements the fixture issue";
  }
  const submission = join(x.root, "candidate.json"); writeFileSync(submission, JSON.stringify(form));
  const candidate = await invoke("candidate", "submit", "--dev-run", archivedRoute.dev_run_id!, "--expected-version", "1",
    "--file", submission, "--archive-policy", transport.policy(), "--operation-id", actor().operation_id,
    "--agent-id", "fixture", "--agent-name", "Fixture");
  const tag = `refs/tags/grounds/candidates/${candidate.candidate_id}`, archivedHead = candidate.source.commit.slice(5);
  assert.equal(git(["rev-parse", tag], { gitDir: x.remote }), archivedHead);
  git(["fetch", "origin", `${tag}:${tag}`], { cwd: x.route.path });
  const environment = await new RepositoryEnvironments(x.ledger.store).save({ ...actor(), environment_id: actor().operation_id,
    repository_id: x.route.repository_id, expected_version: 0, configuration: { name: "Isolation fixture",
      image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, postgres: { image: process.env.GROUNDS_CODE_POSTGRES_IMAGE! } } });
  const engine = new DockerRouteEngine(), executions = new CodeRouteExecutions(x.ledger.store, engine);
  const start = (route_id: string) => executions.start({ ...actor(), route_id, environment_revision_id: environment.revision_id,
    mode: "development", argv: ["sleep", "600"] });
  const a = await start(x.route.route_id), b = await start(sibling.route_id);
  const ref = (run: RouteExecution) => ({ route_id: run.route_id, execution_id: run.execution_id });
  const inside = (run: RouteExecution, ...args: string[]) => docker(["exec", run.container_id!, ...args]);
  const initialHead = git(["rev-parse", "HEAD"], { cwd: sibling.path });
  const siblingRef = `refs/heads/${sibling.development.branch}`;
  const blob = git(["rev-parse", `${archivedHead}:service.txt`], { cwd: x.route.path });
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: x.route.path });
  const object = join(common, "objects", blob.slice(0, 2), blob.slice(2));
  const originalObject = readFileSync(object);
  inside(b, "python3", "-c", "open('/workspace/service.txt','w').write('B private draft\\n')");
  inside(a, "python3", "-c", "open('/workspace/service.txt','w').write('A implementation\\n')");
  assert.equal(inside(a, "git", "show", `${tag}:service.txt`), "archived Candidate", "committed history remains readable");
  assert.equal(inside(a, "git", "rev-parse", siblingRef), initialHead);
  const deniedWrite = (...args: string[]) => assert.throws(() => inside(a, ...args), (error: any) => {
    // Packed refs have no loose parent directories; Git reports mkdir failure without errno.
    assert.match(error.details?.diagnostic ?? "", /read-only file system|permission denied|unable to create directory for \/grounds-git\//i); return true;
  });
  // A cannot address B's actual working files, including via a symlink from A's own tree.
  assert.equal(inside(a, "python3", "-c", `import os,sys
p=sys.argv[1]
assert not os.path.exists(p)
os.symlink(p,'/workspace/peer')
for mode in ['r','w']:
 try:
  f=open('/workspace/peer/service.txt',mode)
 except OSError:
  continue
 f.close()
 raise AssertionError('peer worktree accessible')
os.unlink('/workspace/peer')
print('peer worktree unavailable')
`, sibling.path), "peer worktree unavailable");
  deniedWrite("mkdir", inside(a, "git", "rev-parse", "--git-path", "refs/isolation-write-probe"));
  deniedWrite("git", "update-ref", siblingRef, archivedHead);
  deniedWrite("git", "update-ref", tag, initialHead);
  deniedWrite("git", "update-ref", "-d", tag);
  const objectInContainer = inside(a, "git", "rev-parse", "--git-path", `objects/${blob.slice(0, 2)}/${blob.slice(2)}`);
  inside(a, "test", "-f", objectInContainer); // Missing files must not make the attack pass.
  deniedWrite("python3", "-c", "import sys; open(sys.argv[1],'wb').write(b'corrupt')", objectInContainer);
  deniedWrite("rm", objectInContainer);
  deniedWrite("sh", "-c", "printf forged > /workspace/.git");
  deniedWrite("sh", "-c", "printf forged > /baselines/payments/service.txt");
  const assertPeerUnchanged = () => {
    assert.equal(readFileSync(join(sibling.path, "service.txt"), "utf8"), "B private draft\n");
    assert.equal(git(["show", ":service.txt"], { cwd: sibling.path }), "first version");
    assert.equal(git(["rev-parse", siblingRef], { cwd: x.route.path }), initialHead);
    assert.equal(git(["rev-parse", tag], { cwd: x.route.path }), archivedHead);
    assert.equal(git(["rev-parse", tag], { gitDir: x.remote }), archivedHead);
    assert.deepEqual(readFileSync(object), originalObject);
  };
  assertPeerUnchanged();
  const channel = new CodeRouteRequests(x.ledger.store, engine);
  const publish = (run: RouteExecution, body: object) => inside(run, "python3", "-c",
    "import os,sys; open('/grounds-requests/inbox/next.json','w').write(sys.argv[1]); os.replace('/grounds-requests/inbox/next.json','/grounds-requests/inbox/request.json')", JSON.stringify(body));
  const request = { request_id: actor().operation_id, execution_id: a.execution_id, action: "stage", paths: ["service.txt"] };
  for (const change of [{ execution_id: b.execution_id }, { route_id: b.route_id }, { ref: siblingRef }, { ref: tag },
    { paths: [sibling.path + "/service.txt"] }, { paths: ["../escape"] }, { paths: [".git/config"] }]) {
    publish(a, { ...request, ...change });
    await assert.rejects(channel.process(ref(a)), { code: "VALIDATION_ERROR" });
    assertPeerUnchanged();
    assert.equal((await executions.observe(ref(b))).status.state, "running");
  }
  const perform = async (run: RouteExecution, body: object) => {
    const input = { request_id: actor().operation_id, execution_id: run.execution_id, ...body };
    publish(run, input);
    const receipt = await channel.process(ref(run));
    assert.equal(receipt.state, "completed");
    // Use the shipped client: unlike cat, it verifies file stability and receipt identity.
    let response = "";
    try {
      response = inside(run, "grounds-git", "--timeout", "10", "retry");
      assert.deepEqual(JSON.parse(response), receipt);
    } catch (error: any) {
      t.diagnostic(JSON.stringify({ client_response: response, error: error.details ?? String(error), expected: receipt }));
      throw error;
    }
    assert.equal((await executions.observe(ref(run))).status.state, "running");
    return { input, receipt };
  };
  const staged = await perform(a, { action: "stage", paths: ["service.txt"] });
  publish(a, { ...staged.input, action: "unstage" });
  await assert.rejects(channel.process(ref(a)), { code: "STATE_CONFLICT" });
  publish(a, staged.input); assert.deepEqual(await channel.process(ref(a)), staged.receipt);
  assertPeerUnchanged();
  await perform(a, { action: "commit", message: "Develop A", author: { name: "A", email: "a@example.invalid" } });
  assertPeerUnchanged();
  assert.equal(git(["show", "HEAD:service.txt"], { cwd: x.route.path }), "A implementation");
  await perform(b, { action: "stage", paths: ["service.txt"] });
  await perform(b, { action: "commit", message: "Develop B", author: { name: "B", email: "b@example.invalid" } });
  assert.equal(git(["show", "HEAD:service.txt"], { cwd: sibling.path }), "B private draft");
  assert.equal(git(["show", "HEAD:service.txt"], { cwd: x.route.path }), "A implementation");
  assert.equal(git(["rev-parse", tag], { gitDir: x.remote }), archivedHead);
  assert.deepEqual(readFileSync(object), originalObject);
  const sql = (run: RouteExecution, statement: string) => assert.equal(inside(run, "python3", "-c", query(statement)), "query succeeded");
  const rows = (run: RouteExecution) => docker(["exec", run.dependency!.container_id, "psql", "-X", "-v", "ON_ERROR_STOP=1",
    "-U", "postgres", "-d", "task", "-Atc", "SELECT value FROM marker ORDER BY value"]);
  for (const [run, marker] of [[a, "A"], [b, "B"]] as const) {
    sql(run, `CREATE TABLE marker(value text); INSERT INTO marker VALUES ('${marker}');`);
    assert.equal(rows(run), marker);
    assert.equal((await executions.observe(ref(run))).status.state, "running");
  }
  assert.notEqual(a.dependency!.network_id, b.dependency!.network_id);
  assert.notEqual(a.dependency!.volume_name, b.dependency!.volume_name);
  const peer = JSON.parse(docker(["inspect", b.dependency!.container_id]))[0];
  const addresses = Object.values(peer.NetworkSettings.Networks).map((network: any) => network.IPAddress);
  assert.equal(addresses.length, 1); assert.match(addresses[0]!, /^\d+\.\d+\.\d+\.\d+$/);
  assert.deepEqual(peer.HostConfig.PortBindings, {});
  // B is demonstrably healthy. Test its real address, not just unresolvable names.
  const targets = [...addresses, peer.Name.slice(1)];
  assert.equal(inside(a, "python3", "-c", `import socket,sys
for host in sys.argv[1:]:
 try:
  s=socket.create_connection((host,5432),2)
 except OSError:
  continue
 s.close()
 raise AssertionError('cross-route database is reachable: '+host)
print('peer unreachable')
`, ...targets), "peer unreachable");
  sql(a, "TRUNCATE marker;");
  assert.equal(rows(a), ""); assert.equal(rows(b), "B");
  sql(a, "INSERT INTO marker VALUES ('A-after');");
  sql(b, "INSERT INTO marker VALUES ('B-after');");
  assert.equal(rows(a), "A-after"); assert.equal(rows(b), "B\nB-after");
  await executions.stop(ref(a));
  assert.equal((await executions.observe(ref(b))).status.state, "running");
  assert.equal(rows(b), "B\nB-after");
  await x.admit();
  const resumed = await start(x.route.route_id);
  assert.notEqual(resumed.execution_id, a.execution_id);
  publish(resumed, staged.input); // Old execution capability cannot be replayed into a new generation.
  await assert.rejects(channel.process(ref(resumed)), { code: "VALIDATION_ERROR" });
  await assert.rejects(channel.process(ref(a)), { code: "STATE_CONFLICT" });
  assert.equal((await executions.observe(ref(resumed))).status.state, "running");
  assert.equal((await executions.observe(ref(b))).status.state, "running");
  assert.equal(inside(resumed, "git", "show", "HEAD:service.txt"), "A implementation");
  assert.equal(rows(resumed), "A-after"); assert.equal(rows(b), "B\nB-after");
  assert.equal(git(["rev-parse", tag], { cwd: x.route.path }), archivedHead);
  assert.equal(git(["rev-parse", tag], { gitDir: x.remote }), archivedHead);
  assert.deepEqual(readFileSync(object), originalObject);
  await executions.stop(ref(resumed));
  await executions.stop(ref(b));
});
