import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { workerEnvironment, createWorkerHome, mysqlEnabled, createIsolatedMysqlDatabase } from './test-environment.mjs';

test('isolated worker HOME can launch the installed Chromium without sharing its runtime home', () => {
  const home = createWorkerHome('browser-regression');
  try {
    const env = workerEnvironment(home);
    assert.equal(env.HOME, home);
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      'import {chromium} from "playwright";const browser=await chromium.launch();try{const page=await browser.newPage();await page.setContent("<p>worker browser</p>");console.log(await page.locator("p").innerText());}finally{await browser.close();}'],
      { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 20000 });
    assert.match(output, /worker browser/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('worker temp and Docker fixture roots are writable beneath its private home', () => {
  const home = createWorkerHome('temp-regression');
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      'import {homedir,tmpdir} from "node:os";import {mkdtempSync} from "node:fs";import {join} from "node:path";console.log(JSON.stringify([mkdtempSync(join(homedir(),"tmp/identity-")),mkdtempSync(join(tmpdir(),"docker-")),process.env.GROUNDS_ENV_TEST_ROOT]));'],
      { env: workerEnvironment(home), encoding: 'utf8' });
    for (const path of JSON.parse(output)) assert.ok(path.startsWith(home + '/tmp'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('explicit browser installation selection is preserved', () => {
  assert.equal(workerEnvironment('/private/test-home', { PLAYWRIGHT_BROWSERS_PATH: '0' }).PLAYWRIGHT_BROWSERS_PATH, '0');
});

test('worker database provisioning rejects a non-test base before connecting', async () => {
  await assert.rejects(createIsolatedMysqlDatabase({ GROUNDS_TEST_MYSQL_HOST: 'example.invalid',
    GROUNDS_TEST_MYSQL_DATABASE: 'production', GROUNDS_TEST_MYSQL_USERNAME: 'test',
    GROUNDS_TEST_MYSQL_PASSWORD: 'test' }), /dedicated test database/);
});

test('parallel files receive distinct TLS databases and cleanup drops only those databases', { skip: !mysqlEnabled(process.env) }, async () => {
  const a = await createIsolatedMysqlDatabase(), b = await createIsolatedMysqlDatabase();
  const connection = environment => mysql.createConnection({
    host: environment.GROUNDS_TEST_MYSQL_HOST, port: Number(environment.GROUNDS_TEST_MYSQL_PORT || 3306),
    user: environment.GROUNDS_TEST_MYSQL_USERNAME, password: environment.GROUNDS_TEST_MYSQL_PASSWORD,
    database: environment.GROUNDS_TEST_MYSQL_DATABASE,
    ssl: { rejectUnauthorized: true, ...(environment.GROUNDS_TEST_MYSQL_CA_FILE
      ? { ca: readFileSync(environment.GROUNDS_TEST_MYSQL_CA_FILE) } : {}) },
  });
  let first, second;
  try {
    assert.notEqual(a.environment.GROUNDS_TEST_MYSQL_DATABASE, b.environment.GROUNDS_TEST_MYSQL_DATABASE);
    first = await connection(a.environment); second = await connection(b.environment);
    await first.query('CREATE TABLE worker_fixture (value INTEGER)');
    await first.query('INSERT INTO worker_fixture VALUES (42)');
    const [tables] = await second.query("SHOW TABLES LIKE 'worker_fixture'");
    assert.equal(tables.length, 0, 'One worker must not observe another file’s mutation');
  } finally {
    try { await first?.end(); await second?.end(); }
    finally { await a.cleanup(); await b.cleanup(); }
  }
  const admin = await connection(process.env);
  try {
    const [rows] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)',
      [a.environment.GROUNDS_TEST_MYSQL_DATABASE, b.environment.GROUNDS_TEST_MYSQL_DATABASE]);
    assert.equal(rows.length, 0);
    assert.equal(admin.config.database, process.env.GROUNDS_TEST_MYSQL_DATABASE);
  } finally { await admin.end(); }
});
