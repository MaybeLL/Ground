import assert from "node:assert/strict";
import { test } from "node:test";
import { GitLabClient, resolveGitLabCredential, GitLabFailure } from "../src/gitlab-api.js";
import { ARCHIVE_NAMESPACES, decodeTagRules, evaluateNamespace } from "../src/gitlab-tag-policy.js";
import { archiveConfigurationGuide, RepositoryArchiveAccess } from "../src/repository-archive-access.js";
import { normalizeRemote } from "../src/git.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { defaultTagRules, gitLabAPIFixture } from "./gitlab-api-fixture.js";
import { assertContract } from "./schema-fixture.js";
const developer = { id: 11, username: "developer", access_level: 30 };

test("literal closing brackets remain literal in protected tag rules", () => {
  const rules = decodeTagRules([
    ...defaultTagRules(),
    { name: "release]", create_access_levels: [{ access_level: 40 }] },
    { name: "grounds/candidates/*]", create_access_levels: [{ access_level: 0 }] },
  ]);
  for (const namespace of ARCHIVE_NAMESPACES) {
    const result = evaluateNamespace(namespace, rules, developer);
    assert.equal(result.protection, "confirmed");
    assert.equal(result.current_user_can_create, true);
    assert.equal(result.matches.length, 1, "literal ] must not turn into a glob operator");
  }
});

test("unrelated legal literal rules do not block HTTP checks or project binding", async t => {
  const x = await setup(t); x.actor("maintainer");
  x.api.projects.get("team/repo")!.rules.push({ name: "release]", create_access_levels: [{ access_level: 40 }] });
  const bound = await x.bind(x.ids[0], 0, x.api.instance);
  assert.equal(bound.report.state, "ready");
  assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
  assertContract("command-results.schema.json", bound);
  assert.ok(x.api.transcript.every(item => item.method === "GET" && item.status === 200));
});

test("legacy protected tag group grants use direct membership rather than Developer thresholds", async t => {
  const x = await setup(t); x.actor("maintainer");
  const project = x.api.projects.get("team/repo")!;
  project.rules = [{ name: "grounds/*", create_access_levels: [{ access_level: null, group_id: 9 }] }];
  for (const version of ["14.10.5-ee", "15.11.13-ee", "16.11.10-ee", "17.0.5-ee", "17.1.8-ee"]) {
    x.api.state.version = version;
    for (const [share, level] of [[30, 10], [10, 30], [10, 20]]) {
      project.shared = [{ group_id: 9, group_access_level: share }];
      x.api.state.groups.set("/groups/9/members/12", { id: 12, access_level: level, expires_at: null });
      const report = await x.access.check(x.ids[0]!, x.api.instance);
      assert.equal(report.state, "unbound", `${version}: share ${share}, member ${level}`);
      assert.ok(report.namespaces.every(item => item.current_user_can_create === true && item.developer_can_create === false));
      assertContract("repository-archive.schema.json#/$defs/report", report);
    }
  }
  // Legacy GitLab checks the saved grant's direct group membership even if a
  // project invitation has subsequently been removed; project role is separate.
  project.shared = [];
  assert.equal((await x.access.check(x.ids[0]!, x.api.instance)).state, "unbound");
  x.api.failures.set("/groups/9/members/12", { status: 403 });
  assert.equal((await x.access.check(x.ids[0]!, x.api.instance)).state, "unknown");
  x.api.failures.set("/groups/9/members/12", { status: 404 });
  assert.equal((await x.access.check(x.ids[0]!, x.api.instance)).state, "permission_denied");
  assert.ok(x.api.transcript.every(item => item.method === "GET"));
});

test("GitLab 17.2 and later retain group Developer thresholds across version changes", async t => {
  const x = await setup(t); x.actor("maintainer");
  const project = x.api.projects.get("team/repo")!;
  project.rules = [{ name: "grounds/*", create_access_levels: [{ access_level: null, group_id: 9 }] }];
  for (const version of ["17.2.0-ee", "17.11.0-ee", "18.0.0-ee", "18.4.0-ee", "17.1.8-ee", "17.2.0-ee"]) {
    x.api.state.version = version;
    for (const [share, level] of [[30, 10], [10, 30], [30, 30]]) {
      project.shared = [{ group_id: 9, group_access_level: share }];
      x.api.state.groups.set("/groups/9/members/12", { id: 12, access_level: level, expires_at: null });
      const allowed = version === "17.1.8-ee" || share >= 30 && level >= 30;
      const report = await x.access.check(x.ids[0]!, x.api.instance);
      assert.equal(report.state, allowed ? "unbound" : "permission_denied", `${version}: share ${share}, member ${level}`);
    }
  }
  x.api.state.version = "99.0.0";
  const unknown = await x.access.check(x.ids[0]!, x.api.instance);
  assert.equal(unknown.state, "unknown"); assert.deepEqual(unknown.unknowns, ["unsupported_version"]);
});

