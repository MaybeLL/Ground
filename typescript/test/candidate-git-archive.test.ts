import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { archiveGitCommit, fetchGitArchive, collectGitArchiveBinding, inspectGitArchive, inspectLocalGitArchive, readArchiveProtectionPolicy, restoreGitArchive, validateArchiveProtectionEvidence, type ArchiveProtectionEvidence, type GitArchiveBinding } from "../src/candidate-git-archive.js";
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Archive Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Archive Test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_TERMINAL_PROMPT: "0" } }).trimEnd();
const oid = (value: string): string => `sha1:${value}`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-archive-test-")));
  const local = join(root, "author"), remote = join(root, "remote.git"); mkdirSync(local);
  git(root, "init", "--bare", remote); git(local, "init", "-b", "feature");
  writeFileSync(join(local, "feature"), "base\n"); git(local, "add", "."); git(local, "commit", "-m", "base");
  const base = oid(git(local, "rev-parse", "HEAD"));
  writeFileSync(join(local, "feature"), "candidate one\n"); git(local, "commit", "-am", "candidate zero");
  const c0 = oid(git(local, "rev-parse", "HEAD"));
  const binding = (source = c0, id = "candidate-0"): GitArchiveBinding => collectGitArchiveBinding(local, { repository_id: "repository-1", canonical_remote: pathToFileURL(remote).href, archive_ref: `refs/tags/grounds/candidates/${id}`, source_commit: source, base_commit: base, retained_commits: [base] }, { allowLocalTransport: true });
  return { root, local, remote, base, c0, binding, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function policy(binding: GitArchiveBinding): ArchiveProtectionEvidence {
  return { format: "grounds.archive-protection/v1", repository_id: binding.repository_id, canonical_remote: binding.canonical_remote, ref_namespace: "refs/tags/grounds/candidates/", source: { kind: "platform-api", locator: "https://example.invalid/repository/policy", revision: "policy-1", verified_by: "isolated-test-adapter" }, observed_at: new Date(Date.now() - 1000).toISOString(), valid_until: new Date(Date.now() + 60_000).toISOString(), currently_applicable: true, archive_identity_can_create: true, ordinary_identity_cannot_update: true, ordinary_identity_cannot_delete: true, team_can_read_by_ref: true, repository_backup: "unknown", database_backup: "unknown" };
}
const archive = (local: string, binding: GitArchiveBinding) => archiveGitCommit({ repositoryPath: local, binding, allowLocalTransport: true, allowRemoteWrite: true, policyCheck: policy });

test("candidates survive branch deletion, reflog expiry, GC and author clone loss", async () => {
  const f = fixture(); try {
    const b0 = f.binding(); assert.equal((await archive(f.local, b0)).status, "confirmed");
    writeFileSync(join(f.local, "binary"), Buffer.from([0, 1, 255, 3]));
    writeFileSync(join(f.local, "executable"), "#!/bin/sh\nexit 0\n"); chmodSync(join(f.local, "executable"), 0o755); symlinkSync("feature", join(f.local, "symlink"));
    git(f.local, "add", "."); git(f.local, "commit", "-m", "candidate one");
    const b1 = f.binding(oid(git(f.local, "rev-parse", "HEAD")), "candidate-1"); assert.equal((await archive(f.local, b1)).status, "confirmed");
    git(f.local, "push", f.remote, "HEAD:refs/heads/development"); git(f.local, "push", f.remote, ":refs/heads/development");
    git(f.remote, "reflog", "expire", "--expire=now", "--all"); git(f.remote, "gc", "--prune=now"); rmSync(f.local, { recursive: true });
    for (const [i, binding] of [b0, b1].entries()) {
      const destination = join(f.root, `colleague-${i}`); const result = restoreGitArchive({ binding, destination, branch: `resume-${i}`, allowLocalTransport: true });
      assert.equal(result.status, "confirmed", JSON.stringify(result)); assert.equal(git(destination, "remote", "get-url", "origin"), binding.canonical_remote); assert.equal(oid(git(destination, "rev-parse", "HEAD")), binding.source_commit); assert.equal(oid(git(destination, "rev-parse", "HEAD^{tree}")), binding.result_tree); assert.equal(git(destination, "cat-file", "-t", f.base.slice(5)), "commit");
    }
    assert.deepEqual(readFileSync(join(f.root, "colleague-1", "binary")), Buffer.from([0, 1, 255, 3])); assert.match(git(join(f.root, "colleague-1"), "ls-tree", "HEAD", "executable"), /^100755 /); assert.match(git(join(f.root, "colleague-1"), "ls-tree", "HEAD", "symlink"), /^120000 /);
  } finally { f.cleanup(); }
});
test("same ref/source is idempotent and distinct same-tree history cannot overwrite it", async () => {
  const f = fixture(); try {
    const binding = f.binding(); assert.equal((await archive(f.local, binding)).status, "confirmed"); assert.equal((await archive(f.local, binding)).status, "confirmed");
    git(f.local, "commit", "--allow-empty", "-m", "same tree distinct history"); const replacement = f.binding(oid(git(f.local, "rev-parse", "HEAD")));
    assert.equal(replacement.result_tree, binding.result_tree); assert.equal((await archive(f.local, replacement)).status, "conflict"); assert.equal(git(f.remote, "rev-parse", binding.archive_ref), f.c0.slice(5));
  } finally { f.cleanup(); }
});
test("policy scope, permissions, expiry and applicability fail closed before push", async () => {
  const f = fixture(); try {
    const binding = f.binding();
    for (const patch of [{ repository_id: "other" }, { ref_namespace: "refs/tags/grounds/deliveries/" }, { valid_until: "2000-01-01T00:00:00Z" }, { currently_applicable: false }, { team_can_read_by_ref: false }, { ordinary_identity_cannot_update: false }, { ordinary_identity_cannot_delete: false }, { archive_identity_can_create: false }, { source: { ...policy(binding).source, locator: "https://secret-token@example.invalid/policy" } }, { source: { ...policy(binding).source, locator: "https://example.invalid/policy?access_token=secret" } }]) {
      const result = await archiveGitCommit({ repositoryPath: f.local, binding, allowRemoteWrite: true, allowLocalTransport: true, policyCheck: () => ({ ...policy(binding), ...patch }) as ArchiveProtectionEvidence });
      assert.equal(result.status, "unknown"); assert.equal(inspectGitArchive({ binding, allowLocalTransport: true }).status, "missing");
    }
  } finally { f.cleanup(); }
});
test("deployment evidence rereads a separate current source on every call", async () => {
  const f = fixture(); try {
    const binding = f.binding(), config = join(f.root, "deployment.json"), path = join(f.root, "policy.json"); writeFileSync(config, '{"protected":true}');
    const evidence = policy(binding); evidence.source = { kind: "verified-deployment-config", locator: pathToFileURL(config).href, revision: `sha256:${createHash("sha256").update(readFileSync(config)).digest("hex")}`, verified_by: "deployment-operator" }; writeFileSync(path, JSON.stringify(evidence));
    assert.deepEqual(readArchiveProtectionPolicy(path, binding), evidence); writeFileSync(config, '{"protected":false}'); assert.throws(() => readArchiveProtectionPolicy(path, binding), /cannot be rechecked or has changed/);
    writeFileSync(path, JSON.stringify(policy(binding))); assert.throws(() => readArchiveProtectionPolicy(path, binding), /live policy adapter/);
  } finally { f.cleanup(); }
});
test("remote closure check cannot use author objects to conceal absent remote blob", async () => {
  const f = fixture(); try {
    const binding = f.binding(); assert.equal((await archive(f.local, binding)).status, "confirmed"); const blob = git(f.local, "rev-parse", "HEAD:feature"); rmSync(join(f.remote, "objects", blob.slice(0, 2), blob.slice(2)));
    assert.equal(inspectLocalGitArchive(f.local, binding, { allowLocalTransport: true }).status, "confirmed"); assert.equal(inspectGitArchive({ binding, allowLocalTransport: true }).status, "incomplete");
  } finally { f.cleanup(); }
});
test("annotated tags and wrong parents cannot masquerade as exact candidate identity", async () => {
  const f = fixture(); try {
    const binding = f.binding(); git(f.local, "tag", "-a", binding.archive_ref.slice(10), "-m", "annotated", binding.source_commit.slice(5)); git(f.local, "push", f.remote, binding.archive_ref);
    assert.equal(inspectGitArchive({ binding, allowLocalTransport: true }).status, "conflict"); assert.equal(inspectLocalGitArchive(f.local, { ...binding, ordered_parents: [] }, { allowLocalTransport: true }).status, "conflict");
  } finally { f.cleanup(); }
});
test("restore preserves existing paths; default does not authorize remote writes", async () => {
  const f = fixture(); try {
    const binding = f.binding(); assert.equal((await archiveGitCommit({ repositoryPath: f.local, binding, policyCheck: policy, allowLocalTransport: true })).status, "missing");
    assert.throws(() => restoreGitArchive({ binding, destination: f.local, allowLocalTransport: true }), /new destination/); assert.equal(readFileSync(join(f.local, "feature"), "utf8"), "candidate one\n");
  } finally { f.cleanup(); }
});
test("local inspection never invokes transport and local remotes require explicit opt-in", async () => {
  const f = fixture(); try {
    const binding = f.binding(); assert.throws(() => inspectLocalGitArchive(f.local, binding));
    assert.equal(inspectLocalGitArchive(f.local, { ...binding, canonical_remote: "ssh://git@example.invalid/repository" }).status, "confirmed"); assert.equal(existsSync(join(f.remote, "refs", "tags", "grounds")), false);
  } finally { f.cleanup(); }
});
test("post-write protection recheck failure retains reconcilable unknown", async () => {
  const f = fixture(); try {
    const binding = f.binding(); let calls = 0;
    const result = await archiveGitCommit({ repositoryPath: f.local, binding, allowLocalTransport: true, allowRemoteWrite: true, policyCheck: () => ({ ...policy(binding), currently_applicable: ++calls === 1 }) });
    assert.equal(result.status, "unknown"); assert.equal(inspectGitArchive({ binding, allowLocalTransport: true }).status, "confirmed"); assert.equal((await archive(f.local, binding)).status, "confirmed");
  } finally { f.cleanup(); }
});
test("landing archival retains actual predecessor without moving candidate tag", async () => {
  const f = fixture(); try {
    const candidate = f.binding(); assert.equal((await archive(f.local, candidate)).status, "confirmed"); git(f.local, "commit", "--allow-empty", "-m", "landing commit");
    const binding = { ...f.binding(oid(git(f.local, "rev-parse", "HEAD")), "landing"), archive_ref: "refs/tags/grounds/deliveries/integration-1", retained_commits: [candidate.source_commit] };
    const result = await archiveGitCommit({ repositoryPath: f.local, binding, allowLocalTransport: true, allowRemoteWrite: true, policyCheck: () => ({ ...policy(binding), ref_namespace: "refs/tags/grounds/deliveries/" }) });
    assert.equal(result.status, "confirmed"); assert.equal(git(f.remote, "rev-parse", candidate.archive_ref), candidate.source_commit.slice(5)); assert.equal(git(f.remote, "rev-parse", binding.archive_ref), binding.source_commit.slice(5)); validateArchiveProtectionEvidence(result.protection!, binding, result.observed_at);
  } finally { f.cleanup(); }
});

test("explicit fetch leaves active HEAD, index and dirty files unchanged", async () => {
  const f = fixture(); try {
    const binding = f.binding(); assert.equal((await archive(f.local, binding)).status, "confirmed");
    const colleague = join(f.root, "colleague"); mkdirSync(colleague); git(colleague, "init", "-b", "own");
    writeFileSync(join(colleague, "own-file"), "own work\n"); git(colleague, "add", "."); git(colleague, "commit", "-m", "own checkpoint");
    writeFileSync(join(colleague, "own-file"), "uncommitted work\n");
    const head = git(colleague, "rev-parse", "HEAD"), status = git(colleague, "status", "--porcelain"), index = readFileSync(join(colleague, ".git", "index"));
    const result = fetchGitArchive(colleague, binding, { allowLocalTransport: true });
    assert.equal(result.status, "confirmed", JSON.stringify(result)); assert.equal(result.remote_source_commit, binding.source_commit);
    assert.equal(git(colleague, "rev-parse", "HEAD"), head); assert.equal(git(colleague, "status", "--porcelain"), status); assert.deepEqual(readFileSync(join(colleague, ".git", "index")), index); assert.equal(readFileSync(join(colleague, "own-file"), "utf8"), "uncommitted work\n");
  } finally { f.cleanup(); }
});

test("a real push with its response lost is reconciled by remote readback", async () => {
  const f = fixture(), originalPath = process.env.PATH; try {
    const binding = f.binding(), bin = join(f.root, "bin"); mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const cp = require('node:child_process');
const args = process.argv.slice(2);
try { const bytes = cp.execFileSync(${JSON.stringify(realGit)}, args, { stdio: ['ignore', 'pipe', 'pipe'] }); if (args.includes('push')) process.exit(1); process.stdout.write(bytes); }
catch { process.exit(1); }
`, { mode: 0o700 });
    process.env.PATH = bin + ":" + originalPath;
    const result = await archive(f.local, binding); assert.equal(result.status, "confirmed", JSON.stringify(result)); assert.equal(result.remote_source_commit, binding.source_commit); assert.ok(result.protection);
  } finally { process.env.PATH = originalPath; f.cleanup(); }
});
test("unreadable archive repositories are not reported as absent refs", async () => {
  const f = fixture(); try {
    const binding = f.binding(); const replacement = join(f.root, "replacement"); git(f.root, "init", "--bare", replacement);
    const target = { ...binding, canonical_remote: pathToFileURL(replacement).href }; rmSync(join(replacement, "objects"), { recursive: true });
    const result = inspectGitArchive({ binding: target, allowLocalTransport: true }); assert.equal(result.status, "unreadable");
  } finally { f.cleanup(); }
});

test("real merge archive preserves ordered parents and fixed integrated target base", async () => {
  const f = fixture(); try {
    git(f.local, "checkout", "-b", "upstream", f.base.slice(5)); writeFileSync(join(f.local, "upstream"), "other contributor\n"); git(f.local, "add", "."); git(f.local, "commit", "-m", "upstream");
    const target = oid(git(f.local, "rev-parse", "HEAD")); git(f.local, "checkout", "feature"); git(f.local, "merge", "--no-ff", "upstream", "-m", "integrate target");
    const binding = collectGitArchiveBinding(f.local, { repository_id: "repository-1", canonical_remote: pathToFileURL(f.remote).href, archive_ref: "refs/tags/grounds/candidates/merge-candidate", source_commit: oid(git(f.local, "rev-parse", "HEAD")), base_commit: target, retained_commits: [f.base] }, { allowLocalTransport: true });
    assert.deepEqual(binding.ordered_parents, [f.c0, target]); assert.equal((await archive(f.local, binding)).status, "confirmed");
    const destination = join(f.root, "restored-merge"); assert.equal(restoreGitArchive({ binding, destination, allowLocalTransport: true }).status, "confirmed");
    assert.equal(git(destination, "diff", "--name-only", target.slice(5), "HEAD"), "feature"); assert.equal(readFileSync(join(destination, "upstream"), "utf8"), "other contributor\n");
  } finally { f.cleanup(); }
});
test("partial-clone/grafted local history fails closed without fetching", async () => {
  const f = fixture(); try {
    const binding = f.binding(); git(f.local, "config", "remote.origin.promisor", "true"); assert.equal(inspectLocalGitArchive(f.local, binding, { allowLocalTransport: true }).status, "incomplete");
    git(f.local, "config", "--unset", "remote.origin.promisor"); writeFileSync(join(f.local, ".git", "info", "grafts"), binding.source_commit.slice(5) + "\n"); assert.equal(inspectLocalGitArchive(f.local, binding, { allowLocalTransport: true }).status, "incomplete");
  } finally { f.cleanup(); }
});

test("existing remote archive resumes from original binding without author-local objects", async () => {
  const f = fixture(); try {
    const binding = f.binding(); assert.equal((await archive(f.local, binding)).status, "confirmed"); const empty = join(f.root, "new-machine"); mkdirSync(empty); git(empty, "init", "-q"); rmSync(f.local, { recursive: true });
    const result = await archive(empty, binding); assert.equal(result.status, "confirmed", JSON.stringify(result)); assert.equal(result.remote_source_commit, binding.source_commit);
  } finally { f.cleanup(); }
});
