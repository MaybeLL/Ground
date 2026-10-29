#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../typescript/package.json', import.meta.url));
const { parseDocument } = require('yaml');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const start = '<!-- design-index:start -->';
const end = '<!-- design-index:end -->';
const states = new Set(['todo', 'done', 'discarded']);
const kinds = new Set(['design', 'research', 'review', 'history']);

export function readMetadata(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw Error('missing YAML front matter');
  const document = parseDocument(match[1], { uniqueKeys: true, strict: true });
  if (document.errors.length) throw Error(document.errors.map(e => e.message).join('; '));
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('metadata must be a mapping');
  if (!states.has(value.status)) throw Error('status must be todo, done or discarded');
  if (!kinds.has(value.kind)) throw Error('kind must be design, research, review or history');
  for (const key of ['scope', 'status_note', 'current_design']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw Error(`${key} must be a nonempty string`);
  }
  if (typeof value.status_checked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.status_checked)
      || !Number.isFinite(Date.parse(value.status_checked))
      || new Date(value.status_checked).toISOString().slice(0, 10) !== value.status_checked) throw Error('status_checked must be a real YYYY-MM-DD date');
  if (!Array.isArray(value.status_basis) || !value.status_basis.length
      || value.status_basis.some(v => typeof v !== 'string' || !v.trim())) throw Error('status_basis must contain evidence references');
  return { metadata: value, body: text.slice(match[0].length) };
}

export function slug(title) {
  return title.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
}

function prose(text) {
  const lines = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').split(/\r?\n/);
  const output = []; let fence;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      output.push(''); continue;
    }
    output.push(fence ? '' : line);
  }
  if (fence) throw Error('unclosed Markdown fence');
  return output.join('\n');
}

function anchors(text) {
  const content = prose(text);
  const result = new Set([...content.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
  const counts = new Map();
  for (const match of content.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = slug(match[1]); const count = counts.get(base) ?? 0;
    counts.set(base, count + 1); result.add(count ? `${base}-${count}` : base);
  }
  return result;
}

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  }).sort();
}

export function designIndex(items, root) {
  const escape = value => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const rows = items.map(({ path, metadata, title }) => `| [${escape(title)}](${relative(root, path).split('\\').join('/')}) | ${metadata.kind} | ${metadata.status} | ${escape(metadata.scope)} |`);
  return `${start}\n\n| 历史文档 | 类型 | 状态 | 判断范围 |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n${end}`;
}

