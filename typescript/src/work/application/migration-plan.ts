// Maps a snapshot of the previous ledger model onto the work model. Pure: the
// result is a plan of aggregates in their final state, or the reasons it cannot
// be made. Rules: docs/decisions/0001-target-model.md section 12.
import {
  createDefinition, criteriaDigest, digestOf, importLegacyGate, importLegacyTaskRun, materialsDigest, migrateWork, parseTaskContent, protocolStages, publishRevision, refOf,
  type CommandObservation, type CriterionVerdict, type Definition, type Digest, type GradingRecord, type Hasher, type Id, type JsonValue, type ProtocolRecord, type ProtocolStage,
  type Result, type Revision, type RevisionRef, type TaskRun, type Timestamp, type Verdict, type Work,
} from "../domain/index.js";
import type { LegacyCriterion, LegacyDevRun, LegacyIssue, LegacyIssueRevision, LegacySnapshot, LegacyVerification, LegacyVerificationRun } from "../ports/legacy.js";

export const BUILTIN_VERIFICATION_GRADER = { definitionId: "builtin.independent-verification", revisionId: "builtin.independent-verification.r1" } as const;

export interface PlannedDefinition { readonly definition: Definition; readonly revisions: readonly Revision[] }
export interface MigrationReport {
  readonly issues: number;
  readonly taskRevisions: number;
  readonly taskRuns: { readonly delivered: number; readonly abandoned: number; readonly stillOpen: number };
  readonly works: number;
  /** Works with several leaves and no choice made in the old ledger: no head until someone selects one. */
  readonly worksWithoutHead: readonly Id[];
  /** Works whose head is a choice the user made in the old ledger. */
  readonly worksWithSelectedHead: number;
  readonly gradings: number;
  /** Gates whose old ledger did not keep the review session: independence is unknown. */
  readonly gradingsWithoutSession: number;
  readonly skippedVerifications: readonly { readonly id: Id; readonly reason: string }[];
  /** Texts shortened to fit the new limits; the full text stays in the old tables. */
  readonly clippedTexts: number;
  readonly observationsOutsideProtocol: number;
  readonly qualityReviewsLeftInPlace: number;
}
export interface MigrationPlan {
  readonly migratedAt: Timestamp;
  readonly definitions: readonly PlannedDefinition[];
  /** Parents before the runs that refine them. */
  readonly taskRuns: readonly TaskRun[];
  readonly works: readonly Work[];
  /** In request order; the last `requestSeq` is the count to seed the ledger counter with. */
  readonly gradings: readonly GradingRecord[];
  readonly report: MigrationReport;
  /** Identifies this exact plan, so a repeat of the migration can tell it is the same one. */
  readonly digest: Digest;
}
export type PlanOutcome = { readonly ok: true; readonly plan: MigrationPlan } | { readonly ok: false; readonly problems: readonly string[] };

interface TaskRevisionFacts { readonly ref: RevisionRef; readonly criteria: readonly LegacyCriterion[]; readonly criteriaDigest: Digest; readonly issueId: Id }

const verdictOf: Record<string, Verdict> = { qualified: "satisfied", rejected: "unsatisfied", inconclusive: "indeterminate" };

export function planMigration(snapshot: LegacySnapshot, options: { migratedAt: Timestamp; hash: Hasher }): PlanOutcome {
  return new Planner(snapshot, options.migratedAt, options.hash).plan();
}

class Planner {
  private readonly problems: string[] = [];
  private clipped = 0;
  private outsideProtocol = 0;
  private readonly skipped: { id: Id; reason: string }[] = [];

  constructor(private readonly snapshot: LegacySnapshot, private readonly at: Timestamp, private readonly hash: Hasher) {}

  private fail(message: string): void { this.problems.push(message); }
  private take<T>(what: string, result: Result<T>): T | undefined {
    if (result.ok) return result.value;
    this.fail(`${what}: ${result.error.message}`);
    return undefined;
  }
  private clip(text: string, maximum: number): string {
    if (text.length <= maximum) return text;
    this.clipped++;
    return `${text.slice(0, maximum - 1)}…`;
  }

