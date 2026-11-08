import {operation} from "./operation-id.js";
import type {WorkApplication} from "../application/index.js";
import {succeed} from "../application/outcome.js";

type Child = {runId:string;executionId:string;kind?:"test-grading";allowStart:boolean};


/** The batch owns task slots in SQL. Each child uses the existing worker
 * or evaluator host and its independent stop, archive and release protocol. */
export class ExperimentDriver {
  private readonly notified = new Set<string>();
  constructor(private readonly app:WorkApplication, private readonly wake:(child:Child,requestId:string)=>Promise<void>,
    private readonly requestId:string, private readonly isRunning:(id:string,op:string)=>boolean) {}

  private async dispatch(child:Child,action:string) {
    const key = operation(this.requestId,child.executionId,action);
    if (this.notified.has(key)) return false;
    await this.wake(child,key);
    this.notified.add(key);
    return true;
  }

  async drive(batchId:string,live:boolean) {
    const snapshot = await this.app.members.schedule(batchId);
    if (!snapshot.ok) return snapshot;
    const {cancelled,pending,members} = snapshot.value;
    let active = false, changes = false;
    const blocked:string[] = [];
    if (pending && !cancelled && live) {
      const next = await this.app.members.next(batchId);
      if (!next.ok) return next;
      if (next.value.state === "started") {
        const {runId,executionId} = next.value;
        await this.dispatch({runId,executionId,allowStart:true},"run");
        return succeed({state:"running" as const});
      }
    }
    for (const member of members) {
      const terminalRun = ["delivered","failed","cancelled"].includes(member.status);
      if (!terminalRun || !member.workerDone) {
        if (cancelled && !member.cancel && !terminalRun) {
          const stop = await this.app.exec.cancel({runId:member.runId,requestId:operation(batchId,member.runId,"cancel")});
          if (!stop.ok) return stop;
        }
        const action = cancelled ? "cancel" : live ? "run" : "observe";
        changes = await this.dispatch({runId:member.runId,executionId:member.executionId,allowStart:live && !cancelled},action) || changes;
        if (!this.isRunning(member.executionId,operation(this.requestId,member.executionId,action))) blocked.push(member.key + ": " + (member.host?.detail ?? "worker needs reconciliation"));
        else active = true;
      }
      for (const id of member.waitingRules) {
        if (cancelled) {
          const stop = await this.app.grading.cancel({requestId:operation(batchId,id,"cancel-grade"),gradingId:id});
          if (!stop.ok) return stop;
        }
        if (live || cancelled) {
          const finished = await this.app.members.finishRule(id);
          if (!finished.ok) return finished;
          changes = true;
        } else blocked.push(id);
      }
      for (const grading of member.waitingTests) {
        if (cancelled && grading.status === "running") {
          const stop = await this.app.grading.cancel({requestId:operation(batchId,grading.id,"cancel-grade"),gradingId:grading.id});
          if (!stop.ok) return stop;
        }
        const action = cancelled ? "cancel" : live ? "grade" : "observe";
        changes = await this.dispatch({kind:"test-grading",runId:member.runId,executionId:grading.id,allowStart:live && !cancelled},action) || changes;
        if (!this.isRunning(grading.id,operation(this.requestId,grading.id,action))) blocked.push(grading.id + ": " + (grading.host?.detail ?? "evaluator needs reconciliation"));
        else active = true;
      }
      if (member.status !== "delivered" || cancelled) continue;
      for (const requirement of member.requirements) {
        if (requirement.records.length) continue;
        if (!live) { blocked.push(member.key); continue; }
        const request = operation(batchId,member.key,requirement.key,"initial-measurement");
        const result = await this.app.members.measure(batchId,member.key,requirement.key,request);
        if (!result.ok) { blocked.push(member.key + ": " + result.error.message); continue; }
        changes = true;
        if ("status" in result.value && result.value.status === "accepted") {
          await this.dispatch({kind:"test-grading",runId:member.runId,executionId:result.value.gradingId,allowStart:true},"grade");
        }
      }
    }
    if (active || changes) return succeed({state:"running" as const});
    if (blocked.length || pending && !cancelled) return succeed({state:"awaiting-resume" as const,detail:blocked[0] ?? "batch has unscheduled members"});
    return succeed({state:"terminal" as const});
  }
}
