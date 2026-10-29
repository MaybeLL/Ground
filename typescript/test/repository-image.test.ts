import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, symlinkSync, existsSync, unlinkSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { codeWorkspaceFixture } from "./code-workspace-fixture.js";
import { actor } from "./code-route-execution-fixture.js";
import { git } from "../src/env-git.js";
import { RepositoryBuildMaterials } from "../src/repository-build-materials.js";
import { RepositoryImagePreparations, type ImageBuildEngine, type ImagePreparation } from "../src/repository-image-preparation.js";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";

class BuildEngine implements ImageBuildEngine {
  calls = 0; loseReply = false; baseMissing = false; id = "builder-one";
  images = new Map<string, string>();
  failed = false;
  beforeBuild?: () => Promise<void>;
  failures = new Set<string>();
  async failureConfirmed(build: ImagePreparation, _directory: string) { return this.failures.has(build.preparation_id); }
  async identity() { return { engine_id: this.id, platform: "linux/arm64", builder: "fixture-builder/v1" }; }
  async assertBase(_image: string, _platform: string) { if (this.baseMissing) throw new Error("base unavailable"); }
  async find(build: ImagePreparation) { return this.images.get(build.preparation_id); }
  async verify(build: ImagePreparation, image: string) { return this.images.get(build.producer_id ?? build.preparation_id) === image; }
  async build(build: ImagePreparation) {
    this.calls++;
    await this.beforeBuild?.();
    if (this.failed) { this.failures.add(build.preparation_id); throw new Error("daemon confirmed failure"); }
    const image = `sha256:${String(this.calls).repeat(64)}`;
    this.images.set(build.preparation_id, image);
    if (this.loseReply) throw new Error("lost build reply");
    return image;
  }
}

test("build materials capture only selected regular files at an exact commit and survive working tree changes", async t => {
  const x = await codeWorkspaceFixture(t);
  git(["remote", "set-url", "origin", "ssh://git@example.test/team/repo"], { cwd: x.writer });
  writeFileSync(join(x.writer, "Dockerfile"), "FROM grounds-base\nCOPY service.txt /service.txt\n");
  git(["add", "Dockerfile"], { cwd: x.writer });
  git(["commit", "-qm", "build recipe"], { cwd: x.writer });
  const commit = `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`;
  const service = new RepositoryBuildMaterials(x.ledger.store);
  const request = { ...actor(), repository_id: x.ledger.repository.repository_id, source: x.writer, commit,
    dockerfile: "Dockerfile", files: ["Dockerfile", "service.txt"] };
  const material = await service.capture(request);
  assert.equal(Buffer.from(material.files.find(f => f.path === "service.txt")!.content, "base64").toString(), "first version\n");
  writeFileSync(join(x.writer, "service.txt"), "dirty new material\n");
  writeFileSync(join(x.writer, "untracked.txt"), "untracked\n");
  assert.deepEqual(await service.capture(request), material);
  assert.deepEqual(await service.show(material.material_id), material);
  await assert.rejects(service.capture({ ...request, files: ["Dockerfile"] }));
  await assert.rejects(service.capture({ ...request, ...actor(), files: ["Dockerfile", "untracked.txt"] }));
  await assert.rejects(service.capture({ ...request, ...actor(), commit: "main" }));
  await assert.rejects(service.capture({ ...request, ...actor(), files: ["Dockerfile", "../service.txt"] }));
  symlinkSync("service.txt", join(x.writer, "link"));
  git(["add", "link"], { cwd: x.writer }); git(["commit", "-qm", "link"], { cwd: x.writer });
  await assert.rejects(service.capture({ ...request, ...actor(), commit: `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`,
    files: ["Dockerfile", "link"] }));
});

