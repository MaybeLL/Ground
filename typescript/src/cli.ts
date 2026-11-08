import { executeEnvironmentCommand } from "./env-cli.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { writeConfig, configPath, defaultSQLitePath, loadConfig, networkPassword, validateConfig, type Config, type DatabaseConfig } from "./config.js";
import { asDomainError, DomainError, schemaDetails, validation } from "./errors.js";
import { isUUIDv7, newUUIDv7 } from "./identity.js";
import { SCHEMA_VERSION, SQLStore } from "./sql-store.js";
import type { IntegrityReport, Metadata } from "./store-types.js";
import { bundledPluginRoot, defaultSkillsDirectory, installGroundsSkills } from "./skill-installer.js";
import { installationStatus } from "./installation-status.js";
import { cliVersion } from "./runtime-version.js";
import { composeWork } from "./work/composition.js";
import { executeWorkCommand, WORK_GROUPS, WORK_WRITE_ACTIONS, workHelp } from "./work/entry/index.js";

export interface Warning { code: string; message: string }
export interface SuccessEnvelope { format: "patchledger.cli/v1"; ok: true; operation_id?: string; data: unknown; warnings: Warning[] }

export interface ParsedArgs { positionals: string[]; values: Record<string, string | boolean | string[]> }

export interface CLIIO {
  signal?: AbortSignal;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  cwd?: string;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
}

const stdout = (io: CLIIO, line: string): void => (io.stdout ?? ((value) => process.stdout.write(value + "\n")))(line);
const stderr = (io: CLIIO, line: string): void => (io.stderr ?? ((value) => process.stderr.write(value + "\n")))(line);

const booleanOptionKeys = new Set(["early", "pinned", "allow-cached", "legacy-fixed","preview","parallel-route","tty", "summary", "paged", "json", "reconfigure", "allow-submitted", "non-interactive", "confirm-initialize", "help", "link", "dry-run", "discard-changes", "refresh", "declare-stop"]);

export const parseArgs = (argv: string[]): ParsedArgs => {
  const positionals: string[] = []; const values: Record<string, string | boolean | string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const raw = token.slice(2); const equal = raw.indexOf("="); const key = equal < 0 ? raw : raw.slice(0, equal); let value: string | boolean = equal < 0 ? true : raw.slice(equal + 1);
    // A lone `-` is the documented stdin sentinel for YAML/file options.  It
    // is not another option and must therefore be consumed as the value of
    // the preceding flag (`--file -`).  Negative numeric values are handled
    // the same way so their eventual range validation reports the right
    // field instead of the misleading "requires a value" error.
    const next = argv[index + 1];
    const nextIsValue = next === "-" || (next !== undefined && !next.startsWith("-")) || (next !== undefined && /^-\d/.test(next));
    if (value === true && !booleanOptionKeys.has(key) && nextIsValue) value = argv[++index];
    const previous = values[key];
    values[key] = previous === undefined ? value : [...(Array.isArray(previous) ? previous.map(String) : [String(previous)]), String(value)];
  }
  return { positionals, values };
};

// Keep parsing deliberately small, but reject the two classes of typo that
// are most dangerous for a contract CLI: an unknown option silently falling
// back to a default and an extra positional silently being ignored.  The
// option allow-list is shared across commands because Grounds commands
// intentionally reuse a small set of attribution, storage and Git flags.
const validateOptionKeys = (args: ParsedArgs): void => {
  for (const key of Object.keys(args.values)) if (!knownOptionKeys.has(key)) throw validation(`--${key}`, "unknown option");
};

// A global allow-list catches spelling mistakes, but it is not enough for a
// stateful CLI: accepting a flag from a different command can silently select
// a default (for example `issue list --baseline ...`).  Keep the command
// surface explicit so every option is consumed by exactly one handler.
const commandOptionKeys: Record<string, Set<string>> = {
  "init:": new Set(["config", "driver", "path", "reconfigure", "baseline-policy", "non-interactive", "confirm-initialize", "host", "port", "database", "username", "tls", "tls-mode", "ca-file", "password-source"]),
  "doctor:": new Set(["skills-path"]),
  "install:skill": new Set(["link"]),
  "config:show": new Set(["config"]), "config:path": new Set(["config"]), "config:validate": new Set(["config"]),
  "db:status": new Set(["config"]), "db:test": new Set(["config"]),
};

