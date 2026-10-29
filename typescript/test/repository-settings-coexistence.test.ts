import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { RepositoryEnvironmentChecks } from "../src/repository-environment-check.js";
import { RepositoryArchiveAccess } from "../src/repository-archive-access.js";
import { GitLabClient } from "../src/gitlab-api.js";
import { gitLabAPIFixture } from "./gitlab-api-fixture.js";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import type { RouteEngine, RouteExecution, RouteEngineStatus } from "../src/code-route-execution.js";

class CheckEngine implements RouteEngine {
  exitCode = 0;
  stopUnknown = false;
  id = "check-engine";
  containers = new Set<string>();
  async identity() { return this.id; }
  async platform() { return "linux/amd64"; }
  async create(run: RouteExecution) { this.containers.add(run.execution_id); return run.execution_id; }
  async find(run: RouteExecution) { return this.containers.has(run.execution_id) ? run.execution_id : undefined; }
  async start(_run: RouteExecution) {}
  async status(_run: RouteExecution): Promise<RouteEngineStatus> { return { state: "exited", exit_code: this.exitCode }; }
  async removeStopped(run: RouteExecution) { if (this.stopUnknown) throw new Error("stop unknown"); this.containers.delete(run.execution_id); }
}

async function setup(t: TestContext) {
  const x = await executionFixture(t), api = await gitLabAPIFixture();
  t.after(() => api.close());
  api.state.publicInstance = "https://example.test";
  const access = new RepositoryArchiveAccess(x.ledger.store, () => new GitLabClient(api.instance,
    () => ({ token: "fixture-maintainer", source: "environment" })));
  const versions = new RepositoryEnvironments(x.ledger.store);
  const env = await versions.save({ ...actor(), repository_id: x.route.repository_id, environment_id: newUUIDv7(),
    expected_version: 0, configuration: { name: "dev", image: `sha256:${"1".repeat(64)}` } });
  const check = await new RepositoryEnvironmentChecks(x.ledger.store, new CheckEngine()).check({ ...actor(),
    route_id: x.route.route_id, environment_revision_id: env.revision_id });
  const promotion = { ...actor(), repository_id: x.route.repository_id, check_id: check.check_id, expected_version: 0 };
  const binding = { ...actor(), repository_id: x.route.repository_id, expected_version: 0 };
  return { ...x, access, versions, env, check, promotion, binding };
}

test("a repository can select its default environment after binding GitLab archival", async t => {
  const x = await setup(t);
  const bound = await x.access.bind(x.binding);
  const selected = await x.versions.setDefault(x.promotion);
  assert.equal(selected.revision_id, x.env.revision_id);
  assert.deepEqual(await x.versions.default(x.route.repository_id), selected);
  assert.equal((await x.access.check(x.route.repository_id)).state, "ready");
  assert.deepEqual((await x.access.status(x.route.repository_id)).binding, bound.binding);
});

test("archive binding after default selection has independent versions and replay", async t => {
  const x = await setup(t), id = x.route.repository_id;
  const selected = await x.versions.setDefault(x.promotion);
  assert.equal((await x.access.status(id)).binding_version, 0);
  const bound = await x.access.bind(x.binding);
  const next = await x.access.bind({ ...x.binding, ...actor(), expected_version: 1 });
  assert.equal(next.binding_version, 2);
  assert.deepEqual(await x.versions.default(id), selected);
  await x.versions.setDefault({ ...x.promotion, ...actor(), expected_version: 1 });
  assert.deepEqual(await x.access.bind(x.binding), bound);
  assert.deepEqual(await x.versions.setDefault(x.promotion), selected);
  assert.equal((await x.versions.default(id)).version, 2);
  assert.equal((await x.access.status(id)).binding_version, 2);
  await assert.rejects(x.access.bind({ ...x.binding, ...actor(), expected_version: 1 }), { code: "VERSION_CONFLICT" });
  await assert.rejects(x.versions.setDefault({ ...x.promotion, ...actor(), expected_version: 1 }), { code: "VERSION_CONFLICT" });
});

for (const legacy of ["archive", "default"] as const) test(`historical ${legacy} remains readable and updatable while adding the other setting`, async t => {
  const x = await setup(t), id = x.route.repository_id;
  const report = await x.access.check(id);
  // Historical persisted inputs, constructed from the published v1 formats.
  const data = legacy === "archive" ? {
    format: "grounds.repository-archive-binding/v1", repository_id: id, canonical_remote: report.canonical_remote,
    instance: report.instance, project_id: report.project_id, project_path: report.project_path,
    ref_namespaces: ["refs/tags/grounds/candidates/", "refs/tags/grounds/deliveries/"],
    initial_policy_digest: report.policy_digest, bound_at: report.checked_at, attribution: actor().attribution,
  } : {
    format: "grounds.repository-environment-default/v1", repository_id: id, revision_id: x.env.revision_id,
    check_id: x.check.check_id, version: 1, attribution: actor().attribution, selected_at: report.checked_at,
  };
  await x.ledger.store.write(tx => tx.saveRuntimeRecord({ id, kind: "runtime_operation", version: 1,
    ...(legacy === "archive" ? { parent_id: id } : {}), data }, 0));
  if (legacy === "archive") {
    assert.deepEqual((await x.access.status(id)).binding, data);
    await x.versions.setDefault(x.promotion);
    assert.deepEqual((await x.access.status(id)).binding, data);
    assert.equal((await x.access.bind({ ...x.binding, expected_version: 1 })).binding_version, 2);
  } else {
    assert.deepEqual(await x.versions.default(id), data);
    await x.access.bind(x.binding);
    assert.deepEqual(await x.versions.default(id), data);
    assert.equal((await x.versions.setDefault({ ...x.promotion, expected_version: 1 })).version, 2);
  }
  // Storage inspection is confined to the explicit no-migration compatibility assertion.
  const old = await x.ledger.store.read(tx => tx.getRuntimeRecord("runtime_operation", id));
  assert.equal(old?.version, 2);
  assert.equal(old?.data.format, data.format);
  assert.equal((await x.access.status(id)).binding_version, legacy === "archive" ? 2 : 1);
  assert.equal((await x.versions.default(id)).version, legacy === "default" ? 2 : 1);
});

