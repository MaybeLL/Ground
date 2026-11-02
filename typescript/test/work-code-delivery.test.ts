import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeWork } from "../src/work/composition.js";
import type { WorkApplication } from "../src/work/application/index.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { openLedger } from "./backends.js";
import { refused, value } from "./work-application-harness.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

async function scenario(run: (t: { app: WorkApplication; repo: string; remote: string; baseline: string; root: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "grounds-delivery-"));
  const fixture = await openLedger("sqlite");
  try {
    const repo = join(root, "repo"), remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "a.txt"), "a\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
    await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, () => run({ app: composeWork(fixture.store), repo, remote, baseline: git(repo, "rev-parse", "HEAD"), root }));
  } finally { await fixture.close(); rmSync(root, { recursive: true, force: true }); }
}

const task = async (app: WorkApplication, repository?: { remote: string; baseline: string }) =>
  value(await app.tasks.createTask({ requestId: `t-${Math.random()}`, summary: "Add export", criteria: [{ statement: "exports CSV" }], ...(repository ? { repository } : {}) }));

test("delivering is refused for what cannot be delivered, before anything is submitted", async () => {
  await scenario(async ({ app, repo, remote, baseline }) => {
    const withRepo = await task(app, { remote, baseline });
    const run = value(await app.exec.startWork({ requestId: "w-1", taskDefinitionId: withRepo.taskId, workerMode: "none" }));
    refused(await app.delivery.deliver({ requestId: "d-0", runId: "no-such-run", repositoryPath: repo, commit: "HEAD" }), "not-found");
    refused(await app.delivery.deliver({ requestId: "d-1", runId: run.runId, repositoryPath: repo, commit: "no-such-commit" }), "invalid", /not a commit/);
    refused(await app.delivery.deliver({ requestId: "d-2", runId: run.runId, repositoryPath: repo, commit: "HEAD", remote: join(repo, "..", "nowhere.git") }), "unavailable");
    assert.equal(value(await app.exec.getRun(run.runId)).run.status, "pending", "nothing was submitted, so the round never started");
    assert.equal(value(await app.exec.getRun(run.runId)).run.manifest, undefined);
    // A task that names no remote needs one from the caller.
    const bare = await task(app);
    const other = value(await app.exec.startWork({ requestId: "w-2", taskDefinitionId: bare.taskId, workerMode: "none" }));
    refused(await app.delivery.deliver({ requestId: "d-3", runId: other.runId, repositoryPath: repo, commit: "HEAD" }), "invalid", /no repository remote/);
    const given = value(await app.delivery.deliver({ requestId: "d-4", runId: other.runId, repositoryPath: repo, commit: "HEAD", remote }));
    assert.equal(given.submitted.status, "delivered");
  });
});

test("a tag already taken by another commit under the same delivery identity is a conflict", async () => {
  await scenario(async ({ app, repo, remote, baseline }) => {
    const created = await task(app, { remote, baseline });
    const run = value(await app.exec.startWork({ requestId: "w-1", taskDefinitionId: created.taskId, workerMode: "none" }));
    writeFileSync(join(repo, "a.txt"), "b\n"); git(repo, "commit", "-qam", "change");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "-q", remote, `${baseline}:refs/tags/grounds/deliveries/d-${run.runId}-${head.slice(0, 12)}`);
    refused(await app.delivery.deliver({ requestId: "d-1", runId: run.runId, repositoryPath: repo, commit: head }), "conflict", /already points at/);
    assert.equal(value(await app.exec.getRun(run.runId)).run.manifest, undefined);
  });
});

test("a workspace is prepared only for a run that can still do work, from what it starts from, and again as the same place", async () => {
  await scenario(async ({ app, repo, remote, baseline, root }) => {
    refused(await app.delivery.prepareWorkspace({ runId: "no-such-run", repositoryPath: repo }), "not-found");
    const noBaseline = await task(app);
    const bare = value(await app.exec.startWork({ requestId: "w-0", taskDefinitionId: noBaseline.taskId, workerMode: "none" }));
    refused(await app.delivery.prepareWorkspace({ runId: bare.runId, repositoryPath: repo }), "invalid", /baseline/);
    const created = await task(app, { remote, baseline: "main" });
    const run = value(await app.exec.startWork({ requestId: "w-1", taskDefinitionId: created.taskId, workerMode: "none" }));
    const first = value(await app.delivery.prepareWorkspace({ runId: run.runId, repositoryPath: repo }));
    assert.deepEqual([first.created, first.base.from, first.base.commit], [true, "baseline", baseline]);
    const again = value(await app.delivery.prepareWorkspace({ runId: run.runId, repositoryPath: repo }));
    assert.deepEqual([again.created, again.path], [false, first.path]);
    // Deliver, then a refinement of a run that delivered nothing, and of a delivery whose tag was removed.
    writeFileSync(join(first.path, "a.txt"), "b\n"); git(first.path, "commit", "-qam", "change");
    const delivered = value(await app.delivery.deliver({ requestId: "d-1", runId: run.runId, repositoryPath: first.path, commit: "HEAD" }));
    refused(await app.delivery.prepareWorkspace({ runId: run.runId, repositoryPath: repo }), "conflict", /already delivered/);
    const refinement = value(await app.exec.continueWork({ requestId: "c-1", workId: run.workId, expectedHead: run.runId, workerMode: "none" }));
    const branch = value(await app.exec.addBranch({ requestId: "b-1", workId: run.workId, refines: run.runId, workerMode: "none" }));
    value(await app.exec.cancel({ requestId: "x-1", runId: branch.runId }));
    const fromCancelled = value(await app.exec.addBranch({ requestId: "b-2", workId: run.workId, refines: branch.runId, workerMode: "none" }));
    refused(await app.delivery.prepareWorkspace({ runId: fromCancelled.runId, repositoryPath: repo }), "conflict", /delivered no code/);
    git(root, "--git-dir", remote, "tag", "-d", `grounds/deliveries/${delivered.delivery.id}`);
    refused(await app.delivery.prepareWorkspace({ runId: refinement.runId, repositoryPath: repo }), "conflict", /no longer shows/);
  });
});
