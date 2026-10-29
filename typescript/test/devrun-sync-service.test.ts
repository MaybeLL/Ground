import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LedgerFixture, testAgent } from "./fixture.js";
import { reviseTargetIssue, seedStartPreflight, seedRunAdmission, ledgerOnlyPreflightCoordinator } from "./preflight-fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { DevRunSyncService } from "../src/devrun-sync-service.js";
import { syncData } from "../src/devrun-sync-record.js";
import { sha256 } from "../src/canonical-json.js";
import { reconcileDevRun, listUncommittedWork } from "../src/reconcile-service.js";
import { assertContract } from "./schema-fixture.js";
import { SQLStore } from "../src/sql-store.js";
import { runCLI } from "../src/cli.js";
import { captureCommittedCandidate } from "../src/development-branch.js";
import { captureArtifact } from "../src/git.js";
import { renderReviewMarkdown } from "../src/review.js";
import { withRuntimeDirectories, withRuntimeLock, directoryRegistryRoot } from "../src/runtime-files.js";
import { reservePhysicalDirectory, releasePhysicalDirectory, physicalClaims, physicalIdentity, assertPhysicalDirectoryFree } from "../src/physical-directory.js";

const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
async function fixture(t: { after: (f: () => Promise<void>) => void }, conflict = false, environment = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-sync-service-"))), source = join(root, "source"), remote = join(root, "remote.git"); mkdirSync(source);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init", "--bare", "-q", remote); git(source, "init", "-qb", "main"); git(source, "config", "user.name", "Test"); git(source, "config", "user.email", "test@invalid");
  git(source, "remote", "add", "origin", "ssh://git@example.test/team/repo");
  git(source, "config", `url.file://${remote}.insteadOf`, "ssh://git@example.test/team/repo");
  if (environment) {
    writeFileSync(join(source, "package.json"), JSON.stringify({name:"sync-fixture",version:"1.0.0"}));
    writeFileSync(join(source, "package-lock.json"), JSON.stringify({name:"sync-fixture",version:"1.0.0",lockfileVersion:3,packages:{"":{name:"sync-fixture",version:"1.0.0"}}}));
    writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  }
  writeFileSync(join(source, "file"), "base\n"); git(source, "add", "."); git(source, "commit", "-qm", "base"); const base = `sha1:${git(source, "rev-parse", "HEAD")}`;
  writeFileSync(join(source, conflict ? "file" : "upstream"), "upstream\n"); git(source, "add", "."); git(source, "commit", "-qm", "advance"); const target = `sha1:${git(source, "rev-parse", "HEAD")}`;
  git(source, "push", remote, "HEAD:refs/heads/main"); git(source, "fetch", "origin");
  const databasePath = join(root, "ledger.db");
  const store = SQLStore.sqlite(databasePath);
  // This fixture's remote has already advanced to `target`; its start is a
  // ledger-only boundary stub, with the Issue-version assessment it needs seeded.
  const f = await LedgerFixture.createWithStore(store, () => store.close(), { preflightCoordinator: ledgerOnlyPreflightCoordinator(store) }); t.after(async () => { await f.close(); rmSync(root, { recursive: true, force: true }); });
  const revised = await reviseTargetIssue(f.module, f.store, source, { ...actor(), issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id,
    requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: { git_oid: base, reachability: "remote_tracking_reachable" },
    input: { format: 1, summary: "Sync feature", target_branch: { remote: "origin", ref: "refs/heads/main" }, goals: [{ statement: "Feature", criteria: ["Feature works"] }] } });
  await seedStartPreflight(store, { repositoryId: f.repository.repository_id, canonicalRemote: f.repository.canonical_remote, issueId: f.issue.issue_id, issueRevisionId: revised.result.issue_revision_id, target: { remote: "origin", ref: "refs/heads/main" }, commit: base });
  const database = (await f.store.inspect()).database_id;
  const worktrees = new DevWorktreeModule(source, database, newUUIDv7, f.store, environment ? directoryRegistryRoot() : join(root, "registry")), op = actor();
  const started = await worktrees.start({ operation_id: op.operation_id, repository_id: f.repository.repository_id, issue_revision_id: revised.result.issue_revision_id, baseline_oid: base }, async id => {
    const value = await f.module.startDevRun({ ...op, dev_run_id: id, issue_id: f.issue.issue_id, issue_revision_id: revised.result.issue_revision_id, issue_revision_explicit: true, repository_remote_snapshot: f.repository.canonical_remote });
    return { value, dev_run_id: id };
  });
  assert.equal(started.local_worktree.status, "available"); if (started.local_worktree.status !== "available") throw new Error("missing");
  const path = started.local_worktree.path, runId = started.value.result.context.dev_run.id;
  writeFileSync(join(path, "file"), "ours\n");
  const service = new DevRunSyncService(f.store, worktrees);
  return { root, source, f, database, databasePath, worktrees, service, path, runId, base, target, git };
}

