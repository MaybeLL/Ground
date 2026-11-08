import { parse, type ParseError } from "jsonc-parser";

/** The operator's source remains immutable in the ledger. Launch a pinned
 * image and an explicit private mount so mutable tags and repository config
 * cannot change the effective workspace during devcontainer startup. */
export function pinnedConfig(source: string, digest: string) {
  const errors: ParseError[] = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config) || typeof config.image !== "string") throw new Error("this environment needs a self-contained image-based devcontainer configuration");
  if (config.build || config.dockerFile || config.dockerComposeFile || Object.keys(config.features ?? {}).length) throw new Error("build the environment image before publishing its digest");
  const [image, embedded] = config.image.split("@");
  if (embedded && embedded !== digest) throw new Error("configured image does not match the published digest");
  if (!/^[a-z0-9][a-z0-9.\-/:_]*$/i.test(image) || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("invalid image reference");
  const slash = image.lastIndexOf("/"), colon = image.lastIndexOf(":");
  const repository = colon > slash ? image.slice(0, colon) : image;
  const folder = config.workspaceFolder ?? "/workspaces/grounds";
  if (typeof folder !== "string" || !/^\/(?:[\w.-]+\/?)+$/.test(folder) || folder.split("/").some(part => part === ".." || part === ".")) throw new Error("invalid container workspace folder");
  const mount = "source=${localWorkspaceFolder},target=" + folder + ",type=bind";
  if ((config.workspaceMount && config.workspaceMount !== mount) || config.mounts?.length || config.privileged ||
      config.runArgs?.some((arg: string) => /^(?:-v|--(?:mount|volume|volumes-from|privileged)(?:=|$))/.test(arg))) throw new Error("the environment overrides the isolated workspace mount");
  return { ...config, image: repository + "@" + digest, workspaceFolder: folder, workspaceMount: mount };
}
