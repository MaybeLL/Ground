# Architecture

Current implementation structure and storage boundaries. Product meaning lives in [vision](vision.md) and the [target model](decisions/0001-target-model.md); the [implementation plan](decisions/0002-implementation-plan.md) says what is built and in which order. This page describes only what exists in the source today.

## The work model (`typescript/src/work/`)

A hexagonal subtree that will replace the DevRun, Verification and evaluation paths. It is being built layer by layer (plan phase P0); nothing outside it calls it yet.

| Layer | Contents | May import |
| --- | --- | --- |
| `domain/` | Aggregates (definitions, task run, work, sandbox, agent execution, grading record, experiment run), derived queries, invariant checkers | itself only |
| `ports/` | Repository interfaces, storage errors, the unit of work | domain |
| `application/` | Use cases (not yet written) | domain, ports |
| `driver/` | Synchronous driving, completion-event delivery, reconciliation (not yet written) | application, ports, domain, Node |
| `adapters/` | SQL repositories; later workspace, devcontainer, agents | domain, ports, existing modules, Node |
| `entry/` | CLI command groups (not yet written) | application, driver, domain |
| `composition.ts` | Wires adapters into use cases | everything |

`test/work-architecture.test.ts` checks these rules statically.

Domain code is pure: functions take the current state and a command and return `Result<Decision>` (new state, events, outcome) or a rejection. Aggregates carry a version; a decision that changes anything advances it by one and must record an event (`advance()` throws otherwise). Each aggregate exports a `*Violations` checker that storage runs on every write and read.

## Storage (schema 24)

The work tables live in the same SQL ledger as the older tables and work on SQLite, MySQL and PostgreSQL. `sql-schema.ts` appends `workSchemaStatements`, so a new ledger gets them at initialization and an older one at `grounds db migrate`. A ledger at schema 23 must be migrated explicitly before this build opens it.

- One table per aggregate: `work_definitions`, `work_revisions`, `work_works`, `work_task_runs`, `work_sandboxes`, `work_executions`, `work_gradings`, `work_experiment_runs` (members in `work_experiment_members`), `work_intents`, `work_completion_events`, `work_counters`.
- Each aggregate row has `id`, `version`, `record_digest` and `body_json` (canonical JSON of the aggregate). What a rule needs the database to enforce is also a column: one live sandbox per runtime instance (`live_instance_id`, null once released), one task run per managed worker execution, one grading per evaluator execution, a ledger-assigned request order for gradings, one task run per experiment member.
- Writes are optimistic: `save(state, expectedVersion)` succeeds only for the version the caller read, otherwise `StorageFailure("stale")`. A state that breaks its invariants is refused (`"invalid"`); a stored row whose digest, identity or invariants do not hold is refused on read (`"integrity"`).
- Foreign keys exist only between a revision and its definition. Aggregates refer to each other by identity; the application owns cross-aggregate consistency.
- Lookups rely on composite UNIQUE constraints ending in the identity column instead of secondary indexes, because MySQL has no `CREATE INDEX IF NOT EXISTS`.
- A request identity is registered in `work_intents` (unique `request_id` plus a hash of the input); the same identity with different input raises `RequestConflict`. This is separate from the older `idempotency_records`, which is tied to ledger events.
- `SqlWorkUnitOfWork.run("read" | "write", ...)` runs repositories in one transaction through `SQLStore.transaction`, which shares the store's retry, compatibility check and error mapping. A read unit rejects writes.

## Use cases (`work/application/`)

`TaskExecution` is the module for work done by the caller's own agent, or by nobody (a person supplies the manifest). Managed workers arrive with phase P4.

- Writes: `startWork`, `continueWork`, `addBranch`, `selectHead`, `closeWork`, `registerExternalWorker`, `importTranscript`, `submit`, `declareStop`, `cancel`. Queries: `getRun`, `getWork`. Each write takes a caller-chosen request identity.
- **Requests** (`requests.ts`): a request is applied once. The same identity with the same input returns the first answer, with other input it is `request-conflict`. The intent is written in the same transaction as the effect, so a request is applied and remembered together or not at all. A refusal writes nothing and does not use the identity up.
- **Outcomes** (`outcome.ts`): refusals the caller can act on (`invalid`, `conflict`, `forbidden`, `unsupported`, `not-found`, `stale`, `request-conflict`) are returned, not thrown; damaged data and bugs are thrown.
- **Linearization**: a refinement moves the head only if the caller still sees the head it expected (`conflict` otherwise; concurrent refinements from one head have exactly one winner). `submit` checks the archive outside any transaction (`DeliveryReceiptPort`), then in one step freezes the manifest, fails the round, holds it open (`unavailable`) or lets an earlier cancellation win.
- The work's conclusion and a run's acceptance are derived from the head run and the recorded gates when read, never stored.

