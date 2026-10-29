import type { Store } from "../src/store-types.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { CodeRouteExecutions, type RouteEngine } from "../src/code-route-execution.js";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { CodeWorkspaceCleanup } from "../src/code-workspace-cleanup.js";
import { CodeRouteServiceCleanup, type ServiceSnapshot, type ServiceCleanupEngine } from "../src/code-route-service-cleanup.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";

class Resources implements ServiceCleanupEngine {
  calls = 0; loseReply = true; retirementRace = false; snapshotReads = 0;
  snapshot: ServiceSnapshot = { key: `sha256:${"1".repeat(64)}`, engine_id: "fixture", container_id: "service", network_id: "network",
    volume_name: "data", volume_created_at: "2026-10-26T00:00:00Z", log_digest: `sha256:${"2".repeat(64)}`,
    container_state: "eligible", network_state: "eligible", blockers: [] };
  async retainedVolume() { return { name: this.snapshot.volume_name, expected_created_at: this.snapshot.volume_created_at,
    state: "matching" as const, consumers: [this.snapshot.container_id] }; }
  async cleanupSnapshot() {
    const snapshot = structuredClone(this.snapshot);
    if (this.retirementRace && ++this.snapshotReads > 1) snapshot.blockers = ["volume_has_other_consumers"];
    return snapshot;
  }
  async reclaimService() {
    if (this.snapshot.container_state !== "removed") {
      this.calls++; this.snapshot.container_state = "removed"; this.snapshot.network_state = "removed";
      if (this.loseReply) throw new Error("external removal reply lost");
    }
    return { directory: "/isolated/archive", digest: this.snapshot.log_digest, review_after: "2027-01-24T00:00:00Z" };
  }
}

test("service cleanup honors ended lifecycle, retention, pins, fresh plans and original operation recovery", async t => {
  const x = await executionFixture(t), resources = new Resources();
  let container: string | undefined;
  const engine: RouteEngine = { identity: async () => "fixture", create: async () => (container = "execution"),
    find: async () => container, start: async () => {}, removeStopped: async () => { container = undefined; },
    prepareDependencies: async () => ({ kind: "postgres", network_id: "network", container_id: "service", volume_name: "data",
      host: "postgres", port: 5432, database: "task", user: "postgres" }), stopDependencies: async () => {} };
  const executions = new CodeRouteExecutions(x.ledger.store, engine);
  const version = await new RepositoryEnvironments(x.ledger.store).save({ ...actor(), environment_id: actor().operation_id,
    repository_id: x.route.repository_id, expected_version: 0, configuration: { name: "service", image: `sha256:${"a".repeat(64)}`,
      postgres: { image: `sha256:${"b".repeat(64)}` } } });
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, environment_revision_id: version.revision_id, argv: ["true"] });
  const location = { route_id: x.route.route_id, execution_id: run.execution_id }, service = new CodeRouteServiceCleanup(x.ledger.store, () => resources);
  await assert.rejects(service.preview(location), /end the Workspace/);
  await assert.rejects(service.volumePreview(location), /end the Workspace/);
  await executions.stop(location);
  await x.ledger.module.abandonDevRun({ ...actor(), dev_run_id: x.route.dev_run_id!, expected_version: 1 });
  const lifecycle = new CodeWorkspaceCleanup(x.ledger.store), end = { instance_id: x.instance.instance_id, host_id: x.hostId, data_root: x.dataRoot };
  await lifecycle.end({ ...actor(), ...end, expected_version: 0 });
  assert.equal((await service.preview(location)).gate, "retention");
  assert.ok((await service.volumePreview(location)).source.blockers.includes("retention"));
  const early = { ...location, early: true };
  assert.equal((await service.preview(early)).gate, "ready");
  await lifecycle.end({ ...actor(), ...end, expected_version: 1, pinned: true });
  const pinned = await service.preview(early);
  assert.equal(pinned.gate, "pinned");
  assert.ok((await service.volumePreview(location)).source.blockers.includes("pinned"));
  await assert.rejects(service.reclaim({ ...early, ...actor(), expected_version: 2, plan_digest: pinned.plan_digest }), /pin/);
  await lifecycle.end({ ...actor(), ...end, expected_version: 2, pinned: false, retention_days: 0 });
  const plan = await service.preview(location);
  const request = { ...location, ...actor(), expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest };
  resources.snapshot.blockers = ["unexpected_consumer"];
  assert.equal((await service.preview(location)).gate, "blocked");
  await assert.rejects(service.reclaim(request), /plan/); assert.equal(resources.calls, 0);
  resources.snapshot.blockers = [];
  await assert.rejects(service.reclaim(request), /reply lost/);
  assert.equal(resources.calls, 1);
  const result = await service.reclaim(request);
  assert.equal(result.volume.state, "retained"); assert.equal(result.container.state, "removed");
  assert.equal(resources.calls, 1);
  assert.deepEqual(await service.reclaim(request), result);
  await assert.rejects(service.reclaim({ ...request, expected_version: 4 }), /original request/);
  const retirementRequest = { ...location, ...actor() };
  // Persistence boundary: execute the real SQLite transaction, then force its rollback.
  const rollbackStore = new Proxy(x.ledger.store, { get(target, key) {
    if (key === "write") return (action: Parameters<Store["write"]>[0]) => target.write(async tx => {
      await action(tx); throw new Error("retirement transaction rolled back");
    });
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(new CodeRouteServiceCleanup(rollbackStore, () => resources).retireVolume(retirementRequest), /transaction rolled back/);
  assert.equal((await service.volumePreview(location)).source.volume.managed_writes.state, "retiring");
  resources.retirementRace = true;
  await assert.rejects(service.retireVolume(retirementRequest), /write fence retained/);
  const fenced = await service.volumePreview(location);
  assert.equal(fenced.source.volume.managed_writes.state, "retiring");
  assert.equal(fenced.source.volume.managed_writes.operation_id, retirementRequest.operation_id);
  resources.retirementRace = false;
  const resumed = await new CodeRouteServiceCleanup(x.ledger.store, () => resources).retireVolume(retirementRequest);
  assert.equal(resumed.state, "retiring");
  assert.deepEqual(await service.retireVolume(retirementRequest), resumed);
  await assert.rejects(service.retireVolume({ ...retirementRequest, ...actor() }), /original request/);
  assert.deepEqual((await x.ledger.store.inspectIntegrity()).report, { valid: true, issues: [] });
});

test("service resource cleanup commands expose public help", async () => {
  for (const action of ["service-volume-delete", "service-volume-assess", "service-volume-restoration-cleanup", "service-volume-retire", "service-volume-preview", "service-cleanup-preview", "service-cleanup", "service-volume-export", "service-volume-restore", "service-volume-restoration-show", "service-volume-restoration-stop"]) {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", action, "--help", "--json"], { stdout: line => lines.push(line), stderr: () => {} });
    assert.equal(code, 0); assertContract("cli-envelope.schema.json", JSON.parse(lines.join("\n")));
  }
});