test("glob proof covers complete namespaces, exact names and permissive overlaps", () => {
  const namespace = ARCHIVE_NAMESPACES[0];
  const rules = (patterns: [string, number][]) => decodeTagRules(patterns.map(([name, access_level]) => ({ name, create_access_levels: [{ access_level }] })));
  assert.equal(evaluateNamespace(namespace, rules([["grounds/candidates/one", 30]]), developer).protection, "missing");
  assert.equal(evaluateNamespace(namespace, rules([["grounds/candidate*", 30]]), developer).protection, "confirmed");
  const union = evaluateNamespace(namespace, rules([["grounds/*", 40], ["grounds/candidates/*", 0], ["*candidates*", 30]]), developer);
  assert.equal(union.current_user_can_create, true); assert.equal(union.matches.length, 3);
  assert.equal(evaluateNamespace(namespace, rules([["grounds/candidates/*", 40], ["grounds/candidates/one", 30]]), developer).current_user_can_create, false);
  const stronger = evaluateNamespace(namespace, rules([["grounds/candidates/*", 40]]), { ...developer, access_level: 40 });
  assert.equal(stronger.current_user_can_create, true); assert.equal(stronger.default_difference, "stricter_or_custom");
  const partition = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].map(char => [`grounds/candidates/${char}*`, 30] as [string, number]);
  assert.equal(evaluateNamespace(namespace, rules(partition), developer).protection, "confirmed");
  assert.equal(evaluateNamespace(namespace, rules(partition.slice(1)), developer).protection, "missing");
});

test("user/group grants use caller identity without granting all Developers", () => {
  const rules = decodeTagRules([{ name: "grounds/*", create_access_levels: [{ access_level: 40, user_id: 11 }] }]);
  const current = evaluateNamespace(ARCHIVE_NAMESPACES[0], rules, developer);
  assert.equal(current.current_user_can_create, true); assert.equal(current.developer_can_create, false);
  assert.equal(evaluateNamespace(ARCHIVE_NAMESPACES[0], rules, { ...developer, id: 12 }).current_user_can_create, false);
  const group = decodeTagRules([{ name: "grounds/*", create_access_levels: [{ access_level: 40, group_id: 9 }] }]);
  assert.equal(evaluateNamespace(ARCHIVE_NAMESPACES[0], group, developer).current_user_can_create, "unknown");
  assert.equal(evaluateNamespace(ARCHIVE_NAMESPACES[0], group, developer, new Map([[9, true]])).current_user_can_create, true);
  assert.equal(evaluateNamespace(ARCHIVE_NAMESPACES[0], group, developer, new Map([[9, false]])).current_user_can_create, false);
  assert.throws(() => decodeTagRules([{ name: "grounds/*", create_access_levels: [{ access_level: 99 }] }]));
});

test("documented nullable identity grants stay scoped and satisfy the closed contract", () => {
  for (const grant of [{ access_level: null, user_id: 11 }, { access_level: null, group_id: 9 }, { access_level: null, deploy_key_id: 7 }]) {
    const rules = decodeTagRules([{ name: "grounds/*", create_access_levels: [grant] }]);
    assert.deepEqual(rules[0]!.create_access_levels[0], grant);
    assertContract("repository-archive.schema.json#/$defs/grant", grant);
    const result = evaluateNamespace(ARCHIVE_NAMESPACES[0], rules, developer, new Map([[9, true]]));
    assert.equal(result.current_user_can_create, "deploy_key_id" in grant ? false : true);
    assert.equal(result.developer_can_create, false);
  }
  const otherUser = decodeTagRules([{ name: "grounds/*", create_access_levels: [{ access_level: null, user_id: 12 }] }]);
  assert.equal(evaluateNamespace(ARCHIVE_NAMESPACES[0], otherUser, developer).current_user_can_create, false);
  for (const invalid of [{ access_level: null }, { access_level: null, user_id: 11, group_id: 9 }, { access_level: 99, user_id: 11 }]) {
    assert.throws(() => decodeTagRules([{ name: "grounds/*", create_access_levels: [invalid] }]));
    assert.throws(() => assertContract("repository-archive.schema.json#/$defs/grant", invalid));
  }
});

