import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLStore } from "../src/sql-store.js";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";
import type { IssueWriteResult, RepositoryWriteResult, RequirementWriteResult } from "../src/module.js";
import { execute, runCLI } from "../src/cli.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";
import { isolatedMySQL } from "./isolated-mysql.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";

const mysqlEnabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every(key => process.env[`GROUNDS_TEST_MYSQL_${key}`]);


const validation = (field: string) => (error: unknown) => {
  assert.ok(error instanceof DomainError); assert.equal(error.code, "VALIDATION_ERROR"); assert.equal((error.details as { field?: string }).field, field); return true;
};

const addRequirement = async (f: LedgerFixture, summary: string): Promise<RequirementWriteResult> => (await f.module.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent, input: { format: 1, summary, outcomes: ["Observable"] } })).result;
const addRepository = async (f: LedgerFixture, remote: string): Promise<RepositoryWriteResult> => (await f.module.registerRepository({ operation_id: newUUIDv7(), attribution: testAgent, canonical_remote: remote })).result;
const addIssue = async (f: LedgerFixture, requirement: RequirementWriteResult, repository: RepositoryWriteResult, summary: string): Promise<IssueWriteResult> => (await f.module.createIssue({
  operation_id: newUUIDv7(), attribution: testAgent, requirement_id: requirement.requirement_id, requirement_revision_id: requirement.requirement_revision_id, requirement_revision_explicit: true, repository_id: repository.repository_id, baseline: testBaseline,
  input: { format: 1, summary, goals: [{ statement: "Change behavior", criteria: ["The behavior changes"], traces_to: [{ type: "outcome", ordinal: 1 }] }] },
})).result;
const openRun = (f: LedgerFixture, issue: IssueWriteResult, repository: RepositoryWriteResult) => f.module.startDevRun({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: issue.issue_id, issue_revision_id: issue.issue_revision_id, issue_revision_explicit: false, repository_remote_snapshot: repository.canonical_remote });

// Board fixture: five Issues across two Repositories and two Requirements, one
// per distinct ledger-provable state (plus an abandoned-only Issue, which must
// still be `ready`).
// Ledger timestamps have millisecond precision; separate the steps whose relative order is asserted.
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const seed = async (f: LedgerFixture) => {
  const r1 = f.repository; const r2 = await addRepository(f, "ssh://git@example.test/team/other");
  const req2 = await addRequirement(f, "A second requirement");
  const ready = f.issue;                                                     // R1, req1, ready
  const exploring = await addIssue(f, f.requirement, r2, "Exploring issue"); // R2, req1
  const rejectedAndOpen = await addIssue(f, f.requirement, r1, "Rejected plus open"); // R1, req1
  const selected = await addIssue(f, req2, r1, "Selected issue");            // R1, req2
  const abandoned = await addIssue(f, req2, r2, "Abandoned only");           // R2, req2
  const run = await openRun(f, exploring, r2);
  const rejectedCandidate = await f.submitCandidate("one", undefined, [], false, undefined, rejectedAndOpen);
  await f.verify(rejectedCandidate, "rejected");
  await tick();
  const secondRun = await openRun(f, rejectedAndOpen, r1);
  const selectedCandidate = await f.submitCandidate("two", undefined, [], false, undefined, selected);
  await f.verify(selectedCandidate, "qualified");
  await tick();
  await f.module.setSelection({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: selected.issue_id, issue_version: 1, candidate_id: selectedCandidate.candidate.candidate_id, expected_version: 0, reason: "best" } as never);
  await tick();
  const dropped = await openRun(f, abandoned, r2);
  await tick();
  await f.module.abandonDevRun({ operation_id: newUUIDv7(), attribution: testAgent, dev_run_id: dropped.result.context.dev_run.id, expected_version: 1, reason: "no longer needed" });
  return { r1, r2, req2, ready, exploring, rejectedAndOpen, selected, abandoned, run, secondRun, rejectedCandidate, selectedCandidate, dropped };
};

