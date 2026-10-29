import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPrivateGraderTargets, removePrivateGraderFiles } from '../src/eval-private-files.js';

test('private grader cleanup refuses a candidate-controlled parent link and preserves host files', () => {
  const root = mkdtempSync(join(tmpdir(), 'grounds-private-grader-'));
  try {
    const workspace = join(root, 'workspace'), outside = join(root, 'outside');
    mkdirSync(workspace); mkdirSync(outside); mkdirSync(join(workspace, 'pkg'));
    writeFileSync(join(outside, 'grader_test.go'), 'host evidence');
    assertPrivateGraderTargets(workspace, ['pkg/grader_test.go']);
    writeFileSync(join(workspace, 'pkg/grader_test.go'), 'private fixture');
    renameSync(join(workspace, 'pkg'), join(workspace, 'saved'));
    symlinkSync(outside, join(workspace, 'pkg'));
    assert.throws(() => removePrivateGraderFiles(workspace, ['pkg/grader_test.go']));
    assert.equal(readFileSync(join(outside, 'grader_test.go'), 'utf8'), 'host evidence');
    assert.throws(() => assertPrivateGraderTargets(workspace, ['pkg/grader_test.go']));
    assert.throws(() => assertPrivateGraderTargets(workspace, ['saved/grader_test.go']), /already exists/);
    removePrivateGraderFiles(workspace, ['saved/grader_test.go']);
    assertPrivateGraderTargets(workspace, ['saved/grader_test.go']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
