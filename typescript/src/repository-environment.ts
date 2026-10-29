import { repositorySetting, repositorySettingID } from "./repository-settings.js";
import { sha256 } from "./canonical-json.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { validation, notFound, DomainError } from "./errors.js";
import { isUUIDv7, newUUIDv7 } from "./identity.js";
import type { Store } from "./store-types.js";
import type { RepositoryEnvironmentCheck } from "./repository-environment-check.js";

/** Fixed local images with optional build provenance; saving never promotes a default. */
export interface RepositoryEnvironmentConfiguration {
  name: string;
  image: string;
  preparation_id?: string;
  postgres?: { image: string };
}
export interface RepositoryEnvironmentVersion {
  format: "grounds.repository-environment/v1";
  environment_id: string; revision_id: string; repository_id: string; version: number;
  configuration: RepositoryEnvironmentConfiguration; digest: string;
  attribution: Attribution; created_at: string;
}
export interface RepositoryEnvironmentDefault {
  format: "grounds.repository-environment-default/v1";
  repository_id: string; revision_id: string; check_id: string; version: number;
  attribution: Attribution; selected_at: string;
}
const imageID = (image: unknown) => typeof image === "string" && /^sha256:[a-f0-9]{64}$/.test(image);
function validate(configuration: RepositoryEnvironmentConfiguration) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)
    || Object.keys(configuration).some(key => !["name", "image", "postgres", "preparation_id"].includes(key))
    || typeof configuration.name !== "string" || !configuration.name.trim() || configuration.name.length > 128
    || /[\x00-\x1f]/.test(configuration.name) || !imageID(configuration.image))
    throw validation("configuration", "requires a bounded name and fixed local image ID");
  if (configuration.preparation_id !== undefined && !isUUIDv7(configuration.preparation_id)) throw validation("preparation_id", "requires UUIDv7");
  if (configuration.postgres !== undefined && (!configuration.postgres || typeof configuration.postgres !== "object"
    || Array.isArray(configuration.postgres) || Object.keys(configuration.postgres).some(key => key !== "image")
    || !imageID(configuration.postgres.image))) throw validation("postgres", "requires a fixed local PostgreSQL image ID");
}

