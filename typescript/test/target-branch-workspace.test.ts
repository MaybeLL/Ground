import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Module } from "../src/module.js";
import { renderContractReview } from "../src/contract-review.js";
import { SQLStore, SCHEMA_VERSION } from "../src/sql-store.js";
import { WorkspaceModule, parseIssueMarkdown, renderIssueMarkdown } from "../src/workspace.js";
import { decodeIssue, validateTargetBranchSpec } from "../src/domain.js";
import { testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";
import { JsonWorkspaceStore } from "../src/workspace-json.js";
import { ledgerOnlyPreflightCoordinator } from "./preflight-fixture.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, json = false) {
  const root = mkdtempSync(join(tmpdir(), "grounds-target-workspace-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("remote", "add", "origin", "ssh://git@example.invalid/team/project");
  writeFileSync(join(root, "file"), "base"); git("add", "file"); git("commit", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const path = join(root, "ledger.db");
  const store = SQLStore.sqlite(path); const metadata = await store.initialize("warn");
  const work = new Module(store, newUUIDv7, undefined, undefined, ledgerOnlyPreflightCoordinator(store));
  const workspace = new WorkspaceModule(work, root, "warn", () => testAgent, metadata.metadata.database_id, undefined, json);
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, work, workspace, git };
}

/**
 * Seed the publish preflight a target declaration needs, binding exactly the
 * declarations the Workspace will write. Call it right before the publish it
 * covers.
 */
async function seedTargetPublish(f: Awaited<ReturnType<typeof fixture>>, name: string): Promise<void> {
  const binding = await f.workspace.pendingPublishBinding(name, f.root);
  if (!binding) throw new Error("no target publish binding to seed");
  const { seedPublishPreflight } = await import("./preflight-fixture.js");
  await seedPublishPreflight(f.store, { canonicalRemote: binding.canonical_remote, target: binding.target, commit: `sha1:${f.git("rev-parse", "HEAD")}`, contentDigest: binding.content_digest });
}

/** Seed a JSON Workspace publish preflight binding the reviewed version digest. */
async function seedJsonTargetPublish(f: Awaited<ReturnType<typeof fixture>>, reviewedVersion: string, target: { remote: string; ref: string }): Promise<void> {
  const oid = `sha1:${f.git("rev-parse", "HEAD")}`;
  const binding = await f.workspace.pendingPublishBinding("json-target", f.root, reviewedVersion);
  assert.ok(binding);
  const canonicalRemote = "ssh://git@example.invalid/team/project";
  const repositoryId = newUUIDv7();
  const now = new Date().toISOString();
  await f.store.write(async (tx) => {
    // The first target publication registers the Repository; the observation is
    // bound by canonical remote so it exists even before registration.
    const ensured = await tx.ensureRepository({ id: repositoryId, canonical_remote: canonicalRemote, version: 1, created_at: now, attribution: testAgent });
    const observationId = newUUIDv7();
    await tx.saveRuntimeRecord({ id: observationId, kind: "runtime_operation", parent_id: ensured.repository.id, version: 1, data: {
      format: "grounds.preflight-observation/v1", phase: "publish", observed_at: now, target, tracking_ref: "",
      observation: { refreshed: true, observed_at: now, commit: { oid, parents: [], tree_oid: oid } },
      binds: { repository_id: ensured.repository.id, canonical_remote: canonicalRemote, scope_digest: reviewedVersion, content_digest: binding.content_digest }, attribution: testAgent,
    } }, 0);
    await tx.saveRuntimeRecord({ id: newUUIDv7(), kind: "runtime_operation", parent_id: observationId, version: 1, data: {
      format: "grounds.preflight-assessment/v1", observation_id: observationId, assessment: "applicable", author: testAgent, rationale: "Fixture", affected: [], assessed_at: now,
      binds: { repository_id: ensured.repository.id, canonical_remote: canonicalRemote, scope_digest: reviewedVersion, content_digest: binding.content_digest }, target_commit: oid,
    } }, 0);
  });
}

test("target declaration round trips, publishes, changes Issue version and preserves old versions", async t => {
  const f = await fixture(t);
  const { path } = await f.workspace.new("target") as { path: string };
  const file = join(path, "issues", "main.md");
  const draft = parseIssueMarkdown(readFileSync(file, "utf8"));
  draft.input.target_branch = { remote: "origin", ref: "refs/heads/main" };
  writeFileSync(file, renderIssueMarkdown(draft.input, draft.baselineExpression));
  assert.deepEqual(parseIssueMarkdown(readFileSync(file, "utf8")).input.target_branch, draft.input.target_branch);
  const dry = await f.workspace.publish("target", f.root, true, false) as any;
  assert.equal(dry.result.issues[0].action, "create");
  await seedTargetPublish(f, "target");
  const published = await f.workspace.publish("target", f.root, false, false) as any;
  const id = published.result.issues[0].id;
  const old = await f.work.showIssue(id);
  assert.deepEqual(old.issue.target_branch, draft.input.target_branch);
  assertContract("query-results.schema.json", old);
  const rendered = await renderContractReview(f.work, { issues: [`${id}@1`], output: join(f.root, "review"), format: "html" });
  assert.match(readFileSync(rendered.path, "utf8"), /目标分支[\s\S]*origin[\s\S]*refs\/heads\/main/);
  const next = parseIssueMarkdown(readFileSync(file, "utf8"));
  next.input.target_branch = { remote: "origin", ref: "refs/heads/release" };
  writeFileSync(file, renderIssueMarkdown(next.input, next.baselineExpression, next.frontmatter.id, next.frontmatter.version));
  await seedTargetPublish(f, "target");
  const revised = await f.workspace.publish("target", f.root, false, false) as any;
  assert.equal(revised.result.requirement.action, "unchanged");
  assert.equal(revised.result.issues[0].version, 2);
  assert.equal((await f.work.showIssue(id)).issue.target_branch?.ref, "refs/heads/release");
  assert.equal((await f.work.showIssueVersion(id, 1)).issue.target_branch?.ref, "refs/heads/main");
  assert.equal((await f.workspace.publish("target", f.root, false, false) as any).result.no_op, true);
});

test("dry-run rejects foreign remote, illegal ref and absence of explicit mapping without publishing", async t => {
  const f = await fixture(t);
  const { path } = await f.workspace.new("bad-target") as { path: string };
  const file = join(path, "issues", "main.md");
  const draft = parseIssueMarkdown(readFileSync(file, "utf8"));
  f.git("remote", "add", "foreign", "https://example.invalid/other/project");
  for (const target of [{ remote: "foreign", ref: "refs/heads/main" }, { remote: "origin", ref: "HEAD" }]) {
    writeFileSync(file, renderIssueMarkdown({ ...draft.input, target_branch: target }, draft.baselineExpression));
    await assert.rejects(f.workspace.publish("bad-target", f.root, true, false));
  }
  f.git("config", "remote.origin.fetch", "+refs/heads/only:refs/remotes/origin/only");
  writeFileSync(file, renderIssueMarkdown({ ...draft.input, target_branch: { remote: "origin", ref: "refs/heads/main" } }, draft.baselineExpression));
  await assert.rejects(f.workspace.publish("bad-target", f.root, false, false));
});

test("schema18 migration is additive and preserves a historical Issue with no target", async t => {
  const f = await fixture(t);
  await f.workspace.new("historical");
  const published = await f.workspace.publish("historical", f.root, false, false) as any;
  const id = published.result.issues[0].id;
  const before = await f.work.showIssue(id);
  const raw = new DatabaseSync(f.path);
  raw.exec(`DROP TABLE issue_target_branches; DROP TABLE candidate_bases; DROP TABLE dev_run_bases; UPDATE schema_metadata SET schema_version=18; DELETE FROM schema_migrations WHERE schema_version=${SCHEMA_VERSION}`);
  raw.close();
  assert.equal((await f.store.inspectIntegrity()).report.valid, true);
  assert.equal((await f.store.migrate()).schema_version, SCHEMA_VERSION);
  assert.deepEqual(await f.work.showIssue(id), before);
  assert.equal((await f.store.migrate()).schema_version, SCHEMA_VERSION);
});

test("failed target schema migration rolls back the new table and can be retried", async t => {
  const f = await fixture(t);
  const raw = new DatabaseSync(f.path);
  try {
    raw.exec(`DROP TABLE issue_target_branches; DROP TABLE candidate_bases; DROP TABLE dev_run_bases; UPDATE schema_metadata SET schema_version=18;
      DELETE FROM schema_migrations WHERE schema_version=${SCHEMA_VERSION};
      CREATE TRIGGER fail_target_migration BEFORE UPDATE OF schema_version ON schema_metadata
      WHEN NEW.schema_version=${SCHEMA_VERSION} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    await assert.rejects(f.store.migrate());
    assert.equal(raw.prepare("SELECT schema_version FROM schema_metadata").get()!.schema_version, 18);
    assert.equal(raw.prepare("SELECT migration_state FROM schema_metadata").get()!.migration_state, "clean");
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='issue_target_branches'").get(), undefined);
    raw.exec("DROP TRIGGER fail_target_migration");
    assert.equal((await f.store.migrate()).schema_version, SCHEMA_VERSION);
  } finally { raw.close(); }
});

test("persisted malformed target is rejected instead of being treated as a historical Issue", async t => {
  const f = await fixture(t);
  const { path } = await f.workspace.new("corrupt-target") as { path: string };
  const file = join(path, "issues", "main.md");
  const draft = parseIssueMarkdown(readFileSync(file, "utf8"));
  writeFileSync(file, renderIssueMarkdown({ ...draft.input, target_branch: { remote: "origin", ref: "refs/heads/main" } }, draft.baselineExpression));
  await seedTargetPublish(f, "corrupt-target");
  const published = await f.workspace.publish("corrupt-target", f.root, false, false) as any;
  const raw = new DatabaseSync(f.path);
  try { raw.exec("UPDATE issue_target_branches SET branch_ref='HEAD'"); } finally { raw.close(); }
  await assert.rejects(f.work.showIssue(published.result.issues[0].id), { code: "ARTIFACT_INTEGRITY_ERROR" });
  assert.equal((await f.store.inspectIntegrity()).report.valid, false);
});

test("JSON target survives save/publication/revision with CAS and rejects foreign remotes", async t => {
  const f = await fixture(t, true);
  const { path } = await f.workspace.new("json-target") as { path: string };
  const local = new JsonWorkspaceStore(path), initial = local.read();
  initial.draft.issues[0]!.input.target_branch = { remote: "origin", ref: "refs/heads/main" };
  const saved = await local.save(initial.draft, initial.version);
  assertContract("authoring-workspace.schema.json", saved.manifest);
  await assert.rejects(local.save(initial.draft, initial.version));
  const publish = (dry: boolean, version: string) => f.workspace.publish("json-target", f.root, dry, false, false, "", undefined, version) as Promise<any>;
  assert.equal((await publish(true, saved.version)).result.issues[0].action, "create");
  await seedJsonTargetPublish(f, saved.version, { remote: "origin", ref: "refs/heads/main" });
  const published = await publish(false, saved.version), id = published.result.issues[0].id;
  assert.equal((await f.work.showIssue(id)).issue.target_branch?.ref, "refs/heads/main");
  const parallel = await f.workspace.openIssue(id, "json-parallel") as { path: string };
  const parallelStore = new JsonWorkspaceStore(parallel.path), parallelDraft = parallelStore.read();
  parallelDraft.draft.issues[0]!.input.summary += " local notes";
  await parallelStore.save(parallelDraft.draft, parallelDraft.version);
  const next = local.read(); next.draft.issues[0]!.input.target_branch!.ref = "refs/heads/release";
  const changed = await local.save(next.draft, next.version);
  await seedJsonTargetPublish(f, changed.version, { remote: "origin", ref: "refs/heads/release" });
  assert.equal((await publish(false, changed.version)).result.issues[0].version, 2);
  assert.equal((await f.work.showIssueVersion(id, 1)).issue.target_branch?.ref, "refs/heads/main");
  await f.workspace.rebase("json-parallel", f.root);
  const rebased = parallelStore.read();
  assert.equal(rebased.draft.issues[0]!.input.target_branch?.ref, "refs/heads/release");
  assert.match(rebased.draft.issues[0]!.input.summary, /local notes$/);
  assertContract("authoring-workspace.schema.json", rebased.manifest);
  const bad = local.read(); f.git("remote", "add", "foreign", "https://example.invalid/foreign/project");
  bad.draft.issues[0]!.input.target_branch!.remote = "foreign";
  const foreign = await local.save(bad.draft, bad.version);
  await assert.rejects(publish(true, foreign.version));
  assert.equal((await f.work.showIssue(id)).issue.version, 2);
});

test("explicit Markdown-to-JSON migration retains a target declaration", async t => {
  const f = await fixture(t);
  const { path } = await f.workspace.new("migrate-target") as { path: string };
  const file = join(path, "issues", "main.md"), draft = parseIssueMarkdown(readFileSync(file, "utf8"));
  draft.input.target_branch = { remote: "origin", ref: "refs/heads/main" };
  writeFileSync(file, renderIssueMarkdown(draft.input, draft.baselineExpression));
  const local = new JsonWorkspaceStore(path);
  await local.migrateLegacy(false);
  assert.deepEqual(local.read().draft.issues[0]!.input.target_branch, draft.input.target_branch);
  assertContract("authoring-workspace.schema.json", local.read().manifest);
});

test("domain and YAML boundaries validate target shape without Git", () => {
  const valid = { remote: "origin", ref: "refs/heads/release/stable" };
  validateTargetBranchSpec(valid);
  for (const ref of ["main", "refs/heads/a..b", "refs/heads/a.lock", "refs/heads/a b", "refs/heads/a\\b", "refs/heads/a@{b", "refs/heads/.hidden"]) {
    assert.throws(() => validateTargetBranchSpec({ ...valid, ref }));
  }
  const value = decodeIssue(Buffer.from("format: 1\nsummary: test\ntarget_branch:\n  remote: origin\n  ref: refs/heads/main\ngoals:\n  - statement: implement\n    criteria: [works]\n"));
  assert.equal(value.target_branch?.ref, "refs/heads/main");
  assertContract("issue.schema.json", value);
});
