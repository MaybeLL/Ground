import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataRoot, previousDataLocations } from "./data-layout.js";
import { loadConfig, writeConfig, type Config } from "./config.js";
import { planDataMigration, type DataMigrationPlan } from "./data-migration-plan.js";
import { stageRelocation, activateRelocation } from "./storage-relocation.js";
import { inspectLocalBindings, applyLocalBindings, type LocalBindingChange } from "./migration-local-state.js";
import { relocatePath, relocateRuntimeRecord, RELOCATABLE_RUNTIME_FORMATS, repairRelocatedWorktrees, saveRelocatedRuntimeRecords } from "./storage-bindings.js";
import { atomicPrivateWrite, privateDirectory, safeRead, withRuntimeLock, overlaps, directoryRegistryRoot } from "./runtime-files.js";
import { physicalClaims } from "./physical-directory.js";
import { validation } from "./errors.js";
import type { RuntimeRecord } from "./runtime-record.js";
import type { Store } from "./store-types.js";
import { inspectWorkspaceRegistry, repairWorkspaceRegistry, requireIdleEnvironmentLeases } from "./migration-registry.js";
import { installRetiredMarkers, retiredMarkers } from "./migration-retired.js";
import { requireIdleRepositoryControllers, withPreviousLayoutIdle } from "./migration-locks.js";

export interface DataMigrationInput {
  id: string; targetRoot?: string; oldDataRoot?: string; oldConfig?: string;
  oldRuntime?: string; oldRegistry?: string; repositories: string[];
}
interface MigrationJournal {
  format: "grounds.data-migration/v1";
  phase: "planned" | "files_activated" | "bindings_updated" | "complete";
  plan: DataMigrationPlan;
  config: Config;
  origins: { oldData: string; oldRuntime: string; oldRegistry: string; oldConfig: string };
  local_bindings: LocalBindingChange[];
  runtime_records: RuntimeRecord[];
  workspace_registry?: { target: string; original: string };
}

