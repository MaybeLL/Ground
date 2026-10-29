import { dataLayout } from "./data-layout.js";
import { validateDevelopmentMode, type DevelopmentMode } from "./development-mode.js";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stringify } from "yaml";
import { isUUIDv7 } from "./identity.js";
import { DomainError, validation } from "./errors.js";
import { safeYAMLToJS } from "./yaml-safe.js";

export interface MySQLTLS {
  mode: "verify_identity";
  ca_file?: string;
}

export interface PasswordSource {
  source: "keychain" | "environment";
  variable?: "GROUNDS_MYSQL_PASSWORD" | "PATCHLEDGER_MYSQL_PASSWORD" | "GROUNDS_POSTGRES_PASSWORD";
}

export interface DatabaseConfig {
  driver: "sqlite" | "mysql" | "postgres";
  path?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  tls?: MySQLTLS;
  password?: PasswordSource;
  expected_database_id: string;
}

export interface Config {
  development?: { default_mode: DevelopmentMode };
  version: 2;
  database: DatabaseConfig;
}

export interface LegacyConfig {
  version: 1;
  database: DatabaseConfig;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const lengthBetween = (field: string, value: string, min: number, max: number): void => {
  if (typeof value !== "string") throw validation(field, "must be a string");
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw validation(field, "must contain valid UTF-8 text");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw validation(field, "must contain valid UTF-8 text");
  }
  const length = [...value].length;
  if (length < min || length > max) throw validation(field, `must contain between ${min} and ${max} characters`);
};

const rejectUnknown = (value: unknown, allowed: string[], field: string): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(field, "must be an object");
  for (const key of Object.keys(value as object)) if (!allowed.includes(key)) throw validation(`${field}.${key}`, "unknown field");
};

const validateConfigVersion = (value: unknown, version: 1 | 2): void => {
  if (!isRecord(value)) throw validation("config", "must be an object");
  rejectUnknown(value, version === 2 ? ["version", "database", "development"] : ["version", "database"], "config");
  if (value.development !== undefined) {
    rejectUnknown(value.development, ["default_mode"], "config.development");
    validateDevelopmentMode((value.development as Record<string, unknown>).default_mode, "config.development.default_mode");
  }
  if (value.version !== version) throw validation("version", `must equal ${version}`);
  const db = value.database;
  if (!isRecord(db)) throw validation("database", "must be an object");
  rejectUnknown(db, ["driver", "path", "host", "port", "database", "username", "tls", "password", "expected_database_id"], "config.database");
  if (db.tls !== undefined) rejectUnknown(db.tls, ["mode", "ca_file"], "config.database.tls");
  if (db.password !== undefined) rejectUnknown(db.password, ["source", "variable"], "config.database.password");
  if (db.driver === "sqlite") {
    if (typeof db.path !== "string") throw validation("database.path", "must be a string");
    if (!db.path) throw validation("database.path", "must not be empty");
    lengthBetween("database.path", db.path, 1, 32768);
    if (!isAbsolute(db.path)) throw validation("database.path", "must be an absolute path");
    if (db.host !== undefined || db.port !== undefined || db.database !== undefined || db.username !== undefined || db.tls !== undefined || db.password !== undefined) {
      throw validation("database", "SQLite configuration cannot contain network database fields");
    }
  } else if (db.driver === "mysql" || db.driver === "postgres") {
    if (db.path !== undefined) throw validation("database.path", "is only valid for SQLite");
    if (typeof db.host !== "string") throw validation("database.host", "must be a string");
    if (!db.host) throw validation("database.host", "must not be empty");
    if (db.host.trim() !== db.host) throw validation("database.host", "must not contain surrounding whitespace");
    lengthBetween("database.host", db.host, 1, 1024);
    const port = db.port;
    if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw validation("database.port", "must be between 1 and 65535");
    if (typeof db.database !== "string") throw validation("database.database", "must be a string");
    if (!db.database) throw validation("database.database", "must not be empty");
    lengthBetween("database.database", db.database, 1, 256);
    if (typeof db.username !== "string") throw validation("database.username", "must be a string");
    if (!db.username) throw validation("database.username", "must not be empty");
    lengthBetween("database.username", db.username, 1, 256);
    if (!isRecord(db.tls) || db.tls.mode !== "verify_identity") throw validation("database.tls", "must set mode to verify_identity");
    const tls = db.tls;
    if (tls.ca_file !== undefined) {
      if (typeof tls.ca_file !== "string") throw validation("database.tls.ca_file", "must be a string");
      lengthBetween("database.tls.ca_file", tls.ca_file, 1, 32768);
      if (!isAbsolute(tls.ca_file)) throw validation("database.tls.ca_file", "must be an absolute path");
    }
    if (!isRecord(db.password)) throw validation("database.password", "is required");
    const password = db.password;
    if (password.source === "keychain") {
      if (password.variable !== undefined) throw validation("database.password.variable", "is only valid for environment password sources");
    } else if (password.source === "environment") {
      const expected = db.driver === "postgres"
        ? "GROUNDS_POSTGRES_PASSWORD"
        : version === 2 ? "GROUNDS_MYSQL_PASSWORD" : "PATCHLEDGER_MYSQL_PASSWORD";
      if (password.variable !== expected) throw validation("database.password.variable", `must equal ${expected}`);
    } else {
      throw validation("database.password.source", "must be keychain or environment");
    }
  } else {
    throw validation("database.driver", "must be sqlite, mysql or postgres");
  }
  if (!isUUIDv7(db.expected_database_id)) throw validation("database.expected_database_id", "must be a lowercase UUIDv7");
};

