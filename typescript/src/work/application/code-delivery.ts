// Delivering code and preparing the place the next worker starts in. Both touch
// a git repository and its remote, which is outside the ledger: the archive is
// written first and is idempotent, so a command that stops half way is simply
// run again.
import { isId, parseTaskContent, type Id, type TaskRun } from "../domain/index.js";
import type { ArchiveProtection, RecordedProtection, CodeArchivePort, WorkUnitOfWork, WorktreePort } from "../ports/index.js";
import { fail, failureOf, succeed, type Outcome } from "./outcome.js";
import type { Submitted, TaskExecution } from "./task-execution.js";

export type Delivered = { delivery: { id: string; commit: string; receipt: string; protection: RecordedProtection }; submitted: Submitted };
export type Workspace = { runId: Id; path: string; branch: string; base: { commit: string; from: "baseline" | "delivery"; of: string }; created: boolean };

const repositoryOf = (content: unknown): { remote?: string; baseline?: string } => {
  const r = (content as { repository?: { remote?: unknown; baseline?: unknown } } | undefined)?.repository;
  return { ...(typeof r?.remote === "string" ? { remote: r.remote } : {}), ...(typeof r?.baseline === "string" ? { baseline: r.baseline } : {}) };
};

export class CodeDelivery {
  constructor(private readonly deps: { units: WorkUnitOfWork; exec: TaskExecution; archive: CodeArchivePort; worktrees: WorktreePort }) {}

  /**
   * Archive a commit of the worker's repository and hand it in as the round's
   * delivery. The delivery identity follows the run and the commit, so
   * running the command again after an interruption archives the same tag and
   * submits the same manifest.
   */
  async deliver(input: { requestId: string; runId: Id; sessionId?: Id; repositoryPath: string; commit: string; remote?: string; protection?: ArchiveProtection; declaresStop?: boolean }): Promise<Outcome<Delivered>> {
    if (!isId(input.requestId) || !isId(input.runId)) return fail("invalid", "requestId and runId are required");
    const known = await this.taskRemote(input.runId);
    if (!known.found) return fail("not-found", `run ${input.runId} does not exist`);
    const remote = input.remote ?? known.remote;
    if (!remote) return fail("invalid", "the task names no repository remote; pass one explicitly");
    const commit = await this.deps.archive.resolveCommit(input.repositoryPath, input.commit);
    if (!commit) return fail("invalid", `${input.commit} is not a commit of ${input.repositoryPath}`);
    const deliveryId = `d-${input.runId}-${commit.slice(0, 12)}`;
    const archived = await this.deps.archive.archive({ repositoryPath: input.repositoryPath, remote, deliveryId, commit, protection: input.protection });
    if (archived.status !== "confirmed") return fail(archived.status === "unavailable" ? "unavailable" : archived.status, archived.reason);
    const submitted = await this.deps.exec.submit({ requestId: input.requestId, runId: input.runId, ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      items: [{ type: "candidate", id: deliveryId, receipt: archived.receipt }], ...(input.declaresStop ? { declaresStop: true } : {}) });
    if (!submitted.ok) return submitted;
    return succeed({ delivery: { id: deliveryId, commit: archived.commit, receipt: archived.receipt, protection: input.protection ?? { level: "unknown" } }, submitted: submitted.value });
  }

  async inspectRun(run: TaskRun, repositoryPath: string) {
    const observations = [];
    for (const item of run.manifest?.items ?? []) {
      if (item.type === "candidate") observations.push(await this.deps.archive.inspect(repositoryPath, item));
    }
    return observations;
  }

  /**
   * A private working copy for a run. A first run starts at the task's
   * baseline; a refinement starts at the commit the run it refines delivered,
   * fetched back from its archive, never from whatever the earlier worker left
   * on disk.
   */
  async prepareWorkspace(input: { runId: Id; repositoryPath: string }): Promise<Outcome<Workspace>> {
    if (!isId(input.runId)) return fail("invalid", "runId is required");
    try {
      const found = await this.deps.units.run("read", async r => {
        const run = await r.taskRuns.get(input.runId);
        if (!run) return undefined;
        const revision = await r.definitions.getRevision(run.taskRevision.definitionId, run.taskRevision.revisionId);
        const parent = run.refines ? await r.taskRuns.get(run.refines) : undefined;
        return { run, content: revision?.content, parent };
      });
      if (!found) return fail("not-found", `run ${input.runId} does not exist`);
      if (found.run.status === "delivered" || found.run.status === "failed" || found.run.status === "cancelled") return fail("conflict", `run ${found.run.id} is already ${found.run.status}`);
      let base: Workspace["base"];
      if (found.run.refines) {
        const item = found.parent?.manifest?.items.find(i => i.type === "candidate");
        if (!item) return fail("conflict", `run ${found.run.refines} delivered no code to continue from`);
        const fetched = await this.deps.archive.fetch({ repositoryPath: input.repositoryPath, receipt: item.receipt });
        if (fetched.status !== "fetched") return fail(fetched.status === "unavailable" ? "unavailable" : "conflict", fetched.reason);
        base = { commit: fetched.commit, from: "delivery", of: found.run.refines };
      } else {
        const baseline = repositoryOf(found.content).baseline;
        if (!baseline) return fail("invalid", "the task names no baseline to start from");
        const commit = await this.deps.archive.resolveCommit(input.repositoryPath, baseline);
        if (!commit) return fail("invalid", `baseline ${baseline} is not a commit of ${input.repositoryPath}`);
        base = { commit, from: "baseline", of: baseline };
      }
      const made = await this.deps.worktrees.create({ repositoryPath: input.repositoryPath, runId: input.runId, commit: base.commit });
      return succeed({ runId: input.runId, path: made.path, branch: made.branch, base, created: made.created });
    } catch (error) { const failure = failureOf(error); if (failure) return { ok: false, error: failure }; throw error; }
  }

  private async taskRemote(runId: Id): Promise<{ found: boolean; remote?: string }> {
    return this.deps.units.run("read", async r => {
      const run = await r.taskRuns.get(runId);
      if (!run) return { found: false };
      const revision = await r.definitions.getRevision(run.taskRevision.definitionId, run.taskRevision.revisionId);
      const remote = revision && parseTaskContent(revision.content).ok ? repositoryOf(revision.content).remote : undefined;
      return { found: true, ...(remote ? { remote } : {}) };
    });
  }
}
