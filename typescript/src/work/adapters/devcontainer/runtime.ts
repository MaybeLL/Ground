import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { hostIdentity, withRuntimeLock } from "../../../runtime-files.js";
import { dataLayout } from "../../../data-layout.js";
import { join, dirname } from "node:path";
import { checkIsolation, pinnedConfig } from "./config.js";
import { mkdir, readFile, writeFile, copyFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { RuntimeOwner, RuntimeState, RuntimeWorkspace, SandboxRuntimePort } from "../../ports/index.js";

const exec = promisify(execFile);
const ledgerLabel = "dev.grounds.ledger";
const sandboxLabel = "dev.grounds.sandbox";
const opts = { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" as const };
const containerId = /^[a-f0-9]{64}$/;

/** devcontainers CLI interprets the pinned environment configuration. Docker
 * observes exact ownership and performs lifecycle operations on one container. */
export class DevcontainerRuntime implements SandboxRuntimePort {
  constructor(private readonly devcontainer = createRequire(import.meta.url).resolve("@devcontainers/cli/devcontainer.js"), private readonly docker = "docker", private readonly launchLockFd?: number) {}

  private selectedEnvironment?: Promise<NodeJS.ProcessEnv>;

  private environment(): Promise<NodeJS.ProcessEnv> {
    if (!this.selectedEnvironment) {
      const env = { ...process.env };
      this.selectedEnvironment = env.DOCKER_CONTEXT || env.DOCKER_HOST ? Promise.resolve(env) :
        exec(this.docker, ["context","show"], { ...opts, env }).then(({stdout}) => {
          const context = stdout.trim();
          if (!context) throw new Error("Docker did not identify its context");
          return { ...env, DOCKER_CONTEXT: context };
        }).catch(error => { this.selectedEnvironment = undefined; throw error; });
    }
    return this.selectedEnvironment;
  }

  private async invoke(binary: string, argv: string[], options = opts) {
    return exec(binary,argv,{...options,env:await this.environment()});
  }

  async location() {
    const daemonId = (await this.invoke(this.docker, ["info", "--format", "{{.ID}}"], opts)).stdout.trim();
    if (!daemonId) throw new Error("Docker did not identify its daemon");
    return { daemonId, hostId: hostIdentity(dataLayout().runtime) };
  }
  exclusive<T>(owner: RuntimeOwner, action: () => Promise<T>) {
    return withRuntimeLock(dataLayout().runtime, "devcontainer:" + owner.ledgerId + ":" + owner.sandboxId, action, opts.timeout);
  }

  async observe(owner: RuntimeOwner): Promise<RuntimeState | null> {
    const { stdout } = await this.invoke(this.docker, ["ps", "--all", "--no-trunc", "--format", "{{.ID}}",
      "--filter", "label=" + ledgerLabel + "=" + owner.ledgerId, "--filter", "label=" + sandboxLabel + "=" + owner.sandboxId], opts);
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return null;
    if (ids.length !== 1 || !containerId.test(ids[0]!)) throw new Error("sandbox labels do not identify one container");
    const inspected = await this.invoke(this.docker, ["inspect", "--type", "container", "--format", "{{json .Config.Labels}}\n{{json .State}}", ids[0]!], opts);
    const [labelsLine, stateLine] = inspected.stdout.trimEnd().split("\n");
    const labels = JSON.parse(labelsLine!), state = JSON.parse(stateLine!);
    if (labels[ledgerLabel] !== owner.ledgerId || labels[sandboxLabel] !== owner.sandboxId) throw new Error("container ownership changed");
    if (state.Restarting || state.Status === "removing" || state.Status === "dead") throw new Error("container state is unresolved");
    return { id: ids[0]!, state: state.Paused ? "paused" : state.Running ? "running" : "stopped" };
  }

  async up(owner: RuntimeOwner, workspace: RuntimeWorkspace): Promise<RuntimeState> {
    const prior = await this.observe(owner);
    if (prior) {
      await this.verifyWorkspace(prior.id, workspace);
      return prior;
    }
    const configPath = workspace.imageDigest ? await this.effectiveConfig(workspace) : workspace.configPath;
    const result = await this.startTool(["up", "--update-remote-user-uid-default", "never", "--docker-path", this.docker,
      "--workspace-folder", workspace.path, "--config", configPath, "--mount-workspace-git-root=false", ...(workspace.frozenLockfile ? ["--frozen-lockfile"] : []),
      "--id-label", ledgerLabel + "=" + owner.ledgerId, "--id-label", sandboxLabel + "=" + owner.sandboxId]);
    const report = JSON.parse(result.stdout.trim());
    const after = await this.observe(owner);
    if (!after || after.state !== "running" || report.outcome !== "success" || report.containerId !== after.id) throw new Error("devcontainer did not confirm the owned running container");
    await this.verifyWorkspace(after.id, workspace);
    return after;
  }

  private async effectiveConfig(workspace: RuntimeWorkspace) {
    const expected = workspace.imageDigest!;
    const parsed = pinnedConfig(await readFile(workspace.configPath,"utf8"), expected);
    const inspect = async (ref: string) => JSON.parse((await this.invoke(this.docker, ["image","inspect","--format","{{json .}}",ref],opts)).stdout);
    let image;
    try { image = await inspect(expected); }
    catch {
      try { image = await inspect(parsed.image); }
      catch {
        await this.invoke(this.docker,["pull",parsed.image],opts);
        image = await inspect(parsed.image);
      }
    }
    if (image.Id !== expected && !image.RepoDigests?.some((ref: string) => ref.split("@")[1] === expected)) throw new Error("cannot verify pinned environment image");
    const raw = image.Config?.Labels?.["devcontainer.metadata"];
    if (raw) {
      const metadata = JSON.parse(raw);
      for (const item of Array.isArray(metadata) ? metadata : [metadata]) {
        checkIsolation(item);
        if (item.workspaceMount || item.dockerComposeFile || item.build || item.features) throw new Error("image metadata overrides frozen environment configuration");
      }
    }
    if (Object.keys(image.Config?.Volumes ?? {}).length) throw new Error("the image declares additional workspace volumes");
    const dir = join(dirname(workspace.configPath),"effective");
    await mkdir(dir,{recursive:true,mode:0o700});
    // Registry references select manifests; a local build can instead be pinned
    // by its Docker image ID. Docker accepts that immutable ID directly.
    const launch = { ...parsed, image: image.Id === expected ? image.Id : parsed.image };
    const path = join(dir,"devcontainer.json");
    await writeFile(path,JSON.stringify(launch));
    if (workspace.frozenLockfile) await copyFile(join(dirname(workspace.configPath),"devcontainer-lock.json"),join(dir,"devcontainer-lock.json"));
    return path;
  }

  private async startTool(argv: string[]) {
    if (this.launchLockFd === undefined) return this.invoke(this.devcontainer, argv, opts);
    // The CLI inherits the file description. Even if the helper is killed, a
    // reconciler cannot declare the attempt interrupted while the CLI is alive.
    const child = spawn(this.devcontainer, argv, { stdio: ["ignore","pipe","ignore",this.launchLockFd], timeout: opts.timeout, env:await this.environment() });
    let stdout = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > opts.maxBuffer) child.kill();
      else stdout += chunk;
    });
    await new Promise<void>((ok, fail) => {
      child.once("error", fail);
      child.once("close", code => code === 0 ? ok() : fail(new Error("devcontainer setup did not complete")));
    });
    return { stdout };
  }

  private async verifyWorkspace(id: string, workspace: RuntimeWorkspace) {
    if (workspace.imageDigest) await this.verifyImage(id, workspace.imageDigest);
    if (!workspace.containerFolder) return;
    const data = await this.invoke(this.docker, ["inspect", "--type", "container", "--format", "{{json .Mounts}}", id], opts);
    const mounts = JSON.parse(data.stdout) as {Type: string; Source: string; Destination: string; RW: boolean}[];
    const mount = mounts.find(m => m.Destination === workspace.containerFolder);
    if (mounts.length !== 1 || !mount || mount.Type !== "bind" || !mount.RW || await realpath(mount.Source) !== await realpath(workspace.path)) throw new Error("Docker did not mount the reserved workspace");
  }

  private async verifyImage(id: string, expected: string) {
    const image = (await this.invoke(this.docker, ["inspect", "--type", "container", "--format", "{{.Image}}", id], opts)).stdout.trim();
    if (image === expected) return;
    const digests = JSON.parse((await this.invoke(this.docker, ["image", "inspect", "--format", "{{json .RepoDigests}}", image], opts)).stdout) as string[] | null;
    if (!digests?.some(entry => entry.split("@")[1] === expected)) throw new Error("the running container image differs from the frozen environment digest");
  }

  private async owned(owner: RuntimeOwner, id: string) {
    const current = await this.observe(owner);
    if (!current || current.id !== id) throw new Error("sandbox container is no longer present under the recorded identity");
    return current;
  }

  async pause(owner: RuntimeOwner, id: string) {
    const current = await this.owned(owner, id);
    if (current.state !== "paused") await this.invoke(this.docker, ["pause", id], opts);
    if ((await this.owned(owner, id)).state !== "paused") throw new Error("sandbox pause not confirmed");
  }

  async resume(owner: RuntimeOwner, id: string) {
    const current = await this.owned(owner, id);
    if (current.state === "paused") await this.invoke(this.docker, ["unpause", id], opts);
    if ((await this.owned(owner, id)).state !== "running") throw new Error("sandbox resume not confirmed");
  }

  async remove(owner: RuntimeOwner, id: string) {
    const current = await this.observe(owner);
    if (!current) return;
    if (current.id !== id) throw new Error("recorded container identity differs; cannot release");
    if (current.state === "paused") await this.invoke(this.docker, ["unpause", id], opts);
    if (current.state !== "stopped") await this.invoke(this.docker, ["stop", id], opts);
    await this.invoke(this.docker, ["rm", id], opts);
    if (await this.observe(owner)) throw new Error("sandbox removal not confirmed");
  }

  async execute(owner: RuntimeOwner, id: string, workspace: RuntimeWorkspace, argv: readonly string[]) {
    if ((await this.owned(owner, id)).state !== "running") throw new Error("sandbox is not running");
    if (!argv.length) throw new Error("sandbox command needs an executable");
    try {
      const result = await this.invoke(this.devcontainer, ["exec", "--docker-path", this.docker, "--workspace-folder", workspace.path,
        "--config", workspace.imageDigest ? join(dirname(workspace.configPath),"effective","devcontainer.json") : workspace.configPath, "--container-id", id, "--", ...argv], opts);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as {code?: number | string; killed?: boolean; stdout?: string; stderr?: string};
      if (typeof failure.code !== "number" || failure.killed) throw error;
      return { exitCode: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }
}