export function checkDocumentation(root, { writeIndex = false } = {}) {
  const errors = []; let links = 0;
  // External workspace links retain their original location when this project
  // is checked out in a managed Git worktree. Never fall back for an in-repo
  // missing file: the fixed checkout remains the source of project content.
  let originalRoot;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common.endsWith('/.git') && dirname(common) !== resolve(root)) originalRoot = dirname(common);
  } catch { /* Temporary documentation fixtures need no Git metadata. */ }
  const check = (path, action) => {
    try { return action(); } catch (error) { errors.push(`${relative(root, path)}: ${error.message}`); }
  };
  const reference = (path, destination) => {
    for (const name of ['README.md', 'GROUNDS_DESIGN.md', 'docs/README.md']) {
      const canonical = 'https://github.com/MaybeLL/grounds-open/blob/main/' + name;
      if (destination === canonical || destination.startsWith(canonical + '#')) {
        destination = resolve(root, name) + destination.slice(canonical.length);
        break;
      }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('//')) return;
    const [name, fragment] = destination.replace(/^<|>$/g, '').split('#');
    let target = name ? resolve(dirname(path), decodeURIComponent(name)) : path;
    if (!existsSync(target) && originalRoot && !target.startsWith(resolve(root) + '/')) {
      target = resolve(originalRoot, relative(root, dirname(path)), decodeURIComponent(name));
    }
    links++;
    if (!existsSync(target)) throw Error(`missing local reference: ${destination}`);
    if (fragment && extname(target) === '.md' && !anchors(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment))) throw Error(`missing anchor: ${destination}`);
  };
  const items = [];
  const designs = markdownFiles(resolve(root, 'docs/design'));
  for (const path of designs) check(path, () => {
    const { metadata, body } = readMetadata(readFileSync(path, 'utf8'));
    if (resolve(dirname(path), metadata.current_design) !== resolve(root, 'GROUNDS_DESIGN.md')) throw Error('current_design must reference the unique root design');
    for (const ref of [metadata.current_design, ...metadata.status_basis]) reference(path, ref);
    const title = /^#\s+(.+)$/m.exec(prose(body))?.[1];
    if (!title) throw Error('missing document title');
    items.push({ path, metadata, title });
  });
  const indexDocument = resolve(root, 'GROUNDS_DESIGN.md');
  if ((designs.length || existsSync(indexDocument)) && items.length === designs.length) check(indexDocument, () => {
    const text = readFileSync(indexDocument, 'utf8');
    if (text.split(start).length !== 2 || text.split(end).length !== 2) throw Error('requires exactly one design index block');
    const from = text.indexOf(start), until = text.indexOf(end) + end.length;
    if (until <= from) throw Error('invalid design index order');
    const expected = designIndex(items, root);
    if (text.slice(from, until) !== expected) {
      if (writeIndex) writeFileSync(indexDocument, text.slice(0, from) + expected + text.slice(until));
      else throw Error('stale design index; run node scripts/check-docs.mjs --write-index');
    }
  });
  const entries = ['README.md', 'AGENTS.md', 'docs/README.md', 'typescript/README.md', 'tui/README.md'].map(name => resolve(root, name));
  for (const name of ['GROUNDS_DESIGN.md', 'TODO.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']) {
    if (existsSync(resolve(root, name))) entries.push(resolve(root, name));
  }
  const archiveDirectory = resolve(root, 'docs/validation/dogfooding');
  const archives = markdownFiles(archiveDirectory);
  const validations = markdownFiles(resolve(root, 'docs/validation'));
  const legacy = existsSync(resolve(root, 'docs')) ? readdirSync(resolve(root, 'docs'))
    .filter(name => /^dogfooding-.*\.md$/.test(name) || /^evaluation-.*-validation-\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map(name => resolve(root, 'docs', name)) : [];
  for (const path of legacy) check(path, () => {
    if (!relative(root, path).startsWith('docs/dogfooding-')) throw Error('top-level evaluation validation files must be moved to docs/validation');
    throw Error('top-level dogfooding files must be removed after archival');
  });
  if (archives.length) check(resolve(archiveDirectory, 'manifest.json'), () => {
    const manifest = JSON.parse(readFileSync(resolve(archiveDirectory, 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.source_revision)
        || !Array.isArray(manifest.records) || !manifest.records.length) throw Error('invalid archive manifest');
    const names = manifest.records.map(record => record.file);
    const actual = archives.map(path => relative(archiveDirectory, path)).filter(name => name.startsWith('dogfooding-'));
    if (new Set(names).size !== names.length || names.slice().sort().join('\n') !== actual.sort().join('\n')) throw Error('archive manifest must cover every report exactly once');
    const sha = text => createHash('sha256').update(text).digest('hex');
    for (const record of manifest.records) {
      if (!/^dogfooding-\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(record.file)
          || record.original_path !== 'docs/' + record.file
          || ![record.original_sha256, record.content_sha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
          || !Array.isArray(record.link_rewrites)) throw Error('invalid archived report record');
      const bytes = readFileSync(resolve(archiveDirectory, record.file));
      if (sha(bytes) !== record.content_sha256) throw Error(`archived content digest mismatch: ${record.file}`);
      let original = bytes.toString('utf8');
      for (const rewrite of record.link_rewrites) {
        if (typeof rewrite.from !== 'string' || typeof rewrite.to !== 'string'
            || !original.includes('](' + rewrite.to + ')')) throw Error(`invalid link rewrite: ${record.file}`);
        original = original.replace('](' + rewrite.to + ')', '](' + rewrite.from + ')');
      }
      if (sha(original) !== record.original_sha256) throw Error(`archive changed more than declared links: ${record.file}`);

    }
  });
  const skillDocuments = [
    ...markdownFiles(resolve(root, 'plugins/grounds/references')),
    ...markdownFiles(resolve(root, 'plugins/grounds/skills')),
  ];
  const checkedPaths = [...new Set([...entries, ...markdownFiles(resolve(root, 'docs')), ...designs, ...legacy, ...validations, ...skillDocuments])];
  for (const path of checkedPaths) check(path, () => {
    const source = readFileSync(path, 'utf8');
    if (path === resolve(root, 'README.md') && (source.includes(start) || source.includes(end))) throw Error('design index belongs only in GROUNDS_DESIGN.md');
    const text = prose(source);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) reference(path, match[1]);
    for (const match of text.matchAll(/^ {0,3}\[[^\]]+\]:\s+(\S+)/gm)) reference(path, match[1]);
    if (['typescript/README.md', 'tui/README.md'].includes(relative(root, path))) {
      if (!['GROUNDS_DESIGN.md', 'docs/README.md'].some(name => text.includes('https://github.com/MaybeLL/grounds-open/blob/main/' + name))) throw Error('package entrance must link to the canonical manual');
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(match[1]) && !match[1].startsWith('#')) throw Error('package README links must work outside the repository');
      }
    }
  });
  return { errors, documents: checkedPaths.length, designs: designs.length, links,
    statuses: Object.fromEntries([...states].map(state => [state, items.filter(item => item.metadata.status === state).length])) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = process.argv.slice(2);
  if (options.some(arg => arg !== '--write-index')) throw Error('usage: node scripts/check-docs.mjs [--write-index]');
  const result = checkDocumentation(repository, { writeIndex: options.includes('--write-index') });
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
  else console.log(`docs-check: ${result.documents} documents, ${result.designs} YAML records, ${result.links} local references; statuses=${JSON.stringify(result.statuses)}. Semantic/evidence review remains manual.`);
}
