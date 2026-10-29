import { LedgerFixture } from "./fixture.js";
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

/** A fresh ledger fixture on the requested backend.  PostgreSQL gets its own database per call. */
export const openLedger = async (backend: Backend): Promise<LedgerFixture> => {
  if (backend === "sqlite") return LedgerFixture.create();
  if (backend === "postgres") {
    const pg = await isolatedPostgres();
    return LedgerFixture.createWithStore(pg.store, pg.cleanup);
  }
  // A fresh database per call: the shared MYSQL test database accumulates the deliberate
  // corruption that integrity-mysql.test.ts writes, which would fail any later whole-database
  // integrity assertion regardless of the code under test.
  const mysql = await isolatedMySQL();
  return LedgerFixture.createWithStore(mysql.store, async () => { await mysql.store.close(); await mysql.cleanup(); });
};
