// A case belongs to its immutable suite revision. Private material is captured
// from the selected delivery; the task revision remains the worker's only input.
import { createDefinition, createGrading, digestOf, isId, isText, publishRevision, refOf, sameRef, submitGrade, unique, type JsonValue, type Revision, type RevisionRef } from "../domain/index.js";
import { GRADING_REQUEST_COUNTER, type CodeArchivePort } from "../ports/index.js";
import type { ArchiveRepairs } from "./archive-repairs.js";
import { ensureFileMatchGrader, FILE_MATCH_CONTENT } from "./builtin-grader.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";

type CaseSource = { key: string; runId: string; deliveryId: string; answerPath: string; referencePath: string; hiddenTestPaths: string[] };
type Material = { role: "reference-answer" | "hidden-test"; visibility: "grader"; path: string; blob: string; digest: string; base64: string };
type FrozenCase = { key: string; taskRevision: RevisionRef; source: { runId: string; deliveryId: string; manifestDigest: string; receipt: string; archiveId: string; commit: string }; answerPath: string; graderRevision: RevisionRef; materials: Material[] };
type Published = { suiteId: string; revisionId: string; seq: number; digest: string; caseCount: number };
type Measurement = { gradingId: string; suiteId: string; revisionId: string; caseKey: string; runId: string; deliveryId: string; result: "match" | "mismatch"; actualDigest: string | null; expectedDigest: string };
type SuiteDeps = RequestContext & { archive: CodeArchivePort; repairs: ArchiveRepairs; capture(bytes: Uint8Array): { digest: string; base64: string } };
const json = (value: unknown) => value as JsonValue;
const validPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\\]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");

export function parseSources(input: unknown): Outcome<CaseSource[]> {
  if (!Array.isArray(input) || !input.length) return fail("invalid", "supply at least one case");
  const sources: CaseSource[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("invalid", "a case must be an object");
    const { key, runId, deliveryId, answerPath, referencePath, hiddenTestPaths = [] } = entry;
    if (![key, runId, deliveryId].every(isId) || !validPath(answerPath) || !validPath(referencePath) || !Array.isArray(hiddenTestPaths) || !hiddenTestPaths.every(validPath) || !unique(hiddenTestPaths)) return fail("invalid", "invalid case identity, source, or material path");
    sources.push({ key, runId, deliveryId, answerPath, referencePath, hiddenTestPaths });
  }
  return unique(sources, c => c.key) ? succeed(sources) : fail("invalid", "case keys must be unique");
}

function casesOf(revision: Revision): FrozenCase[] {
  const content = revision.content as { format?: string; cases?: FrozenCase[] };
  if (content.format !== "grounds.evaluation-suite/v1" || !Array.isArray(content.cases)) throw new Error("unsupported evaluation suite snapshot");
  return content.cases;
}

export class EvaluationSuites {
  constructor(private readonly deps: SuiteDeps) {}

  private async delivery(runId: string, deliveryId: string, repo: string) {
    const run = await this.deps.units.run("read", r => r.taskRuns.get(runId));
    if (!run) return fail("not-found", "the source run does not exist");
    const item = run.manifest?.items.find(item => item.id === deliveryId && item.type === "candidate");
    if (run.status !== "delivered" || !run.manifest || !item) return fail("conflict", "select a frozen candidate of this run");
    const { observation, receipt } = await this.deps.repairs.current(runId, item, repo);
    if (!observation.recordedCommit || (observation.status !== "intact" && observation.status !== "ref-changed")) return fail("unavailable", "the selected delivery cannot be reproduced");
    const archiveId = "activeArchiveId" in observation ? observation.activeArchiveId : item.id;
    return succeed({ taskRevision: run.taskRevision, item, archive: { id: archiveId, receipt }, source: {
      runId, deliveryId, manifestDigest: run.manifest.digest, receipt: item.receipt, archiveId, commit: observation.recordedCommit,
    } });
  }

  // Replay completed operations before any live Git lookup. A second writer
  // racing the first is handled by once() in the final transaction.
  private async replay<T>(requestId: string, kind: string, input: JsonValue): Promise<Outcome<T> | undefined> {
    const prior = await this.deps.units.run("read", r => r.intents.findByRequest(requestId));
    if (!prior) return undefined;
    const digest = digestOf({ kind, input }, this.deps.hash);
    return digest.ok && prior.state === "completed" && prior.requestHash === digest.value ? succeed(prior.result as T) : fail("request-conflict", "operation ID already used");
  }

