import { existsSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "./canonical-json.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { DomainError, notFound, validation } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { privateDirectory, atomicPrivateWrite, safeRead, withRuntimeLock, hostIdentity } from "./runtime-files.js";
import { RepositoryBuildMaterials, type RepositoryBuildMaterial } from "./repository-build-materials.js";
import { cleanupBuildInputs } from "./repository-image-cleanup.js";
import type { Store } from "./store-types.js";

export interface ImageBuildHost { engine_id: string; platform: string; builder: string }
export interface ImagePreparation extends ImageBuildHost {
  format: "grounds.repository-image-preparation/v1";
  preparation_id: string; repository_id: string; material_id: string; material_digest: string; base_image: string;
  database_id: string; host_id: string; data_root: string; input_digest: string; request_digest: string;
  state: "registered" | "blocked" | "building" | "needs-recovery" | "ready" | "failed" | "cancelled";
  cleanup?: { operation_id: string; attribution: Attribution; state: "pending" | "complete" };
  cancellation?: { operation_id: string; attribution: Attribution; requested_at: string };
  image?: string; reused?: boolean; producer_id?: string; attribution: Attribution; created_at: string;
}
/** Only the external builder is replaceable; materials, persistence and ownership are real. */
export interface ImageBuildEngine {
  identity(): Promise<ImageBuildHost>;
  assertBase(image: string, platform: string): Promise<void>;
  build(record: ImagePreparation, material: RepositoryBuildMaterial, directory: string): Promise<string>;
  find(record: ImagePreparation): Promise<string | undefined>;
  failureConfirmed?(record: ImagePreparation, directory: string): Promise<boolean>;
  verify(record: ImagePreparation, image: string): Promise<boolean>;
}
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
export class RepositoryImagePreparations {
  constructor(private readonly store: Store, private readonly engine: ImageBuildEngine) {}
  async show(id: string): Promise<ImagePreparation> { return readImagePreparation(this.store, id); }
  private async save(record: ImagePreparation): Promise<ImagePreparation> {
    return this.store.write(async tx => {
      await tx.lockRuntimeRecord("runtime_operation", record.preparation_id);
      const previous = (await tx.getRuntimeRecord("runtime_operation", record.preparation_id))!;
      const current = previous.data as unknown as ImagePreparation;
      const result = { ...record, ...(current.cancellation ? { cancellation: current.cancellation } : {}) };
      if (current.state === "cancelled" || (current.cancellation && ["ready", "failed", "cancelled"].includes(result.state))) result.state = "cancelled";
      await tx.saveRuntimeRecord({ ...previous, version: previous.version + 1, data: { ...result } }, previous.version);
      return result;
    });
  }
  /** Cancellation is cooperative: it never treats disconnecting a client as a stop proof. */
  async cancel(input: { operation_id: string; preparation_id: string; attribution: Attribution }): Promise<ImagePreparation> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id) || !isUUIDv7(request.preparation_id)) throw validation("cancellation", "requires UUIDv7 identities");
    validateAttribution(request.attribution);
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.image-cancel", request_hash: sha256(request) });
      await tx.lockRuntimeRecord("runtime_operation", request.preparation_id);
      const row = await tx.getRuntimeRecord("runtime_operation", request.preparation_id);
      if (!row || row.data.format !== "grounds.repository-image-preparation/v1") throw notFound("image_preparation", request.preparation_id);
      let result = row.data as unknown as ImagePreparation;
      if (replay) return result;
      if (result.state === "ready") conflict("A completed image preparation cannot be cancelled");
      if (!["failed", "cancelled"].includes(result.state) && !result.cancellation) {
        result = { ...result, cancellation: { operation_id: request.operation_id, attribution: request.attribution, requested_at: await tx.now() },
          state: ["registered", "blocked"].includes(result.state) ? "cancelled" : result.state };
        await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...result } }, row.version);
      }
      await tx.completeOperation(request.operation_id, JSON.stringify(result));
      return result;
    });
  }
  async cleanup(input: { operation_id: string; preparation_id: string; attribution: Attribution }): Promise<ImagePreparation> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id) || !isUUIDv7(request.preparation_id)) throw validation("cleanup", "requires UUIDv7 identities");
    validateAttribution(request.attribution);
    const initial = await this.show(request.preparation_id), root = join(initial.data_root, "runtime");
    if (hostIdentity(root) !== initial.host_id || (await this.store.open()).database_id !== initial.database_id)
      conflict("Build cleanup belongs to another host or database");
    return withRuntimeLock(root, `image-preparation:${initial.input_digest}`, async () => {
      const record = await this.store.write(async tx => {
        const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.image-cleanup", request_hash: sha256(request) });
        await tx.lockRuntimeRecord("runtime_operation", request.preparation_id);
        const row = (await tx.getRuntimeRecord("runtime_operation", request.preparation_id))!;
        let result = row.data as unknown as ImagePreparation;
        if (!["ready", "failed", "cancelled"].includes(result.state)) conflict("Build cleanup requires a terminal preparation; unknown builds retain ownership");
        if (replay) return result;
        if (result.cleanup?.state === "pending") conflict("Resume the original cleanup operation");
        if (!result.cleanup) {
          result = { ...result, cleanup: { operation_id: request.operation_id, attribution: request.attribution, state: "pending" } };
          await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...result } }, row.version);
        }
        await tx.completeOperation(request.operation_id, JSON.stringify(result));
        return result;
      });
      if (record.cleanup!.state === "complete") return record; // Do not touch a path recreated after completion.
      cleanupBuildInputs(record, await new RepositoryBuildMaterials(this.store).show(record.material_id));
      return this.save({ ...record, cleanup: { ...record.cleanup!, state: "complete" } });
    });
  }
  async prepare(input: { operation_id: string; material_id: string; base_image: string; data_root: string; attribution: Attribution }): Promise<ImagePreparation> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id) || !isUUIDv7(request.material_id) || !/^sha256:[a-f0-9]{64}$/.test(request.base_image))
      throw validation("preparation", "requires UUIDv7 identities and a fixed local base image");
    validateAttribution(request.attribution);
    request.data_root = resolve(request.data_root);
    const requestDigest = sha256(request);
    const prior = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
    if (prior && (prior.data.format !== "grounds.repository-image-preparation/v1" || prior.data.request_digest !== requestDigest))
      conflict("Image preparation ID reused with different inputs");
    if (prior && ["ready", "failed", "cancelled"].includes(String(prior.data.state))) return prior.data as unknown as ImagePreparation; // Historical replay, not a fresh availability claim.
    const material = await new RepositoryBuildMaterials(this.store).show(request.material_id);
    const root = privateDirectory(join(request.data_root, "runtime")), host = hostIdentity(root);
    const engine = await this.engine.identity(), database = (await this.store.open()).database_id;
    if (!engine.engine_id || !engine.platform || !engine.builder) conflict("Builder identity is unavailable");
    const inputDigest = sha256({ profile: "grounds-fixed-recipe/v1", database, repository: material.repository_id,
      material: material.digest, base_image: request.base_image, ...engine });
    if (prior && (prior.data.input_digest !== inputDigest || prior.data.host_id !== host || prior.data.database_id !== database))
      conflict("Build engine, host or database changed; retain original preparation");
    return withRuntimeLock(root, `image-preparation:${inputDigest}`, async () => {
      let record = await this.store.write(async tx => {
        const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.image-prepare", request_hash: requestDigest });
        if (replay) return (await tx.getRuntimeRecord("runtime_operation", request.operation_id))!.data as unknown as ImagePreparation;
        const result: ImagePreparation = { format: "grounds.repository-image-preparation/v1", preparation_id: request.operation_id,
          repository_id: material.repository_id, material_id: material.material_id, material_digest: material.digest,
          base_image: request.base_image, database_id: database, host_id: host, data_root: request.data_root,
          input_digest: inputDigest, request_digest: requestDigest, ...engine, state: "registered",
          attribution: request.attribution, created_at: await tx.now() };
        await tx.saveRuntimeRecord({ id: result.preparation_id, kind: "runtime_operation", parent_id: material.material_id, version: 1, data: { ...result } }, 0);
        await tx.completeOperation(request.operation_id, JSON.stringify(result));
        return result;
      });
      if (["ready", "failed", "cancelled"].includes(record.state)) return record;
      const cache = join(root, "image-preparations", "cache", `${inputDigest.slice(7)}.json`);
      if (existsSync(cache)) {
        const ownerID = JSON.parse(safeRead(cache, 1024).toString()).preparation_id;
        const owner = await this.show(ownerID);
        if (owner.input_digest !== inputDigest || owner.data_root !== request.data_root || owner.host_id !== host || owner.database_id !== database)
          conflict("Build cache ownership changed");
        if (owner.preparation_id !== record.preparation_id) {
          if (!["ready", "failed", "cancelled"].includes(owner.state)) conflict(`An unresolved image preparation owns these inputs: ${owner.preparation_id}`);
          if (owner.state === "ready" && await this.engine.verify(owner, owner.image!)) return this.save({ ...record, state: "ready", image: owner.image!,
            reused: true, producer_id: owner.producer_id ?? owner.preparation_id });
        }
      } else if (!["registered", "blocked"].includes(record.state)) conflict("Build ownership is missing; retain unresolved preparation");
      atomicPrivateWrite(cache, JSON.stringify({ preparation_id: record.preparation_id }));
      const ready = async (image: string) => {
        if (!/^sha256:[a-f0-9]{64}$/.test(image) || sha256(await this.engine.identity()) !== sha256(engine)
          || !await this.engine.verify(record, image)) conflict("Build result identity or engine cannot be proven");
        return this.save({ ...record, state: "ready", image, reused: false, producer_id: record.preparation_id });
      };
      const directory = join(root, "image-preparations", record.preparation_id);
      const failed = async () => await this.engine.failureConfirmed?.(record, directory) === true;
      try {
        if (!["registered", "blocked"].includes(record.state)) {
          if (await failed()) return this.save({ ...record, state: "failed" });
          const found = await this.engine.find(record);
          return found ? await ready(found) : this.save({ ...record, state: "needs-recovery" });
        }
        await this.engine.assertBase(record.base_image, record.platform);
        privateDirectory(directory);
        for (const file of material.files) {
          const path = join(directory, "context", file.path);
          atomicPrivateWrite(path, Buffer.from(file.content, "base64"));
          chmodSync(path, file.mode === "100755" ? 0o755 : 0o644);
        }
        // Publish intent before invoking the builder. A crash/lost reply never authorizes redispatch.
        record = await this.save({ ...record, state: "building" });
        if (record.state === "cancelled") return record;
        return await ready(await this.engine.build(record, material, directory));
      } catch {
        try { if (await failed()) return await this.save({ ...record, state: "failed" }); } catch { /* Missing or invalid proof keeps ownership. */ }
        return this.save({ ...record, state: ["registered", "blocked"].includes(record.state) ? "blocked" : "needs-recovery" });
      }
    });
  }
}
export async function readImagePreparation(store: Store, id: string): Promise<ImagePreparation> {
  if (!isUUIDv7(id)) throw validation("preparation_id", "requires UUIDv7");
  return store.read(async tx => {
    const record = await tx.getRuntimeRecord("runtime_operation", id);
    if (!record || record.data.format !== "grounds.repository-image-preparation/v1") throw notFound("image_preparation", id);
    return record.data as unknown as ImagePreparation;
  });
}