  plan(): PlanOutcome {
    const { issues, devRuns, verifications } = this.snapshot;
    const definitions: PlannedDefinition[] = [];
    const tasks = new Map<Id, TaskRevisionFacts>();
    for (const issue of [...issues].sort(byCreated)) {
      const planned = this.taskDefinition(issue, tasks);
      if (planned) definitions.push(planned);
    }
    const grader = this.graderDefinition();
    const migrated = this.runsAndWorks(devRuns, tasks);
    if (this.problems.length > 0 || !grader || !migrated) return { ok: false, problems: this.problems };
    definitions.push(grader.planned);
    const gradings = this.gradings([...verifications].sort(byCreated), migrated.runs, tasks, grader.ref);
    if (this.problems.length > 0) return { ok: false, problems: this.problems };
    const report: MigrationReport = {
      issues: issues.length, taskRevisions: issues.reduce((n, i) => n + i.revisions.length, 0),
      taskRuns: { delivered: devRuns.filter(r => r.state === "submitted").length, abandoned: devRuns.filter(r => r.state === "abandoned").length, stillOpen: devRuns.filter(r => r.state === "open").length },
      works: migrated.works.length, worksWithoutHead: migrated.works.filter(w => w.head === undefined).map(w => w.id),
      worksWithSelectedHead: migrated.works.filter(w => w.headHistory.some(h => h.reason === "migration-selection")).length,
      gradings: gradings.length, gradingsWithoutSession: gradings.filter(g => g.evaluator?.kind === "external" && g.evaluator.sessionId === undefined).length,
      skippedVerifications: this.skipped, clippedTexts: this.clipped, observationsOutsideProtocol: this.outsideProtocol, qualityReviewsLeftInPlace: this.snapshot.qualityReviewCount,
    };
    const digest = digestOf({
      definitions: definitions.map(d => ({ id: d.definition.id, revisions: d.revisions.map(r => r.digest) })),
      runs: migrated.runs.map(r => ({ id: r.id, status: r.status, manifest: r.manifest?.digest ?? null })),
      works: migrated.works.map(w => ({ id: w.id, runs: [...w.runIds], head: w.head ?? null })),
      gradings: gradings.map(g => ({ id: g.id, seq: g.requestSeq, manifest: g.binding?.manifestDigest ?? null })),
    }, this.hash);
    if (!digest.ok) return { ok: false, problems: [digest.error.message] };
    return { ok: true, plan: { migratedAt: this.at, definitions, taskRuns: migrated.runs, works: migrated.works, gradings, report, digest: digest.value } };
  }

  // ---- tasks ---------------------------------------------------------------

  private taskContent(revision: LegacyIssueRevision, issue: LegacyIssue): JsonValue {
    const criteria = [...revision.goals.flatMap(g => g.criteria), ...revision.constraints.flatMap(c => c.criteria)];
    return {
      kind: "coding", schemaVersion: 1, summary: this.clip(revision.summary, 1024),
      criteria: criteria.map(c => ({ id: c.id, statement: this.clip(c.statement, 4096) })),
      ...(revision.context ? { context: revision.context } : {}), ...(revision.plan ? { plan: revision.plan } : {}),
      legacy: {
        issueRevisionId: revision.id, requirementRevisionId: revision.requirementRevisionId, repositoryId: issue.repositoryId, baselineOid: revision.baselineOid, summary: revision.summary,
        goals: revision.goals.map(g => ({ id: g.id, statement: g.statement, criterionIds: g.criteria.map(c => c.id) })),
        constraints: revision.constraints.map(c => ({ id: c.id, statement: c.statement, ...(c.rationale ? { rationale: c.rationale } : {}), criterionIds: c.criteria.map(x => x.id) })),
      },
    };
  }

