import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const cli = json('typescript/package.json');
const tui = json('tui/package.json');
const plugin = json('plugins/grounds/.codex-plugin/plugin.json');
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(cli.version)) throw new Error('A stable X.Y.Z version is required');
if (tui.version !== cli.version || plugin.version !== cli.version) throw new Error('CLI, TUI and plugin versions must agree');
for (const folder of ['typescript', 'tui']) {
  const manifest = json(`${folder}/package.json`), lock = json(`${folder}/package-lock.json`);
  if (lock.version !== manifest.version || lock.packages[''].version !== manifest.version || lock.name !== manifest.name || lock.packages[''].name !== manifest.name) throw new Error(`${folder}: lock identity differs from manifest`);
  if (!manifest.license || manifest.license === 'UNLICENSED') throw new Error('Maintainer must resolve project licensing before distributing release artifacts');
}
if (!existsSync(resolve(root, 'LICENSE')) || readFileSync(resolve(root, 'LICENSE'), 'utf8').trim().length < 100) throw new Error('A reviewed project LICENSE is required for distribution');
const tag = process.env.GITHUB_REF_NAME ?? `v${cli.version}`;
if (tag !== `v${cli.version}`) throw new Error('Release tag must be v plus the shared package version');
if (git('rev-parse', `${tag}^{commit}`) !== git('rev-parse', 'HEAD')) throw new Error('Release tag does not identify HEAD');
git('merge-base', '--is-ancestor', 'HEAD', 'origin/main');
if (git('status', '--porcelain')) throw new Error('Release requires a clean working tree');
console.log(`Release checks passed for ${tag}`);
