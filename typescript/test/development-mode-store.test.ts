import { test } from "node:test";
import assert from "node:assert/strict";
import { LedgerFixture, testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { DomainError } from "../src/errors.js";

test("DevRun mode survives SQL reads, context reconstruction and operation replay", async () => {
  const f = await LedgerFixture.create();
  try {
    const input = { operation_id: newUUIDv7(), attribution: testAgent,
      issue_id: f.issue.issue_id, issue_revision_id: f.issue.issue_revision_id,
      issue_revision_explicit: false, repository_remote_snapshot: f.repository.canonical_remote,
      execution_mode: { mode: "simple" as const, source: "argument" as const } };
    const first = await f.module.startDevRun(input), id = first.result.context.dev_run.id;
    assert.deepEqual((await f.store.read(tx => tx.getDevRun(id))).execution_mode, input.execution_mode);
    assert.deepEqual((await f.module.showDevRun(id)).execution_mode, input.execution_mode);
    assert.deepEqual((await f.module.devRunContext(id, false, [])).context.dev_run.execution_mode, input.execution_mode);
    assert.equal((await f.module.startDevRun(input)).result.context.dev_run.id, id);
    await assert.rejects(f.module.startDevRun({ ...input, execution_mode: { mode: "container", source: "argument" } }), (e: unknown) => e instanceof DomainError);
    const next = await f.module.startDevRun({ ...input, operation_id: newUUIDv7(), execution_mode: { mode: "container", source: "configuration" } });
    assert.equal(next.result.context.dev_run.execution_mode?.mode, "container");
    assert.equal((await f.module.showDevRun(id)).execution_mode?.mode, "simple");
  } finally { await f.close(); }
});