export const validateConfig = (value: unknown): void => validateConfigVersion(value, 2);

export const configPath = (override = ""): string => {
  if (override) return resolve(override);
  if (process.env.GROUNDS_CONFIG) return resolve(process.env.GROUNDS_CONFIG);
  return dataLayout().config;
};

export const legacyConfigPath = (): string => {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "PatchLedger", "config.yaml");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "PatchLedger", "config.yaml");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "patchledger", "config.yaml");
};

export const defaultSQLitePath = (): string => dataLayout().database;

export const legacyDefaultSQLitePath = (): string => {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "PatchLedger", "patchledger.db");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "PatchLedger", "patchledger.db");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "patchledger", "patchledger.db");
};

const loadConfigDocument = (filePath: string): unknown => {
  let parsed: unknown;
  try {
    // Configuration is intentionally restricted to JSON-compatible YAML.
    const fd = openSync(filePath, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, 64 * 1024 + 1 - total));
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (count === 0) break;
        total += count;
        chunks.push(chunk.subarray(0, count));
        if (total > 64 * 1024) throw validation("config", "file exceeds 64 KiB");
      }
    } finally { closeSync(fd); }
    parsed = safeYAMLToJS(Buffer.concat(chunks, total), "config");
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw validation("config", error instanceof Error ? error.message : String(error));
  }
  return parsed;
};

const loadConfigVersion = <T extends Config | LegacyConfig>(filePath: string, version: 1 | 2): T => {
  const parsed = loadConfigDocument(filePath);
  rejectNulls(parsed, "config");
  rejectUnknown(parsed, version === 2 ? ["version", "database", "development"] : ["version", "database"], "config");
  const raw = parsed as Record<string, unknown>;
  rejectUnknown(raw.database, ["driver", "path", "host", "port", "database", "username", "tls", "password", "expected_database_id"], "config.database");
  if (raw.database && typeof raw.database === "object") {
    const db = raw.database as Record<string, unknown>;
    if (db.tls !== undefined) rejectUnknown(db.tls, ["mode", "ca_file"], "config.database.tls");
    if (db.password !== undefined) rejectUnknown(db.password, ["source", "variable"], "config.database.password");
  }
  validateConfigVersion(parsed, version);
  return parsed as T;
};

export const loadConfig = (filePath: string): Config => loadConfigVersion<Config>(filePath, 2);

export const loadLegacyConfig = (filePath: string): LegacyConfig => loadConfigVersion<LegacyConfig>(filePath, 1);