  private taskDefinition(issue: LegacyIssue, tasks: Map<Id, TaskRevisionFacts>): PlannedDefinition | undefined {
    const ordered = [...issue.revisions].sort((a, b) => a.number - b.number);
    if (ordered.length === 0) { this.fail(`issue ${issue.id} has no revision`); return undefined; }
    const created = this.take(`issue ${issue.id}`, createDefinition({ id: issue.id, kind: "task", name: this.clip(ordered[0].summary, 256), at: issue.createdAt }));
    if (!created) return undefined;
    let definition: Definition = created.state;
    const revisions: Revision[] = [];
    for (const [index, revision] of ordered.entries()) {
      if (revision.number !== index + 1) { this.fail(`issue ${issue.id} revision numbers are not consecutive at ${revision.number}`); return undefined; }
      const content = this.taskContent(revision, issue);
      const published: { state: Definition; outcome: Revision } | undefined = this.take(`issue revision ${revision.id}`, publishRevision(definition, { revisionId: revision.id, expectedSeq: index, content, at: revision.createdAt }, this.hash));
      if (!published) return undefined;
      definition = published.state;
      revisions.push(published.outcome);
      const parsed = this.take(`issue revision ${revision.id}`, parseTaskContent(content));
      const digest = parsed && this.take(`issue revision ${revision.id}`, criteriaDigest(parsed, this.hash));
      if (!parsed || !digest) return undefined;
      tasks.set(revision.id, { ref: refOf(published.outcome), criteria: parsed.criteria, criteriaDigest: digest, issueId: issue.id });
    }
    return { definition, revisions };
  }

  private graderDefinition(): { planned: PlannedDefinition; ref: RevisionRef } | undefined {
    const created = this.take("the verification grader", createDefinition({ id: BUILTIN_VERIFICATION_GRADER.definitionId, kind: "grader", name: "Independent verification (migrated)", at: this.at }));
    if (!created) return undefined;
    const published = this.take("the verification grader", publishRevision(created.state, { revisionId: BUILTIN_VERIFICATION_GRADER.revisionId, expectedSeq: 0, content: { strategy: "agent", scale: { form: "criteria" } }, at: this.at }, this.hash));
    if (!published) return undefined;
    return { planned: { definition: published.state, revisions: [published.outcome] }, ref: refOf(published.outcome) };
  }

  // ---- runs and works ------------------------------------------------------

  private manifestOf(run: LegacyDevRun): { digest: Digest; items: { type: "candidate"; id: Id; receipt: string }[]; operationId: Id } | undefined {
    const candidate = run.candidate;
    if (!candidate) return undefined;
    const digest = this.take(`candidate ${candidate.id}`, digestOf({ format: "grounds.legacy-candidate-manifest/v1", candidateId: candidate.id, patchDigest: candidate.patchDigest, resultTreeOid: candidate.resultTreeOid, artifactFormat: candidate.artifactFormat }, this.hash));
    if (!digest) return undefined;
    return { digest, items: [{ type: "candidate", id: candidate.id, receipt: `legacy:candidate:${candidate.id}` }], operationId: `migrated:${candidate.id}` };
  }

