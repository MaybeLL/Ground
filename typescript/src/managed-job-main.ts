import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openStore } from "./cli.js";
import { hostProcessIdentity } from "./env-process.js";
import { ExperimentDriver } from "./work/driver/experiment.js";
import { hostDirectory, notifyManaged, managedActivityLive, managedRequestRunning, launchManaged, managedId, queueRoot, type HostJob } from "./managed-host-client.js";
import { atomicPrivateWrite, removePrivateFile, safeRead, withRuntimeLock } from "./runtime-files.js";
import { composeWork } from "./work/composition.js";

async function supervise(job: HostJob, name: string, observeOnly: boolean) {
  const opened = await openStore(job.config);
  try {
    if (opened.config.database.expected_database_id !== job.ledgerId) throw new Error("job ledger identity changed");
    const fallback = join(hostDirectory("recovery-status"), job.executionId);
    if (existsSync(fallback)) removePrivateFile(fallback);
    const app = composeWork(opened.store);
    if (job.kind === "experiment") {
      if (job.executionId !== job.runId) throw new Error("invalid batch identity");
      const birth = hostProcessIdentity(process.pid);
      if (!birth) throw new Error("cannot establish batch controller identity");
      const owner = join(hostDirectory("batches"),job.runId), issued = join(hostDirectory("issued"),name);
      const drive = new ExperimentDriver(app,(child,requestId)=>notifyManaged({...child,ledgerId:job.ledgerId,config:job.config},requestId),name,(id,op)=>managedRequestRunning(id,op) || managedActivityLive(id));
      const live = !observeOnly && job.allowStart && !existsSync(issued);
      atomicPrivateWrite(owner,JSON.stringify({pid:process.pid,birth,name}));
      try {
        await launchManaged("host");
        if (live) atomicPrivateWrite(issued,job.executionId);
        for (;;) {
          const result = await drive.drive(job.runId,live);
          const state = result.ok ? result.value.state : "blocked";
          await app.members.note(job.runId,state,result.ok ? ("detail" in result.value ? result.value.detail : undefined) : result.error.message);
          if (state !== "running") break;
          await delay(250);
        }
      } catch {
        await app.members.note(job.runId,"blocked","batch observation failed; inspect the members and resume");
      } finally { if (existsSync(owner)) removePrivateFile(owner); }
      return;
    }
    const test = job.kind === "test-grading";
    const status = async () => {
      if (test) {
        const current = await app.tests.context(job.executionId);
        if (!current.ok || current.value.plan.runId !== job.runId) throw new Error("evaluator job identity changed");
        return {cancelled:!!current.value.grading.cancelIntent || current.value.grading.status === "cancelled",
          stopped:current.value.sandbox?.phase === "released"};
      }
      const current = await app.workers.context(job.runId);
      if (!current.ok || current.value.exec.id !== job.executionId) throw new Error("worker execution identity changed");
      return {cancelled:!!current.value.run.cancelIntent || current.value.run.status === "cancelled",
        stopped:["verified","idle"].includes(current.value.exec.stop)};
    };
    const drive = (live:boolean) => test ? app.testDriver.drive(job.executionId,live) : app.driver.drive(job.runId,live);
    const note = (state:string,detail?:string) => test ? app.tests.note(job.executionId,state,detail) : app.workers.note(job.runId,state,detail);
    await status();
    const slot = join(hostDirectory("slots"), job.executionId);
    const ticket = join(hostDirectory("waiting"), job.executionId);
    const issued = join(hostDirectory("issued"), name);
    const birth = hostProcessIdentity(process.pid);
    if (!birth) throw new Error("cannot establish runner identity");
    const ticketLock = (fn: () => Promise<void>) => withRuntimeLock(queueRoot(), "ticket-" + job.executionId, fn, 10_000);
    try {
      let live = !observeOnly && job.allowStart && !existsSync(issued);
      if (live) {
        await ticketLock(async () => atomicPrivateWrite(ticket, JSON.stringify({pid: process.pid, birth, name})));
        await launchManaged("host");
        let nextWake = Date.now() + 5000;
        while (!existsSync(slot)) {
          if ((await status()).cancelled) { live = false; break; }
          if (Date.now() >= nextWake) { await launchManaged("host"); nextWake = Date.now() + 5000; }
          await delay(250);
        }
        if (live) await ticketLock(async () => {
          atomicPrivateWrite(slot, JSON.stringify({pid: process.pid, birth, name}));
        });
        atomicPrivateWrite(issued, job.executionId);
      }
      for (;;) {
        const result = await drive(live);
        const state = result.ok ? result.value.state : "blocked";
        await note(state, result.ok ? result.value.detail : result.error.message);
        if (state === "running") {
          await delay(250);
          continue;
        }
        if (result.ok && result.value.providerStopped || (await status()).stopped) {
          await ticketLock(async () => {
            if (existsSync(ticket)) removePrivateFile(ticket);
            if (existsSync(slot)) removePrivateFile(slot);
          });
        }
        break;
      }
    } catch {
      await note("blocked", "host observation failed; inspect the run and resume explicitly");
    } finally {
      await ticketLock(async () => { if (existsSync(ticket)) removePrivateFile(ticket); });
    }
  } finally { await opened.store.close(); }
}

const name = process.argv[2] ?? "";
const [executionId, operationId] = name.split(".");
if (!executionId || !operationId || name !== executionId + "." + operationId || ![executionId, operationId].every(id => managedId.test(id))) {
  throw new Error("invalid managed operation");
}
const job = JSON.parse(safeRead(join(hostDirectory("requests"), name), 32768).toString()) as HostJob;
if (executionId !== job.executionId) throw new Error("execution identity mismatch");
// A repeated notification for the same run must never start a second driver.
const observeOnly = ["observe", "recover"].includes(process.argv[3] ?? "");
try {
  await withRuntimeLock(queueRoot(), "execution-" + executionId, () => supervise(job, name, observeOnly), observeOnly ? 0 : 600_000);
} catch (error) {
  if (String(error).includes("another local controller") && observeOnly) {
    // The authorized runner still supervises this execution.
  } else if (process.argv[3] === "recover") {
    atomicPrivateWrite(join(hostDirectory("recovery-status"), executionId), JSON.stringify({ledgerId: job.ledgerId,
      state: "awaiting-resume", detail: "automatic reconciliation needs the execution's original database or runtime context"}));
  } else throw error;
}
