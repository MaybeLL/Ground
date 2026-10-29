import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { request } from "node:http";
import { startWorkspaceEditor } from "../src/workspace-editor.js";
import { JSON_FORMAT, JsonWorkspaceStore } from "../src/workspace-json.js";
import { directoryRegistryRoot, withRuntimeLock } from "../src/runtime-files.js";

test("editor protects all APIs and shares optimistic concurrency with Agent storage", async () => {
  const path = mkdtempSync(join(tmpdir(), "grounds-editor-"));
  const draft = {
    requirement: {
      format: 1,
      summary: "<script>alert('unsafe')</script>",
      outcomes: ["Works"],
    },
    issues: [],
  };
  writeFileSync(
    join(path, ".workspace.json"),
    JSON.stringify({
      format: JSON_FORMAT,
      name: "test",
      database_id: "db",
      repository_remote: "example/repo",
      requirement: {},
      issues: [],
      revision: 1,
      draft,
    }),
  );
  const editor = await startWorkspaceEditor(path),
    url = new URL(editor.url),
    origin = url.origin;
  const headers = {
    Authorization: `Bearer ${url.hash.slice(1)}`,
    "Content-Type": "application/json",
  };
  const store = new JsonWorkspaceStore(path);
  try {
    await assert.rejects(withRuntimeLock(directoryRegistryRoot(), "data-layout", async () => undefined));
    for (const route of ["draft", "validate", "save"])
      assert.equal(
        (
          await fetch(`${origin}/api/${route}`, {
            method: route === "draft" ? "GET" : "POST",
            body: route === "draft" ? undefined : "{}",
            headers: { "Content-Type": "application/json" },
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await fetch(`${origin}/api/draft`, {
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await new Promise<number>((resolve) => {
        const req = request(
          `${origin}/api/draft`,
          { headers: { ...headers, Host: "evil.example" } },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.end();
      }),
      403,
    );
    const response = await fetch(`${origin}/api/draft`, { headers });
    assert.equal(response.status, 200);
    const initial = (await response.json()) as { version: string };
    assert.deepEqual(Object.keys(initial).sort(), [
      "bindings",
      "conflicts",
      "currentRequirementIssueKeys",
      "draft",
      "externalIssues",
      "reading",
      "source",
      "version",
    ]);
    assert.equal(
      (
        await fetch(`${origin}/api/publish`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      404,
    );
    const shell = await fetch(origin),
      html = await shell.text();
    assert.ok(!html.includes("alert('unsafe')"));
    assert.ok(!html.includes(url.hash.slice(1)));
    assert.match(
      shell.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    // HTML insertion is limited to escaped, server-rendered reading fragments.
    assert.match(html, /safeFragment/);
    const browser = structuredClone(draft);
    browser.requirement.summary = "Browser saved";
    const firstSave = await fetch(`${origin}/api/save`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        draft: browser,
        expectedVersion: initial.version,
      }),
    });
    assert.equal(firstSave.status, 200, await firstSave.text());
    assert.equal(store.read().draft.requirement?.summary, "Browser saved");
    const current = store.read(),
      agent = structuredClone(current.draft);
    agent.requirement!.summary = "Agent saved";
    await store.save(agent, current.version);
    assert.equal(
      (
        await fetch(`${origin}/api/save`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            draft: browser,
            expectedVersion: initial.version,
          }),
        })
      ).status,
      409,
    );
    assert.equal(store.read().draft.requirement?.summary, "Agent saved");
    assert.equal(
      (
        await fetch(`${origin}/api/save`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            draft: browser,
            expectedVersion: store.read().version,
            database_id: "changed",
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/validate`, {
          method: "POST",
          headers,
          body: JSON.stringify({ draft: agent }),
        })
      ).status,
      200,
    );
  } finally {
    await editor.close();
    await withRuntimeLock(directoryRegistryRoot(), "data-layout", async () => undefined);
    rmSync(path, { recursive: true, force: true });
  }
});

test("save distinguishes pre-rename failure from uncertain post-rename durability", async (t) => {
  const path = mkdtempSync(join(tmpdir(), "grounds-save-fault-"));
  const store = new JsonWorkspaceStore(path);
  store.writeUnlocked({
    format: JSON_FORMAT,
    name: "fault",
    database_id: "fixture",
    repository_remote: "test/repo",
    revision: 1,
    requirement: {},
    issues: [],
    draft: {
      requirement: { format: 1, summary: "before", outcomes: [] },
      issues: [],
    },
  });
  const editor = await startWorkspaceEditor(path);
  const url = new URL(editor.url);
  const headers = {
    Authorization: `Bearer ${url.hash.slice(1)}`,
    "Content-Type": "application/json",
  };
  try {
    for (const failAt of [1, 2]) {
      const before = store.read(),
        draft = structuredClone(before.draft);
      draft.requirement.summary = `write-${failAt}`;
      const original = fs.fsyncSync;
      let calls = 0;
      t.mock.method(fs, "fsyncSync", (fd: number) => {
        if (++calls === failAt)
          throw Object.assign(new Error("injected durability error"), {
            code: "EIO",
          });
        original(fd);
      });
      syncBuiltinESMExports();
      let body: any;
      try {
        const response = await fetch(`${url.origin}/api/save`, {
          method: "POST",
          headers,
          body: JSON.stringify({ draft, expectedVersion: before.version }),
        });
        body = await response.json();
        assert.equal(response.status, 400);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.equal(
        body.commit_state,
        failAt === 1 ? "not_committed" : "unknown",
      );
      assert.equal(
        store.read().draft.requirement.summary,
        failAt === 1
          ? before.draft.requirement.summary
          : draft.requirement.summary,
      );
      if (failAt === 1) assert.equal(store.read().version, before.version);
    }
  } finally {
    await editor.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("HTTP save preserves conflicted draft until explicit store resolution", async () => {
  const path = mkdtempSync(join(tmpdir(), "grounds-editor-conflicts-"));
  const draft = { requirement: { format: 1, summary: "Conflicted original", outcomes: ["Outcome"] }, issues: [] };
  writeFileSync(join(path, ".workspace.json"), JSON.stringify({ format: JSON_FORMAT, name: "test", database_id: "db", repository_remote: "example/repo", requirement: {}, issues: [], revision: 1, conflicts: [{ field: "requirement.summary", local: "local", remote: "remote" }], draft }));
  const store = new JsonWorkspaceStore(path), editor = await startWorkspaceEditor(path), url = new URL(editor.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
  try {
    const before = store.read();
    const input = structuredClone(before.draft); input.requirement.summary = "Pending browser input";
    const unchanged = structuredClone(input);
    const rejected = await fetch(`${url.origin}/api/save`, { method: "POST", headers, body: JSON.stringify({ draft: input, expectedVersion: before.version }) });
    assert.equal(rejected.status, 409);
    const error = await rejected.json() as any;
    assert.equal(error.code, "STATE_CONFLICT");
    assert.equal(error.commit_state, "not_committed");
    assert.match(error.error, /workspace resolve/);
    assert.deepEqual(store.read(), before);
    assert.deepEqual(input, unchanged);
    const actual = await (await fetch(`${url.origin}/api/draft`, { headers })).json() as any;
    assert.equal(actual.version, before.version);
    assert.deepEqual(actual.draft, before.draft);
    assert.equal(actual.conflicts.length, 1);
    const resolved = await store.resolve(input, before.version);
    const next = structuredClone(resolved.draft); next.requirement.summary = "Browser edit after resolution";
    const accepted = await fetch(`${url.origin}/api/save`, { method: "POST", headers, body: JSON.stringify({ draft: next, expectedVersion: resolved.version }) });
    assert.equal(accepted.status, 200, await accepted.text());
    assert.equal(store.read().draft.requirement.summary, next.requirement.summary);
    assert.deepEqual(store.read().manifest.conflicts, []);
  } finally { await editor.close(); rmSync(path, { recursive: true, force: true }); }
});
