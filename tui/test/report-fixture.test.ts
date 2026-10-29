import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedReports } from './support/report-fixture.js';

test('report setup rejects invalid batch sizes before loading a CLI or opening a database', async () => {
  for (const count of [-1, 0, 1.5, 257, NaN]) {
    await assert.rejects(seedReports({ cli: '/missing', root: '/missing', config: '/missing', seedId: '', count }), /fixture count/);
  }
});

test('report setup refuses a config outside its owned temporary fixture root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grounds-tui-integration-'));
  try {
    const config = join(root, 'unexpected.yaml');
    writeFileSync(config, 'not a real database configuration');
    await assert.rejects(seedReports({ cli: '/missing', root, config, seedId: '', count: 1 }), /fixture config must be inside/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
