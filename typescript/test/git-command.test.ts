import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGit } from "../src/git-command.js";

test("a stuck Git process is killed within its deadline and private input is removed", () => {
  const root = mkdtempSync(join(tmpdir(), "grounds-git-deadline-"));
  const originalPath = process.env.PATH;
  const originalTmp = process.env.TMPDIR;
  try {
    const record = join(root, "record");
    writeFileSync(join(root, "git"), `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {});
const inputDirectory = fs.readdirSync(${JSON.stringify(root)}).find(name => name.startsWith('grounds-git-input-'));
fs.writeFileSync(${JSON.stringify(record)}, process.pid + '\\n' + require('node:path').join(${JSON.stringify(root)}, inputDirectory, 'stdin'));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    process.env.PATH = root + ":" + originalPath;
    process.env.TMPDIR = root;
    const start = Date.now();
    assert.throws(() => runGit(root, ["apply"], undefined, Buffer.from("private patch"), 1000), /timed out after 1000ms/);
    assert.ok(Date.now() - start < 5000);
    const [pid, path] = readFileSync(record, "utf8").split("\n");
    assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
    assert.equal(existsSync(path), false);
  } finally {
    process.env.PATH = originalPath;
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    rmSync(root, { recursive: true, force: true });
  }
});
