import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  configPath,
  defaultSQLitePath,
  legacyConfigPath,
  legacyDefaultSQLitePath,
  loadLegacyConfig,
  mysqlKeychainLocator,
  mysqlPassword,
  writeConfig,
  type Config,
  type DatabaseConfig,
} from "./config.js";
import { DomainError, validation } from "./errors.js";
import { withGroundsExclude } from "./grounds-exclude.js";
import { SQLStore } from "./sql-store.js";

export interface BrandMigrationOptions {
  cwd: string;
  legacyConfig?: string;
  dryRun: boolean;
}

interface MigrationPart {
  status: "not_found" | "planned" | "migrated";
  source?: string;
  target?: string;
  moved_worktrees?: number;
}

export interface BrandMigrationResult {
  result_type: "patchledger.result.brand-migration/v1";
  command: "migrate.patchledger";
  dry_run: boolean;
  config: MigrationPart;
  repository: MigrationPart;
}

interface RepoPlan {
  repository: string;
  gitCommon: string;
  oldRoot: string;
  newRoot: string;
  exclude: string;
  oldExclude: string;
  newExclude: string;
  stateFiles: string[];
  worktrees: Array<{ oldPath: string; recordedOldPath: string; newPath: string }>;
  metadataMoves: Array<{ source: string; target: string }>;
  journal: string;
}

const git = (cwd: string, args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
}).trim();

const present = (path: string): boolean => {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const canonicalExistingOrParent = (path: string): string => present(path)
  ? realpathSync(path)
  : join(realpathSync(dirname(path)), basename(path));

const migrationRequired = (reason: string, command: string[]): DomainError =>
  new DomainError("BRAND_MIGRATION_REQUIRED", "legacy PatchLedger state must be migrated to Grounds", false, { reason, migrate_argv: command });

export const legacyBrandState = (cwd: string, explicitConfig = ""): { required: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  if (!explicitConfig && !present(configPath()) && present(legacyConfigPath())) reasons.push(`legacy configuration exists at ${legacyConfigPath()}`);
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (present(join(root, ".patchledger"))) reasons.push(`legacy repository state exists at ${join(root, ".patchledger")}`);
  } catch { /* commands that do not require a Git repository remain usable */ }
  return { required: reasons.length > 0, reasons };
};

export const requireNoLegacyBrandState = (cwd: string, explicitConfig = ""): void => {
  const state = legacyBrandState(cwd, explicitConfig);
  if (state.required) throw migrationRequired(state.reasons.join("; "), ["grounds", "migrate", "patchledger", "--cwd", resolve(cwd)]);
};

const directoryEntries = (path: string): string[] => present(path) ? readdirSync(path).filter((name) => name !== ".DS_Store") : [];

const assertRealDirectory = (path: string, label: string): void => {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw validation("migration", `${label} must be a real directory`);
};

const registeredWorktrees = (repository: string): Set<string> => {
  const output = git(repository, ["worktree", "list", "--porcelain", "-z"]);
  const paths = new Set<string>();
  for (const item of output.split("\0")) if (item.startsWith("worktree ")) paths.add(resolve(item.slice(9)));
  return paths;
};

