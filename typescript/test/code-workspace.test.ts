import { DatabaseSync } from "node:sqlite";
import { codeWorkspaceFixture } from "./code-workspace-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CodeWorkspaces } from "../src/code-workspace.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent } from "./fixture.js";

test("saving a Workspace configuration preserves its complete repository selection across service instances", async t => {
  const fixture = await LedgerFixture.create();
  t.after(() => fixture.close());
  const service = new CodeWorkspaces(fixture.store);
  const configuration = {
    name: "Order services",
    repositories: [{ repository_id: fixture.repository.repository_id, alias: "order-service", revision: { branch: "main" } }],
  };
  const saved = await service.saveConfiguration({ configuration_id: newUUIDv7(), expected_version: 0, configuration, attribution: testAgent });
  const reopened = await new CodeWorkspaces(fixture.store).configuration(saved.configuration_id, 1);
  assert.equal(reopened.version, 1);
  assert.deepEqual(reopened.configuration, configuration);
  assert.match(reopened.digest, /^sha256:[0-9a-f]{64}$/);
});

test("revising configuration leaves the earlier version readable and rejects stale updates", async t => {
  const fixture = await LedgerFixture.create();
  t.after(() => fixture.close());
  const service = new CodeWorkspaces(fixture.store), id = newUUIDv7();
  const original = { name: "Services", repositories: [{ repository_id: fixture.repository.repository_id, alias: "orders", revision: { branch: "main" } }] };
  await service.saveConfiguration({ configuration_id: id, expected_version: 0, configuration: original, attribution: testAgent });
  await service.saveConfiguration({ configuration_id: id, expected_version: 1, configuration: { ...original, name: "New services" }, attribution: testAgent });
  assert.deepEqual((await service.configuration(id, 1)).configuration, original);
  assert.equal((await service.configuration(id)).configuration.name, "New services");
  await assert.rejects(service.saveConfiguration({ configuration_id: id, expected_version: 1, configuration: original, attribution: testAgent }), { code: "VERSION_CONFLICT" });
  assert.equal((await service.configuration(id)).version, 2);
});

test("invalid repository selections are rejected without creating a configuration", async t => {
  const fixture = await LedgerFixture.create();
  t.after(() => fixture.close());
  const service = new CodeWorkspaces(fixture.store);
  const repo = { repository_id: fixture.repository.repository_id, alias: "orders", revision: { branch: "main" } };
  for (const configuration of [
    { name: "Services", repositories: [] },
    { name: "Services", repositories: [repo, repo] },
    { name: "Services", repositories: [{ ...repo, alias: "../outside" }] },
    { name: "Services", repositories: [{ ...repo, revision: { branch: "--upload-pack=bad" } }] },
    { name: "Services", repositories: [{ ...repo, revision: { branch: "main", commit: "sha1:" + "a".repeat(40) } }] },
    { name: "Services", repositories: [{ ...repo, revision: { commit: "HEAD" } }] },
    { name: "Services", repositories: [repo], secret: "not-a-config-field" },
  ]) {
    const id = newUUIDv7();
    await assert.rejects(service.saveConfiguration({ configuration_id: id, expected_version: 0, configuration: configuration as any, attribution: testAgent }), { code: "VALIDATION_ERROR" });
    await assert.rejects(service.configuration(id), { code: "NOT_FOUND" });
  }
  const missingId = newUUIDv7();
  await assert.rejects(service.saveConfiguration({ configuration_id: missingId, expected_version: 0,
    configuration: { name: "Services", repositories: [{ ...repo, repository_id: newUUIDv7() }] }, attribution: testAgent }), { code: "NOT_FOUND" });
  await assert.rejects(service.configuration(missingId), { code: "NOT_FOUND" });
});

