import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { captureArtifact, materializeCandidateWorktree } from '../src/git.js';
import { DomainError } from '../src/errors.js';
import { addFixtureSubmodule, fixtureGit as git } from './submodule-fixture.js';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'grounds-submodules-'));
  const source = join(root, 'source');
  git(root, 'init', '-q', source);
  git(source, 'config', 'user.name', 'T'); git(source, 'config', 'user.email', 't@example.test');
  writeFileSync(join(source, '.gitignore'), '.grounds/\n');
  writeFileSync(join(source, 'main.txt'), 'baseline\n');
  // Spaces and a newline exercise NUL-delimited paths, not human status parsing.
  const path = 'support/orm with\nspace';
  const module = addFixtureSubmodule(root, source, path);
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'baseline');
  const baseline = 'sha1:' + git(source, 'rev-parse', 'HEAD');
  return { root, source, module, path, baseline };
};

test('clean initialized and empty uninitialized submodules capture the same pinned Candidate offline', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, 'main.txt'), 'candidate\n');
    const initialized = captureArtifact(f.source, f.baseline);
    git(f.source, 'submodule', 'deinit', '-f', '--all');
    assert.deepEqual(readdirSync(f.module), []);
    const empty = captureArtifact(f.source, f.baseline);
    assert.equal(empty.patch_digest, initialized.patch_digest);
    assert.equal(empty.result_tree_oid, initialized.result_tree_oid);
    git(f.source, 'add', 'main.txt'); git(f.source, 'commit', '-qm', 'fixed candidate');
    const source = 'sha1:' + git(f.source, 'rev-parse', 'HEAD');
    const review = join(f.root, 'review');
    materializeCandidateWorktree({ source_path: f.source, source_commit: source, target_path: review, mode: 'review', baseline_oid: f.baseline, patch: empty.patch, expected_tree_oid: empty.result_tree_oid });
    assert.deepEqual(readdirSync(join(review, f.path)), []);
    assert.equal(captureArtifact(review, f.baseline).result_tree_oid, empty.result_tree_oid);
    git(f.source, 'worktree', 'remove', '--force', review);
    assert.equal(git(f.source, 'worktree', 'list', '--porcelain').match(/worktree /g)?.length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('capture checks nested submodules even when the parent Git status ignores them', () => {
  const f = fixture();
  try {
    const nested = addFixtureSubmodule(join(f.root, 'nested'), f.module, 'nested');
    git(f.module, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-qam', 'nested baseline');
    git(f.source, 'add', '.'); git(f.source, 'commit', '-qm', 'nested baseline');
    const baseline = 'sha1:' + git(f.source, 'rev-parse', 'HEAD');
    git(f.module, 'submodule', 'deinit', '-f', '--all');
    assert.doesNotThrow(() => captureArtifact(f.source, baseline));
    git(f.module, 'config', 'submodule.fixture-orm.ignore', 'all');
    writeFileSync(join(nested, 'lost.txt'), 'must not disappear');
    assert.throws(() => captureArtifact(f.source, baseline), (error: unknown) => error instanceof DomainError && String(error.details.reason).includes('submodule'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const scenario of ['tracked edits', 'untracked files', 'HEAD drift', 'nonempty uninitialized', 'changed uninitialized gitlink', 'symlink checkout', 'conflicted gitlink'] as const) {
  test(`capture rejects submodule ${scenario} instead of losing content`, () => {
    const f = fixture();
    try {
      git(f.source, 'config', 'diff.ignoreSubmodules', 'all');
      git(f.module, 'config', 'status.showUntrackedFiles', 'no');
      if (scenario === 'tracked edits') writeFileSync(join(f.module, 'schema.txt'), 'uncommitted\n');
      if (scenario === 'untracked files') writeFileSync(join(f.module, 'new.txt'), 'untracked\n');
      if (scenario === 'HEAD drift') {
        git(f.module, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-qm', 'new head');
      }
      if (scenario === 'nonempty uninitialized' || scenario === 'changed uninitialized gitlink') {
        git(f.source, 'submodule', 'deinit', '-f', '--all');
        if (scenario === 'nonempty uninitialized') writeFileSync(join(f.module, 'hidden.txt'), 'must not disappear\n');
        else git(f.source, 'update-index', '--cacheinfo', '160000', '1'.repeat(40), f.path);
      }
      if (scenario === 'symlink checkout') { rmSync(f.module, { recursive: true }); symlinkSync(join(f.root, 'orm-upstream'), f.module); }
      if (scenario === 'conflicted gitlink') {
        const oid = git(f.module, 'rev-parse', 'HEAD');
        execFileSync('git', ['update-index', '-z', '--index-info'], { cwd: f.source, input: `0 ${'0'.repeat(40)}\t${f.path}\0` + `160000 ${oid} 1\t${f.path}\0` + `160000 ${oid} 2\t${f.path}\0` });
      }
      assert.throws(() => captureArtifact(f.source, f.baseline), (error: unknown) => error instanceof DomainError && error.code === 'WORKTREE_MISMATCH' && String(error.details.reason).includes('submodule'));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