// One-line documentation for every option the CLI understands.  Subcommand
// help surfaces these so a caller never has to read source to discover the
// contract.  Attribution/storage/Git flags are shared across commands and
// documented once here.
const knownOptionKeys = new Set(["cwd", "json", "help", "version", ...Object.values(commandOptionKeys).flatMap(options => [...options])]);
const optionDocs: Record<string, string> = {
  instance: "Explicit credential-free HTTPS GitLab instance (default selected binding or repository host); credentials are resolved for the current user and this instance",
  "baseline-policy": "warn or require_override for unconfirmed baselines",
  "ca-file": "MySQL/PostgreSQL TLS CA file",
  "config": "Path to the Grounds config file",
  "confirm-initialize": "Explicitly confirm initializing an empty MySQL/PostgreSQL database",
  "cwd": "Working directory for Git operations",
  "database": "MySQL/PostgreSQL database name",
  "driver": "Storage driver: sqlite, mysql or postgres",
  "help": "Show help for the command (or global help)",
  "host": "MySQL/PostgreSQL host",
  "json": "Emit a machine-readable patchledger.cli/v1 envelope",
  "link": "Create links to the canonical ~/.agents/skills install instead of copying a second managed copy",
  "non-interactive": "Never prompt; use supplied values or defaults",
  "password-source": "MySQL/PostgreSQL password source: environment or keychain",
  "path": "Directory path (install skill target, materialize target; optional in review mode, where the CLI names a review session)",
  "port": "MySQL/PostgreSQL port",
  "reconfigure": "Replace an existing config during init",
  "skills-path": "Managed skills root to inspect (default ~/.agents/skills)",
  "tls": "MySQL/PostgreSQL TLS mode",
  "tls-mode": "MySQL/PostgreSQL TLS mode",
  "username": "MySQL/PostgreSQL username",
  "version": "Print the installed Grounds CLI version",
};

// Human description per command family/action.  Options are derived from
// commandOptionKeys so the two can never drift.
const commandDocs: Record<string, string> = {
  "init:": "Initialize a Grounds ledger and write its config file",
  "doctor:": "Check PATH CLI, registry release, and managed skill versions",
  "install:skill": "Install the bundled Grounds skills into a directory (default ~/.agents/skills)",
  "config:show": "Show the resolved configuration",
  "config:path": "Print the config file path",
  "config:validate": "Validate the config file",
  "db:status": "Inspect database integrity and metadata",
  "db:test": "Test the database connection",
};

// Keep the command-family view available to both dispatch and `GROUP --help`.
// A group help page is a navigation step, not an empty command: it must tell a
// caller which actions exist before it can sensibly request action-level help.
const actionSets: Record<string, string[]> = {
  install: ["skill"], db: ["status", "test"],
};
const positionalBounds: Record<string, [number, number]> = {
  "init:": [1, 1],
  "doctor:": [1, 1],
  "install:skill": [2, 3],
  "config:show": [2, 2], "config:path": [2, 2], "config:validate": [2, 2],
  "db:status": [2, 2], "db:test": [2, 2],
};

const validatePositionals = (args: ParsedArgs, group: string, action: string): void => {
  const bounds = positionalBounds[`${group}:${action}`];
  if (!bounds) return;
  const [minimum, maximum] = bounds;
  if (args.positionals.length < minimum || args.positionals.length > maximum) throw validation("command", `${group} ${action} expects ${minimum === maximum ? minimum : `between ${minimum} and ${maximum}`} positional arguments`);
};