const collectStateFiles = (oldRoot: string): { files: string[]; worktrees: Array<{ oldPath: string; recordedOldPath: string; newPath: string }> } => {
  const devruns = join(oldRoot, "devruns");
  if (!present(devruns)) return { files: [], worktrees: [] };
  assertRealDirectory(devruns, ".patchledger/devruns");
  for (const blocked of [".locks", ".pending"]) {
    const directory = join(devruns, blocked);
    if (directoryEntries(directory).length) throw validation("migration", `${relative(oldRoot, directory)} is not empty; finish or recover the local operation first`);
  }
  const files: string[] = [];
  const worktrees = new Map<string, { recordedOldPath: string; newPath: string }>();
  // State files live beside managed worktrees. Never descend into the worktree
  // itself: its repository may contain arbitrary JSON that is not Grounds state.
  for (const name of directoryEntries(devruns)) {
    if (name.startsWith(".")) continue;
    const runDirectory = join(devruns, name);
    const stat = lstatSync(runDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw validation("migration", `legacy DevRun entry must be a real directory: ${runDirectory}`);
    const path = join(runDirectory, "state.json");
    if (!present(path)) continue;
    const stateStat = lstatSync(path);
    if (!stateStat.isFile() || stateStat.isSymbolicLink()) throw validation("migration", `legacy DevRun state must be a real file: ${path}`);
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw validation("migration", `legacy state is not valid JSON: ${path}`); }
    if (value && typeof value === "object" && typeof (value as { worktree_path?: unknown }).worktree_path === "string") {
      const recordedOldPath = resolve((value as { worktree_path: string }).worktree_path);
      const oldPath = canonicalExistingOrParent(recordedOldPath);
      const canonicalOldRoot = realpathSync(oldRoot);
      if (!oldPath.startsWith(join(canonicalOldRoot, "devruns") + sep)) throw validation("migration", `managed worktree path escapes .patchledger: ${oldPath}`);
      const newPath = resolve(join(dirname(canonicalOldRoot), ".grounds"), relative(canonicalOldRoot, oldPath));
      worktrees.set(oldPath, { recordedOldPath, newPath });
      files.push(path);
    }
  }
  return { files: [...new Set(files)], worktrees: [...worktrees].map(([oldPath, value]) => ({ oldPath, ...value })) };
};

const gitPath = (worktree: string, name: string): string => resolve(worktree, git(worktree, ["rev-parse", "--git-path", name]));

const planRepository = (cwd: string): RepoPlan | undefined => {
  let repository: string;
  try { repository = resolve(git(cwd, ["rev-parse", "--show-toplevel"])); }
  catch { return undefined; }
  const oldRoot = join(repository, ".patchledger");
  const newRoot = join(repository, ".grounds");
  if (!present(oldRoot)) return undefined;
  if (present(newRoot)) throw validation("migration", "both .patchledger and .grounds exist; resolve the conflict before migration");
  assertRealDirectory(oldRoot, ".patchledger");
  const tracked = git(repository, ["ls-files", "--", ".patchledger", ".grounds"]);
  if (tracked) throw validation("migration", "legacy or target Grounds state is tracked by Git");
  const current = resolve(cwd);
  if (current === oldRoot || current.startsWith(oldRoot + sep)) throw validation("migration", "run migration outside the managed .patchledger directory");
  const collected = collectStateFiles(oldRoot);
  const registered = registeredWorktrees(repository);
  for (const worktree of collected.worktrees) {
    if (present(worktree.oldPath) && !registered.has(worktree.oldPath)) throw validation("migration", `managed worktree is not registered with Git: ${worktree.oldPath}`);
    if (present(worktree.newPath)) throw validation("migration", `target managed worktree already exists: ${worktree.newPath}`);
  }
  const gitCommon = resolve(repository, git(repository, ["rev-parse", "--git-common-dir"]));
  const metadataMoves: RepoPlan["metadataMoves"] = [];
  const registry = join(gitCommon, "patchledger-deliveries");
  if (present(registry)) metadataMoves.push({ source: registry, target: join(gitCommon, "grounds-deliveries") });
  for (const worktree of registered) {
    for (const [oldName, newName] of [["patchledger-review.json", "grounds-review.json"], ["patchledger-delivery.json", "grounds-delivery.json"]]) {
      if (!present(worktree)) continue;
      let source: string; let target: string;
      try { source = gitPath(worktree, oldName); target = gitPath(worktree, newName); }
      catch { throw validation("migration", `Git worktree registration cannot be verified: ${worktree}`); }
      if (present(source)) metadataMoves.push({ source, target });
    }
  }
  for (const move of metadataMoves) if (present(move.target)) throw validation("migration", `target metadata already exists: ${move.target}`);
  const exclude = resolve(repository, git(repository, ["rev-parse", "--git-path", "info/exclude"]));
  const oldExclude = present(exclude) ? readFileSync(exclude, "utf8") : "";
  const withoutLegacy = oldExclude.split(/\r?\n/).filter((line) => line !== "/.patchledger/").join("\n").replace(/\n*$/, "\n");
  const newExclude = withGroundsExclude(withoutLegacy);
  const journal = join(gitCommon, "grounds-brand-migration.json");
  if (present(journal)) throw new DomainError("MIGRATION_DIRTY", "a previous Grounds brand migration did not finish", false, { reason: `inspect ${journal}` });
  return { repository, gitCommon, oldRoot, newRoot, exclude, oldExclude, newExclude, stateFiles: collected.files, worktrees: collected.worktrees, metadataMoves, journal };
};

