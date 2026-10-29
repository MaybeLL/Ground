import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { checkDocumentation, readMetadata } from './check-docs.mjs';

const metadata = `---
status: todo
kind: design
scope: 完整实施
status_note: 验收未完成
status_checked: "2026-10-08"
status_basis:
  - ../../GROUNDS_DESIGN.md#当前设计
current_design: ../../GROUNDS_DESIGN.md
---
`;

function fixture(action) {
  const root = mkdtempSync(join(tmpdir(), 'grounds-docs-check-'));
  const put = (name, text) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  try {
    put('README.md', '# Grounds\n\n[总设计](GROUNDS_DESIGN.md)\n');
    for (const name of ['AGENTS.md', 'TODO.md', 'docs/README.md']) put(name, '# 入口\n');
    put('GROUNDS_DESIGN.md', '# 总设计\n\n## 当前设计\n\n<a id="旧链接"></a>\n\n<!-- design-index:start -->\n<!-- design-index:end -->\n');
    for (const name of ['typescript/README.md', 'tui/README.md']) put(name, '# 包入口\n\n[完整手册](https://git.example.test/review-user/grounds/-/blob/main/GROUNDS_DESIGN.md)\n');
    put('docs/design/example.md', metadata + '# 设计\n\n[当前上下文](../../GROUNDS_DESIGN.md#当前设计)\n');
    assert.deepEqual(checkDocumentation(root, { writeIndex: true }).errors, []);
    action(root, put);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('rejects unknown, duplicate and aliased lifecycle states instead of guessing', () => {
  assert.throws(() => readMetadata('# 未标状态\n'), /front matter/);
  assert.throws(() => readMetadata(metadata.replace('status: todo', 'status: approved')), /status must/);
  assert.throws(() => readMetadata(metadata.replace('status: todo', 'status: todo\nstatus: done')), /unique|unique keys|Map keys/i);
  assert.throws(() => readMetadata(metadata.replace('status: todo', 'status: &state todo\nextra: *state')), /alias/i);
  assert.throws(() => readMetadata(metadata.replace('2026-10-08', '2026-02-31')), /real YYYY/);
  assert.throws(() => readMetadata(metadata.replace('  - ../../GROUNDS_DESIGN.md#当前设计', '  []')), /evidence references/);
});

test('preserves Chinese headings, duplicate anchors, old aliases and ignores code examples', () => fixture((root, put) => {
  const before = readFileSync(join(root, 'GROUNDS_DESIGN.md'), 'utf8');
  put('GROUNDS_DESIGN.md', before.replace('## 当前设计', '## 当前设计\n\n## 当前设计'));
  put('AGENTS.md', '# 规则\n\n[重复标题](GROUNDS_DESIGN.md#当前设计-1)\n[旧入口](GROUNDS_DESIGN.md#旧链接)\n\n```md\n[示例](不存在.md)\n## 不是真标题\n```\n');
  assert.deepEqual(checkDocumentation(root).errors, []);
}));

test('rejects missing evidence, unresolved anchors and unclosed fences', () => fixture((root, put) => {
  put('docs/design/example.md', metadata.replace('#当前设计', '#未存在') + '# 设计\n\n```sh\ncommand\n');
  const result = checkDocumentation(root);
  assert.ok(result.errors.some(error => error.includes('missing anchor')));
  assert.ok(result.errors.some(error => error.includes('unclosed Markdown fence')));
  put('docs/design/example.md', metadata.replace('GROUNDS_DESIGN.md#当前设计', 'missing.md') + '# 设计\n');
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('missing local reference')));
}));

test('detects a changed status index and updates only its generated block', () => fixture((root, put) => {
  const before = readFileSync(join(root, 'GROUNDS_DESIGN.md'), 'utf8');
  const readmeBefore = readFileSync(join(root, 'README.md'), 'utf8');
  put('docs/design/example.md', metadata.replace('status: todo', 'status: discarded').replace('验收未完成', '已决定不采纳，替代方向见总设计') + '# 设计\n');
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('stale design index')));
  assert.deepEqual(checkDocumentation(root, { writeIndex: true }).errors, []);
  const after = readFileSync(join(root, 'GROUNDS_DESIGN.md'), 'utf8');
  assert.equal(after.split('<!-- design-index:start -->')[0], before.split('<!-- design-index:start -->')[0]);
  assert.equal(after.split('<!-- design-index:end -->')[1], before.split('<!-- design-index:end -->')[1]);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), readmeBefore);
  assert.match(after, /discarded/);
  assert.equal(checkDocumentation(root).statuses.discarded, 1);
}));

test('rejects a parallel generated index in the short README', () => fixture((root, put) => {
  put('README.md', '# Grounds\n\n<!-- design-index:start -->\n<!-- design-index:end -->\n');
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('belongs only in GROUNDS_DESIGN.md')));
}));

