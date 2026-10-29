import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blockingCredentialReferences, credentialSourceAction } from "./env-credential-consumer-fixture.js";
import { acquireCredentialSourceLocks } from "../src/env-credentials.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";

const receipt = (occupancy: unknown[]) => ({ ok: true, data: { result_type: "grounds.result.environment/v1", command: "env.credential-occupancy", occupancy } });
test("authentication source guard includes different grant names and every unfinished state", () => {
  const rows = ["ready", "blocked", "future-unknown-state"].map((state, index) => ({ environment_id: `environment-${index}`, name: index ? "another-grant" : "model", source_file: "/temporary/account.json", state }));
  assert.deepEqual(blockingCredentialReferences(receipt(rows), "/temporary/account.json"), rows.map(({ environment_id, name, state }) => ({ environment_id, name, state })));
});
test("unrelated authentication sources do not block the selected source", () => {
  assert.deepEqual(blockingCredentialReferences(receipt([{ environment_id: "other", name: "model", source_file: "/temporary/unrelated.json", state: "ready" }]), "/temporary/account.json"), []);
});
test("missing, failed or malformed public occupancy receipts fail closed", () => {
  for (const value of [null, { ok: false }, { ok: true, data: {} }, receipt([{ environment_id: "unknown", name: "model", state: "ready" }]), receipt([{ environment_id: "unknown", name: "model", source_file: "relative.json", state: "ready" }])]) {
    assert.throws(() => blockingCredentialReferences(value, "/temporary/account.json"), /retain authentication source/);
  }
});
test("a failed public CLI check preserves the source and releases the asynchronous authentication lock", async () => {
  const root = mkdtempSync(join(homedir(), "tmp/grounds-env-v5-agent-logout-unit-"));
  try {
    await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, async () => {
      const source = join(root, "temporary-auth.json"); const original = '{"fixture":"temporary authentication data"}'; writeFileSync(source, original, { mode: 0o600 });
      await assert.rejects(credentialSourceAction({ action: "logout", sourceFile: source, grounds: join(root, "unavailable-cli") }), /occupancy is unavailable/);
      assert.equal(readFileSync(source, "utf8"), original);
      const release = acquireCredentialSourceLocks([source]); release(); release();
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
