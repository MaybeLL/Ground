import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CandidateArchiveService, archiveOperation } from "../src/candidate-archive-service.js";
import { collectGitArchiveBinding, inspectGitArchive, type ArchiveProtectionEvidence, type GitArchiveBinding } from "../src/candidate-git-archive.js";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";
import type { Store } from "../src/store-types.js";
import { SQLStore } from "../src/sql-store.js";
import { LedgerFixture, testAgent } from "./fixture.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function policy(binding: GitArchiveBinding): ArchiveProtectionEvidence {
  return { format: "grounds.archive-protection/v1", repository_id: binding.repository_id, canonical_remote: binding.canonical_remote, ref_namespace: "refs/tags/grounds/candidates/", source: { kind: "platform-api", locator: "https://example.invalid/policy", revision: "policy-1", verified_by: "isolated-test-adapter" }, observed_at: new Date(Date.now() - 1000).toISOString(), valid_until: new Date(Date.now() + 60_000).toISOString(), currently_applicable: true, archive_identity_can_create: true, ordinary_identity_cannot_update: true, ordinary_identity_cannot_delete: true, team_can_read_by_ref: true, repository_backup: "unknown", database_backup: "unknown" };
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-archive-service-"))), local = join(root, "author"), remote = join(root, "remote.git");
  mkdirSync(local); git(root, "init", "--bare", "-q", remote); git(local, "init", "-qb", "main"); git(local, "config", "user.name", "Test"); git(local, "config", "user.email", "test@example.invalid");
  writeFileSync(join(local, "feature"), "base\n"); git(local, "add", "."); git(local, "commit", "-qm", "base"); const base = `sha1:${git(local, "rev-parse", "HEAD")}`;
  writeFileSync(join(local, "feature"), "candidate\n"); git(local, "commit", "-qam", "candidate"); const source = `sha1:${git(local, "rev-parse", "HEAD")}`;
  const store = SQLStore.sqlite(join(root, "ledger.db")); const ledger = await LedgerFixture.createWithStore(store);
  const run = await ledger.module.startDevRun({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: ledger.issue.issue_id, issue_revision_id: ledger.issue.issue_revision_id, issue_revision_explicit: true, repository_remote_snapshot: ledger.repository.canonical_remote });
  const service = new CandidateArchiveService(store, local, { allowLocalTransport: true });
  const input = { operation_id: newUUIDv7(), purpose: "candidate_submit" as const, owner_id: run.result.context.dev_run.id, request: { explanation: "fixed candidate material", material_digest: "fixed-digest" }, attribution: testAgent, binding: (candidate: string) => collectGitArchiveBinding(local, { repository_id: ledger.repository.repository_id, canonical_remote: pathToFileURL(remote).href, archive_ref: `refs/tags/grounds/candidates/${candidate}`, source_commit: source, base_commit: base }, { allowLocalTransport: true }) };
  return { root, local, remote, source, store, ledger, service, input, close: async () => { await ledger.close(); rmSync(root, { recursive: true, force: true }); } };
}
const conflict = (error: unknown): boolean => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT";

test("prepare durably reserves a stable Candidate and rejects changed request or source", async () => {
  const f = await fixture(); try {
    const first = await f.service.prepare(f.input), identity = archiveOperation(first);
    assert.equal(identity.phase, "prepared"); assert.equal(identity.binding.archive_ref, `refs/tags/grounds/candidates/${identity.candidate_id}`);
    assert.deepEqual(await f.service.prepare(f.input), first);
    const otherStore = SQLStore.sqlite(join(f.root, "ledger.db")); await otherStore.open();
    try {
      const other = new CandidateArchiveService(otherStore, f.local, { allowLocalTransport: true }); assert.deepEqual(await other.prepare(f.input), first);
      const concurrent = { ...f.input, operation_id: newUUIDv7() };
      const [a, b] = await Promise.all([f.service.prepare(concurrent), other.prepare(concurrent)]);
      assert.equal(archiveOperation(a).candidate_id, archiveOperation(b).candidate_id); assert.equal(archiveOperation(a).request_digest, archiveOperation(b).request_digest);
    } finally { await otherStore.close(); }
    await assert.rejects(f.service.prepare({ ...f.input, request: { explanation: "changed" } }), conflict);
    await assert.rejects(f.service.prepare({ ...f.input, candidate_id: newUUIDv7() }), conflict);
    git(f.local, "commit", "--allow-empty", "-qm", "different source same tree"); const moved = `sha1:${git(f.local, "rev-parse", "HEAD")}`;
    await assert.rejects(f.service.prepare({ ...f.input, binding: candidate => ({ ...f.input.binding(candidate), source_commit: moved }) }), conflict);
    assert.deepEqual(await f.service.show(f.input.operation_id), first); assert.equal(git(f.remote, "for-each-ref", "--format=%(refname)"), "");
  } finally { await f.close(); }
});

