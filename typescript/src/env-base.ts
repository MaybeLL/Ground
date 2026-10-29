import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, readFileSync, lstatSync, copyFileSync, chmodSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { promisify } from "node:util";
import type { EnvironmentDefinition } from "./env-definition.js";
import { DomainError, validation } from "./errors.js";
import { baseDirectory, readRecord, writeRecord, environmentStoreRoot } from "./env-store.js";
import { digestBytes, privateDirectory, atomicPrivateWrite, withRuntimeLock } from "./runtime-files.js";
import { docker, probeDocker } from "./env-docker.js";
import { git } from "./env-git.js";

const execFileAsync = promisify(execFile);
export interface BaseLayer { identity: string; directory: string; cache: string; reused: boolean; image?: string }
export const baseIdentity = (definition: EnvironmentDefinition, contextDigest = ""): string => digestBytes(Buffer.from(JSON.stringify({ definition: definition.digest, backend: definition.backend, platform: process.platform, contextDigest })));
const privatePath = (path: string): boolean => path === ".git" || path.startsWith(".git/") || (path.startsWith(".grounds/") && !/^\.grounds\/environments\/[a-z][a-z0-9-]*\.yaml$/.test(path)) || /(^|\/)(\.env(?:\..*)?|\.ssh|credentials|auth\.json)(\/|$)/.test(path);
/** Build only tracked, regular declared-context files. Never send the caller's Git/config/runtime directories to Docker. */
const buildFiles = (definition: EnvironmentDefinition, workspace: string): { path: string; bytes: Buffer; mode: number }[] => {
  const recipe = definition.base.image!;
  const root = resolve(workspace, recipe.context);
  if (root !== workspace && !root.startsWith(workspace + "/")) throw validation("base.image.context", "outside repository");
  const files = git(["ls-files", "-z"], { cwd: workspace }).split("\0").filter(Boolean).filter(path => !privatePath(path));
  if (!files.includes(recipe.dockerfile)) files.push(recipe.dockerfile);
  const result: { path: string; bytes: Buffer; mode: number }[] = [];
  for (const path of files) {
    const source = resolve(workspace, path);
    if (source !== root && !source.startsWith(root + "/")) continue;
    if (!existsSync(source)) continue;
    if (!lstatSync(source).isFile()) throw validation("base.image.context", "build context supports regular files only; symlinks are not followed");
    if (lstatSync(source).size > 64 * 1024 * 1024) throw validation("base.image.context", "individual build input exceeds 64 MiB");
    result.push({ path: relative(root, source), bytes: readFileSync(source), mode: lstatSync(source).mode & 0o111 ? 0o755 : 0o644 });
  }
  return result.sort((a,b)=>a.path.localeCompare(b.path));
};
const materializeBaseUnlocked = async (definition: EnvironmentDefinition, workspace = process.cwd()): Promise<BaseLayer> => {
  if (definition.backend === "docker") probeDocker();
  const files = definition.backend === "docker" ? buildFiles(definition, workspace) : [];
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(String(file.mode)).update("\0").update(file.bytes).update("\0");
  const identity = baseIdentity(definition, hash.digest("hex"));
  const directory = baseDirectory(identity);
  const recordFile = join(directory, "base.json");
  if (existsSync(recordFile)) {
    const record = readRecord<BaseLayer>(recordFile);
    if (record.image) docker(["image", "inspect", record.image]);
    return { ...record, reused: true };
  }
  if (definition.backend === "host" && existsSync(directory)) renameSync(directory,`${directory}.failed-${randomUUID()}`);
  const partial = privateDirectory(definition.backend === "host" ? directory : `${directory}.partial-${randomUUID()}`);
  for (const name of ["cache", "home", "work"]) privateDirectory(join(partial, name));
  let image: string | undefined;
  try {
    if (definition.backend === "docker") {
      const context = privateDirectory(join(partial, "context"));
      for (const file of files) { privateDirectory(dirname(join(context, file.path))); atomicPrivateWrite(join(context, file.path), file.bytes); chmodSync(join(context,file.path),file.mode); }
      const recipe = definition.base.image!;
      const dockerfile = relative(resolve(workspace, recipe.context), resolve(workspace, recipe.dockerfile));
      if (dockerfile.startsWith("..") || !existsSync(join(context, dockerfile))) throw validation("base.image.dockerfile", "must exist inside the declared context");
      const original = readFileSync(join(context, dockerfile), "utf8");
      // Build steps are Docker RUN instructions, never host commands. No build secrets, sockets, SSH forwarding or extra contexts.
      const generated = original + "\n" + definition.base.setup.map(argv => `RUN ${JSON.stringify(argv)}`).join("\n") + "\n";
      atomicPrivateWrite(join(context, ".grounds-build.Dockerfile"), generated);
      const iid = join(partial, "image-id");
      const result = await execFileAsync("docker", ["build", "--network", definition.requirements.network === "none" ? "none" : "default", "--iidfile", iid, "-f", join(context, ".grounds-build.Dockerfile"), context], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
      atomicPrivateWrite(join(partial, "setup.log"), result.stdout + result.stderr);
      image = readFileSync(iid, "utf8").trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw validation("image", "Docker did not return a fixed image identity");
      docker(["image", "inspect", image]);
      rmSync(context, { recursive: true });
    } else {
      for (const [index, argv] of definition.base.setup.entries()) {
        try {
          const result = await execFileAsync(argv[0], argv.slice(1), { cwd: join(partial, "work"), env: { PATH: join(partial,"cache/bin")+":"+(process.env.PATH??"/usr/bin:/bin"), HOME: join(partial, "home"), TMPDIR: join(partial, "home"), GROUNDS_BASE_CACHE: join(partial, "cache") }, timeout: 600_000, maxBuffer: 1024 * 1024 });
          atomicPrivateWrite(join(partial, `setup-${index}.log`), result.stdout + result.stderr);
        } catch (error) { throw new DomainError("ENVIRONMENT_SETUP_FAILED", "trusted host setup failed; external effects are not rolled back", false, { step_index: index }); }
      }
    }
    const layer: BaseLayer = { identity, directory, cache: join(directory, "cache"), reused: false, ...(image ? { image } : {}) };
    writeRecord(join(partial, "base.json"), layer);
    if (partial !== directory) renameSync(partial, directory);
    return layer;
  } catch (error) {
    writeRecord(join(partial, "failure.json"), { state: "failed", diagnostic: String((error as {stderr?:unknown}).stderr ?? (error instanceof Error ? error.message : error)).slice(0,4096), created_at: new Date().toISOString() });
    const diagnostic = partial === directory ? `${directory}.failed-${randomUUID()}` : partial;
    if (diagnostic !== partial) renameSync(partial,diagnostic);
    throw new DomainError("ENVIRONMENT_SETUP_FAILED", "preparation failed; diagnostic retained and no reusable base registered", false, { diagnostic_directory: diagnostic });
  }
};

export const materializeBase = (definition: EnvironmentDefinition, workspace = process.cwd()): Promise<BaseLayer> => withRuntimeLock(environmentStoreRoot(), `base:${definition.digest}:${definition.backend === "host" ? "host" : workspace}`, ()=>materializeBaseUnlocked(definition,workspace),600_000);