`Grading` is the module for gates judged by an external evaluator (a fresh session of the caller's own agent). Managed and test graders arrive with P4, measures with P3.

- `requestGate` binds a gate to the exact task revision, criteria digest, manifest, grader revision and materials, and numbers it from a ledger counter; the latest request over the same subject is the one that counts. Only a delivered run can be accepted. The one grader behind it (`builtin.independent-verification`) is created on first use, under the same ids a migrated ledger carries.
- `registerExternalEvaluator` issues a fresh session now (after the delivery was frozen); it must differ from the worker's session. Only that session may record protocol stages and observed commands or submit the verdict.
- The protocol is blind, freeze, reconcile, handoff, submit, in order. The freeze records the digest of the blind result and nothing afterwards may change it; a verdict is refused until the blind result was frozen. A verdict must judge exactly the task's criteria.
- A cancelled grading ends once the evaluator declares it stopped; a verdict that arrives after cancellation is only recorded.

`TaskDefinitions` creates and revises tasks (a coding task: summary, criteria with stable identities, optional context and the repository and baseline the work starts from). A revision never edits an earlier one: a run stays tied to the wording it was done against, and a refinement starts from the latest revision unless the caller pins one.

## Deliveries and archive receipts

A code delivery is a commit archived as a tag on the repository's remote (`adapters/git/tag-archive.ts`, D147). `archive` pushes `refs/tags/grounds/deliveries/<id>` without force and reads it back; the same commit again is harmless, another commit under the same identity is a conflict. The receipt is self-describing (remote, tag, commit, tree, parents) and is a delivery item's `receipt`; nothing is written to the old `candidates` table. `check` implements `DeliveryReceiptPort` by asking the remote now: a moved or removed tag or a receipt for another identity is `rejected`, an unreachable remote is `unavailable` and proves nothing.

Crash safety needs no intent log here: every use case is one transaction, and the only external effect, pushing the tag, is idempotent. If a command stops after the push and before `submit`, running it again finds the tag already in place and submits.

`CodeDelivery` ties the archive to the ledger. `deliver` resolves the commit, archives it under a delivery identity that follows the run and the commit (so running it again archives the same tag and submits the same manifest), then submits. `prepareWorkspace` gives a run a private git worktree under the repository's data directory: a first run starts at the task's baseline, a refinement at the commit the run it refines delivered, fetched back from its archive and checked against its receipt, never from what the earlier worker left on disk.

## Command line (`work/entry/`, `work/composition.ts`)

Three groups, each action one use case: `task` (create, revise, show, list), `work` (start, continue, branch, select, close, show, run, register, transcript, workspace, deliver, stop, cancel) and `grade` (request, register, stage, command, submit, stop, cancel, show, list); `grounds work help` lists the options. The operation id every write prints is its request identity: repeating a call with `--operation-id` is safe. `composition.ts` is the only place that wires the SQL repositories, git and the real clock together; the entry layer calls application classes and never adapters. Task text is passed as `--title` (`--summary` is an existing boolean option). A grade is a JSON file of criterion verdicts (`criterion_id`, `independent`, `reconciliation`, `final`, `rationale`, `evidence`).

Not yet covered: JSON schemas for the new result types under `docs/contracts/v1` (with the skill rewrite, P1d).

## Verifying a storage change

`node --import tsx --test test/work-storage.test.ts` runs SQLite. Skipped backends are reported as `SKIP ... NOT verified`; a skip is not a pass. To run the other two against real servers, use the scripts that start an isolated TLS server in Docker:

```sh
node scripts/test-runtime-postgres.mjs node --import tsx --test --test-concurrency=1 --test-name-pattern="^postgres" test/work-storage.test.ts
node scripts/test-runtime-mysql.mjs node --import tsx --test --test-concurrency=1 --test-name-pattern="^mysql" test/work-storage.test.ts
```

They need Docker and OpenSSL. Tests that touch local data layout need an isolated `HOME` (the parallel runner provides one).