  async publish(input: { requestId: string; name: string; suiteId?: string; expectedSeq: number; cases: unknown }, repo: string): Promise<Outcome<Published>> {
    if (!isId(input.requestId) || !isText(input.name, 256) || !Number.isSafeInteger(input.expectedSeq) || input.expectedSeq < 0 || (input.suiteId === undefined ? input.expectedSeq !== 0 : !isId(input.suiteId) || input.expectedSeq === 0)) return fail("invalid", "supply a name and a valid suite revision to replace");
    const sources = parseSources(input.cases);
    if (!sources.ok) return sources;
    const request = { requestId: input.requestId, input: json({ ...input, cases: sources.value }), kind: "publish-suite", subject: { type: "suite", id: input.suiteId ?? input.requestId } };
    const replay = await this.replay<Published>(request.requestId, request.kind, request.input);
    if (replay) return replay;
    const cases: Omit<FrozenCase, "graderRevision">[] = [];
    for (const entry of sources.value) {
      const delivery = await this.delivery(entry.runId, entry.deliveryId, repo);
      if (!delivery.ok) return delivery;
      const materials: Material[] = [];
      for (const [i, path] of [entry.referencePath, ...entry.hiddenTestPaths].entries()) {
        const file = await this.deps.archive.readFile(repo, delivery.value.archive, path);
        if (file.status !== "read") return fail(file.status === "missing" ? "not-found" : file.status, file.reason);
        materials.push({ role: i === 0 ? "reference-answer" : "hidden-test", visibility: "grader", path, blob: file.blob, ...this.deps.capture(file.bytes) });
      }
      cases.push({ key: entry.key, answerPath: entry.answerPath, taskRevision: delivery.value.taskRevision, source: delivery.value.source, materials });
    }
    return once<Published>(this.deps, request, async r => {
      const at = this.deps.now();
      const grader = await ensureFileMatchGrader(r, this.deps.hash, at);
      if (!grader.ok) return grader;
      const id = input.suiteId ?? this.deps.newId();
      let definition = await r.definitions.get(id, { lock: true });
      if (!input.suiteId) {
        const created = createDefinition({ id, name: input.name, kind: "suite", at });
        if (!created.ok) return fromRejection(created.error);
        definition = created.value.state;
        await r.definitions.create(definition);
      }
      if (!definition || definition.kind !== "suite") return fail("not-found", "suite does not exist");
      const content = json({ format: "grounds.evaluation-suite/v1", name: input.name, cases: cases.map(c => ({ ...c, graderRevision: grader.value })) });
      const next = publishRevision(definition, { at, expectedSeq: input.expectedSeq, revisionId: this.deps.newId(), content }, this.deps.hash);
      if (!next.ok) return fromRejection(next.error);
      const revision = next.value.outcome;
      await r.definitions.save(next.value.state, definition.version);
      await r.definitions.addRevision(revision);
      return succeed({ suiteId: id, revisionId: revision.id, seq: revision.seq, digest: revision.digest, caseCount: cases.length });
    });
  }

  private async snapshot(id: string, seq: number) {
    return this.deps.units.run("read", async r => {
      const revision = await r.definitions.getRevisionBySeq(id, seq);
      return revision?.kind === "suite" ? revision : undefined;
    });
  }

  async show(id: string, seq: number) {
    const revision = await this.snapshot(id, seq);
    if (!revision) return fail("not-found", "suite revision does not exist");
    const cases = casesOf(revision).map(c => ({ ...c, materials: c.materials.map(({ base64, ...metadata }) => metadata) }));
    return succeed({ suite: refOf(revision), cases });
  }

  async list() {
    return this.deps.units.run("read", async r => succeed({ suites: (await r.definitions.list("suite")).map(d => ({ id: d.id, name: d.name, head: d.head })) }));
  }

  async measure(input: { requestId: string; suiteId: string; seq: number; caseKey: string; runId: string; deliveryId: string }, repo: string): Promise<Outcome<Measurement>> {
    const request = { requestId: input.requestId, input: json(input), kind: "measure-file-match", subject: {type: "task_run", id: input.runId} };
    const replay = await this.replay<Measurement>(request.requestId, request.kind, request.input);
    if (replay) return replay;
    const revision = await this.snapshot(input.suiteId, input.seq);
    if (!revision) return fail("not-found", "suite revision does not exist");
    const selected = casesOf(revision).find(c => c.key === input.caseKey);
    if (!selected) return fail("not-found", "case is absent from the suite revision");
    const delivery = await this.delivery(input.runId, input.deliveryId, repo);
    if (!delivery.ok) return delivery;
    if (!sameRef(delivery.value.taskRevision, selected.taskRevision)) return fail("conflict", "delivery uses a different task revision");
    const file = await this.deps.archive.readFile(repo, delivery.value.archive, selected.answerPath);
    if (file.status !== "read" && file.status !== "missing") return fail(file.status, file.reason);
    const actualDigest = file.status === "read" ? this.deps.capture(file.bytes).digest : null;
    const expected = selected.materials.find(m => m.role === "reference-answer")!;
    const result = actualDigest === expected.digest ? "match" : "mismatch";
    return once<Measurement>(this.deps, request, async r => {
      const { item } = delivery.value;
      const digest = digestOf(json(item), this.deps.hash);
      if (!digest.ok) return fromRejection(digest.error);
      const at = this.deps.now(), gradingId = this.deps.newId();
      const created = createGrading({ id: gradingId, purpose: "measure", origin: { type: "standalone", historical: { taskRunId: input.runId, caseKey: input.caseKey, suite: refOf(revision) } }, graderRevision: selected.graderRevision, grader: FILE_MATCH_CONTENT, requestSeq: await r.sequences.next(GRADING_REQUEST_COUNTER),
        targets: [{ type: item.type, id: item.id, digest: digest.value }], materials: [{ id: "reference-answer", digest: expected.digest }, { id: "suite-snapshot", digest: revision.digest }], at });
      if (!created.ok) return fromRejection(created.error);
      const completed = submitGrade(created.value.state, { grade: { form: "category", category: result }, at });
      if (!completed.ok) return fromRejection(completed.error);
      await r.gradings.create(created.value.state);
      await r.gradings.save(completed.value.state, created.value.state.version);
      return succeed({ gradingId, suiteId: input.suiteId, revisionId: revision.id, caseKey: selected.key, runId: input.runId, deliveryId: item.id, result, actualDigest, expectedDigest: expected.digest });
    });
  }
}
