import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitLabClient, gitLabInstance } from "../src/gitlab-api.js";
import { normalizeRemote } from "../src/git.js";
import { RepositoryArchiveAccess } from "../src/repository-archive-access.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";

// Explicit opt-in ONLY: an administrator prepares a dedicated test project and
// its ACL outside this test. No protection-rule or member-role writes exist here.
test("live dedicated GitLab: Developer create, protected overwrite/delete rejection and explicit Maintainer API delete", {
  skip: process.env.GROUNDS_GITLAB_LIVE_TEST !== "1" ? "No explicitly authorized dedicated GitLab project/credentials; live permissions unverified" : false,
}, async t => {
  const need = (name: string) => { const value = process.env[name]; assert.ok(value, `${name} required for explicitly enabled live test`); return value; };
  const instance = gitLabInstance(need("GROUNDS_TEST_GITLAB_INSTANCE"));
  assert.ok(instance.startsWith("https://"), "live tests require HTTPS");
  const projectPath = need("GROUNDS_TEST_GITLAB_PROJECT"), commit = need("GROUNDS_TEST_GITLAB_COMMIT");
  assert.match(projectPath, /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/); assert.match(commit, /^[a-f0-9]{40}$/);
  const developer = need("GROUNDS_TEST_GITLAB_DEVELOPER_TOKEN"), maintainer = need("GROUNDS_TEST_GITLAB_MAINTAINER_TOKEN");
  const f = await LedgerFixture.create(); t.after(() => f.close());
  const remote = normalizeRemote(`${instance}/${projectPath}.git`);
  const registered = await f.module.registerRepository({ operation_id: newUUIDv7(), canonical_remote: remote, attribution: testAgent });
  let token = developer;
  const access = new RepositoryArchiveAccess(f.store, url => new GitLabClient(url, () => ({ token, source: "environment" })));
  const bound = await access.bind({ repository_id: registered.result.repository_id, instance, expected_version: 0, operation_id: newUUIDv7(), attribution: testAgent });
  assert.equal(bound.report.state, "ready"); assert.equal(bound.report.actor.access_level, 30, "dedicated Developer identity required");
  const projectID = bound.binding.project_id;
  token = maintainer;
  const maintainerReport = await access.check(registered.result.repository_id);
  assert.equal(maintainerReport.state, "ready"); assert.ok(maintainerReport.actor!.access_level >= 40);
  assert.notEqual(maintainerReport.actor!.id, bound.report.actor.id);
  const transcript: { method: string; path: string; status: number; tag?: string; protected?: boolean; commit?: string }[] = [];
  const request = async (method: string, path: string, credential: string, body?: unknown) => {
    const response = await fetch(`${instance}/api/v4${path}`, { method, headers: { "PRIVATE-TOKEN": credential, "Content-Type": "application/json", Connection: "close" }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(15_000) });
    const value = response.ok && response.status !== 204 ? await response.json() as any : undefined;
    if (!response.ok) await response.body?.cancel();
    transcript.push({ method, path, status: response.status, ...(value?.name ? { tag: value.name, protected: value.protected, commit: value.commit?.id } : {}) });
    return { status: response.status, value };
  };
  const root = mkdtempSync(join(tmpdir(), "grounds-gitlab-live-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const askpass = join(root, "askpass.cjs");
  writeFileSync(askpass, `#!${process.execPath}\nprocess.stdout.write(/username/i.test(process.argv[2] || '') ? 'oauth2\\n' : process.env.GROUNDS_TEST_GIT_TOKEN+'\\n');\n`, { mode: 0o700 });
  const git = (...args: string[]) => promisify(execFile)("git", ["-c", "credential.helper=", "-c", "http.followRedirects=false", ...args], { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpass, GROUNDS_TEST_GIT_TOKEN: developer, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  await git("init", "-q"); await git("config", "user.name", "Grounds dedicated permission test"); await git("config", "user.email", "test@example.invalid");
  await git("fetch", "--no-tags", remote, commit); await git("checkout", "--detach", "FETCH_HEAD"); await git("commit", "--allow-empty", "-qm", "Dedicated protected-tag overwrite probe");
  for (const namespace of ["candidates", "deliveries"]) {
    const tag = `grounds/${namespace}/live-${newUUIDv7()}`, path = `/projects/${projectID}/repository/tags/${encodeURIComponent(tag)}`;
    const created = await request("POST", `/projects/${projectID}/repository/tags`, developer, { tag_name: tag, ref: commit });
    assert.equal(created.status, 201); assert.equal(created.value.protected, true);
    try {
      const denied = (error: any) => /protected|not allowed|denied/i.test(String(error.stderr));
      await assert.rejects(git("push", "--force", remote, `HEAD:refs/tags/${tag}`), denied);
      await assert.rejects(git("push", remote, `:refs/tags/${tag}`), denied);
      const apiDelete = await request("DELETE", path, developer); assert.equal(apiDelete.status, 403);
      const retained = await request("GET", path, developer); assert.equal(retained.status, 200); assert.equal(retained.value.commit.id, commit);
    } finally {
      // Only the exact tag created above is eligible for explicit test cleanup.
      const removed = await request("DELETE", path, maintainer); assert.equal(removed.status, 204, `task tag retained: ${tag}`);
    }
  }
  if (process.env.GROUNDS_TEST_GITLAB_TRANSCRIPT) writeFileSync(process.env.GROUNDS_TEST_GITLAB_TRANSCRIPT, JSON.stringify(transcript, null, 2), { mode: 0o600 });
});
