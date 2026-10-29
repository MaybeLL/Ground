import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonWorkspaceStore,
  JSON_FORMAT,
  type JsonManifest,
  validateJsonDraft,
} from "../src/workspace-json.js";
import {
  renderRequirementMarkdown,
  renderIssueMarkdown,
  parseIssueMarkdown,
} from "../src/workspace-markdown.js";
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "grounds-json-test-"));
  const manifest: JsonManifest = {
    format: JSON_FORMAT,
    name: "test",
    database_id: "db",
    repository_remote: "repo",
    requirement: {},
    issues: [{ key: "main", file: "issues/main.md" }],
    revision: 1,
    draft: {
      requirement: { format: 1, summary: "", outcomes: [] },
      issues: [
        {
          key: "main",
          input: { format: 1, summary: "", goals: [] },
          baselineExpression: "HEAD",
          questions: [],
          assumptions: [],
        },
      ],
    },
  };
  writeFileSync(join(path, ".workspace.json"), JSON.stringify(manifest));
  return { path, store: new JsonWorkspaceStore(path), manifest };
}
test("concurrent writers from one version yield one winner and preserve loser input", async () => {
  const { path, store } = fixture();
  try {
    const before = store.read();
    const a = structuredClone(before.draft);
    a.requirement.summary = "A";
    const b = structuredClone(before.draft);
    b.requirement.summary = "B";
    const results = await Promise.allSettled([
      store.save(a, before.version),
      new JsonWorkspaceStore(path).save(b, before.version),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(store.read().manifest.revision, 2);
    assert.equal(b.requirement.summary, "B");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("CAS notices raw external edits even with unchanged revision, and pending blocks saves", async () => {
  const { path, store } = fixture();
  try {
    const before = store.read();
    writeFileSync(
      join(path, ".workspace.json"),
      JSON.stringify(before.manifest, null, 2),
    );
    await assert.rejects(store.save(before.draft, before.version), {
      code: "VERSION_CONFLICT",
    });
    const current = store.read();
    writeFileSync(join(path, ".pending-publication.json"), "{}");
    await assert.rejects(store.save(current.draft, current.version), {
      code: "STATE_CONFLICT",
    });
    assert.equal(store.read().version, current.version);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("structural validation permits incomplete drafts but rejects managed and nested unknown fields", () => {
  const { path, store } = fixture();
  try {
    const draft = store.read().draft;
    validateJsonDraft(draft);
    assert.throws(() => validateJsonDraft({ ...draft, database_id: "other" }));
    assert.throws(() =>
      validateJsonDraft({
        ...draft,
        requirement: { ...draft.requirement, id: "fake" },
      }),
    );
    assert.throws(() =>
      validateJsonDraft({
        ...draft,
        issues: [
          {
            ...draft.issues[0],
            input: {
              format: 1,
              summary: "",
              goals: [{ statement: "", criteria: [], id: "fake" }],
            },
          },
        ],
      }),
    );
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("explicit migration preserves semantic draft, authoritative base, external material and receipt", async () => {
  const { path, manifest } = fixture();
  try {
    const req = { format: 1, summary: "Requirement", outcomes: ["Outcome"] };
    const issue = {
      format: 1,
      summary: "Issue",
      goals: [
        {
          statement: "Goal",
          criteria: ["Criterion"],
          traces_to: [{ type: "outcome" as const, ordinal: 1 }],
        },
      ],
    };
    const old = {
      format: "patchledger.authoring-workspace/v1",
      name: manifest.name,
      database_id: manifest.database_id,
      repository_remote: manifest.repository_remote,
      requirement: { base: req },
      issues: manifest.issues,
    };
    writeFileSync(join(path, ".workspace.json"), JSON.stringify(old));
    mkdirSync(join(path, "issues"));
    mkdirSync(join(path, ".base"));
    writeFileSync(join(path, "requirement.md"), renderRequirementMarkdown(req));
    writeFileSync(
      join(path, "issues/main.md"),
      renderIssueMarkdown(issue, "HEAD"),
    );
    writeFileSync(join(path, ".base/requirement.json"), '{"obsolete":true}');
    writeFileSync(join(path, "external-issues.md"), "external read-only");
    writeFileSync(join(path, "receipt.json"), '{"operation_id":"previous"}');
    const store = new JsonWorkspaceStore(path);
    const dry = await store.migrateLegacy(true);
    assert.equal("dry_run" in dry, true);
    if ("dry_run" in dry) {
      assert.equal(dry.path, path);
      assert.equal(dry.to_format, JSON_FORMAT);
      assert.ok(dry.backup_files.includes(".workspace.json"));
      assert.match(dry.warning, /Stop old CLI/);
      assert.match(dry.warning, /not original Markdown formatting bytes/);
      assert.match(dry.warning, /original text remains in the read-only backup/);
    }
    assert.equal(existsSync(join(path, "requirement.md")), true);
    await store.migrateLegacy();
    const current = store.read();
    assert.deepEqual(current.draft.requirement, req);
    assert.deepEqual(current.manifest.requirement.base, req);
    assert.deepEqual(current.draft.issues[0].input, issue);
    assert.equal(current.manifest.external_issues, "external read-only");
    assert.deepEqual(current.manifest.receipt, { operation_id: "previous" });
    assert.equal(existsSync(join(path, "requirement.md")), false);
    assert.equal(
      readFileSync(
        join(
          path,
          current.manifest.migration!.backup,
          ".base/requirement.json",
        ),
        "utf8",
      ),
      '{"obsolete":true}',
    );
    await store.migrateLegacy();
    assert.equal(store.read().version, current.version);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("symlink manifest is rejected and malformed file remains untouched", () => {
  const { path, store } = fixture();
  try {
    writeFileSync(join(path, ".workspace.json"), "bad");
    assert.throws(() => store.read());
    assert.equal(readFileSync(join(path, ".workspace.json"), "utf8"), "bad");
    rmSync(join(path, ".workspace.json"));
    symlinkSync(join(path, "other"), join(path, ".workspace.json"));
    assert.throws(() => store.read());
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("oversized save is rejected without replacing current manifest", async () => {
  const { path, store } = fixture();
  try {
    const before = store.read();
    const draft = structuredClone(before.draft);
    draft.requirement.context = "a".repeat(17 * 1024 * 1024);
    await assert.rejects(store.save(draft, before.version), {
      code: "VALIDATION_ERROR",
    });
    assert.equal(store.read().version, before.version);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("migration rejects pending publication and managed identity corruption", async () => {
  const { path, manifest } = fixture();
  try {
    writeFileSync(
      join(path, ".workspace.json"),
      JSON.stringify({
        ...manifest,
        format: "patchledger.authoring-workspace/v1",
      }),
    );
    writeFileSync(join(path, ".pending-publication.json"), "{}");
    const store = new JsonWorkspaceStore(path);
    await assert.rejects(store.migrateLegacy(), { code: "VALIDATION_ERROR" });
    assert.equal(
      JSON.parse(readFileSync(join(path, ".workspace.json"), "utf8")).format,
      "patchledger.authoring-workspace/v1",
    );
    writeFileSync(
      join(path, ".workspace.json"),
      JSON.stringify({ ...manifest, requirement: { id: "partial" } }),
    );
    assert.throws(() => store.read(), { code: "VALIDATION_ERROR" });
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("large draft that fits can also backfill its full published base", async () => {
  const { path, store } = fixture();
  try {
    const before = store.read();
    const draft = structuredClone(before.draft);
    draft.requirement.context = "a".repeat(12 * 1024 * 1024);
    const saved = await store.save(draft, before.version);
    const published = await store.update(saved.version, (manifest) => ({
      ...manifest,
      requirement: {
        ...manifest.requirement,
        base: manifest.draft.requirement,
      },
      receipt: { operation_id: "done" },
    }));
    assert.equal(
      published.manifest.requirement.base!.context!.length,
      12 * 1024 * 1024,
    );
    assert.equal(store.read().version, published.version);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("migration preserves published Issue identity after Markdown rename", async () => {
  const { path, manifest } = fixture();
  try {
    const req = { format: 1, summary: "Requirement", outcomes: ["Outcome"] };
    const input = {
      format: 1,
      summary: "Issue",
      goals: [{ statement: "Goal", criteria: ["Criterion"] }],
    };
    const id = "01a12e36-ce92-738e-ba28-6c8de79a9e9a";
    const revision = "01a12e36-ce92-7252-aeb7-951dc26a554b";
    writeFileSync(
      join(path, ".workspace.json"),
      JSON.stringify({
        format: "patchledger.authoring-workspace/v1",
        name: manifest.name,
        database_id: manifest.database_id,
        repository_remote: manifest.repository_remote,
        requirement: {},
        issues: [
          {
            key: "main",
            file: "issues/main.md",
            id,
            revision_id: revision,
            version: 1,
            base: input,
          },
        ],
      }),
    );
    mkdirSync(join(path, "issues"));
    writeFileSync(join(path, "requirement.md"), renderRequirementMarkdown(req));
    writeFileSync(
      join(path, "issues/renamed.md"),
      renderIssueMarkdown(input, "HEAD", id, 1),
    );
    const store = new JsonWorkspaceStore(path);
    await store.migrateLegacy();
    const current = store.read();
    assert.equal(current.manifest.issues[0].id, id);
    assert.equal(current.draft.issues[0].key, "main");
    assert.equal(current.manifest.issues[0].file, "issues/renamed.md");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("migration interrupted after JSON commit resumes backup cleanup", async () => {
  const { path, store, manifest } = fixture();
  try {
    mkdirSync(join(path, "issues"));
    writeFileSync(
      join(path, ".workspace.json"),
      JSON.stringify({
        ...manifest,
        format: "patchledger.authoring-workspace/v1",
        draft: undefined,
        revision: undefined,
      }),
    );
    writeFileSync(
      join(path, "requirement.md"),
      renderRequirementMarkdown({
        format: 1,
        summary: "Requirement",
        outcomes: ["Outcome"],
      }),
    );
    writeFileSync(
      join(path, "issues/main.md"),
      renderIssueMarkdown(
        {
          format: 1,
          summary: "Issue",
          goals: [{ statement: "Goal", criteria: ["Criterion"] }],
        },
        "HEAD",
      ),
    );
    (store as any).finishMigration = () => {
      throw new Error("simulated stop after commit");
    };
    await assert.rejects(store.migrateLegacy(), /simulated stop/);
    assert.equal(
      new JsonWorkspaceStore(path).read().manifest.format,
      JSON_FORMAT,
    );
    assert.equal(existsSync(join(path, "requirement.md")), true);
    const recovered = (await new JsonWorkspaceStore(
      path,
    ).migrateLegacy()) as any;
    assert.equal(existsSync(join(path, "requirement.md")), false);
    assert.equal(
      existsSync(
        join(path, recovered.manifest.migration.backup, "requirement.md"),
      ),
      true,
    );
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("aggregate migration limit rejects many individually valid Markdown files without changing legacy sources", async () => {
  const { path, manifest } = fixture();
  try {
    mkdirSync(join(path, "issues"));
    const input = {
      format: 1,
      summary: "Large valid Issue",
      goals: Array.from({ length: 5 }, (_, i) => ({
        statement: `Goal ${i}`,
        criteria: Array.from(
          { length: 50 },
          (_, j) => `${j}:` + "x".repeat(3990),
        ),
      })),
    };
    const markdown = renderIssueMarkdown(input, "HEAD");
    assert.ok(Buffer.byteLength(markdown) < 2 * 1024 * 1024);
    assert.deepEqual(parseIssueMarkdown(markdown).input, input);
    const entries = Array.from({ length: 18 }, (_, i) => ({
      key: `issue-${i}`,
      file: `issues/issue-${i}.md`,
    }));
    const old = JSON.stringify({
      format: "patchledger.authoring-workspace/v1",
      name: manifest.name,
      database_id: manifest.database_id,
      repository_remote: manifest.repository_remote,
      requirement: {},
      issues: entries,
    });
    writeFileSync(join(path, ".workspace.json"), old);
    const requirement = renderRequirementMarkdown({
      format: 1,
      summary: "Requirement",
      outcomes: ["Outcome"],
    });
    writeFileSync(join(path, "requirement.md"), requirement);
    for (const entry of entries)
      writeFileSync(join(path, entry.file), markdown);
    await assert.rejects(
      new JsonWorkspaceStore(path).migrateLegacy(),
      (error: any) =>
        error.code === "VALIDATION_ERROR" &&
        /32 MiB/.test(error.details.reason),
    );
    assert.equal(readFileSync(join(path, ".workspace.json"), "utf8"), old);
    assert.equal(
      readFileSync(join(path, "requirement.md"), "utf8"),
      requirement,
    );
    for (const entry of entries)
      assert.equal(readFileSync(join(path, entry.file), "utf8"), markdown);
    assert.equal(existsSync(join(path, "legacy")), false);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("failed atomic rename preserves previous complete manifest and never returns a new version", async (t) => {
  const { path, store } = fixture();
  try {
    const before = store.read();
    const bytes = readFileSync(join(path, ".workspace.json"), "utf8");
    const draft = structuredClone(before.draft);
    draft.requirement.summary = "Must not appear on disk";
    t.mock.method(fs, "renameSync", () => {
      throw Object.assign(new Error("simulated disk I/O failure"), {
        code: "EIO",
      });
    });
    syncBuiltinESMExports();
    await assert.rejects(store.save(draft, before.version), { code: "EIO" });
    assert.equal(readFileSync(join(path, ".workspace.json"), "utf8"), bytes);
    assert.equal(store.read().version, before.version);
    assert.equal(store.read().draft.requirement.summary, "");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(path, { recursive: true, force: true });
  }
});

test("separate processes racing the same CAS version commit exactly one draft", async () => {
  const { path, store } = fixture();
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const before = store.read();
    const moduleURL = new URL("../src/workspace-json.ts", import.meta.url).href;
    const start = (summary: string) => {
      const script = `import { JsonWorkspaceStore } from ${JSON.stringify(moduleURL)}; const store=new JsonWorkspaceStore(process.argv[1]); const draft=store.read().draft; draft.requirement.summary=process.argv[3]; console.log('ready'); await new Promise(resolve=>process.stdin.once('data',resolve)); try { const value=await store.save(draft,process.argv[2]); console.log(JSON.stringify({ok:true,version:value.version})); } catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); }`;
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
          path,
          before.version,
          summary,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      children.push(child);
      let output = "";
      let errors = "";
      let readyResolve!: () => void;
      let readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      child.stdout!.on("data", (bytes) => {
        output += bytes;
        if (output.includes("ready\n")) readyResolve();
      });
      child.stderr!.on("data", (bytes) => {
        errors += bytes;
      });
      const result = new Promise<any>((resolve, reject) => {
        child.on("error", (error) => {
          readyReject(error);
          reject(error);
        });
        child.on("close", (code) => {
          if (code !== 0) {
            const error = new Error(`child exited ${code}: ${errors}`);
            readyReject(error);
            reject(error);
          } else {
            try {
              resolve(JSON.parse(output.trim().split("\n").at(-1)!));
            } catch (error) {
              reject(error);
            }
          }
        });
      });
      return { child, ready, result };
    };
    const left = start("Process A");
    const right = start("Process B");
    await Promise.all([left.ready, right.ready]);
    left.child.stdin!.end("go");
    right.child.stdin!.end("go");
    const results = await Promise.all([left.result, right.result]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(
      results.filter((result) => result.code === "VERSION_CONFLICT").length,
      1,
    );
    assert.equal(store.read().manifest.revision, before.manifest.revision + 1);
    assert.ok(
      ["Process A", "Process B"].includes(
        store.read().draft.requirement.summary,
      ),
    );
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(path, { recursive: true, force: true });
  }
});

test("corrupt authoritative managed sources block legacy migration and v2 reads without mutation", async () => {
  const corruptions: [string, (manifest: JsonManifest) => void][] = [
    ["Requirement base", m => { (m.requirement as any).base = { format: 1, summary: 123, outcomes: "invalid" }; }],
    ["Issue base", m => { (m.issues[0] as any).base = { format: 1, summary: "Issue", goals: [{ statement: "goal", criteria: "invalid" }] }; }],
    ["Requirement metadata", m => { (m as any).requirement = []; }],
    ["Issue metadata", m => { (m as any).issues[0] = null; }],
    ["Requirement policy", m => { (m.requirement as any).require_current = "yes"; }],
    ["Baseline OID", m => { (m.issues[0] as any).baseline = { git_oid: "HEAD", reachability: "remote_tracking_reachable" }; }],
    ["Baseline reachability", m => { (m.issues[0] as any).baseline = { git_oid: "sha1:" + "a".repeat(40), reachability: "unknown" }; }],
    ["Baseline warning", m => { (m.issues[0] as any).baseline = { git_oid: "sha1:" + "a".repeat(40), reachability: "unconfirmed", warning: 123 }; }],
    ["Baseline unknown field", m => { (m.issues[0] as any).baseline = { git_oid: "sha1:" + "a".repeat(40), reachability: "remote_tracking_reachable", extra: true }; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const { path, manifest } = fixture();
    try {
      mkdirSync(join(path, "issues"));
      const requirement = renderRequirementMarkdown({ format: 1, summary: "Requirement", outcomes: ["Outcome"] });
      const issue = renderIssueMarkdown({ format: 1, summary: "Issue", goals: [{ statement: "Goal", criteria: ["Criterion"] }] }, "HEAD");
      writeFileSync(join(path, "requirement.md"), requirement); writeFileSync(join(path, "issues/main.md"), issue);
      corrupt(manifest);
      const legacy = JSON.stringify({ ...manifest, format: "patchledger.authoring-workspace/v1", draft: undefined, revision: undefined });
      writeFileSync(join(path, ".workspace.json"), legacy);
      const store = new JsonWorkspaceStore(path);
      for (const dryRun of [true, false]) await assert.rejects(store.migrateLegacy(dryRun), { code: "VALIDATION_ERROR" }, `${label}: migration must reject`);
      assert.equal(readFileSync(join(path, ".workspace.json"), "utf8"), legacy, label);
      assert.equal(readFileSync(join(path, "requirement.md"), "utf8"), requirement, label);
      assert.equal(readFileSync(join(path, "issues/main.md"), "utf8"), issue, label);
      assert.equal(existsSync(join(path, "legacy")), false, label);
      const v2 = JSON.stringify(manifest); writeFileSync(join(path, ".workspace.json"), v2);
      assert.throws(() => store.read(), { code: "VALIDATION_ERROR" }, `${label}: read must reject`);
      assert.equal(readFileSync(join(path, ".workspace.json"), "utf8"), v2, label);
    } finally { rmSync(path, { recursive: true, force: true }); }
  }
});

test("unresolved rebase conflicts block ordinary saves after CAS until explicit resolution", async () => {
  const { path, store, manifest } = fixture();
  try {
    const original = store.read();
    manifest.conflicts = [{ field: "requirement.summary", local: "local", remote: "remote" }];
    writeFileSync(join(path, ".workspace.json"), JSON.stringify(manifest));
    const current = store.read(), bytes = readFileSync(join(path, ".workspace.json"));
    const input = structuredClone(current.draft); input.requirement.summary = "Resolved content";
    const unchanged = structuredClone(input);
    await assert.rejects(store.save(input, original.version), { code: "VERSION_CONFLICT" });
    await assert.rejects(store.save(input, current.version), (e: any) => e.code === "STATE_CONFLICT" && /workspace resolve/.test(e.message));
    assert.deepEqual(readFileSync(join(path, ".workspace.json")), bytes);
    assert.equal(store.read().version, current.version);
    assert.deepEqual(input, unchanged);
    writeFileSync(join(path, ".pending-publication.json"), "{}");
    await assert.rejects(store.resolve(input, current.version), { code: "STATE_CONFLICT" });
    assert.deepEqual(readFileSync(join(path, ".workspace.json")), bytes);
    rmSync(join(path, ".pending-publication.json"));
    const resolved = await store.resolve(input, current.version);
    assert.deepEqual(resolved.manifest.conflicts, []);
    assert.equal(resolved.draft.requirement.summary, input.requirement.summary);
    assert.notEqual(resolved.version, current.version);
    const next = structuredClone(resolved.draft); next.requirement.summary = "Normal followup";
    assert.equal((await store.save(next, resolved.version)).draft.requirement.summary, next.requirement.summary);
  } finally { rmSync(path, { recursive: true, force: true }); }
});
