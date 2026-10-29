import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { flockSync } from "fs-ext";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runCLI } from "../src/cli.js";
import { JSON_FORMAT } from "../src/workspace-json.js";
import { assertContract } from "./schema-fixture.js";
import { writeConfig } from "../src/config.js";
import { newUUIDv7 } from "../src/identity.js";

const offlineDatabaseID = newUUIDv7();
function offlineDirectory(root: string, name: string): string {
  writeConfig(join(root, "absent.yaml"), { version: 2, database: { driver: "sqlite", path: join(root, "unavailable", "ledger.db"), expected_database_id: offlineDatabaseID } });
  return join(root, "data", "drafts", offlineDatabaseID, name);
}

async function run(args: string[], cwd: string) {
  const lines: string[] = [];
  const previous = process.env.GROUNDS_DATA_HOME;
  process.env.GROUNDS_DATA_HOME = join(cwd, "data");
  try {
    const code = await runCLI([...args, "--json"], { cwd, stdout: line => lines.push(line), stderr: () => {} });
    return { code, envelope: JSON.parse(lines.join("\n")) };
  } finally {
    if (previous === undefined) delete process.env.GROUNDS_DATA_HOME;
    else process.env.GROUNDS_DATA_HOME = previous;
  }
}

test("contract source/format/output matrix fails before database access", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-render-matrix-"));
  try {
    for (const args of [[], ["--workspace", "draft", "--issue", "bad@1"], ["--issue", "bad@1"], ["--requirement", "bad@1"], ["--workspace", "draft", "--format", "markdown"], ["--workspace", "draft", "--output="], ["--workspace="], ["--workspace", "draft", "--format", "pdf"]]) {
      const result = await run(["contract", "render", ...args, "--config", join(root, "absent.yaml")], root);
      assert.notEqual(result.code, 0);
      assert.equal(result.envelope.error.code, "VALIDATION_ERROR", JSON.stringify(result.envelope));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("both unified session and legacy alias stream valid initial JSON without database and stop cleanly", { timeout: 40000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-render-offline-"));
  execFileSync("git", ["init", "-q", root]);
  const workspace = offlineDirectory(root, "draft");
  mkdirSync(workspace, { recursive: true });
  const path = join(workspace, ".workspace.json");
  writeFileSync(path, JSON.stringify({ format: JSON_FORMAT, name: "draft", database_id: offlineDatabaseID, repository_remote: "example/repo", requirement: {}, issues: [], revision: 1, draft: { requirement: { format: 1, summary: "Readable contract", outcomes: ["Observable outcome"] }, issues: [] } }));
  const before = readFileSync(path);
  try {
    for (const args of [["contract", "render", "--workspace", "draft"], ["workspace", "edit", "draft"]]) {
      const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)), fileURLToPath(new URL("../src/main.ts", import.meta.url)), ...args, "--json", "--config", join(root, "absent.yaml")], { cwd: root, env: { ...process.env, NODE_PATH: undefined, GROUNDS_DATA_HOME: join(root, "data") }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      child.stderr.on("data", chunk => { errors += chunk; });
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      try {
        const envelope = await new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`No session JSON: ${output} ${errors}`)), 15000);
          child.once("exit", code => { clearTimeout(timer); reject(new Error(`Session exited ${code}: ${output} ${errors}`)); });
          child.stdout.on("data", chunk => {
            output += chunk;
            try { const value = JSON.parse(output); clearTimeout(timer); resolve(value); } catch {}
          });
        });
        assert.equal(envelope.ok, true, JSON.stringify(envelope));
        assertContract("cli-envelope.schema.json", envelope);
        assert.equal(envelope.data.command, args[0] === "workspace" ? "workspace.edit" : "contract.render");
        assert.equal(envelope.data.result_type, args[0] === "workspace" ? "grounds.result.workspace-editor/v2" : "grounds.result.contract-session/v1");
        assert.equal(envelope.data.editable, true);
        assert.equal(envelope.data.version, envelope.data.source.workspace_version);
        assert.equal(envelope.data.source.workspace, "draft");
        assert.equal(child.exitCode, null);
        assert.equal((await fetch(envelope.data.url)).status, 200);
        assert.deepEqual(readFileSync(path), before);
        const origin = new URL(envelope.data.url).origin;
        child.kill("SIGINT"); await exited;
        await assert.rejects(fetch(origin));
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit output preserves static JSON and Markdown results", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-render-export-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: root });
    writeFileSync(join(root, "a"), "base");
    execFileSync("git", ["add", "a"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "ssh://git@example.test/team/repo"], { cwd: root });
    const config = join(root, "config.yaml");
    assert.equal((await run(["init", "--driver", "sqlite", "--path", join(root, "ledger.db"), "--config", config, "--non-interactive"], root)).code, 0);
    const created = await run(["workspace", "new", "draft", "--config", config], root);
    assert.equal(created.code, 0);
    const source = join(created.envelope.data.path, ".workspace.json");
    const before = readFileSync(source);
    for (const format of ["html", "markdown"]) {
      const result = await run(["contract", "render", "--workspace", "draft", "--output", join(root, "output"), "--format", format, "--config", config], root);
      assert.equal(result.code, 0, JSON.stringify(result.envelope));
      assertContract("cli-envelope.schema.json", result.envelope);
      assert.equal(result.envelope.data.result_type, "patchledger.result.contract-review/v1");
      assert.equal(result.envelope.data.format, format);
      assert.match(result.envelope.data.source.workspace_version, /^[a-f0-9]{64}$/);
      assert.match(result.envelope.data.content_digest, /^sha256:/);
      assert.ok(readFileSync(result.envelope.data.path).length > 0);
      assert.deepEqual(readFileSync(source), before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy Markdown live entry explicitly requires migration without writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-live-legacy-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const directory = offlineDirectory(root, "legacy");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, ".workspace.json");
    writeFileSync(path, JSON.stringify({ format: "patchledger.authoring-workspace/v1", database_id: offlineDatabaseID }));
    writeFileSync(join(directory, "requirement.md"), "# Summary\nLegacy draft\n");
    const before = readFileSync(path);
    for (const args of [["contract", "render", "--workspace", "legacy"], ["workspace", "edit", "legacy"]]) {
      const result = await run([...args, "--config", join(root, "absent.yaml")], root);
      assert.notEqual(result.code, 0);
      assert.equal(result.envelope.error.code, "VALIDATION_ERROR");
      assert.match(JSON.stringify(result.envelope.error), /workspace migrate/);
      assert.deepEqual(readFileSync(path), before);
      assert.equal(readFileSync(join(directory, "requirement.md"), "utf8"), "# Summary\nLegacy draft\n");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SIGINT during a lock-blocked save does not implicitly commit; restart reads persisted state", { timeout: 40000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-live-inflight-"));
  const children: ReturnType<typeof spawn>[] = [];
  let fd: number | undefined;
  try {
    execFileSync("git", ["init", "-q", root]);
    const directory = offlineDirectory(root, "draft");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, ".workspace.json");
    const draft = { requirement: { format: 1, summary: "Persisted original", outcomes: ["Outcome"] }, issues: [] };
    writeFileSync(path, JSON.stringify({ format: JSON_FORMAT, name: "draft", database_id: offlineDatabaseID, repository_remote: "example/repo", requirement: {}, issues: [], revision: 1, draft }));
    const before = readFileSync(path);
    // IPC observes the actual blocked flock call without contaminating CLI stdout.
    const entry = join(root, "observe-lock.mjs");
    writeFileSync(entry, `import {createRequire} from 'node:module';\nconst require=createRequire(import.meta.url); const ext=require(${JSON.stringify(fileURLToPath(import.meta.resolve("fs-ext")))}); const original=ext.flock; ext.flock=(fd,op,cb)=>original(fd,op,error=>{if(error && ['EAGAIN','EWOULDBLOCK'].includes(error.code))process.send({waiting:true});cb(error)}); const {runCLI}=await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)});process.exitCode=await runCLI(process.argv.slice(2));`);
    const start = async () => {
      const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)), entry, "contract", "render", "--workspace", "draft", "--json", "--config", join(root, "absent.yaml")], { cwd: root, env: { ...process.env, GROUNDS_DATA_HOME: join(root, "data") }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      let output = "", errors = "";
      child.stderr!.on("data", chunk => { errors += chunk; });
      const envelope = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Session unavailable ${output} ${errors}`)), 15000);
        child.once("exit", () => { clearTimeout(timer); reject(new Error(`Exited ${output} ${errors}`)); });
        child.stdout!.on("data", chunk => { output += chunk; try { const value = JSON.parse(output); clearTimeout(timer); resolve(value); } catch {} });
      });
      assert.equal(envelope.ok, true, JSON.stringify(envelope));
      const url = new URL(envelope.data.url);
      return { child, url, headers: { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" } };
    };
    const first = await start();
    const loaded = await (await fetch(`${first.url.origin}/api/draft`, { headers: first.headers })).json() as any;
    fd = openSync(join(directory, ".workspace.lock"), "a", 0o600);
    flockSync(fd, "exnb");
    const waiting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("save never reached the held lock")), 10000);
      first.child.on("message", message => { if ((message as any).waiting) { clearTimeout(timer); resolve(); } });
    });
    const changed = structuredClone(loaded.draft); changed.requirement.summary = "In-flight unsaved change";
    const pending = fetch(`${first.url.origin}/api/save`, { method: "POST", headers: first.headers, body: JSON.stringify({ draft: changed, expectedVersion: loaded.version }) }).then(response => ({ response }), error => ({ error }));
    await waiting;
    assert.deepEqual(readFileSync(path), before);
    const exited = new Promise<void>(resolve => first.child.once("exit", () => resolve()));
    first.child.kill("SIGINT"); await exited;
    assert.ok("error" in await pending, "the interrupted request must not report success");
    flockSync(fd, "un"); closeSync(fd); fd = undefined;
    assert.deepEqual(readFileSync(path), before);
    const second = await start();
    assert.notEqual(second.url.hash, first.url.hash);
    const restored = await (await fetch(`${second.url.origin}/api/draft`, { headers: second.headers })).json() as any;
    assert.equal(restored.version, loaded.version);
    assert.deepEqual(restored.draft, loaded.draft);
    assert.equal((await fetch(`${second.url.origin}/api/draft`, { headers: first.headers })).status, 401);
  } finally {
    if (fd !== undefined) { flockSync(fd, "un"); closeSync(fd); }
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); })));
    rmSync(root, { recursive: true, force: true });
  }
});
