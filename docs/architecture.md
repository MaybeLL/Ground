# Architecture

Current implementation structure and storage boundaries. Product meaning lives in [vision](vision.md) and the [target model](decisions/0001-target-model.md); the [implementation plan](decisions/0002-implementation-plan.md) says what is built and in which order. This page describes only what exists in the source today.

## The work model (`typescript/src/work/`)

A hexagonal subtree replacing the DevRun, Verification and evaluation paths. The CLI already calls its task, work and grade entry points (P1c); the old development services have been retired.

| Layer | Contents | May import |
| --- | --- | --- |
| `domain/` | Aggregates (definitions, task run, work, sandbox, agent execution, grading record, experiment run), derived queries, invariant checkers | itself only |
| `ports/` | Repository interfaces, storage errors, the unit of work | domain |
| `application/` | Task definitions, execution, grading and code delivery use cases | domain, ports |
| `driver/` | Synchronous driving, completion-event delivery, reconciliation (not yet written) | application, ports, domain, Node |
| `adapters/` | SQL repositories, Git archive receipts and worktrees; later devcontainer and agents | domain, ports, existing modules, Node |
| `entry/` | Task, work and grade CLI command groups | application, driver, domain |
| `composition.ts` | Wires adapters into use cases | everything |

`test/work-architecture.test.ts` checks these rules statically.

Domain code is pure: functions take the current state and a command and return `Result<Decision>` (new state, events, outcome) or a rejection. Aggregates carry a version; a decision that changes anything advances it by one and must record an event (`advance()` throws otherwise). Each aggregate exports a `*Violations` checker that storage runs on every write and read.

## Storage (work ledger protocol 2, schema 2)

Initialization creates schema metadata and twelve work-model tables. Protocol 2 distinguishes this ledger from historical databases even if their numeric schema versions coincide. A caller can initialize an empty target or attach the same compatible database. An existing database with an older protocol is rejected before DDL.

- One table per aggregate: `work_definitions`, `work_revisions`, `work_works`, `work_task_runs`, `work_sandboxes`, `work_executions`, `work_gradings`, `work_experiment_runs` (members in `work_experiment_members`), `work_intents`, `work_completion_events`, `work_counters`.
- Each aggregate row has `id`, `version`, `record_digest` and `body_json` (canonical JSON of the aggregate). What a rule needs the database to enforce is also a column: one live sandbox per runtime instance (`live_instance_id`, null once released), one task run per managed worker execution, one grading per evaluator execution, a ledger-assigned request order for gradings, one task run per experiment member.
- Writes are optimistic: `save(state, expectedVersion)` succeeds only for the version the caller read, otherwise `StorageFailure("stale")`. A state that breaks its invariants is refused (`"invalid"`); a stored row whose digest, identity or invariants do not hold is refused on read (`"integrity"`).
- Foreign keys exist only between a revision and its definition. Aggregates refer to each other by identity; the application owns cross-aggregate consistency.
- Lookups rely on composite UNIQUE constraints ending in the identity column instead of secondary indexes, because MySQL has no `CREATE INDEX IF NOT EXISTS`.
- A request identity is registered in `work_intents` (unique `request_id` plus a hash of the input); the same identity with different input raises `RequestConflict`.
- `SqlWorkUnitOfWork.run("read" | "write", ...)` runs repositories in one transaction through `SQLStore.transaction`, which shares the store's retry, compatibility check and error mapping. A read unit rejects writes.

## Use cases (`work/application/`)

`TaskExecution` admits external, human-supplied and managed work. For managed work it freezes the agent revision and records the worker intent in the same transaction as the run and its execution.

Linux host process scopes persist the kernel boot ID, namespace identities and elapsed boot time. Observation compares process birth ticks in that same clock domain. Older scopes undergo a conservative same-user census. An unavailable clock or mismatched boot identity leaves the stop observation unknown.

A scheduler for each data root grants up to twenty persistent execution slots. Each admitted job has its own runner process, database connection and CLI environment. A runner can outlive the CLI that admitted it. A lost runner continues to occupy its slot until observation verifies stop. The scheduler starts read-only reconciliation for orphaned slots. A status query can wake the scheduler after a machine restart.

