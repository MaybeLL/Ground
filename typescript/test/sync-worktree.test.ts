import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareLocalSync, applyLocalSync, completeLocalSync, abandonLocalSync, readLocalSync } from "../src/sync-worktree.js";
import { snapshotSyncFiles } from "../src/sync-files.js";

function fixture(t: { after: (fn: () => void) => void }, conflict = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-sync-files-"))), cwd = join(root, "repo"); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-qb", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@invalid");
  writeFileSync(join(cwd, "file"), "base\n"); writeFileSync(join(cwd, ".gitignore"), "ignored\n");
  git("add", "."); git("commit", "-qm", "base"); const base = `sha1:${git("rev-parse", "HEAD")}`;
  writeFileSync(join(cwd, conflict ? "file" : "upstream"), "upstream\n"); git("add", "."); git("commit", "-qm", "target"); const target = `sha1:${git("rev-parse", "HEAD")}`;
  git("checkout", "--detach", base.slice(5));
  writeFileSync(join(cwd, "file"), "staged\n"); git("add", "file"); writeFileSync(join(cwd, "file"), "ours\r\n"); chmodSync(join(cwd, "file"), 0o600);
  writeFileSync(join(cwd, "untracked"), "local only\n"); writeFileSync(join(cwd, "ignored"), "ignored local\n");
  const index = readFileSync(join(cwd, ".git", "index")), directory = join(root, "recovery");
  const prepare = () => prepareLocalSync({ cwd, directory, base, target });
  return { root, cwd, git, base, target, directory, index, prepare };
}

test("real clean sync installs upstream and local changes with an actual completion receipt", t => {
  const x = fixture(t); x.prepare(); const result = applyLocalSync(x.directory);
  assert.equal(result.phase, "resolving"); assert.equal(x.git("rev-parse", "HEAD"), x.target.slice(5));
  assert.equal(readFileSync(join(x.cwd, "upstream"), "utf8"), "upstream\n");
  assert.equal(readFileSync(join(x.cwd, "file"), "utf8"), "ours\r\n");
  assert.equal(readFileSync(join(x.cwd, "ignored"), "utf8"), "ignored local\n");
  assert.doesNotMatch(x.git("diff", "HEAD", "--name-only"), /upstream/);
  const done = completeLocalSync(x.directory); assert.equal(done.phase, "completing"); assert.equal(done.receipt!.head, x.target);
  assert.equal(done.receipt!.files, snapshotSyncFiles(x.cwd, [".gitignore", "file", "upstream", "untracked"]).digest);
});

test("conflicts remain in the real index; explicit completion requires resolution", t => {
  const x = fixture(t, true); x.prepare(); applyLocalSync(x.directory);
  assert.match(x.git("ls-files", "-u"), /file/); assert.throws(() => completeLocalSync(x.directory), /validation/);
  writeFileSync(join(x.cwd, "file"), "upstream\n"); x.git("add", "file");
  const done = completeLocalSync(x.directory); assert.equal(done.phase, "completing");
  assert.doesNotMatch(x.git("diff", "HEAD", "--name-only"), /^file$/m, "taking upstream creates zero file difference");
  assert.equal(done.merge!.conflicts[0]!.path, "file");
});

test("abandon saves post-sync edits and restores exact original index, CRLF, mode and untracked bytes", t => {
  const x = fixture(t, true); x.prepare(); applyLocalSync(x.directory);
  writeFileSync(join(x.cwd, "file"), "later conflict edit\n"); writeFileSync(join(x.cwd, "new-file"), "later untracked\n");
  const done = abandonLocalSync(x.directory);
  assert.equal(done.phase, "abandoned"); assert.equal(x.git("rev-parse", "HEAD"), x.base.slice(5));
  assert.deepEqual(readFileSync(join(x.cwd, ".git", "index")), x.index);
  assert.equal(readFileSync(join(x.cwd, "file"), "utf8"), "ours\r\n"); assert.equal(lstatSync(join(x.cwd, "file")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(x.cwd, "untracked"), "utf8"), "local only\n"); assert.equal(existsSync(join(x.cwd, "new-file")), false);
  const saved = JSON.parse(readFileSync(join(x.directory, done.saved_edits[0]!, "files.json"), "utf8"));
  const blob = saved.entries["new-file"].digest.slice(7);
  assert.equal(readFileSync(join(x.directory, done.saved_edits[0]!, "blobs", blob), "utf8"), "later untracked\n");
});