  private runsAndWorks(devRuns: readonly LegacyDevRun[], tasks: ReadonlyMap<Id, TaskRevisionFacts>): { runs: TaskRun[]; works: Work[] } | undefined {
    const byId = new Map(devRuns.map(r => [r.id, r]));
    const producer = new Map<Id, Id>(); // candidate id -> the run that produced it
    for (const run of devRuns) if (run.candidate) producer.set(run.candidate.id, run.id);
    const parentOf = new Map<Id, Id | undefined>();
    for (const run of devRuns) {
      if (!tasks.has(run.issueRevisionId)) { this.fail(`run ${run.id} belongs to an unknown issue revision ${run.issueRevisionId}`); continue; }
      if (run.state === "submitted" && !run.candidate) this.fail(`run ${run.id} was submitted but has no candidate`);
      if (run.state !== "submitted" && run.candidate) this.fail(`run ${run.id} is ${run.state} but has a candidate`);
      if (run.refinesCandidateId === undefined) { parentOf.set(run.id, undefined); continue; }
      const parent = producer.get(run.refinesCandidateId);
      if (!parent) { this.fail(`run ${run.id} refines candidate ${run.refinesCandidateId}, which no run produced`); continue; }
      if (byId.get(parent)!.issueId !== run.issueId) { this.fail(`run ${run.id} refines a candidate of another issue`); continue; }
      parentOf.set(run.id, parent);
    }
    if (this.problems.length > 0) return undefined;
    // Trees: a root is a run that refines nothing; every other run belongs to the tree of the run it refines.
    const ordered = [...devRuns].sort(byCreated);
    const children = new Map<Id, Id[]>();
    for (const run of ordered) { const parent = parentOf.get(run.id); if (parent) children.set(parent, [...(children.get(parent) ?? []), run.id]); }
    const runs = new Map<Id, TaskRun>();
    const works: Work[] = [];
    for (const root of ordered.filter(r => parentOf.get(r.id) === undefined)) {
      const tree: Id[] = [];
      const walk = (id: Id): void => { tree.push(id); for (const child of children.get(id) ?? []) walk(child); };
      walk(root.id);
      const leaves = tree.filter(id => (children.get(id) ?? []).length === 0);
      const workId = `work:${root.id}`;
      const inTree = new Set(tree);
      // The latest choice among the candidates this work produced; an unselected issue revision contributes none.
      const selected = this.snapshot.selections.map(s => ({ runId: producer.get(s.candidateId), at: s.updatedAt })).filter((s): s is { runId: Id; at: string } => s.runId !== undefined && inTree.has(s.runId))
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      const work = this.take(`work ${workId}`, migrateWork({ id: workId, taskDefinitionId: root.issueId, runIds: tree, ...(leaves.length === 1 ? { defaultHead: leaves[0] } : {}), ...(selected ? { selected } : {}), at: this.at }))?.state;
      if (!work) continue;
      works.push(work);
      for (const id of tree) {
        const legacy = byId.get(id)!;
        const parent = parentOf.get(id);
        const parentRun = parent ? runs.get(parent) : undefined;
        const manifest = this.manifestOf(legacy);
        const outcome = legacy.state === "submitted"
          ? manifest && { type: "delivered" as const, items: manifest.items, digest: manifest.digest, operationId: manifest.operationId, at: legacy.candidate!.createdAt }
          : { type: "cancelled" as const, reason: legacy.state === "abandoned" ? `abandoned${legacy.abandonReason ? `: ${legacy.abandonReason}` : ""}` : "migration: the run was still open at the cutover", at: this.at };
        if (!outcome) continue;
        const imported = this.take(`run ${id}`, importLegacyTaskRun({ id, taskRevision: tasks.get(legacy.issueRevisionId)!.ref, workId, ...(parent ? { refines: parent } : {}), createdAt: legacy.createdAt, migratedAt: this.at, outcome },
          parentRun ? { refines: { id: parentRun.id, status: parentRun.status, taskDefinitionId: parentRun.taskRevision.definitionId, workId: parentRun.workId } } : undefined))?.state;
        if (imported) runs.set(id, imported);
      }
    }
    return { runs: [...runs.values()], works };
  }

  // ---- gates ---------------------------------------------------------------