test("verified but uncommitted operations recheck current policy and reject expiry", async () => {
  const f = await fixture(); try {
    const reserved = archiveOperation(await f.service.prepare(f.input)); let calls = 0;
    const first = await f.service.verify(f.input.operation_id, binding => {
      calls++;
      const independent = new DatabaseSync(join(f.root, "ledger.db"));
      try { independent.exec("BEGIN IMMEDIATE; ROLLBACK"); } finally { independent.close(); }
      return policy(binding);
    }); assert.equal(archiveOperation(first.row).phase, "verified"); assert.equal(calls, 2);
    await assert.rejects(f.service.verify(f.input.operation_id, binding => { calls++; return { ...policy(binding), valid_until: "2000-01-01T00:00:00.000Z" }; })); assert.equal(calls, 3);
    const stopped = archiveOperation(await f.service.show(f.input.operation_id)); assert.equal(stopped.phase, "unknown"); assert.equal(stopped.candidate_id, reserved.candidate_id); assert.equal(stopped.receipt?.status, "unknown");
    assert.equal(inspectGitArchive({ binding: reserved.binding, allowLocalTransport: true }).status, "confirmed");
    await assert.rejects(f.service.committed(f.input.operation_id, { candidate_id: reserved.candidate_id }));
    const retry = await f.service.verify(f.input.operation_id, policy); assert.equal(archiveOperation(retry.row).phase, "verified"); assert.equal(archiveOperation(retry.row).candidate_id, reserved.candidate_id); assert.equal("reason" in archiveOperation(retry.row), false);
  } finally { await f.close(); }
});

test("verified operations check remote object availability again instead of trusting cached receipt", async () => {
  const f = await fixture(); try {
    await f.service.prepare(f.input); const first = await f.service.verify(f.input.operation_id, policy);
    const blob = git(f.local, "rev-parse", "HEAD:feature"); rmSync(join(f.remote, "objects", blob.slice(0, 2), blob.slice(2)));
    await assert.rejects(f.service.verify(f.input.operation_id, policy)); const row = archiveOperation(await f.service.show(f.input.operation_id)); assert.equal(row.phase, "unknown"); assert.equal(row.receipt?.status, "incomplete"); assert.equal(row.candidate_id, archiveOperation(first.row).candidate_id);
  } finally { await f.close(); }
});

test("unknown policy outcome continues with original identity after service restart", async () => {
  const f = await fixture(); try {
    const first = archiveOperation(await f.service.prepare(f.input));
    await assert.rejects(f.service.verify(f.input.operation_id, () => { throw new Error("policy source unavailable"); })); assert.equal(archiveOperation(await f.service.show(f.input.operation_id)).phase, "unknown");
    const replacement = new CandidateArchiveService(f.store, f.local, { allowLocalTransport: true }); const result = await replacement.verify(f.input.operation_id, policy);
    assert.equal(archiveOperation(result.row).candidate_id, first.candidate_id); assert.equal(archiveOperation(result.row).binding.archive_ref, first.binding.archive_ref); assert.equal(result.artifact.receipt.status, "confirmed"); assert.equal(git(f.remote, "for-each-ref", "--format=%(refname)"), first.binding.archive_ref);
  } finally { await f.close(); }
});

test("remote success followed by SQL failure resumes the original reservation", async () => {
  const f = await fixture(); try {
    const reserved = archiveOperation(await f.service.prepare(f.input)); let failNextWrite = false;
    const wrapped = new Proxy(f.store, { get(target, property) { if (property === "write") return async (callback: Parameters<Store["write"]>[0]) => { if (failNextWrite) { failNextWrite = false; throw new DomainError("STORAGE_TRANSIENT", "injected database interruption", true); } return target.write(callback); }; const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } }) as Store;
    const interrupted = new CandidateArchiveService(wrapped, f.local, { allowLocalTransport: true }); let checks = 0;
    await assert.rejects(interrupted.verify(f.input.operation_id, binding => { if (++checks === 2) failNextWrite = true; return policy(binding); }), /injected database interruption/);
    assert.equal(archiveOperation(await f.service.show(f.input.operation_id)).phase, "prepared"); assert.equal(inspectGitArchive({ binding: reserved.binding, allowLocalTransport: true }).status, "confirmed");
    const result = await f.service.verify(f.input.operation_id, policy); assert.equal(archiveOperation(result.row).candidate_id, reserved.candidate_id); assert.equal(result.artifact.receipt.remote_source_commit, f.source); assert.equal(git(f.remote, "for-each-ref", "--format=%(refname)"), reserved.binding.archive_ref);
  } finally { await f.close(); }
});

test("committed operation reuses immutable historical receipt without policy or network", async () => {
  const f = await fixture(); try {
    await f.service.prepare(f.input); const checked = await f.service.verify(f.input.operation_id, policy); const result = { candidate_id: archiveOperation(checked.row).candidate_id };
    const committed = await f.service.committed(f.input.operation_id, result); assert.equal(archiveOperation(committed).phase, "committed"); rmSync(f.remote, { recursive: true });
    const replay = await f.service.verify(f.input.operation_id, () => { throw new Error("historical read must not contact policy"); }); assert.deepEqual(replay.row, committed); assert.deepEqual(replay.artifact.receipt, checked.artifact.receipt);
    assert.deepEqual(await f.service.committed(f.input.operation_id, { attempted_overwrite: true }), committed); assert.deepEqual(archiveOperation(await f.service.show(f.input.operation_id)).result, result);
  } finally { await f.close(); }
});
