// A case belongs to its immutable suite revision. Private material is captured
// from the selected delivery; the task revision remains the worker's only input.
import { createDefinition, createGrading, digestOf, isId, isText, publishRevision, refOf, sameRef, submitGrade, unique, type DeliveryItem, type GradingOrigin, type JsonValue, type Revision, type RevisionRef } from "../domain/index.js";
import { GRADING_REQUEST_COUNTER, type CodeArchivePort, type WorkRepositories } from "../ports/index.js";
import type { ArchiveRepairs } from "./archive-repairs.js";
import { admitTestMeasurement, type AcceptedTest } from "./test-measurements.js";
import { testGrader, fileRule, resolveRule, resolveSuiteGrader, type GraderSelection, type Rule } from "./rule-definitions.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";

type DeliverySelection = { runId: string; deliveryId: string };
type BindingSource = { key: string; answerPath?: string; grader?: GraderSelection; referencePath?: string; hiddenTestPaths: string[]; materialSource?: DeliverySelection };
type CaseSource = DeliverySelection & { key: string; bindings: BindingSource[] };
type Source = DeliverySelection & { manifestDigest: string; receipt: string; archiveId: string; archiveReceipt: string; commit: string };
type Material = { role: "reference-answer" | "hidden-test"; visibility: "grader"; path: string; blob: string; digest: string; base64: string };
type Binding = { key: string; answerPath?: string; graderRevision: RevisionRef; materialSource: Source; materials: Material[] };
type FrozenCase = { key: string; taskRevision: RevisionRef; source: Source; bindings: Binding[] };
type Published = { suiteId: string; revisionId: string; seq: number; digest: string; caseCount: number };
type Measurement = { gradingId: string; suiteId: string; revisionId: string; caseKey: string; runId: string; deliveryId: string; bindingKey: string; result: string; actualDigest: string | null; expectedDigest: string | null };
type SuiteDeps = RequestContext & { archive: CodeArchivePort; repairs: ArchiveRepairs; capture(bytes: Uint8Array): { digest: string; base64: string } };
const measurementArchive = (source: Source) => ({ archiveId: source.archiveId, archiveReceipt: source.archiveReceipt, originalReceipt: source.receipt });
const json = (value: unknown) => value as JsonValue;
const validPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\\]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");

