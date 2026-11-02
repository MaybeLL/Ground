// Pure domain: aggregates, value objects, invariants and failure classes.
// No I/O and no other layer; may import only from this directory.
// See docs/decisions/0001-target-model.md; dependency rules are enforced by
// test/work-architecture.test.ts.
export * from "./kernel.js";
export * from "./definitions.js";
export * from "./task-run.js";
export * from "./work.js";
export * from "./sandbox.js";
export * from "./agent-execution.js";
export * from "./grading.js";
export * from "./experiment.js";
export * from "./queries.js";