const validateCommandArguments = (args: ParsedArgs, group: string, action: string): void => {
  validateOptionKeys(args);
  for (const [key, raw] of Object.entries(args.values)) if (Array.isArray(raw)) throw validation(`--${key}`, "must be supplied at most once");
  const configured = commandOptionKeys[`${group}:${action}`] ?? commandOptionKeys[`${group}:`];
  if (configured) {
    // This process-local selector does not alter the persisted command contract.
    const allowed = new Set(configured).add("cwd");
    for (const key of Object.keys(args.values)) if (!allowed.has(key) && key !== "json") throw validation(`--${key}`, `is not valid for ${group}${action ? ` ${action}` : ""}`);
  }
  for (const [key, optionValue] of Object.entries(args.values)) {
    if (optionValue === true && !booleanOptionKeys.has(key)) throw validation(key, "requires a value");
    if (booleanOptionKeys.has(key)) {
      const entries = Array.isArray(optionValue) ? optionValue : [optionValue];
      for (const entry of entries) {
        if (entry !== true && typeof entry !== "string") throw validation(key, "must be boolean");
        if (typeof entry === "string" && entry.toLowerCase() !== "true" && entry.toLowerCase() !== "false") throw validation(key, "must be boolean");
      }
    }
  }
  validatePositionals(args, group, action);
};

const validateHelpArguments = (args: ParsedArgs): void => {
  // Help is intentionally available as a global escape hatch, including on
  // subcommands (for example `requirement list --help`).  It must not,
  // however, become a way to smuggle arbitrary/typoed options past the
  // command parser.  Keep the accepted surface deliberately tiny and apply
  // the same boolean grammar as normal command validation.
  validateOptionKeys(args);
  for (const [key, raw] of Object.entries(args.values)) {
    if (key !== "help" && key !== "json") throw validation(`--${key}`, "is not valid for help");
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      if (entry !== true && typeof entry !== "string") throw validation(key, "must be boolean");
      if (typeof entry === "string" && entry.toLowerCase() !== "true" && entry.toLowerCase() !== "false") throw validation(key, "must be boolean");
    }
  }
  // The standalone form may take one topic.  When `--help` is attached to a
  // command, its normal positional arguments are intentionally ignored so a
  // user can ask for help before supplying required IDs/files.
  if (args.positionals[0] === "help") {
    if (args.positionals.length > 2) throw validation("command", "help expects at most one topic");
    const topic = args.positionals[1];
    if (topic && !Object.hasOwn(actionSets, topic) && !["init", "doctor", "config", "task", "work", "grade", "env"].includes(topic))
      throw validation("command", `command is not implemented: ${topic}`);
  }
};

// Render the per-command option list.  The set comes from commandOptionKeys
// (the same allow-list the validator uses), so the help text can never show an
// option the parser would reject, or hide one it accepts.
const commandHelp = (group: string, action: string): { command: string; description: string; actions: string[]; options: { name: string; description: string }[] } => {
  const key = `${group}:${action === "" ? "" : action}`;
  const fallbackKey = `${group}:`;
  const docs = commandDocs[key] ?? commandDocs[fallbackKey] ?? "";
  const configured = commandOptionKeys[key] ?? commandOptionKeys[fallbackKey] ?? new Set<string>();
  const options = [...new Set(configured).add("cwd")].sort().map((name) => ({ name, description: optionDocs[name] ?? "" }));
  const command = `${group}${action ? ` ${action}` : ""}`;
  return { command, description: docs, actions: action ? [] : (actionSets[group] ?? []), options };
};

const formatCommandHelp = (help: { command: string; description: string; actions: string[]; options: { name: string; description: string }[] }): string => {
  const lines = [`grounds ${help.command}`, ""];
  if (help.description) lines.push(help.description, "");
  if (help.actions.length) {
    lines.push("可用操作:");
    for (const action of help.actions) {
      const invocation = `${help.command} ${action}`;
      lines.push(`  ${invocation.padEnd(28)} ${commandDocs[`${help.command}:${action}`] ?? ""}`);
    }
    lines.push("", `继续查看: grounds ${help.command} <操作> --help`);
  }
  if (help.options.length) {
    lines.push("选项:");
    for (const option of help.options) lines.push(`  --${option.name.padEnd(28)} ${option.description}`);
    lines.push("", "通用: --config PATH, --cwd DIR, --json (任意命令可用)");
  } else if (!help.actions.length) {
    lines.push("无参数选项。");
  }
  return lines.join("\n");
};

