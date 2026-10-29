import { readFileSync } from "node:fs";
import { SQLStore } from "../src/sql-store.js";
import { newUUIDv7 } from "../src/identity.js";

// Fresh databases prevent list fixtures from observing earlier tests or files.
export const isolatedMySQL = async () => {
  const { createConnection } = await import('mysql2/promise');
  const database = `grounds_list_test_${newUUIDv7().replaceAll('-', '')}`;
  const host = process.env.GROUNDS_TEST_MYSQL_HOST!;
  const port = Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306);
  const username = process.env.GROUNDS_TEST_MYSQL_USERNAME!;
  const password = process.env.GROUNDS_TEST_MYSQL_PASSWORD!;
  const caFile = process.env.GROUNDS_TEST_MYSQL_CA_FILE;
  const connection = await createConnection({ host, port, user: username, password,
    ssl: { rejectUnauthorized: true, ...(caFile ? { ca: readFileSync(caFile) } : {}) } });
  try { await connection.query(`CREATE DATABASE \`${database}\``); }
  catch (error) { await connection.end(); throw error; }
  return {
    configuration: { driver: "mysql" as const, host, port, database, username,
      password: { source: "environment" as const, variable: "GROUNDS_MYSQL_PASSWORD" as const },
      tls: { mode: "verify_identity" as const, ...(caFile ? { ca_file: caFile } : {}) } },
    store: SQLStore.mysql({ host, port, database, username, password, ...(caFile ? { caFile } : {}) }),
    cleanup: async () => {
      try { await connection.query(`DROP DATABASE \`${database}\``); }
      finally { await connection.end(); }
    },
  };
};
