// Build first. Package and independently install the actual CLI release asset.
import { acceptFirstWork } from "./installed-work-smoke.mjs";
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
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
  const platform = `${process.platform}-${process.arch}`;
  const targets = process.argv.includes('--all-platforms') ? ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] : [platform];
  for (const target of targets) {
    if (!existsSync(join(root, 'typescript', 'prebuilds', target, 'peercred.node'))) throw new Error(`Missing release binary for ${target}`);
  }
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: join(root, 'typescript') }))[0];
  const tarball = join(output, packed.filename);
  const entries = run('tar', ['-tzf', tarball]).split(/\r?\n/);
  for (const target of targets) if (!entries.includes(`package/prebuilds/${target}/peercred.node`)) throw new Error(`Tarball omitted ${target}`);

  // Only Node, its npm CLI and Git are on PATH. A dependency that tries to
  // compile from C/C++ cannot borrow the release runner's compiler or Python.
  const bin = join(temporary, 'bin');
  mkdirSync(bin);
  for (const program of ['node', 'npm', 'git']) {
    const executable = program === 'node' ? process.execPath : run('which', [program]).trim();
    symlinkSync(executable, join(bin, program));
  }
  const env = { ...process.env, PATH: bin, HOME: temporary, GROUNDS_DATA_HOME: join(temporary, 'data'), npm_config_cache: join(temporary, 'npm-cache') };
  const start = performance.now();
  run('npm', ['install', '--prefix', temporary, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', tarball], { env, stdio: 'inherit', timeout: 300000 });
  const installed = join(temporary, 'node_modules', packed.name);
  const native = createRequire(import.meta.url)(join(installed, 'prebuilds', platform, 'peercred.node'));
  const fd = openSync(join(temporary, 'lock'), 'wx');
  try { native.tryLock(fd, false); } finally { closeSync(fd); }
  acceptFirstWork(join(temporary, 'node_modules/.bin/grounds'), temporary, env);
  const seconds = (performance.now() - start) / 1000;
  console.log(`Package install through first accepted work: ${seconds.toFixed(2)} s (${platform})`);
  if (seconds > 300) throw new Error('Installation and first accepted work exceeded five minutes');
  writeFileSync(join(output, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(tarball)).digest('hex')}  ${packed.filename}\n`);
  console.log('Release CLI tarball passed an independent install, executable and task/storage smoke tests.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
