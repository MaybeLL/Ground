import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, linkSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { CodeRouteGit } from "../src/code-route-git.js";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { branchGit } from "../src/development-branch.js";
import { CodeRouteExecutions, type RouteEngine } from "../src/code-route-execution.js";
import { git } from "../src/env-git.js";

test("route staging uses fixed content and attributes without changing the work files or other branches", async t => {
  const x = await executionFixture(t);
  const service = new CodeRouteGit(x.ledger.store, x.route.route_id);
  writeFileSync(join(x.route.path, ".gitattributes"), "*.txt text eol=lf\n");
  writeFileSync(join(x.route.path, "service.txt"), "staged version\r\n");
  const snapshot = await service.snapshot(["service.txt"]);
  writeFileSync(join(x.route.path, "service.txt"), "later working version\n");
  writeFileSync(join(x.route.path, ".gitattributes"), "service.txt working-tree-encoding=UTF-16LE\n");
  const request = { ...actor(), action: "stage" as const, snapshot };
  const result = await service.apply(request);
  assert.equal(result.state, "completed");
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "staged version");
  assert.deepEqual(branchGit(x.route.path, ["show", ":service.txt"]), Buffer.from("staged version\n"));
  assert.equal(readFileSync(join(x.route.path, ".gitattributes"), "utf8"), "service.txt working-tree-encoding=UTF-16LE\n");
  assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "later working version\n");
  assert.equal(git(["rev-parse", "refs/heads/main"], { cwd: x.route.path }), x.firstCommit.split(":")[1]);
  assert.deepEqual(await new CodeRouteGit(x.ledger.store, x.route.route_id).apply(request), result);
  await assert.rejects(service.apply({ ...request, snapshot: { ...snapshot, files: [] } }), { code: "STATE_CONFLICT" });
});

test("unstaging selected literal paths retains other staged entries and all working edits", async t => {
  const x = await executionFixture(t), service = new CodeRouteGit(x.ledger.store, x.route.route_id);
  writeFileSync(join(x.route.path, "service.txt"), "edited\n");
  writeFileSync(join(x.route.path, "[draft].txt"), "draft\n");
  writeFileSync(join(x.route.path, "d.txt"), "keep staged\n");
  await service.apply({ ...actor(), action: "stage", snapshot: await service.snapshot(["service.txt", "[draft].txt", "d.txt"]) });
  const request = { ...actor(), action: "unstage" as const, paths: ["service.txt", "[draft].txt"], snapshot: await service.snapshot([]) };
  await service.apply(request);
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "first version");
  assert.throws(() => git(["--literal-pathspecs", "ls-files", "--error-unmatch", "--", "[draft].txt"], { cwd: x.route.path }));
  assert.equal(git(["show", ":d.txt"], { cwd: x.route.path }), "keep staged");
  assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "edited\n");
  assert.equal(readFileSync(join(x.route.path, "[draft].txt"), "utf8"), "draft\n");
});


