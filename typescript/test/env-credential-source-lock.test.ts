import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireCredentialSourceLocks, authorizeCredentials, registerCredentialGrant, withCredentialPreparation, type CredentialGrant } from '../src/env-credentials.js';
import { environmentDefinitionOf, implicitHostDefinition } from '../src/env-definition.js';
import { environmentDown, environmentPrivateDirectory, environmentUp, listEnvironments } from '../src/env-environment.js';
import { temporary } from './env-test-helpers.js';

const fixture = async (action: (root: string, workspace: string, grant: CredentialGrant) => Promise<void>) => temporary(async (root, workspace) => {
  const source = join(root, 'auth.json');
  writeFileSync(source, JSON.stringify({ account: 'fixture', method: 'fixture-auth', value: 'temporary-value' }), { mode: 0o600 });
  const grant: CredentialGrant = { name: 'model', repository_id: 'fixture-repository', environment: 'dev', source_file: source,
    account: 'fixture', method: 'fixture-auth', access: 'model', writeback: true, identity_fields: ['account', 'method'] };
  registerCredentialGrant(grant);
  await action(root, workspace, grant);
});

test('authentication source lock blocks preparation before it publishes an instance or injects a copy', async () => fixture(async (_root, workspace, grant) => {
  const definition = environmentDefinitionOf({ ...implicitHostDefinition(), name: 'dev', credentials: [{ name: 'model', path: 'auth.json' }] });
  const input = { definition, workspace, taskRepositoryId: grant.repository_id, resolvedRepositoryId: grant.repository_id };
  const release = acquireCredentialSourceLocks([grant.source_file]);
  try {
    await assert.rejects(environmentUp(input), { code: 'STATE_CONFLICT' });
    assert.equal(listEnvironments().length, 0);
    assert.ok(existsSync(grant.source_file));
  } finally { release(); }
  const prepared = await environmentUp(input);
  assert.equal(prepared.state, 'ready');
  assert.equal(readFileSync(join(environmentPrivateDirectory(prepared.id), 'credentials/auth.json'), 'utf8'), readFileSync(grant.source_file, 'utf8'));
  environmentDown(prepared.id);
}));

test('changed credential source cannot publish a stale preparing occupancy', async () => fixture(async (_root, _workspace, grant) => {
  const bindings = authorizeCredentials({ declarations: [{ name: 'model' }], environment: grant.environment,
    taskRepositoryId: grant.repository_id, resolvedRepositoryId: grant.repository_id });
  writeFileSync(grant.source_file, JSON.stringify({ account: 'fixture', method: 'fixture-auth', value: 'renewed-value' }));
  let published = false;
  assert.throws(() => withCredentialPreparation(bindings, () => { published = true; }), { code: 'VALIDATION_ERROR' });
  assert.equal(published, false);
  assert.equal(listEnvironments().length, 0);
}));

test('failed multi-source acquisition releases earlier locks and duplicate grants share one lock', async () => fixture(async (root, _workspace, grant) => {
  const other = join(root, 'z-other.json');
  writeFileSync(other, '{}', { mode: 0o600 });
  const releaseOther = acquireCredentialSourceLocks([other]);
  try {
    assert.throws(() => acquireCredentialSourceLocks([grant.source_file, other]), { code: 'STATE_CONFLICT' });
    const releaseFirst = acquireCredentialSourceLocks([grant.source_file, grant.source_file]);
    releaseFirst(); releaseFirst();
  } finally { releaseOther(); }
  const releaseAll = acquireCredentialSourceLocks([other, grant.source_file]);
  releaseAll();
}));
