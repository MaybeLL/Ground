import { repositoryDataRoot } from "../src/data-layout.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCLI } from "../src/cli.js";
import { newUUIDv7 } from "../src/identity.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const runtimeScratch = realpathSync(mkdtempSync(join(tmpdir(), "grounds-baseline-runtime-")));
after(() => rmSync(runtimeScratch, { recursive: true, force: true }));

const run = async (args: string[], cwd: string): Promise<{ code: number; text: string }> => {
  const out: string[] = [];
  const code = await withRuntimeDirectories({ runtimeHome: join(runtimeScratch, "runtime"), directoryRegistryHome: join(runtimeScratch, "registry") }, () => runCLI(args, { stdout: (line) => out.push(line), stderr: () => undefined, cwd }));
  return { code, text: out.join("\n") };
};

test("an unpublished baseline warning is diagnostic", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-baseline-"));
  const repo = join(root, "repo");
  const db = join(root, "ledger.db");
  const cfg = join(root, "config.yaml");
  try {
    execFileSync("git", ["init", "-q", repo]);
    git(repo, "config", "user.name", "T");
    git(repo, "config", "user.email", "t@example.test");
    writeFileSync(join(repo, "a.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "base");
    // A configured but never-fetched remote leaves the baseline unreachable
    // from any remote-tracking ref, without needing a second repository.
    git(repo, "remote", "add", "origin", "ssh://git@example.test/team/unpublished");
    const init = await run(["init", "--driver", "sqlite", "--path", db, "--config", cfg, "--non-interactive", "--json"], root);
    assert.equal(init.code, 0, init.text);
    const created = await run(["workspace", "new", "--format", "markdown", "diagnostic", "--config", cfg, "--json"], repo);
    assert.equal(created.code, 0, created.text);
    const issue = await run([
      "workspace", "publish", "diagnostic",
      "--config", cfg,
      "--allow-unpublished-baseline",
      "--override-reason", "test override",
      "--json",
    ], repo);
    assert.equal(issue.code, 0, issue.text);
    const envelope = JSON.parse(issue.text) as { warnings: { code: string; message: string }[] };
    const warning = envelope.warnings.find((entry) => entry.code === "BASELINE_UNCONFIRMED");
    assert.ok(warning, "expected a BASELINE_UNCONFIRMED warning");
    assert.match(warning.message, /not reachable/);
    assert.match(warning.message, /refs\/remotes\/origin/);
    assert.match(warning.message, /fetch|publish/);
    assert.match(warning.message, /does not block a local DevRun/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("devrun start always builds a managed detached baseline worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-devrun-wt-"));
  const repo = join(root, "repo");
  const db = join(root, "ledger.db");
  const cfg = join(root, "config.yaml");
  try {
    execFileSync("git", ["init", "-q", repo]);
    git(repo, "config", "user.name", "T");
    git(repo, "config", "user.email", "t@example.test");
    writeFileSync(join(repo, "a.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", "ssh://git@example.test/team/repo");
    const head = git(repo, "rev-parse", "HEAD");

    await run(["init", "--driver", "sqlite", "--path", db, "--config", cfg, "--non-interactive", "--json"], root);
    const created = await run(["workspace", "new", "--format", "markdown", "devrun", "--config", cfg, "--json"], repo);
    assert.equal(created.code, 0, created.text);
    const issue = await run([
      "workspace", "publish", "devrun",
      "--config", cfg,
      "--allow-unpublished-baseline",
      "--override-reason", "t",
      "--json",
    ], repo);
    assert.equal(issue.code, 0, issue.text);
    const publication = (JSON.parse(issue.text) as { data: { repository_id: string; issues: { id: string }[] } }).data;
    const issueId = publication.issues[0].id;

    const wrongClone = join(root, "wrong-clone");
    execFileSync("git", ["clone", "-q", repo, wrongClone]);
    git(wrongClone, "remote", "set-url", "origin", "ssh://git@example.test/other/repo");
    const wrongRepository = await run(["devrun", "start", "--development-mode", "simple", "--config", cfg, "--issue", issueId, "--repository", publication.repository_id, "--cwd", wrongClone, "--json"], root);
    assert.equal(wrongRepository.code, 6, wrongRepository.text);
    assert.match(wrongRepository.text, /does not match the Repository|not registered/i);

    // The caller launches outside the Repository and selects the clone explicitly.
    const start = await run(["devrun", "start", "--development-mode", "simple", "--config", cfg, "--issue", issueId, "--cwd", repo, "--json"], root);
    assert.equal(start.code, 0, start.text);
    const started = JSON.parse(start.text) as { operation_id: string; data: { context: { dev_run: { id: string } }; local_worktree: { status: string; path: string } } };
    assert.equal(started.data.local_worktree.status, "available");
    const worktree = started.data.local_worktree.path;
    assert.match(worktree, /\.grounds\/repositories\/[a-f0-9]{64}\/devruns\/.+\/worktree$/);
    assert.equal(existsSync(join(worktree, "a.txt")), true);
    assert.equal(git(worktree, "rev-parse", "HEAD"), head);
    assert.equal(git(worktree, "branch", "--show-current"), "");

    const replay = await run(["devrun", "start", "--development-mode", "simple", "--config", cfg, "--issue", issueId, "--operation-id", started.operation_id, "--json"], repo);
    const replayed = JSON.parse(replay.text) as { data: { context: { dev_run: { id: string } }; local_worktree: { path: string } } };
    assert.equal(replayed.data.context.dev_run.id, started.data.context.dev_run.id);
    assert.equal(replayed.data.local_worktree.path, worktree);

    const conflictingReplay = await run(["devrun", "start", "--development-mode", "simple", "--config", cfg, "--issue", issueId, "--operation-id", started.operation_id, "--exploration-brief", "different request", "--json"], repo);
    assert.equal(conflictingReplay.code, 4, conflictingReplay.text);
    assert.equal(existsSync(worktree), true, "a conflicting replay must not delete the original DevRun worktree");

    const resumed = await run(["devrun", "context", started.data.context.dev_run.id, "--config", cfg, "--json"], repo);
    assert.equal((JSON.parse(resumed.text) as { data: { local_worktree: { path: string } } }).data.local_worktree.path, worktree);

    const second = await run(["devrun", "start", "--development-mode", "simple", "--config", cfg, "--issue", issueId, "--json"], repo);
    const secondRun = JSON.parse(second.text) as { data: { context: { dev_run: { id: string } }; local_worktree: { path: string } } };
    assert.notEqual(secondRun.data.context.dev_run.id, started.data.context.dev_run.id);
    assert.notEqual(secondRun.data.local_worktree.path, worktree);

    const concurrentOperation = newUUIDv7();
    const staleLock = join(repositoryDataRoot(repo), "devruns", ".locks", `operation-${concurrentOperation}`);
    mkdirSync(staleLock);
    writeFileSync(join(staleLock, "owner.json"), JSON.stringify({ pid: 999_999_999, created_at_ms: 0 }));
    const concurrentArgs = ["devrun", "start", "--development-mode", "simple", "--config", cfg, "--issue", issueId, "--operation-id", concurrentOperation, "--json"];
    const [concurrentA, concurrentB] = await Promise.all([run(concurrentArgs, repo), run(concurrentArgs, repo)]);
    assert.equal(concurrentA.code, 0, concurrentA.text);
    assert.equal(concurrentB.code, 0, concurrentB.text);
    const concurrentAData = (JSON.parse(concurrentA.text) as { data: { context: { dev_run: { id: string } }; local_worktree: { path: string } } }).data;
    const concurrentBData = (JSON.parse(concurrentB.text) as { data: { context: { dev_run: { id: string } }; local_worktree: { path: string } } }).data;
    assert.equal(concurrentAData.context.dev_run.id, concurrentBData.context.dev_run.id);
    assert.equal(concurrentAData.local_worktree.path, concurrentBData.local_worktree.path);

    const other = join(root, "other-clone");
    execFileSync("git", ["clone", "-q", repo, other]);
    git(other, "remote", "set-url", "origin", "ssh://git@example.test/team/repo");
    const remoteContext = await run(["devrun", "context", started.data.context.dev_run.id, "--config", cfg, "--json"], other);
    const remoteLocal = (JSON.parse(remoteContext.text) as { data: { local_worktree: { status: string; reason: string } } }).data.local_worktree;
    assert.deepEqual(remoteLocal, { status: "missing", reason: "not_available_on_this_machine" });
    assert.equal(existsSync(join(other, ".grounds")), false, "context inspection must not create local state");

    const openCleanup = await run(["devrun", "cleanup", started.data.context.dev_run.id, "--config", cfg, "--json"], repo);
    assert.equal(openCleanup.code, 4, openCleanup.text);
    const abandoned = await run(["devrun", "abandon", started.data.context.dev_run.id, "--config", cfg, "--expected-version", "1", "--json"], repo);
    assert.equal(abandoned.code, 0, abandoned.text);
    const cleanup = await run(["devrun", "cleanup", started.data.context.dev_run.id, "--config", cfg, "--json"], repo);
    assert.equal(cleanup.code, 0, cleanup.text);
    assert.equal((JSON.parse(cleanup.text) as { data: { removed: boolean; local_worktree: { status: string } } }).data.removed, true);
    assert.equal(existsSync(worktree), false);
    const repeatedCleanup = await run(["devrun", "cleanup", started.data.context.dev_run.id, "--config", cfg, "--json"], repo);
    assert.deepEqual((JSON.parse(repeatedCleanup.text) as { data: { removed: boolean; local_worktree: { status: string } } }).data, {
      result_type: "patchledger.result.devrun-worktree-cleanup/v1",
      command: "devrun.cleanup",
      dev_run_id: started.data.context.dev_run.id,
      removed: false,
      local_worktree: { status: "removed" },
    });
    const replayAfterCleanup = await run(["devrun", "start", "--development-mode", "simple", "--config", cfg, "--issue", issueId, "--operation-id", started.operation_id, "--json"], repo);
    const replayAfterCleanupData = (JSON.parse(replayAfterCleanup.text) as { data: { local_worktree: { status: string } } }).data;
    assert.equal(replayAfterCleanupData.local_worktree.status, "removed");
    assert.equal(existsSync(worktree), false, "an idempotent start replay must not resurrect a cleaned worktree");

    const exclude = join(repo, ".git", "info", "exclude");
    writeFileSync(exclude, readFileSync(exclude, "utf8") + "*.scratch\n");
    writeFileSync(join(secondRun.data.local_worktree.path, "keep.scratch"), "ignored but valuable\n");
    await run(["devrun", "abandon", secondRun.data.context.dev_run.id, "--config", cfg, "--expected-version", "1", "--json"], repo);
    const unsafe = await run(["devrun", "cleanup", secondRun.data.context.dev_run.id, "--config", cfg, "--json"], repo);
    assert.equal(unsafe.code, 6, unsafe.text);
    const forced = await run(["devrun", "cleanup", secondRun.data.context.dev_run.id, "--config", cfg, "--discard-changes", "--json"], repo);
    assert.equal(forced.code, 0, forced.text);
    assert.equal(existsSync(secondRun.data.local_worktree.path), false);

    const third = await run(["devrun", "start", "--development-mode", "simple", "--config", cfg, "--issue", issueId, "--json"], repo);
    const thirdRun = (JSON.parse(third.text) as { data: { context: { dev_run: { id: string } }; local_worktree: { path: string } } }).data;
    git(repo, "worktree", "remove", "--force", thirdRun.local_worktree.path);
    const deletedContext = await run(["devrun", "context", thirdRun.context.dev_run.id, "--config", cfg, "--json"], repo);
    assert.deepEqual((JSON.parse(deletedContext.text) as { data: { local_worktree: unknown } }).data.local_worktree, { status: "missing", reason: "local_worktree_deleted" });
    writeFileSync(join(repositoryDataRoot(repo), "devruns", thirdRun.context.dev_run.id, "state.json"), "{not-json\n");
    const invalidContext = await run(["devrun", "context", thirdRun.context.dev_run.id, "--config", cfg, "--json"], repo);
    assert.equal((JSON.parse(invalidContext.text) as { data: { local_worktree: { status: string } } }).data.local_worktree.status, "invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
