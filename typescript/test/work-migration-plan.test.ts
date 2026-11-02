import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceOf, taskRunViolations, workViolations, gradingViolations, definitionViolations, revisionViolations } from "../src/work/domain/index.js";
import { BUILTIN_VERIFICATION_GRADER, planMigration, type MigrationPlan } from "../src/work/application/index.js";
import type { LegacyAssessment, LegacyDevRun, LegacyIssue, LegacySnapshot, LegacyVerification } from "../src/work/ports/legacy.js";
import { hash } from "./work-fixtures.js";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const MIGRATED_AT = T(10_000);

const criteria = (prefix: string) => [{ id: `${prefix}-c1`, statement: "behaves" }, { id: `${prefix}-c2`, statement: "is tested" }];
const issue = (id: string, revisions = 1): LegacyIssue => ({
  id, repositoryId: "repo-1", createdAt: T(1),
  revisions: Array.from({ length: revisions }, (_, i) => ({
    id: `${id}-rev-${i + 1}`, number: i + 1, requirementRevisionId: "req-rev-1", summary: `Issue ${id} v${i + 1}`, baselineOid: "sha1:0123", createdAt: T(2 + i),
    goals: [{ id: `${id}-g1`, statement: "goal", criteria: criteria(`${id}-r${i + 1}`) }], constraints: [],
  })),
});
const run = (id: string, over: Partial<LegacyDevRun> & { cand?: boolean } = {}): LegacyDevRun => {
  const { cand = over.state !== "open" && over.state !== "abandoned", ...rest } = over;
  return { id, issueId: "issue-1", issueRevisionId: "issue-1-rev-1", state: "submitted", createdAt: T(100), ...rest,
    ...(cand ? { candidate: { id: `cand-${id}`, devRunId: id, issueRevisionId: rest.issueRevisionId ?? "issue-1-rev-1", patchDigest: d("a"), resultTreeOid: "sha1:abcd", artifactFormat: "grounds.git-commit-artifact/v1", blindContextDigest: d("b"), createdAt: T(200) } } : {}) };
};
const assessment = (criterionId: string, verdict: LegacyAssessment["final"] = "qualified"): LegacyAssessment => ({
  criterionId, independent: verdict, independentExplanation: "looked", reconciliation: "corroborated", reconciliationExplanation: "agrees", final: verdict, finalExplanation: "ok", evidence: [{ command: "go test", exitCode: 0, outputDigest: d("c") }],
});
const verification = (id: string, candidateId: string, over: Partial<LegacyVerification> = {}): LegacyVerification => ({
  id, candidateId, blindContextDigest: d("d"), createdAt: T(300), agent: { kind: "agent", id: "reviewer-1" },
  assessments: [assessment("issue-1-r1-c1"), assessment("issue-1-r1-c2")], ...over,
});
const snapshot = (over: Partial<LegacySnapshot> = {}): LegacySnapshot => ({ issues: [issue("issue-1")], devRuns: [], verifications: [], qualityReviewCount: 0, ...over });
const plan = (s: LegacySnapshot): MigrationPlan => {
  const outcome = planMigration(s, { migratedAt: MIGRATED_AT, hash });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.problems.join("\n"));
  return outcome.plan;
};
const problems = (s: LegacySnapshot): readonly string[] => {
  const outcome = planMigration(s, { migratedAt: MIGRATED_AT, hash });
  assert.ok(!outcome.ok, "expected the plan to be refused");
  return outcome.ok ? [] : outcome.problems;
};

test("an issue becomes a task definition whose revisions keep their identity, numbering and criteria", () => {
  const p = plan(snapshot({ issues: [issue("issue-1", 2)] }));
  const task = p.definitions.find(x => x.definition.id === "issue-1")!;
  assert.equal(task.definition.kind, "task");
  assert.deepEqual(task.revisions.map(r => [r.id, r.seq]), [["issue-1-rev-1", 1], ["issue-1-rev-2", 2]]);
  assert.equal(task.revisions[1].predecessorId, "issue-1-rev-1");
  const content = task.revisions[0].content as { criteria: { id: string }[]; legacy: { goals: unknown[] } };
  assert.deepEqual(content.criteria.map(c => c.id), ["issue-1-r1-c1", "issue-1-r1-c2"]);
  assert.equal(content.legacy.goals.length, 1);
  assert.equal(p.report.taskRevisions, 2);
  for (const x of p.definitions) { assert.deepEqual(definitionViolations(x.definition), []); for (const r of x.revisions) assert.deepEqual(revisionViolations(r), []); }
  const grader = p.definitions.find(x => x.definition.id === BUILTIN_VERIFICATION_GRADER.definitionId)!;
  assert.equal(grader.definition.kind, "grader");
  assert.equal(grader.revisions[0].id, BUILTIN_VERIFICATION_GRADER.revisionId);
});

