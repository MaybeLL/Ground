import { encodeVerificationCursor } from "../src/verification-cursor.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLStore } from "../src/sql-store.js";
import { Module } from "../src/module.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";

const required = [
  "GROUNDS_TEST_MYSQL_HOST",
  "GROUNDS_TEST_MYSQL_DATABASE",
  "GROUNDS_TEST_MYSQL_USERNAME",
  "GROUNDS_TEST_MYSQL_PASSWORD",
] as const;

const enabled = required.every((name) => Boolean(process.env[name]));

const mysqlStore = (): SQLStore => SQLStore.mysql({
  host: process.env.GROUNDS_TEST_MYSQL_HOST!,
  port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? "3306"),
  database: process.env.GROUNDS_TEST_MYSQL_DATABASE!,
  username: process.env.GROUNDS_TEST_MYSQL_USERNAME!,
  password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!,
  ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE } : {}),
});

test("MySQL adapter passes the core lifecycle conformance scenario", { skip: !enabled }, async () => {
  const store = mysqlStore();
  const fixture = await LedgerFixture.createWithStore(store);
  try {
    const candidate = await fixture.submitCandidate();
    const verification = await fixture.verify(candidate);
    assert.equal(verification.overall_verdict, "qualified");
    assert.equal((await fixture.module.showCandidate(candidate.candidate.candidate_id)).candidate.standing, "qualified");
  } finally {
    await fixture.close();
  }
});

// Storage conformance runs on all three adapters so the MySQL and PostgreSQL paths are
// compared against the SQLite reference instead of only being skipped when no
// server is set up.
type Backend = "sqlite" | "mysql" | "postgres";
const backendEnabled = (backend: Backend): boolean => backend === "sqlite" || (backend === "mysql" ? enabled : postgresEnabled);

const openFixture = async (backend: Backend): Promise<LedgerFixture> => {
  if (backend === "sqlite") return LedgerFixture.create();
  if (backend === "mysql") return LedgerFixture.createWithStore(mysqlStore());
  const pg = await isolatedPostgres();
  return LedgerFixture.createWithStore(pg.store, pg.cleanup);
};

test("concurrent MySQL repository registrations resolve the same identity", { skip: !enabled }, async () => {
  const stores = [mysqlStore(), mysqlStore()];
  const remote = `ssh://git@example.test/team/mysql-${newUUIDv7()}`;
  try {
    await stores[0].initialize("require_override");
    const [left, right] = await Promise.all(stores.map(store => new Module(store).registerRepository({
      operation_id: newUUIDv7(), canonical_remote: remote, attribution: testAgent,
    })));
    assert.equal(left.result.repository_id, right.result.repository_id);
  } finally {
    await Promise.all(stores.map(store => store.close()));
  }
});

for (const backend of ['sqlite', 'mysql', 'postgres'] as const) test(`${backend}: retained multi-chunk storage is portable and immutable until schema retirement`, { skip: !backendEnabled(backend) }, async () => {
  const f = await openFixture(backend);
  try {
    const { randomBytes } = await import('node:crypto');
    const content = randomBytes(2 * 1024 * 1024 + 17);
    const digest = await f.store.write(tx => tx.putEvalBlob(content));
    assert.equal(await f.store.write(tx => tx.putEvalBlob(content)), digest);
    assert.deepEqual(await f.store.read(tx => tx.getEvalBlob(digest)), content);
  } finally { await f.close(); }
});

for (const backend of ["sqlite", "mysql", "postgres"] as const) test(`${backend}: verification pagination preserves nanosecond order across canonical and legacy timestamps`, { skip: !backendEnabled(backend) }, async () => {
  const f = await openFixture(backend);
  try {
    const candidate = await f.submitCandidate("timestamp-order");
    const seed = await f.verify(candidate, "qualified");
    const candidateId = candidate.candidate.candidate_id;
    // Deliberately insert in reverse chronological order. Equal instants use
    // the id tie-breaker, including legacy space/no-Z and trailing-zero forms.
    const timestamps = [
      "2025-01-01T00:00:00.11Z",
      "2025-01-01T00:00:00.100000002Z",
      "2025-01-01T00:00:00.100000001Z",
      "2025-01-01T00:00:00.1Z",
      "2025-01-01 00:00:00.100",
      "2025-01-01T00:00:00.100Z",
      "2025-01-01 00:00:00",
      "2025-01-01T00:00:00Z",
    ];
    const ids = timestamps.map((_, index) => newUUIDv7(1700000000000 + index));
    await f.store.write(async tx => {
      const record = await tx.getVerification(seed.verification_id);
      for (let i = 0; i < ids.length; i++) await tx.createVerification({ verification: { ...record.verification, id: ids[i], created_at: timestamps[i] }, report: record.report });
    });
    const expected = [ids[6], ids[7], ids[3], ids[4], ids[5], ids[2], ids[1], ids[0], seed.verification_id];
    await f.store.read(async tx => {
      for (const verified of [false, true]) {
        const actual: string[] = []; let cursor = "";
        for (;;) {
          const page = verified ? await tx.listVerificationSummariesPage(candidateId, cursor, 2) : await tx.readVerificationDirectoryPage(candidateId, cursor, 2);
          actual.push(...page.rows.map(row => row.id));
          if (!page.more) break;
          assert.ok(page.rows.length > 0 && actual.length <= expected.length, "pagination must advance without duplicates");
          const last = page.rows.at(-1)!;
          cursor = encodeVerificationCursor(last);
        }
        assert.deepEqual(actual, expected);
      }
      const listed: string[] = []; let after: { key: string; id: string } | undefined;
      for (;;) {
        const page = await tx.listVerificationsPage(candidateId, {}, after, 2);
        listed.push(...page.rows.map(row => row.id));
        if (!page.more) break;
        assert.ok(page.rows.length > 0 && listed.length <= expected.length);
        const last = page.rows.at(-1)!; after = { key: last.order_key, id: last.id };
      }
      assert.deepEqual(listed, expected, "generic verification list must agree with report-directory pagination");
    });
  } finally { await f.close(); }
});
