import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, renameSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/env-git.js";
import { codeWorkspaceFixture } from "./code-workspace-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { testAgent } from "./fixture.js";
import { CodeWorkspaces } from "../src/code-workspace.js";

test("two instances share repository history while fetch leaves each materialized baseline fixed", async t => {
  const x = await codeWorkspaceFixture(t);
  const first = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  assert.equal(first.state, "prepared");
  assert.equal(first.baselines[0].commit, x.firstCommit);
  const secondCommit = x.publish("second version\n");
  const second = await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  assert.equal(second.baselines[0].commit, secondCommit);
  assert.equal(readFileSync(join(first.baselines[0].path, "service.txt"), "utf8"), "first version\n");
  assert.equal(readFileSync(join(second.baselines[0].path, "service.txt"), "utf8"), "second version\n");
  const common = (path: string) => git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path });
  assert.equal(common(first.baselines[0].path), common(second.baselines[0].path));
  assert.equal(first.execution_enabled, false, "code preparation does not grant development execution");
});

test("failed materialization retains its chosen commit and resumes without adopting a newer remote", async t => {
  const x = await codeWorkspaceFixture(t), instance = await x.create();
  const destination = join(x.dataRoot, "workspaces", instance.instance_id, "baselines", "orders");
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "keep.txt"), "existing content");
  const request = { instance_id: instance.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  await assert.rejects(x.service.prepareInstance(request));
  const pending = await x.service.instance(instance.instance_id);
  assert.equal(pending.baselines[0]?.commit, x.firstCommit);
  assert.equal(pending.baselines[0]?.materialized, false);
  assert.equal(readFileSync(join(destination, "keep.txt"), "utf8"), "existing content");
  renameSync(destination, destination + "-preserved");
  x.publish("a later commit\n");
  const recovered = await x.service.prepareInstance(request);
  assert.equal(recovered.baselines[0].commit, x.firstCommit);
  assert.equal(recovered.baselines[0].materialized, true);
  assert.equal(readFileSync(join(destination, "service.txt"), "utf8"), "first version\n");
});

test("preparation replay uses fixed input without refetching and refuses to overwrite changed baseline files", async t => {
  const x = await codeWorkspaceFixture(t);
  const request = { instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot };
  const prepared = await x.service.prepareInstance(request);
  x.publish("remote advanced\n");
  renameSync(x.remote, x.remote + ".offline");
  assert.deepEqual(await x.service.prepareInstance(request), prepared);
  writeFileSync(join(prepared.baselines[0].path, "service.txt"), "keep this modification\n");
  await assert.rejects(x.service.prepareInstance(request), { code: "WORKTREE_MISMATCH" });
  assert.equal(readFileSync(join(prepared.baselines[0].path, "service.txt"), "utf8"), "keep this modification\n");
});