  private protocolOf(run: LegacyVerificationRun | undefined): { protocol: ProtocolRecord[]; observations: CommandObservation[] } {
    if (!run) return { protocol: [], observations: [] };
    const protocol: ProtocolRecord[] = [];
    // A stage counts as done when its last attempt succeeded or when the run recorded the fact the stage produces.
    const facts: Partial<Record<ProtocolStage, string | undefined>> = { freeze: run.freeze?.at, handoff: run.handoff?.at, submit: run.submit?.at };
    for (const stage of protocolStages) {
      const done = [...(run.stages[stage] ?? [])].reverse().find(a => a.state === "succeeded");
      const at = done ? (done.endedAt ?? done.startedAt) : facts[stage];
      if (!at) continue;
      const blindDigest = stage === "freeze" && run.freeze && /^sha256:[0-9a-f]{64}$/.test(run.freeze.digest) ? run.freeze.digest : undefined;
      protocol.push({ stage, at, ...(blindDigest ? { blindDigest } : {}) });
    }
    const observations: CommandObservation[] = [];
    for (const command of run.commands) {
      if (!(protocolStages as readonly string[]).includes(command.stage)) { this.outsideProtocol++; continue; }
      observations.push({ stage: command.stage as ProtocolStage, entry: command.entry, argvDigest: command.argvDigest, state: command.state, ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}), at: command.endedAt });
    }
    return { protocol, observations };
  }

  private gradings(verifications: readonly LegacyVerification[], runs: readonly TaskRun[], tasks: ReadonlyMap<Id, TaskRevisionFacts>, grader: RevisionRef): GradingRecord[] {
    const runOfCandidate = new Map<Id, TaskRun>();
    for (const run of runs) for (const item of run.manifest?.items ?? []) if (item.type === "candidate") runOfCandidate.set(item.id, run);
    const candidates = new Map(this.snapshot.devRuns.flatMap(r => r.candidate ? [[r.candidate.id, r.candidate] as const] : []));
    const out: GradingRecord[] = [];
    for (const verification of verifications) {
      const run = runOfCandidate.get(verification.candidateId);
      const candidate = candidates.get(verification.candidateId);
      if (!run || !candidate || !run.manifest) { this.skipped.push({ id: verification.id, reason: "its candidate was not migrated" }); continue; }
      const task = tasks.get(run.taskRevision.revisionId)!;
      const judged = new Set(verification.assessments.map(a => a.criterionId));
      const expected = task.criteria.map(c => c.id);
      if (judged.size !== verification.assessments.length || judged.size !== expected.length || !expected.every(id => judged.has(id))) {
        this.skipped.push({ id: verification.id, reason: "it did not judge exactly the criteria of its issue revision" });
        continue;
      }
      const materials = [{ id: verification.id, digest: verification.blindContextDigest }];
      const materialsFingerprint = this.take(`verification ${verification.id}`, materialsDigest(materials, this.hash));
      if (!materialsFingerprint) continue;
      const items: CriterionVerdict[] = verification.assessments.map(a => ({
        criterionId: a.criterionId, independent: verdictOf[a.independent], reconciliation: a.reconciliation, final: verdictOf[a.final], rationale: this.clip(a.finalExplanation || "(no explanation recorded)", 4096),
        evidence: [`independent: ${this.clip(a.independentExplanation, 1000)}`, `reconciliation: ${this.clip(a.reconciliationExplanation, 1000)}`, ...a.evidence.map(e => `command ${JSON.stringify(e.command)} exit ${e.exitCode} output ${e.outputDigest}`)],
      }));
      const { protocol, observations } = this.protocolOf(verification.run);
      const createdAt = [verification.createdAt, ...protocol.map(p => p.at)].sort()[0];
      const agentId = verification.agent.id ?? verification.agent.name;
      const imported = this.take(`verification ${verification.id}`, importLegacyGate({
        id: verification.id, requestSeq: out.length + 1, taskRunId: run.id, target: { type: "candidate", id: candidate.id, digest: candidate.patchDigest }, graderRevision: grader,
        binding: { taskRevision: task.ref, criteriaDigest: task.criteriaDigest, manifestDigest: run.manifest.digest, graderRevision: grader, materialsDigest: materialsFingerprint, expectedCriteria: expected }, materials,
        evaluator: { ...(verification.run ? { sessionId: verification.run.reviewSessionId } : {}), ...(agentId ? { agentId } : {}), protocol, commandObservations: observations },
        grade: { form: "criteria", items }, createdAt, completedAt: verification.createdAt,
      }))?.state;
      if (imported) out.push(imported);
    }
    return out;
  }
}

function byCreated<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  return a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);
}
