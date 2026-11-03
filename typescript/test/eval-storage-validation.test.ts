// These validators and tables still serve SQL integrity checks. Retire their
// coverage with the schema, not with the already removed evaluation services.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeGrader, decodeSubmission, decodeEvalJSON } from "../src/evaluation.js";
import { decodeEnvironment, decodePreparationResult, preparationContractDigest } from "../src/eval-environment.js";
import { sha256 } from "../src/canonical-json.js";
import { newUUIDv7 } from "../src/identity.js";
import { SQLStore } from "../src/sql-store.js";

const definition = (role: string) => ({ format: "grounds.eval-environment/v1", name: role, role, task_kind: "qa",
  parameters: { kb: { type: "string", required: true } }, script: { interpreter: "/bin/sh", content: "exit 0" },
  execution: { backend: "docker", timeout_seconds: 60, network_hosts: [] }, access: { read_roles: [], kb: false, writable_workspace: false } });

test("retained environment record validation rejects unsafe roles and oversized skill evidence", () => {
  assert.throws(() => decodeEnvironment({ ...definition("grade"), access: { read_roles: ["code"], kb: false, writable_workspace: false } }));
  assert.throws(() => decodeEnvironment({ ...definition("grade"), skills: [{ name: "graphkb-cli", entrypoint: "SKILL.md" }] }));
  assert.throws(() => decodePreparationResult({ format: "grounds.environment-preparation-result/v1", attempt_id: "x", status: "failed", error: { message: "missing stage" } }));
  const result = (file_count: number, total_bytes: number) => ({ format: "grounds.environment-preparation-result/v1", attempt_id: "x", status: "success",
    workspace: { root: "workspace", materials: [] }, tools: [], sources: [],
    skills: [{ name: "graphkb-cli", root: "skills/graphkb-cli", entrypoint: "SKILL.md", bundle_digest: sha256([]), file_count, total_bytes }] });
  assert.equal(decodePreparationResult(result(2, 100)).skills?.[0].name, "graphkb-cli");
  assert.throws(() => decodePreparationResult(result(1001, 100)));
  assert.throws(() => decodePreparationResult(result(2, 32 * 1024 * 1024 + 1)));
});

test("retained preparation contract digest matches its stored golden vector", () => {
  const d = decodeEnvironment({ ...definition("answer"), name: "x", parameters: { n: { type: "number", required: true } }, skills: [{ name: "graphkb-cli", entrypoint: "SKILL.md" }] });
  assert.equal(preparationContractDigest(d, { n: 1.5 }, { name: "grounds-env", version: "1", platform: "docker" }), "sha256:751d62051fbda03d0ab700276c67affa1e0f6076087b07363728536159becbca");
});

test("retained grading validators distinguish failed execution, evidence and score scales", () => {
  const base = { format: "patchledger.eval-grader-submission/v1", execution_id: newUUIDv7(), context_digest: sha256({}), status: "completed", explanation: "Reasoning", evidence: [{ kind: "observation", content: "Specific code reference" }] };
  assert.throws(() => decodeSubmission({ ...base, status: "error", outcome: { kind: "decision", verdict: "fail" } }));
  assert.throws(() => decodeSubmission({ ...base, evidence: [], outcome: { kind: "decision", verdict: "pass" } }));
  assert.equal(decodeSubmission({ ...base, outcome: { kind: "inconclusive", reason: "No reliable evidence" }, evidence: [] }).outcome?.kind, "inconclusive");
  const score = decodeGrader({ format: "patchledger.eval-grader/v1", issue: { id: newUUIDv7(), version: 1 }, name: "Behavior",
    scope: { kind: "diagnostic", name: "Public behavior" }, definition: { type: "agent", instructions: "Inspect fixed evidence" }, limitations: "Fixture only",
    result_spec: { kind: "score", min: 0, max: 5, higher_is_better: true, rubric: "0=opaque; 5=clear" } });
  for (const bad of [{ ...score, extra: true }, { ...score, issue: { ...score.issue, version: null } }, { ...score, result_spec: { kind: "score", min: 5, max: 0, higher_is_better: true, rubric: "bad" } }]) assert.throws(() => decodeGrader(bad));
});

test("retained evaluation JSON decoding rejects duplicate keys, nulls, malformed UTF-8 and YAML", () => {
  for (const input of [Buffer.from('{"name":"first","name":"last"}'), Buffer.from('{"name":null}'), Buffer.from([0xff]), Buffer.from("name: yaml")]) assert.throws(() => decodeEvalJSON(input));
  assert.deepEqual(decodeEvalJSON(Buffer.from('{"name":"valid"}')), { name: "valid" });
});

test("retained schema upgrade and blob reads still reject missing chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-retained-eval-storage-")), path = join(root, "ledger.db");
  const store = SQLStore.sqlite(path);
  try {
    await store.initialize("warn");
    await store.close();
    const old = new DatabaseSync(path);
    try { old.exec("DROP TABLE eval_blob_chunks; DROP TABLE eval_blobs; UPDATE schema_metadata SET schema_version = 15;"); } finally { old.close(); }
    await store.migrate();
    const digest = await store.write(tx => tx.putEvalBlob(Buffer.from("saved")));
    assert.equal((await store.read(tx => tx.getEvalBlob(digest))).toString(), "saved");
    await store.close();
    const corrupt = new DatabaseSync(path);
    try { corrupt.exec("DELETE FROM eval_blob_chunks"); } finally { corrupt.close(); }
    await assert.rejects(store.read(tx => tx.getEvalBlob(digest)), /missing/);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});
