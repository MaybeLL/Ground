import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { CodeRouteExecutions, type RouteEngine } from "./code-route-execution.js";
import { CodeRouteRequests, type RouteRequestReceipt } from "./code-route-requests.js";
import { withRuntimeLock } from "./runtime-files.js";
import { validation } from "./errors.js";
import type { Store } from "./store-types.js";

/** A foreground host controller. Cancellation drains an in-flight operation before stopping.
 * An uncertain error rejects without releasing execution ownership; a new controller can recover. */
export class CodeRouteController {
  constructor(private readonly store: Store, private readonly engine: RouteEngine) {}
  async serve(input: { route_id: string; execution_id: string }, options: {
    signal?: AbortSignal; interval_ms?: number;
    onReceipt?: (receipt: RouteRequestReceipt) => void | Promise<void>;
  } = {}): Promise<{ reason: "cancelled" } | { reason: "exited"; exit_code: number }> {
    const ref = structuredClone(input), interval = options.interval_ms ?? 500;
    if (!Number.isSafeInteger(interval) || interval < 10 || interval > 30_000) throw validation("interval_ms", "requires 10..30000 milliseconds");
    const executions = new CodeRouteExecutions(this.store, this.engine), requests = new CodeRouteRequests(this.store, this.engine);
    const run = await executions.show(ref), runtime = join(resolve(run.code_path, "../../../.."), "runtime");
    if (run.mode !== "development") throw validation("execution", "request controller requires development mode");
    return withRuntimeLock(runtime, `code-controller:${run.execution_id}`, async () => {
      for (;;) {
        if (options.signal?.aborted) { await executions.stop(ref); return { reason: "cancelled" }; }
        const observed = await executions.observe(ref);
        if (observed.status.state === "exited") {
          await executions.stop(ref); return { reason: "exited", exit_code: observed.status.exit_code };
        }
        const receipt = await requests.poll(ref);
        if (receipt) await options.onReceipt?.(receipt);
        try { await setTimeout(interval, undefined, { signal: options.signal }); }
        catch (error: any) { if (error.name !== "AbortError") throw error; }
      }
    });
  }
}