test("failed refresh stops by default; explicit cached fallback records that remote freshness is unknown", async t => {
  const x = await codeWorkspaceFixture(t);
  await x.service.prepareInstance({ instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  renameSync(x.remote, x.remote + ".offline");
  const request = { instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot };
  await assert.rejects(x.service.prepareInstance(request), { code: "BASELINE_UNAVAILABLE" });
  assert.deepEqual((await x.service.instance(request.instance_id)).baselines, []);
  const cached = await x.service.prepareInstance({ ...request, allow_cached: true });
  assert.equal(cached.baselines[0].commit, x.firstCommit);
  assert.equal(cached.baselines[0].refresh, "cached");
  assert.equal(cached.execution_enabled, false);
});

test("preparation rejects another host before touching disk and cannot silently relocate an instance", async t => {
  const x = await codeWorkspaceFixture(t), instance = await x.create();
  await assert.rejects(x.service.prepareInstance({ instance_id: instance.instance_id, host_id: newUUIDv7(), data_root: x.dataRoot }), { code: "VALIDATION_ERROR" });
  assert.equal(existsSync(x.dataRoot), false);
  const request = { instance_id: instance.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  await x.service.prepareInstance(request);
  const otherRoot = join(x.root, "other-data");
  await assert.rejects(x.service.prepareInstance({ ...request, data_root: otherRoot }), { code: "VALIDATION_ERROR" });
  assert.equal(existsSync(otherRoot), false);
});

test("an unacknowledged successful Git checkout is recognized on retry without recreating or resetting it", async t => {
  const x = await codeWorkspaceFixture(t), instance = await x.create();
  const request = { instance_id: instance.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  const restore = x.failAfterGit("add");
  await assert.rejects(x.service.prepareInstance(request));
  restore();
  const pending = await x.service.instance(instance.instance_id);
  assert.equal(pending.baselines[0].materialized, false);
  assert.equal(readFileSync(join(pending.baselines[0].path, "service.txt"), "utf8"), "first version\n");
  const recovered = await x.service.prepareInstance(request);
  assert.equal(recovered.state, "prepared");
  assert.equal(recovered.baselines[0].commit, x.firstCommit);
});

test("a Git pin written before SQL acknowledgement retains the original selection on recovery", async t => {
  const x = await codeWorkspaceFixture(t), instance = await x.create();
  const request = { instance_id: instance.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  const restore = x.failAfterGit("update-ref");
  await assert.rejects(x.service.prepareInstance(request));
  restore();
  assert.equal((await x.service.instance(instance.instance_id)).baselines.length, 0);
  x.publish("advanced during interruption\n");
  const recovered = await x.service.prepareInstance(request);
  assert.equal(recovered.baselines[0].commit, x.firstCommit);
  assert.equal(readFileSync(join(recovered.baselines[0].path, "service.txt"), "utf8"), "first version\n");
});

test("concurrent instances select different branches from one cache without changing each other's files", async t => {
  const x = await codeWorkspaceFixture(t), main = await x.create();
  git(["checkout", "-qb", "release"], { cwd: x.writer });
  const releaseCommit = x.publish("release branch\n");
  const configuration = (await x.service.configuration(x.configurationId)).configuration;
  await x.service.saveConfiguration({ configuration_id: x.configurationId, expected_version: 1, attribution: testAgent,
    configuration: { ...configuration, repositories: [{ ...configuration.repositories[0], revision: { branch: "release" } }] } });
  const release = await x.create(2);
  const results = await Promise.all([main, release].map(instance => x.service.prepareInstance({ instance_id: instance.instance_id, host_id: x.hostId, data_root: x.dataRoot })));
  assert.equal(results[0].baselines[0].commit, x.firstCommit);
  assert.equal(results[1].baselines[0].commit, releaseCommit);
  assert.equal(readFileSync(join(results[0].baselines[0].path, "service.txt"), "utf8"), "first version\n");
  assert.equal(readFileSync(join(results[1].baselines[0].path, "service.txt"), "utf8"), "release branch\n");
});

test("multi-repository preparation reports partial failure and resumes the frozen successful repository", async t => {
  const x = await codeWorkspaceFixture(t);
  const other = await x.ledger.module.registerRepository({ operation_id: newUUIDv7(), attribution: testAgent, canonical_remote: "ssh://git@example.test/team/payments" });
  const secondRemote = join(x.root, "payments.git");
  const configuration = (await x.service.configuration(x.configurationId)).configuration;
  await x.service.saveConfiguration({ configuration_id: x.configurationId, expected_version: 1, attribution: testAgent,
    configuration: { ...configuration, repositories: [...configuration.repositories, { repository_id: other.result.repository_id, alias: "payments", revision: { branch: "main" } }] } });
  const instance = await x.create(2);
  const service = new CodeWorkspaces(x.ledger.store, { repositorySource: repo => repo.id === other.result.repository_id ? secondRemote : x.remote });
  const request = { instance_id: instance.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  await assert.rejects(service.prepareInstance(request), { code: "BASELINE_UNAVAILABLE" });
  const partial = await service.instance(instance.instance_id);
  assert.equal(partial.state, "blocked");
  assert.equal(partial.baselines.length, 1);
  assert.equal(partial.baselines[0].commit, x.firstCommit);
  x.publish("orders advanced\n");
  git(["clone", "--bare", "--", x.remote, secondRemote]);
  const completed = await service.prepareInstance(request);
  assert.equal(completed.state, "prepared");
  assert.equal(completed.baselines.length, 2);
  assert.equal(completed.baselines[0].commit, x.firstCommit);
  assert.equal(readFileSync(join(completed.baselines[1].path, "service.txt"), "utf8"), "orders advanced\n");
});

test("a symlinked cache cannot redirect preparation writes into another repository", async t => {
  const x = await codeWorkspaceFixture(t), instance = await x.create();
  mkdirSync(join(x.dataRoot, "cache", "repos"), { recursive: true });
  symlinkSync(join(x.writer, ".git"), join(x.dataRoot, "cache", "repos", x.ledger.repository.repository_id));
  const before = git(["show-ref"], { cwd: x.writer });
  await assert.rejects(x.service.prepareInstance({ instance_id: instance.instance_id, host_id: x.hostId, data_root: x.dataRoot }), { code: "VALIDATION_ERROR" });
  assert.equal(git(["show-ref"], { cwd: x.writer }), before);
});

test("fixed commit selection keeps the exact commit and rejects tag objects masquerading as commits", async t => {
  const x = await codeWorkspaceFixture(t);
  x.publish("later main\n");
  git(["tag", "-a", "annotated", "-m", "tag object"], { cwd: x.writer });
  git(["push", "-q", "origin", "refs/tags/annotated"], { cwd: x.writer });
  const tag = `sha1:${git(["rev-parse", "refs/tags/annotated"], { cwd: x.writer })}`;
  const configuration = (await x.service.configuration(x.configurationId)).configuration;
  await x.service.saveConfiguration({ configuration_id: x.configurationId, expected_version: 1, attribution: testAgent,
    configuration: { ...configuration, repositories: [{ ...configuration.repositories[0], revision: { commit: x.firstCommit } }] } });
  const fixed = await x.service.prepareInstance({ instance_id: (await x.create(2)).instance_id, host_id: x.hostId, data_root: x.dataRoot });
  assert.equal(fixed.baselines[0].commit, x.firstCommit);
  await x.service.saveConfiguration({ configuration_id: x.configurationId, expected_version: 2, attribution: testAgent,
    configuration: { ...configuration, repositories: [{ ...configuration.repositories[0], revision: { commit: tag } }] } });
  const invalid = await x.create(3);
  await assert.rejects(x.service.prepareInstance({ instance_id: invalid.instance_id, host_id: x.hostId, data_root: x.dataRoot }), { code: "BASELINE_UNAVAILABLE" });
});

test("preparation refuses a worktree whose Git registration points at another directory", async t => {
  const x = await codeWorkspaceFixture(t);
  const request = { instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot };
  const prepared = await x.service.prepareInstance(request);
  const path = prepared.baselines[0].path;
  const administration = git(["rev-parse", "--absolute-git-dir"], { cwd: path });
  writeFileSync(join(administration, "gitdir"), join(x.root, "another-directory", ".git") + "\n");
  await assert.rejects(x.service.prepareInstance(request), { code: "WORKTREE_MISMATCH" });
  assert.equal(readFileSync(join(path, "service.txt"), "utf8"), "first version\n");
});

test("a prepared instance refuses a changed retention ref instead of certifying unprotected input", async t => {
  const x = await codeWorkspaceFixture(t);
  const request = { instance_id: (await x.create()).instance_id, host_id: x.hostId, data_root: x.dataRoot };
  const prepared = await x.service.prepareInstance(request);
  const cache = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: prepared.baselines[0].path });
  const pin = `refs/grounds/workspace-baselines/${prepared.instance_id}/${prepared.baselines[0].repository_id}`;
  git(["update-ref", "-d", pin], { gitDir: cache });
  await assert.rejects(x.service.prepareInstance(request), { code: "WORKTREE_MISMATCH" });
  assert.equal((await x.service.instance(prepared.instance_id)).state, "blocked");
  assert.equal(readFileSync(join(prepared.baselines[0].path, "service.txt"), "utf8"), "first version\n");
});
