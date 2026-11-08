import { advance, conflict, digestOf, firstInvalid, invalid, isDigest, isId, isNonNegativeInteger, isText, isTimestamp, ok, unique, type Decision, type Digest, type Hasher, type Id, type JsonValue, type Result, type Timestamp, type Versioned } from "./kernel.js";

/** One mechanism for every versioned definition: a stable identity plus immutable revisions. */
export type DefinitionKind = "task" | "agent" | "grader" | "environment" | "suite";
export const definitionKinds: readonly DefinitionKind[] = ["task", "agent", "grader", "environment", "suite"];

export interface Definition extends Versioned {
  readonly id: Id;
  readonly kind: DefinitionKind;
  readonly name: string;
  readonly createdAt: Timestamp;
  /** Latest published revision; `seq` is 0 before the first publication. */
  readonly head: { readonly seq: number; readonly revisionId?: Id; readonly digest?: Digest };
}

/** Immutable once published. A change of content is a new revision, never an edit. */
export interface Revision {
  readonly id: Id;
  readonly definitionId: Id;
  readonly kind: DefinitionKind;
  readonly seq: number;
  readonly predecessorId?: Id;
  readonly digest: Digest;
  readonly content: JsonValue;
  readonly publishedAt: Timestamp;
}

/** The only way another aggregate may point at a definition: an exact revision. */
export interface RevisionRef { readonly kind: DefinitionKind; readonly definitionId: Id; readonly revisionId: Id; readonly seq: number; readonly digest: Digest }
export const refOf = (revision: Revision): RevisionRef => ({ kind: revision.kind, definitionId: revision.definitionId, revisionId: revision.id, seq: revision.seq, digest: revision.digest });
export const sameRef = (a: RevisionRef, b: RevisionRef): boolean => a.revisionId === b.revisionId && a.digest === b.digest && a.definitionId === b.definitionId && a.kind === b.kind && a.seq === b.seq;
export function isRevisionRef(value: unknown, kind?: DefinitionKind): value is RevisionRef {
  const ref = value as RevisionRef;
  return !!ref && typeof ref === "object" && definitionKinds.includes(ref.kind) && (kind === undefined || ref.kind === kind)
    && isId(ref.definitionId) && isId(ref.revisionId) && Number.isSafeInteger(ref.seq) && ref.seq >= 1 && isDigest(ref.digest);
}

export type DefinitionEvent =
  | { readonly type: "definition-created"; readonly definitionId: Id; readonly kind: DefinitionKind; readonly at: Timestamp }
  | { readonly type: "revision-published"; readonly definitionId: Id; readonly revisionId: Id; readonly seq: number; readonly digest: Digest; readonly at: Timestamp };