test("Administrator rules are valid without granting ordinary users or poisoning unrelated namespaces", async t => {
  const x = await setup(t), project = x.api.projects.get("team/repo")!;
  const grant = { access_level: 60 };
  assert.deepEqual(decodeTagRules([{ name: "release-*", create_access_levels: [grant] }])[0]!.create_access_levels, [grant]);
  assertContract("repository-archive.schema.json#/$defs/grant", grant);
  x.actor("maintainer"); project.rules.push({ name: "release-*", create_access_levels: [grant] });
  const bound = await x.bind(x.ids[0], 0, x.api.instance);
  assert.equal(bound.report.state, "ready"); assert.equal(bound.report.actor.access_level, 40);
  project.rules = [{ name: "grounds/*", create_access_levels: [grant] }];
  const denied = await x.access.check(x.ids[0]!);
  assert.equal(denied.state, "permission_denied");
  assert.ok(denied.namespaces.every(item => item.current_user_can_create === false && item.developer_can_create === false));
  assertContract("repository-archive.schema.json#/$defs/report", denied);
});

test("effective project membership includes invited groups and higher shared roles", async t => {
  const x = await setup(t);
  for (const [actor, id, level] of [["maintainer", 12, 40], ["developer", 11, 30]] as const) {
    x.actor(actor);
    const project = x.api.projects.get("team/repo")!;
    x.api.failures.set("/projects/team%2Frepo", { body: { id: 101, path_with_namespace: "team/repo", web_url: `${x.api.instance}/team/repo`, archived: false,
      repository_access_level: "enabled", permissions: { project_access: null, group_access: null }, shared_with_groups: [{ group_id: 9, group_access_level: level }] } });
    project.roles[actor] = level;
    const report = await x.access.check(x.ids[0]!, x.api.instance);
    assert.equal(report.actor?.access_level, level); assert.equal(report.state, "unbound");
    assert.ok(report.namespaces.every(item => item.current_user_can_create === true));
    assert.ok(report.requests.some(item => item.path === `/projects/101/members/all/${id}` && item.status === 200));
  }
  // A lower direct role must not hide a higher invited-group role.
  x.actor("maintainer");
  const response = x.api.failures.get("/projects/team%2Frepo")!.body as any;
  response.permissions.project_access = { access_level: 20 };
  x.api.projects.get("team/repo")!.rules = [{ name: "grounds/*", create_access_levels: [{ access_level: 40 }] }];
  const bound = await x.bind(x.ids[0], 0, x.api.instance);
  assert.equal(bound.report.state, "ready"); assert.equal(bound.report.actor.access_level, 40);
});

test("effective membership failures never reuse a direct-role success or another principal", async t => {
  const x = await setup(t); await x.bind(x.ids[0], 0, x.api.instance);
  const path = "/projects/101/members/all/11";
  for (const [failure, reason] of [[{ status: 403 }, "api_forbidden"], [{ status: 404 }, "api_not_found"],
    [{ body: { id: 12, access_level: 40, state: "active" } }, "invalid_response"], [{ body: { id: 11, access_level: 99 } }, "invalid_response"]] as const) {
    x.api.failures.set(path, failure);
    const report = await x.access.check(x.ids[0]!);
    assert.equal(report.state, "unknown"); assert.ok(report.unknowns.includes(reason)); assert.ok(report.recovery.length);
  }
  for (const member of [{ id: 11, access_level: 40, expires_at: "2000-01-01" }, { id: 11, access_level: 40, state: "blocked" }]) {
    x.api.failures.set(path, { body: member });
    const report = await x.access.check(x.ids[0]!);
    assert.equal(report.state, "permission_denied"); assert.equal(report.actor?.access_level, 0);
  }
  x.api.failures.clear(); assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
});

