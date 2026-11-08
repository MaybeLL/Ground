import { failInfrastructure, isTerminal, markBlocked, markReady } from "../domain/index.js";
import type { ManagedWorkspacePort, SandboxLauncher, RuntimeOwner, SandboxRuntimePort } from "../ports/index.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";
import type { RequestContext } from "./requests.js";
import type { SandboxLifecycle } from "./sandbox-lifecycle.js";

export type Reserved = { runId: string; sandboxId: string; environmentRevisionId: string; commit: string };
export type Prepared = Reserved & { phase: "ready"; instanceId: string };
export type RecoveryDeps = RequestContext & { runtime: SandboxRuntimePort; launcher: SandboxLauncher; workspaces: ManagedWorkspacePort; lifecycle: SandboxLifecycle; ledgerId(): Promise<string> };

export class SandboxRecovery {
  constructor(private readonly deps: RecoveryDeps) {}

  async failedPreparation(reserved: Reserved, reason: string, instanceId?: string, workspacePrepared = true): Promise<Outcome<never>> {
    return this.deps.units.run("write", async r => {
      const run = await r.taskRuns.get(reserved.runId, {lock:true});
      const sandbox = await r.sandboxes.get(reserved.sandboxId, {lock:true});
      if (!run || sandbox?.phase !== "preparing") return fail("conflict", "sandbox is no longer preparing");
      const at = this.deps.now();
      const blocked = markBlocked(sandbox, { reason, at, ...(workspacePrepared ? {workspace:{ref:sandbox.id,origin:"own" as const}} : {}), ...(instanceId ? {runtime:{instanceId,environmentRevisionId:reserved.environmentRevisionId}} : {}) });
      if (!blocked.ok) return fromRejection(blocked.error);
      const failed = failInfrastructure(run, { detail: reason, at });
      if (!failed.ok) return fromRejection(failed.error);
      const launch = (await r.intents.listForSubject("launch-devcontainer","sandbox",sandbox.id))[0];
      if (launch?.state === "registered") await r.intents.save({ ...launch,state:"failed",result:{reason},updatedAt:at,version:launch.version + 1 },launch.version);
      await r.sandboxes.save(blocked.value.state,sandbox.version);
      await r.taskRuns.save(failed.value.state,run.version);
      return fail("conflict", reason);
    });
  }

  /** Never starts a second container. Completion requires both the trusted
   * post-up receipt and the exact running Docker resource under this ledger. */
  async reconcile(runId: string): Promise<Outcome<Prepared>> {
    return this.afterPreparation(runId,await this.inspectPreparation(runId));
  }

  async afterPreparation(runId: string, outcome: Outcome<Prepared>): Promise<Outcome<Prepared>> {
    const run = await this.deps.units.run("read", r => r.taskRuns.get(runId));
    if (run && isTerminal(run)) {
      const settled = await this.deps.lifecycle.settleRun(runId);
      if (!settled.ok) return settled;
      if (outcome.ok) return fail("conflict", "the run ended during preparation; its sandbox retention was applied");
    }
    return outcome;
  }