for (const backend of ["sqlite", "mysql", "postgres"] as const) {
  const skipped = backend === "mysql" ? !mysqlEnabled : backend === "postgres" ? !postgresEnabled : false;
  const backendTest = (name: string, run: (f: LedgerFixture) => Promise<void>) => test(`${backend}: ${name}`, { skip: skipped }, async () => {
    const isolated = backend === "mysql" ? await isolatedMySQL() : backend === "postgres" ? await isolatedPostgres() : undefined;
    let f: LedgerFixture | undefined;
    try {
      f = isolated ? await LedgerFixture.createWithStore(isolated.store) : await LedgerFixture.create();
      await run(f);
    } finally {
      try { if (f) await f.close(); else await isolated?.store.close(); }
      finally { await isolated?.cleanup(); }
    }
  });

  backendTest("issue list carries ownership and a board that equals issue show", async f => {
    const s = await seed(f);
    const list = await f.module.listIssues();
    assertContract("command-results.schema.json", list);
    assert.equal(list.resources.length, 5);
    for (const item of list.resources) {
      const shown = await f.module.showIssue(item.resource_id);
      assert.equal(item.version, shown.issue.version);
      assert.deepEqual(item.requirement, { id: shown.requirement.id, version: shown.requirement.version });
      assert.deepEqual(item.repository, shown.repository);
      assert.equal(item.board?.status, shown.board.status);
      assert.equal(item.board?.next_action, shown.board.next_action);
      assert.equal(item.board?.open_dev_run_count, shown.board.open_dev_run_count);
      assert.equal(item.board?.candidate_count, shown.board.candidate_count);
      assert.equal(item.board?.selection.state, shown.board.selection.state);
      assert.equal(item.board?.selection.version, shown.board.selection.version);
      assert.equal(item.board?.selection.candidate_id, shown.board.selection.candidate_id);
    }
    const byId = new Map(list.resources.map(item => [item.resource_id, item]));
    assert.equal(byId.get(s.ready.issue_id)?.board?.status, "ready");
    assert.equal(byId.get(s.exploring.issue_id)?.board?.status, "exploring");
    assert.equal(byId.get(s.abandoned.issue_id)?.board?.status, "ready", "an abandoned DevRun is not open work");
    assert.equal(byId.get(s.selected.issue_id)?.board?.status, "candidate_selected");
    // A rejected Candidate does not hide the open DevRun that exists beside it.
    const both = byId.get(s.rejectedAndOpen.issue_id)!;
    assert.equal(both.board?.status, "candidates_available"); assert.equal(both.board?.open_dev_run_count, 1); assert.equal(both.board?.candidate_count, 1);
    assert.deepEqual(list.query, { sort: "id" });
  });

  backendTest("issue list filters compose exactly and empty results stay explicit", async f => {
    const s = await seed(f);
    const ids = async (...args: Parameters<typeof f.module.listIssues>) => (await f.module.listIssues(...args)).resources.map(item => item.resource_id).sort();
    assert.deepEqual(await ids("", { status: "ready" }), [s.ready.issue_id, s.abandoned.issue_id].sort());
    assert.deepEqual(await ids("", { status: "ready", repository_id: s.r2.repository_id }), [s.abandoned.issue_id]);
    assert.deepEqual(await ids("", { repository_id: s.r1.repository_id }), [s.ready.issue_id, s.rejectedAndOpen.issue_id, s.selected.issue_id].sort());
    assert.deepEqual(await ids(f.requirement.requirement_id, { repository_id: s.r1.repository_id }), [s.ready.issue_id, s.rejectedAndOpen.issue_id].sort());
    assert.deepEqual(await ids("", { has_open_dev_run: true }), [s.exploring.issue_id, s.rejectedAndOpen.issue_id].sort());
    assert.deepEqual(await ids("", { has_open_dev_run: true, status: "candidates_available" }), [s.rejectedAndOpen.issue_id]);
    assert.deepEqual(await ids("", { has_open_dev_run: false, repository_id: s.r1.repository_id }), [s.ready.issue_id, s.selected.issue_id].sort());
    assert.deepEqual(await ids("", { status: "candidate_selected" }), [s.selected.issue_id]);
    const empty = await f.module.listIssues(s.req2.requirement_id, { status: "exploring" });
    assert.deepEqual(empty.resources, []); assert.deepEqual(empty.query, { sort: "id", requirement_id: s.req2.requirement_id, status: "exploring" });
    assertContract("command-results.schema.json", empty);
    await assert.rejects(f.module.listIssues("", { status: "done" }), validation("status"));
    await assert.rejects(f.module.listIssues("", { sort: "newest" }), validation("sort"));
    await assert.rejects(f.module.listIssues("", { repository_id: "not-an-id" }), validation("repository_id"));
    await assert.rejects(f.module.listIssues("", { repository_id: newUUIDv7() }), (error: unknown) => error instanceof DomainError && error.code === "NOT_FOUND");
  });

  backendTest("issue activity covers DevRun lifecycle and orders by latest activity with an ID tie-break", async f => {
    const s = await seed(f);
    const list = await f.module.listIssues("", { sort: "activity" });
    assert.deepEqual(list.query, { sort: "activity" });
    const kinds = new Map(list.resources.map(item => [item.resource_id, item.last_activity?.kind]));
    assert.equal(kinds.get(s.exploring.issue_id), "devrun_started");
    assert.equal(kinds.get(s.abandoned.issue_id), "devrun_abandoned");
    assert.equal(kinds.get(s.selected.issue_id), "selection");
    assert.equal(kinds.get(s.rejectedAndOpen.issue_id), "devrun_started");
    assert.equal(kinds.get(s.ready.issue_id), "published");
    // Compare instants, not text: canonical timestamps drop trailing zeros.
    const times = list.resources.map(item => Date.parse(item.last_activity!.occurred_at));
    assert.deepEqual([...times].sort((a, b) => b - a), times);
    for (let i = 1; i < list.resources.length; i += 1) if (times[i] === times[i - 1]) assert.ok(list.resources[i - 1].resource_id < list.resources[i].resource_id);
    assert.equal(list.resources[0].resource_id, s.abandoned.issue_id, "the most recent ledger change is the abandonment");
    // Reading never writes: identical repeated queries.
    assert.deepEqual(await f.module.listIssues("", { sort: "activity" }), list);
  });

  backendTest("issue list follows Selection changes without touching Candidate facts", async f => {
    const s = await seed(f);
    const status = async () => (await f.module.listIssues("", { repository_id: s.r1.repository_id })).resources.find(item => item.resource_id === s.selected.issue_id)!;
    assert.equal((await status()).board?.status, "candidate_selected");
    assert.equal((await status()).board?.selection.version, 1);
    await f.module.clearSelection({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: s.selected.issue_id, issue_version: 1, expected_version: 1, reason: "reconsidered" } as never);
    const cleared = await status();
    assert.equal(cleared.board?.status, "candidates_available"); assert.equal(cleared.board?.next_action, "review_candidates");
    assert.deepEqual(cleared.board?.selection, { state: "unselected", version: 2 });
    assert.equal((await f.module.listIssues("", { status: "candidate_selected" })).resources.length, 0);
    assert.equal((await f.module.listCandidates(s.selected.issue_revision_id)).resources[0].is_selected, false);
    assert.equal((await f.module.listCandidates(s.selected.issue_revision_id)).resources[0].state, "qualified");
  });

  backendTest("filters and orderings compose with cursor paging: pages equal the unpaged filtered list and the cursor binds every filter", async f => {
    const s = await seed(f); const m = f.module;
    const collect = async (list: (page: { limit: number; cursor?: string }) => Promise<import("../src/module.js").ResourceListResult>, limit: number) => {
      const ids: string[] = []; let cursor: string | undefined; let pages = 0;
      do { const page = await list({ limit, ...(cursor ? { cursor } : {}) }); assertContract("command-results.schema.json", page); ids.push(...page.resources.map(item => item.resource_id)); cursor = page.next_cursor; pages += 1; } while (cursor && pages < 50);
      return ids;
    };
    for (const options of [{ status: "ready" }, { repository_id: s.r1.repository_id }, { has_open_dev_run: true }, { repository_id: s.r1.repository_id, has_open_dev_run: false }, { sort: "activity" }, { status: "ready", sort: "activity" }, { status: "candidates_available", has_open_dev_run: true, sort: "activity" }]) {
      const whole = (await m.listIssues("", options)).resources.map(item => item.resource_id);
      for (const limit of [1, 2, 10]) assert.deepEqual(await collect(page => m.listIssues("", options, page), limit), whole, JSON.stringify(options) + " limit " + limit);
    }
    const first = await m.listIssues("", { status: "ready" }, { limit: 1 });
    assert.deepEqual(first.query, { sort: "id", status: "ready" }); assert.equal(first.page?.sort, "id:asc");
    assert.equal((await m.listIssues("", { sort: "activity" }, { limit: 1 })).page?.sort, "activity:desc,id:asc");
    const cursor = first.next_cursor!;
    const bad = (error: unknown) => { assert.ok(error instanceof DomainError); assert.equal(error.code, "VALIDATION_ERROR"); assert.equal((error.details as { field?: string }).field, "cursor"); return true; };
    await assert.rejects(m.listIssues("", { status: "exploring" }, { cursor }), bad);
    await assert.rejects(m.listIssues("", { status: "ready", repository_id: s.r1.repository_id }, { cursor }), bad);
    await assert.rejects(m.listIssues("", { status: "ready", sort: "activity" }, { cursor }), bad);
    assert.equal((await m.listIssues("", { status: "ready" }, { cursor })).resources.length, 1);
    // DevRun / Candidate / Verification filters page too.
    assert.deepEqual(await collect(page => m.listDevRuns("", { state: "open" }, page), 1), (await m.listDevRuns("", { state: "open" })).resources.map(item => item.resource_id));
    assert.deepEqual(await collect(page => m.listDevRuns("", { state: "submitted", repository_id: s.r1.repository_id }, page), 1), (await m.listDevRuns("", { state: "submitted", repository_id: s.r1.repository_id })).resources.map(item => item.resource_id));
    for (const options of [{ standing: "qualified" }, { standing: "rejected" }, { selected: true }, { selected: false }, { repository_id: s.r1.repository_id }]) assert.deepEqual(await collect(page => m.listCandidates("", options, page), 1), (await m.listCandidates("", options)).resources.map(item => item.resource_id), JSON.stringify(options));
    assert.deepEqual(await collect(page => m.listCandidatesForIssue(s.selected.issue_id, 1, { selected: true }, page), 1), [s.selectedCandidate.candidate.candidate_id]);
    for (const verdict of ["qualified", "rejected"]) assert.deepEqual(await collect(page => m.listVerifications("", { verdict }, page), 1), (await m.listVerifications("", { verdict })).resources.map(item => item.resource_id));
    const candCursor = (await m.listCandidates("", { repository_id: s.r1.repository_id }, { limit: 1 })).next_cursor!;
    await assert.rejects(m.listCandidates("", { selected: true }, { cursor: candCursor }), bad);
    await assert.rejects(m.listDevRuns("", { state: "open" }, { cursor: (await m.listDevRuns("", { state: "abandoned" }, { limit: 1 })).next_cursor ?? "x" }), bad);
  });

  backendTest("requirement list progress equals the requirement detail aggregates", async f => {
    const s = await seed(f);
    const list = await f.module.listRequirements();
    assertContract("command-results.schema.json", list);
    const one = list.resources.find(item => item.resource_id === f.requirement.requirement_id)!;
    const two = list.resources.find(item => item.resource_id === s.req2.requirement_id)!;
    assert.deepEqual(one.progress, { completion_status: "incomplete", completed_issue_count: 0, bound_to_selected_version_issue_count: 3, issue_count: 3, ready_issue_count: 1, open_dev_run_count: 2, candidate_count: 1 });
    assert.deepEqual(two.progress, { completion_status: "incomplete", completed_issue_count: 0, bound_to_selected_version_issue_count: 2, issue_count: 2, ready_issue_count: 1, open_dev_run_count: 0, candidate_count: 1 });
    for (const item of list.resources) {
      const detail = await f.module.showRequirement(item.resource_id);
      assert.equal(item.progress?.issue_count, detail.aggregates.issue_count);
      assert.equal(item.progress?.open_dev_run_count, detail.aggregates.open_dev_run_count);
      assert.equal(item.progress?.candidate_count, detail.aggregates.candidate_count);
      assert.equal(item.progress?.ready_issue_count, detail.issues.filter(entry => entry.board.status === "ready").length);
    }
    const empty = await addRequirement(f, "No issues yet");
    const zero = (await f.module.listRequirements()).resources.find(item => item.resource_id === empty.requirement_id)!;
    assert.deepEqual(zero.progress, { completion_status: "no_issues", completed_issue_count: 0, bound_to_selected_version_issue_count: 0, issue_count: 0, ready_issue_count: 0, open_dev_run_count: 0, candidate_count: 0 });
  });

  backendTest("devrun list exposes ownership and filters by Issue, version, Repository and state", async f => {
    const s = await seed(f);
    const all = await f.module.listDevRuns();
    assertContract("command-results.schema.json", all);
    assert.equal(all.resources.length, 5);
    const runId = s.run.result.context.dev_run.id;
    const item = all.resources.find(entry => entry.resource_id === runId)!;
    assert.deepEqual(item.issue, { id: s.exploring.issue_id, version: 1 });
    assert.deepEqual(item.repository, { id: s.r2.repository_id, canonical_remote: s.r2.canonical_remote });
    assert.equal(item.state, "open");
    const ids = async (issue: string, options: Parameters<typeof f.module.listDevRuns>[1]) => (await f.module.listDevRuns(issue, options)).resources.map(entry => entry.resource_id).sort();
    assert.deepEqual(await ids("", { state: "open" }), [runId, s.secondRun.result.context.dev_run.id].sort());
    assert.deepEqual(await ids("", { state: "abandoned" }), [s.dropped.result.context.dev_run.id]);
    assert.equal((await ids("", { state: "submitted" })).length, 2);
    assert.deepEqual(await ids("", { repository_id: s.r2.repository_id, state: "open" }), [runId]);
    assert.deepEqual(await ids(s.exploring.issue_id, {}), [runId]);
    assert.deepEqual(await ids(s.exploring.issue_id, { issue_version: 1 }), [runId]);
    assert.deepEqual(await ids(s.exploring.issue_id, { issue_version: 2 }), []);
    await assert.rejects(f.module.listDevRuns("", { issue_version: 1 }), validation("issue_version"));
    await assert.rejects(f.module.listDevRuns("", { state: "paused" }), validation("state"));
  });

  backendTest("issue filter on DevRuns includes historical Issue Versions", async f => {
    const s = await seed(f);
    const detail = await f.module.showIssue(s.exploring.issue_id);
    const revised = await f.module.reviseIssue({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: s.exploring.issue_id, expected_predecessor_id: s.exploring.issue_revision_id, requirement_revision_id: s.exploring.requirement_revision_id, requirement_revision_explicit: true, baseline: testBaseline,
      input: { format: 1, summary: "Exploring issue v2", goals: [{ statement: "Change behavior", criteria: ["The behavior changes"], traces_to: [{ type: "outcome", ordinal: 1 }] }] } });
    assert.equal(detail.issue.version, 1); assert.equal(revised.result.revision_number, 2);
    const all = await f.module.listDevRuns(s.exploring.issue_id);
    assert.deepEqual(all.resources.map(entry => entry.issue), [{ id: s.exploring.issue_id, version: 1 }]);
    assert.equal((await f.module.listDevRuns(s.exploring.issue_id, { issue_version: 2 })).resources.length, 0);
    // The current Issue Version has no open DevRun any more, but the historical one is still visible.
    const board = (await f.module.listIssues("", { has_open_dev_run: true })).resources.map(item => item.resource_id);
    assert.ok(!board.includes(s.exploring.issue_id));
  });

  backendTest("candidate list exposes ownership and filters by Repository, standing and selection", async f => {
    const s = await seed(f);
    const all = await f.module.listCandidates();
    assertContract("command-results.schema.json", all);
    assert.equal(all.resources.length, 2);
    const rejected = all.resources.find(entry => entry.resource_id === s.rejectedCandidate.candidate.candidate_id)!;
    const chosen = all.resources.find(entry => entry.resource_id === s.selectedCandidate.candidate.candidate_id)!;
    assert.deepEqual(rejected.issue, { id: s.rejectedAndOpen.issue_id, version: 1 });
    assert.deepEqual(chosen.repository, { id: s.r1.repository_id, canonical_remote: s.r1.canonical_remote });
    assert.equal(rejected.state, "rejected"); assert.equal(rejected.is_selected, false);
    assert.equal(chosen.state, "qualified"); assert.equal(chosen.is_selected, true);
    const ids = async (options: Parameters<typeof f.module.listCandidates>[1]) => (await f.module.listCandidates("", options)).resources.map(entry => entry.resource_id);
    assert.deepEqual(await ids({ standing: "rejected" }), [rejected.resource_id]);
    assert.deepEqual(await ids({ standing: "qualified" }), [chosen.resource_id]);
    assert.deepEqual(await ids({ standing: "unverified" }), []);
    assert.deepEqual(await ids({ selected: true }), [chosen.resource_id]);
    assert.deepEqual(await ids({ selected: false }), [rejected.resource_id]);
    assert.deepEqual(await ids({ repository_id: s.r1.repository_id }).then(list => list.length), 2);
    assert.deepEqual(await ids({ repository_id: s.r2.repository_id }), []);
    // Another qualified Candidate elsewhere never rewrites the rejected Candidate's standing.
    assert.equal((await f.module.listCandidates(s.rejectedAndOpen.issue_revision_id)).resources[0].state, "rejected");
    const issueScoped = await f.module.listCandidatesForIssue(s.selected.issue_id, 1, { selected: true });
    assert.deepEqual(issueScoped.query, { issue_id: s.selected.issue_id, issue_version: 1, selected: true });
    await assert.rejects(f.module.listCandidates("", { standing: "great" }), validation("standing"));
  });

  backendTest("verification list names its Candidate and Issue and filters by verdict without touching paging", async f => {
    const s = await seed(f);
    const all = await f.module.listVerifications();
    assertContract("command-results.schema.json", all);
    assert.equal(all.resources.length, 2);
    const item = all.resources.find(entry => entry.overall_verdict === "rejected")!;
    assert.equal(item.candidate_id, s.rejectedCandidate.candidate.candidate_id);
    assert.deepEqual(item.issue, { id: s.rejectedAndOpen.issue_id, version: 1 });
    assert.equal(item.state, "rejected"); assert.ok(item.created_at);
    assert.deepEqual((await f.module.listVerifications("", { verdict: "qualified" })).resources.map(entry => entry.candidate_id), [s.selectedCandidate.candidate.candidate_id]);
    assert.deepEqual((await f.module.listVerifications(s.rejectedCandidate.candidate.candidate_id, { verdict: "qualified" })).resources, []);
    assert.equal((await f.module.listVerifications(s.rejectedCandidate.candidate.candidate_id)).resources.length, 1);
    const page = await f.module.verificationPage(s.rejectedCandidate.candidate.candidate_id);
    assertContract("query-results.schema.json", page); assert.equal(page.verifications.length, 1);
    await assert.rejects(f.module.listVerifications("", { verdict: "maybe" }), validation("verdict"));
  });
}

