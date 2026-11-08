import type { Sandbox } from "../domain/index.js";
import type { ManagedWorkspacePort, RuntimeOwner, SandboxLauncher, SandboxRuntimePort, WorkUnitOfWork } from "../ports/index.js";
import type { EnvironmentContent } from "./environment-definitions.js";
import { fail, succeed } from "./outcome.js";

type Deps = {units: WorkUnitOfWork; runtime: SandboxRuntimePort; workspaces: ManagedWorkspacePort; launcher: SandboxLauncher};

/** Called under the runtime lock for a transfer that already changed owner.
 * A separate helper journal binds a fresh setup attempt to the receiver. Its
 * workspace stays at the stable sandbox path across all setup attempts. */
export class RetainedSetup {
  constructor(private readonly deps: Deps) {}

  /** Prevent a detached helper from creating a container after the owner
   * has been cancelled. The launch lock fences the pre-marker window. */
  async fenceCancellation(owner: RuntimeOwner, operationId: string) {
    const attempt = {...owner, setupAttempt: operationId};
    let state = await this.deps.launcher.status(attempt);
    if (state === "not-started") {
      try { await this.deps.launcher.cancelPending(attempt); }
      catch {
        // A helper may hold the launch lock before writing its active marker.
        return false;
      }
      state = await this.deps.launcher.status(attempt);
    }
    return state !== "active" && state !== "not-started";
  }

  async failed(owner: RuntimeOwner, operationId: string) {
    const status = await this.deps.launcher.status({...owner, setupAttempt:operationId});
    return status === "failed" || status === "interrupted";
  }

  async verifyOrPrepare(sandbox: Sandbox, owner: RuntimeOwner, operationId: string, allowStart: boolean) {
    const {runtime, workspaces, launcher} = this.deps;
    const attempt = {...owner, setupAttempt: operationId};
    const facts = await this.deps.units.run("read", async r => {
      const receiver = await r.taskRuns.get(sandbox.owner.id);
      const initialRun = sandbox.transfers[0]?.from;
      if (!receiver?.environment || !initialRun) return;
      const [allocation] = await r.intents.listForSubject("reserve-task-sandbox", "task_run", initialRun);
      const [worker] = await r.intents.listForSubject("managed-worker", "task_run", receiver.id);
      const ref = receiver.environment.revision;
      const revision = await r.definitions.getRevision(ref.definitionId, ref.revisionId);
      if (!revision || !allocation || !worker) return;
      return {repository: (worker.payload as {repositoryPath:string}).repositoryPath,
        commit: (allocation.result as {commit:string}).commit, environment: revision.content as EnvironmentContent, ref,
        cancelled: !!receiver.cancelIntent || ["failed","delivered","cancelled"].includes(receiver.status)};
    });
    if (!facts || !sandbox.location) return fail("conflict", "retained workspace preparation facts are unavailable");
    const status = await launcher.status(attempt);
    let observed = await runtime.observe(owner);
    if (status === "not-started") {
      if (!allowStart || facts.cancelled) return fail("unavailable", "retained setup requires an explicit resume");
      const prior = {...owner, setupAttempt: sandbox.runtime?.setupAttempt};
      let previous = await launcher.status(prior);
      if (previous === "not-started") {
        await launcher.cancelPending(prior);
        previous = await launcher.status(prior);
      }
      if (previous === "active") return fail("unavailable", "previous setup still owns the workspace");
      // Validate a retained checkout before touching its old container.
      let workspace;
      try { workspace = await workspaces.prepare(owner, facts.repository, facts.commit, facts.environment, !!sandbox.workspace); }
      catch { return fail("unavailable", "cannot recover the original retained checkout or its preparation descriptor"); }
      if (observed) {
        if (!sandbox.runtime || observed.id !== sandbox.runtime.instanceId || observed.setupAttempt !== sandbox.runtime.setupAttempt || previous !== "failed" && previous !== "interrupted") {
          return fail("conflict", "the occupied container cannot be identified as the failed setup");
        }
        await runtime.remove(owner, observed.id);
      }
      try { await launcher.start(attempt, workspace, sandbox.location); }
      catch { /* The durable receipt is authoritative if the client lost its reply. */ }
      observed = await runtime.observe(owner);
    }
    const receipt = await workspaces.receipt(attempt);
    if (!receipt || observed?.id !== receipt || observed.setupAttempt !== operationId || await launcher.status(attempt) !== "completed") {
      return fail("unavailable", "the retained setup has no verified completion receipt");
    }
    return succeed({instanceId: receipt, environmentRevisionId: facts.ref.revisionId, setupAttempt: operationId});
  }
}
