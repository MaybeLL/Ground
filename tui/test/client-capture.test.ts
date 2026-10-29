import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '../src/client.js';

test('actual client and CLI clean failed input preparation and keep local clue lists distinct from QA', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-client-capture-'))), config = join(root, 'config.yaml'), owned = join(root, 'owned');
  const cli = process.env.GROUNDS_RELEASE_CLI ?? resolve('../typescript/dist/src/bin.js'); let client: Client | undefined;
  try {
    const init = JSON.parse(execFileSync(cli, ['init', '--driver', 'sqlite', '--path', join(root, 'ledger.db'), '--config', config, '--non-interactive', '--json'], { cwd: root, encoding: 'utf8' }));
    assert.equal(init.ok, true);
    client = await Client.open({ cli, cwd: root, config, temporaryRoot: owned, timeout: 30000 });
    const circular: any = {}; circular.self = circular;
    await assert.rejects(client.qaDraft('draft.edit', ['invalid-id', '--expected-version', '1', '--draft-root', join(root, 'drafts')], circular), /circular/i);
    const session = readdirSync(owned).find(n => n.startsWith('session-'))!;
    assert.deepEqual(readdirSync(join(owned, session)).sort(), ['config.yaml', 'owner.json']);
    const list = await client.qaDraft('clue.list', ['--draft-root', join(root, 'drafts')]) as any;
    assert.equal(list.format, 'grounds.source-clue-list/v1'); assert.deepEqual(list.clues, []);
    assert.deepEqual(readdirSync(join(owned, session)).sort(), ['config.yaml', 'owner.json']);
  } finally { await client?.close(); rmSync(root, { recursive: true, force: true }); }
});
