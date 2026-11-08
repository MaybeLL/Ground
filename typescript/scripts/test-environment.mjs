import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readdirSync, rmSync, readFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';

export const createWorkerHome = worker => {
  // Set GROUNDS_TEST_WORKER_ROOT to a Docker-shared directory when needed.
  // Spotlight workers spawned by test file writes are protected, reparented
  // processes: the native observer must retain unknown for them. Keep fixture
  // writes out of indexing rather than weaken that safety rule.
  // https://developer.apple.com/documentation/xcode/locating-a-missing-debug-symbol-file
  const parent = process.env.GROUNDS_TEST_WORKER_ROOT || join(tmpdir(), 'grounds-test-workers.noindex');
  mkdirSync(parent, { recursive: true });
  const home = realpathSync(mkdtempSync(join(parent, `grounds-test-home-${worker}-`)));
  mkdirSync(join(home, 'tmp'));
  return home;
};

export function removeWorkerHome(home) {
  try {rmSync(home,{recursive:true,force:true});return;}
  catch (error) {if (!["EACCES","EPERM","ENOTEMPTY"].includes(error.code)) throw error;}
  // The successful worker can own immutable Git material snapshots (0555).
  // Restore directory write permission only inside this test's private home.
  function writable(directory) {
    if (!lstatSync(directory).isDirectory()) return;
    chmodSync(directory,0o700);
    for (const entry of readdirSync(directory,{withFileTypes:true})) {
      if (entry.isDirectory()) writable(join(directory,entry.name));
    }
  }
  writable(home);
  rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}

export const workerEnvironment = (home, environment = process.env) => {
  return { ...environment, HOME: home, TMPDIR: join(home, 'tmp'),
    GROUNDS_ENV_TEST_ROOT: environment.GROUNDS_ENV_TEST_ROOT || join(home, 'tmp') };
};

export const mysqlEnabled = environment => ['HOST', 'DATABASE', 'USERNAME', 'PASSWORD']
  .every(key => Boolean(environment[`GROUNDS_TEST_MYSQL_${key}`]));

export const createIsolatedMysqlDatabase = async (environment = process.env) => {
  if (!mysqlEnabled(environment)) return undefined;
  if (!/test/i.test(environment.GROUNDS_TEST_MYSQL_DATABASE)) throw new Error('Worker MySQL database must be a dedicated test database');
  const admin = await mysql.createConnection({
    host: environment.GROUNDS_TEST_MYSQL_HOST, port: Number(environment.GROUNDS_TEST_MYSQL_PORT || 3306),
    user: environment.GROUNDS_TEST_MYSQL_USERNAME, password: environment.GROUNDS_TEST_MYSQL_PASSWORD,
    database: environment.GROUNDS_TEST_MYSQL_DATABASE,
    ssl: { rejectUnauthorized: true, ...(environment.GROUNDS_TEST_MYSQL_CA_FILE
      ? { ca: readFileSync(environment.GROUNDS_TEST_MYSQL_CA_FILE) } : {}) },
  });
  const database = `grounds_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  try { await admin.query(`CREATE DATABASE \`${database}\``); }
  catch (error) { await admin.end(); throw error; }
  return {
    environment: { ...environment, GROUNDS_TEST_MYSQL_DATABASE: database },
    cleanup: async () => {
      try { await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); }
      finally { await admin.end(); }
    },
  };
};