test("simultaneous creation and same-setting updates never lose either repository setting", async t => {
  const x = await setup(t), id = x.route.repository_id;
  await Promise.all([x.access.bind(x.binding), x.versions.setDefault(x.promotion)]);
  for (const change of [() => x.access.bind({ ...x.binding, ...actor(), expected_version: 1 }),
    () => x.versions.setDefault({ ...x.promotion, ...actor(), expected_version: 1 })]) {
    const outcomes = await Promise.allSettled([change(), change()]);
    assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(x => x.status === "rejected").length, 1);
  }
  assert.equal((await x.access.status(id)).binding_version, 2);
  assert.equal((await x.versions.default(id)).version, 2);
});

for (const bad of ["format", "owner", "parent"] as const) test(`a legacy setting with invalid ${bad} is not accepted or overwritten`, async t => {
  const x = await setup(t), id = x.route.repository_id;
  await x.ledger.store.write(tx => tx.saveRuntimeRecord({ id, kind: "runtime_operation", version: 1,
    ...(bad === "parent" ? { parent_id: newUUIDv7() } : {}),
    data: { format: bad === "format" ? "unexpected/v1" : "grounds.repository-environment-default/v1",
      repository_id: bad === "owner" ? newUUIDv7() : id } }, 0));
  await assert.rejects(x.access.status(id), { code: "ARTIFACT_INTEGRITY_ERROR" });
  await assert.rejects(x.versions.default(id), { code: "ARTIFACT_INTEGRITY_ERROR" });
  await assert.rejects(x.access.bind(x.binding), { code: "ARTIFACT_INTEGRITY_ERROR" });
  await assert.rejects(x.versions.setDefault(x.promotion), { code: "ARTIFACT_INTEGRITY_ERROR" });
});

for (const kind of ["archive", "default"] as const) test(`conflicting persisted identities for ${kind} are rejected`, async t => {
  const x = await setup(t), id = x.route.repository_id;
  const data = kind === "archive" ? (await x.access.bind(x.binding)).binding : await x.versions.setDefault(x.promotion);
  await x.ledger.store.write(tx => tx.saveRuntimeRecord({ id, kind: "runtime_operation", version: 1,
    ...(kind === "archive" ? { parent_id: id } : {}), data: { ...data } }, 0));
  const read = () => kind === "archive" ? x.access.status(id) : x.versions.default(id);
  const update = () => kind === "archive" ? x.access.bind({ ...x.binding, ...actor(), expected_version: 1 })
    : x.versions.setDefault({ ...x.promotion, ...actor(), expected_version: 1 });
  await assert.rejects(read(), { code: "ARTIFACT_INTEGRITY_ERROR" });
  await assert.rejects(update(), { code: "ARTIFACT_INTEGRITY_ERROR" });
});

test("new setting storage rejects a record whose declared owner or type was corrupted", async t => {
  const x = await setup(t), id = x.route.repository_id;
  await x.access.bind(x.binding);
  await x.versions.setDefault(x.promotion);
  // Inject corrupt persisted input after normal creation, without reproducing the key algorithm.
  const rows = await x.ledger.store.read(tx => tx.listRuntimeRecords("runtime_operation", id));
  for (const row of rows.filter(row => ["grounds.repository-archive-binding/v1", "grounds.repository-environment-default/v1"].includes(String(row.data.format)))) {
    const archive = row.data.format === "grounds.repository-archive-binding/v1";
    await x.ledger.store.write(tx => tx.saveRuntimeRecord({ ...row, version: row.version + 1,
      data: { ...row.data, ...(archive ? { repository_id: newUUIDv7() } : { format: "unexpected/v1" }) } }, row.version));
  }
  await assert.rejects(x.access.status(id), { code: "ARTIFACT_INTEGRITY_ERROR" });
  await assert.rejects(x.versions.default(id), { code: "ARTIFACT_INTEGRITY_ERROR" });
  await assert.rejects(x.access.bind({ ...x.binding, ...actor(), expected_version: 2 }), { code: "ARTIFACT_INTEGRITY_ERROR" });
  await assert.rejects(x.versions.setDefault({ ...x.promotion, ...actor(), expected_version: 2 }), { code: "ARTIFACT_INTEGRITY_ERROR" });
});

test("competing initial writes create exactly one version of each setting", async t => {
  const x = await setup(t), id = x.route.repository_id;
  for (const change of [() => x.access.bind({ ...x.binding, ...actor() }),
    () => x.versions.setDefault({ ...x.promotion, ...actor() })]) {
    const outcomes = await Promise.allSettled([change(), change()]);
    assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(x => x.status === "rejected").length, 1);
  }
  assert.equal((await x.access.status(id)).binding_version, 1);
  assert.equal((await x.versions.default(id)).version, 1);
});
