import { existsSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Store } from "./store-types.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { isUUIDv7, newUUIDv7 } from "./identity.js";
import { sha256 } from "./canonical-json.js";
import { privateDirectory, directoryRegistryRoot, hostIdentity, atomicPrivateWrite, safeRead, withRuntimeLock } from "./runtime-files.js";
import { DomainError, validation, notFound } from "./errors.js";
import { DevelopmentRecipes } from "./development-recipes.js";
import { RepositoryEnvironments, type RepositoryEnvironmentConfiguration } from "./repository-environment.js";
import type { DevelopmentBuildIdentity, DevelopmentImageBuilder } from "./development-image-buildkit.js";
import { inspectDevelopmentInputs, cleanupDevelopmentInputs } from "./development-image-inputs.js";

export interface DevelopmentTarget { environment_id: string; expected_version: number; configuration: Omit<RepositoryEnvironmentConfiguration, "image" | "preparation_id"> }
export interface DevelopmentPreparation extends DevelopmentBuildIdentity {
  format: "grounds.development-image-preparation/v1"; recipe_revision_id: string; repository_id: string;
  database_id: string; host_id: string; data_root: string; request_digest: string; target: DevelopmentTarget;
  build_args: Record<string, string>; registration_operation_id: string; environment_revision_id?: string;
  registration_error?: string; image?: string; state: "registered" | "blocked" | "building" | "needs-recovery" | "ready" | "cancelled";
  cancellation?: { operation_id: string; attribution: Attribution; requested_at: string };
  cleanup?: { operation_id: string; attribution: Attribution; state: "pending" | "complete" };
  attribution: Attribution; created_at: string;
}
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
export class DevelopmentImagePreparations {
  constructor(private readonly store: Store, private readonly engine: Pick<DevelopmentImageBuilder, "identity" | "build" | "find" | "verify">) {}
  async show(id: string): Promise<DevelopmentPreparation> {
    if (!isUUIDv7(id)) throw validation("preparation_id", "requires UUIDv7");
    const row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", id));
    if (!row || row.data.format !== "grounds.development-image-preparation/v1") throw notFound("development_preparation", id);
    return row.data as unknown as DevelopmentPreparation;
  }
  async cleanup(input: { operation_id: string; attribution: Attribution; preparation_id: string }) {
    if (![input.operation_id, input.preparation_id].every(isUUIDv7)) throw validation("identity", "requires UUIDv7");
    validateAttribution(input.attribution);
    const initial = await this.show(input.preparation_id), root = join(initial.data_root, "runtime");
    if (initial.host_id !== hostIdentity(root) || initial.database_id !== (await this.store.open()).database_id) conflict("Cleanup requires original host and database");
    return withRuntimeLock(directoryRegistryRoot(), `development-build:${initial.input_digest}`, async () => {
      const record = await this.store.write(async tx => {
        const replay = await tx.reserveOperation({ id: input.operation_id, command: "code-workspace.recipe-preparation-cleanup", request_hash: sha256(input) });
        if (replay) return (await tx.getRuntimeRecord("runtime_operation", input.preparation_id))!.data as unknown as DevelopmentPreparation;
        await tx.lockRuntimeRecord("runtime_operation", input.preparation_id);
        const row = (await tx.getRuntimeRecord("runtime_operation", input.preparation_id))!;
        const current = row.data as unknown as DevelopmentPreparation;
        if (!["ready", "cancelled"].includes(current.state)) conflict("Only terminal preparations can clean inputs");
        if (current.cleanup && current.cleanup.operation_id !== input.operation_id && current.cleanup.state !== "complete") conflict("Resume original cleanup operation");
        const result: DevelopmentPreparation = { ...current, cleanup: current.cleanup ?? { operation_id: input.operation_id, attribution: input.attribution, state: "pending" } };
        await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...result } }, row.version);
        await tx.completeOperation(input.operation_id, JSON.stringify(result)); return result;
      });
      if (record.cleanup?.state === "complete") return record;
      cleanupDevelopmentInputs(join(root, "development-builds", record.preparation_id, "context"), await new DevelopmentRecipes(this.store).show(record.recipe_revision_id));
      return this.save({ ...record, cleanup: { ...record.cleanup!, state: "complete" } });
    });
  }
  private async save(record: DevelopmentPreparation) {
    return this.store.write(async tx => {
      await tx.lockRuntimeRecord("runtime_operation", record.preparation_id);
      const row = (await tx.getRuntimeRecord("runtime_operation", record.preparation_id))!;
      const current = row.data as unknown as DevelopmentPreparation;
      const result = { ...record, ...(current.cancellation ? { cancellation: current.cancellation } : {}) };
      if (current.state === "cancelled" || (result.cancellation && result.state === "ready")) result.state = "cancelled";
      await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...result } }, row.version); return result;
    });
  }
  async cancel(input: { operation_id: string; attribution: Attribution; preparation_id: string }) {
    if (![input.operation_id, input.preparation_id].every(isUUIDv7)) throw validation("identity", "requires UUIDv7");
    validateAttribution(input.attribution);
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: input.operation_id, command: "code-workspace.recipe-preparation-cancel", request_hash: sha256(input) });
      if (replay) return JSON.parse(replay.result_json) as DevelopmentPreparation;
      await tx.lockRuntimeRecord("runtime_operation", input.preparation_id);
      const row = await tx.getRuntimeRecord("runtime_operation", input.preparation_id);
      if (!row || row.data.format !== "grounds.development-image-preparation/v1") throw notFound("development_preparation", input.preparation_id);
      const record = row.data as unknown as DevelopmentPreparation;
      if (record.state === "ready") conflict("Completed preparation cannot be cancelled");
      const result: DevelopmentPreparation = { ...record, cancellation: { operation_id: input.operation_id,
        attribution: input.attribution, requested_at: await tx.now() },
        state: ["registered", "blocked", "cancelled"].includes(record.state) ? "cancelled" : record.state };
      await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...result } }, row.version);
      await tx.completeOperation(input.operation_id, JSON.stringify(result)); return result;
    });
  }
  private async register(record: DevelopmentPreparation) {
    if (record.environment_revision_id || record.state !== "ready") return record;
    try {
      const env = await new RepositoryEnvironments(this.store).save({ operation_id: record.registration_operation_id,
        attribution: record.attribution, repository_id: record.repository_id,
        environment_id: record.target.environment_id, expected_version: record.target.expected_version,
        configuration: { ...record.target.configuration, image: record.image!, preparation_id: record.preparation_id } });
      const { registration_error, ...rest } = record;
      return await this.save({ ...rest, environment_revision_id: env.revision_id });
    } catch (error) { return this.save({ ...record, registration_error: error instanceof DomainError ? error.code : "REGISTRATION_UNCONFIRMED" }); }
  }
  async prepare(input: { operation_id: string; attribution: Attribution; recipe_revision_id: string; data_root: string;
    build_args: Record<string, string>; target: DevelopmentTarget }): Promise<DevelopmentPreparation> {
    const request = structuredClone(input); request.data_root = resolve(request.data_root);
    if (!request.target || typeof request.target !== "object" || Array.isArray(request.target)
      || Object.keys(request.target).some(key => !["environment_id", "expected_version", "configuration"].includes(key)))
      throw validation("target", "only environment_id, expected_version and configuration are accepted");
    if (![request.operation_id, request.recipe_revision_id, request.target?.environment_id].every(isUUIDv7)
      || !Number.isSafeInteger(request.target.expected_version) || request.target.expected_version < 0) throw validation("identity", "requires UUIDv7 identities and expected_version");
    validateAttribution(request.attribution);
    const configuration = request.target.configuration;
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)
      || Object.keys(configuration).some(k => !["name", "postgres"].includes(k)) || typeof configuration.name !== "string"
      || !configuration.name.trim() || configuration.name.length > 128 || /[\x00-\x1f]/.test(configuration.name)
      || (configuration.postgres !== undefined && (!configuration.postgres || Object.keys(configuration.postgres).some(k => k !== "image") || !/^sha256:[a-f0-9]{64}$/.test(configuration.postgres.image))))
      throw validation("target", "requires a complete environment name and optional fixed postgres image");
    if (!request.build_args || typeof request.build_args !== "object" || Array.isArray(request.build_args) || Object.keys(request.build_args).length > 32
      || Object.entries(request.build_args).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)
        || /proxy|password|token|secret|credential/i.test(k) || typeof v !== "string" || v.length > 4096 || /[\x00-\x1f]/.test(v)))
      throw validation("build_args", "requires at most 32 bounded non-secret build arguments; proxies are unsupported");
    const requestDigest = sha256(request);
    const prior = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
    if (prior && (prior.data.format !== "grounds.development-image-preparation/v1" || prior.data.request_digest !== requestDigest)) conflict("Preparation operation reused with different inputs");
    if (prior && prior.data.state === "cancelled") return prior.data as unknown as DevelopmentPreparation;
    const recipe = await new DevelopmentRecipes(this.store).show(request.recipe_revision_id);
    const root = privateDirectory(join(request.data_root, "runtime")), host = hostIdentity(root);
    const engine = await this.engine.identity(), database = (await this.store.open()).database_id;
    const inputDigest = sha256({ profile: "grounds-development-build/v1", database, repository: recipe.repository_id,
      material: recipe.digest, build_args: request.build_args, engine_id: engine.engine_id, platform: engine.platform, builder: engine.builder });
    if (prior && (prior.data.input_digest !== inputDigest || prior.data.host_id !== host || prior.data.database_id !== database)) conflict("Build engine, host or database changed; retain original preparation");
    return withRuntimeLock(directoryRegistryRoot(), `development-build:${inputDigest}`, async () => {
      let record = await this.store.write(async tx => {
        const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.recipe-prepare", request_hash: requestDigest });
        if (replay) return (await tx.getRuntimeRecord("runtime_operation", request.operation_id))!.data as unknown as DevelopmentPreparation;
        const result: DevelopmentPreparation = { format: "grounds.development-image-preparation/v1", preparation_id: request.operation_id,
          recipe_revision_id: recipe.revision_id, repository_id: recipe.repository_id, database_id: database, host_id: host, data_root: request.data_root,
          input_digest: inputDigest, request_digest: requestDigest, target: request.target, build_args: request.build_args,
          registration_operation_id: newUUIDv7(), ...engine, state: "registered", attribution: request.attribution, created_at: await tx.now() };
        await tx.saveRuntimeRecord({ id: result.preparation_id, parent_id: result.recipe_revision_id, kind: "runtime_operation", version: 1, data: { ...result } }, 0);
        await tx.completeOperation(request.operation_id, JSON.stringify(result)); return result;
      });
      if (record.state === "ready") return this.register(record);
      const ownerFile = join(directoryRegistryRoot(), "development-builds", "owners", inputDigest.slice(7) + ".json");
      if (existsSync(ownerFile)) {
        const owner = await this.show(JSON.parse(safeRead(ownerFile, 1024).toString()).preparation_id);
        if (owner.input_digest !== inputDigest || owner.database_id !== database) conflict("Build ownership changed");
        if (owner.preparation_id !== record.preparation_id && !["ready", "cancelled"].includes(owner.state)) conflict(`Unresolved preparation owns these inputs: ${owner.preparation_id}`);
      } else if (!["registered", "blocked"].includes(record.state)) conflict("Build ownership missing; retain unresolved preparation");
      atomicPrivateWrite(ownerFile, JSON.stringify({ preparation_id: record.preparation_id }));
      const ready = async (image: string) => {
        if (!await this.engine.verify(record, image)) conflict("Build result cannot be verified");
        record = await this.save({ ...record, state: "ready", image }); return this.register(record);
      };
      const directory = join(root, "development-builds", record.preparation_id);
      try {
        if (!["registered", "blocked"].includes(record.state)) {
          const found = await this.engine.find(record);
          return found ? ready(found) : this.save({ ...record, state: "needs-recovery" });
        }
        privateDirectory(directory);
        for (const file of recipe.files) {
          const path = join(directory, "context", file.path); atomicPrivateWrite(path, Buffer.from(file.content, "base64"));
          chmodSync(path, file.mode === "100755" ? 0o755 : 0o644);
        }
        inspectDevelopmentInputs(join(directory, "context"), recipe);
        record = await this.save({ ...record, state: "building" });
        if (record.state === "cancelled") return record;
        return await ready(await this.engine.build(record, join(directory, "context"), recipe.dockerfile, record.build_args, join(directory, "build.log")));
      } catch { return this.save({ ...record, state: ["registered", "blocked"].includes(record.state) ? "blocked" : "needs-recovery" }); }
    });
  }
}
