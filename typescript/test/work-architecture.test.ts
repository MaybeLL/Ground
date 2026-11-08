import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Layers of src/work, plus what an import can resolve to outside them. */
type Target = 'domain' | 'ports' | 'application' | 'driver' | 'adapters' | 'entry' | 'composition' | 'legacy' | 'node' | 'package';

/** What each layer may import. Same-layer imports are always allowed. */
export const allowed: Record<string, readonly Target[]> = {
  domain: ['domain'],
  ports: ['domain', 'ports'],
  application: ['domain', 'ports', 'application'],
  driver: ['domain', 'ports', 'application', 'driver', 'node', 'package'],
  adapters: ['domain', 'ports', 'adapters', 'legacy', 'node', 'package'],
  entry: ['domain', 'application', 'driver', 'entry', 'legacy', 'node', 'package'],
  composition: ['domain', 'ports', 'application', 'driver', 'adapters', 'entry', 'composition', 'legacy', 'node', 'package'],
};

/** Module specifiers in a TypeScript source: static, re-export, dynamic and require forms. */
export function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const found: string[] = [];
  for (const pattern of [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) for (const match of code.matchAll(pattern)) found.push(match[1]);
  return found;
}

/** Layer of a path relative to src/work (posix), or 'composition' for the root file. */
function layerOf(path: string): string | undefined {
  const first = path.split('/')[0];
  if (first === 'composition.ts' || first === 'composition.js') return 'composition';
  return first in allowed ? first : undefined;
}

/** Violations in `files` (paths relative to src/work, posix) mapped to their source text. */
export function violations(files: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    const from = layerOf(file);
    if (!from) { problems.push(`${file}: lives outside a known layer`); continue; }
    for (const specifier of specifiers(source)) {
      let target: Target;
      if (specifier.startsWith('node:')) target = 'node';
      else if (!specifier.startsWith('.')) target = 'package';
      else {
        const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
        target = resolved.startsWith('..') ? 'legacy' : (layerOf(resolved) as Target | undefined) ?? 'legacy';
      }
      if (target !== from && !allowed[from].includes(target)) problems.push(`${file}: ${from} must not import ${target} (${specifier})`);
    }
  }
  return problems;
}

function collect(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts')) files[relative(root, path).split(sep).join('/')] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return files;
}

test('src/work respects the layer dependency rules', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'work');
  const files = collect(root);
  assert.ok(Object.keys(files).length >= 7, 'skeleton files are present');
  assert.deepEqual(violations(files), []);
});

test('the checker rejects each kind of forbidden import', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['domain/a.ts', `import { readFileSync } from "node:fs";`, /domain must not import node/],
    ['domain/a.ts', `import yaml from "yaml";`, /domain must not import package/],
    ['domain/a.ts', `import { x } from "../ports/store.js";`, /domain must not import ports/],
    ['domain/a.ts', `import type { M } from "../../module.js";`, /domain must not import legacy/],
    ['ports/a.ts', `export * from "../application/use.js";`, /ports must not import application/],
    ['application/a.ts', `import { sql } from "../adapters/sql.js";`, /application must not import adapters/],
    ['application/a.ts', `const m = await import("../driver/run.js");`, /application must not import driver/],
    ['application/a.ts', `const fs = require("node:fs");`, /application must not import node/],
    ['driver/a.ts', `import { sql } from "../adapters/sql.js";`, /driver must not import adapters/],
    ['adapters/a.ts', `import { use } from "../application/use.js";`, /adapters must not import application/],
    ['entry/a.ts', `import { sql } from "../adapters/sql.js";`, /entry must not import adapters/],
    ['stray.ts', `export {};`, /outside a known layer/],
  ];
  for (const [file, source, pattern] of cases)
    assert.match(violations({ [file]: source }).join('\n'), pattern, `${file}: ${source}`);
});

test('the checker accepts legitimate imports and ignores comments', () => {
  assert.deepEqual(violations({
    'domain/a.ts': `// import { x } from "node:fs";\n/* import y from "../ports/p.js" */\nimport { b } from "./b.js";`,
    'ports/a.ts': `import type { A } from "../domain/a.js";`,
    'application/a.ts': `import { A } from "../domain/a.js";\nimport type { P } from "../ports/a.js";`,
    'driver/a.ts': `import { setTimeout } from "node:timers/promises";\nimport { U } from "../application/a.js";`,
    'adapters/a.ts': `import { P } from "../ports/a.js";\nimport { Store } from "../../sql-store.js";\nimport { createHash } from "node:crypto";`,
    'entry/a.ts': `import { U } from "../application/a.js";\nimport { envelope } from "../../cli.js";`,
    'composition.ts': `import { sql } from "./adapters/sql.js";\nimport { cli } from "./entry/cli.js";`,
  }), []);
});
