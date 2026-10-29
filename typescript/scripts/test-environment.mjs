import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import mysql from 'mysql2/promise';

export const createWorkerHome = worker => {
  // Colima shares the user's home. System temp on macOS can be outside that
  // mount, so Docker-backed fixtures and their runtime must stay under it.
  // Spotlight workers spawned by test file writes are protected, reparented
  // processes: the native observer must retain unknown for them. Keep fixture
  // writes out of indexing rather than weaken that safety rule.
  // https://developer.apple.com/documentation/xcode/locating-a-missing-debug-symbol-file
  const parent = join(homedir(), 'tmp', 'grounds-test-workers.noindex');
  mkdirSync(parent, { recursive: true });
  const home = realpathSync(mkdtempSync(join(parent, `grounds-test-home-${worker}-`)));
  mkdirSync(join(home, 'tmp'));
  return home;
};

// Capture the caller's browser installation before assigning an isolated HOME.
// Browser profiles remain private; only the installed, read-only binaries are shared.
export const workerEnvironment = (home, environment = process.env) => {
  let browsers = environment.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsers) {
    const cache = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
      : environment.XDG_CACHE_HOME || join(homedir(), '.cache');
    browsers = join(cache, 'ms-playwright');
  } else if (browsers !== '0') browsers = resolve(environment.INIT_CWD || process.cwd(), browsers);
  return { ...environment, HOME: home, TMPDIR: join(home, 'tmp'),
    GROUNDS_ENV_TEST_ROOT: environment.GROUNDS_ENV_TEST_ROOT || join(home, 'tmp'),
    PLAYWRIGHT_BROWSERS_PATH: browsers };
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
