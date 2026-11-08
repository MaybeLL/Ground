import { completeRelease, completeReservation, digestOf, isId, reserve, isTerminal, markBlocked } from "../domain/index.js";
import type { SandboxRuntimePort, WorkRepositories } from "../ports/index.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";
import type { RequestContext } from "./requests.js";

type Action = "pause" | "release";
type Result = { sandboxId: string; runId: string; phase: "blocked" | "paused" | "released" };

export class SandboxLifecycle {
  constructor(private readonly deps: RequestContext & { runtime: SandboxRuntimePort; ledgerId(): Promise<string> }) {}

  async reserve(r: WorkRepositories, requestId: string, runId: string, action: Action) {
    const digest = digestOf({ kind: "sandbox-lifecycle", runId, action }, this.deps.hash);
    if (!digest.ok || !isId(requestId) || !isId(runId)) return fail("invalid", "invalid lifecycle operation");
    const earlier = await r.intents.findByRequest(requestId);
    if (earlier) return earlier.requestHash === digest.value ? succeed({ intent: earlier, created: false }) : fail("request-conflict", "operation was used for a different action");
    const run = await r.taskRuns.get(runId, { lock: true });
    let sandbox = run?.sandboxId && await r.sandboxes.get(run.sandboxId, { lock: true });
    if (!sandbox || !run) return fail("not-found", "run has no sandbox");
    if (!isTerminal(run)) return fail("conflict", "the task run is still active");
    if (sandbox.phase === "preparing" && action === "release") {
      const starts = await r.intents.listForSubject("launch-devcontainer","sandbox",sandbox.id);
      if (starts.length) return fail("conflict", "reconcile the interrupted launch before release");
      const blocked = markBlocked(sandbox,{reason:"owner ended before launch",at:this.deps.now()});
      if (!blocked.ok) return fromRejection(blocked.error);
      await r.sandboxes.save(blocked.value.state,sandbox.version);
      sandbox = blocked.value.state;
    }
    if (!sandbox.runtime && (action !== "release" || sandbox.phase !== "blocked")) return fail("conflict", "no verified runtime for this operation");
    const at = this.deps.now(), id = this.deps.newId();
    const reserved = reserve(sandbox, { by: { type: "task_run", id: runId }, kind: action, operationId: id, at });
    if (!reserved.ok) return fromRejection(reserved.error);
    await r.sandboxes.save(reserved.value.state, sandbox.version);
    return succeed(await r.intents.register({ id, requestId, requestHash: digest.value, kind: "sandbox-lifecycle", subject: { type: "sandbox", id: sandbox.id }, state: "registered",
      payload: { action, runId, sandboxId: sandbox.id, instanceId: sandbox.runtime?.instanceId ?? null }, version: 1, createdAt: at, updatedAt: at }));

  }