const value = (args: ParsedArgs, key: string, fallback = ""): string => { const v = args.values[key]; if (v === undefined) return fallback; if (Array.isArray(v)) return String(v[v.length - 1]); return String(v); };
const hasOption = (args: ParsedArgs, key: string): boolean => args.values[key] !== undefined;
const bool = (args: ParsedArgs, key: string): boolean => args.values[key] === true || value(args, key).toLowerCase() === "true";
// Once a caller includes --json, keep failures in the machine-readable
// envelope even when the value itself is malformed.  The command validator
// still reports the invalid boolean; treating its presence as a request for
// JSON prevents a typo from switching the output protocol to human text.
const jsonOutputRequested = (args: ParsedArgs): boolean => {
  if (!hasOption(args, "json")) return false;
  const raw = args.values.json;
  const last = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return last !== false && !(typeof last === "string" && last.toLowerCase() === "false");
};
const required = (args: ParsedArgs, key: string): string => { const v = value(args, key); if (!v) throw validation(key, "is required"); return v; };
const parseInteger = (raw: string, field: string, minimum?: number): number => {
  if (!/^[+-]?\d+$/.test(raw)) throw validation(field, "must be an integer");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || (minimum !== undefined && parsed < minimum)) throw validation(field, minimum === undefined ? "must be a safe integer" : `must be at least ${minimum}`);
  return parsed;
};
/**
 * Where verification material goes: an explicit --out file, or the named file inside an existing
 * review session. With neither option nothing is written, so existing callers keep stdout-only behavior.
 */
const integerValue = (args: ParsedArgs, key: string, minimum?: number, fallback?: string): number => {
  const raw = value(args, key, fallback);
  if (!raw && fallback === undefined) throw validation(key, "is required");
  return parseInteger(raw, key, minimum);
};
const defaultPrompt = async (question: string): Promise<string> => {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try { return await terminal.question(question); } finally { terminal.close(); }
};

const canPrompt = (args: ParsedArgs, io: CLIIO): boolean =>
  !bool(args, "json") && !bool(args, "non-interactive") && (io.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY));

const promptValue = async (args: ParsedArgs, io: CLIIO, key: string, question: string, fallback = ""): Promise<string> => {
  if (args.values[key] !== undefined) return value(args, key);
  if (!canPrompt(args, io)) return fallback;
  const answer = (await (io.prompt ?? defaultPrompt)(question)).trim();
  return answer || fallback;
};

const storeForConfig = (config: Config): SQLStore => {
  if (config.database.driver === "sqlite") return SQLStore.sqlite(config.database.path!);
  if (config.database.tls?.ca_file) {
    try { readFileSync(config.database.tls.ca_file); } catch { throw validation("database.tls.ca_file", "file does not exist or cannot be read"); }
  }
  const connection = { host: config.database.host!, port: config.database.port!, database: config.database.database!, username: config.database.username!, password: networkPassword(config.database), caFile: config.database.tls?.ca_file };
  return config.database.driver === "postgres" ? SQLStore.postgres(connection) : SQLStore.mysql(connection);
};

const normalizedConfigHost = (host: string | undefined): string => (host ?? "").replace(/^\[|\]$/g, "").toLowerCase();

const sameDatabaseTarget = (left: DatabaseConfig, right: DatabaseConfig): boolean => {
  if (left.driver !== right.driver) return false;
  if (left.driver === "sqlite") return left.path === right.path;
  return normalizedConfigHost(left.host) === normalizedConfigHost(right.host)
    && left.port === right.port
    && left.database === right.database
    && left.username === right.username
    && left.tls?.mode === right.tls?.mode
    && left.tls?.ca_file === right.tls?.ca_file
    && left.password?.source === right.password?.source
    && left.password?.variable === right.password?.variable;
};

const databaseIdentityMismatch = (): DomainError => new DomainError(
  "DATABASE_ID_MISMATCH",
  "config points at a different database",
  false,
  { reason: "expected_database_id does not match" },
);

