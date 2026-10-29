import test from "node:test";
import assert from "node:assert/strict";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { CodeRouteExecutions, type RouteEngine } from "../src/code-route-execution.js";

test("simple development binds and admits without an engine and refuses container development before contacting it", async t => {
  const x = await executionFixture(t, undefined, false, false, undefined, undefined, { mode: "simple", source: "argument" });
  assert.equal((await x.ledger.module.showDevRun(x.route.dev_run_id!)).execution_mode?.mode, "simple");
  let engineCalls = 0;
  const unreachable = async (): Promise<never> => { engineCalls++; throw new Error("no container engine in this platform container"); };
  const engine: RouteEngine = { identity: unreachable, create: unreachable, find: unreachable, start: unreachable, removeStopped: unreachable };
  const execution = new CodeRouteExecutions(x.ledger.store, engine);
  await assert.rejects(execution.start({ ...actor(), route_id: x.route.route_id, mode: "development", image: `sha256:${"1".repeat(64)}`, argv: ["true"] }),
    (error: any) => error.code === "STATE_CONFLICT" && /current environment/.test(error.message));
  assert.equal(engineCalls, 0);
});