export function createDefinition(command: { id: Id; kind: DefinitionKind; name: string; at: Timestamp }): Result<Decision<Definition, DefinitionEvent>> {
  const bad = firstInvalid([["id", isId(command.id)], ["kind", definitionKinds.includes(command.kind)], ["name", isText(command.name, 256)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  const state: Definition = { id: command.id, kind: command.kind, name: command.name, createdAt: command.at, version: 1, head: { seq: 0 } };
  return ok({ state, events: [{ type: "definition-created", definitionId: state.id, kind: state.kind, at: command.at }], outcome: undefined });
}

// ---- content of each kind -------------------------------------------------

export type TaskKind = "coding" | "working";
export interface Criterion { readonly id: Id; readonly statement: string }
export type MaterialRepository = {name:string;repository:string;commit:string};
export type OutputSlot = {key:string; required:boolean};
export interface TaskContent { readonly outputs?: readonly OutputSlot[]; readonly materialRepositories?:readonly MaterialRepository[]; readonly kind: TaskKind; readonly schemaVersion: number; readonly summary: string; readonly criteria: readonly Criterion[]; readonly environmentDefinitionId?: Id }

/** What an acceptance verdict is a verdict about on the task side: the criteria and their wording, independent of their order. */
export function criteriaDigest(task: Pick<TaskContent, "criteria">, hash: Hasher): Result<Digest> {
  return digestOf([...task.criteria].sort((a, b) => a.id.localeCompare(b.id)).map(c => ({ id: c.id, statement: c.statement })), hash);
}

export type Scale =
  | { readonly form: "numeric"; readonly min: number; readonly max: number }
  | { readonly form: "category"; readonly categories: readonly string[] }
  | { readonly form: "criteria" };
export type GraderStrategy = "rule" | "test" | "agent";
export interface GraderContent { readonly strategy: GraderStrategy; readonly scale: Scale; readonly environmentRevisionId?: Id }

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function parseTaskContent(content: unknown): Result<TaskContent> {
  if (!isObject(content)) return invalid("task content must be an object");
  const { kind, schemaVersion, summary, criteria, environmentDefinitionId, outputs, materialRepositories } = content;
  if (kind !== "coding" && kind !== "working") return invalid("task kind must be coding or working");
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) return invalid("schemaVersion must be a positive integer");
  if (!isText(summary, 1024)) return invalid("summary is required");
  if (!Array.isArray(criteria)) return invalid("criteria must be a list");
  const parsed: Criterion[] = [];
  for (const entry of criteria) {
    if (!isObject(entry) || !isId(entry.id) || !isText(entry.statement)) return invalid("each criterion needs an id and a statement");
    parsed.push({ id: entry.id, statement: entry.statement });
  }
  if (!unique(parsed, c => c.id)) return invalid("criterion ids must be unique");
  if (environmentDefinitionId !== undefined && !isId(environmentDefinitionId)) return invalid("environmentDefinitionId must be an identifier");
  const repos:MaterialRepository[] = [];
  if (materialRepositories !== undefined) {
    if (!Array.isArray(materialRepositories)) return invalid("material repositories must be a list");
    for (const repo of materialRepositories) {
      if (!isObject(repo) || typeof repo.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(repo.name) ||
          !isText(repo.repository,2048) || typeof repo.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(repo.commit)) return invalid("each material requires a name, repository and full Git commit");
      repos.push({name:repo.name,repository:repo.repository,commit:repo.commit});
    }
    if (!unique(repos,repo=>repo.name.toLowerCase())) return invalid("material repository names must be distinct");
  }
  const slots:OutputSlot[] = [];
  if (outputs !== undefined) {
    if (!Array.isArray(outputs)) return invalid("task output slots must be a list");
    for (const slot of outputs) {
      if (!isObject(slot) || !isId(slot.key) || typeof slot.required !== "boolean") return invalid("each output needs a key and a required flag");
      slots.push({key:slot.key,required:slot.required});
    }
    if (!unique(slots,slot=>slot.key)) return invalid("output keys must be unique");
  }
  return ok({ kind, ...(materialRepositories === undefined ? {} : {materialRepositories:repos}), ...(outputs === undefined ? {} : {outputs:slots}), schemaVersion: schemaVersion as number, summary, criteria: parsed, ...(environmentDefinitionId !== undefined ? { environmentDefinitionId } : {}) });
}

export function parseScale(value: unknown): Result<Scale> {
  if (!isObject(value)) return invalid("scale must be an object");
  if (value.form === "numeric") {
    const { min, max } = value;
    if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) return invalid("numeric scale needs finite min < max");
    return ok({ form: "numeric", min, max });
  }
  if (value.form === "category") {
    const categories = value.categories;
    if (!Array.isArray(categories) || categories.length === 0 || !categories.every(c => isText(c, 128)) || !unique(categories as string[])) return invalid("category scale needs unique, non-empty categories");
    return ok({ form: "category", categories: categories as string[] });
  }
  if (value.form === "criteria") return ok({ form: "criteria" });
  return invalid("unknown scale form");
}

export function parseGraderContent(content: unknown): Result<GraderContent> {
  if (!isObject(content)) return invalid("grader content must be an object");
  const strategy = content.strategy;
  if (strategy !== "rule" && strategy !== "test" && strategy !== "agent") return invalid("strategy must be rule, test or agent");
  const scale = parseScale(content.scale);
  if (!scale.ok) return scale;
  const environmentRevisionId = content.environmentRevisionId;
  if (environmentRevisionId !== undefined && !isId(environmentRevisionId)) return invalid("environmentRevisionId must be an identifier");
  if (strategy === "test" && environmentRevisionId === undefined) return invalid("a test grader fixes an environment revision");
  if (strategy === "rule" && environmentRevisionId !== undefined) return invalid("a rule grader needs no environment");
  return ok({ strategy, scale: scale.value, ...(environmentRevisionId !== undefined ? { environmentRevisionId } : {}) });
}

function validateContent(kind: DefinitionKind, content: JsonValue): Result<void> {
  const parsed = kind === "task" ? parseTaskContent(content) : kind === "grader" ? parseGraderContent(content) : undefined;
  if (parsed) return parsed.ok ? ok(undefined) : parsed;
  if (!isObject(content) || Object.keys(content).length === 0) return invalid(`${kind} content must be a non-empty object`);
  if (kind === "agent" && !isText((content as Record<string, unknown>).provider, 128)) return invalid("agent content needs a provider");
  if (kind === "suite") {
    const cases = (content as Record<string, unknown>).cases;
    if (!Array.isArray(cases) || !cases.every(c => isObject(c) && isId(c.key)) || !unique(cases as Array<{ key: string }>, c => c.key)) return invalid("suite cases need unique keys");
  }
  return ok(undefined);
}

export function publishRevision(
  definition: Definition,
  command: { revisionId: Id; expectedSeq: number; content: JsonValue; at: Timestamp },
  hash: Hasher,
): Result<Decision<Definition, DefinitionEvent, Revision>> {
  const bad = firstInvalid([["revisionId", isId(command.revisionId)], ["expectedSeq", isNonNegativeInteger(command.expectedSeq)], ["at", isTimestamp(command.at)]]);
  if (bad) return bad;
  if (command.expectedSeq !== definition.head.seq) return conflict(`definition is at revision ${definition.head.seq}, not ${command.expectedSeq}`);
  const content = validateContent(definition.kind, command.content);
  if (!content.ok) return content;
  const digest = digestOf(command.content, hash);
  if (!digest.ok) return digest;
  if (digest.value === definition.head.digest) return conflict("content is unchanged from the latest revision");
  const revision: Revision = {
    id: command.revisionId, definitionId: definition.id, kind: definition.kind, seq: definition.head.seq + 1,
    ...(definition.head.revisionId ? { predecessorId: definition.head.revisionId } : {}),
    digest: digest.value, content: command.content, publishedAt: command.at,
  };
  const published = advance(definition, { head: { seq: revision.seq, revisionId: revision.id, digest: revision.digest } },
    [{ type: "revision-published", definitionId: definition.id, revisionId: revision.id, seq: revision.seq, digest: revision.digest, at: command.at } as DefinitionEvent], revision);
  return published;
}

// ---- environment resolution ----------------------------------------------

export type EnvironmentSource = "latest" | "specified" | "inherited";
export interface ResolvedEnvironment { readonly revision: RevisionRef; readonly source: EnvironmentSource }

/** A resolved environment must be a revision of the definition the task asks for. */
export function resolveEnvironment(task: TaskContent, revision: RevisionRef, source: EnvironmentSource): Result<ResolvedEnvironment> {
  if (revision.kind !== "environment") return invalid("a resolved environment must be an environment revision");
  if (task.environmentDefinitionId === undefined) return conflict("the task declares no environment requirement");
  if (revision.definitionId !== task.environmentDefinitionId) return conflict("the revision does not belong to the environment definition the task requires");
  return ok({ revision, source });
}

export function definitionViolations(definition: Definition): string[] {
  const problems: string[] = [];
  const head = definition.head;
  if (!Number.isSafeInteger(head.seq) || head.seq < 0) problems.push("the head revision number is not negative");
  if ((head.seq === 0) !== (head.revisionId === undefined && head.digest === undefined)) problems.push("a definition has a head revision exactly when something was published");
  if (head.seq > 0 && (head.revisionId === undefined || head.digest === undefined)) problems.push("the head names its revision and digest");
  return problems;
}

export function revisionViolations(revision: Revision): string[] {
  const problems: string[] = [];
  if (!Number.isSafeInteger(revision.seq) || revision.seq < 1) problems.push("revision numbers start at 1");
  if ((revision.seq === 1) !== (revision.predecessorId === undefined)) problems.push("every revision but the first names its predecessor");
  if (!isDigest(revision.digest)) problems.push("a revision carries its content digest");
  return problems;
}
