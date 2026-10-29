import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";
import { Module } from "../src/module.js";
import { SQLStore } from "../src/sql-store.js";
import type { Store, Tx } from "../src/store-types.js";
import { assertContract } from "./schema-fixture.js";
import { testAgent, testBaseline } from "./fixture.js";

const remote = "ssh://git@example.test/team/quickstart";
const quickstartInput = {
  format: "patchledger.quickstart/v1" as const,
  requirement: {
    format: 1 as const,
    summary: "Users can start work from one business goal",
    outcomes: ["A complete development contract is available"],
    decisions: [{ statement: "One atomic publication", options: [{ key: "atomic", description: "Publish the complete graph" }], chosen_option: "atomic", trade_offs: [{ gain: "Consistent graph", sacrifice: "Larger transaction", reason: "No partially published contract" }] }],
  },
  issue: {
    format: 1 as const,
    summary: "Add the Repository quickstart entrypoint",
    goals: [{ statement: "Create the complete model atomically", criteria: ["Repository, Requirement, and Issue are bound"] }],
  },
};

const command = (operationId = newUUIDv7()) => ({
  operation_id: operationId,
  canonical_remote: remote,
  baseline: testBaseline,
  input: quickstartInput,
  attribution: testAgent,
});

test("quickstart creates a complete graph and replays the same result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-quickstart-"));
  const store = SQLStore.sqlite(join(directory, "ledger.db"));
  try {
    await store.initialize("warn");
    const module = new Module(store);
    const operationId = newUUIDv7();
    const first = await module.quickstartCreate(command(operationId));
    const replay = await module.quickstartCreate(command(operationId));

    assert.deepEqual(replay, first);
    assert.equal(first.result.repository_action, "registered");
    assert.equal(first.result.requirement_revision_number, 1);
    assert.equal(first.result.issue_revision_number, 1);
    assert.equal(first.result.next_action, "start_devrun");
    assertContract("quickstart.schema.json", quickstartInput);

    const requirement = await module.showRequirement(first.result.requirement_id);
    const issue = await module.showIssue(first.result.issue_id);
    assert.equal(issue.repository.id, first.result.repository_id);
    assert.equal(issue.requirement.id, first.result.requirement_id);
    assert.equal(issue.requirement.version, 1);
    assert.equal(requirement.requirement.id, first.result.requirement_id);
    assert.deepEqual(requirement.requirement.decisions, quickstartInput.requirement.decisions);

    const ledger = await module.listLedger();
    assert.deepEqual(ledger.events.map((event) => event.event_type), ["repository.registered", "requirement.created", "issue.created"]);
    assert.ok(ledger.events.every((event) => event.operation_id === operationId));

    await assert.rejects(
      module.quickstartCreate({ ...command(operationId), input: { ...quickstartInput, issue: { ...quickstartInput.issue, summary: "Changed" } } }),
      (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quickstart reuses an existing Repository without a registration event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-quickstart-reuse-"));
  const store = SQLStore.sqlite(join(directory, "ledger.db"));
  try {
    await store.initialize("warn");
    const module = new Module(store);
    const registered = await module.registerRepository({ operation_id: newUUIDv7(), canonical_remote: remote, attribution: testAgent });
    const operationId = newUUIDv7();
    const result = await module.quickstartCreate(command(operationId));
    assert.equal(result.result.repository_action, "resolved");
    assert.equal(result.result.repository_id, registered.result.repository_id);
    const ledger = await module.listLedger();
    const events = ledger.events.filter((event) => event.operation_id === operationId);
    assert.deepEqual(events.map((event) => event.event_type), ["requirement.created", "issue.created"]);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent quickstarts share one newly registered Repository", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-quickstart-concurrent-"));
  const database = join(directory, "ledger.db");
  const initializer = SQLStore.sqlite(database);
  await initializer.initialize("warn");
  await initializer.close();
  const leftStore = SQLStore.sqlite(database);
  const rightStore = SQLStore.sqlite(database);
  try {
    const [left, right] = await Promise.all([
      new Module(leftStore).quickstartCreate(command()),
      new Module(rightStore).quickstartCreate(command()),
    ]);
    assert.equal(left.result.repository_id, right.result.repository_id);
    assert.deepEqual([left.result.repository_action, right.result.repository_action].sort(), ["registered", "resolved"]);
    const module = new Module(leftStore);
    assert.equal((await module.listRepositories()).resources.length, 1);
    assert.equal((await module.listRequirements()).resources.length, 2);
  } finally {
    await leftStore.close();
    await rightStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a late quickstart failure rolls back Repository, Requirement, events, and operation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-quickstart-rollback-"));
  const store = SQLStore.sqlite(join(directory, "ledger.db"));
  try {
    await store.initialize("warn");
    const failingStore: Store = {
      initialize: (policy) => store.initialize(policy),
      open: () => store.open(),
      inspect: () => store.inspect(),
      inspectIntegrity: () => store.inspectIntegrity(),
      migrate: () => store.migrate(),
      read: (callback) => store.read(callback),
      close: () => Promise.resolve(),
      write: (callback) => store.write((tx) => callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "createIssue") return async () => { throw new Error("injected issue failure"); };
          const member = Reflect.get(target, property, receiver);
          return typeof member === "function" ? member.bind(target) : member;
        },
      }) as Tx)),
    };
    const operationId = newUUIDv7();
    await assert.rejects(new Module(failingStore).quickstartCreate(command(operationId)), /injected issue failure/);
    const module = new Module(store);
    assert.equal((await module.listRepositories()).resources.length, 0);
    assert.equal((await module.listRequirements()).resources.length, 0);
    assert.equal((await module.listLedger()).events.length, 0);

    const retry = await module.quickstartCreate(command(operationId));
    assert.equal(retry.result.repository_action, "registered");
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
