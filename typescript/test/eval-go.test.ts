import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureCommittedCandidate } from '../src/development-branch.js';
import { gradeGoCandidate, interpretGoResult, type UnitTestRequest } from '../src/eval-go.js';
import { decodeSubmission } from '../src/evaluation.js';
import { newUUIDv7 } from '../src/identity.js';
import { addFixtureSubmodule } from './submodule-fixture.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const captureArtifact = (cwd: string, base: string) => {
  git(cwd, 'add', '-A'); git(cwd, 'commit', '--allow-empty', '-qm', 'fixed candidate');
  const fixed = captureCommittedCandidate(cwd, base); return {...fixed.artifact, source: fixed.source};
};
const fixture = (withSubmodule = false) => {
  const root = mkdtempSync(join(tmpdir(), 'eval-go-adapter-'));
  const source = join(root, 'source');
  execFileSync('git', ['init', '-q', source]);
  git(source, 'remote', 'add', 'origin', 'ssh://git@example.test/repo');
  git(source, 'config', 'user.name', 'Tester'); git(source, 'config', 'user.email', 'tester@example.test');
  if (withSubmodule) addFixtureSubmodule(root, source);
  writeFileSync(join(source, 'go.mod'), 'module fixture\n\ngo 1.19\n');
  writeFileSync(join(source, '.gitignore'), '.grounds/\n');
  writeFileSync(join(source, 'production.go'), 'package fixture\nconst Value = 0\n');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'baseline');
  const baseline = { git_oid: `sha1:${git(source, 'rev-parse', 'HEAD')}`, reachability: 'unconfirmed' as const, warning: 'fixture', override_reason: 'fixture' };
  writeFileSync(join(source, 'production.go'), 'package fixture\nconst Value = 1\n');
  const artifact = captureArtifact(source, baseline.git_oid);
  const request: UnitTestRequest = {
    source,
    candidate: { candidate_id: newUUIDv7(), issue_revision_id: newUUIDv7(), repository_id: newUUIDv7(), canonical_remote: 'ssh://git@example.test/repo', baseline, source: artifact.source, patch: artifact.patch, patch_digest: artifact.patch_digest, result_tree_oid: artifact.result_tree_oid },
    definition: { type: 'unit_test', adapter: 'go', package: '.', test_name: 'TestBehavior', timeout_seconds: 1, files: [{ path: 'private_test.go', content: 'package fixture' }] },
  };
  return { root, request, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};
const events = (output = '') => [{ Action: 'run', Test: 'TestBehavior' }, ...(output ? [{ Action: 'output', Test: 'TestBehavior', Output: output }] : []), { Action: 'pass', Test: 'TestBehavior' }].map(e => JSON.stringify(e)).join('\n');