test("sqlite: activity ordering compares instants although canonical timestamps trim fraction zeros", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-list-time-"));
  const path = join(directory, "ledger.db");
  const f = await LedgerFixture.createWithStore(SQLStore.sqlite(path), async () => { rmSync(directory, { recursive: true, force: true }); });
  try {
    const other = await addIssue(f, f.requirement, f.repository, "Second issue");
    const raw = new DatabaseSync(path);
    // Text order would put ".5Z" after ".51Z"; the instants are 500 ms and 510 ms.
    raw.prepare("UPDATE issue_revisions SET created_at = ? WHERE id = ?").run("2030-01-01T00:00:00.5Z", f.issue.issue_revision_id);
    raw.prepare("UPDATE issue_revisions SET created_at = ? WHERE id = ?").run("2030-01-01T00:00:00.51Z", other.issue_revision_id);
    raw.close();
    const list = await f.module.listIssues("", { sort: "activity" });
    assert.deepEqual(list.resources.map(item => item.resource_id), [other.issue_id, f.issue.issue_id]);
    assert.equal(list.resources[0].last_activity?.occurred_at, "2030-01-01T00:00:00.51Z");
    // Identical instants fall back to ascending Issue ID.
    const tied = new DatabaseSync(path);
    tied.prepare("UPDATE issue_revisions SET created_at = ? WHERE id IN (?, ?)").run("2030-01-01T00:00:00.5Z", f.issue.issue_revision_id, other.issue_revision_id);
    tied.close();
    assert.deepEqual((await f.module.listIssues("", { sort: "activity" })).resources.map(item => item.resource_id), [f.issue.issue_id, other.issue_id].sort());
  } finally { await f.close(); }
});

