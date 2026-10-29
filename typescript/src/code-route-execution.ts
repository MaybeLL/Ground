import { CodeRouteGit } from "./code-route-git.js";
import { assertChannelIdle, prepareRouteChannel } from "./code-route-channel.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./canonical-json.js";
import { CodeWorkspaces } from "./code-workspace.js";
import { CodeWorkspaceRoutes, type CodeWorkspaceRoute } from "./code-workspace-route.js";
import { assertNoPendingRouteGit, assertRoutePreparing, readRouteControl, writeRouteControl } from "./code-route-fence.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { DomainError, validation } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { atomicPrivateWrite, safeRead, withRuntimeLock } from "./runtime-files.js";
import type { Store } from "./store-types.js";
import { getCurrentAdmission } from "./preflight-admission.js";
import { capturePreflightInputs } from "./preflight-inputs.js";
import { observeBranch } from "./integration-observation.js";
import { RepositoryEnvironments, type RepositoryEnvironmentVersion, type RepositoryEnvironmentDefault } from "./repository-environment.js";

export interface RouteDependency {
  kind: "postgres"; network_id: string; container_id: string; volume_name: string;
  host: "postgres"; port: 5432; database: "task"; user: "postgres";
}

export interface RouteExecution {
  format: "grounds.code-route-execution/v1";
  execution_id: string; route_id: string; database_id: string; host_id: string;
  dev_run_id: string; generation: number; request_digest: string; engine_id: string;
  image: string; argv: string[]; code_path: string;
  environment?: RepositoryEnvironmentVersion;
  environment_default?: RepositoryEnvironmentDefault;
  dependency?: RouteDependency;
  baselines?: { alias: string; path: string; repository_id: string; commit: string }[];
  container_id?: string;
  exit_code?: number;
  pause_id?: string;
  git_view_dirty?: boolean;
  mode: "read-only-diagnostic" | "development";
  state: "intent" | "preparing-runtime" | "creating" | "created" | "starting" | "running" | "pausing" | "paused" | "resuming" | "stopping" | "stopped";
  attribution: Attribution;
}
/** External engine boundary. removeStopped resolves only after ownership, stop and absence proofs. */
export type RouteEngineStatus = { state: "running" | "paused" } | { state: "exited"; exit_code: number };
export interface RouteEngine {
  identity(): Promise<string>;
  platform?(): Promise<string>;
  /** Fresh state of the exact owned container, never inferred from a saved run. */
  status?(run: RouteExecution): Promise<RouteEngineStatus>;
  /** Local preparation only; must never create or start an executor. */
  prepare?(run: RouteExecution): Promise<void>;
  /** Called only after durable route reservation. Must retain recoverable resource identities. */
  prepareDependencies?(run: RouteExecution): Promise<RouteDependency | void>;
  /** Prove owned services stopped; preserve their containers, networks and data volumes. */
  stopDependencies?(run: RouteExecution): Promise<void>;
  create(run: RouteExecution): Promise<string>;
  find(run: RouteExecution): Promise<string | undefined>;
  start(run: RouteExecution): Promise<void>;
  /** Idempotent engine transitions, each proving the exact container's resulting state. */
  pause?(run: RouteExecution): Promise<void>;
  assertPaused?(run: RouteExecution): Promise<void>;
  /** Rebuild the mounted read view while the route and target repository remain locked. */
  refreshGitView?(run: RouteExecution): Promise<void>;
  resume?(run: RouteExecution): Promise<void>;
  removeStopped(run: RouteExecution): Promise<void>;
}
interface PauseRequest { route_id: string; execution_id: string; operation_id: string; attribution: Attribution; channel_request_id?: string }
export interface RoutePause {
  format: "grounds.code-route-pause/v1";
  operation_id: string; route_id: string; execution_id: string; generation: number;
  database_id: string; host_id: string; request_digest: string;
  state: "pausing" | "paused" | "resuming" | "resumed";
}
interface StartExecution { route_id: string; operation_id: string; image?: string; environment_revision_id?: string; environment_default?: true; argv: string[]; attribution: Attribution; mode?: RouteExecution["mode"] }
/** Shared pre-I/O validation keeps CLI route selection behind malformed-input rejection. */
export function validateExecutionStart(request: StartExecution): void {
  validateAttribution(request.attribution);
  if ((request.mode !== undefined && !["read-only-diagnostic", "development"].includes(request.mode))
    || [request.image, request.environment_revision_id, request.environment_default].filter(value => value !== undefined).length !== 1
    || (request.environment_default !== undefined && request.environment_default !== true)
    || (request.environment_revision_id !== undefined && !isUUIDv7(request.environment_revision_id))
    || (request.image !== undefined && (typeof request.image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(request.image)))
    || !Array.isArray(request.argv) || !request.argv.length
    || request.argv.length > 64 || request.argv.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 8192)
    || !request.argv[0]) throw validation("execution", "requires exactly one image, environment revision or explicit Repo default, and bounded command arguments");
}
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };

/** Host application service: explicit admission and ownership for diagnostic/development execution. */
export class CodeRouteExecutions {
  constructor(private readonly store: Store, private readonly engine: RouteEngine) {}

  private async location(routeId: string) {
    const route = await new CodeWorkspaceRoutes(this.store).show(routeId);
    const instance = await new CodeWorkspaces(this.store).instance(route.instance_id);
    const root = instance.data_root;
    if (!root || safeRead(join(root, "runtime", "host-id"), 128).toString().trim() !== route.host_id
      || route.host_id !== instance.host_id || route.database_id !== (await this.store.open()).database_id)
      conflict("Execution must be controlled on the recorded host and database");
    return { route, root: root!, instance };
  }
  private journal(root: string, id: string) {
    if (!isUUIDv7(id)) throw validation("execution_id", "requires UUIDv7");
    return join(root, "runtime", "route-executions", `${id}.json`);
  }
  private read(root: string, id: string, route: CodeWorkspaceRoute): RouteExecution {
    const run = JSON.parse(safeRead(this.journal(root, id)).toString("utf8")) as RouteExecution;
    if (run.format !== "grounds.code-route-execution/v1" || run.execution_id !== id || run.route_id !== route.route_id
      || run.database_id !== route.database_id || run.host_id !== route.host_id || run.dev_run_id !== route.dev_run_id
      || run.code_path !== route.path) conflict("Execution receipt identity differs from the route");
    return run;
  }
  async show(input: { route_id: string; execution_id: string }): Promise<RouteExecution> {
    const { root, route } = await this.location(input.route_id);
    return this.read(root, input.execution_id, route);
  }
  async observe(input: { route_id: string; execution_id: string }) {
    const { root, route } = await this.location(input.route_id);
    return withRuntimeLock(join(root, "runtime"), `code-route:${route.route_id}`, async () => {
      const run = this.read(root, input.execution_id, route), control = readRouteControl(route);
      if (control.execution_id !== run.execution_id || control.generation !== run.generation || !run.container_id
        || !this.engine.status || await this.engine.identity() !== run.engine_id
        || await this.engine.find(run) !== run.container_id) conflict("Cannot observe the current execution owner");
      const status = await this.engine.status!(run);
      if (status.state === "exited") {
        if (!Number.isSafeInteger(status.exit_code) || status.exit_code < 0
          || (run.exit_code !== undefined && run.exit_code !== status.exit_code)) conflict("Container exit result is invalid or changed");
        run.exit_code = status.exit_code;
        atomicPrivateWrite(this.journal(root, run.execution_id), JSON.stringify(run));
      }
      return { execution: run, status };
    });
  }
  /** Trusted host API; binding a window does not authenticate a container caller. */
  git(input: PauseRequest): CodeRouteGit {
    const request = structuredClone(input);
    validateAttribution(request.attribution);
    return new CodeRouteGit(this.store, request.route_id, { binding: { execution_id: request.execution_id,
      pause_id: request.operation_id, request_digest: sha256(request) }, engine: this.engine });
  }
  async pause(input: PauseRequest): Promise<RoutePause> { return this.transitionPause(input, false); }
  async resume(input: PauseRequest): Promise<RoutePause> { return this.transitionPause(input, true); }