At admission, the CLI resolves the selected repository path, baseline commit and publication endpoint. For a managed coding task, the runner prepares the selected devcontainer and reserves its sandbox for the execution. It persists the Docker exec identity before dispatching the provider. A detached collector records the attempt before sending the prompt, drains stdout and stderr separately, and observes the exit code. The host checks the container and daemon identity when reconciling. When the collector disappears after dispatch without a complete result, the host stops the sandbox before recording an interruption.

The worker returns the full candidate commit ID in its final message. The host imports a bundle into a temporary bare repository, checks the declared commit and its ancestry against the run baseline, then pushes and reads back the delivery tag. The temporary repository is retained until archiving finishes. Before publication, the runner checks for surviving provider processes and records the output, trajectory and stderr. A failed push leaves the execution in `archive_blocked` with its evidence available. Replaying the admission checks existing receipts. An explicit resume can publish the frozen candidate.

A managed refinement can retain the parent workspace. Continuing the head selects its retained sandbox by default. A branch can request it explicitly. The admission transaction reserves the transfer, attaches the receiving run and records the new owner and inherited environment. The runner checks the recorded daemon, setup receipt and container identity before resuming. For an interrupted setup it retains the checkout and journals a new setup attempt for the receiving run. Cancellation settles the recorded transfer against the observed container state.


- Writes: `startWork`, `continueWork`, `addBranch`, `selectHead`, `closeWork`, `registerExternalWorker`, `importTranscript`, `submit`, `declareStop`, `cancel`. Queries: `getRun`, `getWork`. Each write takes a caller-chosen request identity.
- **Requests** (`requests.ts`): a request is applied once. The same identity with the same input returns the first answer, with other input it is `request-conflict`. The intent is written in the same transaction as the effect, so a request is applied and remembered together or not at all. A refusal writes nothing and does not use the identity up.
- **Outcomes** (`outcome.ts`): refusals the caller can act on (`invalid`, `conflict`, `forbidden`, `unsupported`, `not-found`, `stale`, `request-conflict`) are returned, not thrown; damaged data and bugs are thrown.
- **Linearization**: a refinement moves the head only if the caller still sees the head it expected (`conflict` otherwise; concurrent refinements from one head have exactly one winner). `submit` checks the archive outside any transaction (`DeliveryReceiptPort`), then in one step freezes the manifest, fails the round, holds it open (`unavailable`) or lets an earlier cancellation win.
- The work's conclusion and a run's acceptance are derived from the head run and the recorded gates when read, never stored.