test("image preparation reuses fixed inputs and recovers a lost reply without rebuilding or selecting a default", async t => {
  const x = await codeWorkspaceFixture(t);
  git(["remote", "set-url", "origin", "ssh://git@example.test/team/repo"], { cwd: x.writer });
  writeFileSync(join(x.writer, "Dockerfile"), "FROM grounds-base\nCOPY service.txt /service.txt\n");
  git(["add", "Dockerfile"], { cwd: x.writer }); git(["commit", "-qm", "recipe"], { cwd: x.writer });
  const materials = new RepositoryBuildMaterials(x.ledger.store);
  const material = await materials.capture({ ...actor(), repository_id: x.ledger.repository.repository_id, source: x.writer,
    commit: `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`, dockerfile: "Dockerfile", files: ["Dockerfile", "service.txt"] });
  const engine = new BuildEngine(), service = new RepositoryImagePreparations(x.ledger.store, engine);
  const request = { ...actor(), material_id: material.material_id, base_image: `sha256:${"a".repeat(64)}`, data_root: x.dataRoot };
  engine.loseReply = true;
  const uncertain = await service.prepare(request);
  assert.equal(uncertain.state, "needs-recovery");
  engine.images.clear();
  assert.equal((await service.prepare(request)).state, "needs-recovery");
  assert.equal(engine.calls, 1, "absence is not permission to redispatch an unknown build");
  engine.images.set(request.operation_id, `sha256:${"1".repeat(64)}`);
  await assert.rejects(service.prepare({ ...request, ...actor() }), /unresolved/);
  const environments = new RepositoryEnvironments(x.ledger.store);
  await assert.rejects(environments.save({ ...actor(), environment_id: actor().operation_id, repository_id: material.repository_id,
    expected_version: 0, configuration: { name: "dev", image: `sha256:${"1".repeat(64)}`, preparation_id: uncertain.preparation_id } }));
  engine.id = "other-engine";
  await assert.rejects(service.prepare(request));
  engine.id = "builder-one";
  const ready = await service.prepare(request);
  assert.equal(ready.state, "ready"); assert.equal(engine.calls, 1);
  assert.deepEqual(await service.show(ready.preparation_id), ready);
  const reused = await service.prepare({ ...request, ...actor() });
  assert.equal(reused.image, ready.image); assert.equal(reused.reused, true); assert.equal(engine.calls, 1);
  writeFileSync(join(x.writer, "unrelated.txt"), "business code is not a selected build input\n");
  git(["add", "unrelated.txt"], { cwd: x.writer }); git(["commit", "-qm", "unrelated code"], { cwd: x.writer });
  const recapture = () => materials.capture({ ...actor(), repository_id: material.repository_id, source: x.writer,
    commit: `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`, dockerfile: "Dockerfile", files: ["Dockerfile", "service.txt"] });
  const sameInputs = await recapture();
  assert.notEqual(sameInputs.commit, material.commit); assert.equal(sameInputs.digest, material.digest);
  assert.equal((await service.prepare({ ...request, ...actor(), material_id: sameInputs.material_id })).reused, true);
  assert.equal(engine.calls, 1);
  const version = await environments.save({ ...actor(), environment_id: actor().operation_id, repository_id: material.repository_id,
    expected_version: 0, configuration: { name: "dev", image: ready.image!, preparation_id: ready.preparation_id } });
  assert.equal(version.configuration.preparation_id, ready.preparation_id);
  await assert.rejects(environments.default(material.repository_id), { code: "NOT_FOUND" });
  await assert.rejects(environments.save({ ...actor(), environment_id: version.environment_id, repository_id: material.repository_id,
    expected_version: 1, configuration: { ...version.configuration, image: `sha256:${"f".repeat(64)}` } }));
  assert.deepEqual(await service.prepare(request), ready);
  await assert.rejects(service.prepare({ ...request, base_image: `sha256:${"b".repeat(64)}` }));
  engine.images.clear(); engine.loseReply = false;
  const rebuilt = await service.prepare({ ...request, ...actor() });
  assert.equal(rebuilt.reused, false); assert.equal(engine.calls, 2);
  writeFileSync(join(x.writer, "service.txt"), "selected input changed\n");
  git(["add", "service.txt"], { cwd: x.writer }); git(["commit", "-qm", "build input change"], { cwd: x.writer });
  const changed = await recapture();
  assert.notEqual(changed.digest, material.digest);
  assert.equal((await service.prepare({ ...request, ...actor(), material_id: changed.material_id })).reused, false);
  assert.equal(engine.calls, 3);
  assert.deepEqual((await x.ledger.store.inspectIntegrity()).report, { valid: true, issues: [] });
});