test("states map as the model says: submitted is delivered by its caller, abandoned and still-open are cancelled with a reason", () => {
  const p = plan(snapshot({ devRuns: [run("r1"), run("r2", { state: "abandoned", abandonReason: "wrong approach" }), run("r3", { state: "open" })] }));
  const byId = new Map(p.taskRuns.map(r => [r.id, r]));
  assert.equal(byId.get("r1")!.status, "delivered");
  assert.equal(byId.get("r1")!.manifest!.origin, "caller");
  assert.deepEqual(byId.get("r1")!.manifest!.items.map(i => i.id), ["cand-r1"]);
  assert.equal(byId.get("r2")!.status, "cancelled");
  assert.equal(byId.get("r2")!.cancelIntent!.reason, "abandoned: wrong approach");
  assert.match(byId.get("r3")!.cancelIntent!.reason!, /still open/);
  assert.equal(byId.get("r3")!.terminalAt, MIGRATED_AT);
  for (const r of p.taskRuns) { assert.deepEqual(taskRunViolations(r), []); assert.deepEqual(r.migrated, { source: "dev-run", at: MIGRATED_AT }); }
  assert.deepEqual(p.report.taskRuns, { delivered: 1, abandoned: 1, stillOpen: 1 });
});

test("runs that refine each other form one work whose single leaf is the migration default head", () => {
  const p = plan(snapshot({ devRuns: [run("r1", { createdAt: T(100) }), run("r2", { createdAt: T(400), refinesCandidateId: "cand-r1" }), run("r3", { createdAt: T(500), refinesCandidateId: "cand-r2" })] }));
  assert.equal(p.works.length, 1);
  const work = p.works[0];
  assert.equal(work.id, "work:r1");
  assert.deepEqual(work.runIds, ["r1", "r2", "r3"]);
  assert.equal(work.head, "r3");
  assert.deepEqual(work.headHistory.map(h => h.reason), ["migration-default"]);
  assert.equal(work.migrated, true);
  assert.deepEqual(workViolations(work), []);
  const byId = new Map(p.taskRuns.map(r => [r.id, r]));
  assert.equal(byId.get("r2")!.refines, "r1");
  assert.equal(byId.get("r3")!.workId, "work:r1");
  assert.deepEqual(p.report.worksWithoutHead, []);
});

test("a tree with several leaves has no head until someone selects one; the migration does not pick by time", () => {
  const p = plan(snapshot({ devRuns: [run("r1"), run("r2", { createdAt: T(400), refinesCandidateId: "cand-r1" }), run("r3", { createdAt: T(900), refinesCandidateId: "cand-r1" })] }));
  const work = p.works[0];
  assert.equal(work.head, undefined);
  assert.deepEqual(work.headHistory, []);
  assert.deepEqual(work.runIds, ["r1", "r2", "r3"]);
  assert.deepEqual(workViolations(work), []);
  assert.deepEqual(p.report.worksWithoutHead, ["work:r1"]);
});

test("runs that refine nothing each start their own work, even under one issue", () => {
  const p = plan(snapshot({ devRuns: [run("r1"), run("r2", { createdAt: T(150) }), run("r3", { createdAt: T(160), state: "open" })] }));
  assert.deepEqual(p.works.map(w => [w.id, w.head, w.runIds.length]), [["work:r1", "r1", 1], ["work:r2", "r2", 1], ["work:r3", "r3", 1]]);
  assert.equal(p.report.works, 3);
});

test("a refinement may sit on a later revision of the same task", () => {
  const p = plan(snapshot({ issues: [issue("issue-1", 2)], devRuns: [run("r1"), run("r2", { issueRevisionId: "issue-1-rev-2", createdAt: T(400), refinesCandidateId: "cand-r1" })] }));
  const byId = new Map(p.taskRuns.map(r => [r.id, r]));
  assert.equal(byId.get("r1")!.taskRevision.seq, 1);
  assert.equal(byId.get("r2")!.taskRevision.seq, 2);
  assert.equal(p.works.length, 1);
});