const replaceWorktreePaths = (root: string, plan: RepoPlan, forward: boolean): void => {
  for (const original of plan.stateFiles) {
    const path = forward ? join(root, relative(plan.oldRoot, original)) : join(root, relative(plan.oldRoot, original));
    if (!present(path)) continue;
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof value.worktree_path !== "string") continue;
    const currentWorktreePath = value.worktree_path;
    for (const worktree of plan.worktrees) {
      const from = forward ? worktree.oldPath : worktree.newPath;
      const to = forward ? worktree.newPath : worktree.oldPath;
      if (resolve(currentWorktreePath) === from || (forward && resolve(currentWorktreePath) === worktree.recordedOldPath)) value.worktree_path = to;
    }
    writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
  }
};

const rollbackRepository = (plan: RepoPlan): void => {
  const failures: string[] = [];
  for (const move of [...plan.metadataMoves].reverse()) {
    try { if (present(move.target) && !present(move.source)) renameSync(move.target, move.source); }
    catch (error) { failures.push(`metadata ${move.target}: ${String(error)}`); }
  }
  if (present(plan.newRoot) && !present(plan.oldRoot)) {
    try {
      replaceWorktreePaths(plan.newRoot, plan, false);
      renameSync(plan.newRoot, plan.oldRoot);
      const oldWorktrees = plan.worktrees.filter((item) => present(item.oldPath)).map((item) => item.oldPath);
      if (oldWorktrees.length) git(plan.repository, ["worktree", "repair", ...oldWorktrees]);
    } catch (error) { failures.push(`repository state: ${String(error)}`); }
  }
  try { writeFileSync(plan.exclude, plan.oldExclude, { mode: 0o600 }); }
  catch (error) { failures.push(`Git exclude: ${String(error)}`); }
  if (failures.length) throw new DomainError("MIGRATION_DIRTY", "Grounds brand migration rollback needs recovery", false, {
    reason: failures.join("; "), journal: plan.journal,
  });
  if (present(plan.journal)) rmSync(plan.journal);
};

