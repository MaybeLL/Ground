import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openStore } from "./cli.js";
import { hostProcessIdentity } from "./env-process.js";
import { hostDirectory, launchManaged, managedId, queueRoot, type HostJob } from "./managed-host-client.js";
import { atomicPrivateWrite, removePrivateFile, safeRead, withRuntimeLock } from "./runtime-files.js";
import { composeWork } from "./work/composition.js";

async function supervise(job: HostJob, name: string, observeOnly: boolean) {
  const opened = await openStore(job.config);
  try {
    if (opened.config.database.expected_database_id !== job.ledgerId) throw new Error("job ledger identity changed");
    const app = composeWork(opened.store);
    const context = await app.workers.context(job.runId);
    if (!context.ok || context.value.exec.id !== job.executionId) throw new Error("execution identity changed");
    const slot = join(hostDirectory("slots"), job.executionId);
    const ticket = join(hostDirectory("waiting"), job.executionId);
    const issued = join(hostDirectory("issued"), name);
    const birth = hostProcessIdentity(process.pid);
    if (!birth) throw new Error("cannot establish runner identity");
    const ticketLock = (fn: () => Promise<void>) => withRuntimeLock(queueRoot(), "ticket-" + job.executionId, fn, 10_000);
    try {
      let live = !observeOnly && job.allowStart && !existsSync(issued);
      if (live) {
        await ticketLock(async () => atomicPrivateWrite(ticket, JSON.stringify({pid: process.pid, birth})));
        await launchManaged("host");
        let nextWake = Date.now() + 5000;
        while (!existsSync(slot)) {
          const current = await app.workers.context(job.runId);
          if (!current.ok) throw new Error("run no longer available");
          if (current.value.run.cancelIntent || current.value.run.status === "cancelled") { live = false; break; }
          if (Date.now() >= nextWake) { await launchManaged("host"); nextWake = Date.now() + 5000; }
          await delay(250);
        }
        atomicPrivateWrite(issued, job.executionId);
      }
      for (;;) {
        const result = await app.driver.drive(job.runId, live);
        const state = result.ok ? result.value.state : "blocked";
        await app.workers.note(job.runId, state, result.ok ? result.value.detail : result.error.message);
        if (state === "running") {
          await delay(250);
          continue;
        }
        const current = await app.workers.context(job.runId);
        if (current.ok && ["verified", "idle"].includes(current.value.exec.stop)) {
          await ticketLock(async () => {
            if (existsSync(ticket)) removePrivateFile(ticket);
            if (existsSync(slot)) removePrivateFile(slot);
          });
        }
        break;
      }
    } catch {
      await app.workers.note(job.runId, "blocked", "host observation failed; inspect the run and resume explicitly");
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
const observeOnly = process.argv[3] === "observe";
try {
  await withRuntimeLock(queueRoot(), "execution-" + executionId, () => supervise(job, name, observeOnly), observeOnly ? 0 : 600_000);
} catch (error) {
  if (!observeOnly || !String(error).includes("another local controller")) throw error;
}
