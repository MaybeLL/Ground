import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('home public entry and mode compatibility in a CI PTY leave ledger unchanged', { skip: process.env.GROUNDS_TUI_PTY !== '1', timeout: 120000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'grounds-home-pty-'));
  const cli = process.env.GROUNDS_RELEASE_CLI ?? resolve('../typescript/dist/src/bin.js');
  const slowCli = join(root, 'slow-cli.py');
  const config = join(root, 'config.yaml');
  const run = (...args: string[]) => {
    const result = JSON.parse(execFileSync(cli, [...args, '--config', config, '--json'], { cwd: root, encoding: 'utf8', timeout: 30000 }));
    assert.equal(result.ok, true); return result.data;
  };
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    run('init', '--driver', 'sqlite', '--path', join(root, 'ledger.db'), '--non-interactive');
    const before = run('ledger', 'list');
    // Force the initial Requirement query to outlast the first rendered frame.
    // All CLI operations still execute against the actual disposable ledger.
    writeFileSync(slowCli, `#!/usr/bin/env python3\nimport os, sys, time\nif sys.argv[1:3] == ['requirement', 'list']:\n    time.sleep(1.5)\nos.execv(${JSON.stringify(cli)}, [${JSON.stringify(cli)}, *sys.argv[1:]])\n`);
    chmodSync(slowCli, 0o755);
    const output = execFileSync('python3', ['scripts/home-pty-smoke.py', process.execPath, resolve('dist/bin.js'), '--cli', slowCli, '--config', config, '--cwd', root], { encoding: 'utf8', timeout: 100000, env: { ...process.env, CI: 'true' } });
    assert.match(output, /HOME PTY PASS/);
    assert.deepEqual(run('ledger', 'list'), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
