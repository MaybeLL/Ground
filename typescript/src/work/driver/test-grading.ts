import type {AgentGradingDriver} from "./agent-grading.js";
import {TestTargetFault} from "../ports/index.js";
import { authorizeBridge, isGradingTerminal } from "../domain/index.js";
import type { ManagedWorkspacePort, RuntimeOwner, SandboxLauncher, SandboxRuntimePort, TestProcessPort } from "../ports/index.js";
import { fail, succeed, type Outcome } from "../application/outcome.js";
import type { ArchiveRepairs } from "../application/archive-repairs.js";
import type { TestExecution } from "../application/test-execution.js";
import type { DriveState } from "./managed-task.js";

type Observation = {state:DriveState;detail?:string;providerStopped?:boolean};
type Dependencies = {tests:TestExecution;agents:AgentGradingDriver;repairs:ArchiveRepairs;runtime:SandboxRuntimePort;launcher:SandboxLauncher;workspaces:ManagedWorkspacePort;
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
        } else await runtime.removeDependents?.(owner);
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
        if (!live) {
          if (launcher.dispatched?.(owner) === false) return succeed({state:"awaiting-resume",detail:"evaluator setup has not started",providerStopped:true});
          // Fence a helper that may have been spawned just before the host
          // died. It must acquire this same lock before creating a container.
          try {
            if (await launcher.cancelPending(owner)) {
              const ended = await tests.fault(id,"evaluator setup dispatch was interrupted");
              return ended.ok ? this.drive(id,false) : ended;
            }
          } catch { /* The live helper owns the launch lock. */ }
          return succeed({state:"running",detail:"reconciling evaluator setup dispatch"});
        }
        let workspace;
        try {
          let target = plan;
          const original = plan.originalReceipt ?? (plan.archiveId === plan.deliveryId ? plan.receipt : undefined);
          if (original && plan.commit!==null) {
            const {observation,receipt} = await this.deps.repairs.current(plan.runId,{id:plan.deliveryId,receipt:original},plan.repository);
            if (observation.recordedCommit !== plan.commit || !["intact","ref-changed"].includes(observation.status ?? "")) {
              return succeed({state:"blocked",detail:"frozen evaluator target archive could not be verified",providerStopped:true});
            }
            target = {...plan,archiveId:"activeArchiveId" in observation ? observation.activeArchiveId : plan.deliveryId,receipt};
          }
          workspace = await process.prepare(owner,target,environment,materials,grader.strategy);
        }
        catch (error) {
          if (error instanceof TestTargetFault) {
            const fault=await tests.fault(id,error.message);
            return fault.ok ? this.drive(id,false) : fault;
          }
          return succeed({state:"blocked",detail:"frozen evaluator workspace or target could not be prepared",providerStopped:true});
        }
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
    if (grader.strategy==="agent") return this.deps.agents.drive(id,{owner,location,containerId:sandbox.runtime.instanceId},grader,known.value.task,live,!!grading.cancelIntent);
    const last = grading.commandSteps.at(-1);
    const active = last && last.state !== "stopped_result" && last.state !== "stopped_no_result";
    if (!active) {
      if (!live) {
        const actual = await runtime.observe(owner);
        if (actual && (actual.id !== sandbox.runtime.instanceId || actual.setupAttempt !== id)) return fail("conflict","evaluator instance identity changed");
        if (actual && actual.state !== "stopped") await runtime.stop(owner,actual.id);
        return succeed({state:"awaiting-resume",detail:"next evaluator command has not started",providerStopped:true});
      }
      const begun = await tests.beginStep(id,grading.commandSteps.length);
      return begun.ok ? this.drive(id,live) : begun;
    }
    const ordinal = last.ordinal, token = sandbox.lease?.token;
    if (token === undefined || !authorizeBridge(sandbox,{holder:{type:"command_step",gradingRecordId:id,ordinal},token}).ok) {
      return fail("conflict","evaluator command no longer owns its sandbox");
    }
    const result = await process.command({owner,location,containerId:sandbox.runtime.instanceId},ordinal,token,grader.commands[ordinal]!,live,!!grading.cancelIntent);
    if (result.state === "running" || result.state === "awaiting-resume") return succeed(result);
    if (result.state !== "stopped") return fail("unavailable","test command stop is unconfirmed");
    const output = await process.output(owner,ordinal,token);
    const ended = await tests.stopped(id,ordinal,token,result.exitCode,output);
    return ended.ok ? this.drive(id,live) : ended;
  }
}
