import { execFile } from "node:child_process";
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
  constructor(private readonly devcontainer = "devcontainer", private readonly docker = "docker") {}

  async observe(owner: RuntimeOwner): Promise<RuntimeState | null> {
    const { stdout } = await exec(this.docker, ["ps", "--all", "--no-trunc", "--format", "{{.ID}}",
      "--filter", "label=" + ledgerLabel + "=" + owner.ledgerId, "--filter", "label=" + sandboxLabel + "=" + owner.sandboxId], opts);
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return null;
    if (ids.length !== 1 || !containerId.test(ids[0]!)) throw new Error("sandbox labels do not identify one container");
    const inspected = await exec(this.docker, ["inspect", "--type", "container", "--format", "{{json .Config.Labels}}\n{{json .State}}", ids[0]!], opts);
    const [labelsLine, stateLine] = inspected.stdout.trimEnd().split("\n");
    const labels = JSON.parse(labelsLine!), state = JSON.parse(stateLine!);
    if (labels[ledgerLabel] !== owner.ledgerId || labels[sandboxLabel] !== owner.sandboxId) throw new Error("container ownership changed");
    if (state.Restarting || state.Status === "removing" || state.Status === "dead") throw new Error("container state is unresolved");
    return { id: ids[0]!, state: state.Paused ? "paused" : state.Running ? "running" : "stopped" };
  }

  async up(owner: RuntimeOwner, workspace: RuntimeWorkspace): Promise<RuntimeState> {
    const prior = await this.observe(owner);
    if (prior) return prior;
    const result = await exec(this.devcontainer, ["up", "--docker-path", this.docker,
      "--workspace-folder", workspace.path, "--override-config", workspace.configPath, "--mount-workspace-git-root=false",
      "--id-label", ledgerLabel + "=" + owner.ledgerId, "--id-label", sandboxLabel + "=" + owner.sandboxId], opts);
    const report = JSON.parse(result.stdout.trim());
    const after = await this.observe(owner);
    if (!after || after.state !== "running" || report.outcome !== "success" || report.containerId !== after.id) throw new Error("devcontainer did not confirm the owned running container");
    return after;
  }

  private async owned(owner: RuntimeOwner, id: string) {
    const current = await this.observe(owner);
    if (!current || current.id !== id) throw new Error("sandbox container is no longer present under the recorded identity");
    return current;
  }

  async pause(owner: RuntimeOwner, id: string) {
    const current = await this.owned(owner, id);
    if (current.state !== "paused") await exec(this.docker, ["pause", id], opts);
    if ((await this.owned(owner, id)).state !== "paused") throw new Error("sandbox pause not confirmed");
  }

  async resume(owner: RuntimeOwner, id: string) {
    const current = await this.owned(owner, id);
    if (current.state === "paused") await exec(this.docker, ["unpause", id], opts);
    if ((await this.owned(owner, id)).state !== "running") throw new Error("sandbox resume not confirmed");
  }

  async remove(owner: RuntimeOwner, id: string) {
    const current = await this.observe(owner);
    if (!current) return;
    if (current.id !== id) throw new Error("recorded container identity differs; cannot release");
    if (current.state === "paused") await exec(this.docker, ["unpause", id], opts);
    if (current.state !== "stopped") await exec(this.docker, ["stop", id], opts);
    await exec(this.docker, ["rm", id], opts);
    if (await this.observe(owner)) throw new Error("sandbox removal not confirmed");
  }

  async execute(owner: RuntimeOwner, id: string, workspace: RuntimeWorkspace, argv: readonly string[]) {
    if ((await this.owned(owner, id)).state !== "running") throw new Error("sandbox is not running");
    if (!argv.length) throw new Error("sandbox command needs an executable");
    try {
      const result = await exec(this.devcontainer, ["exec", "--docker-path", this.docker, "--workspace-folder", workspace.path,
        "--override-config", workspace.configPath, "--container-id", id, "--", ...argv], opts);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as {code?: number | string; killed?: boolean; stdout?: string; stderr?: string};
      if (typeof failure.code !== "number" || failure.killed) throw error;
      return { exitCode: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }
}