export function parseSources(input: unknown): Outcome<CaseSource[]> {
  if (!Array.isArray(input) || !input.length) return fail("invalid", "supply at least one case");
  const sources: CaseSource[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("invalid", "a case must be an object");
    const { key, runId, deliveryId, bindings } = entry;
    if (![key, runId, deliveryId].every(isId) || !Array.isArray(bindings) || !bindings.length ||
        Object.keys(entry).some(k => !["key","runId","deliveryId","bindings"].includes(k))) return fail("invalid", "a case needs a key, source and one or more bindings");
    const parsed: BindingSource[] = [];
    for (const binding of bindings) {
      if (!binding || typeof binding !== "object" || Object.keys(binding).some(k => !["key","answerPath","grader","referencePath","hiddenTestPaths","materialSource"].includes(k))) return fail("invalid", "unknown grading binding field");
      const { key, grader, referencePath, hiddenTestPaths = [], answerPath, materialSource } = binding;
      if (!isId(key) || (answerPath !== undefined && !validPath(answerPath)) || (referencePath !== undefined && !validPath(referencePath)) ||
          !Array.isArray(hiddenTestPaths) || !hiddenTestPaths.every(validPath) || !unique(hiddenTestPaths)) return fail("invalid", "invalid binding key or file paths");
      if (grader !== undefined && !(grader && isId(grader.definitionId) && isId(grader.revisionId) && Object.keys(grader).every(k => k === "definitionId" || k === "revisionId"))) return fail("invalid", "select an exact grader definition and revision");
      if (materialSource !== undefined && !(materialSource && isId(materialSource.runId) && isId(materialSource.deliveryId) && Object.keys(materialSource).every(k => k === "runId" || k === "deliveryId"))) return fail("invalid", "select a frozen material source run and delivery");
      parsed.push({ key, ...(answerPath ? {answerPath} : {}), hiddenTestPaths, ...(referencePath ? { referencePath } : {}), ...(grader ? { grader } : {}), ...(materialSource ? { materialSource } : {}) });
    }
    if (!unique(parsed, b => b.key)) return fail("invalid", "binding keys must be unique within a case");
    sources.push({ key, runId, deliveryId, bindings: parsed });
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
    if (observation.status === null) return fail("unavailable", "the archive endpoint could not confirm reproducibility");
    if (!observation.recordedCommit || (observation.status !== "intact" && observation.status !== "ref-changed")) return fail("unavailable", "the selected delivery cannot be reproduced");
    const archiveId = "activeArchiveId" in observation ? observation.activeArchiveId : item.id;
    return succeed({ taskRevision: run.taskRevision, item, archive: { id: archiveId, receipt }, source: {
      runId, deliveryId, manifestDigest: run.manifest.digest, receipt: item.receipt, archiveId, archiveReceipt: receipt, commit: observation.recordedCommit,
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
    const cases: (Omit<FrozenCase, "bindings"> & { bindings: (Omit<Binding,"graderRevision"> & { selection: GraderSelection | undefined })[] })[] = [];
    for (const entry of sources.value) {
      const delivery = await this.delivery(entry.runId, entry.deliveryId, repo);
      if (!delivery.ok) return delivery;
      if (entry.bindings.every(binding => binding.materialSource !== undefined)) {
        const sourceTree = await this.deps.archive.readFiles(repo, delivery.value.archive, []);
        if (sourceTree.status !== "read") return fail("unavailable", sourceTree.reason);
      }
      const bindings = [];
      for (const binding of entry.bindings) {
        const source = binding.materialSource ? await this.delivery(binding.materialSource.runId, binding.materialSource.deliveryId, repo) : delivery;
        if (!source.ok) return source;
        const paths = [...(binding.referencePath ? [binding.referencePath] : []), ...binding.hiddenTestPaths];
        const files = await this.deps.archive.readFiles(repo, source.value.archive, paths);
        if (files.status !== "read") return fail(files.status === "missing" ? "not-found" : files.status, files.reason);
        const materials: Material[] = paths.map((path, i) => {
          const file = files.files.get(path)!;
          return { role: i === 0 && binding.referencePath ? "reference-answer" : "hidden-test", visibility: "grader", path, blob: file.blob, ...this.deps.capture(file.bytes) };
        });
        bindings.push({ key: binding.key, ...(binding.answerPath ? {answerPath:binding.answerPath} : {}), selection: binding.grader, materialSource: source.value.source, materials });
      }
      cases.push({ key: entry.key, taskRevision: delivery.value.taskRevision, source: delivery.value.source, bindings });
    }
    return once<Published>(this.deps, request, async r => {
      const at = this.deps.now();
      const frozen: FrozenCase[] = [];
      for (const entry of cases) {
        const bindings: Binding[] = [];
        for (const { selection, ...binding } of entry.bindings) {
          const resolved = await resolveSuiteGrader(r, this.deps, selection);
          if (!resolved.ok) return resolved;
          const grader = resolved.value.rule;
          if (grader.strategy === "rule" && !binding.answerPath) return fail("invalid", "a file rule needs the path to grade");
          if (grader.strategy === "test" && binding.answerPath) return fail("invalid", "a test binding takes its commands from its grader revision");
          const needsReference = grader.strategy === "rule" && grader.operation === "equal-file-bytes";
          if (needsReference !== binding.materials.some(m => m.role === "reference-answer")) return fail("invalid", "reference answer does not match the grader's input contract");
          bindings.push({ ...binding, graderRevision: resolved.value.ref });
        }
        frozen.push({ ...entry, bindings });
      }
      const id = input.suiteId ?? this.deps.newId();
      let definition = await r.definitions.get(id, { lock: true });
      if (!input.suiteId) {
        const created = createDefinition({ id, name: input.name, kind: "suite", at });
        if (!created.ok) return fromRejection(created.error);
        definition = created.value.state;
        await r.definitions.create(definition);
      }
      if (!definition || definition.kind !== "suite") return fail("not-found", "suite does not exist");
      const content = json({ format: "grounds.evaluation-suite/v1", name: input.name, cases: frozen });
      const next = publishRevision(definition, { at, expectedSeq: input.expectedSeq, revisionId: this.deps.newId(), content }, this.deps.hash);
      if (!next.ok) return fromRejection(next.error);
      const revision = next.value.outcome;
      await r.definitions.save({ ...next.value.state, name: input.name }, definition.version);
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
    const cases = casesOf(revision).map(c => ({ ...c, bindings: c.bindings.map(b => ({ ...b, materials: b.materials.map(({ base64, ...metadata }) => metadata) })) }));
    return succeed({ suite: refOf(revision), name: (revision.content as {name: string}).name, cases });
  }

  async list() {
    return this.deps.units.run("read", async r => succeed({ suites: (await r.definitions.list("suite")).map(d => ({ id: d.id, name: d.name, head: d.head })) }));
  }

  private async score(repo: string, archive: { id: string; receipt: string }, path: string, rule: Rule, expectedDigest: string | null) {
    const file = await this.deps.archive.fileDigest(repo, archive, path);
    if (file.status !== "read" && file.status !== "missing") return fail(file.status, file.reason);
    const actualDigest = file.status === "read" ? file.digest : null;
    const passes = rule.operation === "file-exists" ? actualDigest !== null : actualDigest !== null && actualDigest === expectedDigest;
    return succeed({ result: rule.scale.categories[passes ? 0 : 1]!, actualDigest, expectedDigest });
  }

  private async record(r: WorkRepositories, item: DeliveryItem, origin: GradingOrigin, revision: RevisionRef, rule: Rule,
    result: string, materials: { id: string; digest: string }[]) {
    const digest = digestOf(json(item), this.deps.hash);
    if (!digest.ok) return fromRejection(digest.error);
    const at = this.deps.now(), gradingId = this.deps.newId();
    const created = createGrading({ id: gradingId, purpose: "measure", origin, graderRevision: revision, grader: rule,
      requestSeq: await r.sequences.next(GRADING_REQUEST_COUNTER), targets: [{ type: item.type, id: item.id, digest: digest.value }], materials, at });
    if (!created.ok) return fromRejection(created.error);
    const completed = submitGrade(created.value.state, { grade: { form: "category", category: result }, at });
    if (!completed.ok) return fromRejection(completed.error);
    await r.gradings.create(created.value.state);
    await r.gradings.save(completed.value.state, created.value.state.version);
    return succeed(gradingId);
  }

  async measureDirect(input: { requestId: string; runId: string; deliveryId: string; answerPath: string; grader: GraderSelection;
    reference?: DeliverySelection & { path: string } }, repo: string) {
    type DirectResult = { gradingId: string; runId: string; deliveryId: string; result: string; actualDigest: string | null; expectedDigest: string | null };
    if (!validPath(input.answerPath) || (input.reference && !validPath(input.reference.path))) return fail("invalid", "select a relative regular file path");
    const request = { requestId: input.requestId, input: json(input), kind: "measure-direct", subject: { type: "task_run", id: input.runId } };
    const replay = await this.replay<DirectResult>(request.requestId, request.kind, request.input);
    if (replay) return replay;
    const chosen = await this.deps.units.run("read", r => resolveRule(r, this.deps, input.grader));
    if (!chosen.ok) return chosen;
    if ((chosen.value.rule.operation === "equal-file-bytes") !== !!input.reference) return fail("invalid", "reference answer does not match the grader's input contract");
    const target = await this.delivery(input.runId, input.deliveryId, repo);
    if (!target.ok) return target;
    let reference;
    if (input.reference) {
      const source = await this.delivery(input.reference.runId, input.reference.deliveryId, repo);
      if (!source.ok) return source;
      const file = await this.deps.archive.fileDigest(repo, source.value.archive, input.reference.path);
      if (file.status !== "read") return fail(file.status === "missing" ? "not-found" : file.status, file.reason);
      reference = { archive: measurementArchive(source.value.source), taskRunId: input.reference.runId, deliveryId: input.reference.deliveryId, path: input.reference.path, digest: file.digest };
    }
    const basis = reference;
    const scored = await this.score(repo, target.value.archive, input.answerPath, chosen.value.rule, basis?.digest ?? null);
    if (!scored.ok) return scored;
    return once<DirectResult>(this.deps, request, async r => {
      const origin: GradingOrigin = { type: "standalone", direct: { archive: measurementArchive(target.value.source), taskRunId: input.runId, answerPath: input.answerPath, actualDigest: scored.value.actualDigest, ...(basis ? { reference: basis } : {}) } };
      const recorded = await this.record(r, target.value.item, origin, chosen.value.ref, chosen.value.rule, scored.value.result, basis ? [{ id: "reference-answer", digest: basis.digest }] : []);
      return recorded.ok ? succeed({ gradingId: recorded.value, runId: input.runId, deliveryId: input.deliveryId, ...scored.value }) : recorded;
    });
  }

  async measure(input: { requestId: string; suiteId: string; seq: number; caseKey: string; bindingKey?: string; runId: string; deliveryId: string }, repo: string): Promise<Outcome<Measurement | AcceptedTest>> {
    const request = { requestId: input.requestId, input: json(input), kind: "measure-file-match", subject: {type: "task_run", id: input.runId} };
    const replay = await this.replay<Measurement | AcceptedTest>(request.requestId, request.kind, request.input);
    if (replay) return replay;
    const revision = await this.snapshot(input.suiteId, input.seq);
    if (!revision) return fail("not-found", "suite revision does not exist");
    const selected = casesOf(revision).find(c => c.key === input.caseKey);
    if (!selected) return fail("not-found", "case is absent from the suite revision");
    const binding = input.bindingKey ? selected.bindings.find(b => b.key === input.bindingKey) : selected.bindings.length === 1 ? selected.bindings[0] : undefined;
    if (!binding) return fail("invalid", "select one of this case's grading bindings");
    const graderRevision = await this.deps.units.run("read", r => r.definitions.getRevision(binding.graderRevision.definitionId, binding.graderRevision.revisionId));
    const rule = graderRevision && fileRule(graderRevision.content);
    const test = graderRevision && testGrader(graderRevision.content);
    if (!graderRevision || !sameRef(refOf(graderRevision), binding.graderRevision) || (!rule && !test)) return fail("unsupported", "the frozen grader revision cannot be loaded");
    const delivery = await this.delivery(input.runId, input.deliveryId, repo);
    if (!delivery.ok) return delivery;
    if (!sameRef(delivery.value.taskRevision, selected.taskRevision)) return fail("conflict", "delivery uses a different task revision");
    if (test) {
      const source = delivery.value.source;
      const plan = {suite:refOf(revision), caseKey:selected.key, bindingKey:binding.key, runId:input.runId,
        deliveryId:input.deliveryId, commit:source.commit, receipt:source.archiveReceipt, repository:repo};
      const materials = binding.materials.map(m => ({id:m.path, digest:m.digest}));
      return once(this.deps, request, r => admitTestMeasurement(this.deps, r, plan, delivery.value.item, test, binding.graderRevision, materials));
    }
    if (!rule) return fail("unsupported", "the selected rule is unavailable");
    const expected = binding.materials.find(m => m.role === "reference-answer");
    if (!binding.answerPath) return fail("invalid", "the file rule has no target path");
    const scored = await this.score(repo, delivery.value.archive, binding.answerPath, rule, expected?.digest ?? null);
    if (!scored.ok) return scored;
    return once<Measurement>(this.deps, request, async r => {
      const origin: GradingOrigin = { type: "standalone", historical: { taskRunId: input.runId, caseKey: input.caseKey, bindingKey: binding.key, suite: refOf(revision) } };
      const materials = [...(expected ? [{ id: "reference-answer", digest: expected.digest }] : []), { id: "suite-snapshot", digest: revision.digest }];
      const recorded = await this.record(r, delivery.value.item, origin, binding.graderRevision, rule, scored.value.result, materials);
      return recorded.ok ? succeed({ gradingId: recorded.value, suiteId: input.suiteId, revisionId: revision.id, caseKey: selected.key,
        runId: input.runId, deliveryId: delivery.value.item.id, bindingKey: binding.key, ...scored.value }) : recorded;
    });
  }
}
