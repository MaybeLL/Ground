import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustedGit } from "../src/frozen-checkout.js";
import { previewExternalWorkspace, checkWorkspaceReservation } from "../src/workspace-provider.js";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";

const matches = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error.details ?? {}) + error.message);

async function setup(overlapping = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-external-workspace-"))), project = join(root, "project"), registry = join(root, "registry");
  mkdirSync(project); mkdirSync(registry);
  const f = await LedgerFixture.create();
  const git = (args: string[]) => trustedGit(project, args);
  git(["init", "-q"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.test"]);
  git(["remote", "add", "origin", f.repository.canonical_remote]);
  writeFileSync(join(project, "file.txt"), "baseline\n"); git(["add", "."]); git(["commit", "-qm", "baseline"]);
  const baseline = "sha1:" + git(["rev-parse", "HEAD"]);
  const created = await f.module.createIssue({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: f.requirement.requirement_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, repository_id: f.repository.repository_id,
    baseline: { git_oid: baseline, reachability: "unconfirmed", warning: "fixture", override_reason: "fixture" }, input: { format: 1, summary: "External workspace", goals: [{ statement: "Change", criteria: ["Observable change"], traces_to: [{ type: "outcome", ordinal: 1 }] }] } });
  const database = (await f.store.inspect()).database_id;
  const previousDataHome = process.env.GROUNDS_DATA_HOME;
  if (overlapping) process.env.GROUNDS_DATA_HOME = join(project, ".grounds", "managed-data");
  const manager = new DevWorktreeModule(project, database, newUUIDv7, f.store, registry);
  const input = (digest?: string) => ({ operation_id: newUUIDv7(), repository_id: f.repository.repository_id, issue_revision_id: created.result.issue_revision_id, baseline_oid: baseline,
    external_workspace: { directory: project, remote: f.repository.canonical_remote, ...(digest ? { input_digest: digest } : {}) } });
  const perform = async (id: string, operation: string) => {
    const value = await f.module.startDevRun({ operation_id: operation, attribution: testAgent, dev_run_id: id, issue_id: created.result.issue_id, issue_revision_id: created.result.issue_revision_id, issue_revision_explicit: true, repository_remote_snapshot: f.repository.canonical_remote });
    return { value, dev_run_id: value.result.context.dev_run.id };
  };
  return { root, project, registry, f, database, manager, input, perform, baseline, git,
    close: async () => { if (previousDataHome === undefined) delete process.env.GROUNDS_DATA_HOME; else process.env.GROUNDS_DATA_HOME = previousDataHome; await f.close(); rmSync(root, { recursive: true, force: true }); } };
}
test("external preview preserves HEAD/index and binds the entire selected input", async () => {
  const x = await setup();
  try {
    writeFileSync(join(x.project, "file.txt"), "user input\n");
    const index = x.git(["ls-files", "--stage"]), head = x.git(["rev-parse", "HEAD"]);
    const snapshot = previewExternalWorkspace(x.project, x.baseline, x.f.repository.canonical_remote);
    assert.equal(snapshot.dirty, true); assert.deepEqual(snapshot.changes, ["file.txt"]);
    assert.equal(x.git(["ls-files", "--stage"]), index); assert.equal(x.git(["rev-parse", "HEAD"]), head);
    const rejected = x.input(); await assert.rejects(x.manager.start(rejected, id => x.perform(id, rejected.operation_id)), matches(/explicitly accept/));
    const input = x.input(snapshot.input_digest), run = await x.manager.start(input, id => x.perform(id, input.operation_id));
    assert.equal(run.local_worktree.status, "available");
    assert.equal((run.local_worktree as any).ownership, "external");
    assert.deepEqual((run.local_worktree as any).initial_changes, ["file.txt"]);
    writeFileSync(join(x.project, "file.txt"), "later task change\n");
    const replay = await x.manager.start(input, id => x.perform(id, input.operation_id));
    assert.equal(replay.value.result.context.dev_run.id, run.value.result.context.dev_run.id);
  } finally { await x.close(); }
});
test("external cleanup detaches only owned metadata even with discard-changes", async () => {
  const x = await setup();
  try {
    const input = x.input(), run = await x.manager.start(input, id => x.perform(id, input.operation_id)), id = run.value.result.context.dev_run.id;
    writeFileSync(join(x.project, "later.txt"), "keep me");
    await assert.rejects(x.manager.cleanup(id, "open", true), matches(/state/));
    await x.f.module.abandonDevRun({ operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: id, expected_version: 1 });
    await x.manager.markAbandoned(id);
    const result = await x.manager.cleanup(id, "abandoned", true);
    assert.equal(result.removed, false); assert.equal(result.external_preserved, true);
    assert.equal(readFileSync(join(x.project, "later.txt"), "utf8"), "keep me");
    assert.equal(x.git(["rev-parse", "HEAD"]), x.baseline.slice(5));
    assert.deepEqual(JSON.parse(readFileSync(join(x.registry, "workspace-registry.json"), "utf8")), {});
  } finally { await x.close(); }
});
test("shared workspace reservation fences another DevRun and other runtime roots", async () => {
  const x = await setup();
  try {
    const input = x.input(), run = await x.manager.start(input, id => x.perform(id, input.operation_id));
    const second = new DevWorktreeModule(x.project, x.database, newUUIDv7, x.f.store, x.registry), request = x.input();
    await assert.rejects(second.start(request, id => x.perform(id, request.operation_id)), matches(/overlaps/));
    await checkWorkspaceReservation(x.f.store, x.database, x.registry, x.project, run.value.result.context.dev_run.id);
    await assert.rejects(checkWorkspaceReservation(x.f.store, "different-ledger", x.registry, x.project), matches(/workspace/));
  } finally { await x.close(); }
});
test("pre-SQL failure leaves recoverable lease and never removes source files", async () => {
  const x = await setup();
  try {
    const first = x.input(); await assert.rejects(x.manager.start(first, async () => { throw Error("crash before SQL"); }), matches(/crash/));
    const next = x.input(), run = await x.manager.start(next, id => x.perform(id, next.operation_id));
    assert.equal(run.local_worktree.status, "available"); assert.equal(readFileSync(join(x.project, "file.txt"), "utf8"), "baseline\n");
  } finally { await x.close(); }
});
test("external input rejects mismatched HEAD/remote, credentials and dangling links", async () => {
  const x = await setup();
  try {
    assert.throws(() => previewExternalWorkspace(x.project, "sha1:" + "a".repeat(40), x.f.repository.canonical_remote), matches(/Baseline/));
    assert.throws(() => previewExternalWorkspace(x.project, x.baseline, "ssh://git@example.test/other/repo"), matches(/identity/));
    writeFileSync(join(x.project, ".env"), "synthetic-only");
    assert.throws(() => previewExternalWorkspace(x.project, x.baseline, x.f.repository.canonical_remote), matches(/credential/));
    rmSync(join(x.project, ".env")); symlinkSync("missing", join(x.project, "dangling"));
    assert.throws(() => previewExternalWorkspace(x.project, x.baseline, x.f.repository.canonical_remote), matches(/special/));
  } finally { await x.close(); }
});


for (const drift of ["deleted", "replaced", "head"] as const) test(`external ${drift} is observable and cleanup never recreates or deletes source`, async () => {
  const x = await setup();
  try {
    const anchor = join(x.root, "anchor");
    trustedGit(x.root, ["clone", "--no-hardlinks", x.project, anchor]);
    trustedGit(anchor, ["remote", "set-url", "origin", x.f.repository.canonical_remote]);
    const manager = new DevWorktreeModule(anchor, x.database, newUUIDv7, x.f.store, x.registry);
    const input = x.input(), run = await manager.start(input, id => x.perform(id, input.operation_id)), id = run.value.result.context.dev_run.id;
    if (drift === "deleted") rmSync(x.project, { recursive: true });
    if (drift === "replaced") { renameSync(x.project, join(x.root, "original")); mkdirSync(x.project); writeFileSync(join(x.project, "replacement.txt"), "preserve replacement"); }
    if (drift === "head") { writeFileSync(join(x.project, "file.txt"), "other commit"); x.git(["add", "."]); x.git(["commit", "-qm", "external HEAD drift"]); }
    assert.equal(manager.inspect(id).status, drift === "deleted" ? "missing" : drift === "head" ? "available" : "invalid");
    await x.f.module.abandonDevRun({ operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: id, expected_version: 1 });
    const cleaned = await manager.cleanup(id, "abandoned", true);
    assert.equal(cleaned.external_preserved, true);
    if (drift === "replaced") assert.equal(readFileSync(join(x.project, "replacement.txt"), "utf8"), "preserve replacement");
    if (drift === "head") assert.equal(readFileSync(join(x.project, "file.txt"), "utf8"), "other commit");
    assert.equal(manager.inspect(id).status, "removed");
  } finally { await x.close(); }
});

test("cleanup and start replay never reacquire a released external directory lease", async () => {
  const x = await setup();
  try {
    const input = x.input(), first = await x.manager.start(input, id => x.perform(id, input.operation_id)), id = first.value.result.context.dev_run.id;
    await x.f.module.abandonDevRun({ operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: id, expected_version: 1 });
    await x.manager.cleanup(id, "abandoned", true);
    const restarted = new DevWorktreeModule(x.project, x.database, newUUIDv7, x.f.store, x.registry);
    const replay = await restarted.start(input, run => x.perform(run, input.operation_id));
    assert.equal(replay.local_worktree.status, "removed");
    assert.deepEqual(JSON.parse(readFileSync(join(x.registry, "workspace-registry.json"), "utf8")), {});
    const next = x.input(), second = await restarted.start(next, run => x.perform(run, next.operation_id));
    await restarted.start(input, run => x.perform(run, input.operation_id));
    const leases = JSON.parse(readFileSync(join(x.registry, "workspace-registry.json"), "utf8"));
    assert.deepEqual(Object.keys(leases), [second.value.result.context.dev_run.id]);
  } finally { await x.close(); }
});

for (const first of ["external", "managed"] as const) test(`workspace reservation fences ${first} against the overlapping other start mode before Git/SQL creation`, async () => {
  const x = await setup(true);
  try {
    const ext = x.input(); const { external_workspace: _, ...managed } = x.input();
    const request = first === "external" ? ext : managed;
    await x.manager.start(request, id => x.perform(id, request.operation_id));
    const before = x.git(["worktree", "list", "--porcelain"]);
    let sqlCalled = false;
    const next = first === "external" ? managed : ext;
    await assert.rejects(x.manager.start(next, async id => { sqlCalled = true; return x.perform(id, next.operation_id); }), matches(/overlaps|active or unrecovered/));
    assert.equal(sqlCalled, false);
    assert.equal(x.git(["worktree", "list", "--porcelain"]), before);
  } finally { await x.close(); }
});

test("managed sibling leases stay independent and cleanup cannot reacquire an old owner", async () => {
  const x = await setup(true);
  try {
    const { external_workspace: _, ...a } = x.input(), { external_workspace: __, ...b } = x.input();
    const one = await x.manager.start(a, id => x.perform(id, a.operation_id));
    const two = await x.manager.start(b, id => x.perform(id, b.operation_id));
    const first = one.value.result.context.dev_run.id, second = two.value.result.context.dev_run.id;
    assert.notEqual((one.local_worktree as any).path, (two.local_worktree as any).path);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(x.registry, "workspace-registry.json"), "utf8"))).sort(), [first, second].sort());
    await x.f.module.abandonDevRun({ operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: first, expected_version: 1 });
    await x.manager.cleanup(first, "abandoned", false);
    const replay = await x.manager.start(a, id => x.perform(id, a.operation_id));
    assert.equal(replay.local_worktree.status, "removed");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(x.registry, "workspace-registry.json"), "utf8"))), [second]);
    const ext = x.input();
    await assert.rejects(x.manager.start(ext, id => x.perform(id, ext.operation_id)), matches(/overlaps/));
    await x.f.module.abandonDevRun({ operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: second, expected_version: 1 });
    await x.manager.cleanup(second, "abandoned", false);
    assert.equal((await x.manager.start(ext, id => x.perform(id, ext.operation_id))).local_worktree.status, "available");
  } finally { await x.close(); }
});