test('Go adapter grades and cleans up with an unchanged uninitialized submodule', async () => {
  const f = fixture(true);
  try {
    const originalHead = git(join(f.request.source, 'support/orm'), 'rev-parse', 'HEAD');
    let worktree = '';
    const result = await gradeGoCandidate(f.request, async command => {
      worktree = command.cwd;
      assert.match(git(worktree, 'submodule', 'status'), /^-/);
      return { exit_code: 0, stdout: events(), stderr: '' };
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.outcome, { kind: 'decision', verdict: 'pass' });
    assert.equal(existsSync(worktree), false);
    assert.equal(git(f.request.source, 'worktree', 'list', '--porcelain').match(/worktree /g)?.length, 1);
    assert.equal(git(join(f.request.source, 'support/orm'), 'rev-parse', 'HEAD'), originalHead);
  } finally { f.cleanup(); }
});

test('Go adapter retains passing evidence and the reason for uncapturable submodule files', async () => {
  const f = fixture(true);
  try {
    const result = await gradeGoCandidate(f.request, async command => {
      writeFileSync(join(command.cwd, 'support/orm/uncaptured.txt'), 'uncaptured change');
      return { exit_code: 0, stdout: events(), stderr: '' };
    });
    assert.equal(result.status, 'error');
    assert.equal('outcome' in result, false);
    assert.match(result.explanation, /uninitialized checkout contains files/);
    assert.match(result.explanation, /support\/orm/);
    assert.ok(result.evidence.some(e => e.content.includes('pass')));
    assert.equal(git(f.request.source, 'worktree', 'list', '--porcelain').match(/worktree /g)?.length, 1);
  } finally { f.cleanup(); }
});

test('Go adapter rejects success obtained after changing Candidate production files', async () => {
  const f = fixture();
  try {
    let worktree = '';
    const result = await gradeGoCandidate(f.request, async command => {
      worktree = command.cwd;
      assert.ok(existsSync(join(worktree, 'private_test.go')));
      writeFileSync(join(worktree, 'production.go'), 'package fixture\nconst Value = 999\n');
      return { exit_code: 0, stdout: events(), stderr: '' };
    });
    assert.equal(result.status, 'error'); assert.match(result.explanation, /Candidate files changed/);
    assert.equal('outcome' in result, false);
    assert.ok(result.evidence.some(e => e.content.includes('pass')));
    assert.equal(existsSync(worktree), false);
    assert.equal(git(f.request.source, 'worktree', 'list', '--porcelain').match(/worktree /g)?.length, 1);
  } finally { f.cleanup(); }
});

test('Go adapter preserves the complete output beyond 60 KB, including the terminal event', async () => {
  const f = fixture();
  try {
    const stdout = events('x'.repeat(80000) + ' tail assertion');
    const result = await gradeGoCandidate(f.request, async () => ({ exit_code: 0, stdout, stderr: 'diagnostic' }));
    assert.equal(result.status, 'completed');
    const reconstructed = result.evidence.filter(e => e.content.startsWith('stdout part ')).map(e => e.content.slice(e.content.indexOf('\n') + 1)).join('');
    assert.equal(reconstructed, stdout);
    assert.ok(result.evidence.every(e => Buffer.byteLength(e.content) <= 65536));
    assert.doesNotThrow(() => decodeSubmission({ format: 'patchledger.eval-grader-submission/v1', execution_id: newUUIDv7(), context_digest: 'sha256:' + '1'.repeat(64), ...result }));
  } finally { f.cleanup(); }
});

test('Go adapter materialization failure does not start a process', async () => {
  const f = fixture();
  try {
    const result = await gradeGoCandidate({ ...f.request, candidate: { ...f.request.candidate, result_tree_oid: 'sha1:' + '0'.repeat(40) } }, async () => assert.fail('process must not run'));
    assert.equal(result.status, 'error'); assert.match(result.explanation, /setup\/execution error/);
    assert.equal(git(f.request.source, 'worktree', 'list', '--porcelain').match(/worktree /g)?.length, 1);
  } finally { f.cleanup(); }
});

test('malformed Go events become execution errors instead of throwing or passing', () => {
  for (const stdout of ['null', '[]', '{"Action":"run","Test":123}', 'garbage']) {
    assert.equal(interpretGoResult('TestBehavior', { exit_code: 0, stdout, stderr: '' }).status, 'error');
  }
});

test('cleanup failure retains executed evidence and a recoverable worktree instead of success', async () => {
  const f = fixture();
  let worktree = '';
  try {
    const result = await gradeGoCandidate(f.request, async command => {
      worktree = command.cwd;
      git(f.request.source, 'worktree', 'lock', worktree);
      return { exit_code: 0, stdout: events(), stderr: '' };
    });
    assert.equal(result.status, 'error');
    assert.match(result.explanation, /cleanup failed/);
    assert.ok(result.evidence.some(e => e.content.includes('pass')));
    assert.ok(existsSync(worktree));
  } finally {
    if (worktree && existsSync(worktree)) {
      git(f.request.source, 'worktree', 'unlock', worktree);
      git(f.request.source, 'worktree', 'remove', '--force', worktree);
      rmSync(join(worktree, '..'), { recursive: true, force: true });
    }
    f.cleanup();
  }
});

for (const vendor of [false, true]) test(`nested Go module uses its own dependencies (vendor=${vendor})`, async () => {
  const f = fixture();
  try {
    const src = join(f.request.source, 'src'); mkdirSync(src);
    renameSync(join(f.request.source, 'go.mod'), join(src, 'go.mod'));
    renameSync(join(f.request.source, 'production.go'), join(src, 'production.go'));
    writeFileSync(join(f.request.source, 'go.mod'), 'module outer\n\ngo 1.19\n');
    mkdirSync(join(f.request.source, 'vendor'));
    writeFileSync(join(f.request.source, 'vendor', 'sentinel'), 'outer');
    if (vendor) { mkdirSync(join(src, 'vendor')); writeFileSync(join(src, 'vendor', 'modules.txt'), ''); }
    const artifact = captureArtifact(f.request.source, f.request.candidate.baseline.git_oid);
    f.request.candidate = { ...f.request.candidate, ...artifact }; f.request.definition.package = 'src';
    const result = await gradeGoCandidate(f.request, async command => {
      assert.equal(command.cwd.endsWith('/src'), true);
      assert.ok(command.args.includes(vendor ? '-mod=vendor' : '-mod=readonly'));
      assert.equal(command.args.at(-1), '.');
      assert.equal(command.env.GOPROXY, 'off'); assert.equal(command.env.GOWORK, 'off');
      return { exit_code: 0, stdout: events(), stderr: '' };
    });
    assert.equal(result.status, 'completed', result.explanation);
    assert.equal(JSON.parse(result.evidence[0].content).cwd, 'src');
  } finally { f.cleanup(); }
});

for (const kind of ['missing', 'module-link', 'vendor-link']) test(`reject unsafe module setup: ${kind}`, async () => {
  const f = fixture();
  try {
    if (kind !== 'vendor-link') rmSync(join(f.request.source, 'go.mod'));
    if (kind === 'module-link') symlinkSync('/tmp/host-go.mod', join(f.request.source, 'go.mod'));
    if (kind === 'vendor-link') symlinkSync('/tmp/host-vendor', join(f.request.source, 'vendor'));
    f.request.candidate = { ...f.request.candidate, ...captureArtifact(f.request.source, f.request.candidate.baseline.git_oid) };
    const result = await gradeGoCandidate(f.request, async () => assert.fail('must not run'));
    assert.equal(result.status, 'error');
    assert.equal(git(f.request.source, 'worktree', 'list', '--porcelain').match(/worktree /g)?.length, 1);
  } finally { f.cleanup(); }
});
