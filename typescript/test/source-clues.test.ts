import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from '../src/cli.js';
import { QADraftStore } from '../src/qa-candidate.js';
import { assertContract } from './schema-fixture.js';

test('source clues use public local metadata only, immutable IDs, original expiry and independent ignore decisions', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-clues-'))), draftRoot = join(root, 'drafts'), file = join(root, 'clues.json');
  const now = Date.now(), first = new Date(now - 1000).toISOString(), expires = new Date(now + 86400000).toISOString();
  const clue = (id: string) => ({ id, project_id: 'p', host: 'codex-cli', session: 's', branch: '', reason: 'query_failed', state: 'pending_analysis', record_ref: { id: 'm1', kind: 'cli_result', digest: 'sha256:' + 'a'.repeat(64) }, first_captured_at: first, expires_at: expires, limitations: ['No reliable branch observed.'] });
  const packet = { format: 'grounds.source-clue/v1', project: { id: 'p', root: '/selected/project' }, clues: [clue('c1'), clue('c2')] };
  const call = async (...args: string[]) => execute(['eval', 'clue', ...args, '--draft-root', draftRoot, '--config', join(root, 'not-configured')]) as Promise<any>;
  try {
    writeFileSync(file, JSON.stringify(packet));
    const imported = await call('import', '--file', file); assertContract('eval.schema.json', imported);
    assert.equal(imported.payload.clues.length, 2); assert.equal(new QADraftStore(draftRoot).list().length, 0);
    assert.equal((await call('import', '--file', file)).payload.clues[0].version, 1);
    const page = await call('list', '--limit', '1', '--project', 'p', '--host', 'codex-cli');
    assert.equal(page.payload.clues.length, 1); assert.equal(page.payload.next_cursor, 'c1'); assertContract('eval.schema.json', page);
    assert.equal((await call('list', '--cursor', page.payload.next_cursor)).payload.clues[0].id, 'c2');
    const ignored = await call('ignore', 'c1', '--expected-version', '1'); assert.equal(ignored.payload.state, 'ignored'); assert.equal(ignored.payload.version, 2);
    assert.equal((await call('import', '--file', file)).payload.clues[0].state, 'ignored');
    await assert.rejects(call('ignore', 'c1', '--expected-version', '1'), (e: any) => e.code === 'VERSION_CONFLICT');
    const originalClock = Date.now; Date.now = () => now + 2 * 86400000;
    try {
      assert.equal((await call('show', 'c2')).payload.state, 'expired');
      assert.equal((await call('import', '--file', file)).payload.clues[1].state, 'expired');
      assert.equal((await call('list', '--state', 'expired')).payload.clues.length, 1);
      assert.equal((await call('show', 'c1')).payload.state, 'ignored');
    } finally { Date.now = originalClock; }
    const changed = structuredClone(packet); changed.clues[0].reason = 'new_reason'; writeFileSync(file, JSON.stringify(changed));
    await assert.rejects(call('import', '--file', file), (e: any) => e.code === 'VALIDATION_ERROR');
    const withBody = { ...packet, content: 'must not persist transcript' }; writeFileSync(file, JSON.stringify(withBody));
    await assert.rejects(call('import', '--file', file));
    assert.ok(!JSON.stringify((await call('show', 'c1')).payload).includes('content'));
    assert.equal(readFileSync(file, 'utf8').includes('must not persist'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
