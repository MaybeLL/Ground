import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DomainError, validation } from "./errors.js";
import { safeYAMLToJS } from "./yaml-safe.js";

export const ENVIRONMENT_DEFINITION_DIRECTORY = ".grounds/environments";
export const ENVIRONMENT_DEFINITION_FORMAT = "grounds.environment-definition/v1";
const MAX_DEFINITION_BYTES = 64 * 1024;
const FILE_PATTERN = /^([a-z][a-z0-9-]{0,62})\.yaml$/;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const MEMORY_PATTERN = /^[1-9][0-9]{0,4}[mg]$/;
const TOP_LEVEL_KEYS = ["format", "name", "backend", "purpose", "repositories", "requirements", "base", "services", "credentials", "tools", "artifacts"];

export type EnvironmentBackendKind = "host" | "docker";

export interface EnvironmentRepository {
  name: string;
  path: string;
}

export interface EnvironmentRequirements {
  workspace_write?: "confined";
  network?: "none" | "allowed";
  cpu?: number;
  memory?: string;
  pids?: number;
}

export interface EnvironmentImageRecipe {
  dockerfile: string;
  context: string;
}

export interface EnvironmentBaseRecipe {
  image?: EnvironmentImageRecipe;
  setup: string[][];
}

export interface EnvironmentServiceDeclaration {
  name: string;
  kind: "mysql" | "postgres";
  shared?: string;
  image?: string;
}

export interface EnvironmentCredentialDeclaration {
  name: string;
  path?: string;
}

export interface EnvironmentDefinitionContent {
  format: typeof ENVIRONMENT_DEFINITION_FORMAT;
  name: string;
  backend: EnvironmentBackendKind;
  purpose?: string;
  repositories: EnvironmentRepository[];
  requirements: EnvironmentRequirements;
  base: EnvironmentBaseRecipe;
  services: EnvironmentServiceDeclaration[];
  credentials: EnvironmentCredentialDeclaration[];
  tools?: string[];
  artifacts?: string[];
}

export interface EnvironmentDefinition extends EnvironmentDefinitionContent {
  digest: string;
  implicit?: true;
}

export interface EnvironmentDefinitionIssue {
  file: string;
  path: string;
  message: string;
}

export interface EnvironmentDefinitionCatalog {
  definitions: EnvironmentDefinition[];
  issues: EnvironmentDefinitionIssue[];
}

type Issues = { path: string; message: string }[];

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const at = (path: string, key: string): string => (path ? `${path}.${key}` : key);

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
};

