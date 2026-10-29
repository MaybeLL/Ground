#!/usr/bin/env node
/**
 * Run the core test suite with several worker processes instead of one.
 *
 * The suite is written for `--test-concurrency=1`: many files reserve
 * directories through the shared runtime registry under the local user's home
 * and take its operation lock, so two files running side by side in one process
 * group collide. Giving each worker its own HOME isolates those default roots,
 * which is what makes parallel files possible at all. Every file still runs with
 * `--test-concurrency=1`, so no test's own assumptions change — only how many
 * processes exist.
 *
 * Workers pull files one at a time from a shared queue, so a slow file cannot
 * strand a worker the way fixed round-robin shards would; the longest single
 * file bounds the run.
 *
 * Usage: node scripts/test-parallel.mjs [--workers N] [--reporter spec]
 */
import { spawn } from "node:child_process";
import { readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { workerEnvironment, createWorkerHome, createIsolatedMysqlDatabase } from "./test-environment.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const repository = realpathSync(new URL("..", import.meta.url).pathname);
const testDirectory = join(repository, "test");
const workers = Math.max(1, Number(value("--workers", Math.min(4, Math.max(2, cpus().length - 1)))));
const reporter = ["--test-reporter", value("--reporter", "tap")];

const files = readdirSync(testDirectory)
  .filter(name => name.endsWith(".test.ts"))
  .sort()
  .map(name => join("test", name));
// This integration file observes the host-wide process inventory. Other test
// workers must finish first; the fixture itself still exercises unrelated tasks.
const exclusive = files.filter(file => file === 'test/env-process.test.ts');
const queue = files.filter(file => !exclusive.includes(file));

const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
const failures = [];
let next = 0;
const recordFailure = (file, code, output) => {
  failures.push({ file, code, output });
  const name = `test-worker-${file.replace(/[^a-zA-Z0-9]+/g, "-")}.log`;
  writeFileSync(join(repository, name), output);
  process.stderr.write(`${file} failed (exit ${code}); see ${name}\n`);
};

const runFile = async (file, worker) => {
  const started = Date.now();
  const home = createWorkerHome(worker);
  let database;
  let output = "";
  let exit = 1;
  try {
    database = await createIsolatedMysqlDatabase();
    exit = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--test", "--test-concurrency=1", ...reporter, file],
        { cwd: repository, env: workerEnvironment(home, database?.environment ?? process.env), stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.on("error", error => { output += `${error.stack}\n`; });
      child.on("close", code => resolve(code ?? 1));
    });
    for (const match of output.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)) {
      totals[match[1]] += Number(match[2]);
    }
    if (exit !== 0) recordFailure(file, exit, output);
  } catch (error) {
    exit = 1;
    recordFailure(file, exit, output + String(error.stack ?? error));
  } finally {
    try { await database?.cleanup(); }
    catch (error) { exit = 1; recordFailure(file, exit, output + `\nWorker database cleanup failed: ${error.stack ?? error}`); }
    if (exit === 0) rmSync(home, { recursive: true, force: true });
    else process.stderr.write(`Retained failed worker home: ${home}\n`);
  }
  process.stdout.write(`test-parallel: file=${file} exit=${exit} duration=${Math.round((Date.now() - started) / 1000)}s\n`);
};

const runWorker = async (worker) => {
  for (;;) {
    const index = next++;
    if (index >= queue.length) return;
    await runFile(queue[index], worker);
  }
};

const started = Date.now();
await Promise.all(Array.from({ length: workers }, (_, worker) => runWorker(worker)));
for (const file of exclusive) await runFile(file, 'exclusive');

process.stdout.write(
  `test-parallel: ${workers} workers, ${files.length} files, ${Math.round((Date.now() - started) / 1000)}s, ` +
  `tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} skipped=${totals.skipped}\n`,
);
process.exitCode = failures.length > 0 ? 1 : 0;
