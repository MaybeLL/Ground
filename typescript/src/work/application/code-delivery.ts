// Delivering code and preparing the place the next worker starts in. Both touch
// a git repository and its remote, which is outside the ledger: the archive is
// written first and is idempotent, so a command that stops half way is simply
// run again.
import { readArtifact } from "./artifacts.js";
import { isTerminal, isId, parseTaskContent, type Id } from "../domain/index.js";
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
  constructor(private readonly deps: { units: WorkUnitOfWork; exec: TaskExecution; archive: CodeArchivePort; worktrees: WorktreePort; materials:import("../ports/index.js").WorkingWorkspacePort; ledgerId():Promise<string>; repairs: import("./archive-repairs.js").ArchiveRepairs }) {}

  /**
   * Archive a commit of the worker's repository and hand it in as the round's
   * delivery. The delivery identity follows the run and the commit, so
   * running the command again after an interruption archives the same tag and
   * submits the same manifest.
   */
  async deliver(input: { requestId: string; runId: Id; sessionId?: Id; repositoryPath: string; commit: string; remote?: string; protection?: ArchiveProtection; artifactIds?:string[]; declaresStop?: boolean }): Promise<Outcome<Delivered>> {
    if (!isId(input.requestId) || !isId(input.runId)) return fail("invalid", "requestId and runId are required");
    const known = await this.taskRemote(input.runId);
    if (!known.found) return fail("not-found", `run ${input.runId} does not exist`);
    if (known.managed) return fail("unsupported", "a managed round delivers through its own execution");
    if (known.working) return fail("invalid","use an explicit artifact manifest for a working task");
    const attachments = await this.deps.units.run("read",async r=>{
      const files = [], slots = new Set<string>();
      for (const id of input.artifactIds ?? []) {
        const saved = await readArtifact(r,id);
        if (!saved || saved.runId !== input.runId || slots.has(saved.slot)) return fail("invalid","select one saved artifact per slot from this run");
        slots.add(saved.slot);
        files.push({type:"artifact" as const,id,receipt:saved.receipt});
      }
      if (known.outputs?.some(slot=>slot.required && !slots.has(slot.key))) return fail("invalid","the manifest is missing a required output");
      return succeed(files);
    });
    if (!attachments.ok) return attachments;
    const remote = input.remote ?? known.remote;
    if (!remote) return fail("invalid", "the task names no repository remote; pass one explicitly");
    const commit = await this.deps.archive.resolveCommit(input.repositoryPath, input.commit);
    if (!commit) return fail("invalid", `${input.commit} is not a commit of ${input.repositoryPath}`);
    const deliveryId = `d-${input.runId}-${commit.slice(0, 12)}`;
    let previous = await this.deps.units.run("read", r => r.intents.findByRequest(input.requestId));
    if (previous?.state==="registered" && previous.kind==="submit" && previous.subject.id===input.runId && known.terminal) {
      const settled=await this.deps.exec.reconcileSubmission(input.runId);
      if (!settled.ok) return settled;
      previous=await this.deps.units.run("read",r=>r.intents.findByRequest(input.requestId));
    }
    let previousReceipt: string | undefined;
    let observedPublication=false;
    if (previous) {
      const payload = previous.payload as { items?: { id: Id; receipt: string }[] };
      const item = payload?.items?.[0];
      if (previous.kind !== "submit" || previous.subject.id !== input.runId || item?.id !== deliveryId || typeof item.receipt !== "string") {
        return fail("request-conflict", `operation ${input.requestId} belongs to a different submission`);
      }
      if (previous.state==="completed") {
        const outcome=(previous.result as Submitted).outcome;
        if (!previous.publicationConfirmed && ["cancel-wins","already-terminal"].includes(outcome)) {
          const observed=await this.deps.archive.inspect(input.repositoryPath,item);
          if (observed.tag==="unknown") return fail("unavailable","the candidate publication cannot currently be verified");
          if (observed.tag!=="unchanged") return fail("conflict","the run ended without a confirmed publication");
          observedPublication=true;
        }
        previousReceipt = item.receipt;
      }
    }
    const proposal=(receipt:string)=>({requestId:input.requestId,runId:input.runId,...(input.sessionId ? {sessionId:input.sessionId} : {}),
      items:[{type:"candidate" as const,id:deliveryId,receipt},...attachments.value],...(input.declaresStop ? {declaresStop:true} : {})});
    const archived = await this.deps.archive.archive({ observeOnly:known.terminal, repositoryPath: input.repositoryPath, remote, deliveryId, commit, protection: input.protection, previousReceipt,
      reservePublication:receipt=>this.deps.exec.reservePublication(proposal(receipt),known.terminal) });
    if (archived.status !== "confirmed") {
      if (previous && archived.status === "conflict") return fail("request-conflict", archived.reason);
      return fail(archived.status, archived.reason);
    }
    const submission=proposal(archived.receipt);
    if (!previousReceipt || observedPublication) await this.deps.exec.confirmPublication(submission);
    const submitted = await this.deps.exec.submit(submission);
    if (!submitted.ok) return submitted;
    return succeed({ delivery: { id: deliveryId, commit: archived.commit, receipt: archived.receipt, protection: input.protection ?? { level: "unknown" } }, submitted: submitted.value });
  }

  /**
   * A private working copy for a run. A first run starts at the task's
   * baseline; a refinement starts at the commit the run it refines delivered,
   * fetched back from its archive, never from whatever the earlier worker left
   * on disk.
   */
  async workspace(input:{runId:Id;repositoryPath:string}) {
    const known = await this.deps.units.run("read",async r=>{
      const run = await r.taskRuns.get(input.runId);
      if (!run) return;
      const revision = await r.definitions.getRevision(run.taskRevision.definitionId,run.taskRevision.revisionId);
      return {run,task:parseTaskContent(revision?.content)};
    });
    if (!known) return fail("not-found","task run does not exist");
    if (!known.task.ok) return fail("invalid",known.task.error.message);
    if (known.task.value.kind === "coding") {
      const workspace=await this.prepareWorkspace(input);
      if (!workspace.ok || !known.task.value.materialRepositories?.length) return workspace;
      const {materials}=await this.deps.materials.prepare(await this.deps.ledgerId(),input.runId,known.task.value.materialRepositories);
      return succeed({...workspace.value,materials});
    }
    if (["delivered","cancelled","failed"].includes(known.run.status)) return fail("conflict","the run is already terminal");
    return succeed(await this.deps.materials.prepare(await this.deps.ledgerId(),input.runId,known.task.value.materialRepositories ?? []));
  }

  async prepareWorkspace(input: { runId: Id; repositoryPath: string }): Promise<Outcome<Workspace>> {
    const base = await this.workspaceBase(input);
    if (!base.ok) return base;
    try {
      const made = await this.deps.worktrees.create({ ...input, commit: base.value.commit });
      return succeed({ runId: input.runId, path: made.path, branch: made.branch, base: base.value, created: made.created });
    } catch (error) { const failure = failureOf(error); if (failure) return { ok: false, error: failure }; throw error; }
  }

  async freshManagedBase(repository: string, commit: string, parent?: {runId:string; id:string; receipt:string}): Promise<Outcome<{commit:string}>> {
    if (await this.deps.archive.resolveCommit(repository, commit) === commit) return succeed({commit});
    if (!parent) return fail("unavailable", "the pinned task baseline is unavailable");
    const active = await this.deps.repairs.current(parent.runId, parent, repository);
    const fetched = await this.deps.archive.fetch({repositoryPath:repository, receipt:active.receipt});
    if (fetched.status !== "fetched" || fetched.commit !== commit) return fail("unavailable", "the parent archive could not supply the frozen baseline");
    return succeed({commit});
  }

  async workspaceBase(input: { runId: Id; repositoryPath: string }): Promise<Outcome<Workspace["base"]>> {
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
      const callerWithoutDelivery = found.parent && found.parent.workerMode !== "managed" &&
        (found.parent.status === "failed" || found.parent.status === "cancelled") && !found.parent.manifest;
      if (found.run.refines && !callerWithoutDelivery) {
        const item = found.parent?.manifest?.items.find(i => i.type === "candidate");
        if (!item) return fail("conflict", `run ${found.run.refines} delivered no code to continue from`);
        const { receipt } = await this.deps.repairs.current(found.run.refines, item, input.repositoryPath);
        const fetched = await this.deps.archive.fetch({ repositoryPath: input.repositoryPath, receipt });
        if (fetched.status !== "fetched") return fail(fetched.status === "unavailable" ? "unavailable" : "conflict", fetched.reason);
        base = { commit: fetched.commit, from: "delivery", of: found.run.refines };
      } else {
        const baseline = repositoryOf(found.content).baseline;
        if (!baseline) return fail("invalid", "the task names no baseline to start from");
        const commit = await this.deps.archive.resolveCommit(input.repositoryPath, baseline);
        if (!commit) return fail("invalid", `baseline ${baseline} is not a commit of ${input.repositoryPath}`);
        base = { commit, from: "baseline", of: baseline };
      }
      return succeed(base);
    } catch (error) { const failure = failureOf(error); if (failure) return { ok: false, error: failure }; throw error; }
  }

  private async taskRemote(runId: Id): Promise<{ found: boolean; terminal?:boolean; working?:boolean; outputs?:readonly {key:string;required:boolean}[]; managed?: boolean; remote?: string }> {
    return this.deps.units.run("read", async r => {
      const run = await r.taskRuns.get(runId);
      if (!run) return { found: false };
      const revision = await r.definitions.getRevision(run.taskRevision.definitionId, run.taskRevision.revisionId);
      const remote = revision && parseTaskContent(revision.content).ok ? repositoryOf(revision.content).remote : undefined;
      const parsed = parseTaskContent(revision?.content);
      return { found: true, terminal:isTerminal(run), outputs:parsed.ok ? parsed.value.outputs : undefined, working:(revision?.content as {kind?:string} | undefined)?.kind === "working", managed: run.workerMode === "managed", ...(remote ? { remote } : {}) };
    });
  }
}
