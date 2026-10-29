import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLStore } from "../src/sql-store.js";
import { Module } from "../src/module.js";
import { EvalModule } from "../src/eval-module.js";
import { renderEvalReport } from "../src/eval-report.js";
import type { GraderDraft } from "../src/evaluation.js";
import { sha256 } from "../src/canonical-json.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";

const required = [
  "GROUNDS_TEST_MYSQL_HOST",
  "GROUNDS_TEST_MYSQL_DATABASE",
  "GROUNDS_TEST_MYSQL_USERNAME",
  "GROUNDS_TEST_MYSQL_PASSWORD",
] as const;

const enabled = required.every((name) => Boolean(process.env[name]));

const mysqlStore = (): SQLStore => SQLStore.mysql({
  host: process.env.GROUNDS_TEST_MYSQL_HOST!,
  port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? "3306"),
  database: process.env.GROUNDS_TEST_MYSQL_DATABASE!,
  username: process.env.GROUNDS_TEST_MYSQL_USERNAME!,
  password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!,
  ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? { caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE } : {}),
});

test("MySQL adapter passes the core lifecycle conformance scenario", { skip: !enabled }, async () => {
  const store = mysqlStore();
  const fixture = await LedgerFixture.createWithStore(store);
  try {
    const candidate = await fixture.submitCandidate();
    const verification = await fixture.verify(candidate);
    assert.equal(verification.overall_verdict, "qualified");
    assert.equal((await fixture.module.showCandidate(candidate.candidate.candidate_id)).candidate.standing, "qualified");
  } finally {
    await fixture.close();
  }
});

// Eval conformance runs on all three adapters so the MySQL and PostgreSQL paths are
// compared against the SQLite reference instead of only being skipped when no
// server is set up.
type Backend = "sqlite" | "mysql" | "postgres";
const backendEnabled = (backend: Backend): boolean => backend === "sqlite" || (backend === "mysql" ? enabled : postgresEnabled);

const openFixture = async (backend: Backend): Promise<LedgerFixture> => {
  if (backend === "sqlite") return LedgerFixture.create();
  if (backend === "mysql") return LedgerFixture.createWithStore(mysqlStore());
  const pg = await isolatedPostgres();
  return LedgerFixture.createWithStore(pg.store, pg.cleanup);
};

const evalActor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });

const graderDraft = (f: LedgerFixture): GraderDraft => ({
  format: "patchledger.eval-grader/v1",
  issue: { id: f.issue.issue_id, version: 1 },
  name: "Behavior",
  scope: { kind: "diagnostic", name: "Public behavior" },
  result_spec: { kind: "decision" },
  definition: { type: "agent", instructions: "Write table-driven tests first; reason only where tests are impractical." },
  limitations: "Conformance fixture, not calibrated",
});

for (const backend of ["sqlite", "mysql", "postgres"] as const) test(`${backend}: Eval revisions, snapshots and immutable closure persist with the same contract`, { skip: !backendEnabled(backend) }, async () => {
  const f = await openFixture(backend);
  try {
    const evals = new EvalModule(f.store);
    const draft = graderDraft(f);
    const grader = await evals.publishGrader(draft, evalActor());
    const empty = await evals.createSuite(`Conformance ${backend} ${newUUIDv7()}`, evalActor());
    const suite = await evals.changeTask(empty.id, empty.version, { type: "add", task: { name: "Implement behavior", issue: grader.data.issue, graders: [{ id: grader.id, version: grader.version }] } }, evalActor());
    const experiment = await evals.createExperiment({ suite_id: suite.id }, { name: `Subject ${backend}`, description: "Same frozen snapshot on both adapters" }, evalActor());
    const task = suite.data.tasks[0];

    // Appending a Grader version keeps the frozen task on v1 and the old revision readable.
    const updated = await evals.publishGrader({ ...draft, name: "Behavior v2" }, evalActor(), { id: grader.id, expected_version: 1 });
    assert.equal(updated.version, 2);
    assert.equal((await evals.show("grader", grader.id, 1)).data.name, "Behavior");
    assert.equal((await evals.list("grader", f.issue.issue_id)).find(record => record.id === grader.id)?.version, 2);
    assert.equal(task.graders[0].version, 1);

    // Regrading an existing Candidate must not create development ownership.
    const candidate = await f.submitCandidate(`conformance-${backend}`);
    const run = await evals.startRun({ experiment_id: experiment.id, task_id: task.id, candidate_id: candidate.candidate.candidate_id }, evalActor());
    const execution = await evals.reserveGrader(run.id, grader.id, evalActor());
    assert.equal(execution.data.grader.version, 1);
    const submission = {
      format: "patchledger.eval-grader-submission/v1" as const,
      execution_id: execution.id, context_digest: execution.data.context_digest,
      status: "completed" as const, outcome: { kind: "decision" as const, verdict: "fail" as const },
      explanation: "Expected branch missing", evidence: [{ kind: "observation" as const, content: "code reference" }],
    };
    await evals.submitGrader(submission, evalActor());
    const result = await evals.finishRun(run.id, evalActor());
    assert.equal(result.data.graders[0].submission?.outcome?.kind, "decision");
    assert.equal(result.data.development_duration.kind, "referenced");
    assert.deepEqual(await evals.finishRun(run.id, evalActor()), result, "closure is repeatable on both adapters");

    const report = await evals.report(experiment.id);
    assert.equal(report.tasks[0].runs.length, 1);
    assert.match(renderEvalReport(report), /Verdict: fail/);

    // Append-only Eval revisions must surface through the shared ledger event store,
    // and each audit fact must still bind the digest of the revision it recorded.
    const events = await f.store.read(tx => tx.listLedgerEventsPage(0, "", "eval_grader", grader.id, 100));
    const recorded = events.rows.filter(event => event.event_type === "eval.grader.recorded");
    assert.equal(recorded.length, 2);
    for (const event of recorded) {
      const revision = await evals.show("grader", grader.id, event.subject_version!);
      assert.equal(event.subject_version, revision.version);
      assert.equal(event.facts.find(fact => fact.name === "record_digest")?.value, sha256(revision));
    }
  } finally { await f.close(); }
});