test("offline idle/unknown lease fences sync, capture, submit and cleanup; pending sync fences the reverse direction", async t => {
  const x = await fixture(t, true), registry = join(x.root, "registry");
  const claim = {kind:"environment" as const,owner:join(x.root,"arbitrary-environment-root"),id:"offline-lease",directory:x.path,identity:physicalIdentity(x.path)};
  await withRuntimeLock(registry,"directory-registry",async()=>reservePhysicalDirectory(registry,claim));
  const before = x.git(x.path,"status","--porcelain");
  await assert.rejects(x.service.start(x.runId,1,x.target,true,actor()));
  await assert.rejects(x.worktrees.capture(x.runId,async()=>{throw new Error("must not enter capture");}), /persistent environment/);
  await assert.rejects(x.worktrees.submit(x.runId,async()=>{throw new Error("must not enter submit");}), /persistent environment/);
  await assert.rejects(x.worktrees.cleanup(x.runId,"submitted",true), /persistent environment/);
  assert.equal(x.git(x.path,"status","--porcelain"),before);
  assert.equal((await x.f.store.read(tx=>tx.getDevRun(x.runId))).version,1);
  await withRuntimeLock(registry,"directory-registry",async()=>releasePhysicalDirectory(registry,claim));
  const pending=await x.service.start(x.runId,1,x.target,true,actor());
  await withRuntimeLock(registry,"directory-registry",async()=>{
    assert.equal(Object.values(physicalClaims(registry))[0]!.kind,"sync");
    assert.throws(()=>reservePhysicalDirectory(registry,claim));
  });
  await x.service.abandon(pending.id,pending.version,actor());
  await withRuntimeLock(registry,"directory-registry",async()=>assertPhysicalDirectoryFree(x.path,registry));
});

test("pre-SQL sync intent survives a dead controller until authoritative absence recovery", async t => {
  const x=await fixture(t), registry=join(x.root,"registry");
  const claim={kind:"sync" as const,owner:`${x.database}:${x.runId}`,id:newUUIDv7(),directory:x.path,identity:physicalIdentity(x.path)};
  await withRuntimeLock(registry,"directory-registry",async()=>reservePhysicalDirectory(registry,claim));
  await assert.rejects(x.worktrees.capture(x.runId,async()=>"unsafe"));
  const recovered=await x.service.start(x.runId,1,x.target,true,actor());
  assert.equal(syncData(recovered).phase,"completed");
  await withRuntimeLock(registry,"directory-registry",async()=>assert.equal(Object.keys(physicalClaims(registry)).length,0));
});

test("real managed worktree sync commits a file-derived SQL receipt and advances capture base", async t => {
  const x = await fixture(t), op = actor();
  const done = await x.service.start(x.runId, 1, x.target, true, op);
  assert.equal(syncData(done).phase, "completed");
  assert.equal((await x.f.store.read(tx => tx.getDevRun(x.runId))).base_commit, x.target);
  assert.equal(x.worktrees.observe(x.runId).journal!.lifecycle, "active");
  assert.equal(readFileSync(join(x.path, "upstream"), "utf8"), "upstream\n");
  assert.equal(await x.worktrees.capture(x.runId, async () => "capturable"), "capturable");
  assert.equal((await x.service.start(x.runId, 1, x.target, true, op)).id, done.id);
  const uncommitted = await listUncommittedWork(x.f.module, x.database, x.source);
  assertContract("query-results.schema.json", uncommitted);
  assert.match(JSON.stringify(uncommitted), /sync_recovery/);
  const integrity = (await x.f.store.inspectIntegrity()).report;
  assert.equal(integrity.valid, true, JSON.stringify(integrity));
});

