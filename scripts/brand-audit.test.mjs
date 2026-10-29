import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('brand audit preserves SQLite archive data but still checks current and archived text', t => {
  const root = mkdtempSync(join(tmpdir(), 'grounds-brand-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('./brand-audit.mjs', import.meta.url), join(root, 'scripts/brand-audit.mjs'));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const archive = join(root, 'archive/db-backups/fixed-snapshot');
  mkdirSync(archive, { recursive: true });
  const oldName = 'Patch' + 'Ledger';
  const db = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84), Buffer.from(oldName)]);
  writeFileSync(join(archive, 'grounds.db'), db);
  const run = () => spawnSync(process.execPath, ['scripts/brand-audit.mjs'], { cwd: root, encoding: 'utf8' });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 historical SQLite archive/);
  for (const name of ['README.md', 'archive/db-backups/fixed-snapshot/notes.md', 'archive/db-backups/fixed-snapshot/fake.db', 'current.db']) {
    writeFileSync(join(root, name), name === 'current.db' ? db : oldName);
    result = run();
    assert.equal(result.status, 1, name);
    assert.ok(result.stderr.includes(name));
    rmSync(join(root, name));
  }
  // The exemption does not mutate the preserved file.
  assert.deepEqual(readFileSync(join(archive, 'grounds.db')), db);
});