test("retrying a saved configuration returns its original version even after another edit", async t => {
  const fixture = await LedgerFixture.create();
  t.after(() => fixture.close());
  const service = new CodeWorkspaces(fixture.store);
  const input = { operation_id: newUUIDv7(), configuration_id: newUUIDv7(), expected_version: 0, attribution: testAgent,
    configuration: { name: "Services", repositories: [{ repository_id: fixture.repository.repository_id, alias: "orders", revision: { branch: "main" } }] } };
  const original = await service.saveConfiguration(input);
  await service.saveConfiguration({ ...input, operation_id: newUUIDv7(), expected_version: 1, configuration: { ...input.configuration, name: "Updated" } });
  assert.deepEqual(await service.saveConfiguration(input), original);
  await assert.rejects(service.saveConfiguration({ ...input, configuration: { ...input.configuration, name: "Different request" } }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal((await service.configuration(input.configuration_id)).version, 2);
});

test("configuration writes cannot replace another record kind and concurrent edits have one winner", async t => {
  const fixture = await LedgerFixture.create();
  t.after(() => fixture.close());
  const service = new CodeWorkspaces(fixture.store), configurationId = newUUIDv7();
  const configuration = { name: "Services", repositories: [{ repository_id: fixture.repository.repository_id, alias: "orders", revision: { branch: "main" } }] };
  const first = await service.saveConfiguration({ configuration_id: configurationId, expected_version: 0, configuration, attribution: testAgent });
  const outcomes = await Promise.allSettled(["A", "B"].map(name => service.saveConfiguration({ configuration_id: configurationId, expected_version: 1, configuration: { ...configuration, name }, attribution: testAgent })));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.deepEqual(await service.configuration(configurationId, 1), first);
  // A configuration version is immutable and cannot be treated as a mutable configuration head.
  assert.match(first.revision_id, /^[0-9a-f-]{36}$/);
  await assert.rejects(service.saveConfiguration({ configuration_id: first.revision_id, expected_version: 1, configuration, attribution: testAgent }), { code: "VALIDATION_ERROR" });
  assert.deepEqual(await service.configuration(configurationId, 1), first);
});

test("an Issue instance freezes its configuration and retries return the same instance", async t => {
  const fixture = await LedgerFixture.create();
  t.after(() => fixture.close());
  const service = new CodeWorkspaces(fixture.store), configurationId = newUUIDv7();
  const saved = await service.saveConfiguration({ configuration_id: configurationId, expected_version: 0, attribution: testAgent,
    configuration: { name: "Services", repositories: [{ repository_id: fixture.repository.repository_id, alias: "orders", revision: { branch: "main" } }] } });
  const request = { operation_id: newUUIDv7(), configuration_id: configurationId, configuration_version: 1,
    issue_id: fixture.issue.issue_id, issue_version: 1, host_id: newUUIDv7(), attribution: testAgent };
  const instance = await service.createInstance(request);
  await service.saveConfiguration({ configuration_id: configurationId, expected_version: 1, attribution: testAgent,
    configuration: { ...saved.configuration, name: "Changed", repositories: [{ ...saved.configuration.repositories[0], revision: { branch: "release" } }] } });
  assert.deepEqual(await service.createInstance(request), instance);
  assert.deepEqual((await service.instance(instance.instance_id)).configuration, saved);
  assert.equal(instance.issue_id, fixture.issue.issue_id);
  assert.equal(instance.issue_version, 1);
  assert.equal(instance.state, "preparing");
  assert.equal(instance.execution_enabled, false);
  assert.notEqual((await service.createInstance({ ...request, operation_id: newUUIDv7() })).instance_id, instance.instance_id);
});

test("Workspace configuration operations remain valid in the whole-ledger integrity scan", async t => {
  const fixture = await LedgerFixture.create();
  t.after(() => fixture.close());
  const service = new CodeWorkspaces(fixture.store);
  const input = { operation_id: newUUIDv7(), configuration_id: newUUIDv7(), expected_version: 0, attribution: testAgent,
    configuration: { name: "Services", repositories: [{ repository_id: fixture.repository.repository_id, alias: "orders", revision: { branch: "main" } }] } };
  const saved = await service.saveConfiguration(input);
  assert.deepEqual((await fixture.store.inspectIntegrity()).report, { valid: true, issues: [] });
  assert.deepEqual(await service.saveConfiguration(input), saved, "integrity reads preserve idempotent replay");
});


test("Workspace integrity rejects swapped results, wrong commands and malformed snapshots without rewriting replay", async t => {
  const x = await codeWorkspaceFixture(t);
  const request = { operation_id: newUUIDv7(), configuration_id: newUUIDv7(), expected_version: 0, attribution: testAgent,
    configuration: { name: "First", repositories: [{ repository_id: x.ledger.repository.repository_id, alias: "orders", revision: { branch: "main" } }] } };
  const original = await x.service.saveConfiguration(request);
  const other = await x.service.saveConfiguration({ ...request, operation_id: newUUIDv7(), configuration_id: newUUIDv7(),
    configuration: { ...request.configuration, name: "Other" } });
  const db = new DatabaseSync(x.ledgerPath);
  try {
    for (const [command, result] of [
      ["code-workspace.config-save", other],
      ["code-workspace.config-save", { ...original, revision_id: newUUIDv7() }],
      ["code-workspace.config-save", { ...original, configuration: null }],
      ["code-workspace.config-save", { ...original, format: "grounds.unknown/v1" }],
      ["code-workspace.unknown", original],
      ["repository.register", original],
      ["code-workspace.environment-save", original],
    ] as const) {
      db.prepare("UPDATE idempotency_records SET command = ?, result_json = ? WHERE operation_id = ?")
        .run(command, JSON.stringify(result), request.operation_id);
      const report = (await x.ledger.store.inspectIntegrity()).report;
      assert.ok(report.issues.some(item => item.check === "idempotency" && item.resource_id === request.operation_id), command);
    }
    db.prepare("UPDATE idempotency_records SET command = ?, result_json = ? WHERE operation_id = ?")
      .run("code-workspace.config-save", JSON.stringify(original), request.operation_id);
    assert.deepEqual((await x.ledger.store.inspectIntegrity()).report, { valid: true, issues: [] });
    assert.deepEqual(await x.service.saveConfiguration(request), original);
  } finally { db.close(); }
});
