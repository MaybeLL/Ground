import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only the root project's release version is irrelevant to installed dependencies.
// Keep all other manifest/lock fields, including every dependency's version.
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function dependencyFingerprint(directory) {
  const manifest = object(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')), 'package.json');
  const lock = object(JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8')), 'package-lock.json');
  if (lock.lockfileVersion !== 3) throw new Error('Expected package-lock.json lockfileVersion 3');
  const root = object(object(lock.packages, 'lock packages')[''], 'lock root package');
  for (const input of [manifest, lock, root]) {
    if (typeof input.version !== 'string' || !input.version) throw new Error('Expected a root project version');
    delete input.version;
  }
  return `grounds-dependencies-v1:${createHash('sha256').update(canonical({ manifest, lock })).digest('hex')}`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: dependency-fingerprint.mjs PROJECT_DIRECTORY');
    console.log(dependencyFingerprint(process.argv[2]));
  } catch (error) {
    console.error(`Invalid dependency inputs: ${error.message}`);
    process.exitCode = 2;
  }
}
