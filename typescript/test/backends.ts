import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLStore } from "../src/sql-store.js";
import { isolatedMySQL } from "./isolated-mysql.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";

/** The three business-database backends every conformance scenario runs against. */
export type Backend = "sqlite" | "mysql" | "postgres";
export const backends = ["sqlite", "mysql", "postgres"] as const;

const mysqlEnabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every((key) => Boolean(process.env[`GROUNDS_TEST_MYSQL_${key}`]));

/** Why a backend cannot run here, or false when it can.  A skip is never a pass. */
export const backendSkip = (backend: Backend): string | false => {
  if (backend === "mysql" && !mysqlEnabled) return "GROUNDS_TEST_MYSQL_* is not configured; MySQL is NOT verified by this run";
  if (backend === "postgres" && !postgresEnabled) return "GROUNDS_TEST_PG_* is not configured; PostgreSQL is NOT verified by this run";
  return false;
};

/** Each test owns its database and closes the pool before disposing of it. */
function isolatedSQLite() {
  const directory = mkdtempSync(join(tmpdir(), "grounds-ledger-"));
  return { store: SQLStore.sqlite(join(directory, "ledger.db")), cleanup: async () => rmSync(directory, { recursive: true, force: true }) };
}

export async function openLedger(backend: Backend, initialize = true) {
  const database = backend === "sqlite"
    ? isolatedSQLite()
    : backend === "postgres" ? await isolatedPostgres() : await isolatedMySQL();
  const close = async () => {
    try { await database.store.close(); }
    finally { await database.cleanup(); }
  };
  try {
    if (initialize) await database.store.initialize("warn");
    return { store: database.store, close };
  } catch (error) {
    await close();
    throw error;
  }
}
