import { dataRoot } from "./data-layout.js";
import { developmentImageCommands, executeDevelopmentImage } from "./development-image-cli.js";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { ParsedArgs } from "./cli.js";
import type { Attribution } from "./domain.js";
import type { Store } from "./store-types.js";
import { validation } from "./errors.js";
import { safeRead } from "./runtime-files.js";
import { RepositoryBuildMaterials } from "./repository-build-materials.js";
import { RepositoryImagePreparations } from "./repository-image-preparation.js";
import { DockerImageBuildEngine } from "./repository-image-docker.js";

export const repositoryImageCommands = {
  ...developmentImageCommands,
  "build-material-capture": { options: ["config", "directory", "file", "operation-id", "agent-id", "agent-name"],
    description: "Capture REPO committed build files from --directory CLONE --file JSON {commit,dockerfile,files}; up to 4 MiB, no uncommitted files; fixed recipe starts FROM grounds-base" },
  "build-material-show": { options: ["config"], description: "Read MATERIAL_ID immutable snapshot including base64 file bytes; does not read a mutable worktree" },
  "image-prepare": { options: ["config", "base-image", "data-root", "operation-id", "agent-id", "agent-name"],
    description: "Prepare MATERIAL_ID --base-image sha256:ID from local images with offline Docker classic builder; same operation resumes unknown replies without rebuilding; does not set Repo default" },
  "image-cancel": { options: ["config", "operation-id", "agent-id", "agent-name"],
    description: "Request cooperative cancellation of PREPARATION_ID; in-flight or unknown builds retain ownership until a terminal result is proven; no forced disconnect" },
  "image-cleanup": { options: ["config", "operation-id", "agent-id", "agent-name"],
    description: "Remove exact reproducible local inputs of terminal PREPARATION_ID; retain images, logs, proof and SQL materials; resume incomplete cleanup with the original operation ID" },
  "image-show": { options: ["config"], description: "Read PREPARATION_ID historical result and original engine; ready does not prove present image availability" },
} as const;
export async function executeRepositoryImage(input: { action: keyof typeof repositoryImageCommands; args: ParsedArgs; store: Store;
  cwd: string; attribution: () => Attribution; operationID: () => string }) {
  if (Object.hasOwn(developmentImageCommands, input.action)) return executeDevelopmentImage({ ...input, action: input.action as keyof typeof developmentImageCommands });
  const { args, action, store } = input, id = args.positionals[2]!;
  const required = (key: string) => {
    const value = args.values[key];
    if (typeof value !== "string" || !value) throw validation(key, "requires a value");
    return value;
  };
  const base = { result_type: "grounds.result.repository-image/v1", command: `code-workspace.${action}` };
  const materials = new RepositoryBuildMaterials(store), preparations = new RepositoryImagePreparations(store, new DockerImageBuildEngine());
  if (action === "build-material-show") return { ...base, material: await materials.show(id) };
  if (action === "image-show") return { ...base, preparation: await preparations.show(id) };
  const operation_id = input.operationID(), attribution = input.attribution();
  if (action === "image-cancel") return { ...base, preparation: await preparations.cancel({ operation_id, attribution, preparation_id: id }) };
  if (action === "image-cleanup") return { ...base, preparation: await preparations.cleanup({ operation_id, attribution, preparation_id: id }) };
  if (action === "image-prepare") return { ...base, preparation: await preparations.prepare({ operation_id, attribution,
    material_id: id, base_image: required("base-image"), data_root: dataRoot(args.values["data-root"] !== undefined ? required("data-root") : undefined, input.cwd) }) };
  let file;
  try { file = JSON.parse(safeRead(resolve(input.cwd, required("file")), 1024 * 1024).toString()); }
  catch { throw validation("file", "requires a bounded regular JSON material request"); }
  if (!file || Array.isArray(file) || typeof file !== "object" || Object.keys(file).some(key => !["commit", "dockerfile", "files"].includes(key)))
    throw validation("file", "only commit, dockerfile and files are accepted");
  return { ...base, material: await materials.capture({ operation_id, attribution, repository_id: id,
    source: resolve(input.cwd, required("directory")), commit: file.commit, dockerfile: file.dockerfile, files: file.files }) };
}
