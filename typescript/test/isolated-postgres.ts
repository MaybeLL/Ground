import { readFileSync } from "node:fs";
import pg from "pg";
import { SQLStore } from "../src/sql-store.js";
import { newUUIDv7 } from "../src/identity.js";

/** Dedicated PostgreSQL test server, configured like the MySQL one. */
export const postgresEnabled = ["HOST", "USERNAME", "PASSWORD"].every((key) => Boolean(process.env[`GROUNDS_TEST_PG_${key}`]));

export interface PostgresTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  caFile?: string;
}

export const postgresTarget = (): PostgresTarget => ({
  host: process.env.GROUNDS_TEST_PG_HOST!,
  port: Number(process.env.GROUNDS_TEST_PG_PORT ?? 5432),
  username: process.env.GROUNDS_TEST_PG_USERNAME!,
  password: process.env.GROUNDS_TEST_PG_PASSWORD!,
  ...(process.env.GROUNDS_TEST_PG_CA_FILE ? { caFile: process.env.GROUNDS_TEST_PG_CA_FILE } : {}),
});

/** A raw, TLS-verified connection for assertions that must bypass the store. */
export const rawConnection = async (database: string, target = postgresTarget()): Promise<pg.Client> => {
  const client = new pg.Client({
    host: target.host, port: target.port, user: target.username, password: target.password, database,
    ssl: { rejectUnauthorized: true, ...(target.caFile ? { ca: readFileSync(target.caFile, "utf8") } : {}) },
  });
  // Cleanup terminates backends; a connection a failing test left open must not
  // turn that into an uncaught exception that hides the real assertion failure.
  client.on("error", () => undefined);
  await client.connect();
  return client;
};

/**
 * A fresh database per call, so fixtures never observe earlier tests.  The
 * database is dropped by cleanup(); nothing outside it is touched.
 */
export const isolatedPostgres = async (options: { lockWaitTimeoutMs?: number; retryAttempts?: number } = {}) => {
  const target = postgresTarget();
  const database = `grounds_test_${newUUIDv7().replaceAll("-", "")}`;
  const admin = await rawConnection(process.env.GROUNDS_TEST_PG_DATABASE ?? "postgres", target);
  try { await admin.query(`CREATE DATABASE "${database}"`); } catch (error) { await admin.end(); throw error; }
  const connection = { host: target.host, port: target.port, database, username: target.username, password: target.password, ...(target.caFile ? { caFile: target.caFile } : {}) };
  const stores: SQLStore[] = [];
  const open = (storeOptions = options): SQLStore => { const store = SQLStore.postgres(connection, storeOptions); stores.push(store); return store; };
  return {
    database,
    connection,
    store: open(),
    /** Another store on the same database, i.e. a second CLI process. */
    open,
    raw: () => rawConnection(database, target),
    cleanup: async () => {
      try {
        for (const store of stores) { try { await store.close(); } catch { /* already closed */ } }
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [database]);
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      } finally { await admin.end(); }
    },
  };
};