`Grading` is the module for gates judged by an external evaluator (a fresh session of the caller's own agent). Command-based suite measurements use a fresh evaluator sandbox, a frozen environment revision and a lease per grading command. The local scheduler reconciles durable Docker setup and command launches. Each confirmed stop returns its lease; command exit codes determine the category only after all steps stop. A lost exit result faults the grading, and cancellation takes precedence. Bounded command output is archived in SQL before sandbox release.

- `requestGate` binds a gate to the exact task revision, criteria digest, manifest, grader revision and materials, and numbers it from a ledger counter; the latest request over the same subject is the one that counts. Only a delivered run can be accepted. The one grader behind it (`builtin.independent-verification`) is created on first use with stable built-in definition and revision identities.
- `registerExternalEvaluator` issues a fresh session now (after the delivery was frozen); it must differ from the worker's session. Only that session may record protocol stages and observed commands or submit the verdict.
- The protocol is blind, freeze, reconcile, handoff, submit, in order. The freeze records the digest of the blind result and nothing afterwards may change it; a verdict is refused until the blind result was frozen. A verdict must judge exactly the task's criteria.
- A cancelled grading ends once the evaluator declares it stopped; a verdict that arrives after cancellation is only recorded.

`TaskDefinitions` creates and revises tasks (a coding task: summary, criteria with stable identities, optional context and the repository and baseline the work starts from). A revision never edits an earlier one: a run stays tied to the wording it was done against, and a refinement starts from the latest revision unless the caller pins one.

## Deliveries and archive receipts

A code delivery is a commit archived as a tag on the repository's remote (`adapters/git/tag-archive.ts`, D147). `archive` pushes `refs/tags/grounds/deliveries/<id>` without force and reads it back; the same commit again is harmless, another commit under the same identity is a conflict. The receipt is self-describing (remote, tag, commit, tree, parents) and is a delivery item's `receipt`; nothing is written to the old `candidates` table. `check` implements `DeliveryReceiptPort` by asking the remote now: a moved or removed tag or a receipt for another identity is `rejected`, an unreachable remote is `unavailable` and proves nothing.

Crash safety needs no intent log here: every use case is one transaction, and the only external effect, pushing the tag, is idempotent. If a command stops after the push and before `submit`, running it again finds the tag already in place and submits.

`CodeDelivery` ties the archive to the ledger. `deliver` resolves the commit, archives it under a delivery identity that follows the run and the commit (so running it again archives the same tag and submits the same manifest), then submits. `prepareWorkspace` gives a run a private git worktree under the repository's data directory: a first run starts at the task's baseline, a refinement at the commit the run it refines delivered, fetched back from its archive and checked against its receipt, never from what the earlier worker left on disk.

Each explicit archive repair first registers its request in `work_intents`. Its identity determines a new tag at the original remote. Readback of that exact tag can finish an interrupted request. The completed intent retains the new receipt; queries inspect it alongside the original, and workspace preparation uses the best verified archive of the frozen commit.

## Command line (`work/entry/`, `work/composition.ts`)

Three groups, each action one use case: `task` (create, revise, show, list), `work` (start, continue, branch, select, close, show, run, register, transcript, workspace, deliver, stop, cancel) and `grade` (request, register, stage, command, submit, stop, cancel, show, list); `grounds work help` lists the options. The operation id every write prints is its request identity: repeating a call with `--operation-id` is safe. `composition.ts` is the only place that wires the SQL repositories, git and the real clock together; the entry layer calls application classes and never adapters. Task text is passed as `--title` (`--summary` is an existing boolean option). A grade is a JSON file of criterion verdicts (`criterion_id`, `independent`, `reconciliation`, `final`, `rationale`, `evidence`).

The published task, work and grade schemas cover the CLI envelope and evaluator grade file. The development skill calls these commands directly.

## Legacy retirement

The old Requirement, Issue, DevRun, Candidate and Verification services and their ledger tables are retired. The standalone environment still checks repository grants, ownership and stop evidence before releasing resources. Historical runtime directories and databases remain under the owner's control.

## Verifying a storage change

`node --import tsx --test test/work-storage.test.ts` runs SQLite. Skipped backends are reported as `SKIP ... NOT verified`; a skip is not a pass. To run the other two against real servers, use the scripts that start an isolated TLS server in Docker:

```sh
node scripts/test-runtime-postgres.mjs node --import tsx --test --test-concurrency=1 --test-name-pattern="^postgres" test/work-storage.test.ts
node scripts/test-runtime-mysql.mjs node --import tsx --test --test-concurrency=1 --test-name-pattern="^mysql" test/work-storage.test.ts
```

They need Docker and OpenSSL. Tests that touch local data layout need an isolated `HOME` (the parallel runner provides one).


## Native host support

The package carries a Node-API binary for each supported operating system and architecture. It implements nonblocking shared and exclusive file locks and inspects host process identity. Grounds loads it on the first operation that needs these capabilities. Lock contention is retried by the caller, and missing host support leaves ownership and release checks in effect. The release workflow collects binaries built and tested on their respective platforms.

### Evaluation suites and historical measurements

`EvaluationSuites` resolves each selected TaskRun and frozen Candidate, checks current archive integrity (including repairs), then reads regular Git blobs from a verified tree. The suite revision stores each case's stable key, exact TaskRevision and GraderRevision, source delivery and manifest digest, answer path, and grader-only material bytes with SHA-256 digests. Git reads precede the transaction. One transaction publishes the definition revision and records the operation receipt. Replaying it does not require Git.

Each case supports independently keyed bindings to exact grader revisions. A curator can select another frozen delivery to supply later corrections or private tests. Its original and active archive receipts are stored independently of the historical source. User-defined rules fix their operation and two ordered category labels. The built-in exact-file rule compares the target delivery's file bytes against the case's reference answer. A verified tree lacking the answer file produces a mismatch. Unreadable archives cannot supply an observation. Measurements use standalone GradingRecords with their historical task run, suite revision and case key. They preserve the independent gate and original run. Historical suite queries expose material metadata. Hidden tests are stored for a sandbox evaluator in P4.

Standalone rule measurements can bind a grader revision and optional reference from a frozen delivery directly. They share rule execution and grading persistence with suite-based scoring. Their origin records the actual answer digest and reference path, run, delivery and digest without creating a suite, Work or TaskRun.

### Versioned task environments and devcontainers

A TaskRevision can name an environment definition. Starting or refining a run resolves the current revision, or a caller-specified revision of that definition, inside the run-creation transaction. The published environment stores the operator's devcontainer configuration, optional feature lockfile and expected image digest. The task's working tree supplies code. The operator's published configuration controls how the container is created.

`SandboxProvisioning` attaches a preparing sandbox to its TaskRun and records its frozen base. Its workspace adapter fetches only that commit into a private shallow repository. The devcontainer configuration and the local completion receipt live outside the workspace. A registered launch intent identifies a detached local helper. Its durable attempt marker and file lock authorize one invocation of the devcontainers CLI, which inherits the lock until it exits. The helper verifies the running image and bind mount before writing its completion receipt. Reconciliation requires the local completion receipt and the running Docker instance with the matching ledger and sandbox labels. An unresolved launch remains visible in the ledger.

Terminal task retention pauses or releases the owned resource. Lifecycle operations check the persisted runtime host and Docker daemon and serialize inspection and changes under a sandbox lock. Work closure reserves releases for its owned sandboxes in its closing transaction and checks the releases before returning success. Release retains the local workspace and records its disposition.


### Provider trajectory evidence

The Claude Code and Codex adapters map observed JSONL records to common session, message, tool call, tool result, error and provider completion events. A normalized event stores its input line and part. Unknown, malformed and oversized records remain in the raw archive. Conversion reports partial coverage and its actual record counts.

An external session can archive a generic transcript as immutable bytes. A reported reference records the session's claim. For gate admission the ledger verifies the archived streams and includes their descriptors in the binding. Reuse requires the same archived evidence fingerprint, so a historical claim-only verdict cannot stand in for a verified archive.

Raw and normalized streams use separate SHA-256 receipts. Schema 2 stores each stream in `work_evidence` and ordered binary chunks in `work_evidence_chunks`. An import writes both streams and the session binding in one transaction. `db status` checks each chunk and the digest of the whole stream. `db upgrade` adds the evidence tables to a configured protocol-2 schema-1 ledger under the migration and database identity checks.

For external and caller-supplied deliveries, the ledger reserves the candidate and its attachments before the Git push. Submission records the manifest proposal and the external session’s stop before checking receipts. Reconciliation reads the original proposal and observes the remote tag. If the push cannot be confirmed, the original delivery request can retry publication.

## Experiments

ExperimentPlans stores the immutable plan in the ledger alongside its creation request. It resolves Git sources before the write transaction and freezes the environment resolution table in that transaction. Launch verifies the historical sources are still reproducible and registers the complete repeated member list. A batch row lock serializes cancellation and admission. Each admitted member has its own managed execution, task run and derived request identity, without a Work head.

The host monitors batch controllers separately from its execution slots. The controller uses the same worker and grader hosts as standalone jobs. Observation after controller loss reconciles admitted children. Explicit resume authorizes further task and grading admission. Rule gradings receive their request sequence before archive I/O. Result queries join frozen members to runs and gradings, select the latest normal completion with the same bindings, and report subsequent grader faults alongside the adopted record.
