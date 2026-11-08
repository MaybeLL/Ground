import { execFile } from "node:child_process";
import { mkdir, mkdtemp, lstat, realpath, readFile, rename, rm, writeFile } from "node:fs/promises";
import {dirname,join} from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { inspectionEnvironment } from "../git/inspection-environment.js";
import { atomicPrivateWrite, privateDirectory, withRuntimeLock } from "../../../runtime-files.js";
import {MaterialWorkspaces} from "../git/material-workspaces.js";
import type {MaterialRepository} from "../../domain/index.js";
import { pinnedConfig } from "./config.js";
import { dataLayout, repositoryDataRoot } from "../../../data-layout.js";
import type { ManagedWorkspacePort, RuntimeOwner } from "../../ports/index.js";

const exec = promisify(execFile);
const git = (args: string[]) => exec("git", args, { env: inspectionEnvironment(), timeout: 60_000 });
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export class ManagedWorkspaces implements ManagedWorkspacePort {
  constructor(private readonly directory = dataLayout().workspaces) {}
  root(owner: RuntimeOwner) {
    if (![owner.ledgerId, owner.sandboxId].every(id => /^[0-9a-f-]{36}$/.test(id))) throw new Error("invalid managed workspace identity");
    return join(this.directory, "sandboxes", owner.ledgerId, owner.sandboxId);
  }

  /** The launch helper can be delayed before acquiring its per-attempt
   * lock. Keep this lifetime lock outside the disposable workspace. */
  async withSetupLifetime<T>(owner:RuntimeOwner, action:()=>Promise<T>) {
    return withRuntimeLock(dataLayout().runtime, "setup-lifetime-" + owner.ledgerId + "-" + owner.sandboxId, action, 120_000);
  }

  setupRoot(owner: RuntimeOwner) {
    if (!owner.setupAttempt) return this.root(owner);
    if (!/^[a-f0-9-]{36}$/.test(owner.setupAttempt)) throw new Error("invalid setup attempt identity");
    return privateDirectory(join(this.root(owner), "setup-attempts", owner.setupAttempt));
  }

  async prepareExternal(owner:RuntimeOwner,runId:string,repository:string,commit:string|null,content:{config:string;lockfile:string|null;imageDigest:string},path:string,repositories:readonly MaterialRepository[]) {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw Error("invalid external workspace owner");
    const expected=commit===null ? join(this.directory,"working",owner.ledgerId,runId,"output") : join(repositoryDataRoot(repository),"work",runId,"worktree");
    if (path!==expected || await realpath(path)!==expected || !(await lstat(path)).isDirectory()) throw Error("external workspace binding changed");
    if (commit!==null) {
      const registered=(await git(["-C",repository,"worktree","list","--porcelain","-z"])).stdout.split("\0");
      if (!registered.includes("worktree "+expected)) throw Error("external coding workspace is not registered with this repository");
    }
    return this.prepare(owner,repository,commit,content,false,repositories,undefined,path);
  }

  async prepare(owner: RuntimeOwner, repository: string, commit: string|null, content: { config: string; lockfile: string | null; imageDigest: string }, requireExisting = false,repositories:readonly MaterialRepository[] = [],artifact?:{receipt:string;populate(directory:string):Promise<void>},externalPath?:string) {
    const configSource = pinnedConfig(content.config, content.imageDigest);
    const root = this.root(owner);
    if (commit!==null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error("managed workspace needs a full commit");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const dest = join(root, "prepared"), workspace = join(dest, "workspace");
    const selected = repositories.length ? await new MaterialWorkspaces().prepare(owner.ledgerId,owner.sandboxId,repositories) : undefined;
    const taskMaterials=selected && dirname(selected.materials[0]!.path);
    const originalDescriptor = JSON.stringify({ commit,...(artifact ? {artifactReceipt:artifact.receipt} : {}), ...(repositories.length ? {repositories} : {}), config: content.config, lockfile: content.lockfile, imageDigest: content.imageDigest });
    // Existing external sandboxes may already have a private clone with work in progress.
    let descriptor=originalDescriptor;
    if (externalPath) {
      let existing;
      try {existing=await readFile(join(dest,"source.json"),"utf8");} catch(error) {if (!absent(error)) throw error;}
      if (existing===originalDescriptor) externalPath=undefined;
      else descriptor=JSON.stringify({...JSON.parse(originalDescriptor),externalPath});
    }
    const verified = async () => {
      try { if (await readFile(join(dest, "source.json"), "utf8") !== descriptor) throw new Error("workspace preparation identity conflict"); return true; }
      catch (error) { if (absent(error)) return false; throw error; }
    };
    if (requireExisting) {
      if (!await verified() || !(await lstat(workspace)).isDirectory() || commit!==null && !(await lstat(join(workspace, ".git"))).isDirectory()) {
        throw new Error("the retained checkout is unavailable");
      }
    } else if (!await verified()) {
      const stage = await mkdtemp(join(root, "prepare-"));
      try {
        const clone = join(stage, "workspace"), config = join(stage, ".devcontainer");
        await mkdir(config);
        if (!externalPath && commit===null) {await mkdir(clone);await artifact?.populate(clone);}
        else if (!externalPath && commit!==null) {
          await git(["init", "--quiet", "--template=", "--object-format=" + (commit.length === 64 ? "sha256" : "sha1"), clone]);
          await git(["-C", clone, "-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", "--depth=1", "--", pathToFileURL(repository).href, commit]);
          await git(["-C", clone, "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", commit]);
          await git(["-C",clone,"config","user.name","Grounds Worker"]);
          await git(["-C",clone,"config","user.email","worker@grounds.invalid"]);
        }
        await writeFile(join(config, "devcontainer.json"), JSON.stringify(configSource));
        if (content.lockfile !== null) await writeFile(join(config, "devcontainer-lock.json"), content.lockfile);
        await writeFile(join(stage, "source.json"), descriptor, { mode: 0o600 });
        try { await rename(stage, dest); } catch (error) { if (!await verified()) throw error; }
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    return { path: externalPath ?? workspace,...(taskMaterials ? {taskMaterials} : {}), configPath: join(dest, ".devcontainer", "devcontainer.json"), imageDigest: content.imageDigest, containerFolder: configSource.workspaceFolder as string, frozenLockfile: content.lockfile !== null };
  }

  async receipt(owner: RuntimeOwner) {
    try { return (await readFile(join(this.setupRoot(owner), "container-id"), "utf8")).trim(); }
    catch (error) { if (absent(error)) return null; throw error; }
  }
  async record(owner: RuntimeOwner, id: string) {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid container receipt");
    const existing = await this.receipt(owner);
    if (existing !== null && existing !== id) throw new Error("sandbox completion receipt already identifies a different container");
    if (existing === null) atomicPrivateWrite(join(this.setupRoot(owner), "container-id"),id);
  }
}
