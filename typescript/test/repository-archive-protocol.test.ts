import { test } from "node:test";
import assert from "node:assert/strict";
import { GitLabClient } from "../src/gitlab-api.js";
import { normalizeRemote } from "../src/git.js";
import { newUUIDv7 } from "../src/identity.js";
import { RepositoryArchiveAccess } from "../src/repository-archive-access.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { gitLabAPIFixture } from "./gitlab-api-fixture.js";
import { assertContract } from "./schema-fixture.js";

test("SSH/HTTPS spellings discover the same project; changing stored remote still requires rebind", async t => {
  const api = await gitLabAPIFixture(), f = await LedgerFixture.create(); t.after(async () => { await api.close(); await f.close(); });
  const instance = "https://gitlab-one.example"; api.state.publicInstance = instance;
  const ssh = normalizeRemote("git@gitlab-one.example:team/repo.git"), https = normalizeRemote("https://gitlab-one.example/team/repo.git");
  const registered = await f.module.registerRepository({ operation_id: newUUIDv7(), canonical_remote: ssh, attribution: testAgent });
  const id = registered.result.repository_id;
  assert.equal((await f.module.resolveRepository([https])).id, id);
  const access = new RepositoryArchiveAccess(f.store, selected => {
    assert.equal(selected, instance);
    // A real local API fixture represents this public instance without DNS/TLS or production credentials.
    return new GitLabClient(api.instance, () => ({ token: "fixture-developer", source: "environment" }));
  });
  const bind = (expected_version: number) => access.bind({ repository_id: id, instance, expected_version, operation_id: newUUIDv7(), attribution: testAgent });
  const first = await bind(0); assert.equal(first.binding.project_id, 101); assert.equal(first.report.state, "ready");
  await f.module.moveRepository({ operation_id: newUUIDv7(), repository_id: id, canonical_remote: https, expected_version: 1, attribution: testAgent });
  assert.equal((await access.status(id)).state, "binding_changed"); assert.equal((await access.check(id)).state, "binding_changed");
  const rebound = await bind(1); assert.equal(rebound.binding.project_id, first.binding.project_id); assert.equal(rebound.report.state, "ready");
  assertContract("command-results.schema.json", rebound);
  const ready = structuredClone(rebound.report);
  assert.throws(() => assertContract("repository-archive.schema.json#/$defs/report", { ...ready, namespaces: [ready.namespaces[0], ready.namespaces[0]] }));
  assert.throws(() => assertContract("repository-archive.schema.json#/$defs/binding", { ...rebound.binding, token: "must-never-be-shared" }));
});

test("oversized overlapping policy returns a bounded unknown with recovery and no ACL writes", async t => {
  const api = await gitLabAPIFixture(), f = await LedgerFixture.create(); t.after(async () => { await api.close(); await f.close(); });
  const registered = await f.module.registerRepository({ operation_id: newUUIDv7(), canonical_remote: normalizeRemote(`${api.instance}/team/repo`), attribution: testAgent });
  api.projects.get("team/repo")!.rules = Array.from({ length: 101 }, (_, i) => ({ name: `grounds/candidates/*${i}*`, create_access_levels: [{ access_level: 30 }] }));
  const report = await new RepositoryArchiveAccess(f.store, instance => new GitLabClient(instance, () => ({ token: "fixture-developer", source: "environment" }))).check(registered.result.repository_id, api.instance);
  assert.equal(report.state, "unknown"); assert.deepEqual(report.unknowns, ["policy_too_complex"]); assert.ok(report.recovery.length);
  assert.ok(api.transcript.every(item => item.method === "GET"));
});