const openStore = async (pathOverride = ""): Promise<{ store: SQLStore; config: Config; policy: "warn" | "require_override" }> => {
  const path = configPath(pathOverride);
  if (!existsSync(path)) throw new DomainError("SCHEMA_INCOMPATIBLE", `configuration file does not exist: ${path}`, false, schemaDetails(SCHEMA_VERSION, `configuration file does not exist: ${path}`));
  const config = loadConfig(path); const store = storeForConfig(config);
  try {
    const metadata = await store.open();
    if (metadata.database_id !== config.database.expected_database_id) throw databaseIdentityMismatch();
    return { store, config, policy: metadata.baseline_reachability_policy };
  } catch (error) {
    try { await store.close(); } catch { /* preserve the original open/identity error */ }
    throw error;
  }
};

const initCommand = async (args: ParsedArgs, io: CLIIO): Promise<unknown> => {
  const configFile = configPath(value(args, "config"));
  if (existsSync(configFile) && !bool(args, "reconfigure")) throw validation("config", "already exists; pass --reconfigure to replace it");
  const driver = await promptValue(args, io, "driver", "Storage driver [sqlite/mysql/postgres] (sqlite): ", "sqlite") as "sqlite" | "mysql" | "postgres";
  if (driver !== "sqlite" && driver !== "mysql" && driver !== "postgres") throw validation("driver", "must be sqlite, mysql or postgres");
  const policy = await promptValue(args, io, "baseline-policy", `Baseline policy [warn/require_override] (${driver === "sqlite" ? "warn" : "require_override"}): `, driver === "sqlite" ? "warn" : "require_override") as "warn" | "require_override";
  if (policy !== "warn" && policy !== "require_override") throw validation("baseline-policy", "must be warn or require_override");
  let db: DatabaseConfig;
  if (driver === "sqlite") {
    const configuredPath = await promptValue(args, io, "path", `SQLite database path (${defaultSQLitePath()}): `, defaultSQLitePath());
    db = { driver, path: resolve(configuredPath), expected_database_id: newUUIDv7() };
  } else {
    if (!canPrompt(args, io)) {
      for (const key of ["host", "database", "username"]) if (args.values[key] === undefined) throw validation(key, `is required for non-interactive ${driver === "postgres" ? "PostgreSQL" : "MySQL"} initialization`);
    }
    const engine = driver === "postgres" ? "PostgreSQL" : "MySQL";
    const defaultPort = driver === "postgres" ? "5432" : "3306";
    const host = await promptValue(args, io, "host", `${engine} host: `);
    const port = await promptValue(args, io, "port", `${engine} port (${defaultPort}): `, defaultPort);
    const database = await promptValue(args, io, "database", `${engine} database: `);
    const username = await promptValue(args, io, "username", `${engine} username: `);
    const tlsFlag = args.values["tls-mode"] === undefined ? "tls" : "tls-mode";
    if (args.values.tls !== undefined && args.values["tls-mode"] !== undefined && value(args, "tls") !== value(args, "tls-mode")) throw validation("tls-mode", "use either --tls-mode or --tls, not both");
    const tlsMode = await promptValue(args, io, tlsFlag, "TLS mode (verify_identity): ", "verify_identity");
    const caFile = await promptValue(args, io, "ca-file", "CA file (leave empty for system trust): ");
    const passwordSource = await promptValue(args, io, "password-source", "Password source [keychain/environment] (environment): ", "environment") as "environment" | "keychain";
    if (!host) throw validation("host", "is required");
    if (!database) throw validation("database", "is required");
    if (!username) throw validation("username", "is required");
    if (tlsMode !== "verify_identity") throw validation("tls", "must equal verify_identity");
    if (passwordSource !== "environment" && passwordSource !== "keychain") throw validation("password-source", "must be keychain or environment");
    db = { driver, host, port: parseInteger(port, "port", 1), database, username, tls: { mode: "verify_identity", ...(caFile ? { ca_file: caFile } : {}) }, password: passwordSource === "environment" ? { source: "environment", variable: driver === "postgres" ? "GROUNDS_POSTGRES_PASSWORD" : "GROUNDS_MYSQL_PASSWORD" } : { source: "keychain" }, expected_database_id: newUUIDv7() };
  }
  const config: Config = { version: 2, database: db };
  // Validate the complete connection model before constructing a pool or
  // touching the target database.  This keeps malformed init flags in the
  // stable VALIDATION_ERROR path and prevents a partially initialized target.
  validateConfig(config);
  const store = storeForConfig(config);
  let initialized;
  try {
    const target = await store.classifyTarget();
    if (target.state === "unrecognized") throw new DomainError("SCHEMA_INCOMPATIBLE", "database is neither empty nor an initialized Grounds database", false, schemaDetails(SCHEMA_VERSION, "unrecognized tables"));
    if (driver !== "sqlite" && target.state === "empty" && !bool(args, "confirm-initialize")) {
      const confirmed = await promptValue(args, io, "confirm-initialize", `Initialize empty ${driver === "postgres" ? "PostgreSQL" : "MySQL"} database ${db.database} on ${db.host}? Type yes: `);
      if (confirmed.toLowerCase() !== "yes") throw validation("confirm-initialize", `explicit confirmation is required for an empty ${driver === "postgres" ? "PostgreSQL" : "MySQL"} database`);
    }
    initialized = await store.initialize(policy);
  } finally {
    await store.close();
  }
  db.expected_database_id = initialized.metadata.database_id;
  config.database.expected_database_id = initialized.metadata.database_id;
  const result = { result_type: "patchledger.result.init/v1", command: "init", config_path: configFile, database_id: initialized.metadata.database_id, database_action: initialized.action, driver };
  const { writeConfig } = await import("./config.js");
  try {
    writeConfig(configFile, config, bool(args, "reconfigure"));
  } catch (error) {
    // Two full CLI initializers can both pass the early exists check. If the
    // other initializer atomically published the same database target, its
    // config is the durable winner and this invocation should attach to it.
    // Never accept an unrelated or malformed config in this recovery path.
    if (!bool(args, "reconfigure") && error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "config" && error.details.reason === "already exists; pass --reconfigure to replace it") {
      try {
        const existing = loadConfig(configFile);
        if (existing.database.expected_database_id === config.database.expected_database_id && sameDatabaseTarget(existing.database, config.database)) return result;
      } catch { /* preserve the original no-clobber publication error */ }
    }
    throw error;
  }
  return result;
};

