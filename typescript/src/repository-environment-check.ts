import { join } from "node:path";
import { sha256 } from "./canonical-json.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { DomainError, notFound, validation } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { CodeWorkspaceRoutes } from "./code-workspace-route.js";
import { CodeWorkspaces } from "./code-workspace.js";
import { CodeRouteExecutions, type RouteEngine } from "./code-route-execution.js";
import { RepositoryEnvironments, type RepositoryEnvironmentVersion } from "./repository-environment.js";
import { safeRead, withRuntimeLock } from "./runtime-files.js";
import type { Store } from "./store-types.js";

export interface RepositoryEnvironmentCheck {
  format: "grounds.repository-environment-check/v1";
  check_id: string; route_id: string; database_id: string; host_id: string;
  environment: RepositoryEnvironmentVersion; request_digest: string;
  profile: "git-python-postgres-connect/v1"; argv: string[];
  state: "registered" | "checking" | "needs-recovery" | "passed" | "failed";
  engine_id?: string; platform?: string; exit_code?: number;
  reason?: "execution-needs-recovery" | "probe-failed" | "stopped-without-result";
  attribution: Attribution; created_at: string; completed_at?: string;
}
interface CheckRequest { operation_id: string; route_id: string; environment_revision_id: string; attribution: Attribution }
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
const terminal = (record: RepositoryEnvironmentCheck) => record.state === "passed" || record.state === "failed";
const probe = (postgres: boolean) => ["python3", "-I", "-c", `import fcntl,subprocess,socket,os
subprocess.run(['git','--version'],check=True,timeout=5)
${postgres ? "socket.create_connection((os.environ['PGHOST'],int(os.environ['PGPORT'])),5).close()" : ""}
`];

/** A fixed read-only probe, using the existing route reservation and stop proofs.
 * Check success is historical readiness on one host/engine, never Candidate acceptance.
 */
export class RepositoryEnvironmentChecks {
  constructor(private readonly store: Store, private readonly engine: RouteEngine) {}
  private async lookup(id: string): Promise<RepositoryEnvironmentCheck | undefined> {
    if (!isUUIDv7(id)) throw validation("check_id", "requires UUIDv7");
    return this.store.read(async tx => {
      const row = await tx.getRuntimeRecord("runtime_operation", id);
      if (row && row.data.format !== "grounds.repository-environment-check/v1") conflict("Check ID belongs to another record type");
      return row?.data as unknown as RepositoryEnvironmentCheck | undefined;
    });
  }
  async show(id: string): Promise<RepositoryEnvironmentCheck> {
    const check = await this.lookup(id);
    if (!check) throw notFound("environment_check", id);
    return check;
  }
  private async update(id: string, patch: Partial<RepositoryEnvironmentCheck>): Promise<RepositoryEnvironmentCheck> {
    return this.store.write(async tx => {
      await tx.lockRuntimeRecord("runtime_operation", id);
      const row = (await tx.getRuntimeRecord("runtime_operation", id))!;
      const previous = row.data as unknown as RepositoryEnvironmentCheck;
      if (terminal(previous)) return previous;
      const result = { ...previous, ...patch };
      if (result.state === "checking" || result.state === "passed") delete result.reason;
      if (terminal(result)) result.completed_at = await tx.now();
      await tx.saveRuntimeRecord({ ...row, version: row.version + 1, data: { ...result } }, row.version);
      return result;
    });
  }
  async check(input: CheckRequest): Promise<RepositoryEnvironmentCheck> {
    const request = structuredClone(input);
    for (const id of [request.operation_id, request.route_id, request.environment_revision_id])
      if (!isUUIDv7(id)) throw validation("check", "requires UUIDv7 identities");
    validateAttribution(request.attribution);
    const digest = sha256(request), prior = await this.lookup(request.operation_id);
    if (prior && prior.request_digest !== digest) conflict("Check request ID was reused with different inputs");
    if (prior && terminal(prior)) return prior;
    const route = await new CodeWorkspaceRoutes(this.store).show(request.route_id);
    const instance = await new CodeWorkspaces(this.store).instance(route.instance_id), root = instance.data_root;
    if (!root || safeRead(join(root, "runtime", "host-id"), 128).toString().trim() !== route.host_id
      || route.database_id !== (await this.store.open()).database_id) conflict("Check must run on the recorded host and database");
    const environment = await new RepositoryEnvironments(this.store).revision(request.environment_revision_id);
    if (environment.repository_id !== route.repository_id) conflict("Environment belongs to another repository");
    if (!this.engine.platform) conflict("Engine cannot report its check platform");
    return withRuntimeLock(join(root!, "runtime"), `environment-check:${request.operation_id}`, async () => {
      let check = await this.store.write(async tx => {
        const replay = await tx.reserveOperation({ id: request.operation_id, command: "code-workspace.environment-check", request_hash: digest });
        if (replay) return (await tx.getRuntimeRecord("runtime_operation", request.operation_id))!.data as unknown as RepositoryEnvironmentCheck;
        const result: RepositoryEnvironmentCheck = { format: "grounds.repository-environment-check/v1", check_id: request.operation_id,
          route_id: route.route_id, database_id: route.database_id, host_id: route.host_id, request_digest: digest,
          environment, profile: "git-python-postgres-connect/v1", argv: probe(!!environment.configuration.postgres),
          state: "registered", attribution: request.attribution, created_at: await tx.now() };
        await tx.saveRuntimeRecord({ id: result.check_id, kind: "runtime_operation", parent_id: environment.revision_id, version: 1, data: { ...result } }, 0);
        await tx.completeOperation(request.operation_id, JSON.stringify(result));
        return result;
      });
      if (terminal(check)) return check;
      const executions = new CodeRouteExecutions(this.store, this.engine);
      const ref = { route_id: route.route_id, execution_id: request.operation_id };
      try {
        const engineId = await this.engine.identity(), platform = await this.engine.platform!();
        if (!platform || (check.engine_id && check.engine_id !== engineId) || (check.platform && check.platform !== platform))
          conflict("Check engine or platform changed; retain original ownership");
        check = await this.update(check.check_id, { state: "checking", engine_id: engineId, platform });
        let run = await executions.start({ ...request, argv: check.argv, mode: "read-only-diagnostic" });
        if (run.engine_id !== engineId) conflict("Engine changed during check preparation");
        // Saved exit codes come only from the exact container observation, not from caller input.
        const deadline = Date.now() + 20_000;
        while (run.state !== "stopped" && run.exit_code === undefined) {
          const observation = await executions.observe(ref);
          run = observation.execution;
          if (run.exit_code !== undefined) break;
          if (Date.now() >= deadline) return check; // Explicit same-ID continuation; no forced release.
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (run.state !== "stopped") run = await executions.stop(ref);
        if (await this.engine.identity() !== engineId || await this.engine.platform!() !== platform)
          conflict("Check engine or platform changed before completion");
        return await this.update(check.check_id, { state: run.exit_code === 0 ? "passed" : "failed",
          ...(run.exit_code !== undefined ? { exit_code: run.exit_code } : {}),
          ...(run.exit_code === 0 ? {} : { reason: run.exit_code === undefined ? "stopped-without-result" as const : "probe-failed" as const }) });
      } catch {
        // Do not guess absence, stop unknown resources, or turn a lost reply into a passed check.
        return this.update(check.check_id, { state: "needs-recovery", reason: "execution-needs-recovery" });
      }
    });
  }
}