test("sqlite: CLI list options bind to filters, echo the query and reject invalid values", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-list-cli-"));
  const config = join(directory, "config.yaml"); const path = join(directory, "ledger.db");
  await execute(["init", "--driver", "sqlite", "--non-interactive", "--config", config, "--path", path]);
  const f = await LedgerFixture.createWithStore(SQLStore.sqlite(path));
  try {
    const s = await seed(f);
    const call = async (...args: string[]) => {
      const out: string[] = []; const status = await runCLI([...args, "--config", config, "--json"], { stdout: line => out.push(line), stderr: () => undefined });
      return { status, envelope: JSON.parse(out[0]) as { ok: boolean; data?: { resources: { resource_id: string; board?: { status: string } }[]; query?: Record<string, unknown> }; error?: { details?: { field?: string } } } };
    };
    const ready = await call("issue", "list", "--repository", s.r2.repository_id, "--status", "ready");
    assert.equal(ready.status, 0);
    assert.deepEqual(ready.envelope.data?.resources.map(item => item.resource_id), [s.abandoned.issue_id]);
    assert.deepEqual(ready.envelope.data?.query, { sort: "id", repository_id: s.r2.repository_id, status: "ready" });
    assertContract("cli-envelope.schema.json", ready.envelope);
    // Boolean filters take an explicit true/false; false is the complement.
    const open = await call("issue", "list", "--has-open-devrun", "true");
    assert.deepEqual(open.envelope.data?.resources.map(item => item.resource_id).sort(), [s.exploring.issue_id, s.rejectedAndOpen.issue_id].sort());
    const none = await call("issue", "list", "--has-open-devrun", "false", "--sort", "activity");
    assert.equal(none.envelope.data?.resources.length, 3); assert.equal(none.envelope.data?.query?.has_open_dev_run, false);
    const runs = await call("devrun", "list", "--issue", s.exploring.issue_id, "--issue-version", "1", "--state", "open");
    assert.equal(runs.envelope.data?.resources.length, 1);
    const candidates = await call("candidate", "list", "--standing", "qualified", "--selected", "true");
    assert.equal(candidates.envelope.data?.resources.length, 1);
    const verifications = await call("verification", "list", "--verdict", "rejected");
    assert.equal(verifications.envelope.data?.resources.length, 1);
    for (const [args, field] of [
      [["issue", "list", "--status", "done"], "status"], [["issue", "list", "--has-open-devrun", "maybe"], "has-open-devrun"], [["issue", "list", "--has-open-devrun"], "has-open-devrun"],
      [["devrun", "list", "--issue-version", "1"], "issue_version"], [["candidate", "list", "--selected", "yes"], "selected"],
      [["verification", "list", "--paged", "--candidate", s.selectedCandidate.candidate.candidate_id, "--verdict", "qualified"], "verdict"],
      [["requirement", "list", "--status", "ready"], "--status"],
    ] as const) {
      const failed = await call(...args);
      assert.equal(failed.status, 2, args.join(" ")); assert.equal(failed.envelope.error?.details?.field, field);
    }
    const help = await runCLI(["issue", "list", "--help", "--json"], { stdout: line => { for (const option of ["--repository", "--status", "--has-open-devrun", "--sort"]) assert.ok(line.includes(option), option); }, stderr: () => undefined });
    assert.equal(help, 0);
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
});