/** Immutable Repo-scoped versions in the selected Grounds database. Saving never changes a default. */
export class RepositoryEnvironments {
  constructor(private readonly store: Store) {}
  async save(input: { operation_id: string; environment_id: string; repository_id: string; expected_version: number;
    configuration: RepositoryEnvironmentConfiguration; attribution: Attribution }): Promise<RepositoryEnvironmentVersion> {
    const request = structuredClone(input);
    for (const id of [request.operation_id, request.environment_id, request.repository_id])
      if (!isUUIDv7(id)) throw validation("identity", "requires UUIDv7");
    if (!Number.isSafeInteger(request.expected_version) || request.expected_version < 0) throw validation("expected_version", "requires a nonnegative integer");
    validate(request.configuration); validateAttribution(request.attribution);
    const { operation_id, ...body } = request;
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: operation_id, command: "code-workspace.environment-save", request_hash: sha256(body) });
      if (replay) return JSON.parse(replay.result_json) as RepositoryEnvironmentVersion;
      await tx.getRepository(request.repository_id);
      if (request.configuration.preparation_id) {
        const prepared = await tx.getRuntimeRecord("runtime_operation", request.configuration.preparation_id);
        if (!prepared || !["grounds.repository-image-preparation/v1", "grounds.development-image-preparation/v1"].includes(String(prepared.data.format)) || prepared.data.state !== "ready"
          || prepared.data.repository_id !== request.repository_id || prepared.data.image !== request.configuration.image)
          throw new DomainError("STATE_CONFLICT", "Environment requires a ready preparation of this repository and exact image");
      }
      const head = await tx.getRuntimeRecord("runtime_operation", request.environment_id);
      if (head && (head.data.format !== "grounds.repository-environment-head/v1" || head.data.repository_id !== request.repository_id))
        throw validation("environment_id", "belongs to another repository or record type");
      if (head) await tx.lockRuntimeRecord("runtime_operation", request.environment_id);
      const result: RepositoryEnvironmentVersion = { format: "grounds.repository-environment/v1",
        environment_id: request.environment_id, revision_id: newUUIDv7(), repository_id: request.repository_id,
        version: request.expected_version + 1, configuration: request.configuration, digest: sha256(request.configuration),
        attribution: request.attribution, created_at: await tx.now() };
      await tx.saveRuntimeRecord({ id: result.revision_id, parent_id: result.environment_id, kind: "runtime_operation", version: 1, data: { ...result } }, 0);
      await tx.saveRuntimeRecord({ id: result.environment_id, kind: "runtime_operation", version: result.version,
        data: { format: "grounds.repository-environment-head/v1", repository_id: result.repository_id, revision_id: result.revision_id } }, request.expected_version);
      await tx.completeOperation(operation_id, JSON.stringify(result));
      return result;
    });
  }
  async revision(id: string): Promise<RepositoryEnvironmentVersion> {
    if (!isUUIDv7(id)) throw validation("revision_id", "requires UUIDv7");
    return this.store.read(async tx => {
      const row = await tx.getRuntimeRecord("runtime_operation", id);
      if (!row || row.data.format !== "grounds.repository-environment/v1") throw notFound("environment_revision", id);
      return row.data as unknown as RepositoryEnvironmentVersion;
    });
  }
  async default(repositoryId: string): Promise<RepositoryEnvironmentDefault> {
    if (!isUUIDv7(repositoryId)) throw validation("repository_id", "requires UUIDv7");
    return this.store.read(async tx => {
      const row = await repositorySetting(tx, repositoryId, "environment-default");
      if (!row || row.data.format !== "grounds.repository-environment-default/v1") throw notFound("environment_default", repositoryId);
      return row.data as unknown as RepositoryEnvironmentDefault;
    });
  }
  async setDefault(input: { operation_id: string; repository_id: string; check_id: string; expected_version: number;
    attribution: Attribution }): Promise<RepositoryEnvironmentDefault> {
    const request = structuredClone(input);
    for (const id of [request.operation_id, request.repository_id, request.check_id])
      if (!isUUIDv7(id)) throw validation("default", "requires UUIDv7 identities");
    if (!Number.isSafeInteger(request.expected_version) || request.expected_version < 0) throw validation("expected_version", "requires a nonnegative integer");
    validateAttribution(request.attribution);
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.environment-set-default", request_hash: sha256(request) });
      if (replay) return JSON.parse(replay.result_json) as RepositoryEnvironmentDefault;
      await tx.getRepository(request.repository_id);
      const row = await tx.getRuntimeRecord("runtime_operation", request.check_id);
      const check = row?.data as unknown as RepositoryEnvironmentCheck | undefined;
      if (!check || check.format !== "grounds.repository-environment-check/v1" || check.state !== "passed" || check.exit_code !== 0
        || check.environment.repository_id !== request.repository_id || !check.engine_id || !check.platform || !check.completed_at)
        throw new DomainError("STATE_CONFLICT", "Default requires a completed successful check of this repository environment");
      const revision = await tx.getRuntimeRecord("runtime_operation", check.environment.revision_id);
      if (!revision || sha256(revision.data) !== sha256(check.environment)) throw new DomainError("STATE_CONFLICT", "Checked environment version is unavailable or changed");
      // A Repo owns one default head; conditional writes serialize first creation as well as updates.
      const head = await repositorySetting(tx, request.repository_id, "environment-default");
      if (head) await tx.lockRuntimeRecord("runtime_operation", head.id);
      const result: RepositoryEnvironmentDefault = { format: "grounds.repository-environment-default/v1",
        repository_id: request.repository_id, revision_id: check.environment.revision_id, check_id: check.check_id,
        version: request.expected_version + 1, attribution: request.attribution, selected_at: await tx.now() };
      await tx.saveRuntimeRecord({ id: head?.id ?? repositorySettingID(request.repository_id, "environment-default"),
        ...(head ? (head.parent_id ? { parent_id: head.parent_id } : {}) : { parent_id: request.repository_id }),
        kind: "runtime_operation", version: result.version, data: { ...result } }, request.expected_version);
      await tx.completeOperation(request.operation_id, JSON.stringify(result));
      return result;
    });
  }
}