test("concurrent start modes publish exactly one overlapping owner", async () => {
  const x = await setup(true);
  try {
    const ext = x.input(), { external_workspace: _, ...managed } = x.input();
    const result = await Promise.allSettled([
      x.manager.start(ext, id => x.perform(id, ext.operation_id)),
      x.manager.start(managed, id => x.perform(id, managed.operation_id)),
    ]);
    assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(result.filter(r => r.status === "rejected").length, 1);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(x.registry, "workspace-registry.json"), "utf8"))).length, 1);
  } finally { await x.close(); }
});

test("managed SQL-committed lost reply retains ownership and idempotent recovery", async () => {
  const x = await setup(true);
  try {
    const { external_workspace: _, ...request } = x.input();
    let committed = "";
    await assert.rejects(x.manager.start(request, async id => {
      await x.perform(id, request.operation_id); committed = id;
      throw Error("reply lost after SQL commit");
    }), /reply lost/);
    const external = x.input();
    await assert.rejects(x.manager.start(external, id => x.perform(id, external.operation_id)), matches(/overlaps/));
    const restarted = new DevWorktreeModule(x.project, x.database, newUUIDv7, x.f.store, x.registry);
    const resumed = await restarted.start(request, id => x.perform(id, request.operation_id));
    assert.equal(resumed.value.result.context.dev_run.id, committed);
    assert.equal(resumed.local_worktree.status, "available");
  } finally { await x.close(); }
});