async function setup(t: { after(fn: () => unknown): void }) {
  const api = await gitLabAPIFixture(), other = await gitLabAPIFixture(), f = await LedgerFixture.create();
  t.after(async () => { await api.close(); await other.close(); await f.close(); });
  const ids: string[] = [];
  for (const [instance, path] of [[api.instance, "team/repo"], [api.instance, "other/repo"], [other.instance, "team/repo"]]) {
    const row = await f.module.registerRepository({ operation_id: newUUIDv7(), canonical_remote: normalizeRemote(`${instance}/${path}.git`), attribution: testAgent }); ids.push(row.result.repository_id);
  }
  api.projects.set("other/repo", { id: 102, path: "other/repo", rules: [], roles: { developer: 30, maintainer: 40 } });
  let actor = "developer";
  const access = new RepositoryArchiveAccess(f.store, instance => new GitLabClient(instance, () => ({ token: `fixture-${actor}`, source: "environment" }), 1000));
  const bind = (id = ids[0]!, expected_version = 0, instance?: string, operation_id = newUUIDv7()) => access.bind({ repository_id: id, expected_version, ...(instance ? { instance } : {}), operation_id, attribution: testAgent });
  return { api, other, f, ids, access, bind, actor: (value: string) => { actor = value; } };
}

test("an unrelated nullable custom rule does not block default-role project archival checks", async t => {
  const x = await setup(t), project = x.api.projects.get("team/repo")!;
  project.rules.push({ name: "release-*", create_access_levels: [{ access_level: null, user_id: 12, group_id: null }] });
  const bound = await x.bind(x.ids[0], 0, x.api.instance);
  assert.equal(bound.report.state, "ready");
  assertContract("command-results.schema.json", bound);
  assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
});

test("OAuth and PAT credentials from every supported source use Bearer without exposing tokens", async t => {
  const api = await gitLabAPIFixture(); t.after(() => api.close()); api.state.requireBearer = true;
  for (const source of ["environment", "git-credential", "glab"] as const) {
    const client = new GitLabClient(api.instance, () => ({ token: "fixture-developer", source }));
    const user: any = await client.get("/user");
    assert.equal(user.username, "developer");
    assert.ok(!JSON.stringify(client.observations).includes("fixture-developer"));
  }
  assert.equal(api.transcript.length, 3);
  assert.ok(api.transcript.every(request => request.authentication === "bearer" && !request.private_token_present));
});

test("rebind retains unknown group permission and recovers without rewriting the prior result", async t => {
  const x = await setup(t); x.api.state.version = "18.4.0-ee"; await x.bind(x.ids[0], 0, x.api.instance);
  const project = x.api.projects.get("team/repo")!;
  project.id = 999;
  project.rules = [{ name: "grounds/*", create_access_levels: [{ access_level: 40, group_id: 9 }] }];
  project.shared = [{ group_id: 9, group_access_level: 30 }];
  x.api.failures.set("/groups/9/members/11", { status: 403 });
  const operation = newUUIDv7(), bound = await x.bind(x.ids[0], 1, x.api.instance, operation);
  assert.equal(bound.report.state, "unknown");
  assert.deepEqual(bound.report.unknowns, ["group_create_permission_unknown"]);
  assert.ok(bound.report.namespaces.every(item => item.current_user_can_create === "unknown"));
  assert.ok(bound.report.recovery.length > 0);
  assertContract("command-results.schema.json", bound);
  assert.equal((await x.access.check(x.ids[0]!)).state, bound.report.state);
  x.api.failures.clear(); x.api.state.groups.set("/groups/9/members/11", { id: 11, access_level: 30 });
  assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
  assert.deepEqual(await x.bind(x.ids[0], 1, x.api.instance, operation), bound);
  project.id = 1000; project.shared = [];
  const denied = await x.bind(x.ids[0], 2, x.api.instance);
  assert.equal(denied.report.state, "permission_denied");
  assert.ok(denied.report.recovery.length > 0);
});