const configCommand = (args: ParsedArgs): unknown => {
  const path = configPath(value(args, "config"));
  const action = args.positionals[1] ?? "";
  if (!action) throw validation("config", "expected show, path or validate");
  if (action === "path") return { result_type: "patchledger.result.config-path/v1", command: "config.path", config_path: path };
  const config = loadConfig(path);

  if (action === "show") return { result_type: "patchledger.result.config-show/v1", command: "config.show", config };
  if (action === "validate") return { result_type: "patchledger.result.config-validate/v1", command: "config.validate", valid: true };
  throw validation("command", `unknown config action: ${action}`);
};

const databaseResult = (command: "db.test" | "db.status", metadata: Metadata, integrity?: IntegrityReport): unknown => ({
  result_type: "patchledger.result.database/v1",
  command,
  database_id: metadata.database_id,
  schema_version: metadata.schema_version,
  protocol_version: metadata.protocol_version,
  remote_normalization_version: metadata.remote_normalization_version,
  baseline_reachability_policy: metadata.baseline_reachability_policy,
  migration_state: metadata.migration_state,
  ...(integrity === undefined ? {} : { integrity }),
});

export const execute = async (argv: string[], io: CLIIO = {}): Promise<unknown> => {
  const args = parseArgs(argv); const group = args.positionals[0] ?? ""; const action = args.positionals[1] ?? ""; const cwd = value(args, "cwd", io.cwd ?? process.cwd());
  if (group === "env") return executeEnvironmentCommand(args, cwd);

  if ((WORK_GROUPS as readonly string[]).includes(group)) {
    if (bool(args, "help") || !action || action === "help") return { result_type: "patchledger.result.help/v1", command: "help", usage: workHelp() };
    const opened = await openStore(value(args, "config"));
    try { return await executeWorkCommand(args, { app: composeWork(opened.store), cwd, readFile: path => readFileSync(resolve(cwd, path), "utf8") }); }
    finally { await opened.store.close(); }
  }
  // `--version` / `-v` print the installed package version without touching
  // storage.  It must stay available even before the config/store opens, and
  // under `--json` it returns a contract-shaped version result.
  if ((hasOption(args, "version") && args.positionals.length === 0) || (group === "version") || (args.positionals.length === 1 && args.positionals[0] === "-v")) {
    validateOptionKeys(args);
    return { result_type: "patchledger.result.version/v1", command: "version", version: cliVersion() };
  }
  if (bool(args, "help") || group === "help" || group === "--help") {
    validateHelpArguments(args);
    // `--help` attached to a command (e.g. `requirement list --help`) returns
    // that command's own option list instead of the global usage.  The global
    // `help` topic form keeps its existing single-topic behavior.
    if (args.positionals.length >= 1 && args.positionals[0] !== "help" && args.positionals[0] !== "--help") {
      const helpGroup = args.positionals[0];
      const helpAction = args.positionals[1] ?? "";
      const specialActions: Record<string, string[]> = { config: ["show", "path", "validate"] };
      const actions = actionSets[helpGroup] ?? specialActions[helpGroup];
      const actionless = helpGroup === "init" || helpGroup === "doctor";
      if ((!actions && !actionless) || (helpAction && !(actions ?? []).includes(helpAction)) || (actionless && helpAction)) {
        throw validation("command", `command is not implemented: ${helpGroup}${helpAction ? ` ${helpAction}` : ""}`);
      }
      return { result_type: "patchledger.result.help/v1", command: "help", usage: formatCommandHelp(commandHelp(helpGroup, helpAction)) };
    }
    return { result_type: "patchledger.result.help/v1", command: "help", usage: "grounds doctor | task | work | grade | install skill [path] | init | env | db | config" };
  }
  if (!group) throw validation("command", "expected env, task, work, grade, install, init, doctor, config, or db");
  if (group === "doctor") {
    validateCommandArguments(args, group, action);
    if (action) throw validation("command", "doctor does not take an action");
    if (hasOption(args, "skills-path") && !value(args, "skills-path").trim()) throw validation("skills-path", "must not be empty");
    return installationStatus(value(args, "skills-path") || defaultSkillsDirectory());
  }
  if (group === "init") {
    validateCommandArguments(args, group, action);
    if (action) throw validation("command", "init does not take an action");
    if (hasOption(args, "config") && !value(args, "config").trim()) throw validation("config", "must not be empty");
    if (hasOption(args, "path") && !value(args, "path").trim()) throw validation("path", "must not be empty");
    return initCommand(args, io);
  }
  if (group === "config") {
    if (!action || !["show", "path", "validate"].includes(action)) throw validation("config", "expected show, path or validate");
    validateCommandArguments(args, group, action);
    if (hasOption(args, "config") && !value(args, "config").trim()) throw validation("config", "must not be empty");
    return configCommand(args);
  }
  if (group === "install") {
    if (action !== "skill") throw validation("install", "expected skill");
    validateCommandArguments(args, group, action);
    const requestedPath = args.positionals[2];
    if (requestedPath !== undefined && !requestedPath.trim()) throw validation("path", "must not be empty");
    const target = requestedPath === undefined ? defaultSkillsDirectory() : resolve(cwd, requestedPath);
    return installGroundsSkills(target, bundledPluginRoot(), bool(args, "link"));
  }
  if (!Object.hasOwn(actionSets, group)) throw validation("command", `command is not implemented: ${group}`);
  if (!action || !actionSets[group].includes(action)) throw validation(group, `expected ${actionSets[group].join(", ")}`);
  validateCommandArguments(args, group, action);
  if (hasOption(args, "config") && !value(args, "config").trim()) throw validation("config", "must not be empty");
  if (group === "db") {
    const configFile = configPath(value(args, "config"));
    if (!existsSync(configFile)) throw new DomainError("SCHEMA_INCOMPATIBLE", `configuration file does not exist: ${configFile}`, false, schemaDetails(SCHEMA_VERSION, `configuration file does not exist: ${configFile}`));
    const config = loadConfig(configFile);
    const store = storeForConfig(config);
    try {
      if (action === "status") { const inspected = await store.inspectIntegrity(); if (inspected.metadata.database_id !== config.database.expected_database_id) throw databaseIdentityMismatch(); return databaseResult("db.status", inspected.metadata, inspected.report); }
      const metadata = await store.open();
      if (metadata.database_id !== config.database.expected_database_id) throw databaseIdentityMismatch();
      return databaseResult("db.test", metadata);
    } finally { await store.close(); }
  }
  throw validation("command", `unknown command: ${group} ${action}`);
};

