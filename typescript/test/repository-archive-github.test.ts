import { test } from "node:test";
import assert from "node:assert/strict";
import { githubArchiveNamespaces, GitHubArchiveClient } from "../src/repository-archive-github.js";
import { RepositoryArchiveAccess, archiveConfigurationGuide } from "../src/repository-archive-access.js";
import { GitLabFailure, type GitLabAPI } from "../src/gitlab-api.js";
import { ARCHIVE_NAMESPACES } from "../src/gitlab-tag-policy.js";
import { normalizeRemote } from "../src/git.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";
const ruleset = () => ({ id: 1, source_type: "Repository", source: "example/project", target: "tag", enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ARCHIVE_NAMESPACES.map(n => n + "*"), exclude: [] } }, rules: [{ type: "update" }, { type: "deletion" }] });
test("GitHub protection covers both namespaces and requires update AND deletion restrictions", () => {
  assert.ok(githubArchiveNamespaces([ruleset()], true).every(n => n.protection === "confirmed" && n.current_user_can_create));
  assert.ok(githubArchiveNamespaces([ruleset()], false).every(n => n.current_user_can_create === false));
  for (const type of ["update", "deletion"]) {
    const rule = ruleset(); rule.rules = [{ type }];
    assert.ok(githubArchiveNamespaces([rule], true).every(n => n.protection === "missing"));
  }
  const partial = ruleset(); partial.conditions.ref_name.include = [ARCHIVE_NAMESPACES[0] + "*"];
  assert.equal(githubArchiveNamespaces([partial], true)[1]!.protection, "missing");
  assert.ok(githubArchiveNamespaces([{ ...ruleset(), enforcement: "evaluate" }], true).every(n => n.protection === "missing"));
});
test("GitHub unknown visibility, bypass, exclusions, restricted creation and push rules fail closed", () => {
  for (const override of [
    { bypass_actors: undefined }, { bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }] },
    { conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/grounds/candidates/secret"] } } },
    { conditions: { ref_name: { include: ["~ALL"], exclude: [] }, future_condition: true } },
    { rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: true } }] },
    { rules: [{ type: "deletion", parameters: { future_exception: true } }] },
    { rules: [{ type: "creation" }] }, { target: "push" }, { target: "future-target" },
    { conditions: { ref_name: { include: ["refs/tags/grounds/*"], exclude: [] } } },
  ]) assert.throws(() => githubArchiveNamespaces([{ ...ruleset(), ...override }], true), GitLabFailure);
});
test("GitHub binding, identity drift, permission loss and post-check rule loss use live GitHub only", async t => {
  const f = await LedgerFixture.create(); t.after(() => f.close());
  const id = (await f.module.registerRepository({ operation_id: newUUIDv7(), canonical_remote: normalizeRemote("git@github.com:example/project.git"), attribution: testAgent })).result.repository_id;
  let projectID = 42, push = true, rules: unknown[] = [ruleset()], failure = false;
  const calls: string[] = [];
  const factory = (): GitLabAPI => ({ observations: [], async get(path) {
    calls.push(path);
    if (failure) throw new GitLabFailure("api_forbidden");
    if (path === "/user") return { id: 7, login: "test-user" };
    if (path === "/repos/example/project") return { id: projectID, full_name: "example/project", html_url: "https://github.com/example/project", archived: false, disabled: false, permissions: { push, pull: true } };
    if (path === "/repos/example/project/rulesets/1") return rules[0];
    throw Error("unexpected path");
  }, async list(path) { assert.equal(path, "/repos/example/project/rulesets?includes_parents=true"); return rules; } });
  const access = new RepositoryArchiveAccess(f.store, () => { throw Error("GitLab must not be called"); }, factory);
  const initial = await access.check(id); assert.equal(initial.state, "unbound"); assert.equal(initial.source, "live_github_api");
  const bound = await access.bind({ repository_id: id, expected_version: 0, operation_id: newUUIDv7(), attribution: testAgent });
  assert.equal(bound.report.state, "ready"); assertContract("repository-archive.schema.json#/$defs/report", bound.report);
  assertContract("repository-archive.schema.json#/$defs/guide", archiveConfigurationGuide(bound.report));
  assert.equal(archiveConfigurationGuide(bound.report).settings_url, "https://github.com/example/project/settings/rules");
  const archive = { repository_id: id, canonical_remote: normalizeRemote("git@github.com:example/project.git"), archive_ref: "refs/tags/grounds/candidates/test", source_commit: "a".repeat(40), ordered_parents: [], result_tree: "b".repeat(40), base_commit: "c".repeat(40) };
  const policy = access.policy();
  const evidence = await policy(archive, new Date().toISOString());
  assert.equal(evidence.source.locator, "https://api.github.com/repos/example/project/rulesets");
  assert.equal(evidence.source.verified_by, "github-user:7@https://github.com");
  assert.equal(evidence.ordinary_identity_cannot_delete, true);
  push = false; assert.equal((await access.check(id)).state, "permission_denied");
  await assert.rejects(policy(archive, new Date().toISOString())); push = true;
  projectID++; assert.equal((await access.check(id)).state, "binding_changed"); projectID--;
  rules = []; assert.equal((await access.check(id)).state, "needs_configuration");
  await assert.rejects(policy(archive, new Date().toISOString()));
  failure = true; const denied = await access.check(id); assert.equal(denied.state, "unknown"); assert.match(denied.recovery.join(), /paid GitHub plan/);
  assert.ok(calls.filter(p => p === "/user").length >= 5);
});
test("GitHub transport uses pinned host, bounded pagination and redacted errors", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let count = 0;
  globalThis.fetch = async (url, init) => { assert.ok(String(url).startsWith("https://api.github.com/repos/example/project/rulesets?")); assert.equal(init?.redirect, "error"); count++; return new Response(JSON.stringify(count === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : []), { status: 200 }); };
  const client = new GitHubArchiveClient(() => "fixture-token");
  assert.equal((await client.list("/repos/example/project/rulesets?includes_parents=true")).length, 100); assert.equal(count, 2);
  globalThis.fetch = async () => new Response("secret transport detail", { status: 403 });
  await assert.rejects(new GitHubArchiveClient(() => "fixture-token").get("/user"), error => error instanceof GitLabFailure && error.message === "api_forbidden");
  await assert.rejects(client.get("//evil.example/user"), GitLabFailure);
});

