import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { cancelRun, reconcileRun, startRun } from "../src/env-run.js";
import { environmentDown, environmentUp } from "../src/env-environment.js";
import { environmentDefinitionOf, implicitHostDefinition } from "../src/env-definition.js";
import { registerCredentialGrant } from "../src/env-credentials.js";
import { temporary } from "./env-test-helpers.js";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("host output is durable before command exit and survives controller death", async () => temporary(async (root, workspace) => {
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("../scripts/env-v5-log-controller-fixture.ts", import.meta.url));
  const controller = spawn(process.execPath, ["--import", loader, fixture, join(root, "runtime"), join(root, "registry"), workspace], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  controller.stderr.on("data", chunk => { errors += chunk; });
  const metadata = await new Promise<{ environment: string; run: string; directory: string }>((resolve, reject) => {
    let text = "";
    controller.stdout.on("data", chunk => {
      text += chunk;
      if (text.includes("\n")) {
        try { resolve(JSON.parse(text.split("\n")[0])); } catch (error) { reject(error); }
      }
    });
    controller.once("error", reject);
    controller.once("exit", () => reject(new Error(`controller exited before metadata: ${errors}`)));
  });
  try {
    for (let i = 0; i < 150 && !existsSync(join(workspace, "started")); i++) await wait(20);
    assert.ok(existsSync(join(workspace, "started")), errors);
    await wait(150);
    assert.match(readFileSync(join(metadata.directory, "output.log"), "utf8"), /before-controller-crash/);
  } finally {
    const exited = new Promise(resolve => controller.once("exit", resolve));
    controller.kill("SIGKILL");
    await exited;
    cancelRun(metadata.run);
    for (let i = 0; i < 150 && reconcileRun(metadata.run).termination !== "confirmed"; i++) await wait(30);
    assert.equal(reconcileRun(metadata.run).termination, "confirmed");
    environmentDown(metadata.environment);
  }
  assert.match(readFileSync(join(metadata.directory, "output.log"), "utf8"), /before-controller-crash/);
}));

test("live log snapshots redact credentials split across output chunks", async () => temporary(async (root, workspace) => {
  const token = "s3cr3t-abcdef";
  const source = join(root, "auth.json");
  writeFileSync(source, JSON.stringify({ account: "test", token }));
  registerCredentialGrant({ name: "model", repository_id: "repo", environment: "dev", source_file: source, account: "test", method: "oauth", access: "model", identity_fields: ["account"] });
  const environment = await environmentUp({
    workspace, taskRepositoryId: "repo", resolvedRepositoryId: "repo",
    definition: environmentDefinitionOf({ ...implicitHostDefinition(), name: "dev", credentials: [{ name: "model" }] }),
  });
  const script = `const fs=require('fs');const token=JSON.parse(fs.readFileSync(process.env.GROUNDS_CREDENTIAL_MODEL_FILE)).token;process.stdout.write(token.slice(0,6));fs.writeFileSync('partial','ready');setTimeout(()=>process.stdout.write(token.slice(6)+'\\n'),600);`;
  const started = startRun({ environmentId: environment.id, argv: [process.execPath, "-e", script] });
  try {
    for (let i = 0; i < 100 && !existsSync(join(workspace, "partial")); i++) await wait(10);
    for (let i = 0; i < 100 && !readFileSync(join(started.run.directory, "output.log"), "utf8"); i++) await wait(5);
    const partial = readFileSync(join(started.run.directory, "output.log"), "utf8");
    assert.ok(!partial.includes(token.slice(0,6)));
    assert.match(partial, /REDACTED_PENDING/);
    const result = await started.done;
    assert.equal(readFileSync(join(result.directory, "output.log"), "utf8"), "[REDACTED]\n");
  } finally {
    await started.done;
    environmentDown(environment.id);
  }
}));
