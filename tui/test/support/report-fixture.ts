import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { executable } from '../../src/client.js';
import type { SQLStore as Store } from '../../../typescript/src/sql-store.js';

/** Test-only setup. Production TUI reads/writes must still use the public CLI.
 * Load the adapter from the exact CLI under test (including registry installs),
 * not from a possibly different checkout. Never initialize or migrate a DB here.
 */
export async function seedReports(options: {
  cli: string; config: string; root: string; seedId: string; count: number; password?: string;
}): Promise<string[]> {
  assert.ok(Number.isSafeInteger(options.count) && options.count > 0 && options.count <= 256, 'fixture count must be 1..256');
  const root = realpathSync(options.root);
  assert.ok(basename(root).startsWith('grounds-tui-integration-'), 'fixture requires its temporary test root');
  assert.equal(realpathSync(options.config), join(root, 'config.yaml'), 'fixture config must be inside its test root');
  const core = dirname(await executable(options.cli));
  const [{ SQLStore }, { loadConfig }, { newUUIDv7 }] = await Promise.all([
    import(pathToFileURL(join(core, 'sql-store.js')).href),
    import(pathToFileURL(join(core, 'config.js')).href),
    import(pathToFileURL(join(core, 'identity.js')).href),
  ]);
  const config = loadConfig(options.config);
  const db = config.database;
  let store: Store;
  if (db.driver === 'sqlite') {
    assert.equal(realpathSync(db.path), join(root, 'ledger.db'), 'fixture requires its temporary SQLite ledger');
    store = SQLStore.sqlite(db.path);
  } else {
    assert.match(db.database, /test/i, 'fixture requires a dedicated MySQL test database');
    assert.equal(db.password.source, 'environment');
    assert.ok(options.password, 'fixture requires explicit test credentials');
    store = SQLStore.mysql({ host: db.host, port: db.port, database: db.database, username: db.username,
      password: options.password, caFile: db.tls.ca_file });
  }
  try {
    const metadata = await store.inspect();
    assert.equal(metadata.database_id, db.expected_database_id, 'fixture database identity mismatch');
    return await store.write(async tx => {
      // Start with a real CLI-submitted, adapter-validated report. Reuse its
      // immutable Candidate bindings and assessments, but give every row new IDs.
      const seed = await tx.getVerification(options.seedId);
      assert.equal(seed.verification.attribution.kind, 'agent');
      assert.equal((seed.verification.attribution as { agent_id?: string }).agent_id, 'tui-fixture-verifier');
      const events = await tx.listLedgerEventsPage(0, '', 'verification', options.seedId, 2);
      assert.equal(events.rows.length, 1);
      const sourceEvent = events.rows[0];
      assert.equal(sourceEvent.event_type, 'verification.submitted');
      const operation = newUUIDv7();
      const command = 'test.fixture.seed'; // Explicit synthetic setup, not a public submission receipt.
      await tx.reserveOperation({ id: operation, command,
        request_hash: 'sha256:' + createHash('sha256').update(JSON.stringify({ seed: options.seedId, count: options.count })).digest('hex') });
      const createdAt = await tx.now();
      const ids: string[] = [];
      for (let i = 0; i < options.count; i++) {
        const id = newUUIDv7();
        await tx.createVerification({ verification: { ...seed.verification, id, created_at: createdAt }, report: seed.report });
        const { event_seq: _, ...event } = sourceEvent;
        await tx.appendLedgerEvent({ ...event, event_id: newUUIDv7(), operation_id: operation,
          subject_id: id, occurred_at: createdAt });
        ids.push(id);
      }
      await tx.completeOperation(operation, JSON.stringify({ result_type: 'grounds.test-fixture/v1', command, verification_ids: ids }));
      return ids;
    });
  } finally { await store.close(); }
}
