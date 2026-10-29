import { join, resolve } from "node:path";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { atomicPrivateWrite, privateDirectory, safeRead } from "./runtime-files.js";
import { DomainError } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import type { RouteExecution } from "./code-route-execution.js";

/** Parent and journals stay host-private; only the inbox/outbox and read-only client file are mounted. */
export function routeChannel(run: RouteExecution) {
  const root = join(resolve(run.code_path, "../../../.."), "runtime", "route-channels", run.execution_id);
  return { root, inbox: join(root, "inbox"), outbox: join(root, "outbox"), client: join(root, "client", "grounds-git") };
}
export function prepareRouteChannel(run: RouteExecution): void {
  const { inbox, outbox, client } = routeChannel(run);
  privateDirectory(inbox);
  privateDirectory(outbox);
  atomicPrivateWrite(client, readFileSync(new URL("../assets/code-route-client.py", import.meta.url)));
  chmodSync(client, 0o755);
}
export function assertChannelIdle(run: RouteExecution, requestId?: string): void {
  const path = join(routeChannel(run).root, "pending.json");
  if (existsSync(path)) {
    const pending = JSON.parse(safeRead(path, 1024).toString());
    if (!isUUIDv7(pending.request_id) || pending.request_id !== requestId)
      throw new DomainError("STATE_CONFLICT", "Recover the pending container request before controlling this execution");
  }
}
