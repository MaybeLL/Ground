import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCLI } from "../src/cli.js";
import { acquireRouteLease, isRouteLeased } from "../src/env-route-lease.js";
import { codeRouteFencePath } from "../src/code-route-fence.js";
import { assertContract } from "./schema-fixture.js";

const call = async (args: string[]) => {
  const lines: string[] = [];
  const status = await runCLI([...args, "--json"], { stdout: line => lines.push(line), stderr: () => undefined });
  return { status, result: JSON.parse(lines.at(-1)!) };
};

test("code-workspace commands and help reject before reading config, inputs or initializing resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-retired-code-workspace-"));
  try {
    const config = join(root, "config.yaml"), input = join(root, "input.json");
    writeFileSync(input, "unchanged old input, not JSON\n");
    for (const action of ["config-save", "create", "restore", "route-prepare", "route-bind", "execution-start", "execution-serve",
      "recipe-save", "recipe-prepare", "image-prepare", "environment-check", "service-volume-delete", "cleanup", "show"]) {
      const { status, result } = await call(["code-workspace", action, "old-id", "--config", config, "--file", input]);
      assert.equal(status, 2);
      assert.equal(result.error.code, "VALIDATION_ERROR");
      assert.match(JSON.stringify(result.error), /command is not implemented: code-workspace/);
      assertContract("cli-envelope.schema.json", result);
    }
    for (const args of [["code-workspace", "--help"], ["help", "code-workspace"], ["code-workspace", "execution-start", "--help"]]) {
      assert.equal((await call(args)).status, 2);
    }
    assert.equal(readFileSync(input, "utf8"), "unchanged old input, not JSON\n");
    assert.deepEqual(readdirSync(root), ["input.json"]);
    const help = await call(["help"]);
    assert.doesNotMatch(help.result.data.usage, /code-workspace/);
    assert.match(help.result.data.usage, /task \| work \| grade/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retired container-route schemas are no longer published", () => {
  for (const name of ["code-workspace", "code-execution", "repository-environment", "repository-image", "development-image", "environment-control", "service-cleanup"]) {
    assert.equal(existsSync(new URL(`../../docs/contracts/v1/${name}.schema.json`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../../plugins/grounds/references/contracts/v1/${name}.schema.json`, import.meta.url)), false);
  }
});

test("retiring the route owner does not let standalone env take over a reserved directory or child", () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-reserved-directory-"));
  try {
    const route = join(root, "route"), child = join(route, "child");
    mkdirSync(child, { recursive: true });
    const marker = codeRouteFencePath(route);
    writeFileSync(marker, "damaged reservation must still exclude writers\n");
    for (const path of [route, child]) {
      assert.equal(isRouteLeased(path), true);
      assert.throws(() => acquireRouteLease({ route: path, environmentId: "new-env", runDirectory: join(root, "run") }), { code: "STATE_CONFLICT" });
    }
    assert.equal(readFileSync(marker, "utf8"), "damaged reservation must still exclude writers\n");
    assert.deepEqual(readdirSync(root).sort(), [".route.grounds-route.json", "route"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
