import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('GitHub release rejects unlicensed, untagged, divergent, mismatched and dirty sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'grounds-github-release-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const json = (path, value) => writeFileSync(join(root, path), JSON.stringify(value));
  const check = () => spawnSync(process.execPath, [join(root, 'scripts/github-release-check.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_REF_NAME: 'v1.2.3', GITHUB_REPOSITORY: 'MaybeLL/Ground' } });
  try {
    for (const folder of ['scripts', 'typescript', 'tui', 'plugins/grounds/.codex-plugin']) mkdirSync(join(root, folder), { recursive: true });
    copyFileSync(new URL('./github-release-check.mjs', import.meta.url), join(root, 'scripts/github-release-check.mjs'));
    for (const folder of ['typescript', 'tui']) {
      const manifest = { name: folder, version: '1.2.3', license: 'MIT',
        publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
        repository: { type: 'git', url: 'git+https://github.com/MaybeLL/Ground.git' } };
      json(`${folder}/package.json`, manifest);
      json(`${folder}/package-lock.json`, { ...manifest, packages: { '': manifest } });
    }
    json('plugins/grounds/.codex-plugin/plugin.json', { version: '1.2.3' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release@example.invalid');
    git('add', '.'); git('commit', '-m', 'fixture');
    assert.match(check().stderr, /reviewed project LICENSE/);
    writeFileSync(join(root, 'LICENSE'), 'Test fixture license content. '.repeat(10));
    git('add', '.'); git('commit', '-m', 'license');
    assert.notEqual(check().status, 0, 'missing tag fails');
    git('tag', 'v1.2.3');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(check().status, 0, check().stderr);
    writeFileSync(join(root, 'dirty'), 'dirty');
    assert.match(check().stderr, /clean working tree/);
    rmSync(join(root, 'dirty'));
    json('tui/package.json', { name: 'tui', version: '9.0.0', license: 'MIT' });
    assert.match(check().stderr, /versions must agree/);
    git('checkout', '--', 'tui/package.json');
    json('tui/package.json', { name: 'tui', version: '1.2.3', license: 'UNLICENSED' });
    assert.match(check().stderr, /resolve project licensing/);
    git('checkout', '--', 'tui/package.json');
    const original = JSON.parse(readFileSync(join(root, 'tui/package.json'), 'utf8'));
    for (const patch of [
      { private: true },
      { publishConfig: { ...original.publishConfig, access: 'restricted' } },
      { publishConfig: { ...original.publishConfig, registry: 'https://registry.example.invalid/' } },
    ]) {
      json('tui/package.json', { ...original, ...patch });
      assert.match(check().stderr, /public npm publication/);
      git('checkout', '--', 'tui/package.json');
    }
    json('tui/package.json', { ...original, repository: { type: 'git', url: 'git+https://github.com/MaybeLL/grounds-open.git' } });
    assert.match(check().stderr, /repository must match/);
    git('checkout', '--', 'tui/package.json');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD^');
    assert.notEqual(check().status, 0, 'tag outside main ancestry fails');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