const rejectNulls = (value: unknown, field: string): void => {
  if (value === null) throw validation(field, "YAML null is not supported; omit optional fields instead");
  if (Array.isArray(value)) value.forEach((item, index) => rejectNulls(item, `${field}[${index}]`));
  else if (value && typeof value === "object") Object.entries(value as Record<string, unknown>).forEach(([key, item]) => rejectNulls(item, `${field}.${key}`));
};

export const writeConfig = (filePath: string, value: Config, reconfigure = false): void => {
  validateConfig(value);
  if (existsSync(filePath) && !reconfigure) throw validation("config", "already exists; pass --reconfigure to replace it");
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const text = stringify(value, { sortMapEntries: false, lineWidth: 0 });
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw validation("config", "serialized configuration exceeds 64 KiB");
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (reconfigure) {
      renameSync(temporary, filePath);
    } else {
      // `existsSync` above is only an early, friendly error. Another
      // initializer can create the path after that check, so publishing a
      // non-reconfigure config with renameSync would violate ADR-0037 by
      // replacing the winner. A hard-link install is an atomic no-clobber
      // publish on the same directory; EEXIST is the concurrent equivalent
      // of the initial already-exists check.
      try {
        linkSync(temporary, filePath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
          throw validation("config", "already exists; pass --reconfigure to replace it");
        }
        throw error;
      }
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed successfully or never created */ }
  }
};

export const networkKeychainLocator = (db: DatabaseConfig): string => {
  if ((db.driver !== "mysql" && db.driver !== "postgres") || !db.host || !db.port || !db.database || !db.username) throw validation("database", `complete ${db.driver === "postgres" ? "PostgreSQL" : "MySQL"} connection identity is required`);
  const host = db.host.replace(/^\[|\]$/g, "").toLowerCase();
  const authority = host.includes(":") ? `[${host}]` : host;
  const scheme = db.driver === "postgres" ? "postgresql" : "mysql";
  return `${scheme}://${encodeURIComponent(db.username)}@${authority}:${db.port}/${encodeURIComponent(db.database)}`;
};

/** Historical name retained for callers that only handled MySQL. */
export const mysqlKeychainLocator = networkKeychainLocator;

export type KeychainReader = (locator: string) => string;

const removeCommandLineEnding = (value: string): string => value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;

export const systemKeychainReader: KeychainReader = (locator) => {
  try {
    if (platform() === "darwin") return removeCommandLineEnding(execFileSync("security", ["find-generic-password", "-s", "Grounds", "-a", locator, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    if (platform() === "linux") return removeCommandLineEnding(execFileSync("secret-tool", ["lookup", "service", "Grounds", "account", locator], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    throw new DomainError("VALIDATION_ERROR", `${locator.startsWith("postgresql://") ? "PostgreSQL" : "MySQL"} password could not be read from the system keychain`, false, { field: "database.password.source", reason: "store a credential for the derived Grounds locator or use the environment source" });
  }
  throw new DomainError("VALIDATION_ERROR", "system keychain lookup is not supported on this platform", false, { field: "database.password.source", reason: `use ${locator.startsWith("postgresql://") ? "GROUNDS_POSTGRES_PASSWORD" : "GROUNDS_MYSQL_PASSWORD"} instead` });
};

export const networkPassword = (db: DatabaseConfig, readKeychain: KeychainReader = systemKeychainReader): string => {
  if (!db.password) throw validation("database.password", "is required");
  // Fixed per engine, as before: a legacy configuration naming PATCHLEDGER_MYSQL_PASSWORD still reads GROUNDS_MYSQL_PASSWORD.
  const variable = db.driver === "postgres" ? "GROUNDS_POSTGRES_PASSWORD" : "GROUNDS_MYSQL_PASSWORD";
  const password = db.password.source === "environment"
    ? process.env[variable] ?? ""
    : readKeychain(networkKeychainLocator(db));
  if (!password) throw validation("database.password", db.password.source === "environment" ? `${variable} is empty` : "keychain credential is empty");
  return password;
};

/** Historical name retained for callers that only handled MySQL. */
export const mysqlPassword = networkPassword;
