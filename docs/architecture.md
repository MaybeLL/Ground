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
- The work's conclusion and a run's acceptance are derived from the head run and the recorded gates when read, never stored. Gates themselves arrive with P1b.

## Taking over the previous model

`work/application/migration-plan.ts` is a pure mapping from a snapshot of the old tables (`ports/legacy.ts`) to work-model aggregates in their final state; `migrate-legacy.ts` runs it; `adapters/sql/legacy-reader.ts` reads the old tables and runs the ledger's own integrity check. Nothing calls it from the CLI yet; the cutover command arrives with plan phase P1.

- Identifiers are kept: an Issue becomes a task definition, its revisions become revisions with the same ids and numbers, a DevRun becomes a TaskRun with the same id. A Verification becomes a completed gate with the same id.
- Runs that refine each other form one Work. A candidate the user selected in the old ledger makes its run the head (reason `migration-selection`, the selection's own time), even when it is not a leaf. Without a selection, a single leaf becomes the head (`migration-default`); several leaves leave it unselected. If one tree has several selections, the latest wins. Submitted runs are delivered by their caller (`workerMode: none`, manifest origin `caller`); abandoned and still-open runs are cancelled with the reason recorded. Every migrated run carries `migrated`.
- A gate's evaluator is an external evaluator marked `migrated`. When the old ledger kept the review run, its session, protocol stages (from the stage log or the facts the run recorded: freeze, handoff, confirmed submit) and observed commands are kept; when it did not, no session is invented and `sessionId` is absent, so independence is unknown.
- The plan either succeeds as a whole or is refused with every problem named (a run of an unknown revision, a submitted run without a candidate, a refinement of a candidate no run produced). A verification that did not judge exactly its revision's criteria is left out and listed in the report, never reshaped. Texts longer than the new limits are shortened and counted; the full text stays in the old tables.
- Not migrated, still readable in the old tables: quality reviews, issue completions, delivery links. A completed issue does not close its works.
- The write is one transaction, registered under the request identity `migrate-legacy-ledger/v1` with the plan digest as input. Repeating it on unchanged data plans with the time the first run recorded and changes nothing (`already-migrated`); once the old data has changed it is refused (`changed`). Afterwards it reads every migrated aggregate back and compares it with the plan, re-runs the integrity check and confirms the old rows it reads are identical. A dry run stops after planning.

## Verifying a storage change

`node --import tsx --test test/work-storage.test.ts test/work-migration.test.ts` runs SQLite. Skipped backends are reported as `SKIP ... NOT verified`; a skip is not a pass. To run the other two against real servers, use the scripts that start an isolated TLS server in Docker:

```sh
node scripts/test-runtime-postgres.mjs node --import tsx --test --test-concurrency=1 --test-name-pattern="^postgres" test/work-storage.test.ts test/work-migration.test.ts
node scripts/test-runtime-mysql.mjs node --import tsx --test --test-concurrency=1 --test-name-pattern="^mysql" test/work-storage.test.ts test/work-migration.test.ts
```

They need Docker and OpenSSL. Tests that touch local data layout need an isolated `HOME` (the parallel runner provides one).