test("legacy local-only managed caller keeps unknown external ownership fenced", async () => {
  const x = await setup(true);
  try {
    const external = x.input(); await x.manager.start(external, id => x.perform(id, external.operation_id));
    const before = readFileSync(join(x.registry, "workspace-registry.json"), "utf8");
    const legacy = new DevWorktreeModule(x.project, x.database, newUUIDv7, undefined, x.registry);
    const { external_workspace: _, ...request } = x.input();
    await assert.rejects(legacy.start(request, async id => ({ value: id, dev_run_id: id })), matches(/overlaps/));
    assert.equal(readFileSync(join(x.registry, "workspace-registry.json"), "utf8"), before);
  } finally { await x.close(); }
});


test("default data root permits an external checkout and a physically separate managed worktree", async () => {
  const x = await setup();
  try {
    const external = x.input(), { external_workspace: _, ...managed } = x.input();
    const one = await x.manager.start(external, id => x.perform(id, external.operation_id));
    const two = await x.manager.start(managed, id => x.perform(id, managed.operation_id));
    assert.equal(one.local_worktree.status, "available");
    assert.equal(two.local_worktree.status, "available");
    assert.notEqual((one.local_worktree as any).path, (two.local_worktree as any).path);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(x.registry, "workspace-registry.json"), "utf8"))).length, 2);
  } finally { await x.close(); }
});
