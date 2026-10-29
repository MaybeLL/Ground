// Worker for the mid-transaction termination regression.  It drives the real
// SQLStore against the configured PostgreSQL server and asks the server to
// terminate its own backend while a business transaction is in flight.
//
// A termination reported on a checked-out connection only kills the process if
// nothing listens for the connection's "error" event, so this must run in a
// subprocess: a regression shows up as a non-zero exit rather than a failed
// assertion.  It prints a single JSON line on success.
import { readFileSync } from "node:fs";
import pg from "pg";
import { SQLStore } from "../src/sql-store.js";

const database = process.argv[2];
const connection = {
  host: process.env.GROUNDS_TEST_PG_HOST!,
  port: Number(process.env.GROUNDS_TEST_PG_PORT ?? 5432),
  database,
  username: process.env.GROUNDS_TEST_PG_USERNAME!,
  password: process.env.GROUNDS_TEST_PG_PASSWORD!,
  ...(process.env.GROUNDS_TEST_PG_CA_FILE ? { caFile: process.env.GROUNDS_TEST_PG_CA_FILE } : {}),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const store = SQLStore.postgres(connection, { retryAttempts: 3 });

await store.initialize("warn");
let terminated = false;
let attempts = 0;
const result = await store.write(async (tx) => {
  attempts += 1;
  const inner = tx as unknown as { client: { get<T>(sql: string): Promise<T | undefined> } };
  if (!terminated) {
    terminated = true;
    const pid = Number((await inner.client.get<{ pid: unknown }>("SELECT pg_backend_pid() AS pid"))?.pid);
    const admin = new pg.Client({
      host: connection.host, port: connection.port, user: connection.username, password: connection.password,
      database: process.env.GROUNDS_TEST_PG_DATABASE ?? "postgres",
      ssl: { rejectUnauthorized: true, ...(process.env.GROUNDS_TEST_PG_CA_FILE ? { ca: readFileSync(process.env.GROUNDS_TEST_PG_CA_FILE, "utf8") } : {}) },
    });
    admin.on("error", () => undefined);
    await admin.connect();
    await admin.query("SELECT pg_terminate_backend($1::int)", [pid]);
    await admin.end();
    // Let the socket close arrive while the checkout is still held.
    await sleep(600);
    // The connection is dead: this statement must surface as retryable transient.
    return inner.client.get<{ one: unknown }>("SELECT 1 AS one");
  }
  return inner.client.get<{ one: unknown }>("SELECT 1 AS one");
});

const afterwards = await store.write(async () => "still-works");
await store.close();
console.log(JSON.stringify({ attempts, result, afterwards }));
