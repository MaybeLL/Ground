import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { routeChannel } from "./code-route-channel.js";
import { docker, probeDocker } from "./env-docker.js";
import { DomainError, validation } from "./errors.js";
import type { RouteEngine, RouteEngineStatus, RouteExecution } from "./code-route-execution.js";
import { prepareRouteGitView, refreshRouteGitView, routeGitViewRoot } from "./code-route-git-view.js";
import { DockerRouteRuntime } from "./code-route-runtime.js";

const fail = (reason: string): never => { throw new DomainError("STATE_CONFLICT", reason); };
const name = (run: RouteExecution) => `grounds-code-${run.execution_id}`;
const labels = (run: RouteExecution): Record<string, string> => ({
  "grounds.code-execution": run.execution_id, "grounds.code-route": run.route_id,
  "grounds.database": run.database_id, "grounds.host": run.host_id,
  "grounds.generation": String(run.generation), "grounds.request": run.request_digest,
});
interface Container {
  Id: string; Image: string; Config: { Labels: Record<string, string> };
  State: { Running: boolean; Paused: boolean; Restarting: boolean; Status: string; ExitCode: number };
}

/** Isolated diagnostic/development adapter with read-only Git metadata and fixed route mounts. */
export class DockerRouteEngine implements RouteEngine {
  async platform() { return docker(["info", "--format", "{{.OSType}}/{{.Architecture}}"]); }
  async prepareDependencies(run: RouteExecution) { await this.assertEngine(run); return new DockerRouteRuntime(run).prepare(); }
  async stopDependencies(run: RouteExecution) { await this.assertEngine(run); await new DockerRouteRuntime(run).stop(); }
  async prepare(run: RouteExecution): Promise<void> { prepareRouteGitView(run); }
  async refreshGitView(run: RouteExecution): Promise<void> {
    await this.assertPaused(run);
    refreshRouteGitView(run);
    await this.assertPaused(run);
  }
  async identity(): Promise<string> {
    probeDocker();
    const id = docker(["info", "--format", "{{.ID}}"]);
    if (!id) fail("Docker engine identity is unavailable");
    return id;
  }
  async status(run: RouteExecution): Promise<RouteEngineStatus> {
    const id = await this.find(run);
    if (!id || id !== run.container_id) fail("Exact container is unavailable for observation");
    const value = this.inspect(id!, run);
    if (value.State.Restarting) fail("Restarting container has no stable execution state");
    if (value.State.Running && value.State.Paused && value.State.Status === "paused") return { state: "paused" };
    if (value.State.Running && !value.State.Paused && value.State.Status === "running") return { state: "running" };
    if (!value.State.Running && !value.State.Paused && value.State.Status === "exited") return { state: "exited", exit_code: value.State.ExitCode };
    return fail("Container execution state is unknown");
  }
  private async assertEngine(run: RouteExecution): Promise<void> {
    if (await this.identity() !== run.engine_id) fail("Docker engine changed; retain execution ownership");
  }
  private inspect(id: string, run: RouteExecution): Container {
    const value = JSON.parse(docker(["inspect", id]))[0] as Container;
    if (value.Id !== id || (run.container_id && value.Id !== run.container_id) || value.Image !== run.image
      || Object.entries(labels(run)).some(([key, expected]) => value.Config?.Labels?.[key] !== expected))
      fail("Container ownership differs from the recorded execution; retain it");
    return value;
  }
  async find(run: RouteExecution): Promise<string | undefined> {
    await this.assertEngine(run);
    // A successful list is required. A failed inspect is never treated as absence.
    const ids = docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${name(run)}$`]).split("\n").filter(Boolean);
    if (ids.length > 1) fail("Container identity is ambiguous");
    const named = ids[0];
    if (run.container_id) {
      const exact = docker(["ps", "-aq", "--no-trunc", "--filter", `id=${run.container_id}`]).split("\n").filter(Boolean);
      if (exact.some(id => id !== run.container_id) || (named && named !== run.container_id)) fail("Container identity was replaced");
      if (exact.length) { this.inspect(run.container_id, run); return run.container_id; }
      if (named) fail("Container identity could not be reconciled");
      return undefined;
    }
    if (named) this.inspect(named, run);
    return named;
  }
  async create(run: RouteExecution): Promise<string> {
    await this.assertEngine(run);
    if (run.environment?.configuration.postgres) new DockerRouteRuntime(run).assertReady();
    if (!["read-only-diagnostic", "development"].includes(run.mode) || realpathSync(run.code_path) !== run.code_path
      || /[,\r\n]/.test(run.code_path) || !lstatSync(join(run.code_path, ".git")).isFile())
      throw validation("route", "execution requires the canonical prepared worktree");
    const channel = routeChannel(run);
    if (run.mode === "development" && [channel.inbox, channel.outbox].some(path => realpathSync(path) !== path || !lstatSync(path).isDirectory()))
      throw validation("channel", "execution requires its prepared private mailbox");
    for (const baseline of run.baselines ?? []) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(baseline.alias) || realpathSync(baseline.path) !== baseline.path
        || /[,\r\n]/.test(baseline.path) || !lstatSync(join(baseline.path, ".git")).isFile())
        throw validation("baseline", "diagnostic requires canonical prepared baselines");
    }
    if (docker(["image", "inspect", "--format", "{{.Id}}", run.image]) !== run.image) fail("Exact local image is unavailable");
    const uid = process.getuid?.(), gid = process.getgid?.();
    if (uid === undefined || uid === 0 || gid === undefined) fail("Diagnostic execution requires a non-root host identity");
    const id = docker(["create", "--name", name(run), "--pull", "never", "--init", "--restart", "no",
      ...Object.entries(labels(run)).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--read-only", "--network", run.dependency?.network_id ?? "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      ...(run.dependency ? ["--env", "PGHOST=postgres", "--env", "PGPORT=5432", "--env", "PGDATABASE=task", "--env", "PGUSER=postgres"] : []),
      "--cpus", "1", "--memory", "512m", "--pids-limit", "64", "--user", `${uid}:${gid}`,
      "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777", "--env", "HOME=/tmp",
      "--env", "GIT_CONFIG_NOSYSTEM=1", "--env", "GIT_CONFIG_GLOBAL=/dev/null", "--env", "GIT_OPTIONAL_LOCKS=0",
      "--env", "GIT_NO_REPLACE_OBJECTS=1", "--env", "GIT_NO_LAZY_FETCH=1",
      "--mount", `type=bind,src=${run.code_path},dst=/workspace${run.mode === "development" ? "" : ",readonly"}`, "--workdir", "/workspace",
      ...(run.mode === "development" ? [
        "--env", `GROUNDS_CODE_EXECUTION_ID=${run.execution_id}`,
        "--mount", `type=bind,src=${channel.inbox},dst=/grounds-requests/inbox`,
        "--mount", `type=bind,src=${channel.outbox},dst=/grounds-requests/outbox,readonly`,
        "--mount", `type=bind,src=${channel.client},dst=/usr/local/bin/grounds-git,readonly`,
      ] : []),
      "--mount", `type=bind,src=${routeGitViewRoot(run)},dst=/grounds-git,readonly`,
      "--mount", `type=bind,src=${join(routeGitViewRoot(run), "route", "git-pointer")},dst=/workspace/.git,readonly`,
      ...(run.baselines ?? []).flatMap(baseline => [
        "--mount", `type=bind,src=${baseline.path},dst=/baselines/${baseline.alias},readonly`,
        "--mount", `type=bind,src=${join(routeGitViewRoot(run), "baselines", baseline.alias, "git-pointer")},dst=/baselines/${baseline.alias}/.git,readonly`,
      ]),
      "--entrypoint", run.argv[0]!, run.image, ...run.argv.slice(1)]);
    if (!/^[a-f0-9]{64}$/.test(id)) fail("Docker did not return a full container identity");
    this.inspect(id, run);
    return id;
  }
  async start(run: RouteExecution): Promise<void> {
    const id = await this.find(run);
    if (!id || id !== run.container_id) fail("Created container identity is missing");
    if (run.environment?.configuration.postgres) new DockerRouteRuntime(run).assertReady();
    docker(["start", id!]);
  }
  private async live(run: RouteExecution): Promise<Container> {
    const id = await this.find(run);
    if (!id || id !== run.container_id) fail("Exact running container is missing; retain execution ownership");
    const value = this.inspect(id!, run);
    if (!value.State.Running || value.State.Restarting || !["running", "paused"].includes(value.State.Status))
      fail("Container is not live; retain execution ownership");
    return value;
  }
  async pause(run: RouteExecution): Promise<void> {
    const before = await this.live(run);
    if (!before.State.Paused) docker(["pause", before.Id]);
    await this.assertPaused(run);
  }
  async assertPaused(run: RouteExecution): Promise<void> {
    const value = await this.live(run);
    if (!value.State.Paused || value.State.Status !== "paused") fail("Container pause is not proven; retain execution ownership");
  }
  async resume(run: RouteExecution): Promise<void> {
    const before = await this.live(run);
    if (before.State.Paused) docker(["unpause", before.Id]);
    const after = await this.live(run);
    if (after.State.Paused || after.State.Status !== "running") fail("Container resume is not proven; retain execution ownership");
  }
  async removeStopped(run: RouteExecution): Promise<void> {
    const id = await this.find(run);
    if (!id) return;
    const before = this.inspect(id, run);
    if (before.State.Paused) {
      // Do not unpause merely to stop: that would let the executor write again.
      docker(["rm", "--force", "--volumes", id]);
      if (await this.find(run)) fail("Paused container removal is not proven");
      return;
    }
    if (before.State.Running || before.State.Restarting) docker(["stop", "--time", "2", id]);
    await this.assertEngine(run);
    const after = this.inspect(id, run);
    if (after.State.Running || after.State.Paused || after.State.Restarting
      || !["created", "exited"].includes(after.State.Status)) fail("Container termination is not proven");
    docker(["rm", "--volumes", id]);
    if (await this.find(run)) fail("Container removal is not proven");
  }
}