test('rejects package links that only work inside the source checkout', () => fixture((root, put) => {
  put('typescript/README.md', '# 包入口\n\n[完整手册](https://git.example.test/review-user/grounds/-/blob/main/GROUNDS_DESIGN.md)\n[仓库外文件](../README.md)\n');
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('outside the repository')));
}));

test('checks source skill entrypoints and their private and shared references', () => fixture((root, put) => {
  put('plugins/grounds/skills/grounds/SKILL.md', '# 开发\n[流程](references/workflows/develop.md)\n');
  put('plugins/grounds/references/preparation.md', '# 共享准备\n');
  put('plugins/grounds/skills/grounds/references/workflows/develop.md', '# 开发流程\n[准备](../../../../references/preparation.md)\n');
  assert.deepEqual(checkDocumentation(root).errors, []);
  put('plugins/grounds/skills/grounds/references/workflows/develop.md', '# 开发流程\n[旧位置](../../../../references/workflows/develop.md)\n');
  const result = checkDocumentation(root);
  assert.ok(result.errors.some(error => error.includes('skills/grounds/references/workflows/develop.md') && error.includes('missing local reference')));
}));

test('checks canonical GitLab manual anchors against the current canonical design source', () => fixture((root, put) => {
  put('tui/README.md', '# 包入口\n\n[完整手册](https://git.example.test/review-user/grounds/-/blob/main/GROUNDS_DESIGN.md#不存在的入口)\n');
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('missing anchor')));
}));

test('validates archived bytes and declared link rebasing without legacy files', () => fixture((root, put) => {
  const name = 'dogfooding-2026-09-01-example.md';
  const original = '# 验收记录\n\n[设计](../GROUNDS_DESIGN.md#当前设计)\n';
  const archived = original.replace('../GROUNDS_DESIGN.md', '../../../GROUNDS_DESIGN.md');
  const sha = text => createHash('sha256').update(text).digest('hex');
  const record = { file: name, original_path: 'docs/' + name, original_sha256: sha(original), content_sha256: sha(archived),
    link_rewrites: [{ from: '../GROUNDS_DESIGN.md#当前设计', to: '../../../GROUNDS_DESIGN.md#当前设计' }] };
  const manifest = { version: 1, source_revision: 'a'.repeat(40), records: [record] };
  put('docs/validation/dogfooding/' + name, archived);
  put('docs/validation/dogfooding/manifest.json', JSON.stringify(manifest));
  assert.deepEqual(checkDocumentation(root).errors, []);
  put('docs/validation/dogfooding/' + name, archived + '\n改写历史结论\n');
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('content digest mismatch')));
  record.content_sha256 = sha(archived + '\n改写历史结论\n');
  put('docs/validation/dogfooding/manifest.json', JSON.stringify(manifest));
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('more than declared links')));
  record.content_sha256 = sha(archived);
  put('docs/validation/dogfooding/manifest.json', JSON.stringify(manifest));
  put('docs/validation/dogfooding/' + name, archived);
  assert.deepEqual(checkDocumentation(root).errors, []);
}));

test('requires archive manifest coverage and rejects top-level remnants', () => fixture((root, put) => {
  const name = 'dogfooding-2026-09-01-example.md';
  put('docs/validation/dogfooding/' + name, '# 原记录\n');
  put('docs/validation/dogfooding/manifest.json', JSON.stringify({ version: 1, source_revision: 'a'.repeat(40), records: [] }));
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('invalid archive manifest')));
  const sha = createHash('sha256').update('# 原记录\n').digest('hex');
  put('docs/validation/dogfooding/manifest.json', JSON.stringify({ version: 1, source_revision: 'a'.repeat(40), records: [{ file: name, original_path: 'docs/' + name, original_sha256: sha, content_sha256: sha, link_rewrites: [] }] }));
  put('docs/' + name, '# 原记录\n');
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('top-level dogfooding files must be removed')));
}));

test('checks migrated evaluation validation links and rejects top-level entrances', () => fixture((root, put) => {
  const name = 'evaluation-environments-validation-2026-09-22.md';
  const valid = '# 原验收\n\n[设计](../../GROUNDS_DESIGN.md#当前设计)\n';
  put('docs/validation/' + name, valid);
  assert.deepEqual(checkDocumentation(root).errors, []);
  put('docs/validation/' + name, valid.replace('../../GROUNDS_DESIGN.md', '../GROUNDS_DESIGN.md'));
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('missing local reference')));
  put('docs/validation/' + name, valid);
  put('docs/' + name, '# 旧入口\n');
  assert.ok(checkDocumentation(root).errors.some(error => error.includes('top-level evaluation validation files must be moved')));
}));