/** A single upgrade journal owns all stages; filesystem activation alone is not success. */
export async function migrateDataLayout(input: DataMigrationInput, connect: (config: Config) => Store): Promise<{
  result_type: "grounds.result.data-migration/v1"; command: "migrate.data"; phase: "complete";
  data_root: string; journal_path: string; moved_entries: number;
}> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.id)) throw validation("migration", "invalid identifier");
  const target = dataRoot(input.targetRoot), previous = previousDataLocations();
  const directory = join(target, "migration", input.id), path = join(directory, "journal.json");
  const oldData = resolve(input.oldDataRoot ?? previous.data), oldRuntime = resolve(input.oldRuntime ?? previous.runtime);
  const oldRegistry = resolve(input.oldRegistry ?? previous.directoryRegistry);
  const origins = { oldData, oldRuntime, oldRegistry, oldConfig: resolve(input.oldConfig ?? previous.config) };
  privateDirectory(directory);
  return withRuntimeLock(directoryRegistryRoot(), "data-layout", () => {
    // Validate the fixed journal before recognizing any retired controller path.
    const previousJournal: MigrationJournal | undefined = existsSync(path) ? JSON.parse(safeRead(path).toString()) : undefined;
    if (previousJournal && (previousJournal.format !== "grounds.data-migration/v1" || previousJournal.plan.target_root !== target
      || previousJournal.plan.relocation.id !== input.id || JSON.stringify(previousJournal.origins) !== JSON.stringify(origins)))
      throw validation("migration", "journal does not match this migration");
    return withPreviousLayoutIdle({ oldData, oldRuntime, oldRegistry, repositories: input.repositories,
      retiredControllers: previousJournal ? retiredMarkers(previousJournal.plan) : undefined }, async () => {
      const marker = join(directoryRegistryRoot(), "migration-active.json");
      if (existsSync(marker) && JSON.parse(safeRead(marker, 16 * 1024).toString()).journal_path !== path)
        throw validation("migration", "another data-root migration must be completed first");
      let journal: MigrationJournal;
      if (previousJournal) {
        journal = previousJournal;
      } else {
        const config = loadConfig(origins.oldConfig);
        const store = connect(config);
        let records: RuntimeRecord[];
        try {
          if ((await store.open()).database_id !== config.database.expected_database_id) throw validation("migration", "source ledger identity differs from configuration");
          const hostFile = join(oldData, "runtime", "host-id");
          const host = existsSync(hostFile) ? safeRead(hostFile, 128).toString().trim() : undefined;
          records = (await store.read(tx => tx.listRuntimeRecords("runtime_operation"))).filter(row => host !== undefined && row.data.host_id === host
            && RELOCATABLE_RUNTIME_FORMATS.includes(String(row.data.format)));
        } finally { await store.close(); }
        const plan = planDataMigration(input), mappings = plan.mappings!;
        if (plan.blockers.length) throw validation("migration", plan.blockers.join("; "));
        requireIdleRepositoryControllers(plan.repositories);
        requireIdleEnvironmentLeases(oldRegistry, mappings);
        for (const row of records) relocateRuntimeRecord(row, mappings);
        for (const claim of Object.values(physicalClaims(oldRegistry))) {
          if (plan.relocation.entries.some(entry => overlaps(entry.source, claim.directory)))
            throw validation("migration", `persistent ${claim.kind} ownership must be resolved first: ${claim.id}`);
        }
        const roots = [join(oldData, "runtime", "route-executions"), join(oldData, "runtime", "route-git"),
          join(oldData, "workspaces"), join(oldRuntime, "environments", "instances"),
          ...(plan.metadata_roots ?? []),
          ...plan.repositories.flatMap(repository => [join(repository, ".grounds", "authoring"), join(repository, ".grounds", "development"), join(repository, ".grounds", "devruns")])];
        const localBindings = inspectLocalBindings(roots, plan.repositories, mappings);
        const registryPath = join(oldRegistry, "workspace-registry.json"), registry = inspectWorkspaceRegistry(registryPath, mappings);
        journal = { format: "grounds.data-migration/v1", phase: "planned", plan, config, origins, local_bindings: localBindings, runtime_records: records,
          ...(registry === undefined ? {} : { workspace_registry: { target: relocatePath(registryPath, mappings), original: registry } }) };
        atomicPrivateWrite(path, JSON.stringify(journal));
      }
      const save = (phase: MigrationJournal["phase"]) => { journal.phase = phase; atomicPrivateWrite(path, JSON.stringify(journal)); };
      const mappings = journal.plan.mappings!;
      if (journal.phase !== "complete") atomicPrivateWrite(marker, JSON.stringify({ format: "grounds.data-migration-active/v1", journal_path: path, data_root: target }));
      if (journal.phase === "planned") {
        requireIdleRepositoryControllers(journal.plan.repositories);
        await stageRelocation(join(directory, "files.json"), journal.plan.relocation);
        await activateRelocation(join(directory, "files.json"));
        for (const [index, extraction] of (journal.plan.extractions ?? []).entries()) {
          const extractionPath = join(directory, `extract-${index}.json`);
          await stageRelocation(extractionPath, extraction);
          await activateRelocation(extractionPath);
        }
        save("files_activated");
      }
      if (journal.phase === "files_activated") {
        repairRelocatedWorktrees(journal.plan, mappings);
        applyLocalBindings(journal.local_bindings);
        if (journal.workspace_registry) repairWorkspaceRegistry(journal.workspace_registry.target, journal.workspace_registry.original, mappings);
        const config: Config = structuredClone(journal.config);
        if (config.database.path) config.database.path = relocatePath(config.database.path, mappings);
        if (config.database.tls?.ca_file) config.database.tls.ca_file = relocatePath(config.database.tls.ca_file, mappings);
        const store = connect(config);
        try {
          if ((await store.open()).database_id !== config.database.expected_database_id) throw validation("migration", "relocated ledger identity differs");
          await saveRelocatedRuntimeRecords(store, journal.runtime_records, mappings);
        } finally { await store.close(); }
        const configPath = join(target, "config.yaml");
        if (existsSync(configPath)) {
          const current = loadConfig(configPath);
          if (JSON.stringify(current) !== JSON.stringify(journal.config) && JSON.stringify(current) !== JSON.stringify(config))
            throw validation("migration", "configuration changed during migration; retain both copies");
        }
        writeConfig(configPath, config, true);
        save("bindings_updated");
      }
      if (journal.phase === "bindings_updated") {
        repairRelocatedWorktrees(journal.plan, mappings);
        applyLocalBindings(journal.local_bindings);
        if (journal.workspace_registry) repairWorkspaceRegistry(journal.workspace_registry.target, journal.workspace_registry.original, mappings);
        const store = connect(loadConfig(join(target, "config.yaml")));
        try {
          if ((await store.open()).database_id !== journal.config.database.expected_database_id) throw validation("migration", "final ledger identity differs");
          await saveRelocatedRuntimeRecords(store, journal.runtime_records, mappings);
        } finally { await store.close(); }
        installRetiredMarkers(journal.plan);
        save("complete");
      }
      if (journal.phase !== "complete") throw validation("migration", "unrecognized migration phase; retain journal");
      installRetiredMarkers(journal.plan);
      if (existsSync(marker)) unlinkSync(marker);
      return { result_type: "grounds.result.data-migration/v1", command: "migrate.data", phase: "complete",
        data_root: target, journal_path: path, moved_entries: [journal.plan.relocation, ...(journal.plan.extractions ?? [])].reduce((total, stage) => total + stage.entries.length, 0) };
    });
  });
}
