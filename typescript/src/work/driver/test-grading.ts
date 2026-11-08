import { authorizeBridge, isGradingTerminal } from "../domain/index.js";
import type { ManagedWorkspacePort, RuntimeOwner, SandboxLauncher, SandboxRuntimePort, TestProcessPort } from "../ports/index.js";
import { fail, succeed, type Outcome } from "../application/outcome.js";
import type { TestExecution } from "../application/test-execution.js";
import type { DriveState } from "./managed-task.js";

type Observation = {state:DriveState;detail?:string;providerStopped?:boolean};
type Dependencies = {tests:TestExecution;runtime:SandboxRuntimePort;launcher:SandboxLauncher;workspaces:ManagedWorkspacePort;
  process:TestProcessPort;ledgerId():Promise<string>};

export class TestGradingDriver {
  constructor(private readonly deps:Dependencies) {}

  async drive(id:string, live:boolean):Promise<Outcome<Observation>> {
    const {tests,runtime,process,launcher,workspaces} = this.deps;
    const known = await tests.context(id);
    if (!known.ok) return known;
    const {grading,plan,grader,sandbox,environment,materials} = known.value;
    if (!sandbox) {
      if (isGradingTerminal(grading)) return succeed({state:"terminal",providerStopped:true});
      if (!live) return succeed({state:"awaiting-resume",providerStopped:true});
      const allocated = await tests.allocate(id,await runtime.location());
      return allocated.ok ? this.drive(id,live) : allocated;
    }
    const owner:RuntimeOwner = {ledgerId:await this.deps.ledgerId(),sandboxId:sandbox.id,setupAttempt:id};
    if (sandbox.phase === "released" && isGradingTerminal(grading)) return succeed({state:"terminal",providerStopped:true});
    const location = await runtime.location();
    if (location.daemonId !== sandbox.location?.daemonId || location.hostId !== sandbox.location.hostId) return fail("conflict","evaluator belongs to another runtime");
    if (isGradingTerminal(grading)) {
      const release = await tests.reserveRelease(id);
      if (!release.ok) return release;
      if (!release.value) return succeed({state:"terminal",providerStopped:true});
      const {operationId} = release.value;
      const settled = await runtime.exclusive(owner,async () => {
        let state = await launcher.status(owner);
        if (state === "not-started") {
          try { await launcher.cancelPending(owner); } catch { return false; }
          state = await launcher.status(owner);
        }
        if (state === "active" || state === "not-started") return false;
        const current = await runtime.observe(owner);
        if (current) {
          if (current.setupAttempt !== id || sandbox.runtime && current.id !== sandbox.runtime.instanceId) throw new Error("refusing to release an unrelated evaluator container");
          await runtime.remove(owner,current.id);
        }
        await process.dispose(owner);
        return true;
      });
      if (!settled) return succeed({state:"running",detail:"waiting for evaluator setup to stop"});
      const done = await tests.released(id,operationId);
      return done.ok ? succeed({state:"terminal",providerStopped:true}) : done;
    }
    if (!sandbox.runtime) {
      const setup = await launcher.status(owner);
      if (setup === "not-started") {
        if (!live) return succeed({state:"awaiting-resume",detail:"evaluator setup has not started"});
        let workspace;
        try { workspace = await process.prepare(owner,plan,environment,materials); }
        catch { return succeed({state:"blocked",detail:"frozen evaluator workspace or target could not be prepared",providerStopped:true}); }
        const current = await tests.context(id);
        if (!current.ok) return current;
        if (current.value.grading.cancelIntent || isGradingTerminal(current.value.grading)) return this.drive(id,false);
        try { await launcher.start(owner,workspace,location); }
        catch { /* A lost setup reply is reconciled through the helper's journal. */ }
      }
      const status = await launcher.status(owner);
      if (status === "active") return succeed({state:"running",detail:"preparing evaluator sandbox"});
      if (status === "not-started") return succeed({state:"awaiting-resume",detail:"evaluator setup was not dispatched"});
      const receipt = await workspaces.receipt(owner), observed = await runtime.observe(owner);
      if (status !== "completed" || !receipt || observed?.id !== receipt || observed.setupAttempt !== id || observed.state !== "running") {
        const fault = await tests.fault(id,"evaluator setup ended without a verified running instance");
        return fault.ok ? this.drive(id,false) : fault;
      }
      const ready = await tests.ready(id,receipt);
      return ready.ok ? this.drive(id,live) : ready;
    }
    const last = grading.commandSteps.at(-1);
    const active = last && last.state !== "stopped_result" && last.state !== "stopped_no_result";
    if (!active) {
      if (!live) return succeed({state:"awaiting-resume",detail:"next evaluator command has not started",providerStopped:true});
      const begun = await tests.beginStep(id,grading.commandSteps.length);
      return begun.ok ? this.drive(id,live) : begun;
    }
    const ordinal = last.ordinal, token = sandbox.lease?.token;
    if (token === undefined || !authorizeBridge(sandbox,{holder:{type:"command_step",gradingRecordId:id,ordinal},token}).ok) {
      return fail("conflict","evaluator command no longer owns its sandbox");
    }
    const result = await process.command({owner,location,containerId:sandbox.runtime.instanceId},ordinal,token,grader.commands[ordinal]!,live,!!grading.cancelIntent);
    if (result.state === "running" || result.state === "awaiting-resume") return succeed({state:result.state});
    if (result.state !== "stopped") return fail("unavailable","test command stop is unconfirmed");
    const ended = await tests.stopped(id,ordinal,token,result.exitCode);
    return ended.ok ? this.drive(id,live) : ended;
  }
}
