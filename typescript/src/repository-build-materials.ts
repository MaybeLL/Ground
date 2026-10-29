import { resolve } from "node:path";
import { sha256 } from "./canonical-json.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { DomainError, notFound, validation } from "./errors.js";
import { isGitOID, isUUIDv7 } from "./identity.js";
import { discoverRepository, matchingRemoteNames } from "./git.js";
import { historyBytes, historyGit, withHistoryRead, assertHistoryRepository } from "./git-history-read.js";
import { digestBytes } from "./runtime-files.js";
import type { Store } from "./store-types.js";

export interface BuildMaterialFile { path: string; mode: "100644" | "100755"; blob: string; digest: string; content: string }
export interface RepositoryBuildMaterial {
  format: "grounds.repository-build-material/v1";
  material_id: string; repository_id: string; commit: string; dockerfile: string;
  files: BuildMaterialFile[]; digest: string; request_digest: string; attribution: Attribution; created_at: string;
}
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
function pathAllowed(path: string): boolean {
  return typeof path === "string" && path.length <= 240 && /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(path)
    && path.split("/").every(part => !!part && !part.startsWith(".") && !/^(credentials|auth\.json)$/i.test(part));
}
/** Deliberately bounded first recipe profile: one local base and no external build inputs. */
export function buildRecipe(material: RepositoryBuildMaterial, base = "grounds-base"): string {
  const file = material.files.find(file => file.path === material.dockerfile);
  if (!file) throw validation("dockerfile", "must be selected in the material files");
  const bytes = Buffer.from(file.content, "base64"), text = bytes.toString("utf8");
  if (bytes.length > 32 * 1024 || !Buffer.from(text).equals(bytes) || /[\r\0]/.test(text)) throw validation("dockerfile", "requires bounded UTF-8 recipe");
  let instructions = 0;
  const lines = text.split("\n").map(line => {
    const value = line.trim();
    if (!value) return line;
    if (value.startsWith("#")) {
      if (/^#\s*(syntax|escape|check)\s*=/i.test(value)) throw validation("dockerfile", "parser directives are unsupported");
      return line;
    }
    if (value.endsWith("\\")) throw validation("dockerfile", "multiline instructions are not supported by this recipe profile");
    if (instructions++ === 0) {
      if (!/^FROM\s+grounds-base$/i.test(value)) throw validation("dockerfile", "first instruction must be FROM grounds-base");
      return `FROM ${base}`;
    }
    if (!/^(RUN|COPY|ENV|WORKDIR|USER|LABEL|CMD|ENTRYPOINT|SHELL)\s+[^\s]/i.test(value)
      || /^(RUN|COPY)\s+--/i.test(value)) throw validation("dockerfile", "unsupported instruction or external input; one local base, no ADD, stages or instruction flags");
    return line;
  });
  if (!instructions) throw validation("dockerfile", "requires FROM grounds-base");
  return lines.join("\n");
}
export class RepositoryBuildMaterials {
  constructor(private readonly store: Store) {}
  async show(id: string): Promise<RepositoryBuildMaterial> {
    if (!isUUIDv7(id)) throw validation("material_id", "requires UUIDv7");
    return this.store.read(async tx => {
      const row = await tx.getRuntimeRecord("runtime_operation", id);
      if (!row || row.data.format !== "grounds.repository-build-material/v1") throw notFound("build_material", id);
      const material = row.data as unknown as RepositoryBuildMaterial;
      if (sha256({ dockerfile: material.dockerfile, files: material.files.map(({ path, mode, digest }) => ({ path, mode, digest })) }) !== material.digest
        || material.files.some(file => !pathAllowed(file.path) || digestBytes(Buffer.from(file.content, "base64")) !== file.digest))
        conflict("Saved build material failed integrity validation");
      buildRecipe(material);
      return material;
    });
  }
  async capture(input: { operation_id: string; repository_id: string; source: string; commit: string; dockerfile: string;
    files: string[]; attribution: Attribution }): Promise<RepositoryBuildMaterial> {
    const request = structuredClone(input);
    if (!isUUIDv7(request.operation_id) || !isUUIDv7(request.repository_id) || !isGitOID(request.commit))
      throw validation("material", "requires UUIDv7 identities and a full algorithm-prefixed commit");
    if (!pathAllowed(request.dockerfile) || !Array.isArray(request.files) || !request.files.length || request.files.length > 128
      || request.files.some(file => !pathAllowed(file)) || new Set(request.files).size !== request.files.length
      || !request.files.includes(request.dockerfile)) throw validation("files", "requires up to 128 unique regular paths including Dockerfile; no private paths");
    validateAttribution(request.attribution);
    const digest = sha256(request);
    const prior = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", request.operation_id));
    if (prior) {
      if (prior.data.format !== "grounds.repository-build-material/v1" || prior.data.request_digest !== digest) conflict("Material request ID reused with different inputs");
      return this.show(request.operation_id);
    }
    const source = resolve(request.source), oid = request.commit.split(":")[1]!;
    const remotes = await this.store.read(async tx => { await tx.getRepository(request.repository_id); return (await tx.listRepositoryRemotes(request.repository_id)).map(remote => remote.remote); });
    const files = await withHistoryRead(async () => {
      if (!matchingRemoteNames(discoverRepository(source), remotes).length) conflict("Build material source belongs to another repository");
      assertHistoryRepository(source);
      if (`${historyGit(source, ["rev-parse", "--show-object-format"])}:${historyGit(source, ["rev-parse", `${oid}^{commit}`])}` !== request.commit)
        conflict("Material requires the exact commit object, not a tag or branch");
      let total = 0;
      return [...request.files].sort().map(path => {
        const entry = historyGit(source, ["ls-tree", "-z", oid, "--", path]);
        const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(entry);
        if (!match || match[3] !== path) throw validation("files", "selected file must be a regular tracked blob at the fixed commit");
        const size = Number(historyGit(source, ["cat-file", "-s", match[2]!]));
        total += size;
        if (!Number.isSafeInteger(size) || size < 0 || total > 4 * 1024 * 1024) throw validation("files", "selected build material exceeds 4 MiB");
        const bytes = historyBytes(source, ["cat-file", "blob", match[2]!]);
        return { path, mode: match[1] as BuildMaterialFile["mode"], blob: `${request.commit.split(":")[0]}:${match[2]}`,
          digest: digestBytes(bytes), content: bytes.toString("base64") };
      });
    });
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.build-material-capture", request_hash: digest });
      if (replay) return JSON.parse(replay.result_json) as RepositoryBuildMaterial;
      const result: RepositoryBuildMaterial = { format: "grounds.repository-build-material/v1", material_id: request.operation_id,
        repository_id: request.repository_id, commit: request.commit, dockerfile: request.dockerfile, files,
        digest: sha256({ dockerfile: request.dockerfile, files: files.map(({ path, mode, digest }) => ({ path, mode, digest })) }),
        request_digest: digest, attribution: request.attribution, created_at: await tx.now() };
      buildRecipe(result);
      await tx.saveRuntimeRecord({ id: result.material_id, kind: "runtime_operation", parent_id: result.repository_id, version: 1, data: { ...result } }, 0);
      await tx.completeOperation(request.operation_id, JSON.stringify(result));
      return result;
    });
  }
}
