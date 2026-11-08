import { attachSandbox, digestOf, isId, markReady, requestSandbox } from "../domain/index.js";
import type { ManagedWorkspacePort, RuntimeOwner, SandboxRuntimePort } from "../ports/index.js";
import type { EnvironmentContent } from "./environment-definitions.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";
import type { CodeDelivery } from "./code-delivery.js";

type Reserved = { runId: string; sandboxId: string; environmentRevisionId: string; commit: string };
type Prepared = Reserved & { phase: "ready"; instanceId: string };
type ProvisionDeps = RequestContext & { runtime: SandboxRuntimePort; workspaces: ManagedWorkspacePort; delivery: CodeDelivery; ledgerId(): Promise<string> };

export class SandboxProvisioning {
  constructor(private readonly deps: ProvisionDeps) {}

  async prepare(requestId: string, runId: string, repository: string): Promise<Outcome<Prepared>> {
    if (!isId(requestId) || !isId(runId)) return fail("invalid", "provide a run and operation identity");
    const kind = "reserve-task-sandbox";
    const input = { runId, repository };
    const saved = await this.deps.units.run("read", r => r.intents.findByRequest(requestId));
    let reserved: Reserved;
    if (saved) {
      const digest = digestOf({ kind, input }, this.deps.hash);
      if (!digest.ok || saved.requestHash !== digest.value || saved.state !== "completed") return fail("request-conflict", "sandbox operation identity is already used");
      reserved = saved.result as Reserved;
    } else {
      const base = await this.deps.delivery.workspaceBase({ runId, repositoryPath: repository });
      if (!base.ok) return base;
      const reservation = await once<Reserved>(this.deps, { kind, input, requestId, subject: {type:"task_run", id:runId} }, async r => {
        const run = await r.taskRuns.get(runId, { lock: true });
        if (!run?.environment) return fail("invalid", "the run has no resolved environment");
        if (run.sandboxId) return fail("conflict", "the run already owns a sandbox; reconcile its operation");
        const sandboxId = this.deps.newId(), at = this.deps.now();
        const attached = attachSandbox(run, { sandboxId });
        if (!attached.ok) return fromRejection(attached.error);
        const sandbox = requestSandbox({ id: sandboxId, owner: { type: "task_run", id: runId }, retention: run.retention, at });
        if (!sandbox.ok) return fromRejection(sandbox.error);
        await r.sandboxes.create(sandbox.value.state);
        await r.taskRuns.save(attached.value.state, run.version);
        return succeed({ runId, sandboxId, environmentRevisionId: run.environment.revision.revisionId, commit: base.value.commit });
      });
      if (!reservation.ok) return reservation;
      reserved = reservation.value;
    }
    const owner = { ledgerId: await this.deps.ledgerId(), sandboxId: reserved.sandboxId };
    const known = await this.deps.units.run("read", async r => {
      const run = await r.taskRuns.get(runId);
      const revision = run?.environment?.revision;
      return { run, env: revision && await r.definitions.getRevision(revision.definitionId, revision.revisionId), sandbox: await r.sandboxes.get(reserved.sandboxId) };
    });
    if (!known.env || !known.sandbox || !known.run) return fail("conflict", "reserved sandbox or environment is missing");
    if (known.sandbox.phase !== "preparing") return this.reconcile(runId);
    if (known.run.cancelIntent || !["pending","running"].includes(known.run.status)) return fail("conflict", "run is no longer active");
    const content = known.env.content as EnvironmentContent;
    if (content.format !== "grounds.devcontainer/v1") return fail("unsupported", "unsupported environment revision");
    const workspace = await this.deps.workspaces.prepare(owner, repository, reserved.commit, content);
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
    if (winner) {
      try {
        if (await this.deps.runtime.observe(owner)) return fail("conflict", "an existing container has no matching launch receipt");
        const instance = await this.deps.runtime.up(owner, workspace);
        await this.deps.workspaces.record(owner, instance.id);
      } catch { return fail("unavailable", "devcontainer launch did not yield a verified completion receipt; reconcile the sandbox"); }
    }
    return this.reconcile(runId);
  }

  /** Never starts a second container. Completion requires both the trusted
   * post-up receipt and the exact running Docker resource under this ledger. */
  async reconcile(runId: string): Promise<Outcome<Prepared>> {
    const claim = await this.deps.units.run("read", async r => {
      const run = await r.taskRuns.get(runId);
      if (!run?.sandboxId) return undefined;
      return (await r.intents.listForSubject("launch-devcontainer", "sandbox", run.sandboxId))[0];
    });
    if (!claim) return fail("not-found", "run has no recorded devcontainer launch");
    const payload = claim.payload as Reserved & {workspace: string};
    const owner: RuntimeOwner = { ledgerId: await this.deps.ledgerId(), sandboxId: payload.sandboxId };
    try {
      const id = await this.deps.workspaces.receipt(owner);
      const observed = await this.deps.runtime.observe(owner);
      if (!id || observed?.id !== id || observed.state !== "running") return fail("unavailable", "cannot confirm the recorded running sandbox and completed devcontainer setup");
      return await this.deps.units.run("write", async r => {
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
    } catch { return fail("unavailable", "sandbox completion could not be verified or persisted"); }
  }
}
