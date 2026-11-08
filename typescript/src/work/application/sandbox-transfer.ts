import { applyTransfer, attachSandbox, isTerminal, parseTaskContent, reserve, resolveEnvironment,
  type Revision, type Sandbox, type TaskRun } from "../domain/index.js";
import type { WorkRepositories } from "../ports/index.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";

export type SandboxChoice = "inherit" | "fresh";

export async function selectRetainedSandbox(r: WorkRepositories, parent: TaskRun, mode: TaskRun["workerMode"],
  choice: SandboxChoice | undefined, onHead: boolean): Promise<Outcome<Sandbox | undefined>> {
  const eligible = mode === "managed" && parent.workerMode === "managed" && parent.retention === "keep" && parent.sandboxId;
  if (choice === "fresh" || (!onHead && !choice)) return succeed(undefined);
  if (!eligible) return choice === "inherit" ? fail("conflict", "the parent has no transferable managed sandbox") : succeed(undefined);
  const sandbox = await r.sandboxes.get(eligible, {lock: true});
  if (!sandbox || sandbox.owner.id !== parent.id || sandbox.phase === "released") {
    return fail("conflict", "the retained sandbox belongs to another run or has been released; select a fresh sandbox");
  }
  return succeed(sandbox);
}

export async function inheritedEnvironment(r:WorkRepositories,parent: TaskRun, revision: Revision, override?: string) {
  const content = parseTaskContent(revision.content);
  if (!content.ok) return fromRejection(content.error);
  const prior=await r.definitions.getRevision(parent.taskRevision.definitionId,parent.taskRevision.revisionId);
  const original=parseTaskContent(prior?.content);
  const materials=(c:typeof content.value)=>JSON.stringify([...(c.materialRepositories ?? [])].sort((a,b)=>a.name.localeCompare(b.name)));
  if (!original.ok || original.value.kind!==content.value.kind || materials(original.value)!==materials(content.value)) {
    return fail("conflict","the retained workspace has a different task kind or material binding; select a fresh sandbox");
  }
  const environment = parent.environment?.revision;
  if (!environment || override && override !== environment.revisionId || content.value.environmentDefinitionId !== environment.definitionId) {
    return fail("conflict", "the selected environment differs from the retained sandbox; select a fresh sandbox");
  }
  return resolveEnvironment(content.value, environment, "inherited");
}

export async function transferToRun(r: WorkRepositories, sandbox: Sandbox, parent: TaskRun, run: TaskRun,
  operationId: string, at: string): Promise<Outcome<TaskRun>> {
  const reserved = reserve(sandbox, {operationId, kind: "transfer", by: {type: "task_run", id: parent.id},
    receiver: run.id, ownerTerminal: isTerminal(parent), at});
  if (!reserved.ok) return fromRejection(reserved.error);
  const transfer = applyTransfer(reserved.value.state, {operationId, retention: run.retention, at});
  if (!transfer.ok) return fromRejection(transfer.error);
  const attached = attachSandbox(run, {sandboxId: sandbox.id});
  if (!attached.ok) return fromRejection(attached.error);
  await r.sandboxes.save(reserved.value.state, sandbox.version);
  await r.sandboxes.save(transfer.value.state, reserved.value.state.version);
  await r.taskRuns.save(attached.value.state, run.version);
  return succeed(attached.value.state);
}
