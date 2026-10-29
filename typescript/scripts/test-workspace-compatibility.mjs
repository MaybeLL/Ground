import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { createWorkerHome, workerEnvironment } from './test-environment.mjs';

// Explicit local acceptance only: no image pull, real ledger or installed CLI.
const image = process.env.GROUNDS_COMPAT_MYSQL_IMAGE;
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '') || !process.env.DOCKER_HOST)
  throw new Error('Explicit local GROUNDS_COMPAT_MYSQL_IMAGE and DOCKER_HOST are required');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const home = createWorkerHome('workspace-compatibility');
const name = `grounds-compat-${randomUUID()}`, password = randomBytes(24).toString('hex');
const env = { ...workerEnvironment(home), MYSQL_ROOT_PASSWORD: password, MYSQL_DATABASE: 'grounds_test',
  MYSQL_ROOT_HOST: '%', GROUNDS_DATA_HOME: join(home, 'data'), GROUNDS_RUNTIME_HOME: join(home, 'runtime'),
  DOCKER_CONFIG: join(home, 'docker') };
delete env.DOCKER_CONTEXT;
const docker = args => execFileSync('docker', args, { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const certs = join(home, 'certificates'); mkdirSync(certs);
let passed = false, started = false;
console.log(`Isolated Workspace compatibility: ${home}`);
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(certs, 'server-key.pem'), '-out', join(certs, 'server-cert.pem')], { stdio: 'pipe' });
  // MySQL runs as its own UID; the parent fixture directory remains private.
  const { chmodSync } = await import('node:fs');
  chmodSync(join(certs, 'server-key.pem'), 0o644);
  docker(['run', '--detach', '--rm', '--pull', 'never', '--name', name, '--label', `grounds.compatibility=${name}`,
    '--publish', '127.0.0.1::3306', '--env', 'MYSQL_ROOT_PASSWORD', '--env', 'MYSQL_ROOT_HOST', '--env', 'MYSQL_DATABASE',
    '--tmpfs', '/var/lib/mysql', '--mount', `type=bind,src=${certs},dst=/certificates,readonly`, image,
    '--ssl-ca=/certificates/server-cert.pem', '--ssl-cert=/certificates/server-cert.pem', '--ssl-key=/certificates/server-key.pem',
    '--require-secure-transport=ON']);
  started = true;
  const port = Number(docker(['port', name, '3306/tcp']).split(':').at(-1));
  const ca = readFileSync(join(certs, 'server-cert.pem'));
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password,
        database: 'grounds_test', connectTimeout: 1000, ssl: { ca, rejectUnauthorized: true, verifyIdentity: true } });
      try {
        const [rows] = await connection.query("SHOW STATUS LIKE 'Ssl_cipher'");
        if (!rows[0]?.Value) throw new Error('MySQL connection was not encrypted');
      } finally { await connection.end(); }
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!ready) throw new Error('Isolated TLS MySQL did not become ready');
  Object.assign(env, { GROUNDS_TEST_MYSQL_HOST: '127.0.0.1', GROUNDS_TEST_MYSQL_PORT: String(port),
    GROUNDS_TEST_MYSQL_USERNAME: 'root', GROUNDS_TEST_MYSQL_PASSWORD: password, GROUNDS_TEST_MYSQL_DATABASE: 'grounds_test',
    GROUNDS_TEST_MYSQL_CA_FILE: join(certs, 'server-cert.pem'), GROUNDS_TUI_PTY: '1',
    GROUNDS_RELEASE_CLI: join(root, 'typescript/dist/src/bin.js') });
  const cwd = join(root, 'tui');
  const files = readdirSync(join(cwd, 'test/integration')).filter(file => file.endsWith('.test.ts')).sort().map(file => `test/integration/${file}`);
  let output = '';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = chunk => { output += chunk; process.stdout.write(chunk); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', reject); child.once('close', resolve);
  });
  writeFileSync(join(home, 'test-output.txt'), output);
  passed = code === 0 && /^# tests [1-9][0-9]*$/m.test(output) && /^# skipped 0$/m.test(output) && /^# fail 0$/m.test(output);
  if (!passed) throw new Error('Workspace compatibility requires zero failures and zero skips');
} finally {
  // Also observe by exact name after a lost `run` reply; never remove another
  // container, nor any named database volume (this test uses tmpfs).
  try {
    if (docker(['inspect', '--format', '{{index .Config.Labels "grounds.compatibility"}}', name]) === name)
      docker(['rm', '--force', name]);
    else if (started) throw new Error('Fixture container ownership changed');
  } catch (error) {
    if (started) { passed = false; throw error; }
  } finally {
    if (passed) rmSync(home, { recursive: true, force: true });
    else console.error(`Failed compatibility fixture retained: ${home}`);
  }
}
