// Takes the previous ledger model over into the work model: plan, write in one
// transaction, then check. The old tables are only ever read. Running it again
// on unchanged data does nothing; running it after the old data changed is
// refused instead of mixing two states.
import { canonicalJson, type Hasher, type Id, type JsonValue, type Timestamp } from "../domain/index.js";
import { RequestConflict, type IntentRecord, type LedgerIntegrityProbe, type LegacyLedgerReader, type WorkRepositories, type WorkUnitOfWork } from "../ports/index.js";
import { BUILTIN_VERIFICATION_GRADER, GRADING_REQUEST_COUNTER } from "./builtin-grader.js";
import { planMigration, type MigrationPlan, type MigrationReport } from "./migration-plan.js";

export const MIGRATION_REQUEST_ID = "migrate-legacy-ledger/v1";

export interface MigrationDependencies {
  readonly reader: LegacyLedgerReader;
  readonly units: WorkUnitOfWork;
  readonly integrity: LedgerIntegrityProbe;
  readonly hash: Hasher;
  readonly now: () => Timestamp;
  readonly newId: () => Id;
}
export interface MigrationChecks {
  readonly integrityBefore: boolean;
  readonly integrityAfter: boolean;
  /** What the migration reads from the old tables is identical after it ran. */
  readonly legacyUnchanged: boolean;
  /** Aggregates read back from storage and found identical to the plan. */
  readonly aggregatesVerified: number;
}
export type MigrationResult =
  | { readonly status: "refused"; readonly problems: readonly string[] }
  | { readonly status: "dry-run"; readonly planDigest: string; readonly report: MigrationReport }
  | { readonly status: "migrated" | "already-migrated"; readonly planDigest: string; readonly report: MigrationReport; readonly checks: MigrationChecks }
  /** The old data is not what an earlier migration ran on. */
  | { readonly status: "changed"; readonly planDigest: string; readonly message: string };

const canonical = (value: unknown): string => canonicalJson(value as JsonValue);

export async function migrateLegacyLedger(deps: MigrationDependencies, options: { dryRun?: boolean } = {}): Promise<MigrationResult> {
  const before = await deps.integrity.check();
  if (!before.valid) return { status: "refused", problems: ["the ledger fails its integrity check before the migration", ...before.findings] };
  const snapshot = await deps.reader.read();
  // A repeat plans with the time the first run recorded, so unchanged data gives the identical result.
  const earlier = await deps.units.run("read", repositories => repositories.intents.findByRequest(MIGRATION_REQUEST_ID));
  const recorded = (earlier?.payload as { migratedAt?: Timestamp } | undefined)?.migratedAt;
  const migratedAt = recorded ?? deps.now();
  const outcome = planMigration(snapshot, { migratedAt, hash: deps.hash });
  if (!outcome.ok) return { status: "refused", problems: outcome.problems };
  const plan = outcome.plan;
  if (options.dryRun) return { status: "dry-run", planDigest: plan.digest, report: plan.report };

  let created: boolean;
  try {
    created = await deps.units.run("write", async repositories => {
      const registered = await repositories.intents.register(intentFor(plan, deps));
      if (!registered.created) return false;
      await write(repositories, plan);
      await repositories.intents.save({ ...registered.intent, state: "completed", result: plan.report as unknown as JsonValue, version: registered.intent.version + 1, updatedAt: plan.migratedAt }, registered.intent.version);
      return true;
    });
  } catch (error) {
    if (error instanceof RequestConflict) return { status: "changed", planDigest: plan.digest, message: "the old ledger changed since it was migrated; the earlier result is kept and nothing was written" };
    throw error;
  }

  const verified = await deps.units.run("read", repositories => verify(repositories, plan));
  const after = await deps.integrity.check();
  const unchanged = canonical(await deps.reader.read()) === canonical(snapshot);
  const checks: MigrationChecks = { integrityBefore: true, integrityAfter: after.valid, legacyUnchanged: unchanged, aggregatesVerified: verified };
  return { status: created ? "migrated" : "already-migrated", planDigest: plan.digest, report: plan.report, checks };
}

function intentFor(plan: MigrationPlan, deps: MigrationDependencies): IntentRecord {
  return { id: deps.newId(), requestId: MIGRATION_REQUEST_ID, requestHash: plan.digest, kind: "migrate-legacy-ledger", subject: { type: "ledger", id: "legacy" }, state: "registered",
    payload: { planDigest: plan.digest, migratedAt: plan.migratedAt }, createdAt: plan.migratedAt, updatedAt: plan.migratedAt, version: 1 };
}

async function write(r: WorkRepositories, plan: MigrationPlan): Promise<void> {
  for (const planned of plan.definitions) {
    // The built-in grader may already exist because a gate was requested before the old ledger was taken over; the same content is not a conflict.
    if (planned.definition.id === BUILTIN_VERIFICATION_GRADER.definitionId) {
      const existing = await r.definitions.getRevision(planned.definition.id, BUILTIN_VERIFICATION_GRADER.revisionId);
      if (existing) { if (existing.digest !== planned.revisions[0].digest) throw new Error("the built-in verification grader exists with other content"); continue; }
    }
    // A definition is stored at version 1 and then advanced once per revision, as publication would.
    const first = { ...planned.definition, version: 1, head: { seq: 0 } } as typeof planned.definition;
    await r.definitions.create(first);
    let current = first;
    for (const revision of planned.revisions) {
      const next = { ...current, version: current.version + 1, head: { seq: revision.seq, revisionId: revision.id, digest: revision.digest } };
      await r.definitions.save(next, current.version);
      await r.definitions.addRevision(revision);
      current = next;
    }
  }
  for (const run of plan.taskRuns) await r.taskRuns.create(run);
  for (const work of plan.works) await r.works.create(work);
  for (const grading of plan.gradings) {
    const seq = await r.sequences.next(GRADING_REQUEST_COUNTER);
    if (seq !== grading.requestSeq) throw new Error(`the grading request counter is at ${seq}, not ${grading.requestSeq}; it must start empty`);
    await r.gradings.create(grading);
  }
}

async function verify(r: WorkRepositories, plan: MigrationPlan): Promise<number> {
  let count = 0;
  const same = (what: string, stored: unknown, expected: unknown): void => {
    if (stored === undefined || canonical(stored) !== canonical(expected)) throw new Error(`${what} was not stored as planned`);
    count++;
  };
  for (const planned of plan.definitions) {
    if (planned.definition.id === BUILTIN_VERIFICATION_GRADER.definitionId) {
      // It may have been created earlier, at another time: what must hold is its content.
      same(`definition ${planned.definition.id}`, (await r.definitions.get(planned.definition.id))?.head.digest, planned.definition.head.digest);
      same(`revision ${planned.revisions[0].id}`, (await r.definitions.getRevision(planned.definition.id, planned.revisions[0].id))?.digest, planned.revisions[0].digest);
      continue;
    }
    same(`definition ${planned.definition.id}`, await r.definitions.get(planned.definition.id), planned.definition);
    for (const revision of planned.revisions) same(`revision ${revision.id}`, await r.definitions.getRevision(planned.definition.id, revision.id), revision);
  }
  for (const run of plan.taskRuns) same(`task run ${run.id}`, await r.taskRuns.get(run.id), run);
  for (const work of plan.works) same(`work ${work.id}`, await r.works.get(work.id), work);
  for (const grading of plan.gradings) same(`grading ${grading.id}`, await r.gradings.get(grading.id), grading);
  return count;
}
