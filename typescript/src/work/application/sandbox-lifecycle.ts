import { completeRelease, completeReservation, digestOf, isId, reserve, type JsonValue } from "../domain/index.js";
import type { SandboxRuntimePort, WorkRepositories } from "../ports/index.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";
import type { RequestContext } from "./requests.js";

type Action = "pause" | "resume" | "release";
type Result = { sandboxId: string; runId: string; phase: "ready" | "paused" | "released" };

export class SandboxLifecycle {
  constructor(private readonly deps: RequestContext & { runtime: SandboxRuntimePort; ledgerId(): Promise<string> }) {}

  async reserve(r: WorkRepositories, requestId: string, runId: string, action: Action) {
    const digest = digestOf({ kind: "sandbox-lifecycle", runId, action }, this.deps.hash);
    if (!digest.ok || !isId(requestId) || !isId(runId)) return fail("invalid", "invalid lifecycle operation");
    const earlier = await r.intents.findByRequest(requestId);
    if (earlier) return earlier.requestHash === digest.value ? succeed({ intent: earlier, created: false }) : fail("request-conflict", "operation was used for a different action");
    const run = await r.taskRuns.get(runId, { lock: true });
    const sandbox = run?.sandboxId && await r.sandboxes.get(run.sandboxId, { lock: true });
    if (!sandbox || !sandbox.runtime) return fail("not-found", "run has no prepared sandbox");
    const at = this.deps.now(), id = this.deps.newId();
    const reserved = reserve(sandbox, { by: { type: "task_run", id: runId }, kind: action, operationId: id, at });
    if (!reserved.ok) return fromRejection(reserved.error);
    await r.sandboxes.save(reserved.value.state, sandbox.version);
    return succeed(await r.intents.register({ id, requestId, requestHash: digest.value, kind: "sandbox-lifecycle", subject: { type: "sandbox", id: sandbox.id }, state: "registered",
      payload: { action, runId, sandboxId: sandbox.id, instanceId: sandbox.runtime.instanceId }, version: 1, createdAt: at, updatedAt: at }));

  }

  async lifecycle(requestId: string, runId: string, action: Action): Promise<Outcome<Result>> {
    const registration = await this.deps.units.run("write", r => this.reserve(r, requestId, runId, action));
    if (!registration.ok) return registration;
    const { intent } = registration.value;
    if (intent.state === "completed") return succeed(intent.result as Result);
    const { sandboxId, instanceId } = intent.payload as { sandboxId: string; instanceId: string };
    const owner = { ledgerId: await this.deps.ledgerId(), sandboxId };
    try {
      const dispatch = await this.deps.units.run("write", async r => {
        const live = await r.intents.get(intent.id, { lock: true });
        if (!live || live.state !== "registered" || (live.payload as { dispatched?: boolean }).dispatched) return false;
        await r.intents.save({ ...live, payload: { ...(live.payload as Record<string, JsonValue>), dispatched: true }, version: live.version + 1, updatedAt: this.deps.now() }, live.version);
        return true;
      });
      if (dispatch) {
        if (action === "release") await this.deps.runtime.remove(owner, instanceId);
        else await this.deps.runtime[action](owner, instanceId);
      }
      const observed = await this.deps.runtime.observe(owner);
      if (action === "release" ? observed !== null : observed?.id !== instanceId || observed.state !== (action === "resume" ? "running" : "paused")) {
        return fail("unavailable", "the reserved container operation has not been confirmed");
      }
    } catch { return fail("unavailable", "cannot confirm the reserved container operation"); }
    return this.deps.units.run("write", async r => {
      const saved = await r.intents.get(intent.id, { lock: true });
      if (saved?.state === "completed") return succeed(saved.result as Result);
      const sandbox = await r.sandboxes.get(sandboxId, { lock: true });
      if (!saved || !sandbox) return fail("conflict", "runtime reservation is missing");
      const at = this.deps.now();
      const completed = action === "release" ? completeRelease(sandbox, { operationId: saved.id, at, workspace: "retained" }) : completeReservation(sandbox, { operationId: saved.id, at });
      if (!completed.ok) return fromRejection(completed.error);
      const result: Result = { sandboxId, runId, phase: action === "release" ? "released" : action === "pause" ? "paused" : "ready" };
      await r.sandboxes.save(completed.value.state, sandbox.version);
      await r.intents.save({ ...saved, state: "completed", result, updatedAt: at, version: saved.version + 1 }, saved.version);
      return succeed(result);
    });
  }


  async reserveForClose(r: WorkRepositories, runId: string, sandboxId: string): Promise<Outcome<null>> {
    const sandbox = await r.sandboxes.get(sandboxId, { lock: true });
    if (!sandbox || sandbox.phase === "released" || sandbox.owner.id !== runId) return succeed(null);
    if (sandbox.reservation?.kind === "release") return succeed(null);
    const result = await this.reserve(r, "close-release-" + sandboxId, runId, "release");
    return result.ok ? succeed(null) : result;
  }

  async finishClose(workId: string): Promise<Outcome<null>> {
    const operations = await this.deps.units.run("read", async r => {
      const pending = [];
      for (const run of await r.taskRuns.listByWork(workId)) {
        const sandbox = run.sandboxId && await r.sandboxes.get(run.sandboxId);
        if (!sandbox || sandbox.owner.id !== run.id || sandbox.phase === "released" || sandbox.reservation?.kind !== "release") continue;
        const intent = await r.intents.get(sandbox.reservation.operationId);
        if (!intent) throw new Error("missing work close release intent");
        pending.push({ requestId: intent.requestId, runId: run.id });
      }
      return pending;
    });
    for (const op of operations) {
      const result = await this.lifecycle(op.requestId, op.runId, "release");
      if (!result.ok) return result;
    }
    return succeed(null);
  }
}
