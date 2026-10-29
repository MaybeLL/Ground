import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerificationHandoff, verifyVerificationHandoff } from "../src/verification-handoff.js";
import { DomainError } from "../src/errors.js";
import { runCLI } from "../src/cli.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const report = {
  format: "patchledger.verification-report/v1",
  candidate_id: "018f0000-0000-7000-8000-000000000001",
  result_tree_oid: `sha1:${"1".repeat(40)}`,
  blind_context_digest: `sha256:${"2".repeat(64)}`,
  assessments: [{
    target_type: "goal" as const,
    target_id: "018f0000-0000-7000-8000-000000000002",
    criteria: [{
      criterion_id: "018f0000-0000-7000-8000-000000000003",
      independent: { verdict: "qualified" as const, explanation: "independent evidence", evidence: [] },
      reconciliation: { claim_relation: "corroborated" as const, explanation: "claim agrees" },
      final: { verdict: "qualified" as const, explanation: "qualified" },
    }],
  }],
};

test("verification handoff preserves verifier attribution and detects report edits", () => {
  const verifier = { kind: "agent" as const, agent_id: "verifier-1", display_name: "Verifier One" };
  const handoff = createVerificationHandoff(report, verifier);
  const verified = verifyVerificationHandoff(handoff);
  assert.deepEqual(verified.report, report);
  assert.deepEqual(verified.attribution, verifier);
  assert.match(verified.handoff_digest, /^sha256:/);
  assert.match(verified.key_fingerprint, /^sha256:/);

  const changed = structuredClone(handoff);
  changed.report.assessments[0].criteria[0].final.explanation = "edited later";
  assert.throws(() => verifyVerificationHandoff(changed), (error: unknown) =>
    error instanceof DomainError && error.details.field === "handoff.report_digest");
});

test("offline verifier handoff checks Chinese prose before signing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-handoff-language-"));
  try {
    const input = structuredClone(report);
    input.assessments[0].criteria[0].independent.explanation = "The rendered home preserves the existing search and navigation behavior";
    const file = join(directory, "report.json");
    writeFileSync(file, JSON.stringify(input));
    const run = async (extra: string[]) => {
      const lines: string[] = [];
      const code = await runCLI(["verification", "handoff", "--file", file, "--agent-id", "verifier-1", "--agent-name", "Verifier One", "--content-language", "zh-CN", ...extra, "--json"], { cwd: directory, stdout: line => lines.push(line), stderr: () => undefined });
      return { code, envelope: JSON.parse(lines.join("\n")) };
    };
    const blocked = await run([]);
    assert.equal(blocked.code, 2);
    assert.equal(blocked.envelope.error.details.field, "content_language");
    const overridden = await run(["--language-override-reason", "保留用户提供的英文判断"]);
    assert.equal(overridden.code, 0, JSON.stringify(overridden.envelope));
    assert.equal(overridden.envelope.warnings[0].code, "CONTENT_LANGUAGE_OVERRIDE");
    assert.equal(verifyVerificationHandoff(overridden.envelope.data.handoff).report.assessments[0].criteria[0].independent.explanation, input.assessments[0].criteria[0].independent.explanation);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("Agent helper signs offline handoff with environment attribution and reads business help without a ledger", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-helper-offline-"));
  try {
    const binary = join(directory, "grounds-cli"), file = join(directory, "report.json");
    const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const helper = fileURLToPath(new URL("../../plugins/grounds/scripts/grounds_agent.py", import.meta.url));
    writeFileSync(binary, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const r=spawnSync(${JSON.stringify(process.execPath)},["--import",${JSON.stringify(import.meta.resolve("tsx"))},${JSON.stringify(entry)},...process.argv.slice(2)],{stdio:"inherit"});process.exit(r.status??1);\n`, { mode: 0o700 });
    const input = structuredClone(report), criterion = input.assessments[0].criteria[0];
    criterion.independent.explanation = "独立检查结果通过";
    criterion.reconciliation.explanation = "声明与检查结果一致";
    criterion.final.explanation = "验收结果通过";
    writeFileSync(file, JSON.stringify(input));
    const invoke = (args: string[], identity: boolean) => {
      const env = { ...process.env, HOME: directory, GROUNDS_BIN: binary, GROUNDS_CONFIG: join(directory, "missing.yaml"),
        GROUNDS_AGENT_ID: identity ? "offline-agent" : "", GROUNDS_AGENT_NAME: identity ? "Offline Agent" : "" };
      const result = spawnSync("python3", [helper, "invoke", "--cwd", directory, "--", ...args], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return JSON.parse(result.stdout);
    };
    const signed = invoke(["verification", "handoff", "--file", file, "--content-language", "zh-CN"], true);
    assert.deepEqual(verifyVerificationHandoff(signed.data.handoff).attribution,
      { kind: "agent", agent_id: "offline-agent", display_name: "Offline Agent" });
    assert.equal(invoke(["repository", "register", "--help"], false).ok, true);
    assert.equal(invoke(["candidate", "submit", "--help"], false).ok, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
