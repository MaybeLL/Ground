import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";

const call = async (args: string[]) => {
  const lines: string[] = [];
  const status = await runCLI([...args, "--json"], { stdout: line => lines.push(line), stderr: () => undefined });
  return { status, result: JSON.parse(lines.at(-1)!) };
};

test("retired eval commands and help are rejected before opening storage or touching supplied files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-retired-eval-"));
  try {
    const config = join(directory, "missing-config.yaml"), input = join(directory, "old-draft.json");
    writeFileSync(input, "historical bytes, not valid JSON\n");
    for (const args of [
      ["eval"], ["eval", "experiment", "list"], ["eval", "run", "start"], ["eval", "grader", "execute"],
      ["eval", "draft", "publish", "old-id", "--file", input], ["eval", "clue", "list"],
    ]) {
      const { status, result } = await call([...args, "--config", config]);
      assert.equal(status, 2);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "VALIDATION_ERROR");
      assert.match(result.error.message + JSON.stringify(result.error.details), /command is not implemented: eval/);
      assertContract("cli-envelope.schema.json", result);
    }
    for (const args of [["eval", "--help"], ["eval", "qa", "publish", "--help"], ["help", "eval"]]) {
      const { status, result } = await call(args);
      assert.equal(status, 2);
      assert.equal(result.error.code, "VALIDATION_ERROR");
    }
    assert.equal(readFileSync(input, "utf8"), "historical bytes, not valid JSON\n");
    assert.equal(existsSync(config), false);
    assert.deepEqual(readdirSync(directory), ["old-draft.json"]);
    const help = await call(["help"]);
    assert.equal(help.result.ok, true);
    assert.doesNotMatch(help.result.data.usage, /\beval\b/);
    assert.match(help.result.data.usage, /task \| work \| grade/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("retired evaluation result contracts and skill names are not advertised or accepted", () => {
  const root = new URL("../../docs/contracts/v1/", import.meta.url);
  for (const file of ["eval.schema.json", "eval-list.schema.json", "qa-candidate.schema.json", "qa-draft.schema.json", "source-clue.schema.json"]) {
    assert.equal(existsSync(new URL(file, root)), false);
  }
  for (const data of [
    { result_type: "patchledger.result.eval/v1", command: "eval.experiment.list", payload: [] },
    { result_type: "patchledger.result.eval-list/v1", command: "eval.run.list", kind: "run", items: [], page: { limit: 50, has_more: false, sort: "id:asc" } },
    ...["grounds-eval", "grounds-knowledge-improve"].map(name => ({
      result_type: "patchledger.result.skill-install/v1", command: "install.skill", target_path: "/tmp/skills", skills: [{ name, path: `/tmp/skills/${name}` }],
    })),
  ]) assert.throws(() => assertContract("command-results.schema.json", data));
});
