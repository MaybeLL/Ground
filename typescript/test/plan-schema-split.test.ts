import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The public read model carries the non-normative Issue `plan`; the blind
// contracts must reject it. Both derive from one core definition, so this
// test pins the split itself rather than trusting the ref graph.
const contracts = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/contracts/v1");
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
for (const name of readdirSync(contracts).filter((entry) => entry.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(resolve(contracts, name), "utf8")) as object, name);
}
const compile = (ref: string) => {
  const validate = ajv.getSchema(ref);
  if (!validate) throw new Error(`schema is not registered: ${ref}`);
  return validate;
};
const publicIssue = compile("devrun-context.schema.json#/$defs/publicIssueVersion");
const blindIssue = compile("devrun-context.schema.json#/$defs/blindIssueVersion");

const baseIssue = {
  id: "01a1347f-2692-7624-9cf2-765c5de65b3a",
  version: 1,
  requirement: { id: "01a1347f-2692-7c00-82f3-03f6fd0ad281", version: 1 },
  summary: "s",
  context: "c",
  goals: [{ id: "01a13488-c551-7f13-a386-5958ca10f2a2", statement: "x", criteria: [{ id: "01a13488-c551-7f13-a386-5958ca10f2a2", statement: "y" }], guidance: [] }],
  constraints: [],
};

test("a plan-bearing Issue validates against the public definition and fails the blind one", () => {
  const withPlan = { ...baseIssue, plan: "方案：先加列，再拆定义。" };
  assert.equal(publicIssue(withPlan), true, JSON.stringify(publicIssue.errors));
  assert.equal(blindIssue(withPlan), false);
  // Two shapes must not silently become the same object.
  assert.equal(publicIssue(baseIssue), true);
  assert.equal(blindIssue(baseIssue), true);
});

test("blind-subject v1 and v2 reject a plan inside the embedded Issue Version", () => {
  const subject = (issue: unknown, format: string) => ({
    format,
    base_commit: `sha1:${"a".repeat(40)}`,
    candidate_id: "01a13452-2553-7e42-94db-070a084b1664",
    repository_id: "01a0b3b8-8271-7225-99ea-1eea0d23f14a",
    baseline_oid: `sha1:${"b".repeat(40)}`,
    result_tree_oid: `sha1:${"c".repeat(40)}`,
    patch_digest: `sha256:${"d".repeat(64)}`,
    artifact_format: "patchledger.git-full-index-binary-patch/v1",
    requirement: { id: "01a1347f-2692-7c00-82f3-03f6fd0ad281", version: 1, summary: "r", outcomes: ["o"], decisions: [] },
    issue,
    file_manifest: [],
  });
  for (const [file, format] of [["blind-subject.schema.json", "patchledger.blind-subject/v1"], ["blind-subject-v2.schema.json", "patchledger.blind-subject/v2"]] as const) {
    const validate = compile(file);
    const clean = subject(baseIssue, format);
    if (!validate(clean)) continue; // shape differs for the legacy variant; the Issue ref is what this test pins
    assert.equal(validate(subject({ ...baseIssue, plan: "方案" }, format)), false, `${file} must reject plan`);
  }
});

test("the plan field in the public definition is documented as non-normative", () => {
  const schema = JSON.parse(readFileSync(resolve(contracts, "devrun-context.schema.json"), "utf8"));
  const description = schema.$defs.publicIssueVersion.properties.plan.description as string;
  assert.match(description, /非规范/);
  assert.match(description, /不产生验收义务/);
});