const applyRepository = (plan: RepoPlan, retainJournal = false): MigrationPart => {
  writeFileSync(plan.journal, JSON.stringify({ format: "patchledger.brand-migration/v1", old_root: plan.oldRoot, new_root: plan.newRoot, worktrees: plan.worktrees }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
    renameSync(plan.oldRoot, plan.newRoot);
    replaceWorktreePaths(plan.newRoot, plan, true);
    const newWorktrees = plan.worktrees.filter((item) => present(item.newPath)).map((item) => item.newPath);
    if (newWorktrees.length) git(plan.repository, ["worktree", "repair", ...newWorktrees]);
    for (const move of plan.metadataMoves) { mkdirSync(dirname(move.target), { recursive: true }); renameSync(move.source, move.target); }
    mkdirSync(dirname(plan.exclude), { recursive: true }); writeFileSync(plan.exclude, plan.newExclude, { mode: 0o600 });
    if (!retainJournal) rmSync(plan.journal);
    return { status: "migrated", source: plan.oldRoot, target: plan.newRoot, moved_worktrees: newWorktrees.length };
  } catch (error) {
    rollbackRepository(plan);
    throw error;
  }
};

const oldKeychainPassword = (db: DatabaseConfig): string => {
  const locator = mysqlKeychainLocator(db);
  if (platform() === "darwin") return execFileSync("security", ["find-generic-password", "-s", "PatchLedger", "-a", locator, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\r?\n$/, "");
  if (platform() === "linux") return execFileSync("secret-tool", ["lookup", "service", "PatchLedger", "account", locator], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\r?\n$/, "");
  throw validation("migration", "automatic keychain migration is supported only on macOS and Linux");
};

const storeKeychainPassword = (db: DatabaseConfig, password: string): void => {
  const locator = mysqlKeychainLocator(db);
  if (platform() === "darwin") {
    const result = spawnSync("security", ["add-generic-password", "-U", "-s", "Grounds", "-a", locator, "-w", password], { stdio: "ignore" });
    if (result.status !== 0) throw validation("migration", "failed to store the Grounds keychain credential");
    return;
  }
  if (platform() === "linux") {
    const result = spawnSync("secret-tool", ["store", "--label=Grounds MySQL", "service", "Grounds", "account", locator], { input: password, stdio: ["pipe", "ignore", "ignore"] });
    if (result.status !== 0) throw validation("migration", "failed to store the Grounds keychain credential");
    return;
  }
  throw validation("migration", "automatic keychain migration is supported only on macOS and Linux");
};

const verifyDatabase = async (config: Config): Promise<void> => {
  const db = config.database;
  const store = db.driver === "sqlite"
    ? SQLStore.sqlite(db.path!)
    : SQLStore.mysql({ host: db.host!, port: db.port!, database: db.database!, username: db.username!, password: mysqlPassword(db), caFile: db.tls?.ca_file });
  try {
    // Brand migration verifies identity without requiring the ledger to be at
    // the newest business schema. The new config must be published first so
    // the explicit `grounds db migrate` command can perform that upgrade.
    const metadata = await store.inspect();
    if (metadata.database_id !== db.expected_database_id) throw new DomainError("DATABASE_ID_MISMATCH", "migrated config points at a different database");
  } finally { await store.close(); }
};

const planConfig = (legacyOverride = ""): { source: string; target: string; legacy: ReturnType<typeof loadLegacyConfig>; next: Config; moveDatabase?: { source: string; target: string } } | undefined => {
  const source = legacyOverride ? resolve(legacyOverride) : legacyConfigPath();
  const target = configPath();
  if (!present(source)) return undefined;
  if (present(target)) throw validation("migration", "both legacy and Grounds configuration files exist; resolve the conflict before migration");
  const legacy = loadLegacyConfig(source);
  const db: DatabaseConfig = { ...legacy.database, ...(legacy.database.password?.source === "environment" ? { password: { source: "environment", variable: "GROUNDS_MYSQL_PASSWORD" } } : {}) };
  let moveDatabase: { source: string; target: string } | undefined;
  if (db.driver === "sqlite" && resolve(db.path!) === resolve(legacyDefaultSQLitePath())) {
    if (!present(db.path!)) throw validation("migration", `legacy SQLite database does not exist: ${db.path}`);
    const targetDatabase = defaultSQLitePath();
    if (present(targetDatabase)) throw validation("migration", `Grounds SQLite target already exists: ${targetDatabase}`);
    for (const suffix of ["-wal", "-shm", "-journal"]) if (present(db.path! + suffix)) throw validation("migration", `legacy SQLite sidecar ${db.path! + suffix} exists; stop other processes and checkpoint the database first`);
    moveDatabase = { source: db.path!, target: targetDatabase };
    db.path = targetDatabase;
  }
  return { source, target, legacy, next: { version: 2, database: db }, ...(moveDatabase ? { moveDatabase } : {}) };
};

const applyConfig = async (plan: NonNullable<ReturnType<typeof planConfig>>): Promise<MigrationPart> => {
  let databaseMoved = false;
  let keychainCopied = false;
  try {
    if (plan.next.database.password?.source === "keychain") {
      const password = oldKeychainPassword(plan.legacy.database);
      if (!password) throw validation("migration", "legacy keychain credential is empty");
      storeKeychainPassword(plan.next.database, password);
      keychainCopied = true;
    }
    if (plan.moveDatabase) {
      mkdirSync(dirname(plan.moveDatabase.target), { recursive: true, mode: 0o700 });
      const sourceDevice = statSync(plan.moveDatabase.source).dev;
      const targetDevice = statSync(dirname(plan.moveDatabase.target)).dev;
      if (sourceDevice !== targetDevice) throw validation("migration", "legacy and Grounds SQLite paths are on different filesystems");
      renameSync(plan.moveDatabase.source, plan.moveDatabase.target);
      databaseMoved = true;
    }
    writeConfig(plan.target, plan.next);
    await verifyDatabase(plan.next);
    const backup = join(dirname(plan.target), "migration", "patchledger-config-v1.yaml");
    if (present(backup)) throw validation("migration", `legacy config backup already exists: ${backup}`);
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    renameSync(plan.source, backup);
    return { status: "migrated", source: plan.source, target: plan.target };
  } catch (error) {
    if (present(plan.target)) rmSync(plan.target, { force: true });
    if (databaseMoved && plan.moveDatabase && present(plan.moveDatabase.target) && !present(plan.moveDatabase.source)) renameSync(plan.moveDatabase.target, plan.moveDatabase.source);
    // A copied credential is deliberately retained as a harmless rollback aid.
    void keychainCopied;
    throw error;
  }
};

const configBackup = (plan: NonNullable<ReturnType<typeof planConfig>>): string =>
  join(dirname(plan.target), "migration", "patchledger-config-v1.yaml");

const rollbackConfig = (plan: NonNullable<ReturnType<typeof planConfig>>): void => {
  const backup = configBackup(plan);
  if (present(plan.target)) rmSync(plan.target, { force: true });
  if (present(backup) && !present(plan.source)) renameSync(backup, plan.source);
  if (plan.moveDatabase && present(plan.moveDatabase.target) && !present(plan.moveDatabase.source)) {
    renameSync(plan.moveDatabase.target, plan.moveDatabase.source);
  }
};

export const migratePatchLedgerBrand = async (options: BrandMigrationOptions): Promise<BrandMigrationResult> => {
  if (!isAbsolute(resolve(options.cwd))) throw validation("cwd", "must resolve to an absolute path");
  const repository = planRepository(options.cwd);
  const config = planConfig(options.legacyConfig);
  if (options.dryRun) return {
    result_type: "patchledger.result.brand-migration/v1", command: "migrate.patchledger", dry_run: true,
    config: !config ? { status: "not_found" } : { status: "planned", source: config.source, target: config.target },
    repository: !repository ? { status: "not_found" } : { status: "planned", source: repository.oldRoot, target: repository.newRoot, moved_worktrees: repository.worktrees.length },
  };
  let repositoryResult: MigrationPart = { status: "not_found" };
  let configResult: MigrationPart = { status: "not_found" };
  let repositoryApplied = false;
  let configApplied = false;
  try {
    if (repository) {
      repositoryResult = applyRepository(repository, Boolean(config));
      repositoryApplied = true;
    }
    if (config) {
      configResult = await applyConfig(config);
      configApplied = true;
    }
    if (repository && present(repository.journal)) rmSync(repository.journal);
    return { result_type: "patchledger.result.brand-migration/v1", command: "migrate.patchledger", dry_run: false, config: configResult, repository: repositoryResult };
  } catch (error) {
    try {
      if (configApplied && config) rollbackConfig(config);
      if (repositoryApplied && repository) rollbackRepository(repository);
    } catch (rollbackError) {
      throw rollbackError;
    }
    throw error;
  }
};
