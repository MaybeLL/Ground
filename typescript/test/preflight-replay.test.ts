import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchGit } from "../src/development-branch.js";
import { PreflightService } from "../src/preflight.js";
import { SQLStore } from "../src/sql-store.js";
import { newUUIDv7 } from "../src/identity.js";
import { testAgent } from "./fixture.js";

async function fixture(action: (value: { service: PreflightService; root: string; base: string; canonical: string }) => Promise<void>) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "grounds-preflight-replay-")));
  const root = join(temporary, "repo"), bare = join(temporary, "remote.git");
  mkdirSync(root); mkdirSync(bare);
  branchGit(bare, ["init", "--bare", "-q"]);
  branchGit(root, ["init", "-q", "-b", "main"]);
  branchGit(root, ["config", "user.name", "Test"]);
  branchGit(root, ["config", "user.email", "test@example.test"]);
  const canonical = "ssh://git@example.test/team/preflight-replay";
  branchGit(root, ["config", `url.file://${bare}.insteadOf`, canonical]);
  branchGit(root, ["remote", "add", "origin", canonical]);
  writeFileSync(join(root, "file.txt"), "first\n");
  branchGit(root, ["add", "."]); branchGit(root, ["commit", "-qm", "first"]);
  branchGit(root, ["push", "-q", "origin", "main"]);
  const base = branchGit(root, ["rev-parse", "HEAD"]).toString().trim();
  const store = SQLStore.sqlite(join(temporary, "ledger.db"));
  try {
    await store.initialize("warn");
    await action({ service: new PreflightService(store, root), root, base, canonical });
  } finally { await store.close(); rmSync(temporary, { recursive: true, force: true }); }
}

test("completed preflight observation replays without fetching a later remote head", async () => fixture(async ({ service, root, base, canonical }) => {
  const input = { operation_id: newUUIDv7(), attribution: testAgent, phase: "definition" as const, refresh: true,
    canonical_remote: canonical, target: { remote: "origin", ref: "refs/heads/main" } };
  const first = await service.observe(input);
  writeFileSync(join(root, "file.txt"), "later\n");
  branchGit(root, ["add", "."]); branchGit(root, ["commit", "-qm", "later"]); branchGit(root, ["push", "-q", "origin", "main"]);
  branchGit(root, ["update-ref", "refs/remotes/origin/main", base]);
  assert.deepEqual(await service.observe(input), first);
  assert.equal(branchGit(root, ["rev-parse", "refs/remotes/origin/main"]).toString().trim(), base);
  await assert.rejects(service.observe({ ...input, refresh: false }), { code: "IDEMPOTENCY_CONFLICT" });
}));

test("assessment replay preserves its immutable receipt and rejects different judgement bytes", async () => fixture(async ({ service, canonical }) => {
  const observation = await service.observe({ operation_id: newUUIDv7(), attribution: testAgent, phase: "definition", refresh: true,
    canonical_remote: canonical, target: { remote: "origin", ref: "refs/heads/main" } });
  const input = { operation_id: newUUIDv7(), attribution: testAgent, observation_id: observation.id,
    file: { assessment: "applicable", rationale: "The observed definition inputs are unchanged", affected: [] } };
  const first = await service.assess(input);
  assert.deepEqual(await service.assess(input), first);
  await assert.rejects(service.assess({ ...input, file: { ...input.file, rationale: "A different assertion" } }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(await service.show(first.id), first);
  const second = await service.assess({ ...input, operation_id: newUUIDv7(), file: { ...input.file, assessment: "unknown" } });
  assert.equal(second.data.assessment_seq, Number(first.data.assessment_seq) + 1);
}));