  private async transitionPause(input: PauseRequest, resume: boolean): Promise<RoutePause> {
    const request = structuredClone(input);
    validateAttribution(request.attribution);
    if (!isUUIDv7(request.operation_id)) throw validation("operation_id", "requires UUIDv7");
    const { route, root } = await this.location(request.route_id);
    const path = join(root, "runtime", "route-pauses", `${request.operation_id}.json`), digest = sha256(request);
    return withRuntimeLock(join(root, "runtime"), `code-pause:${request.operation_id}`, () =>
      withRuntimeLock(join(root, "runtime"), `code-route:${route.route_id}`, async () => {
        const run = this.read(root, request.execution_id, route);
        assertChannelIdle(run, request.channel_request_id);
        let window: RoutePause | undefined;
        if (existsSync(path)) {
          window = JSON.parse(safeRead(path, 16 * 1024).toString()) as RoutePause;
          if (window.format !== "grounds.code-route-pause/v1" || window.operation_id !== request.operation_id
            || window.execution_id !== run.execution_id || window.route_id !== route.route_id || window.generation !== run.generation
            || window.database_id !== route.database_id || window.host_id !== route.host_id || window.request_digest !== digest)
            conflict("Pause request identity or bytes changed");
          if (window.state === "resumed" && (!resume || run.pause_id !== request.operation_id || run.state !== "resuming")) return window;
        } else if (resume) conflict("Pause window does not exist");
        const control = readRouteControl(route);
        if (control.execution_id !== run.execution_id || control.generation !== run.generation)
          conflict("Execution no longer owns this route");
        if (await this.engine.identity() !== run.engine_id) conflict("Engine changed; retain execution ownership");
        if (!this.engine.pause || !this.engine.assertPaused || !this.engine.resume) conflict("Engine cannot prove a pause window");
        const persistRun = (state: RouteExecution["state"]) => {
          run.state = state; atomicPrivateWrite(this.journal(root, run.execution_id), JSON.stringify(run));
        };
        const persistWindow = (state: RoutePause["state"]) => {
          window!.state = state; atomicPrivateWrite(path, JSON.stringify(window));
        };
        if (!window) {
          if (run.pause_id || !["running", "starting"].includes(run.state)) conflict("Execution is not available for a new pause");
          window = { format: "grounds.code-route-pause/v1", operation_id: request.operation_id, route_id: route.route_id,
            execution_id: run.execution_id, generation: run.generation, database_id: route.database_id,
            host_id: route.host_id, request_digest: digest, state: "pausing" };
          persistWindow("pausing");
        }
        if (!resume) {
          if (window.state === "resuming") conflict("Recover the resume before requesting a new pause");
          if (run.pause_id && run.pause_id !== request.operation_id) conflict("Another pause owns the execution");
          if (!["running", "starting", "pausing", "paused"].includes(run.state)) conflict("Execution cannot enter a pause");
          run.pause_id = request.operation_id;
          if (window.state === "pausing") {
            persistRun("pausing");
            await this.engine.pause!(run);
          }
          await this.engine.assertPaused!(run);
          persistRun("paused");
          persistWindow("paused");
        } else {
          assertNoPendingRouteGit(route);
          if (run.pause_id !== request.operation_id || !["paused", "resuming"].includes(run.state)
            || !["paused", "resuming", "resumed"].includes(window.state)) conflict("Recover the pause before resuming its exact window");
          if (window.state === "paused") {
            await this.engine.assertPaused!(run);
            if (run.git_view_dirty) {
              if (!this.engine.refreshGitView) conflict("Engine cannot refresh the Git view; retain the pause");
              await withRuntimeLock(join(root, "runtime"), `repository:${route.repository_id}`, async () => {
                await this.engine.assertPaused!(run);
                await this.engine.refreshGitView!(run);
                await this.engine.assertPaused!(run);
                run.git_view_dirty = false;
                persistRun("paused");
              }, 30_000);
            }
            persistWindow("resuming");
          } else if (run.git_view_dirty) conflict("An unfinished resume cannot expose a stale Git view");
          persistRun("resuming");
          await this.engine.resume!(run);
          // Terminal receipt first: a crash cannot make a later pause vulnerable to an old resume.
          persistWindow("resumed");
          delete run.pause_id;
          persistRun("running");
        }
        return window;
      }));
  }
  async start(input: StartExecution): Promise<RouteExecution> {
    const request = structuredClone(input);
    validateExecutionStart(request);
    const { route, root, instance } = await this.location(request.route_id);
    const path = this.journal(root, request.operation_id), digest = sha256(request);
    return withRuntimeLock(join(root, "runtime"), `code-execution:${request.operation_id}`, async () => {
      const replay = () => {
        const prior = this.read(root, request.operation_id, route);
        if (prior.request_digest !== digest) conflict("Execution request ID was already used with different inputs");
        return prior;
      };
      if (existsSync(path)) return replay(); // Never redispatch an uncertain request.
      if (!route.dev_run_id) conflict("Bind and admit the route before execution");
      const environments = new RepositoryEnvironments(this.store);
      const selectedDefault = request.environment_default ? await environments.default(route.repository_id) : undefined;
      const revisionId = selectedDefault?.revision_id ?? request.environment_revision_id;
      const environment = revisionId ? await environments.revision(revisionId) : undefined;
      if (environment && environment.repository_id !== route.repository_id) conflict("Environment belongs to another repository");
      if (environment?.configuration.postgres && (!this.engine.prepareDependencies || !this.engine.stopDependencies))
        conflict("Engine does not support the selected dependency lifecycle");
      return new CodeWorkspaceRoutes(this.store).capture(route.route_id, route.dev_run_id!, route.path, async () => {
        if (existsSync(path)) return replay();
        const control = assertRoutePreparing(route);
        if (control.generation >= Number.MAX_SAFE_INTEGER) conflict("Execution generation exhausted");
        const subject = await this.store.read(async tx => ({
          devRun: await tx.getDevRun(route.dev_run_id!),
          revision: await tx.getIssueRevisionById(route.issue_revision_id),
          remotes: (await tx.listRepositoryRemotes(route.repository_id)).map(item => item.remote),
        }));
        if (request.mode === "development" && subject.devRun.execution_mode?.mode === "simple") conflict("This DevRun uses the current environment; start a new DevRun to use a managed container");
        const run: RouteExecution = { format: "grounds.code-route-execution/v1", execution_id: request.operation_id,
          route_id: route.route_id, database_id: route.database_id, host_id: route.host_id, dev_run_id: route.dev_run_id!,
          generation: control.generation + 1, request_digest: digest, engine_id: await this.engine.identity(),
          image: environment?.configuration.image ?? request.image!, argv: request.argv, code_path: route.path,
          ...(environment ? { environment } : {}),
          ...(selectedDefault ? { environment_default: selectedDefault } : {}),
          baselines: instance.baselines.map(({ alias, path, repository_id, commit }) => ({ alias, path, repository_id, commit })), mode: request.mode ?? "read-only-diagnostic", state: "intent", attribution: request.attribution };
        const persist = (state: RouteExecution["state"]) => { run.state = state; atomicPrivateWrite(path, JSON.stringify(run)); };
        if (!subject.revision.target_branch) conflict("Execution requires a declared target");
        const target = observeBranch(route.path, subject.revision.target_branch!, subject.remotes, true);
        if (!target.refreshed || target.failure || target.commit?.oid !== subject.devRun.base_commit) conflict("Target changed or could not be refreshed; repeat preflight");
        await this.store.write(async tx => {
          await tx.lockDevRun(run.dev_run_id);
          const admission = await getCurrentAdmission(tx, run.dev_run_id);
          if (!admission || sha256(admission.data.input_binding) !== sha256(await capturePreflightInputs(tx, run.dev_run_id, route.path)))
            conflict("Route needs current admission for its actual inputs");
          persist("intent");
          writeRouteControl(route, { generation: run.generation, execution_id: run.execution_id });
        });
        if (run.mode === "development") prepareRouteChannel(run);
        await this.engine.prepare?.(run);
        if (environment?.configuration.postgres) {
          persist("preparing-runtime");
          const dependency = await this.engine.prepareDependencies!(run);
          if (dependency) run.dependency = dependency;
        }
        persist("creating");
        run.container_id = await this.engine.create(run);
        persist("created");
        persist("starting");
        await this.engine.start(run);
        persist("running");
        return run;
      }, "all");
    });
  }
  async stop(input: { route_id: string; execution_id: string }): Promise<RouteExecution> {
    const { route, root } = await this.location(input.route_id);
    return withRuntimeLock(join(root, "runtime"), `code-route:${route.route_id}`, async () => {
      const run = this.read(root, input.execution_id, route), control = readRouteControl(route);
      const owns = control.execution_id === run.execution_id && control.generation === run.generation;
      if (!owns) {
        if (run.state === "stopped") return run;
        conflict("Execution no longer owns this route; preserve the reservation");
      }
      assertChannelIdle(run);
      assertNoPendingRouteGit(route);
      if (await this.engine.identity() !== run.engine_id) conflict("Docker engine changed; retain execution ownership");
      const container = await this.engine.find(run);
      if (container) {
        if (run.container_id && run.container_id !== container) conflict("Container identity changed; preserve the reservation");
        run.container_id = container;
        run.state = "stopping";
        atomicPrivateWrite(this.journal(root, run.execution_id), JSON.stringify(run));
        await this.engine.removeStopped(run);
        if (await this.engine.find(run)) conflict("Container still exists; retain execution ownership");
      } else if (!(run.container_id && ["stopping", "stopped"].includes(run.state)) && !["intent", "preparing-runtime"].includes(run.state)) {
        conflict("Container creation or disappearance is unproven; retain execution ownership");
      }
      if (run.environment?.configuration.postgres) {
        if (!this.engine.stopDependencies) conflict("Engine cannot prove dependencies stopped");
        await this.engine.stopDependencies!(run);
      }
      run.state = "stopped";
      atomicPrivateWrite(this.journal(root, run.execution_id), JSON.stringify(run));
      writeRouteControl(route, { generation: run.generation });
      return run;
    });
  }
}