  async inspectPreparation(runId: string): Promise<Outcome<Prepared>> {
    const claim = await this.deps.units.run("read", async r => {
      const run = await r.taskRuns.get(runId);
      if (!run?.sandboxId) return undefined;
      return (await r.intents.listForSubject("launch-devcontainer", "sandbox", run.sandboxId))[0];
    });
    if (!claim) return fail("not-found", "run has no recorded devcontainer launch");
    if (claim.state === "failed") return fail("conflict", (claim.result as {reason:string}).reason);
    const payload = claim.payload as Reserved & {workspace: string};
    const owner: RuntimeOwner = { ledgerId: await this.deps.ledgerId(), sandboxId: payload.sandboxId };
    try {
      const expected = await this.deps.units.run("read", async r => (await r.sandboxes.get(owner.sandboxId))?.location);
      const location = await this.deps.runtime.location();
      if (!expected || location.daemonId !== expected.daemonId || location.hostId !== expected.hostId) return fail("conflict", "sandbox belongs to a different runtime host");
      let id = await this.deps.workspaces.receipt(owner);
      let observed = await this.deps.runtime.observe(owner);
      if (!id && claim.state === "registered") {
        const status = await this.deps.launcher.status(owner);
        if (status === "not-started") {
          const run = await this.deps.units.run("read",r => r.taskRuns.get(runId));
          if (run && isTerminal(run) && !observed && await this.deps.launcher.cancelPending(owner)) return this.failedPreparation(payload, "owner ended before devcontainer setup began");
        }
        if (status === "failed" || status === "interrupted") {
          id = await this.deps.workspaces.receipt(owner);
          observed = await this.deps.runtime.observe(owner);
          if (!id) return this.failedPreparation(payload, "devcontainer setup ended without a successful completion receipt", observed?.id);
        }
      }
      if (id && claim.state === "registered" && (!observed || (observed.id === id && observed.state !== "running"))) {
        return this.failedPreparation(payload, "the completed sandbox was stopped or removed before registration", id);
      }
      if (!id || observed?.id !== id || observed.state !== "running") return fail("unavailable", "cannot confirm the recorded running sandbox and completed devcontainer setup");
      const result = await this.deps.units.run("write", async r => {
        const intent = await r.intents.get(claim.id, {lock:true});
        if (intent?.state === "completed") return succeed(intent.result as Prepared);
        const sandbox = await r.sandboxes.get(owner.sandboxId, {lock:true});
        if (!intent || !sandbox) return fail("conflict", "sandbox launch intent is missing");
        const at = this.deps.now();
        const ready = markReady(sandbox, { workspace: {ref: owner.sandboxId, origin:"own"}, runtime: {instanceId:id, environmentRevisionId:payload.environmentRevisionId}, at });
        if (!ready.ok) return fromRejection(ready.error);
        const result: Prepared = {runId, sandboxId: owner.sandboxId, environmentRevisionId: payload.environmentRevisionId, commit: payload.commit, phase:"ready", instanceId:id};
        await r.sandboxes.save(ready.value.state, sandbox.version);
        await r.intents.save({ ...intent, state:"completed", result, updatedAt:at, version:intent.version + 1 }, intent.version);
        return succeed(result);
      });
      return result;
    } catch { return fail("unavailable", "sandbox completion could not be verified or persisted"); }
  }

  async beforeClose(workId: string): Promise<Outcome<null>> {
    const runs = await this.deps.units.run("read", async r => {
      const selected = [];
      for (const run of await r.taskRuns.listByWork(workId)) {
        if (run.sandboxId && isTerminal(run) && (await r.sandboxes.get(run.sandboxId))?.phase === "preparing") selected.push(run);
      }
      return selected;
    });
    for (const run of runs) {
      const owner = {ledgerId:await this.deps.ledgerId(),sandboxId:run.sandboxId!};
      const checked = await this.deps.runtime.exclusive(owner,() => this.inspectPreparation(run.id));
      const state = await this.deps.units.run("read", async r => ({
        phase:(await r.sandboxes.get(owner.sandboxId))?.phase,
        hasClaim:(await r.intents.listForSubject("launch-devcontainer","sandbox",owner.sandboxId)).length > 0,
      }));
      if (state.hasClaim && state.phase === "preparing" && !checked.ok) return checked;
    }
    const outstanding = await this.deps.units.run("read", async r => {
      const ids = [];
      for (const run of await r.taskRuns.listByWork(workId)) {
        if (run.sandboxId && isTerminal(run) && (await r.sandboxes.get(run.sandboxId))?.reservation?.kind === "pause") ids.push(run.id);
      }
      return ids;
    });
    for (const runId of outstanding) {
      const settled = await this.deps.lifecycle.settleRun(runId);
      if (!settled.ok) return settled;
    }
    return succeed(null);
  }
}