const digestOf = (content: EnvironmentDefinitionContent): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(sortKeys(content))).digest("hex")}`;

const withDigest = (content: EnvironmentDefinitionContent, implicit = false): EnvironmentDefinition => ({
  ...content,
  digest: digestOf(content),
  ...(implicit ? { implicit: true as const } : {}),
});

/** Attaches the content digest to a definition built in code, for example when a caller supplies its own content. */
export const environmentDefinitionOf = (content: EnvironmentDefinitionContent): EnvironmentDefinition => {
  const issues: Issues = [];
  const { digest: _digest, implicit: _implicit, ...raw } = content as EnvironmentDefinition;
  const normalized = normalizeDefinition(raw, content.name, issues);
  if (!normalized || issues.length) throw validation("definition", JSON.stringify(issues));
  return withDigest(normalized);
};

const readObject = (value: unknown, path: string, allowed: readonly string[], issues: Issues): Record<string, unknown> => {
  if (!plainObject(value)) {
    issues.push({ path, message: "must be a mapping" });
    return {};
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push({ path: at(path, key), message: "unknown field" });
  return value;
};

const readText = (
  value: unknown,
  path: string,
  pattern: RegExp,
  issues: Issues,
  options: { required?: boolean; max?: number } = {},
): string | undefined => {
  if (value === undefined) {
    if (options.required) issues.push({ path, message: "is required" });
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > (options.max ?? 64) || !pattern.test(value)) {
    issues.push({ path, message: "is not valid" });
    return undefined;
  }
  return value;
};

const readEnum = <T extends string>(value: unknown, path: string, allowed: readonly T[], issues: Issues, required = false): T | undefined => {
  if (value === undefined) {
    if (required) issues.push({ path, message: "is required" });
    return undefined;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.push({ path, message: `must be one of ${allowed.join(", ")}` });
    return undefined;
  }
  return value as T;
};

const readInteger = (value: unknown, path: string, min: number, max: number, issues: Issues): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issues.push({ path, message: `must be an integer from ${min} to ${max}` });
    return undefined;
  }
  return value as number;
};

const relativePath = (value: unknown, path: string, issues: Issues): string | undefined => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.startsWith("/")) {
    issues.push({ path, message: "must be a relative path inside the repository" });
    return undefined;
  }
  if (value === ".") return value;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    issues.push({ path, message: "must be a relative path inside the repository" });
    return undefined;
  }
  return value;
};

const readList = <T>(value: unknown, path: string, max: number, issues: Issues, read: (item: unknown, itemPath: string) => T | undefined): T[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    issues.push({ path, message: `must be a list of at most ${max} items` });
    return [];
  }
  return value.flatMap((item, index) => {
    const parsed = read(item, `${path}[${index}]`);
    return parsed === undefined ? [] : [parsed];
  });
};

const uniqueNames = <T extends { name: string }>(items: T[], path: string, issues: Issues): T[] => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.name)) issues.push({ path: `${path}[${index}].name`, message: "must be unique" });
    seen.add(item.name);
  }
  return items;
};

const parseRepositories = (value: unknown, issues: Issues): EnvironmentRepository[] => {
  if (value === undefined) return [{ name: "workspace", path: "." }];
  const repositories = readList(value, "repositories", 1, issues, (item, path) => {
    const fields = readObject(item, path, ["name", "path"], issues);
    const name = readText(fields.name, at(path, "name"), NAME_PATTERN, issues, { required: true });
    const repositoryPath = relativePath(fields.path ?? ".", at(path, "path"), issues);
    return name === undefined || repositoryPath === undefined ? undefined : { name, path: repositoryPath };
  });
  if (repositories.length !== 1 || repositories[0]?.path !== ".") issues.push({ path: "repositories", message: "exactly one task repository at path . is supported" });
  return uniqueNames(repositories, "repositories", issues);
};

const parseRequirements = (value: unknown, issues: Issues): EnvironmentRequirements => {
  if (value === undefined) return {};
  const fields = readObject(value, "requirements", ["workspace_write", "network", "cpu", "memory", "pids"], issues);
  const requirements: EnvironmentRequirements = {};
  const writes = readEnum(fields.workspace_write, "requirements.workspace_write", ["confined"], issues);
  const network = readEnum(fields.network, "requirements.network", ["none", "allowed"], issues);
  const cpu = readInteger(fields.cpu, "requirements.cpu", 1, 256, issues);
  const memory = readText(fields.memory, "requirements.memory", MEMORY_PATTERN, issues, { max: 6 });
  const pids = readInteger(fields.pids, "requirements.pids", 16, 65536, issues);
  if (writes !== undefined) requirements.workspace_write = writes;
  if (network !== undefined) requirements.network = network;
  if (cpu !== undefined) requirements.cpu = cpu;
  if (memory !== undefined) requirements.memory = memory;
  if (pids !== undefined) requirements.pids = pids;
  return requirements;
};

const parseSetup = (value: unknown, issues: Issues): string[][] =>
  readList(value, "base.setup", 32, issues, (item, path) => {
    if (!Array.isArray(item) || item.length === 0 || item.length > 64 || item.some((part) => typeof part !== "string" || part.length === 0 || part.length > 4096 || part.includes("\0"))) {
      issues.push({ path, message: "must be a non-empty argument list of strings" });
      return undefined;
    }
    return [...item] as string[];
  });

const parseBase = (value: unknown, backend: EnvironmentBackendKind | undefined, issues: Issues): EnvironmentBaseRecipe => {
  const fields = readObject(value ?? {}, "base", ["image", "setup"], issues);
  let image: EnvironmentImageRecipe | undefined;
  if (fields.image !== undefined) {
    const recipe = readObject(fields.image, "base.image", ["dockerfile", "context"], issues);
    const dockerfile = relativePath(recipe.dockerfile, "base.image.dockerfile", issues);
    const context = relativePath(recipe.context ?? ".", "base.image.context", issues);
    if (dockerfile !== undefined && context !== undefined) image = { dockerfile, context };
  }
  if (backend === "docker" && image === undefined && !issues.some((issue) => issue.path === "base.image")) issues.push({ path: "base.image", message: "is required for the docker backend" });
  if (backend === "host" && fields.image !== undefined) issues.push({ path: "base.image", message: "is not allowed for the host backend" });
  return { ...(image ? { image } : {}), setup: parseSetup(fields.setup, issues) };
};

const parseServices = (value: unknown, issues: Issues): EnvironmentServiceDeclaration[] => {
  const services = readList(value, "services", 16, issues, (item, path) => {
    const fields = readObject(item, path, ["name", "kind", "shared", "image"], issues);
    const name = readText(fields.name, at(path, "name"), NAME_PATTERN, issues, { required: true });
    const kind = readEnum(fields.kind, at(path, "kind"), ["mysql", "postgres"], issues, true);
    const shared = readText(fields.shared, at(path, "shared"), NAME_PATTERN, issues);
    const image = readText(fields.image, at(path, "image"), /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/, issues, { max: 256 });
    return name === undefined || kind === undefined ? undefined : { name, kind, ...(shared ? { shared } : {}), ...(image ? { image } : {}) };
  });
  return uniqueNames(services, "services", issues);
};

const parseCredentials = (value: unknown, issues: Issues): EnvironmentCredentialDeclaration[] => {
  const credentials = readList(value, "credentials", 32, issues, (item, path) => {
    const fields = readObject(item, path, ["name", "path"], issues);
    const name = readText(fields.name, at(path, "name"), NAME_PATTERN, issues, { required: true });
    const target = fields.path === undefined ? undefined : relativePath(fields.path, at(path, "path"), issues);
    return name === undefined ? undefined : { name, ...(target ? { path: target } : {}) };
  });
  return uniqueNames(credentials, "credentials", issues);
};

const normalizeDefinition = (raw: unknown, stem: string, issues: Issues): EnvironmentDefinitionContent | undefined => {
  const root = readObject(raw, "", TOP_LEVEL_KEYS, issues);
  if (root.format !== ENVIRONMENT_DEFINITION_FORMAT) issues.push({ path: "format", message: `must be ${ENVIRONMENT_DEFINITION_FORMAT}` });
  const name = readText(root.name, "name", NAME_PATTERN, issues, { required: true });
  if (name !== undefined && name !== stem) issues.push({ path: "name", message: "must equal the file name" });
  const backend = readEnum<EnvironmentBackendKind>(root.backend, "backend", ["host", "docker"], issues, true);
  const purpose = readText(root.purpose, "purpose", /^.+$/, issues, { max: 200 });
  const repositories = parseRepositories(root.repositories, issues);
  const requirements = parseRequirements(root.requirements, issues);
  const base = parseBase(root.base, backend, issues);
  const services = parseServices(root.services, issues);
  const credentials = parseCredentials(root.credentials, issues);
  if (name === undefined || backend === undefined) return undefined;
  return {
    format: ENVIRONMENT_DEFINITION_FORMAT,
    name,
    backend,
    ...(purpose !== undefined ? { purpose } : {}),
    repositories,
    requirements,
    base,
    services,
    credentials,
    tools: readList(root.tools, "tools", 32, issues, (item, path) => readText(item, path, /^[a-zA-Z0-9._+-]+$/, issues)),
    artifacts: readList(root.artifacts, "artifacts", 32, issues, (item, path) => relativePath(item, path, issues)),
  };
};

const reasonOf = (error: unknown): string => {
  if (error instanceof DomainError && typeof error.details.reason === "string") return error.details.reason;
  return error instanceof Error ? error.message : String(error);
};

const readDefinitionFile = (file: string, stem: string, issues: Issues): EnvironmentDefinition | undefined => {
  if (statSync(file).size > MAX_DEFINITION_BYTES) {
    issues.push({ path: "", message: "must not exceed 64 KiB" });
    return undefined;
  }
  let raw: unknown;
  try {
    raw = safeYAMLToJS(readFileSync(file), "definition");
  } catch (error) {
    issues.push({ path: "", message: reasonOf(error) });
    return undefined;
  }
  const content = normalizeDefinition(raw, stem, issues);
  return content !== undefined && issues.length === 0 ? withDigest(content) : undefined;
};

/** Reads `.grounds/environments/*.yaml`; every rejected file is reported with its file name and field path. */
export const readEnvironmentDefinitions = (repositoryRoot: string): EnvironmentDefinitionCatalog => {
  const directory = join(repositoryRoot, ENVIRONMENT_DEFINITION_DIRECTORY);
  if (!existsSync(directory)) return { definitions: [], issues: [] };
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  const definitions: EnvironmentDefinition[] = [];
  const issues: EnvironmentDefinitionCatalog["issues"] = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile()) {
      issues.push({ file: entry.name, path: "", message: "file names must be lowercase kebab-case with a .yaml extension" });
      continue;
    }
    const fileIssues: Issues = [];
    const definition = readDefinitionFile(join(directory, entry.name), match[1], fileIssues);
    issues.push(...fileIssues.map((issue) => ({ file: entry.name, ...issue })));
    if (definition !== undefined && fileIssues.length === 0) definitions.push(definition);
  }
  return { definitions, issues };
};

