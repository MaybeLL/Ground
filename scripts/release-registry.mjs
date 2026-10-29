#!/usr/bin/env node
// Stable release publication and readback. Never automatically re-publish or move tags.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function stableVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Stable publication requires an explicit X.Y.Z version: ${value}`);
  }
  return value.split('.').map(BigInt);
}
export function guardLatest(version, latest) {
  const target = stableVersion(version), current = stableVersion(latest);
  for (let i = 0; i < 3; i++) {
    if (target[i] > current[i]) return;
    if (target[i] < current[i]) throw new Error(`Refusing latest rollback: ${latest} -> ${version}`);
  }
}
export function checkReadback(manifest, tags, published, integrity) {
  if (tags.latest !== manifest.version || published.version !== manifest.version) {
    throw new Error(`Publication incomplete: expected latest=${manifest.version}, observed latest=${tags.latest}, version=${published.version}`);
  }
  if (!published.dist?.integrity || (integrity && published.dist.integrity !== integrity)) {
    throw new Error('Publication incomplete: registry artifact integrity missing or mismatched');
  }
}
const execute = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', timeout: 120000, ...options,
});

export async function release({ mode, manifest, tarball, run = execute, sleep = ms => new Promise(r => setTimeout(r, ms)), attempts = 3 }) {
  stableVersion(manifest.version);
  if (!['guard', 'verify', 'publish'].includes(mode)) throw new Error('Use guard, verify, or publish');
  const registry = manifest.publishConfig?.registry;
  if (!registry || !/^https?:\/\//.test(registry)) throw new Error('Explicit publishConfig.registry required');
  const cache = mkdtempSync(join(tmpdir(), 'grounds-release-registry-'));
  const query = (...args) => JSON.parse(run('npm', ['view', ...args, '--json', `--registry=${registry}`, '--prefer-online', `--cache=${cache}`]));
  try {
    let integrity;
    if (tarball) {
      tarball = resolve(tarball);
      const packed = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']));
      if (packed.name !== manifest.name || packed.version !== manifest.version) throw new Error('Tarball name/version differs from release package.json');
      integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
    }
    if (mode !== 'verify') {
      // Registry/auth/network errors are failures, never treated as a first release.
      guardLatest(manifest.version, query(manifest.name, 'dist-tags').latest);
    }
    if (mode === 'guard') return;
    if (mode === 'publish') {
      if (!tarball) throw new Error('publish requires a previously verified tarball');
      run('npm', ['publish', tarball, '--ignore-scripts', '--tag=latest', `--registry=${registry}`], { stdio: 'inherit' });
    }
    let failure;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const published = query(`${manifest.name}@${manifest.version}`, 'version', 'dist');
        // Read the mutable tag last; existence of a version is not successful promotion.
        checkReadback(manifest, query(manifest.name, 'dist-tags'), published, integrity);
        return;
      } catch (error) {
        failure = error;
        if (attempt + 1 < attempts) await sleep(2000);
      }
    }
    throw new Error(`Release readback failed; preserve the receipt and inspect registry before retrying. Do not re-publish automatically. ${failure.message}`);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, tarball, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('Usage: node ../scripts/release-registry.mjs guard|verify|publish [tarball]');
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    await release({ mode, manifest, tarball });
    const scope = mode === 'guard' ? 'latest rollback guard only'
      : tarball ? 'latest/version/local tarball SHA-512 matched'
      : 'latest/version matched; registry integrity present; local artifact NOT compared';
    console.log(`release-registry: ${mode} succeeded for ${manifest.name}@${manifest.version}; ${scope}`);
  } catch (error) {
    console.error(`release-registry: ${error.message}`);
    process.exitCode = 1;
  }
}