test("a missing base before build intent can be repaired with the original request", async t => {
  const x = await codeWorkspaceFixture(t);
  git(["remote", "set-url", "origin", "ssh://git@example.test/team/repo"], { cwd: x.writer });
  writeFileSync(join(x.writer, "Dockerfile"), "FROM grounds-base\n");
  git(["add", "Dockerfile"], { cwd: x.writer }); git(["commit", "-qm", "recipe"], { cwd: x.writer });
  const materials = new RepositoryBuildMaterials(x.ledger.store);
  const material = await materials.capture({ ...actor(), repository_id: x.ledger.repository.repository_id, source: x.writer,
    commit: `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`, dockerfile: "Dockerfile", files: ["Dockerfile"] });
  const engine = new BuildEngine(), service = new RepositoryImagePreparations(x.ledger.store, engine);
  const request = { ...actor(), material_id: material.material_id, base_image: `sha256:${"a".repeat(64)}`, data_root: x.dataRoot };
  engine.baseMissing = true;
  assert.equal((await service.prepare(request)).state, "blocked"); assert.equal(engine.calls, 0);
  engine.baseMissing = false;
  assert.equal((await service.prepare(request)).state, "ready"); assert.equal(engine.calls, 1);
});

test("material capture rejects mutable bases, external build inputs and a foreign repository", async t => {
  const x = await codeWorkspaceFixture(t);
  git(["remote", "set-url", "origin", "ssh://git@example.test/team/repo"], { cwd: x.writer });
  const service = new RepositoryBuildMaterials(x.ledger.store);
  for (const recipe of ["FROM alpine:latest\n", "# syntax=remote/frontend\nFROM grounds-base\n",
    "FROM grounds-base\nADD https://example.invalid/script /script\n", "FROM grounds-base\nFROM other\n",
    "FROM grounds-base\nRUN --mount=type=ssh true\n"]) {
    writeFileSync(join(x.writer, "Dockerfile"), recipe);
    git(["add", "Dockerfile"], { cwd: x.writer }); git(["commit", "-qm", "unsupported recipe"], { cwd: x.writer });
    await assert.rejects(service.capture({ ...actor(), repository_id: x.ledger.repository.repository_id, source: x.writer,
      commit: `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`, dockerfile: "Dockerfile", files: ["Dockerfile"] }), { code: "VALIDATION_ERROR" });
  }
  const foreign = await x.ledger.module.registerRepository({ ...actor(), canonical_remote: "ssh://git@example.test/team/foreign" });
  await assert.rejects(service.capture({ ...actor(), repository_id: foreign.result.repository_id, source: x.writer,
    commit: x.firstCommit, dockerfile: "service.txt", files: ["service.txt"] }), /another repository/);
});

