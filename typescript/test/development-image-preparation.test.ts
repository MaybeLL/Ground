import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LedgerFixture, testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { DevelopmentRecipes } from "../src/development-recipes.js";
import { DevelopmentImagePreparations } from "../src/development-image-preparation.js";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import type { DevelopmentBuildIdentity } from "../src/development-image-buildkit.js";

class Builder {
  images = new Map<string, string>(); calls = 0; loseReply = false;
  async identity() { return { endpoint: "unix:///fixture", engine_id: "fixture", platform: "linux/arm64", builder: "docker-buildkit/v1" }; }
  async find(r: DevelopmentBuildIdentity) { return this.images.get(r.preparation_id); }
  async verify(r: DevelopmentBuildIdentity, image: string) { return this.images.get(r.preparation_id) === image; }
  async build(r: DevelopmentBuildIdentity) { this.calls++; const image = "sha256:" + this.calls.toString(16).padStart(64, "0"); this.images.set(r.preparation_id, image); if (this.loseReply) throw Error("connection lost"); return image; }
}
async function fixture(t: import("node:test").TestContext) {
  const ledger = await LedgerFixture.create(), root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-preparation-")));
  t.after(async () => { await ledger.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
  const recipe = await new DevelopmentRecipes(ledger.store).save({ operation_id: newUUIDv7(), attribution: testAgent,
    recipe_id: newUUIDv7(), repository_id: ledger.repository.repository_id, expected_version: 0, source: root, name: "Dev", dockerfile: "Dockerfile", files: ["Dockerfile"] });
  const builder = new Builder(), preparations = new DevelopmentImagePreparations(ledger.store, builder);
  const request = { operation_id: newUUIDv7(), attribution: testAgent, recipe_revision_id: recipe.revision_id, data_root: join(root, "data"),
    build_args: {}, target: { environment_id: newUUIDv7(), expected_version: 0, configuration: { name: "Dev", postgres: { image: "sha256:" + "a".repeat(64) } } } };
  return { ledger, root, builder, preparations, request };
}
test("prepare registers the exact built image and preserves runtime configuration; replay never rebuilds", async t => {
  const x = await fixture(t), ready = await x.preparations.prepare(x.request);
  assert.equal(ready.state, "ready"); assert.ok(ready.environment_revision_id);
  const environment = await new RepositoryEnvironments(x.ledger.store).revision(ready.environment_revision_id!);
  assert.equal(environment.configuration.image, ready.image);
  assert.deepEqual(environment.configuration.postgres, x.request.target.configuration.postgres);
  assert.equal(environment.configuration.preparation_id, ready.preparation_id);
  assert.deepEqual(await x.preparations.prepare(x.request), ready); assert.equal(x.builder.calls, 1);
  const another = await x.preparations.prepare({ ...x.request, operation_id: newUUIDv7(), target: { ...x.request.target, environment_id: newUUIDv7() } });
  assert.equal(another.state, "ready"); assert.equal(x.builder.calls, 2, "new operation calls Docker, no Grounds result cache");
});

test("lost build reply recovers the proven image, while an unproven result blocks replacement operations", async t => {
  const x = await fixture(t); x.builder.loseReply = true;
  const unknown = await x.preparations.prepare(x.request);
  assert.equal(unknown.state, "needs-recovery");
  await assert.rejects(x.preparations.prepare({ ...x.request, operation_id: newUUIDv7() }), /Unresolved/);
  const ready = await x.preparations.prepare(x.request);
  assert.equal(ready.state, "ready"); assert.equal(x.builder.calls, 1);
  const y = await fixture(t); y.builder.build = async () => { y.builder.calls++; throw Error("disconnected before result"); };
  assert.equal((await y.preparations.prepare(y.request)).state, "needs-recovery");
  assert.equal((await y.preparations.prepare(y.request)).state, "needs-recovery");
  assert.equal(y.builder.calls, 1);
});

test("a concurrent environment update survives registration conflict and built image can be explicitly registered elsewhere", async t => {
  const x = await fixture(t), environments = new RepositoryEnvironments(x.ledger.store);
  const existing = await environments.save({ operation_id: newUUIDv7(), attribution: testAgent,
    environment_id: x.request.target.environment_id, repository_id: x.ledger.repository.repository_id, expected_version: 0,
    configuration: { name: "Concurrent", image: "sha256:" + "f".repeat(64) } });
  const ready = await x.preparations.prepare(x.request);
  assert.equal(ready.state, "ready"); assert.ok(ready.registration_error); assert.equal(ready.environment_revision_id, undefined);
  assert.deepEqual(await environments.revision(existing.revision_id), existing);
  const explicit = await environments.save({ operation_id: newUUIDv7(), attribution: testAgent,
    environment_id: newUUIDv7(), repository_id: x.ledger.repository.repository_id, expected_version: 0,
    configuration: { name: "Explicit", image: ready.image!, preparation_id: ready.preparation_id } });
  assert.equal(explicit.configuration.image, ready.image); assert.equal(x.builder.calls, 1);
});

test("cancellation of an unknown build retains ownership until its result is proven and never registers that image", async t => {
  const x = await fixture(t); x.builder.loseReply = true;
  const unknown = await x.preparations.prepare(x.request);
  const cancelled = await x.preparations.cancel({ operation_id: newUUIDv7(), attribution: testAgent, preparation_id: unknown.preparation_id });
  assert.equal(cancelled.state, "needs-recovery"); assert.ok(cancelled.cancellation);
  const terminal = await x.preparations.prepare(x.request);
  assert.equal(terminal.state, "cancelled"); assert.ok(terminal.image); assert.equal(terminal.environment_revision_id, undefined);
  assert.equal(x.builder.calls, 1);
});

test("recipe, preparation and registration remain valid in ledger integrity inspection", async t => {
  const x = await fixture(t); await x.preparations.prepare(x.request);
  assert.deepEqual((await x.ledger.store.inspectIntegrity()).report, { valid: true, issues: [] });
});

test("cleanup preserves image and logs, refuses modified material, and replays without touching new files", async t => {
  const x = await fixture(t), ready = await x.preparations.prepare(x.request);
  const context = join(x.request.data_root, "runtime", "development-builds", ready.preparation_id, "context"), path = join(context, "Dockerfile");
  writeFileSync(path, "changed\n");
  const request = { operation_id: newUUIDv7(), attribution: testAgent, preparation_id: ready.preparation_id };
  await assert.rejects(x.preparations.cleanup(request), /modified|unexpected/i);
  writeFileSync(path, "FROM scratch\n");
  const cleaned = await x.preparations.cleanup(request); assert.equal(cleaned.cleanup?.state, "complete"); assert.equal(cleaned.image, ready.image);
  const { existsSync, mkdirSync } = await import("node:fs"); assert.equal(existsSync(context), false);
  mkdirSync(context); writeFileSync(path, "new files after completed cleanup\n");
  await x.preparations.cleanup(request); assert.equal(existsSync(path), true);
  await x.preparations.cleanup({ ...request, operation_id: newUUIDv7() }); assert.equal(existsSync(path), true);
  assert.equal((await x.ledger.store.inspectIntegrity()).report.valid, true);
});

test("registration target cannot override actor, repository or operation fields", async t => {
  const x = await fixture(t);
  for (const key of ["repository_id", "operation_id", "attribution"])
    await assert.rejects(x.preparations.prepare({ ...x.request, operation_id: newUUIDv7(), target: { ...x.request.target, [key]: newUUIDv7() } }));
  assert.equal(x.builder.calls, 0);
});

test("unknown builds cannot be redispatched by changing data root or an engine endpoint alias", async t => {
  const x = await fixture(t);
  x.builder.loseReply = true;
  assert.equal((await x.preparations.prepare(x.request)).state, "needs-recovery");
  const alternate = { ...x.request, operation_id: newUUIDv7(), data_root: join(x.root, "alternate-data") };
  await assert.rejects(x.preparations.prepare(alternate), /Unresolved/);
  const host = await x.builder.identity();
  x.builder.identity = async () => ({ ...host, endpoint: "unix:///alias-of-fixture" });
  await assert.rejects(x.preparations.prepare({ ...alternate, operation_id: newUUIDv7() }), /Unresolved/);
  assert.equal(x.builder.calls, 1);
  x.builder.identity = async () => host;
  assert.equal((await x.preparations.prepare(x.request)).state, "ready");
  x.builder.loseReply = false;
  assert.equal((await x.preparations.prepare(alternate)).state, "ready");
  assert.equal(x.builder.calls, 2, "proven completion permits a new explicit build at another data root");
});