test("commit captures only staged content and a lost ref-update reply replays the same commit", async t => {
  const x = await executionFixture(t), service = new CodeRouteGit(x.ledger.store, x.route.route_id);
  writeFileSync(join(x.route.path, "service.txt"), "staged commit\n");
  await service.apply({ ...actor(), action: "stage", snapshot: await service.snapshot(["service.txt"]) });
  writeFileSync(join(x.route.path, "service.txt"), "unstaged work stays\n");
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: x.route.path });
  const hookMarker = join(x.root, "hook-executed");
  mkdirSync(join(common, "hooks"), { recursive: true });
  writeFileSync(join(common, "hooks", "reference-transaction"), `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o700 });
  const request = { ...actor(), action: "commit" as const, snapshot: await service.snapshot([]),
    message: "Implement the issue", author: { name: "Route author", email: "route@example.invalid" } };
  const restore = x.failAfterGit(`refs/heads/${x.route.development.branch}`);
  try { await assert.rejects(service.apply(request), error => !(error instanceof Error && "code" in error && error.code === "VALIDATION_ERROR")); }
  finally { restore(); }
  const head = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  assert.notEqual(head, x.firstCommit.split(":")[1]);
  await assert.rejects(service.abort({ operation_id: request.operation_id, attribution: request.attribution }), { code: "STATE_CONFLICT" });
  await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }), { code: "STATE_CONFLICT" });
  await assert.rejects(service.apply({ ...request, ...actor() }), { code: "STATE_CONFLICT" });
  const result = await new CodeRouteGit(x.ledger.store, x.route.route_id).apply(request);
  assert.equal(result.head, head);
  assert.deepEqual(await service.apply(request), result);
  assert.equal(git(["rev-list", "--count", `${x.firstCommit.split(":")[1]}..HEAD`], { cwd: x.route.path }), "1");
  assert.equal(git(["show", "HEAD:service.txt"], { cwd: x.route.path }), "staged commit");
  assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "unstaged work stays\n");
  assert.equal(git(["rev-parse", "refs/heads/main"], { cwd: x.route.path }), x.firstCommit.split(":")[1]);
  assert.equal(existsSync(hookMarker), false);
});

test("unsupported filters keep the index intact and block other work until a proven no-change abort", async t => {
  const x = await executionFixture(t), service = new CodeRouteGit(x.ledger.store, x.route.route_id);
  writeFileSync(join(x.route.path, ".gitattributes"), "*.txt filter=host-command\n");
  writeFileSync(join(x.route.path, "service.txt"), "must not stage\n");
  const marker = join(x.root, "filter-executed");
  git(["config", "filter.host-command.clean", `touch '${marker}'`], { cwd: x.route.path });
  const snapshot = await service.snapshot(["service.txt"]);
  const request = { ...actor(), action: "stage" as const, snapshot };
  await assert.rejects(service.apply(request), { code: "VALIDATION_ERROR" });
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "first version");
  assert.equal(existsSync(marker), false);
  await assert.rejects(service.snapshot([]), { code: "STATE_CONFLICT" });
  await assert.rejects(x.preflight.markPreparing({ ...actor(), dev_run_id: x.route.dev_run_id! }), { code: "STATE_CONFLICT" });
  assert.equal((await service.abort({ operation_id: request.operation_id, attribution: request.attribution })).state, "aborted");
  assert.equal((await service.snapshot([])).index_digest, snapshot.index_digest);
  await assert.rejects(service.apply(request), { code: "STATE_CONFLICT" });
});

test("managed writes reject caller-selected refs and path escapes before any change", async t => {
  const x = await executionFixture(t), service = new CodeRouteGit(x.ledger.store, x.route.route_id);
  writeFileSync(join(x.route.path, "service.txt"), "new content\n");
  const snapshot = await service.snapshot(["service.txt"]);
  await assert.rejects(service.apply({ ...actor(), action: "stage", snapshot, ref: "refs/heads/main" } as any), { code: "VALIDATION_ERROR" });
  for (const path of ["../outside", "/absolute", ".git/config", "nested/.Git/config", "a\\b"]) {
    await assert.rejects(service.snapshot([path]), { code: "VALIDATION_ERROR" });
  }
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "first version");
  assert.equal((await service.snapshot([])).index_digest, snapshot.index_digest);
});

test("a multi-file conversion refusal preserves the entire index and retries the original attributes", async t => {
  const x = await executionFixture(t), service = new CodeRouteGit(x.ledger.store, x.route.route_id);
  writeFileSync(join(x.route.path, "keep.txt"), "already staged\n");
  await service.apply({ ...actor(), action: "stage", snapshot: await service.snapshot(["keep.txt"]) });
  const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: x.route.path });
  const head = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  const marker = join(x.root, "unexpected-converter");
  for (const filter of ["host-command", "lfs"])
    git(["config", `filter.${filter}.clean`, `touch '${marker}'`], { cwd: x.route.path });
  for (const attribute of ["filter=host-command", "filter=lfs", "working-tree-encoding=UTF-16LE"]) {
    writeFileSync(join(x.route.path, ".gitattributes"), `service.txt text eol=lf\nbad.dat ${attribute}\n`);
    writeFileSync(join(x.route.path, "service.txt"), "valid conversion\r\n");
    writeFileSync(join(x.route.path, "bad.dat"), Buffer.from([65, 0, 10, 0]));
    const originalIndex = readFileSync(index);
    const request = { ...actor(), action: "stage" as const, snapshot: await service.snapshot(["service.txt", "bad.dat"]) };
    await assert.rejects(service.apply(request), { code: "VALIDATION_ERROR" });
    assert.deepEqual(readFileSync(index), originalIndex, "the valid first file must not partially enter the real index");
    assert.equal(existsSync(marker), false);
    assert.equal(git(["rev-parse", "HEAD"], { cwd: x.route.path }), head);
    assert.equal(git(["show", ":keep.txt"], { cwd: x.route.path }), "already staged");
    assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "valid conversion\r\n");
    assert.deepEqual(readFileSync(join(x.route.path, "bad.dat")), Buffer.from([65, 0, 10, 0]));
    // A retry must not reinterpret the saved request using newly edited attributes or bytes.
    writeFileSync(join(x.route.path, ".gitattributes"), "service.txt text eol=lf\nbad.dat -text\n");
    writeFileSync(join(x.route.path, "service.txt"), "later working edit\r\n");
    await assert.rejects(new CodeRouteGit(x.ledger.store, x.route.route_id).apply(request), { code: "VALIDATION_ERROR" });
    assert.deepEqual(readFileSync(index), originalIndex);
    assert.equal(existsSync(marker), false);
    await assert.rejects(service.snapshot([]), { code: "STATE_CONFLICT" });
    assert.equal((await service.abort({ operation_id: request.operation_id, attribution: request.attribution })).state, "aborted");
    await service.apply({ ...actor(), action: "stage", snapshot: await service.snapshot(["service.txt", "bad.dat"]) });
    assert.deepEqual(branchGit(x.route.path, ["show", ":service.txt"]), Buffer.from("later working edit\n"));
    assert.deepEqual(branchGit(x.route.path, ["show", ":bad.dat"]), Buffer.from([65, 0, 10, 0]));
    assert.equal(git(["show", ":keep.txt"], { cwd: x.route.path }), "already staged");
    assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "later working edit\r\n");
  }
});

test("write snapshots refuse index flags and gitlinks whose semantics are not supported", async t => {
  const x = await executionFixture(t), service = new CodeRouteGit(x.ledger.store, x.route.route_id);
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    git(["update-index", `--${flag}`, "service.txt"], { cwd: x.route.path });
    await assert.rejects(service.snapshot(["service.txt"]), { code: "VALIDATION_ERROR" });
    git(["update-index", `--no-${flag}`, "service.txt"], { cwd: x.route.path });
  }
  writeFileSync(join(x.route.path, "planned.txt"), "not staged\n");
  git(["add", "-N", "planned.txt"], { cwd: x.route.path });
  await assert.rejects(service.snapshot(["planned.txt"]), { code: "VALIDATION_ERROR" });
  git(["reset", "-q", "HEAD", "--", "planned.txt"], { cwd: x.route.path });
  git(["update-index", "--add", "--cacheinfo", `160000,${x.firstCommit.split(":")[1]},nested`], { cwd: x.route.path });
  await assert.rejects(service.snapshot([]), { code: "VALIDATION_ERROR" });
  git(["update-index", "--force-remove", "nested"], { cwd: x.route.path });
  const admin = git(["rev-parse", "--absolute-git-dir"], { cwd: x.route.path });
  writeFileSync(join(admin, "MERGE_HEAD"), x.firstCommit.split(":")[1] + "\n");
  await assert.rejects(service.snapshot([]), { code: "VALIDATION_ERROR" });
});


test("staging preserves binary bytes, executable modes, link entries and deletions without following links", async t => {
  const x = await executionFixture(t), service = new CodeRouteGit(x.ledger.store, x.route.route_id);
  const secret = join(x.root, "outside.txt");
  writeFileSync(secret, "outside content must not be staged\n");
  symlinkSync(x.root, join(x.route.path, "escape"));
  await assert.rejects(service.snapshot(["escape/outside.txt"]), { code: "VALIDATION_ERROR" });
  linkSync(secret, join(x.route.path, "hardlink"));
  await assert.rejects(service.snapshot(["hardlink"]), { code: "VALIDATION_ERROR" });
  const binary = Buffer.from([0, 1, 2, 255]);
  writeFileSync(join(x.route.path, "binary.dat"), binary);
  writeFileSync(join(x.route.path, "tool.sh"), "#!/bin/sh\necho fixture\n");
  chmodSync(join(x.route.path, "tool.sh"), 0o755);
  symlinkSync(secret, join(x.route.path, "link"));
  unlinkSync(join(x.route.path, "service.txt"));
  await service.apply({ ...actor(), action: "stage", snapshot: await service.snapshot(["binary.dat", "tool.sh", "link", "service.txt"]) });
  assert.deepEqual(branchGit(x.route.path, ["show", ":binary.dat"]), binary);
  assert.match(git(["ls-files", "--stage", "tool.sh"], { cwd: x.route.path }), /^100755 /);
  assert.match(git(["ls-files", "--stage", "link"], { cwd: x.route.path }), /^120000 /);
  assert.equal(git(["show", ":link"], { cwd: x.route.path }), secret);
  assert.throws(() => git(["ls-files", "--error-unmatch", "--", "service.txt"], { cwd: x.route.path }));
  assert.equal(readFileSync(secret, "utf8"), "outside content must not be staged\n");
});

test("an existing Git index lock is retained and recovery uses the original snapshot", async t => {
  const x = await executionFixture(t), service = new CodeRouteGit(x.ledger.store, x.route.route_id);
  writeFileSync(join(x.route.path, "service.txt"), "fixed request\n");
  const request = { ...actor(), action: "stage" as const, snapshot: await service.snapshot(["service.txt"]) };
  const lock = git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: x.route.path }) + ".lock";
  writeFileSync(lock, "another native writer", { flag: "wx" });
  await assert.rejects(service.apply(request), { code: "EEXIST" });
  assert.equal(readFileSync(lock, "utf8"), "another native writer");
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "first version");
  await assert.rejects(service.snapshot([]), { code: "STATE_CONFLICT" });
  writeFileSync(join(x.route.path, "service.txt"), "changed after interrupted request\n");
  unlinkSync(lock); // The test's external lock owner finishes; the service never steals its lock.
  await new CodeRouteGit(x.ledger.store, x.route.route_id).apply(request);
  assert.equal(git(["show", ":service.txt"], { cwd: x.route.path }), "fixed request");
  assert.equal(readFileSync(join(x.route.path, "service.txt"), "utf8"), "changed after interrupted request\n");
});

test("active executors and stale execution generations cannot use a preparation write snapshot", async t => {
  const x = await executionFixture(t), service = new CodeRouteGit(x.ledger.store, x.route.route_id);
  const snapshot = await service.snapshot(["service.txt"]);
  let container: string | undefined;
  const engine: RouteEngine = {
    identity: async () => "fixture-engine", create: async run => (container = run.execution_id),
    find: async () => container, start: async () => {}, removeStopped: async () => { container = undefined; },
  };
  const execution = new CodeRouteExecutions(x.ledger.store, engine);
  const run = await execution.start({ ...actor(), route_id: x.route.route_id, image: `sha256:${"1".repeat(64)}`, argv: ["true"] });
  await assert.rejects(service.apply({ ...actor(), action: "stage", snapshot }), { code: "STATE_CONFLICT" });
  await execution.stop({ route_id: x.route.route_id, execution_id: run.execution_id });
  await assert.rejects(service.apply({ ...actor(), action: "stage", snapshot }), { code: "STATE_CONFLICT" });
  const fresh = await service.snapshot(["service.txt"]);
  assert.equal(fresh.generation, snapshot.generation + 1);
  assert.equal((await service.apply({ ...actor(), action: "stage", snapshot: fresh })).state, "completed");
});
