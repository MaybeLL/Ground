import { attachSandbox, parseTaskContent, digestOf, isId, isTerminal, requestSandbox } from "../domain/index.js";
import type { RuntimeLocation, RuntimeOwner } from "../ports/index.js";
import type { ManagedTask } from "../domain/managed.js";
import type { EnvironmentContent } from "./environment-definitions.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";
import { once } from "./requests.js";
import type { CodeDelivery } from "./code-delivery.js";

import { SandboxRecovery, type RecoveryDeps, type Reserved, type Prepared } from "./sandbox-recovery.js";
type ProvisionDeps = RecoveryDeps & { delivery: CodeDelivery };

export class SandboxProvisioning {
  private readonly recovery: SandboxRecovery;
  constructor(private readonly deps: ProvisionDeps, recovery?: SandboxRecovery) { this.recovery = recovery ?? new SandboxRecovery(deps); }
  async reconcile(runId: string) {
    return await this.transferred(runId, false) ?? this.recovery.reconcile(runId);
  }

  private async transferred(runId: string, allowResume: boolean): Promise<Outcome<Prepared> | undefined> {
    const facts = await this.deps.units.run("read", async r => {
      const run = await r.taskRuns.get(runId);
      if (!run?.sandboxId || run.environment?.source !== "inherited") return;
      const [intent] = await r.intents.listForSubject("managed-worker", "task_run", runId);
      return {run, sandbox: await r.sandboxes.get(run.sandboxId), job: intent?.payload as {baseline:string}};
    });
    if (!facts) return;
    if (isTerminal(facts.run) || facts.run.cancelIntent || facts.sandbox?.owner.id !== runId) return fail("conflict", "run no longer controls the transferred workspace");
    if (facts.sandbox.reservation?.kind === "transfer") {
      const settled = await this.deps.lifecycle.completeTransfer(runId, allowResume);
      if (!settled.ok) return settled;
      return settled.value === "preparing" ? fail("unavailable", "setup helper is still active") : this.transferred(runId, false);
    }
    const sb = facts.sandbox;
    if (sb.phase !== "ready" || !sb.runtime || !facts.job) return fail("unavailable", "transferred sandbox is not ready");
    const owner = {ledgerId: await this.deps.ledgerId(), sandboxId: sb.id};
    const location = await this.deps.runtime.location();
    if (location.hostId !== sb.location?.hostId || location.daemonId !== sb.location.daemonId) return fail("conflict", "transferred sandbox belongs to another host");
    const observed = await this.deps.runtime.observe(owner);
    if (observed?.id !== sb.runtime.instanceId || observed.state !== "running") return fail("unavailable", "cannot verify the retained instance");
    return succeed({runId, sandboxId: sb.id, environmentRevisionId: sb.runtime.environmentRevisionId, commit: facts.job.baseline, phase: "ready", instanceId: observed.id});
  }

  async prepare(requestId: string, runId: string, repository: string): Promise<Outcome<Prepared>> {
    if (!isId(requestId) || !isId(runId)) return fail("invalid", "provide a run and operation identity");
    const authorized = await this.deps.units.run("read", async r => {
      const run = await r.taskRuns.get(runId);
      if (!run) return {missing:true};
      const revision=await r.definitions.getRevision(run.taskRevision.definitionId,run.taskRevision.revisionId);
      const task=parseTaskContent(revision?.content);
      if (!task.ok) return {unsupported:true};
      const working=task.value.kind==="working";
      if (!run.environment) return {noEnvironment:true};
      if (run.workerMode !== "managed") return {allowed:true,working};
      const [intent] = await r.intents.listForSubject("managed-worker", "task_run", runId);
      const job = intent?.payload as ManagedTask | undefined;
      const parent = run.refines ? await r.taskRuns.get(run.refines) : undefined;
      const useTaskBaseline = !run.refines || job?.freshAfterFailure || (parent?.workerMode === "external" &&
        (parent.status === "failed" || parent.status === "cancelled") && !parent.manifest);
      return {working,allowed: job?.repositoryPath === repository, baseline: job?.baseline, parentCandidate:job?.parentCandidate, useTaskBaseline};
    });
    if (authorized.missing) return fail("not-found","task run does not exist");
    if (authorized.noEnvironment) return fail("invalid","the run has no resolved environment");
    if (authorized.unsupported) return fail("unsupported","this container setup requires a coding workspace without extra material mounts");
    if (!authorized.allowed) return fail("forbidden", "this repository was not selected for the managed worker");
    const inherited = await this.transferred(runId, true);
    if (inherited) return inherited;
    const kind = "reserve-task-sandbox";
    const input = { runId, repository };
    const saved = await this.deps.units.run("read", async r => await r.intents.findByRequest(requestId) ??
      (await r.intents.listForSubject(kind, "task_run", runId))[0]);
    let location: RuntimeLocation;
    try { location = await this.deps.runtime.location(); }
    catch { return fail("unavailable", "Docker is unavailable; retry when the configured daemon is reachable"); }
    let reserved: Reserved;
    if (saved) {
      const digest = digestOf({ kind, input }, this.deps.hash);
      if (!digest.ok || saved.requestHash !== digest.value || saved.state !== "completed") return fail("request-conflict", "sandbox operation identity is already used");
      reserved = saved.result as Reserved;
      if (saved.requestId !== requestId) {
        const replay = await once<Reserved>(this.deps, {kind,input,requestId,subject:{type:"task_run",id:runId}},async () => succeed(reserved));
        if (!replay.ok) return replay;
      }
    } else {
      const base = authorized.working ? succeed({commit:null}) : authorized.baseline && authorized.useTaskBaseline ? await this.deps.delivery.freshManagedBase(repository, authorized.baseline, authorized.parentCandidate) : await this.deps.delivery.workspaceBase({ runId, repositoryPath: repository });
      if (!base.ok) return base;
      if (authorized.baseline && base.value.commit !== authorized.baseline) return fail("conflict", "the recovered delivery differs from the admitted baseline");
      const reservation = await once<Reserved>(this.deps, { kind, input, requestId, subject: {type:"task_run", id:runId} }, async r => {
        const run = await r.taskRuns.get(runId, { lock: true });
        if (!run?.environment) return fail("invalid", "the run has no resolved environment");
        if (run.sandboxId) return fail("conflict", "the run already owns a sandbox; reconcile its operation");
        const sandboxId = this.deps.newId(), at = this.deps.now();
        const attached = attachSandbox(run, { sandboxId });
        if (!attached.ok) return fromRejection(attached.error);
        const sandbox = requestSandbox({ id: sandboxId, location, owner: { type: "task_run", id: runId }, retention: run.retention, at });
        if (!sandbox.ok) return fromRejection(sandbox.error);
        await r.sandboxes.create(sandbox.value.state);
        await r.taskRuns.save(attached.value.state, run.version);
        return succeed({ runId, sandboxId, environmentRevisionId: run.environment.revision.revisionId, commit: base.value.commit });
      });
      if (!reservation.ok) return reservation;
      reserved = reservation.value;
    }
    const owner = { ledgerId: await this.deps.ledgerId(), sandboxId: reserved.sandboxId };
    const result = await this.deps.runtime.exclusive(owner, () => this.prepareOwned(runId, repository, owner, location, reserved));
    return this.recovery.afterPreparation(runId,result);
  }

