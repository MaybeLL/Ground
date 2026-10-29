import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';

const vendor = new URL('../typescript/vendor/', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('vendored bundle and license texts match the reviewed component inventory', () => {
  const inventory = JSON.parse(readFileSync(new URL('mermaid-components.json', vendor), 'utf8'));
  assert.equal(sha256(readFileSync(new URL(inventory.bundle, vendor))), inventory.bundle_sha256);
  assert.equal(inventory.components.length, 67);
  assert.equal(new Set(inventory.components.map(item => `${item.name}@${item.version}`)).size, 67);
  for (const item of inventory.components) {
    assert.ok(item.license && item.license_files.length, `${item.name} lacks a license`);
    for (const file of item.license_files) assert.ok(inventory.license_files_sha256[file]);
  }
  for (const [file, digest] of Object.entries(inventory.license_files_sha256)) {
    assert.equal(sha256(readFileSync(new URL(file, vendor))), digest, file);
  }
});