/** The default host definition used when a repository declares no environment. It is trusted local execution with no forced isolation. */
export const implicitHostDefinition = (): EnvironmentDefinition =>
  withDigest({
    format: ENVIRONMENT_DEFINITION_FORMAT,
    name: "host-default",
    backend: "host",
    repositories: [{ name: "workspace", path: "." }],
    requirements: {},
    base: { setup: [] },
    services: [],
    credentials: [],
    tools: [],
    artifacts: [],
  }, true);

/** Selects one definition. Invalid files block selection, and several definitions require an explicit name. */
export const selectEnvironmentDefinition = (catalog: EnvironmentDefinitionCatalog, name?: string): EnvironmentDefinition => {
  if (catalog.issues.length > 0) {
    const files = [...new Set(catalog.issues.map((issue) => issue.file))];
    throw validation("definition", `environment definitions contain invalid files: ${files.join(", ")}`);
  }
  if (name !== undefined) {
    const selected = catalog.definitions.find((definition) => definition.name === name);
    if (selected === undefined) throw validation("definition", `no environment definition named ${name}`);
    return selected;
  }
  if (catalog.definitions.length === 0) return implicitHostDefinition();
  if (catalog.definitions.length === 1) return catalog.definitions[0];
  throw validation("definition", "several environment definitions exist; select one by name");
};