test("default CLI init/register/bind/check uses isolated SQLite and real GitHub transport wiring", async t => {
  const { runCLI } = await import("../src/cli.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "grounds-github-cli-"));
  const original = globalThis.fetch, originalToken = process.env.GROUNDS_GITHUB_TOKEN, originalData = process.env.GROUNDS_DATA_HOME;
  t.after(() => { globalThis.fetch = original; if (originalToken === undefined) delete process.env.GROUNDS_GITHUB_TOKEN; else process.env.GROUNDS_GITHUB_TOKEN = originalToken; if (originalData === undefined) delete process.env.GROUNDS_DATA_HOME; else process.env.GROUNDS_DATA_HOME = originalData; rmSync(root, { recursive: true, force: true }); });
  process.env.GROUNDS_GITHUB_TOKEN = "isolated-fixture-token";
  process.env.GROUNDS_DATA_HOME = join(root, "data");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/Example/Project.git"]);
  let forbidden = false, reads = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer isolated-fixture-token");
    const parsed = new URL(String(url)); assert.equal(parsed.origin, "https://api.github.com"); reads++;
    if (forbidden) return new Response("private details", { status: 403 });
    const path = parsed.pathname.toLowerCase();
    const value = path === "/user" ? { id: 7, login: "test-user" }
      : path === "/repos/example/project" ? { id: 42, full_name: "example/project", html_url: "https://github.com/example/project", archived: false, disabled: false, permissions: { pull: true, push: true } }
      : path === "/repos/example/project/rulesets" ? [ruleset()]
      : path === "/repos/example/project/rulesets/1" ? ruleset() : undefined;
    assert.notEqual(value, undefined, String(url));
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const config = join(root, "config.yaml");
  async function cli(args: string[]) {
    const lines: string[] = [];
    const code = await runCLI([...args, "--config", config, "--json"], { cwd: root, stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n"));
    assert.equal(code, 0, JSON.stringify(envelope)); assert.equal(envelope.ok, true);
    assertContract("cli-envelope.schema.json", envelope);
    return envelope.data;
  }
  await cli(["init", "--driver", "sqlite", "--non-interactive", "--path", join(root, "ledger.db")]);
  const registered = await cli(["repository", "register", "--agent-id", "test", "--agent-name", "Test"]);
  const id = registered.repository_id;
  assert.equal((await cli(["repository", "archive-check", "--repository", id])).projects[0].report.state, "unbound");
  const bound = await cli(["repository", "archive-bind", "--repository", id, "--expected-version", "0", "--agent-id", "test", "--agent-name", "Test"]);
  assert.equal(bound.report.state, "ready");
  const check = await cli(["repository", "archive-check", "--repository", id]); assert.equal(check.projects[0].report.source, "live_github_api"); assert.equal(check.projects[0].report.state, "ready");
  const guide = await cli(["repository", "archive-guide", "--repository", id]); assertContract("command-results.schema.json", guide);
  forbidden = true;
  const denied = await cli(["repository", "archive-check", "--repository", id]); assert.equal(denied.projects[0].report.state, "unknown"); assert.equal(denied.summary.ready, 0);
  assert.ok(reads >= 17);
});