for (const step of ["index-locked", "index-installed", "head-updated"]) {
  test(`SIGKILL at ${step} recovers from disk in another process`, t => {
    const x = fixture(t); x.prepare();
    const script = `import {applyLocalSync} from ${JSON.stringify(new URL("../dist/src/sync-worktree.js", import.meta.url).href)}; applyLocalSync(${JSON.stringify(x.directory)}, s => { if (s === ${JSON.stringify(step)}) process.kill(process.pid, 'SIGKILL'); });`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30000, env: { ...process.env, NODE_OPTIONS: "" } });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.equal(readLocalSync(x.directory).phase, "applying");
    writeFileSync(join(x.cwd, "after-kill"), "preserve this edit\n");
    const restored = abandonLocalSync(x.directory); assert.equal(restored.phase, "abandoned");
    assert.deepEqual(readFileSync(join(x.cwd, ".git", "index")), x.index);
    assert.ok(JSON.parse(readFileSync(join(x.directory, restored.saved_edits[0]!, "files.json"), "utf8")).entries["after-kill"]);
  });
}

test("fully applied interrupted sync may complete, but a stale completion receipt cannot be reused", t => {
  const x = fixture(t); x.prepare();
  assert.throws(() => applyLocalSync(x.directory, step => { if (step === "index-installed") throw new Error("stop"); }), /stop/);
  const done = completeLocalSync(x.directory); assert.equal(done.phase, "completing");
  writeFileSync(join(x.cwd, "file"), "later changes\n");
  assert.throws(() => completeLocalSync(x.directory));
});

test("unrelated Git index locks are preserved and never stolen by recovery", t => {
  const x = fixture(t); x.prepare(); writeFileSync(join(x.cwd, ".git", "index.lock"), "another writer\n");
  assert.throws(() => applyLocalSync(x.directory));
  assert.equal(readFileSync(join(x.cwd, ".git", "index.lock"), "utf8"), "another writer\n");
  assert.equal(abandonLocalSync(x.directory).phase, "abandoned", "no file mutation began, so abandonment need not touch the index lock");
  assert.equal(readFileSync(join(x.cwd, ".git", "index.lock"), "utf8"), "another writer\n");
});

for (const step of ["applying", "file:file", "index-locked", "index-installed", "head-updated", "resolving"]) {
  test(`interruption at ${step} is queryable and abandonment preserves later edits`, t => {
    const x = fixture(t); x.prepare();
    assert.throws(() => applyLocalSync(x.directory, current => { if (current === step) throw new Error("injected interruption"); }), /injected/);
    assert.ok(["applying", "resolving"].includes(readLocalSync(x.directory).phase));
    writeFileSync(join(x.cwd, "later"), "after interruption\n");
    const restored = abandonLocalSync(x.directory);
    assert.equal(restored.phase, "abandoned"); assert.deepEqual(readFileSync(join(x.cwd, ".git", "index")), x.index);
    assert.equal(readFileSync(join(x.cwd, "file"), "utf8"), "ours\r\n");
    assert.ok(JSON.parse(readFileSync(join(x.directory, restored.saved_edits[0]!, "files.json"), "utf8")).entries.later);
  });
}

test("interrupted restoration can be abandoned again without discarding edits made during recovery", t => {
  const x = fixture(t); x.prepare(); applyLocalSync(x.directory);
  writeFileSync(join(x.cwd, "later"), "first edit\n");
  assert.throws(() => abandonLocalSync(x.directory, step => { if (step.startsWith("restore:")) throw new Error("stop restore"); }), /stop restore/);
  writeFileSync(join(x.cwd, "later"), "second edit\n");
  const done = abandonLocalSync(x.directory); assert.equal(done.saved_edits.length, 2);
  assert.deepEqual(readFileSync(join(x.cwd, ".git", "index")), x.index);
});


test("compiled development and history modules load alone in fresh processes", () => {
  for (const name of ["sync-worktree", "development-branch", "integration-history", "delivery-worktree", "git-history"]) {
    const url = new URL(`../dist/src/${name}.js`, import.meta.url);
    assert.ok(existsSync(url), "build the compiled modules before this test");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url.href)})`], {
      encoding: "utf8", timeout: 30000, env: { ...process.env, NODE_OPTIONS: "" },
    });
    assert.equal(child.status, 0, `${name}: ${child.stderr}`);
    assert.equal(child.signal, null);
  }
});