test("a verification becomes a completed gate bound to its run, with a migrated external evaluator and its protocol facts", () => {
  const withRun = verification("ver-1", "cand-r1", { run: {
    reviewSessionId: "session-1", freeze: { digest: d("e"), at: T(322) }, handoff: { at: T(325) },
    stages: { blind: [{ state: "failed", startedAt: T(310) }, { state: "succeeded", startedAt: T(311), endedAt: T(320) }], freeze: [{ state: "succeeded", startedAt: T(321), endedAt: T(322) }], submit: [{ state: "succeeded", startedAt: T(330), endedAt: T(331) }], prepare: [{ state: "succeeded", startedAt: T(305), endedAt: T(306) }] },
    commands: [{ stage: "blind", entry: "candidate-context", argvDigest: d("f"), state: "succeeded", exitCode: 0, endedAt: T(312) }, { stage: "prepare", entry: "worktree", argvDigest: d("9"), state: "succeeded", endedAt: T(307) }],
  } });
  const p = plan(snapshot({ devRuns: [run("r1")], verifications: [withRun] }));
  assert.equal(p.gradings.length, 1);
  const gate = p.gradings[0];
  assert.equal(gate.id, "ver-1");
  assert.equal(gate.requestSeq, 1);
  assert.equal(gate.status, "completed");
  assert.deepEqual(gate.origin, { type: "gate", taskRunId: "r1" });
  assert.equal(gate.binding!.manifestDigest, p.taskRuns[0].manifest!.digest);
  assert.deepEqual(gate.binding!.expectedCriteria, ["issue-1-r1-c1", "issue-1-r1-c2"]);
  assert.equal(gate.graderRevision.revisionId, BUILTIN_VERIFICATION_GRADER.revisionId);
  assert.equal(gate.evaluator?.kind === "external" && gate.evaluator.sessionId, "session-1");
  assert.equal(gate.evaluator?.kind === "external" && gate.evaluator.agentId, "reviewer-1");
  const evaluator = gate.evaluator?.kind === "external" ? gate.evaluator : undefined;
  assert.deepEqual(evaluator?.protocol?.map(r => [r.stage, r.at]), [["blind", T(320)], ["freeze", T(322)], ["handoff", T(325)], ["submit", T(331)]], "the last successful attempt of a stage, or the fact the run recorded for it");
  assert.equal(evaluator?.protocol?.[1].blindDigest, d("e"));
  assert.equal(evaluator?.commandObservations?.length, 1, "a prepare command has no place in the protocol");
  assert.equal(p.report.observationsOutsideProtocol, 1);
  assert.deepEqual(gradingViolations(gate), []);
  const grade = gate.grade!;
  assert.equal(grade.form === "criteria" && grade.items[0].final, "satisfied");
  assert.equal(p.report.gradingsWithoutSession, 0);
});

test("a stage that has no attempt but left its recorded fact still counts as done", () => {
  const onlyFacts = verification("ver-1", "cand-r1", { run: { reviewSessionId: "session-1", stages: {}, freeze: { digest: d("e"), at: T(322) }, submit: { at: T(331) }, commands: [] } });
  const evaluator = plan(snapshot({ devRuns: [run("r1")], verifications: [onlyFacts] })).gradings[0].evaluator;
  assert.deepEqual(evaluator?.kind === "external" && evaluator.protocol?.map(r => r.stage), ["freeze", "submit"]);
});

test("a verification whose session the old ledger did not keep is migrated without one, and says so", () => {
  const p = plan(snapshot({ devRuns: [run("r1")], verifications: [verification("ver-1", "cand-r1")] }));
  const evaluator = p.gradings[0].evaluator;
  assert.equal(evaluator?.kind === "external" && evaluator.sessionId, undefined);
  assert.equal(evaluator?.kind === "external" && evaluator.migrated, true);
  assert.deepEqual(evaluator?.kind === "external" && evaluator.protocol, []);
  assert.equal(p.report.gradingsWithoutSession, 1);
});

