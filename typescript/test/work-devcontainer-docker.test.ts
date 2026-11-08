import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DevcontainerRuntime } from "../src/work/adapters/devcontainer/runtime.js";

test("three devcontainers isolate workspace writes and lifecycle operations by ledger and sandbox", { skip: !process.env.GROUNDS_TEST_DEVCONTAINER && "requires Docker and devcontainers CLI" }, async () => {
  const runtime = new DevcontainerRuntime(process.env.GROUNDS_TEST_DEVCONTAINER);
  const image = execFileSync("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", process.env.GROUNDS_TEST_CONTAINER_IMAGE ?? "alpine:latest"], { encoding: "utf8" }).trim();
  assert.match(image, /@sha256:[0-9a-f]{64}$/);
  const base = await mkdtemp(join(process.env.GROUNDS_TEST_CONTAINER_ROOT ?? tmpdir(), "grounds-triple-"));
  const ledgerId = randomUUID();
  const subjects = [0, 1, 2].map(i => ({
    owner: { ledgerId, sandboxId: randomUUID() }, workspace: { path: join(base, "work-" + i), configPath: join(base, "config-" + i, "devcontainer.json") },
  }));
  try {
    for (const [i, subject] of subjects.entries()) {
      await mkdir(subject.workspace.path); await mkdir(join(base, "config-" + i));
      await writeFile(subject.workspace.configPath, JSON.stringify({ image, workspaceFolder: "/work", workspaceMount: "source=${localWorkspaceFolder},target=/work,type=bind" }));
    }
    const results = await Promise.allSettled(subjects.map(async ({ owner, workspace }) => {
      const first = await runtime.up(owner, workspace);
      assert.equal(first.state, "running");
      assert.deepEqual(await runtime.up(owner, workspace), first);
      const executed = await runtime.execute(owner, first.id, workspace, ["sh", "-c", "printf %s \"$1\" > /work/result", "sh", owner.sandboxId]);
      assert.equal(executed.exitCode, 0, executed.stderr);
      assert.equal(await readFile(join(workspace.path, "result"), "utf8"), owner.sandboxId);
      return first;
    }));
    const containers = results.map(result => { if (result.status === "rejected") throw result.reason; return result.value; });
    assert.equal(new Set(containers.map(c => c.id)).size, 3);
    const first = subjects[0]!, second = subjects[1]!;
    await assert.rejects(runtime.pause(first.owner, containers[1]!.id), /identity/);
    await runtime.pause(first.owner, containers[0]!.id);
    assert.equal((await runtime.observe(second.owner))!.state, "running");
    await runtime.resume(first.owner, containers[0]!.id);
    assert.equal((await runtime.observe(first.owner))!.state, "running");
  } finally {
    await Promise.all(subjects.map(async ({owner}) => {
      const current = await runtime.observe(owner);
      if (current) await runtime.remove(owner, current.id);
    }));
    await rm(base, { recursive: true, force: true });
  }
});
