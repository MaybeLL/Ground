// Build first. Package and independently install the actual CLI release asset.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'output/release'));
mkdirSync(output, { recursive: true });
// A release must not accidentally include a retired package or stale checksum.
// Never delete caller-owned output; require an explicit fresh destination.
if (readdirSync(output).length) throw new Error('Release output directory must be empty');
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 600000, ...options });
const temporary = mkdtempSync(join(tmpdir(), 'grounds-release-install-'));
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: join(root, 'typescript') }))[0];
  const tarball = join(output, packed.filename);
  // A user's install path: public registry dependencies, including native addons,
  // with no reuse or symlinks to source-tree node_modules.
  run('npm', ['install', '--prefix', temporary, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', tarball], { stdio: 'inherit' });
  const cli = join(temporary, 'node_modules/.bin/grounds');
  const options = { cwd: temporary, env: { ...process.env, HOME: temporary } };
  const help = run(cli, ['--help'], options);
  if (!help.toLowerCase().includes('grounds')) throw new Error('Installed CLI failed its help smoke test');
  const config = join(temporary, 'config.yaml');
  run(cli, ['init', '--driver', 'sqlite', '--path', join(temporary, 'ledger.db'), '--config', config, '--non-interactive', '--json'], options);
  // Verify the remaining public use case against the installed native storage.
  const envelope = JSON.parse(run(cli, ['task', 'list', '--config', config, '--json'], options));
  const tasks = envelope.data;
  if (envelope.ok !== true || tasks?.result_type !== 'grounds.result.task.list/v1' || !Array.isArray(tasks.tasks) || tasks.tasks.length !== 0)
    throw new Error('Installed CLI failed its task/storage smoke test');
  writeFileSync(join(output, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(tarball)).digest('hex')}  ${packed.filename}\n`);
  console.log('Release CLI tarball passed an independent install, executable and task/storage smoke tests.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
