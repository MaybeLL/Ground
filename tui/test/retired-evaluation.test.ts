import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '../src/client.js';

const launcher = (...args: string[]) => spawnSync(process.execPath, [
  '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/bin.tsx', import.meta.url)), ...args,
], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

test('TUI rejects --eval before terminal or CLI initialization and removes it from help', () => {
  const result = launcher('--eval', '--cli', '/nonexistent/grounds');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option '--eval'/);
  assert.doesNotMatch(result.stdout + result.stderr, /正在连接|CLI_NOT_FOUND|\x1b\[\?1049h/);
  const help = launcher('--help');
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--eval|Ctrl\+E|Ctrl\+G/);
  assert.match(help.stdout, /默认打开 Candidate/);
});

test('TUI client no longer exposes evaluation query, publication or QA draft methods', () => {
  for (const method of ['evalReady', 'read', 'publish', 'qaDraft', 'identity', 'database']) {
    assert.equal(Object.hasOwn(Client.prototype, method), false, method);
  }
  assert.equal(typeof Client.prototype.query, 'function');
  assert.equal(typeof Client.prototype.selectCandidate, 'function');
});