const human = (valueToPrint: unknown): string => {
  if (typeof valueToPrint === "string") return valueToPrint;
  return JSON.stringify(valueToPrint, null, 2);
};
/** Offline contract or quality report, told apart by its format string, with what handoff and digest commands need from either. */
export const exitCode = (error: DomainError): number => ({ VALIDATION_ERROR: 2, NOT_FOUND: 3, STATE_CONFLICT: 4, AUTH_FAILED: 4, VERSION_CONFLICT: 4, IDEMPOTENCY_CONFLICT: 4, SCHEMA_INCOMPATIBLE: 5, MIGRATION_DIRTY: 5, DATABASE_ID_MISMATCH: 5, BASELINE_UNAVAILABLE: 6, WORKTREE_MISMATCH: 6, ARTIFACT_INTEGRITY_ERROR: 6, STORAGE_TRANSIENT: 7, INTERNAL: 1 } as Record<string, number>)[error.code] ?? 1;

export const commandNeedsOperationID = (args: ParsedArgs): boolean =>
  WORK_WRITE_ACTIONS.has(`${args.positionals[0] ?? ""}:${args.positionals[1] ?? ""}`);

export const runCLI = async (argv: string[], io: CLIIO = {}): Promise<number> => {
  const args = parseArgs(argv);
  const jsonMode = jsonOutputRequested(args);
  const supplied = value(args, "operation-id");
  const needsOperationID = !bool(args, "help") && commandNeedsOperationID(args);
  const operationOptionPresent = hasOption(args, "operation-id");
  // Do not put an invalid caller-supplied ID in the error envelope.  The
  // command handler still performs the canonical validation, but the outer
  // envelope must itself remain schema-valid when that validation fails.
  const suppliedIsValid = !operationOptionPresent || (Boolean(supplied) && isUUIDv7(supplied));
  const op = needsOperationID ? (operationOptionPresent ? (suppliedIsValid ? supplied : "") : newUUIDv7()) : "";
  if (needsOperationID && !operationOptionPresent) stderr(io, `operation_id: ${op}`);
  const effectiveArgv = needsOperationID && !operationOptionPresent ? [...argv, "--operation-id", op] : argv;
  try {
    // Validate a caller-supplied operation ID before any command preparation
    // (config/database access, YAML decoding, or Git capture).  Besides
    // avoiding unnecessary side effects, this keeps the failure envelope
    // deterministic and guarantees that an invalid ID can never be echoed
    // back as an operation_id value.
    if (needsOperationID && operationOptionPresent && !suppliedIsValid) {
      throw validation("operation_id", "must be a lowercase UUIDv7");
    }
    const data = await execute(effectiveArgv, io);
    const warnings = data && typeof data === "object" && "warnings" in data && Array.isArray((data as { warnings?: unknown }).warnings) ? (data as { warnings: Warning[] }).warnings : [];
    const cleanData = data && typeof data === "object" && !Array.isArray(data) && "warnings" in data
      ? Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([key]) => key !== "warnings"))
      : data;
    const envelope: SuccessEnvelope = {
      format: "patchledger.cli/v1",
      ok: true,
      ...(op ? { operation_id: op } : {}),
      data: cleanData,
      warnings,
    };
    if (jsonMode) stdout(io, JSON.stringify(envelope));
    else {
      if (op) stdout(io, `operation_id: ${op}`);
      stdout(io, human(cleanData));
    }
    return 0;
  } catch (error) {
    const domain = asDomainError(error);
    const envelope = { format: "patchledger.cli/v1", ok: false, ...(op ? { operation_id: op } : {}), error: domain.toJSON() };
    if (jsonMode) stdout(io, JSON.stringify(envelope));
    else {
      if (op) stderr(io, `operation_id: ${op}`);
      stderr(io, `${domain.code}: ${domain.message}`);
    }
    return exitCode(domain);
  }
};
