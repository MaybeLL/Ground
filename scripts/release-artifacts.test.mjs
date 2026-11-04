import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const name of ['maybell-grounds-tui-0.2.53.tgz', 'SHA256SUMS']) {
  test(`release packaging refuses occupied output without changing ${name}`, () => {
    const output = mkdtempSync(join(tmpdir(), 'grounds-release-output-'));
    try {
      const contents = Buffer.from('previous release bytes\n');
      writeFileSync(join(output, name), contents);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./release-artifacts.mjs', import.meta.url)), output], {
        encoding: 'utf8', timeout: 10000,
        // No npm or Git is needed: refuse stale assets before external execution.
        env: { ...process.env, PATH: output },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Release output directory must be empty/);
      assert.deepEqual(readdirSync(output), [name]);
      assert.deepEqual(readFileSync(join(output, name)), contents);
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
}