  private async prepareOwned(runId: string, repository: string, owner: RuntimeOwner, location: RuntimeLocation, reserved: Reserved): Promise<Outcome<Prepared>> {
    const known = await this.deps.units.run("read", async r => {
      const run = await r.taskRuns.get(runId);
      const revision = run?.environment?.revision;
      const taskRevision = run && await r.definitions.getRevision(run.taskRevision.definitionId,run.taskRevision.revisionId);
      return { run, task:parseTaskContent(taskRevision?.content), env: revision && await r.definitions.getRevision(revision.definitionId, revision.revisionId), sandbox: await r.sandboxes.get(reserved.sandboxId) };
    });
    if (!known.env || !known.sandbox || !known.run) return fail("conflict", "reserved sandbox or environment is missing");
    if (known.sandbox.location?.daemonId !== location.daemonId || known.sandbox.location.hostId !== location.hostId) return fail("conflict", "sandbox belongs to a different host or Docker daemon");
    if (known.sandbox.phase !== "preparing") return this.recovery.inspectPreparation(runId);
    if (known.run.cancelIntent || !["pending","running"].includes(known.run.status)) return fail("conflict", "run is no longer active");
    if (!known.task.ok) return fail("invalid","frozen workspace contract is unavailable");
    const content = known.env.content as EnvironmentContent;
    if (content.format !== "grounds.devcontainer/v1") return fail("unsupported", "unsupported environment revision");
    let workspace;
    try { workspace = await this.deps.workspaces.prepare(owner, repository, reserved.commit, content,false,known.task.value.materialRepositories); }
    catch { return this.recovery.failedPreparation(reserved, "the frozen sandbox workspace could not be prepared",undefined,false); }
    const winner = await this.deps.units.run("write", async r => {
      const current = await r.taskRuns.get(runId, {lock:true});
      const sb = await r.sandboxes.get(reserved.sandboxId, {lock:true});
      if (!current || current.cancelIntent || !["pending","running"].includes(current.status) || sb?.phase !== "preparing" || sb.reservation) return false;
      const previous = await r.intents.listForSubject("launch-devcontainer", "sandbox", reserved.sandboxId);
      if (previous.length) return false;
      const at = this.deps.now(), id = this.deps.newId();
      const hash = digestOf({ reserved, workspace }, this.deps.hash);
      if (!hash.ok) throw new Error(hash.error.message);
      await r.intents.register({ id, requestId: id, requestHash: hash.value, kind: "launch-devcontainer", subject: {type:"sandbox",id:reserved.sandboxId},
        state:"registered", payload: { ...reserved, workspace: workspace.path }, updatedAt:at, createdAt:at, version:1 });
      return true;
    });
    const status = await this.deps.launcher.status(owner);
    if (winner || status === "not-started") {
      // A second explicit prepare may restart only the helper. Its durable
      // lock and journal authorize at most one devcontainer invocation.
      const live = await this.deps.units.run("read", async r => {
        const run = await r.taskRuns.get(runId);
        return run && !run.cancelIntent && !isTerminal(run) && (await r.intents.listForSubject("launch-devcontainer","sandbox",owner.sandboxId)).length === 1;
      });
      if (!live) return fail("conflict","run may no longer launch a container");
      try { await this.deps.launcher.start(owner, workspace, location); }
      catch { /* Inspect the helper's durable outcome before deciding. */ }
    }
    return this.recovery.inspectPreparation(runId);
  }

}
