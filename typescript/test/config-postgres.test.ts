import assert from "node:assert/strict";
import { test } from "node:test";
import { networkKeychainLocator, networkPassword, validateConfig, type DatabaseConfig } from "../src/config.js";
import { DomainError } from "../src/errors.js";
import { assertContract } from "./schema-fixture.js";

const identity = "019c0000-0000-7000-8000-000000000001";

const postgres = (overrides: Record<string, unknown> = {}): { version: 2; database: Record<string, unknown> } => ({
  version: 2,
  database: {
    driver: "postgres",
    host: "pg.example.internal",
    port: 5432,
    database: "grounds",
    username: "alice",
    tls: { mode: "verify_identity" },
    password: { source: "environment", variable: "GROUNDS_POSTGRES_PASSWORD" },
    expected_database_id: identity,
    ...overrides,
  },
});

const fieldOf = (error: unknown): string | undefined =>
  error instanceof DomainError && error.code === "VALIDATION_ERROR" ? String(error.details.field) : undefined;

test("a PostgreSQL configuration passes both validation and the machine contract", () => {
  const config = postgres();
  validateConfig(config);
  assertContract("config.schema.json", config);
  assertContract("config.schema.json", postgres({ password: { source: "keychain" }, tls: { mode: "verify_identity", ca_file: "/etc/ssl/ca.pem" } }));
});

test("existing SQLite and MySQL configurations still pass the machine contract", () => {
  assertContract("config.schema.json", { version: 2, database: { driver: "sqlite", path: "/var/lib/grounds/ledger.db", expected_database_id: identity } });
  assertContract("config.schema.json", { ...postgres(), database: { ...postgres().database, driver: "mysql", port: 3306, password: { source: "environment", variable: "GROUNDS_MYSQL_PASSWORD" } } });
});

test("PostgreSQL requires TLS identity verification like every network database", () => {
  assert.throws(() => validateConfig(postgres({ tls: undefined })), (error) => fieldOf(error) === "database.tls");
  assert.throws(() => validateConfig(postgres({ tls: { mode: "disable" } })), (error) => fieldOf(error) === "database.tls");
  assert.throws(() => validateConfig(postgres({ tls: { mode: "require" } })), (error) => fieldOf(error) === "database.tls");
});

test("PostgreSQL passwords come only from the keychain or its own environment variable", () => {
  assert.throws(() => validateConfig(postgres({ password: { source: "environment", variable: "GROUNDS_MYSQL_PASSWORD" } })), (error) => fieldOf(error) === "database.password.variable");
  assert.throws(() => validateConfig(postgres({ password: { source: "environment", variable: "PGPASSWORD" } })), (error) => fieldOf(error) === "database.password.variable");
  // A plaintext password can never be stored in the configuration.
  assert.throws(() => validateConfig(postgres({ password: { source: "literal", value: "hunter2" } })), (error) => fieldOf(error) === "config.database.password.value");
  assert.throws(() => validateConfig(postgres({ password: { source: "environment", variable: "GROUNDS_POSTGRES_PASSWORD", value: "hunter2" } })), (error) => fieldOf(error) === "config.database.password.value");
  assert.throws(() => validateConfig(postgres({ password: { source: "literal" } })), (error) => fieldOf(error) === "database.password.source");
  assert.throws(() => validateConfig(postgres({ password: undefined })), (error) => fieldOf(error) === "database.password");
});

test("PostgreSQL configuration rejects fields that belong to other drivers or are malformed", () => {
  assert.throws(() => validateConfig(postgres({ path: "/tmp/ledger.db" })), (error) => fieldOf(error) === "database.path");
  assert.throws(() => validateConfig(postgres({ host: " pg.example.internal" })), (error) => fieldOf(error) === "database.host");
  assert.throws(() => validateConfig(postgres({ port: 99999 })), (error) => fieldOf(error) === "database.port");
  assert.throws(() => validateConfig(postgres({ database: "" })), (error) => fieldOf(error) === "database.database");
  assert.throws(() => validateConfig(postgres({ expected_database_id: "not-a-uuid" })), (error) => fieldOf(error) === "database.expected_database_id");
  assert.throws(() => validateConfig({ version: 2, database: { driver: "oracle" } }), (error) => fieldOf(error) === "database.driver");
});

test("the keychain locator carries the engine scheme and stays deterministic", () => {
  const base = { host: "PG.Example.Internal", port: 5432, database: "grounds", username: "alice", tls: { mode: "verify_identity" as const }, password: { source: "keychain" as const }, expected_database_id: identity };
  const pg: DatabaseConfig = { driver: "postgres", ...base };
  const my: DatabaseConfig = { driver: "mysql", ...base, port: 3306 };
  assert.equal(networkKeychainLocator(pg), "postgresql://alice@pg.example.internal:5432/grounds");
  assert.equal(networkKeychainLocator(my), "mysql://alice@pg.example.internal:3306/grounds");
  const locators: string[] = [];
  assert.equal(networkPassword(pg, (locator) => { locators.push(locator); return "secret"; }), "secret");
  assert.deepEqual(locators, ["postgresql://alice@pg.example.internal:5432/grounds"]);
  assert.equal(JSON.stringify(pg).includes("secret"), false, "the secret never enters the configuration");
});

test("each engine reads only its own password variable", () => {
  const previous = { pg: process.env.GROUNDS_POSTGRES_PASSWORD, my: process.env.GROUNDS_MYSQL_PASSWORD };
  try {
    process.env.GROUNDS_POSTGRES_PASSWORD = "from-postgres-variable";
    process.env.GROUNDS_MYSQL_PASSWORD = "from-mysql-variable";
    const shared = { host: "db.example.internal", database: "grounds", username: "alice", tls: { mode: "verify_identity" as const }, expected_database_id: identity };
    const pg: DatabaseConfig = { driver: "postgres", port: 5432, ...shared, password: { source: "environment", variable: "GROUNDS_POSTGRES_PASSWORD" } };
    const my: DatabaseConfig = { driver: "mysql", port: 3306, ...shared, password: { source: "environment", variable: "GROUNDS_MYSQL_PASSWORD" } };
    assert.equal(networkPassword(pg), "from-postgres-variable");
    assert.equal(networkPassword(my), "from-mysql-variable");
    delete process.env.GROUNDS_POSTGRES_PASSWORD;
    assert.throws(() => networkPassword(pg), (error) => error instanceof DomainError && /GROUNDS_POSTGRES_PASSWORD is empty/.test(error.message === "input failed validation" ? String(error.details.reason) : error.message));
  } finally {
    for (const [key, value] of [["GROUNDS_POSTGRES_PASSWORD", previous.pg], ["GROUNDS_MYSQL_PASSWORD", previous.my]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