test("conflicted sync is recognized, blocks capture/cleanup/abandon and completes a zero-diff resolution", async t => {
  const x = await fixture(t, true), op = actor(), pending = await x.service.start(x.runId, 1, x.target, true, op);
  assert.equal(syncData(pending).phase, "resolving");
  await assert.rejects(x.worktrees.capture(x.runId, async () => "must not run"));
  await assert.rejects(x.worktrees.cleanup(x.runId, "submitted", true));
  await assert.rejects(x.worktrees.markAbandoned(x.runId));
  const reconcile = await reconcileDevRun(x.f.module, x.database, x.source, x.runId);
  assertContract("query-results.schema.json", reconcile);
  assert.match(JSON.stringify(reconcile), /sync_in_progress/); assert.doesNotMatch(JSON.stringify(reconcile), /local_state_unrecognized/);
  const journalPath = join(syncData(pending).recovery.directory, "journal.json"), originalJournal = readFileSync(journalPath);
  const altered = JSON.parse(originalJournal.toString("utf8")); altered.journal.id = newUUIDv7(); altered.digest = sha256(altered.journal);
  writeFileSync(journalPath, JSON.stringify(altered));
  await assert.rejects(x.service.complete(pending.id, pending.version, [], actor()), /canonical sync reservation/);
  await assert.rejects(x.service.abandon(pending.id, pending.version, actor()), /canonical sync reservation/);
  writeFileSync(journalPath, originalJournal);
  await assert.rejects(x.service.complete(pending.id, pending.version, [], actor()));
  writeFileSync(join(x.path, "file"), "upstream\n"); x.git(x.path, "add", "file");
  const current = await x.service.show(pending.id);
  const explanation = "验证".repeat(1900) + "采用上游实现，最终不产生候选差异";
  const done = await x.service.complete(current.id, current.version, [{ path: "file", explanation }], actor());
  const integrity = await x.f.store.inspectIntegrity(); assert.equal(integrity.report.valid, true, JSON.stringify(integrity.report));
  assert.equal(syncData(done).phase, "completed"); assert.equal(syncData(done).decisions![0]!.path, "file");
  assert.equal(x.git(x.path, "diff", "HEAD", "--name-only"), "");
  writeFileSync(join(x.path, "feature"), "a distinct candidate change\n");
  // The completed sync moved the run's inputs, so this ledger-only fixture
  // records the fresh admission the real observe/admit step would precede submit.
  await seedRunAdmission(x.f.store, { devRunId: x.runId });
  const submission = (await x.f.module.candidateSubmissionTemplate(x.runId)).submission;
  submission.explanation = "独立实现功能";
  for (const claim of submission.claims) { claim.explanation = "实现功能"; for (const criterion of claim.criteria) criterion.explanation = "已实现并检查"; }
  x.git(x.path, "add", "feature"); x.git(x.path, "commit", "-qm", "fixed feature after sync");
  const fixed = captureCommittedCandidate(x.path, x.target);
  const candidate = await x.f.module.submitCandidate({ ...actor(), dev_run_id: x.runId, expected_version: 3, submission, ...fixed, ...x.f.gitCandidateFields(fixed.artifact, x.target, fixed.source) });
  const review = await x.f.module.reviewCandidate(candidate.candidate_id);
  assertContract("query-results.schema.json", review);
  assert.equal(review.trace.sync_records![0]!.decisions[0]!.explanation, explanation);
  assert.match(renderReviewMarkdown(review), /采用上游实现/);
  const blind = await x.f.module.verificationContext(candidate.candidate_id, "blind");
  assert.doesNotMatch(JSON.stringify(blind), /采用上游实现|sync_records/);
});

test("public CLI sync status/start/show and contract validation use the real file-backed protocol", async t => {
  const x = await fixture(t), config = join(x.root, "config.yaml");
  const run = async (args: string[]) => {
    const output: string[] = [];
    const code = await withRuntimeDirectories({ runtimeHome: join(x.root, "runtime"), directoryRegistryHome: join(x.root, "registry") }, () => runCLI([...args, "--json"], { cwd: x.source, stdout: line => output.push(line), stderr: () => {} }));
    const envelope = JSON.parse(output.join("\n")); assert.equal(code, 0, JSON.stringify(envelope)); return envelope;
  };
  await run(["init", "--driver", "sqlite", "--path", x.databasePath, "--config", config, "--non-interactive"]);
  const offline = await run(["devrun", "sync-status", "--dev-run", x.runId, "--config", config]);
  assertContract("cli-envelope.schema.json", offline); assert.equal(offline.data.status.target_observation.refreshed, false);
  const synced = await run(["devrun", "sync", "--dev-run", x.runId, "--expected-version", "1", "--target-commit", x.target, "--refresh", "--agent-id", "sync-cli", "--agent-name", "Sync CLI", "--config", config]);
  assertContract("cli-envelope.schema.json", synced); assert.equal(synced.data.sync.data.phase, "completed");
  const shown = await run(["devrun", "sync-show", "--sync", synced.data.sync.id, "--config", config]);
  assertContract("cli-envelope.schema.json", shown); assert.deepEqual(shown.data.sync, synced.data.sync);
  const context = await run(["devrun", "context", "--dev-run", x.runId, "--config", config]);
  assert.equal(context.data.context.base_commit, x.target); assert.equal(context.data.local_worktree.status, "available");
});

