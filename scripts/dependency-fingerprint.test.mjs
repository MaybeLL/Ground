import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dependencyFingerprint } from './dev-environment/dependency-fingerprint.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grounds-dependency-fingerprint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = { name: 'fixture', version: '1.0.0', dependencies: { dep: '^2.0.0' }, scripts: { install: 'node install.js' } };
  const lock = { name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: {
    '': { ...manifest },
    'node_modules/dep': { version: '2.0.1', resolved: 'https://example.test/dep.tgz', integrity: 'sha512-fixture' },
  } };
  const save = () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
  };
  save(); return { dir, manifest, lock, save, before: dependencyFingerprint(dir) };
}

test('release version, JSON layout/key order and application source do not invalidate dependencies', t => {
  const x = fixture(t);
  x.manifest.version = x.lock.version = x.lock.packages[''].version = '1.0.1'; x.save();
  mkdirSync(join(x.dir, 'src')); writeFileSync(join(x.dir, 'src/main.ts'), 'export const changed = true;');
  writeFileSync(join(x.dir, 'package.json'), JSON.stringify(Object.fromEntries(Object.entries(x.manifest).reverse()), null, 4));
  assert.equal(dependencyFingerprint(x.dir), x.before);
  assert.match(x.before, /^grounds-dependencies-v1:[0-9a-f]{64}$/);
});

for (const [name, mutate] of [
  ['dependency declaration', x => { x.manifest.dependencies.dep = '^3.0.0'; }],
  ['root lock dependency', x => { x.lock.packages[''].dependencies = { dep: '^3.0.0' }; }],
  ['locked dependency version', x => { x.lock.packages['node_modules/dep'].version = '2.0.2'; }],
  ['dependency integrity', x => { x.lock.packages['node_modules/dep'].integrity = 'sha512-changed'; }],
  ['dependency source', x => { x.lock.packages['node_modules/dep'].resolved = 'https://example.test/other.tgz'; }],
  ['installation script', x => { x.manifest.scripts.install = 'node changed.js'; }],
  ['unknown install metadata', x => { x.manifest.overrides = { dep: '2.0.2' }; }],
]) test(`${name} invalidates the fingerprint`, t => {
  const x = fixture(t); mutate(x); x.save(); assert.notEqual(dependencyFingerprint(x.dir), x.before);
});

for (const [name, mutate] of [
  ['missing root package', x => { delete x.lock.packages['']; }],
  ['invalid version field', x => { x.manifest.version = {}; }],
  ['unsupported lock format', x => { x.lock.lockfileVersion = 2; }],
]) test(`${name} fails closed`, t => {
  const x = fixture(t); mutate(x); x.save(); assert.throws(() => dependencyFingerprint(x.dir));
});

test('malformed JSON exits nonzero without emitting a usable cache marker', t => {
  const x = fixture(t); writeFileSync(join(x.dir, 'package-lock.json'), '{broken');
  const run = spawnSync(process.execPath, ['scripts/dev-environment/dependency-fingerprint.mjs', x.dir], { encoding: 'utf8' });
  assert.equal(run.status, 2); assert.equal(run.stdout, ''); assert.match(run.stderr, /Invalid dependency inputs/);
});
