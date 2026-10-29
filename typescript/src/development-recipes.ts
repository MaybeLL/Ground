import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Store } from "./store-types.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { newUUIDv7, isUUIDv7 } from "./identity.js";
import { sha256 } from "./canonical-json.js";
import { safeRead, digestBytes } from "./runtime-files.js";
import { DomainError, validation, notFound } from "./errors.js";

export interface RecipeFile { path: string; mode: "100644" | "100755"; digest: string; content: string }
export interface DevelopmentRecipe {
  format: "grounds.development-recipe/v1"; recipe_id: string; revision_id: string; repository_id: string;
  version: number; name: string; dockerfile: string; files: RecipeFile[]; digest: string; request_digest: string;
  attribution: Attribution; created_at: string;
}
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
export function recipePath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 240 && /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(path)
    && path.split("/").every(p => !!p && !p.startsWith(".") && !/^(credentials|auth\.json)$/i.test(p));
}
const materialDigest = (recipe: Pick<DevelopmentRecipe, "dockerfile" | "files">) => sha256({ dockerfile: recipe.dockerfile,
  files: recipe.files.map(({ path, mode, digest }) => ({ path, mode, digest })) });
export class DevelopmentRecipes {
  constructor(private readonly store: Store) {}
  async show(id: string): Promise<DevelopmentRecipe> {
    if (!isUUIDv7(id)) throw validation("revision_id", "requires UUIDv7");
    const row = await this.store.read(tx => tx.getRuntimeRecord("runtime_operation", id));
    if (!row || row.data.format !== "grounds.development-recipe/v1") throw notFound("development_recipe", id);
    const recipe = row.data as unknown as DevelopmentRecipe;
    if (recipe.digest !== materialDigest(recipe) || recipe.files.some(f => !recipePath(f.path)
      || digestBytes(Buffer.from(f.content, "base64")) !== f.digest)) conflict("Recipe bytes failed integrity validation");
    return recipe;
  }
  async save(input: { operation_id: string; recipe_id: string; repository_id: string; expected_version: number;
    source: string; name: string; dockerfile: string; files: string[]; attribution: Attribution }): Promise<DevelopmentRecipe> {
    const request = structuredClone(input); request.source = resolve(request.source);
    if (![request.operation_id, request.recipe_id, request.repository_id].every(isUUIDv7)
      || !Number.isSafeInteger(request.expected_version) || request.expected_version < 0) throw validation("identity", "requires UUIDv7 identities and nonnegative expected_version");
    validateAttribution(request.attribution);
    if (typeof request.name !== "string" || !request.name.trim() || request.name.length > 128 || /[\x00-\x1f]/.test(request.name)) throw validation("name", "requires a bounded name");
    if (!recipePath(request.dockerfile) || !Array.isArray(request.files) || !request.files.length || request.files.length > 128
      || request.files.some(p => !recipePath(p)) || new Set(request.files).size !== request.files.length || !request.files.includes(request.dockerfile))
      throw validation("files", "requires up to 128 unique safe file paths including Dockerfile");
    const request_hash = sha256(request);
    const prior = await this.store.read(tx => tx.getOperation(request.operation_id));
    if (prior) {
      if (prior.command !== "code-workspace.recipe-save" || prior.request_hash !== request_hash) conflict("Recipe operation reused with different inputs");
      return JSON.parse(prior.result_json) as DevelopmentRecipe;
    }
    const source = realpathSync(request.source); let total = 0;
    const files = [...request.files].sort().map(path => {
      let cursor = source;
      for (const part of path.split("/")) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) throw validation("files", "links are not allowed"); }
      const stat = lstatSync(cursor);
      if (!stat.isFile() || stat.nlink !== 1 || (total += stat.size) > 4 * 1024 * 1024) throw validation("files", "requires regular single-link files within 4 MiB");
      const bytes = safeRead(cursor, 4 * 1024 * 1024);
      if (bytes.length !== stat.size) conflict("Source changed while saving recipe; retry with stable files");
      return { path, mode: stat.mode & 0o111 ? "100755" as const : "100644" as const, digest: digestBytes(bytes), content: bytes.toString("base64") };
    });
    const dockerfile = Buffer.from(files.find(f => f.path === request.dockerfile)!.content, "base64");
    if (dockerfile.length > 32 * 1024 || !dockerfile.length || dockerfile.includes(0) || !Buffer.from(dockerfile.toString("utf8")).equals(dockerfile)) throw validation("dockerfile", "requires up to 32 KiB UTF-8 Dockerfile");
    return this.store.write(async tx => {
      const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.recipe-save", request_hash });
      if (replay) return JSON.parse(replay.result_json) as DevelopmentRecipe;
      await tx.getRepository(request.repository_id);
      const head = await tx.getRuntimeRecord("runtime_operation", request.recipe_id);
      if (head && (head.data.format !== "grounds.development-recipe-head/v1" || head.data.repository_id !== request.repository_id)) conflict("Recipe belongs to another repository or record type");
      if (head) await tx.lockRuntimeRecord("runtime_operation", request.recipe_id);
      const result: DevelopmentRecipe = { format: "grounds.development-recipe/v1", recipe_id: request.recipe_id,
        revision_id: newUUIDv7(), repository_id: request.repository_id, version: request.expected_version + 1,
        name: request.name, dockerfile: request.dockerfile, files, digest: materialDigest({ dockerfile: request.dockerfile, files }), request_digest: request_hash,
        attribution: request.attribution, created_at: await tx.now() };
      await tx.saveRuntimeRecord({ id: result.revision_id, parent_id: result.recipe_id, kind: "runtime_operation", version: 1, data: { ...result } }, 0);
      await tx.saveRuntimeRecord({ id: result.recipe_id, kind: "runtime_operation", version: result.version,
        data: { format: "grounds.development-recipe-head/v1", repository_id: result.repository_id, revision_id: result.revision_id } }, request.expected_version);
      await tx.completeOperation(request.operation_id, JSON.stringify(result)); return result;
    });
  }
}
