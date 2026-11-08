import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hostProcessIdentity } from "./env-process.js";
import { atomicPrivateWrite, removePrivateFile, safeRead, withRuntimeLock } from "./runtime-files.js";
import { hostDirectory, managedId, queueRoot } from "./managed-host-client.js";

async function schedule() {
  const queue = hostDirectory("waiting"), slots = hostDirectory("slots");
  for (;;) {
    const waiting = readdirSync(queue).sort();
    if (!waiting.length) return;
    const occupied = new Set(readdirSync(slots));
    for (const name of waiting) {
      if (!managedId.test(name)) throw new Error("invalid queued execution");
      const path = join(queue, name);
      if (!existsSync(path)) continue;
      let ticket;
      try { ticket = JSON.parse(safeRead(path, 4096).toString()); }
      catch (error) { if (!existsSync(path)) continue; throw error; }
      if (hostProcessIdentity(ticket.pid) !== ticket.birth) {
        // A new runner must acquire the slot under its own request. A
        // previously granted slot stays occupied until stop is confirmed.
        await withRuntimeLock(queueRoot(), "ticket-" + name, async () => {
          if (existsSync(path) && JSON.parse(safeRead(path, 4096).toString()).birth === ticket.birth) removePrivateFile(path);
        }, 10_000);
      } else if (!occupied.has(name) && occupied.size < 20) {
        await withRuntimeLock(queueRoot(), "ticket-" + name, async () => {
          if (!existsSync(path) || JSON.parse(safeRead(path, 4096).toString()).birth !== ticket.birth) return;
          atomicPrivateWrite(join(slots, name), name);
          occupied.add(name);
        }, 10_000);
      }
    }
    await delay(150);
  }
}

try { await withRuntimeLock(queueRoot(), "host", schedule); }
catch (error) { if (!String(error).includes("another local controller")) process.exitCode = 1; }