for (const step of ["index-locked", "after-sql-finish"]) test(`SIGKILL at ${step} is recognized by reconcile and recoverable through a new controller`, async t => {
  const x = await fixture(t), op = actor();
  const base = new URL("../src/", import.meta.url);
  const script = `import {SQLStore} from ${JSON.stringify(new URL("sql-store.ts", base).href)};
    import {DevWorktreeModule} from ${JSON.stringify(new URL("dev-worktree.ts", base).href)};
    import {DevRunSyncService} from ${JSON.stringify(new URL("devrun-sync-service.ts", base).href)};
    import {newUUIDv7} from ${JSON.stringify(new URL("identity.ts", base).href)};
    const store=SQLStore.sqlite(${JSON.stringify(x.databasePath)}); await store.open();
    const worktrees=new DevWorktreeModule(${JSON.stringify(x.source)},${JSON.stringify(x.database)},newUUIDv7,store,${JSON.stringify(join(x.root, "registry"))});
    const sync=new DevRunSyncService(store,worktrees,s=>{if(s===${JSON.stringify(step)})process.kill(process.pid,'SIGKILL')});
    await sync.start(${JSON.stringify(x.runId)},1,${JSON.stringify(x.target)},true,${JSON.stringify(op)});`;
  const killed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30000 });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  const reconcile = await reconcileDevRun(x.f.module, x.database, x.source, x.runId);
  assert.match(JSON.stringify(reconcile), /sync_interrupted/);
  assertContract("query-results.schema.json", reconcile);
  const row = await x.service.show(op.operation_id);
  // Preserve the production 60-second orphan grace; advance only the test
  // clock after SIGKILL, never delete a registry lock or shorten its policy.
  const now = Date.now.bind(Date);
  t.mock.method(Date, "now", () => now() + 61000);
  const done = step === "after-sql-finish" ? await x.service.complete(row.id, row.version, [], actor()) : await x.service.abandon(row.id, row.version, actor());
  assert.ok(["completed", "abandoned"].includes(syncData(done).phase));
  assert.equal(x.worktrees.observe(x.runId).journal!.lifecycle, "active");
});

for (const step of ["before-sql-finish", "after-sql-finish"]) test(`recovers local/SQL divergence at ${step} without reapplying files`, async t => {
  const x = await fixture(t), op = actor();
  const failing = new DevRunSyncService(x.f.store, x.worktrees, s => { if (s === step) throw new Error("injected SQL boundary"); });
  await assert.rejects(failing.start(x.runId, 1, x.target, true, op), /injected/);
  assert.equal(x.worktrees.observe(x.runId).journal!.lifecycle, "sync_interrupted");
  const row = await x.service.show(op.operation_id);
  const done = await x.service.complete(row.id, row.version, [], actor());
  assert.equal(syncData(done).phase, "completed"); assert.equal(x.worktrees.observe(x.runId).journal!.lifecycle, "active");
  assert.equal(x.git(x.path, "rev-parse", "HEAD"), x.target.slice(5));
});

test("interrupted applied sync can abandon through both stores while preserving later edits", async t => {
  const x = await fixture(t), op = actor();
  const failing = new DevRunSyncService(x.f.store, x.worktrees, s => { if (s === "index-locked") throw new Error("interrupted apply"); });
  await assert.rejects(failing.start(x.runId, 1, x.target, true, op), /interrupted/);
  writeFileSync(join(x.path, "later"), "save this edit\n");
  const row = await x.service.show(op.operation_id);
  const interruptedAbandon = new DevRunSyncService(x.f.store, x.worktrees, s => { if (s === "before-sql-finish") throw new Error("interrupted abandonment"); });
  await assert.rejects(interruptedAbandon.abandon(row.id, row.version, actor()), /interrupted abandonment/);
  writeFileSync(join(x.path, "after-receipt"), "preserve this newer edit too\n");
  const retry = await x.service.show(row.id), done = await x.service.abandon(row.id, retry.version, actor());
  assert.equal(syncData(done).phase, "abandoned"); assert.equal((await x.f.store.read(tx => tx.getDevRun(x.runId))).base_commit, x.base);
  assert.equal(x.worktrees.observe(x.runId).journal!.lifecycle, "active");
  assert.equal(x.git(x.path, "rev-parse", "HEAD"), x.base.slice(5));
  const journal = JSON.parse(readFileSync(join(syncData(done).recovery.directory, "journal.json"), "utf8")).journal;
  assert.equal(journal.saved_edits.length, 2);
  const backup = join(syncData(done).recovery.directory, journal.saved_edits[1]);
  const manifest = JSON.parse(readFileSync(join(backup, "files.json"), "utf8"));
  assert.equal(readFileSync(join(backup, "blobs", manifest.entries["after-receipt"].digest.slice(7)), "utf8"), "preserve this newer edit too\n");
});
