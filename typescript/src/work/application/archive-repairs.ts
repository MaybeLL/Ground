import { digestOf, isId, type Hasher, type TaskRun } from "../domain/index.js";
import type { ArchiveObservation, Clock, CodeArchivePort, IdSource, WorkUnitOfWork } from "../ports/index.js";
import { fail, failureOf, succeed, type Outcome } from "./outcome.js";

export type RepairFact = { requestId: string; archiveId: string; runId: string; deliveryId: string; commit: string; receipt: string; recordedAt: string };
type ArchiveItem = { id: string; receipt: string };
const kind = "repair-archive";

const rank = (observation: ArchiveObservation): number => {
  switch (observation.status) {
    case "intact": return 3;
    case "ref-changed": return 2;
    case null: return 1;
    case "unavailable": return 0;
  }
};

export class ArchiveRepairs {
  constructor(private readonly deps: { units: WorkUnitOfWork; archive: CodeArchivePort; clock: Clock; ids: IdSource; hash: Hasher }) {}

  private async facts(runId: string): Promise<RepairFact[]> {
    return this.deps.units.run("read", async r => (await r.intents.listForSubject(kind, "task_run", runId))
      .filter(row => row.state === "completed").map(row => row.result as RepairFact));
  }

  private async observe(original: ArchiveItem, repositoryPath: string, facts: RepairFact[]) {
    const initial = await this.deps.archive.inspect(repositoryPath, original);
    let current = initial, receipt = original.receipt;
    const repairs = [];
    for (const fact of facts) {
      const observed = await this.deps.archive.inspect(repositoryPath, { id: fact.archiveId, receipt: fact.receipt });
      repairs.push({ ...fact, observation: observed });
      if (observed.recordedCommit === initial.recordedCommit && rank(observed) >= rank(current)) { current = observed; receipt = fact.receipt; }
    }
    const observation = facts.length
      ? { ...current, id: original.id, activeArchiveId: current.id, original: initial, repairs }
      : initial;
    return { receipt, observation };
  }

  async current(runId: string, item: ArchiveItem, repositoryPath: string) {
    const facts = (await this.facts(runId)).filter(fact => fact.deliveryId === item.id);
    return this.observe(item, repositoryPath, facts);
  }

  async inspectRun(run: TaskRun, repositoryPath: string) {
    const observations: Awaited<ReturnType<ArchiveRepairs["observe"]>>["observation"][] = [];
    const candidates = run.manifest?.items.filter(item => item.type === "candidate") ?? [];
    if (!candidates.length) return observations;
    const facts = await this.facts(run.id);
    for (const item of candidates) {
      const relevant = facts.filter(fact => fact.deliveryId === item.id);
      observations.push((await this.observe(item, repositoryPath, relevant)).observation);
    }
    return observations;
  }

  async repair(input: { requestId: string; runId: string; deliveryId: string; repositoryPath: string }): Promise<Outcome<RepairFact>> {
    const { requestId, runId, deliveryId, repositoryPath } = input;
    if (![requestId, runId, deliveryId].every(isId)) return fail("invalid", "repair needs request, run and delivery identities");
    try {
      const prepared = await this.deps.units.run("write", async r => {
        const run = await r.taskRuns.get(runId);
        if (!run) return fail("not-found", `no run ${runId}`);
        const item = run.manifest?.items.find(entry => entry.type === "candidate" && entry.id === deliveryId);
        if (run.status !== "delivered" || !item) return fail("invalid", "the run has no such frozen code delivery");
        const payload = { runId, deliveryId, receipt: item.receipt };
        const digest = digestOf({ kind, input: payload }, this.deps.hash);
        if (!digest.ok) return fail("invalid", digest.error.message);
        const parent = await r.intents.findByRequest(run.manifest!.operationId);
        const at = this.deps.clock.now();
        const { intent } = await r.intents.register({ id: this.deps.ids.next(), requestId, requestHash: digest.value, kind,
          subject: { type: "task_run", id: runId }, ...(parent ? { parentIntentId: parent.id } : {}),
          state: "registered", payload, createdAt: at, updatedAt: at, version: 1 });
        return succeed({ intent, item });
      });
      if (!prepared.ok) return prepared;
      const { intent, item } = prepared.value;
      if (intent.state === "completed") return succeed(intent.result as RepairFact);
      const archiveId = `repair-${intent.id}`;
      const earlierReceipts = (await this.facts(runId)).filter(f => f.deliveryId === deliveryId).map(f => f.receipt);
      const archived = await this.deps.archive.repair({ repositoryPath, originalId: item.id, originalReceipt: item.receipt, archiveId, earlierReceipts });
      if (archived.status !== "confirmed") return fail(archived.status, archived.reason);
      return await this.deps.units.run("write", async r => {
        const stored = await r.intents.get(intent.id, { lock: true });
        if (!stored) return fail("conflict", "the reserved repair intent is missing");
        if (stored.state === "completed") return succeed(stored.result as RepairFact);
        const recordedAt = this.deps.clock.now();
        const fact: RepairFact = { requestId, archiveId, runId, deliveryId, commit: archived.commit, receipt: archived.receipt, recordedAt };
        await r.intents.save({ ...stored, state: "completed", result: fact, version: stored.version + 1, updatedAt: recordedAt }, stored.version);
        return succeed(fact);
      });
    } catch (error) {
      const failure = failureOf(error);
      if (failure) return { ok: false, error: failure };
      throw error;
    }
  }
}