  async lifecycle(requestId: string, runId: string, action: Action): Promise<Outcome<Result>> {
    const expected = await this.deps.units.run("read",async r => {
      const sb = (await r.taskRuns.get(runId))?.sandboxId;
      return sb && (await r.sandboxes.get(sb))?.location;
    });
    if (expected) {
      try {
        const actual = await this.deps.runtime.location();
        if (expected.hostId !== actual.hostId || expected.daemonId !== actual.daemonId) return fail("conflict", "sandbox belongs to a different Docker daemon or host");
      } catch { return fail("unavailable", "the recorded Docker daemon cannot be reached"); }
    }
    const registration = await this.deps.units.run("write", r => this.reserve(r, requestId, runId, action));
    if (!registration.ok) return registration;
    const { intent } = registration.value;
    if (intent.state === "completed") return succeed(intent.result as Result);
    const { sandboxId, instanceId } = intent.payload as { sandboxId: string; instanceId: string };
    const owner = { ledgerId: await this.deps.ledgerId(), sandboxId };
    let pauseObservation: "paused" | "stopped" | "absent" | undefined;
    try {
      const expected = await this.deps.units.run("read", async r => (await r.sandboxes.get(sandboxId))?.location);
      const location = await this.deps.runtime.location();
      if (!expected || location.daemonId !== expected.daemonId || location.hostId !== expected.hostId) return fail("conflict", "the recorded Docker daemon and runtime host are required");
      await this.deps.runtime.exclusive(owner, async () => {
        const active = await this.deps.runtime.location();
        if (active.daemonId !== expected.daemonId || active.hostId !== expected.hostId) throw new Error("runtime location changed");
        const saved = await this.deps.units.run("read", r => r.intents.get(intent.id));
        if (saved?.state === "completed") return;
        const observed = await this.deps.runtime.observe(owner);
        if (observed && observed.id !== instanceId) throw new Error("different instance under the ownership labels");
        if (action === "release") {
          if (observed) await this.deps.runtime.remove(owner, observed.id);
        } else {
          if (observed?.state === "running") await this.deps.runtime.pause(owner, observed.id);
        }
        const after = await this.deps.runtime.observe(owner);
        if (action === "release") {
          if (after) throw new Error("release could not be confirmed");
        } else {
          if (!after) pauseObservation = "absent";
          else {
            if (after.id !== instanceId || after.state === "running") throw new Error("cannot confirm that the owned runtime is quiescent");
            pauseObservation = after.state;
          }
        }
      });
    } catch { return fail("unavailable", "cannot confirm the reserved container operation"); }
    return this.deps.units.run("write", async r => {
      const saved = await r.intents.get(intent.id, { lock: true });
      if (saved?.state === "completed") return succeed(saved.result as Result);
      const sandbox = await r.sandboxes.get(sandboxId, { lock: true });
      if (!saved || !sandbox) return fail("conflict", "runtime reservation is missing");
      const at = this.deps.now();
      const completed = action === "release" ? completeRelease(sandbox, { operationId: saved.id, at, workspace: "retained" }) : completeReservation(sandbox, { operationId: saved.id, at, pauseObservation });
      if (!completed.ok) return fromRejection(completed.error);
      const result: Result = { sandboxId, runId, phase: action === "release" ? "released" : completed.value.state.phase === "blocked" ? "blocked" : "paused" };
      await r.sandboxes.save(completed.value.state, sandbox.version);
      await r.intents.save({ ...saved, state: "completed", result, updatedAt: at, version: saved.version + 1 }, saved.version);
      return succeed(result);
    });
  }


  async settleRun(runId: string): Promise<Outcome<null>> {
    const facts = await this.deps.units.run("read", async r => {
      const run = await r.taskRuns.get(runId);
      if (!run?.sandboxId || !isTerminal(run)) return null;
      const sandbox = await r.sandboxes.get(run.sandboxId);
      const pending = sandbox?.reservation && await r.intents.get(sandbox.reservation.operationId);
      return {run,sandbox,pending};
    });
    if (!facts?.sandbox || facts.sandbox.owner.id !== runId || facts.sandbox.phase === "released") return succeed(null);
    const {run,sandbox} = facts;
    if (sandbox.phase === "preparing") return succeed(null); // preparation reconciles a racing termination
    const prior = facts.pending?.payload as { action?: Action } | undefined;
    if (facts.pending && (prior?.action === "pause" || prior?.action === "release")) {
      const resumed = await this.lifecycle(facts.pending.requestId,run.id,prior.action);
      return resumed.ok ? succeed(null) : resumed;
    }
    const action = run.retention === "release" ? "release" : "pause";
    if (action === "pause" && (sandbox.phase === "paused" || (sandbox.phase === "blocked" && (!sandbox.runtime || sandbox.blockedRuntimeQuiescent)))) return succeed(null);
    const result = await this.lifecycle("terminal-" + action + "-" + sandbox.id,runId,action);
    return result.ok ? succeed(null) : result;
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