test("migrated gates give the same acceptance a native one would: the latest request over the same subject wins", () => {
  const later = verification("ver-2", "cand-r1", { createdAt: T(600), assessments: [assessment("issue-1-r1-c1", "rejected"), assessment("issue-1-r1-c2")] });
  const p = plan(snapshot({ devRuns: [run("r1")], verifications: [later, verification("ver-1", "cand-r1")] }));
  assert.deepEqual(p.gradings.map(g => [g.id, g.requestSeq]), [["ver-1", 1], ["ver-2", 2]], "request order follows creation time, not input order");
  const subject = { taskRevisionId: "issue-1-rev-1", criteriaDigest: p.gradings[0].binding!.criteriaDigest, manifestDigest: p.taskRuns[0].manifest!.digest };
  const acceptance = acceptanceOf(p.gradings, subject);
  assert.equal(acceptance.adopted, "ver-2");
  assert.equal(acceptance.conclusion, "rejected");
  assert.equal(acceptance.disputed, true, "an earlier verdict that differs is shown as a dispute");
});

test("verifications that cannot be mapped faithfully are left out of the new model and reported, never reshaped", () => {
  const p = plan(snapshot({ devRuns: [run("r1")], verifications: [
    verification("ver-ok", "cand-r1"),
    verification("ver-partial", "cand-r1", { assessments: [assessment("issue-1-r1-c1")] }),
    verification("ver-orphan", "cand-unknown"),
  ] }));
  assert.deepEqual(p.gradings.map(g => g.id), ["ver-ok"]);
  assert.deepEqual(p.report.skippedVerifications.map(s => s.id).sort(), ["ver-orphan", "ver-partial"]);
});

test("overlong texts are shortened to the new limits, counted, and kept in full in the task's legacy block", () => {
  const long = "x".repeat(3000);
  const i = issue("issue-1"); const withLong = { ...i, revisions: [{ ...i.revisions[0], summary: long }] };
  const p = plan(snapshot({ issues: [withLong] }));
  const revision = p.definitions.find(x => x.definition.id === "issue-1")!.revisions[0].content as { summary: string; legacy: { summary: string } };
  assert.equal(revision.summary.length, 1024);
  assert.equal(revision.legacy.summary, long);
  assert.ok(p.report.clippedTexts >= 1);
});

test("quality reviews are counted as left in place", () => {
  assert.equal(plan(snapshot({ qualityReviewCount: 3 })).report.qualityReviewsLeftInPlace, 3);
});

test("the plan is deterministic and its digest changes with the data", () => {
  const s = snapshot({ devRuns: [run("r1")], verifications: [verification("ver-1", "cand-r1")] });
  assert.equal(plan(s).digest, plan(s).digest);
  assert.deepEqual(plan(s), plan(s));
  const other = snapshot({ devRuns: [run("r1"), run("r2", { createdAt: T(150) })], verifications: [verification("ver-1", "cand-r1")] });
  assert.notEqual(plan(other).digest, plan(s).digest);
});

test("inconsistent legacy data refuses the whole plan and names every problem", () => {
  const found = problems(snapshot({ devRuns: [
    run("r1", { issueRevisionId: "nope" }),
    run("r2", { cand: false }),
    run("r3", { state: "open", cand: true }),
    run("r4", { refinesCandidateId: "cand-nobody" }),
  ] }));
  assert.equal(found.length, 4);
  assert.match(found.join("\n"), /unknown issue revision nope/);
  assert.match(found.join("\n"), /submitted but has no candidate/);
  assert.match(found.join("\n"), /is open but has a candidate/);
  assert.match(found.join("\n"), /no run produced/);
  assert.match(problems(snapshot({ issues: [{ ...issue("issue-1"), revisions: [] }] }))[0], /no revision/);
  const skewed = issue("issue-1", 2); const gap = { ...skewed, revisions: [skewed.revisions[0], { ...skewed.revisions[1], number: 3 }] };
  assert.match(problems(snapshot({ issues: [gap] }))[0], /not consecutive/);
});

test("a run that refines a candidate of another issue is refused", () => {
  const found = problems(snapshot({ issues: [issue("issue-1"), issue("issue-2")], devRuns: [run("r1"), run("r2", { issueId: "issue-2", issueRevisionId: "issue-2-rev-1", refinesCandidateId: "cand-r1" })] }));
  assert.match(found.join("\n"), /another issue/);
});