for (const backend of ["sqlite", "mysql", "postgres"] as const) test(`${backend}: concurrent Eval revision appends leave exactly one winner`, { skip: !backendEnabled(backend) }, async () => {
  const f = await openFixture(backend);
  try {
    const evals = new EvalModule(f.store);
    const draft = graderDraft(f);
    const grader = await evals.publishGrader(draft, evalActor());
    const attempts = await Promise.allSettled([
      evals.publishGrader({ ...draft, name: "Concurrent A" }, evalActor(), { id: grader.id, expected_version: 1 }),
      evals.publishGrader({ ...draft, name: "Concurrent B" }, evalActor(), { id: grader.id, expected_version: 1 }),
    ]);
    const fulfilled = attempts.filter(outcome => outcome.status === "fulfilled");
    const rejected = attempts.filter(outcome => outcome.status === "rejected") as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0].reason as { code?: string }).code, "VERSION_CONFLICT");
    assert.equal((await evals.show("grader", grader.id)).version, 2);
    assert.equal((await evals.show("grader", grader.id, 1)).data.name, "Behavior", "the losing attempt must not append a partial revision");
  } finally { await f.close(); }
});

test("concurrent MySQL authoring publications get or create one Repository atomically", { skip: !enabled }, async () => {
  const initializer = mysqlStore();
  await initializer.initialize("require_override");
  await initializer.close();
  const leftStore = mysqlStore();
  const rightStore = mysqlStore();
  const canonicalRemote = `ssh://git@example.test/team/mysql-${newUUIDv7()}`;
  const command = () => ({
    operation_id: newUUIDv7(), canonical_remote: canonicalRemote, attribution: testAgent,
    requirement: { input: { format: 1 as const, summary: "MySQL Workspace", outcomes: ["It completes"] } },
    issues: [{ baseline: testBaseline, input: { format: 1 as const, summary: "Create the model", goals: [{ statement: "Create records", criteria: ["Records are bound"] }] } }],
  });
  try {
    const [left, right] = await Promise.all([
      new Module(leftStore).publishAuthoring(command()),
      new Module(rightStore).publishAuthoring(command()),
    ]);
    assert.equal(left.result.repository_id, right.result.repository_id);
    assert.deepEqual([left.result.repository_action, right.result.repository_action].sort(), ["registered", "resolved"]);
  } finally {
    await leftStore.close();
    await rightStore.close();
  }
});

for (const backend of ['sqlite', 'mysql', 'postgres'] as const) test(`${backend}: QA records and multi-chunk evidence are portable and immutable`, { skip: !backendEnabled(backend) }, async () => {
  const f = await openFixture(backend);
  try {
    const { randomBytes } = await import('node:crypto'); const { sha256Bytes } = await import('../src/canonical-json.js');
    const m = new EvalModule(f.store); const content = randomBytes(2 * 1024 * 1024 + 17);
    const digest = await f.store.write(tx => tx.putEvalBlob(content));
    assert.equal(await f.store.write(tx => tx.putEvalBlob(content)), digest);
    assert.deepEqual(await f.store.read(tx => tx.getEvalBlob(digest)), content);
    const draft = { format: 'grounds.eval-qa/v1', name: 'QA portability', question: 'What happened?', instructions: 'Use sources.', rubric: 'Do not invent facts.', required_points: ['Facts'], forbidden_claims: [], references: [], source: { identity: `conformance:${newUUIDv7()}`, repository: 'fixture', revision: 'fixed', path: 'qa.json', digest: sha256Bytes(Buffer.from('source')), record: {} } };
    const qa = await m.publishQA(draft, evalActor()); assert.equal((await m.publishQA(draft, evalActor())).id, qa.id);
    await m.publishQA({ ...draft, question: 'What changed?' }, evalActor(), { id: qa.id, expected_version: 1 });
    assert.equal((await m.show('qa', qa.id, 1)).data.question, 'What happened?');
    assert.equal((await m.show('qa', qa.id)).version, 2);
  } finally { await f.close(); }
});