test("image commands expose help and reject malformed material requests as validation errors", async t => {
  for (const action of ["build-material-capture", "build-material-show", "image-prepare", "image-show", "image-cancel", "image-cleanup"]) {
    const lines: string[] = [];
    assert.equal(await runCLI(["code-workspace", action, "--help", "--json"], { stdout: line => lines.push(line), stderr: () => {} }), 0);
    assertContract("cli-envelope.schema.json", JSON.parse(lines.join("\n")));
  }
  const x = await codeWorkspaceFixture(t), config = join(x.root, "config.json"), file = join(x.root, "bad.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  writeFileSync(file, "{");
  const lines: string[] = [];
  await runCLI(["code-workspace", "build-material-capture", x.ledger.repository.repository_id, "--directory", x.writer,
    "--file", file, "--operation-id", actor().operation_id, "--agent-id", "fixture", "--agent-name", "Fixture", "--config", config, "--json"],
  { stdout: line => lines.push(line), stderr: () => {} });
  const envelope = JSON.parse(lines.join("\n"));
  assert.equal(envelope.error.code, "VALIDATION_ERROR"); assertContract("cli-envelope.schema.json", envelope);
});

async function imageFixture(t: Parameters<typeof codeWorkspaceFixture>[0]) {
  const x = await codeWorkspaceFixture(t);
  git(["remote", "set-url", "origin", "ssh://git@example.test/team/repo"], { cwd: x.writer });
  writeFileSync(join(x.writer, "Dockerfile"), "FROM grounds-base\nCOPY service.txt /service.txt\n");
  git(["add", "Dockerfile"], { cwd: x.writer }); git(["commit", "-qm", "recipe"], { cwd: x.writer });
  const material = await new RepositoryBuildMaterials(x.ledger.store).capture({ ...actor(), repository_id: x.ledger.repository.repository_id,
    source: x.writer, commit: `sha1:${git(["rev-parse", "HEAD"], { cwd: x.writer })}`, dockerfile: "Dockerfile", files: ["Dockerfile", "service.txt"] });
  const engine = new BuildEngine(), service = new RepositoryImagePreparations(x.ledger.store, engine);
  return { ...x, material, engine, service, request: { ...actor(), material_id: material.material_id,
    base_image: `sha256:${"a".repeat(64)}`, data_root: x.dataRoot } };
}

test("confirmed build failure releases inputs for a new request but never redispatches the failed request", async t => {
  const x = await imageFixture(t);
  x.engine.failed = true;
  const failed = await x.service.prepare(x.request);
  assert.equal(failed.state, "failed");
  x.engine.failed = false;
  assert.deepEqual(await x.service.prepare(x.request), failed);
  assert.equal(x.engine.calls, 1);
  assert.equal((await x.service.prepare({ ...x.request, ...actor() })).state, "ready");
  assert.equal(x.engine.calls, 2);
});

test("cancellation persists while building, retains ownership until completion and never resumes the cancelled request", async t => {
  const x = await imageFixture(t);
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  x.engine.beforeBuild = async () => { enter(); await finished; };
  const running = x.service.prepare(x.request);
  await entered;
  const cancel = { ...actor(), preparation_id: x.request.operation_id };
  try {
    const pending = await x.service.cancel(cancel);
    assert.equal(pending.state, "building"); assert.ok(pending.cancellation);
    await assert.rejects(x.service.prepare({ ...x.request, ...actor() }), /busy/);
  } finally { finish(); }
  const cancelled = await running;
  assert.equal(cancelled.state, "cancelled"); assert.ok(cancelled.image, "a late successful build stays recorded, not silently deleted");
  assert.deepEqual(await x.service.cancel(cancel), cancelled);
  assert.deepEqual(await x.service.prepare(x.request), cancelled);
  assert.equal(x.engine.calls, 1);
  const environments = new RepositoryEnvironments(x.ledger.store);
  await assert.rejects(environments.save({ ...actor(), environment_id: actor().operation_id, repository_id: x.material.repository_id,
    expected_version: 0, configuration: { name: "cancelled", image: cancelled.image!, preparation_id: cancelled.preparation_id } }));
  assert.equal((await x.service.prepare({ ...x.request, ...actor() })).state, "ready");
  assert.equal(x.engine.calls, 2);
  assert.deepEqual((await x.ledger.store.inspectIntegrity()).report, { valid: true, issues: [] });
});

test("cleanup only removes reproducible terminal build inputs, preserves results and rejects added files", async t => {
  const x = await imageFixture(t);
  const ready = await x.service.prepare(x.request);
  const directory = join(x.dataRoot, "runtime", "image-preparations", ready.preparation_id);
  writeFileSync(join(directory, "build.log"), "unique diagnostic\n");
  writeFileSync(join(directory, "context", "extra.txt"), "keep me\n");
  const cleanup = { ...actor(), preparation_id: ready.preparation_id };
  await assert.rejects(x.service.cleanup(cleanup), /unexpected/);
  assert.ok(existsSync(join(directory, "context", "service.txt")));
  await assert.rejects(x.service.cleanup({ ...cleanup, ...actor() }), /original cleanup/);
  unlinkSync(join(directory, "context", "extra.txt"));
  unlinkSync(join(directory, "context", "service.txt")); // A partial earlier removal can be resumed.
  const cleaned = await x.service.cleanup(cleanup);
  assert.equal(cleaned.cleanup?.state, "complete"); assert.equal(cleaned.state, "ready");
  assert.equal(existsSync(join(directory, "context")), false);
  assert.equal(readFileSync(join(directory, "build.log"), "utf8"), "unique diagnostic\n");
  assert.equal(cleaned.image, ready.image);
  mkdirSync(join(directory, "context"));
  writeFileSync(join(directory, "context", "service.txt"), "new content after cleanup\n");
  assert.deepEqual(await x.service.cleanup(cleanup), cleaned);
  assert.equal(readFileSync(join(directory, "context", "service.txt"), "utf8"), "new content after cleanup\n");
  assert.equal((await x.service.prepare({ ...x.request, ...actor() })).reused, true);
  assert.equal(x.engine.calls, 1);
  assert.deepEqual((await x.ledger.store.inspectIntegrity()).report, { valid: true, issues: [] });
});

test("cancelling an unknown build does not authorize cleanup or a replacement build", async t => {
  const x = await imageFixture(t);
  x.engine.loseReply = true;
  await x.service.prepare(x.request); x.engine.images.clear();
  const cancelled = await x.service.cancel({ ...actor(), preparation_id: x.request.operation_id });
  assert.equal(cancelled.state, "needs-recovery"); assert.ok(cancelled.cancellation);
  await assert.rejects(x.service.cleanup({ ...actor(), preparation_id: x.request.operation_id }), /terminal/);
  await assert.rejects(x.service.prepare({ ...x.request, ...actor() }), /unresolved/);
  assert.equal((await x.service.prepare(x.request)).state, "needs-recovery"); assert.equal(x.engine.calls, 1);
});

test("public CLI cancels a blocked preparation before dispatch and cleans it without starting Docker", async t => {
  const x = await imageFixture(t); x.engine.baseMissing = true;
  assert.equal((await x.service.prepare(x.request)).state, "blocked");
  const config = join(x.root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const invoke = async (action: string, id: string) => {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", action, x.request.operation_id, "--operation-id", id,
      "--agent-id", "fixture", "--agent-name", "Fixture", "--config", config, "--json"],
    { stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n"));
    assert.equal(code, 0, JSON.stringify(envelope)); assertContract("cli-envelope.schema.json", envelope);
    return envelope.data.preparation;
  };
  const cancelled = await invoke("image-cancel", actor().operation_id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await x.service.prepare(x.request)).state, "cancelled"); assert.equal(x.engine.calls, 0);
  const cleanupID = actor().operation_id;
  assert.equal((await invoke("image-cleanup", cleanupID)).cleanup.state, "complete");
  assert.equal((await invoke("image-cleanup", cleanupID)).cleanup.state, "complete");
  x.engine.baseMissing = false;
  assert.equal((await x.service.prepare({ ...x.request, ...actor() })).state, "ready");
});


test("image operation integrity rejects command swaps and retains valid no-op cancellation and cleanup", async t => {
  const x = await imageFixture(t);
  x.engine.failed = true;
  await x.service.prepare(x.request);
  const db = new DatabaseSync(x.ledgerPath);
  try {
    for (const command of ["code-workspace.image-cancel", "code-workspace.image-cleanup"]) {
      db.prepare("UPDATE idempotency_records SET command = ? WHERE operation_id = ?").run(command, x.request.operation_id);
      assert.ok((await x.ledger.store.inspectIntegrity()).report.issues.some(item => item.check === "idempotency"
        && item.resource_id === x.request.operation_id), command);
    }
    db.prepare("UPDATE idempotency_records SET command = ? WHERE operation_id = ?").run("code-workspace.image-prepare", x.request.operation_id);
    const preparation_id = x.request.operation_id;
    await x.service.cancel({ ...actor(), preparation_id });
    await x.service.cancel({ ...actor(), preparation_id, attribution: { kind: "agent", agent_id: "another", display_name: "Another" } });
    await x.service.cleanup({ ...actor(), preparation_id });
    await x.service.cleanup({ ...actor(), preparation_id, attribution: { kind: "agent", agent_id: "another", display_name: "Another" } });
    assert.deepEqual((await x.ledger.store.inspectIntegrity()).report, { valid: true, issues: [] });
  } finally { db.close(); }
});