test("multiple projects/instances and protocol aliases remain scoped, binding is not authorization", async t => {
  const x = await setup(t);
  const before = await x.access.check(x.ids[0]!, x.api.instance); assert.equal(before.state, "unbound"); assert.equal(before.configuration, "ready");
  await x.bind(x.ids[0], 0, x.api.instance);
  assert.equal((await x.access.status(x.ids[0]!)).authorization, "unknown");
  assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
  assert.equal((await x.access.check(x.ids[1]!, x.api.instance)).state, "needs_configuration");
  assert.equal((await x.access.check(x.ids[2]!, x.other.instance)).state, "unbound");
  await x.bind(x.ids[2], 0, x.other.instance);
  x.other.projects.get("team/repo")!.rules = [];
  assert.equal((await x.access.check(x.ids[2]!)).state, "needs_configuration");
  assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
  const guide = archiveConfigurationGuide(await x.access.check(x.ids[1]!, x.api.instance));
  assert.deepEqual(guide.template.tag_patterns, ["grounds/candidates/*", "grounds/deliveries/*"]);
  assert.ok(guide.namespaces.every(item => item.action === "administrator_review_required" && item.recommended_request_preview.executed === false));
  assert.ok(x.api.transcript.every(item => item.method === "GET"));
});

test("stricter policy, identity changes, namespace drift and explicit recheck never reuse cached success", async t => {
  const x = await setup(t); await x.bind(x.ids[0], 0, x.api.instance);
  const project = x.api.projects.get("team/repo")!;
  project.rules = defaultTagRules().map(rule => ({ ...rule, create_access_levels: [{ access_level: 40, access_level_description: "Maintainers" }] }));
  const denied = await x.access.check(x.ids[0]!); assert.equal(denied.state, "permission_denied"); assert.equal(denied.drift, "changed");
  assert.ok(denied.namespaces.every(item => item.default_difference === "stricter_or_custom"));
  assert.ok(archiveConfigurationGuide(denied).namespaces.every(item => item.action === "preserve_existing_rules"));
  x.actor("maintainer"); assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
  project.rules = [defaultTagRules()[0]!]; assert.equal((await x.access.check(x.ids[0]!)).state, "needs_configuration");
  project.rules = defaultTagRules(); x.actor("developer"); assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
  x.actor("expired"); const invalid = await x.access.check(x.ids[0]!); assert.equal(invalid.state, "unknown"); assert.deepEqual(invalid.unknowns, ["authentication_failed"]);
  assert.ok(!JSON.stringify(invalid).includes("fixture-expired"));
});

test("project recreation/transfer/remote drift require explicit versioned rebind", async t => {
  const x = await setup(t), op = newUUIDv7();
  const first = await x.bind(x.ids[0], 0, x.api.instance, op);
  assertContract("command-results.schema.json", first);
  assert.deepEqual(await x.bind(x.ids[0], 0, x.api.instance, op), first);
  const integrity = await x.f.store.inspectIntegrity();
  assert.equal(integrity.report.valid, true, JSON.stringify(integrity.report));
  x.api.projects.get("team/repo")!.id = 999;
  const changed = await x.access.check(x.ids[0]!); assert.equal(changed.state, "binding_changed"); assert.equal(changed.project_id, 999);
  await assert.rejects(x.bind(x.ids[0], 0, x.api.instance), (error: any) => error.code === "VERSION_CONFLICT");
  await x.bind(x.ids[0], 1, x.api.instance); assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
  const project = x.api.projects.get("team/repo")!; project.path = "moved/repo";
  assert.equal((await x.access.check(x.ids[0]!)).state, "unknown");
});

test("one API check snapshots its principal, enforces read-only requests and does not follow credential redirects", async t => {
  const api = await gitLabAPIFixture(), other = await gitLabAPIFixture(); t.after(async () => { await api.close(); await other.close(); });
  let resolutions = 0;
  const client = new GitLabClient(api.instance, () => ({ token: ++resolutions === 1 ? "fixture-developer" : "fixture-maintainer", source: "environment" }));
  await client.get("/version"); const user: any = await client.get("/user");
  assert.equal(user.username, "developer"); assert.equal(resolutions, 1);
  assert.ok(api.transcript.every(item => item.method === "GET" && item.actor === "developer"));
  assert.ok(client.observations.every(item => item.response_digest?.startsWith("sha256:")));
  api.failures.set("/user", { status: 302, headers: { location: `${other.instance}/api/v4/user` } });
  await assert.rejects(client.get("/user"), (error: any) => error.code === "network_failed");
  assert.equal(other.transcript.length, 0, "redirect target must receive no credential-bearing request");
});

