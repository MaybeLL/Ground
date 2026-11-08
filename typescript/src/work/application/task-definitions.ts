// The tasks work is done against: a stable identity with immutable, numbered
// revisions. Changing what a task asks for is a new revision, never an edit, so
// every run and every gate stays tied to the wording it was done against.
import { createDefinition, isId, publishRevision, type Hasher, type Id, type JsonValue, type Revision, type TaskKind } from "../domain/index.js";
import type { Clock, IdSource, WorkUnitOfWork } from "../ports/index.js";
import { fail, failureOf, fromRejection, succeed, type Outcome } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";

export interface TaskDefinitionsDependencies { readonly units: WorkUnitOfWork; readonly clock: Clock; readonly ids: IdSource; readonly hash: Hasher }

export type TaskCriterion = { id?: Id; statement: string };
export type TaskSpec = {
  kind?: TaskKind;
  summary: string;
  environmentDefinitionId?: string;
  criteria: TaskCriterion[];
  context?: string;
  /** Where the code lives and what the work starts from. */
  repository?: { remote: string; baseline: string };
};
export type TaskPublished = { taskId: Id; revisionId: Id; seq: number; criteria: { id: Id; statement: string }[] };
export type TaskView = { taskId: Id; name: string; seq: number; revision: { id: Id; seq: number; digest: string; content: JsonValue; publishedAt: string } | null };

const needId = (name: string, value: unknown) => isId(value) ? undefined : fail("invalid", `${name} is missing or malformed`);

export class TaskDefinitions {
  private readonly context: RequestContext;

  constructor(private readonly deps: TaskDefinitionsDependencies) {
    this.context = { units: deps.units, hash: deps.hash, now: () => deps.clock.now(), newId: () => deps.ids.next() };
  }

  /** A new task with its first revision. Criteria without an identity get one here. */
  createTask(input: { requestId: string; name?: string } & TaskSpec): Promise<Outcome<TaskPublished>> {
    const early = needId("requestId", input.requestId);
    if (early) return Promise.resolve(early);
    return once<TaskPublished>(this.context, { requestId: input.requestId, kind: "create-task", input: input as unknown as JsonValue, subject: { type: "task", id: input.requestId } }, async r => {
      const at = this.deps.clock.now();
      const taskId = this.deps.ids.next(), revisionId = this.deps.ids.next();
      const created = createDefinition({ id: taskId, kind: "task", name: (input.name ?? input.summary).slice(0, 256), at });
      if (!created.ok) return fromRejection(created.error);
      if (input.environmentDefinitionId !== undefined && (await r.definitions.get(input.environmentDefinitionId))?.kind !== "environment") return fail("not-found", "environment definition does not exist");
      const content = this.content(input, undefined);
      if (!content.ok) return content;
      const published = publishRevision(created.value.state, { revisionId, expectedSeq: 0, content: content.value.json, at }, this.deps.hash);
      if (!published.ok) return fromRejection(published.error);
      await r.definitions.create(created.value.state);
      await r.definitions.save(published.value.state, created.value.state.version);
      await r.definitions.addRevision(published.value.outcome);
      return succeed({ taskId, revisionId, seq: 1, criteria: content.value.criteria });
    });
  }

  /**
   * A new revision of the task. `expectedSeq` is the revision the caller edited
   * from; criteria that keep their identity are the same criterion, and one
   * without an identity is new.
   */
  reviseTask(input: { requestId: string; taskId: Id; expectedSeq: number } & TaskSpec): Promise<Outcome<TaskPublished>> {
    const early = needId("requestId", input.requestId) ?? needId("taskId", input.taskId);
    if (early) return Promise.resolve(early);
    return once<TaskPublished>(this.context, { requestId: input.requestId, kind: "revise-task", input: input as unknown as JsonValue, subject: { type: "task", id: input.taskId } }, async r => {
      const definition = await r.definitions.get(input.taskId, { lock: true });
      if (!definition || definition.kind !== "task") return fail("not-found", `task ${input.taskId} does not exist`);
      if (input.environmentDefinitionId !== undefined && (await r.definitions.get(input.environmentDefinitionId))?.kind !== "environment") return fail("not-found", "environment definition does not exist");
      const content = this.content(input, definition.head.seq > 0 ? await r.definitions.getRevision(definition.id, definition.head.revisionId!) : undefined);
      if (!content.ok) return content;
      const revisionId = this.deps.ids.next();
      const published = publishRevision(definition, { revisionId, expectedSeq: input.expectedSeq, content: content.value.json, at: this.deps.clock.now() }, this.deps.hash);
      if (!published.ok) return fromRejection(published.error);
      await r.definitions.save(published.value.state, definition.version);
      await r.definitions.addRevision(published.value.outcome);
      return succeed({ taskId: definition.id, revisionId, seq: published.value.outcome.seq, criteria: content.value.criteria });
    });
  }

  async getTask(taskId: Id, seq?: number): Promise<Outcome<TaskView>> {
    try {
      return await this.deps.units.run("read", async r => {
        const definition = await r.definitions.get(taskId);
        if (!definition || definition.kind !== "task") return fail("not-found", `task ${taskId} does not exist`);
        return succeed(await this.view(r, definition, seq));
      });
    } catch (error) { const failure = failureOf(error); if (failure) return { ok: false, error: failure }; throw error; }
  }

  async listTasks(): Promise<Outcome<TaskView[]>> {
    try {
      return await this.deps.units.run("read", async r => succeed(await Promise.all((await r.definitions.list("task")).map(d => this.view(r, d)))));
    } catch (error) { const failure = failureOf(error); if (failure) return { ok: false, error: failure }; throw error; }
  }

  private async view(r: Parameters<Parameters<WorkUnitOfWork["run"]>[1]>[0], definition: { id: Id; name: string; head: { seq: number } }, seq?: number): Promise<TaskView> {
    const revision: Revision | undefined = seq !== undefined ? await r.definitions.getRevisionBySeq(definition.id, seq) : await r.definitions.latestRevision(definition.id);
    return { taskId: definition.id, name: definition.name, seq: definition.head.seq, revision: revision ? { id: revision.id, seq: revision.seq, digest: revision.digest, content: revision.content, publishedAt: revision.publishedAt } : null };
  }

  /** The content of a task revision. Identities already used by the previous revision are kept; new ones are issued. */
  private content(spec: TaskSpec, previous: Revision | undefined): Outcome<{ json: JsonValue; criteria: { id: Id; statement: string }[] }> {
    if (!Array.isArray(spec.criteria) || spec.criteria.length === 0) return fail("invalid", "a task needs at least one criterion");
    const known = new Set(((previous?.content as { criteria?: { id: Id }[] } | undefined)?.criteria ?? []).map(c => c.id));
    const criteria: { id: Id; statement: string }[] = [];
    for (const c of spec.criteria) {
      if (c.id !== undefined && !known.has(c.id)) return fail("invalid", `criterion ${c.id} was not in the previous revision; leave its identity out to add a new one`);
      criteria.push({ id: c.id ?? this.deps.ids.next(), statement: c.statement });
    }
    const kind = spec.kind ?? (previous?.content as {kind?:TaskKind} | undefined)?.kind ?? "coding";
    const json: Record<string, JsonValue> = { kind, schemaVersion: 1, summary: spec.summary, criteria,
      ...(spec.environmentDefinitionId ? { environmentDefinitionId: spec.environmentDefinitionId } : {}), ...(spec.context ? { context: spec.context } : {}), ...(spec.repository ? { repository: { remote: spec.repository.remote, baseline: spec.repository.baseline } } : {}) };
    return succeed({ json, criteria });
  }
}
