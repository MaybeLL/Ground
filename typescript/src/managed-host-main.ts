import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hostProcessIdentity } from "./env-process.js";
import { atomicPrivateWrite, removePrivateFile, safeRead, withRuntimeLock } from "./runtime-files.js";
import { hostDirectory, launchManaged, managedId, publishedHostEntries, queueRoot } from "./managed-host-client.js";

async function schedule() {
  const queue = hostDirectory("waiting"), slots = hostDirectory("slots");
  const attempted = new Set<string>();
  for (;;) {
    const waiting = publishedHostEntries(queue).sort();
    const occupied = new Set(publishedHostEntries(slots));
    const batches = hostDirectory("batches");
    let live = false;
    for (const slot of [...Array.from(occupied,id=>join(slots,id)), ...publishedHostEntries(batches).map(id=>join(batches,id))]) {
      let owner;
      try { owner = JSON.parse(safeRead(slot, 4096).toString()); }
      catch (error) { if (!existsSync(slot)) continue; throw error; }
      if (hostProcessIdentity(owner.pid) === owner.birth) { live = true; continue; }
      if (!attempted.has(owner.name)) {
        attempted.add(owner.name);
        await launchManaged("job", [owner.name, "recover"]);
      }
    }
    if (!waiting.length && !live) return;
    for (const name of waiting) {
      if (!managedId.test(name)) throw new Error("invalid queued execution");
      const path = join(queue, name);
      if (!existsSync(path)) continue;
      let ticket;
      try { ticket = JSON.parse(safeRead(path, 4096).toString()); }
      catch (error) { if (!existsSync(path)) continue; throw error; }
      if (hostProcessIdentity(ticket.pid) !== ticket.birth) {
        if (ticket.name && !attempted.has(ticket.name)) {
          attempted.add(ticket.name);
          await launchManaged("job", [ticket.name, "recover"]);
        }
        // A new runner must acquire the slot under its own request. A
        // previously granted slot stays occupied until stop is confirmed.
        await withRuntimeLock(queueRoot(), "ticket-" + name, async () => {
          if (existsSync(path) && JSON.parse(safeRead(path, 4096).toString()).birth === ticket.birth) removePrivateFile(path);
        }, 10_000);
      } else if (!occupied.has(name) && occupied.size < 20) {
        await withRuntimeLock(queueRoot(), "ticket-" + name, async () => {
          if (!existsSync(path) || JSON.parse(safeRead(path, 4096).toString()).birth !== ticket.birth) return;
          atomicPrivateWrite(join(slots, name), JSON.stringify(ticket));
          occupied.add(name);
        }, 10_000);
      }
    }
    await delay(150);
  }
}

try { await withRuntimeLock(queueRoot(), "host", schedule); }
catch (error) { if (!String(error).includes("another local controller")) process.exitCode = 1; }
