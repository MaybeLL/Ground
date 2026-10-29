// Start an isolated TLS PostgreSQL server and run a command with test-only credentials.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const exec = promisify(execFile);
const name = `grounds-postgres-test-${randomUUID()}`;
const temporary = mkdtempSync(join(tmpdir(), 'grounds-postgres-ca-'));
const password = randomBytes(24).toString('hex');
const env = { ...process.env, POSTGRES_PASSWORD: password };
const docker = args => exec('docker', args, { env, timeout: 180000, maxBuffer: 1024 * 1024 });
try {
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(temporary, 'server-key.pem'), '-out', join(temporary, 'server-cert.pem')]);
  await docker(['run', '--detach', '--rm', '--name', name, '--label', 'grounds.test=true',
    '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--tmpfs', '/var/lib/postgresql/data',
    '--mount', `type=bind,src=${temporary},dst=/certificates,readonly`, 'postgres:16',
    'bash', '-ec', 'cp /certificates/server-*.pem /tmp/; chown postgres:postgres /tmp/server-*.pem; chmod 600 /tmp/server-key.pem; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server-cert.pem -c ssl_key_file=/tmp/server-key.pem']);
  const port = Number((await docker(['port', name, '5432/tcp'])).stdout.trim().split(':').at(-1));
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password,
      database: 'postgres', connectionTimeoutMillis: 1000,
      ssl: { ca: readFileSync(join(temporary, 'server-cert.pem')), rejectUnauthorized: true } });
    client.on('error', () => {});
    try { await client.connect(); await client.query('SELECT 1'); ready = true; }
    catch { /* Container initialization may still be running. */ }
    finally { await client.end().catch(() => {}); }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Isolated TLS PostgreSQL did not become ready');
  const command = process.argv.slice(2);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command[0] ?? process.execPath, command.length ? command.slice(1)
      : ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/postgres-conformance.test.ts'], {
      stdio: 'inherit', env: { ...process.env,
        GROUNDS_TEST_PG_HOST: '127.0.0.1', GROUNDS_TEST_PG_PORT: String(port),
        GROUNDS_TEST_PG_USERNAME: 'postgres', GROUNDS_TEST_PG_PASSWORD: password,
        GROUNDS_TEST_PG_DATABASE: 'postgres', GROUNDS_TEST_PG_CA_FILE: join(temporary, 'server-cert.pem'),
      },
    });
    child.once('error', reject); child.once('exit', resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  await docker(['rm', '--force', name]).catch(() => {});
  rmSync(temporary, { recursive: true, force: true });
}
