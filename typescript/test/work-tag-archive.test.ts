import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodeReceipt, deliveryIdOf, encodeReceipt, GitTagArchive } from "../src/work/adapters/index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function repository() {
  const root = mkdtempSync(join(tmpdir(), "grounds-archive-"));
  const remote = join(root, "remote.git"), work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  const commit = (name: string) => { writeFileSync(join(work, name), name); git(work, "add", "-A"); git(work, "commit", "-qm", name); return git(work, "rev-parse", "HEAD"); };
  return { root, remote, work, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a commit is archived as a tag, read back, and described by a receipt that names the remote, tag, commit, tree and parents", async t => {
  const r = repository(); t.after(r.cleanup);
  const first = r.commit("a"), second = r.commit("b");
  const archive = new GitTagArchive();
  const result = await archive.archive({ repositoryPath: r.work, remote: r.remote, deliveryId: "delivery-1", commit: "HEAD" });
  assert.equal(result.status, "confirmed");
  if (result.status !== "confirmed") return;
  assert.equal(result.commit, second);
  assert.equal(git(r.root, "--git-dir", r.remote, "rev-parse", "refs/tags/grounds/deliveries/delivery-1"), second, "the remote really has the tag");
  const receipt = decodeReceipt(result.receipt)!;
  assert.deepEqual([receipt.commit, receipt.tree, receipt.parents, deliveryIdOf(receipt)], [second, git(r.work, "rev-parse", `${second}^{tree}`), [first], "delivery-1"]);
  assert.equal(await archive.check([{ type: "candidate", id: "delivery-1", receipt: result.receipt }]), "accepted");
});

test("archiving the same commit again is harmless, and a different commit under the same identity is a conflict that changes nothing", async t => {
  const r = repository(); t.after(r.cleanup);
  const first = r.commit("a");
  const archive = new GitTagArchive();
  const one = await archive.archive({ repositoryPath: r.work, remote: r.remote, deliveryId: "d", commit: first });
  const again = await archive.archive({ repositoryPath: r.work, remote: r.remote, deliveryId: "d", commit: first });
  assert.deepEqual(again, one);
  r.commit("b");
  const clash = await archive.archive({ repositoryPath: r.work, remote: r.remote, deliveryId: "d", commit: "HEAD" });
  assert.equal(clash.status, "conflict");
  assert.equal(git(r.root, "--git-dir", r.remote, "rev-parse", "refs/tags/grounds/deliveries/d"), first, "the tag was not moved");
});

test("an unknown commit and an unusable identity are refused before anything is pushed", async t => {
  const r = repository(); t.after(r.cleanup);
  r.commit("a");
  const archive = new GitTagArchive();
  assert.equal((await archive.archive({ repositoryPath: r.work, remote: r.remote, deliveryId: "d", commit: "deadbeef" })).status, "invalid");
  assert.equal((await archive.archive({ repositoryPath: r.work, remote: r.remote, deliveryId: "../escape", commit: "HEAD" })).status, "invalid");
  assert.equal(git(r.root, "--git-dir", r.remote, "tag", "-l"), "");
});

test("a remote that cannot be reached is unavailable, never a verdict on the delivery", async t => {
  const r = repository(); t.after(r.cleanup);
  r.commit("a");
  const archive = new GitTagArchive({ timeoutMs: 20_000 });
  const stored = await archive.archive({ repositoryPath: r.work, remote: r.remote, deliveryId: "d", commit: "HEAD" });
  assert.equal(stored.status, "confirmed");
  if (stored.status !== "confirmed") return;
  const gone = await archive.archive({ repositoryPath: r.work, remote: join(r.root, "nowhere.git"), deliveryId: "d", commit: "HEAD" });
  assert.equal(gone.status, "unavailable");
  rmSync(r.remote, { recursive: true, force: true });
  assert.equal(await archive.check([{ type: "candidate", id: "d", receipt: stored.receipt }]), "unavailable");
});

test("a receipt is checked against what the remote shows now: a removed or moved tag, a foreign receipt and garbage are rejected", async t => {
  const r = repository(); t.after(r.cleanup);
  const first = r.commit("a");
  const archive = new GitTagArchive();
  const stored = await archive.archive({ repositoryPath: r.work, remote: r.remote, deliveryId: "d", commit: first });
  assert.equal(stored.status, "confirmed");
  if (stored.status !== "confirmed") return;
  const item = { type: "candidate" as const, id: "d", receipt: stored.receipt };
  assert.equal(await archive.check([item]), "accepted");
  assert.equal(await archive.check([{ ...item, id: "other" }]), "rejected", "the receipt names another delivery");
  assert.equal(await archive.check([{ ...item, receipt: "free text" }]), "rejected");
  assert.equal(await archive.check([{ ...item, receipt: encodeReceipt({ ...decodeReceipt(stored.receipt)!, commit: "f".repeat(40) }) }]), "rejected", "the receipt claims a commit the tag does not have");
  const second = r.commit("b");
  git(r.work, "push", "-q", r.remote, `${second}:refs/heads/main`);
  git(r.root, "--git-dir", r.remote, "tag", "-f", "grounds/deliveries/d", second);
  assert.equal(await archive.check([item]), "rejected", "the tag moved");
  git(r.root, "--git-dir", r.remote, "tag", "-d", "grounds/deliveries/d");
  assert.equal(await archive.check([item]), "rejected", "the tag is gone");
});

test("a decisive item settles the whole manifest; an unreachable one only matters when nothing else is wrong", async t => {
  const r = repository(); t.after(r.cleanup);
  r.commit("a");
  const archive = new GitTagArchive({ timeoutMs: 20_000 });
  const good = await archive.archive({ repositoryPath: r.work, remote: r.remote, deliveryId: "good", commit: "HEAD" });
  assert.equal(good.status, "confirmed");
  if (good.status !== "confirmed") return;
  const lost = encodeReceipt({ ...decodeReceipt(good.receipt)!, remote: join(r.root, "nowhere.git"), ref: "refs/tags/grounds/deliveries/lost" });
  const items = [{ type: "candidate" as const, id: "lost", receipt: lost }, { type: "candidate" as const, id: "good", receipt: good.receipt }];
  assert.equal(await archive.check(items), "unavailable");
  const missing = encodeReceipt({ ...decodeReceipt(good.receipt)!, ref: "refs/tags/grounds/deliveries/missing" });
  assert.equal(await archive.check([...items, { type: "candidate", id: "missing", receipt: missing }]), "rejected");
});

test("malformed receipts do not decode", () => {
  assert.equal(decodeReceipt("git-delivery:v1:!!!"), undefined);
  assert.equal(decodeReceipt(encodeReceipt({ format: "grounds.git-delivery/v1", remote: "r", ref: "refs/heads/main", commit: "a".repeat(40), tree: "b".repeat(40), parents: [] })), undefined, "only the delivery namespace is accepted");
  assert.equal(decodeReceipt(encodeReceipt({ format: "grounds.git-delivery/v1", remote: "r", ref: "refs/tags/grounds/deliveries/x", commit: "nope", tree: "b".repeat(40), parents: [] })), undefined);
});
