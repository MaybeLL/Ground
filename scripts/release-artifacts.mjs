// Build first. This script packages and independently installs the actual assets.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'output/release'));
mkdirSync(output, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 600000, ...options });
const temporary = mkdtempSync(join(tmpdir(), 'grounds-release-install-'));
try {
  const sums = [];
  for (const [folder, bin] of [['typescript', 'grounds'], ['tui', 'grounds-tui']]) {
    const cwd = join(root, folder);
    const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd }))[0];
    const tarball = join(output, packed.filename);
    const prefix = join(temporary, folder);
    // Install runtime dependencies from the public registry, including native addons.
    // Do not reuse or symlink workspace node_modules: this is a user's install path.
    run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', tarball], { stdio: 'inherit' });
    const help = run(join(prefix, 'node_modules/.bin', bin), ['--help'], { cwd: temporary, env: { ...process.env, HOME: temporary } });
    if (!help.toLowerCase().includes('grounds')) throw new Error(`${bin} installed executable failed its help smoke test`);
    sums.push(`${createHash('sha256').update(readFileSync(tarball)).digest('hex')}  ${packed.filename}`);
  }
  // Help alone does not open a TUI session. Exercise the independently
  // installed pair so a stale compatibility check cannot ship unnoticed.
  const cli = join(temporary, 'typescript/node_modules/.bin/grounds');
  const config = join(temporary, 'config.yaml');
  run(cli, ['init', '--driver', 'sqlite', '--path', join(temporary, 'ledger.db'), '--config', config, '--non-interactive', '--json'], { cwd: temporary });
  const { Client } = await import(pathToFileURL(join(temporary, 'tui/node_modules/@maybell/grounds-tui/dist/client.js')).href);
  const client = await Client.open({ cli, config, cwd: temporary, timeout: 30000 });
  await client.close();
  writeFileSync(join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  console.log('Release tarballs passed independent installs, executable smoke tests and CLI/TUI compatibility.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