test("expired/invalid group shares cannot supply current creation permission", async t => {
  const x = await setup(t), project = x.api.projects.get("team/repo")!;
  x.api.state.version = "18.4.0-ee";
  project.rules = [{ name: "grounds/*", create_access_levels: [{ access_level: 40, group_id: 9 }] }];
  project.shared = [{ group_id: 9, group_access_level: 30, expires_at: "2000-01-01" }];
  x.api.state.groups.set("/groups/9/members/11", { id: 11, access_level: 30, expires_at: null });
  assert.equal((await x.access.check(x.ids[0]!, x.api.instance)).state, "permission_denied");
  project.shared = [{ group_id: 9, group_access_level: 30, expires_at: "2999-99-99" }];
  assert.equal((await x.access.check(x.ids[0]!, x.api.instance)).state, "unknown");
});

test("403, unsupported versions, timeout, malformed and paginated API replies fail closed and retain actual transcripts", async t => {
  const x = await setup(t); await x.bind(x.ids[0], 0, x.api.instance);
  const path = "/projects/101/protected_tags";
  for (const [failure, expected] of [[{ status: 403 }, "api_forbidden"], [{ status: 500 }, "api_failed"], [{ delay: 2500 }, "timeout"], [{ body: {} }, "invalid_response"]] as const) {
    x.api.failures.set(path, failure);
    const report = await x.access.check(x.ids[0]!); assert.equal(report.state, "unknown"); assert.ok(report.unknowns.includes(expected), JSON.stringify(report));
    assert.ok(report.requests.some(item => item.path.startsWith(path)));
  }
  x.api.failures.clear(); x.api.state.version = "99.0.0";
  assert.deepEqual((await x.access.check(x.ids[0]!)).unknowns, ["unsupported_version"]);
  x.api.state.version = "18.4.0";
  const unrelated = Array.from({ length: 100 }, (_, i) => ({ name: `version-${i}`, create_access_levels: [{ access_level: 40 }] }));
  x.api.projects.get("team/repo")!.rules = [...unrelated, ...defaultTagRules()];
  assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
  assert.ok(x.api.transcript.some(item => item.path.endsWith("page=2") && Array.isArray(item.response)));
  assert.ok(x.api.transcript.every(item => item.method === "GET"));
});

test("direct group grant eligibility is checked against project sharing and current member", async t => {
  const x = await setup(t), project = x.api.projects.get("team/repo")!;
  x.api.state.version = "18.4.0-ee";
  project.rules = [{ name: "grounds/*", create_access_levels: [{ access_level: null, group_id: 9 }] }];
  project.shared = [{ group_id: 9, group_access_level: 30 }];
  x.api.state.groups.set("/groups/9/members/11", { id: 11, access_level: 30, expires_at: null });
  await x.bind(x.ids[0], 0, x.api.instance); assert.equal((await x.access.check(x.ids[0]!)).state, "ready");
  x.api.failures.set("/groups/9/members/11", { status: 403 }); assert.equal((await x.access.check(x.ids[0]!)).state, "unknown");
  x.api.failures.clear(); project.shared = [];
  assert.equal((await x.access.check(x.ids[0]!)).state, "permission_denied");
});

test("explicit environment credential is instance-bound; invalid scope never falls through to another login", () => {
  const original = { token: process.env.GROUNDS_GITLAB_TOKEN, instance: process.env.GROUNDS_GITLAB_INSTANCE };
  try {
    process.env.GROUNDS_GITLAB_TOKEN = "private-test-secret"; process.env.GROUNDS_GITLAB_INSTANCE = "https://one.example";
    assert.equal(resolveGitLabCredential("https://one.example").token, "private-test-secret");
    assert.throws(() => resolveGitLabCredential("https://two.example"), error => error instanceof GitLabFailure && error.code === "credentials_missing");
    delete process.env.GROUNDS_GITLAB_INSTANCE;
    assert.throws(() => resolveGitLabCredential("https://one.example"), GitLabFailure);
  } finally {
    if (original.token === undefined) delete process.env.GROUNDS_GITLAB_TOKEN; else process.env.GROUNDS_GITLAB_TOKEN = original.token;
    if (original.instance === undefined) delete process.env.GROUNDS_GITLAB_INSTANCE; else process.env.GROUNDS_GITLAB_INSTANCE = original.instance;
  }
});
