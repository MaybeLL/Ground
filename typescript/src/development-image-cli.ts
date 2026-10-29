import { dataRoot } from "./data-layout.js";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ParsedArgs } from "./cli.js";
import type { Store } from "./store-types.js";
import type { Attribution } from "./domain.js";
import { safeRead } from "./runtime-files.js";
import { validation } from "./errors.js";
import { DevelopmentRecipes } from "./development-recipes.js";
import { DevelopmentImagePreparations } from "./development-image-preparation.js";
import { DevelopmentImageBuilder } from "./development-image-buildkit.js";
const writes = ["config", "operation-id", "agent-id", "agent-name"];
export const developmentImageCommands = {
  "recipe-save": { options: [...writes, "repository", "expected-version", "directory", "file"], description: "Save RECIPE_ID --repository REPO --expected-version N --directory INPUTS --file JSON {name,dockerfile,files}; internal immutable recipe, no Git dependency" },
  "recipe-show": { options: ["config"], description: "Read internal recipe REVISION_ID including exact file bytes" },
  "recipe-prepare": { options: [...writes, "file", "data-root"], description: "Explicitly build RECIPE_REVISION with network using local BuildKit; --file JSON {build_args,target:{environment_id,expected_version,configuration:{name,postgres?}}}; register environment without promoting default; original operation only resumes" },
  "recipe-preparation-show": { options: ["config"], description: "Read PREPARATION_ID build and registration state; historical ready is not current availability" },
  "recipe-preparation-cleanup": { options: writes, description: "Remove exact terminal build inputs; retain images, logs and recipe versions; resume original cleanup operation" },
  "recipe-preparation-cancel": { options: writes, description: "Request cooperative cancellation of PREPARATION_ID; unknown builds retain ownership" },
} as const;
export async function executeDevelopmentImage(input: { action: keyof typeof developmentImageCommands; args: ParsedArgs; store: Store; cwd: string; attribution: () => Attribution; operationID: () => string }) {
  const { action, args, store, cwd } = input, id = args.positionals[2]!;
  const required = (key: string) => { const v = args.values[key]; if (typeof v !== "string" || !v) throw validation(key, "requires a value"); return v; };
  const recipes = new DevelopmentRecipes(store), preparations = new DevelopmentImagePreparations(store, new DevelopmentImageBuilder());
  const base = { result_type: "grounds.result.development-image/v1", command: `code-workspace.${action}` };
  if (action === "recipe-show") return { ...base, recipe: await recipes.show(id) };
  if (action === "recipe-preparation-show") return { ...base, preparation: await preparations.show(id) };
  const actor = { operation_id: input.operationID(), attribution: input.attribution() };
  if (action === "recipe-preparation-cleanup") return { ...base, preparation: await preparations.cleanup({ ...actor, preparation_id: id }) };
  if (action === "recipe-preparation-cancel") return { ...base, preparation: await preparations.cancel({ ...actor, preparation_id: id }) };
  let file: any;
  try { file = JSON.parse(safeRead(resolve(cwd, required("file")), 64 * 1024).toString()); }
  catch { throw validation("file", "requires bounded regular JSON input"); }
  const keys = action === "recipe-save" ? ["name", "dockerfile", "files"] : ["build_args", "target"];
  if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).some(k => !keys.includes(k))) throw validation("file", `only ${keys.join(", ")} accepted`);
  if (action === "recipe-save") {
    const version = required("expected-version"); if (!/^(0|[1-9][0-9]*)$/.test(version)) throw validation("expected-version", "requires a nonnegative integer");
    return { ...base, recipe: await recipes.save({ ...actor, recipe_id: id, repository_id: required("repository"), expected_version: Number(version), source: resolve(cwd, required("directory")), ...file }) };
  }
  const data_root = dataRoot(args.values["data-root"] !== undefined ? required("data-root") : undefined, cwd);
  return { ...base, preparation: await preparations.prepare({ ...actor, recipe_revision_id: id, data_root, build_args: file.build_args ?? {}, target: file.target }) };
}
