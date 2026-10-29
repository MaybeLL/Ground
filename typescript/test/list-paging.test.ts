import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execute, runCLI } from "../src/cli.js";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";
import type { Module, ResourceListResult } from "../src/module.js";
import { SQLStore } from "../src/sql-store.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";
import { assertContract } from "./schema-fixture.js";
import { isolatedMySQL } from "./isolated-mysql.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";

const mysqlEnabled = ["HOST", "DATABASE", "USERNAME", "PASSWORD"].every(key => process.env[`GROUNDS_TEST_MYSQL_${key}`]);


const failure = (code: string, field?: string) => (error: unknown) => {
  assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code);
  if (field) assert.equal((error.details as { field?: string }).field, field);
  assertContract("error.schema.json", error.toJSON()); return true;
};

type Lister = (page?: { limit?: number; cursor?: string }) => Promise<ResourceListResult>;
// Follow next_cursor to the end and return every page.
const readAll = async (list: Lister, limit: number): Promise<ResourceListResult[]> => {
  const pages: ResourceListResult[] = []; let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await list({ limit, ...(cursor ? { cursor } : {}) });
    assertContract("command-results.schema.json", page); pages.push(page);
    assert.equal(page.page?.limit, limit); assert.ok(page.resources.length <= limit);
    if (!page.page?.has_more) { assert.equal(page.next_cursor, undefined, "the final page has no next_cursor"); return pages; }
    assert.ok(page.next_cursor); cursor = page.next_cursor;
  }
  throw new Error("pagination did not terminate");
};
const ids = (pages: ResourceListResult[]) => pages.flatMap(page => page.resources.map(item => item.resource_id));

const seed = async (f: LedgerFixture) => {
  const repositories = [f.repository]; const requirements = [f.requirement]; const issues = [f.issue];
  for (let i = 0; i < 4; i += 1) {
    const repository = (await f.module.registerRepository({ operation_id: newUUIDv7(), attribution: testAgent, canonical_remote: `ssh://git@example.test/team/repo-${i}` })).result;
    const requirement = (await f.module.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent, input: { format: 1, summary: `Requirement ${i}`, outcomes: ["Observable"] } })).result;
    repositories.push(repository); requirements.push(requirement);
    issues.push((await f.module.createIssue({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: requirement.requirement_id, requirement_revision_id: requirement.requirement_revision_id, requirement_revision_explicit: true, repository_id: f.repository.repository_id, baseline: testBaseline, input: { format: 1, summary: `Issue ${i}`, goals: [{ statement: "Change behavior", criteria: ["The behavior changes"], traces_to: [{ type: "outcome", ordinal: 1 }] }] } })).result);
  }
  const candidates = []; const verifications = [];
  for (let i = 0; i < 5; i += 1) {
    const candidate = await f.submitCandidate(i % 2 ? "one" : "two", undefined, [], false, undefined, issues[i % issues.length]);
    candidates.push(candidate); verifications.push(await f.verify(candidate, i % 2 ? "rejected" : "qualified"));
  }
  return { repositories, requirements, issues, candidates, verifications };
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

  backendTest("every list pages to the end in the published order and equals the unpaged list", async f => {
    const s = await seed(f); const m = f.module;
    const lists: [string, Lister, () => Promise<ResourceListResult>, string, number][] = [
      ["repository", p => m.listRepositories(p), () => m.listRepositories(), "id:asc", s.repositories.length],
      ["requirement", p => m.listRequirements(p), () => m.listRequirements(), "id:asc", s.requirements.length],
      ["issue", p => m.listIssues("", {}, p), () => m.listIssues(), "id:asc", s.issues.length],
      ["devrun", p => m.listDevRuns("", {}, p), () => m.listDevRuns(), "id:asc", s.candidates.length],
      ["candidate", p => m.listCandidates("", {}, p), () => m.listCandidates(), "created_at:asc,id:asc", s.candidates.length],
      ["verification", p => m.listVerifications("", {}, p), () => m.listVerifications(), "created_at:asc,id:asc", s.verifications.length],
    ];
    for (const [name, paged, unpaged, sort, total] of lists) {
      const whole = await unpaged();
      assert.equal(whole.page, undefined, `${name}: an unpaged call is still the plain complete list`); assert.equal(whole.next_cursor, undefined);
      assert.equal(whole.resources.length, total, name);
      for (const limit of [1, 2, total, total + 3]) {
        const pages = await readAll(paged, limit);
        assert.deepEqual(ids(pages), whole.resources.map(item => item.resource_id), `${name} limit ${limit}`);
        assert.deepEqual(pages.flatMap(page => page.resources), whole.resources, `${name} items are identical`);
        assert.equal(pages[0].page?.sort, sort);
        assert.equal(pages.length, Math.ceil(total / limit) || 1);
        assert.equal(pages.filter(page => page.page?.has_more).length, pages.length - 1);
      }
    }
  });

  backendTest("version 1 time-based list cursors require restart and version 2 resumes every item", async f => {
    await seed(f);
    const lists: [string, Lister][] = [
      ["candidate", page => f.module.listCandidates("", {}, page)],
      ["verification", page => f.module.listVerifications("", {}, page)],
      ["activity", page => f.module.listIssues("", { sort: "activity" }, page)],
    ];
    for (const [name, list] of lists) {
      const first = await list({ limit: 1 });
      assert.ok(first.next_cursor, name);
      const binding = JSON.parse(Buffer.from(first.next_cursor, "base64url").toString("utf8"));
      assert.equal(binding.version, 2, name);
      const legacy = Buffer.from(JSON.stringify({ ...binding, version: 1 })).toString("base64url");
      await assert.rejects(list({ cursor: legacy }), error => {
        failure("VALIDATION_ERROR", "cursor")(error);
        assert.match(String((error as DomainError).details.reason), /restart from the first page/);
        return true;
      });
      const rest = await list({ cursor: first.next_cursor });
      assert.deepEqual(ids([first, rest]), (await list()).resources.map(item => item.resource_id), name);
      assert.equal(rest.next_cursor, undefined, name);
    }
  });

  backendTest("an empty collection is one explicit empty final page", async f => {
    const page = await f.module.listCandidates("", {}, { limit: 10 });
    assert.deepEqual(page.resources, []); assert.equal(page.page?.has_more, false); assert.equal(page.next_cursor, undefined);
    assertContract("command-results.schema.json", page);
    assert.deepEqual((await f.module.listDevRuns("", {}, { limit: 3 })).resources, []);
  });

  backendTest("filtered lists page within their filter and bind the cursor to it", async f => {
    const s = await seed(f); const m = f.module;
    const requirementId = s.requirements[0].requirement_id;
    const first = await m.listIssues(requirementId, {}, { limit: 1 });
    assert.deepEqual(first.resources.map(item => item.resource_id), [s.issues[0].issue_id]); assert.equal(first.page?.has_more, false);
    // Candidates scoped to an Issue Version, Verifications scoped to a Candidate, DevRuns scoped to an Issue.
    const issue = s.issues[0];
    const cands = await readAll(p => m.listCandidatesForIssue(issue.issue_id, 1, {}, p), 1);
    assert.deepEqual(ids(cands), (await m.listCandidatesForIssue(issue.issue_id, 1)).resources.map(item => item.resource_id));
    assert.deepEqual(ids(await readAll(p => m.listDevRuns(issue.issue_id, {}, p), 1)), (await m.listDevRuns(issue.issue_id)).resources.map(item => item.resource_id));
    const verificationOf = s.candidates[0].candidate.candidate_id;
    assert.deepEqual(ids(await readAll(p => m.listVerifications(verificationOf, {}, p), 1)), (await m.listVerifications(verificationOf)).resources.map(item => item.resource_id));

    const cursor = (await m.listIssues("", {}, { limit: 2 })).next_cursor!;
    await assert.rejects(m.listIssues(requirementId, {}, { cursor }), failure("VALIDATION_ERROR", "cursor"));        // other filter
    await assert.rejects(m.listRequirements({ cursor }), failure("VALIDATION_ERROR", "cursor"));                 // other list
    await assert.rejects(m.listDevRuns("", {}, { cursor }), failure("VALIDATION_ERROR", "cursor"));
    const candidateCursor = (await m.listCandidatesForIssue(s.issues[1].issue_id, undefined, {}, { limit: 1 })).next_cursor;
    assert.equal(candidateCursor, undefined);
    const withMore = (await m.listCandidates("", {}, { limit: 1 })).next_cursor!;
    await assert.rejects(m.listCandidatesForIssue(issue.issue_id, 1, {}, { cursor: withMore }), failure("VALIDATION_ERROR", "cursor"));
    await assert.rejects(m.listVerifications(verificationOf, {}, { cursor: (await m.listVerifications("", {}, { limit: 1 })).next_cursor! }), failure("VALIDATION_ERROR", "cursor"));
    for (const bad of ["", "!!!", "e30", Buffer.from(JSON.stringify({ version: 1 })).toString("base64url"), `${cursor.slice(0, -2)}AA`, "a".repeat(5000)]) await assert.rejects(m.listIssues("", {}, { cursor: bad }), failure("VALIDATION_ERROR", "cursor"));
    // A cursor is bound to the list, not to the page size.
    assert.equal((await m.listIssues("", {}, { cursor, limit: 3 })).resources.length, 3);
  });

  backendTest("page sizes are validated and the Candidate-bound Verification directory is untouched", async f => {
    const s = await seed(f);
    for (const limit of [0, -1, 1001, 1.5, Number.NaN]) await assert.rejects(f.module.listRepositories({ limit }), failure("VALIDATION_ERROR", "limit"));
    assert.equal((await f.module.listRepositories({ limit: 1000 })).resources.length, s.repositories.length);
    assert.equal((await f.module.listRepositories({ cursor: (await f.module.listRepositories({ limit: 1 })).next_cursor! })).page?.limit, 100);
    const candidateId = s.candidates[0].candidate.candidate_id;
    const directory = await f.module.verificationPage(candidateId);
    assertContract("query-results.schema.json", directory); assert.equal(directory.verifications.length, 1);
    assert.equal((await f.module.listLedger()).events.length > 0, true);
  });

  backendTest("a ledger write between pages is reported as LIST_CHANGED and a fresh read succeeds", async f => {
    const s = await seed(f);
    const first = await f.module.listRequirements({ limit: 2 });
    assert.ok(first.next_cursor);
    await f.module.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent, input: { format: 1, summary: "Arrived mid-read", outcomes: ["Observable"] } });
    await assert.rejects(f.module.listRequirements({ cursor: first.next_cursor }), (error: unknown) => { failure("LIST_CHANGED")(error); assert.equal((error as DomainError).retryable, true); return true; });
    const again = await readAll(p => f.module.listRequirements(p), 2);
    assert.equal(ids(again).length, s.requirements.length + 1);
    assert.equal(new Set(ids(again)).size, ids(again).length, "no repeated items");
  });

  backendTest("a page shrinks to the byte budget, resumes after its last entry, and a single oversized entry is an explicit error", async f => {
    await seed(f);
    const whole = (await f.module.listRepositories()).resources.map(item => item.resource_id);
    const size = (result: ResourceListResult) => Buffer.byteLength(JSON.stringify(result));
    f.module.pageByteLimit = 500;
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const page: ResourceListResult = await f.module.listRepositories({ limit: 1000, ...(cursor ? { cursor } : {}) });
      assert.ok(size(page) <= 500, `page ${pages} is ${size(page)} bytes`);
      assert.ok(page.resources.length >= 1 && page.resources.length < whole.length, "shrunk below the requested limit");
      seen.push(...page.resources.map(item => item.resource_id)); cursor = page.next_cursor; pages += 1;
    } while (cursor);
    assert.deepEqual(seen, whole); assert.ok(pages > 1);
    f.module.pageByteLimit = 50;
    await assert.rejects(f.module.listRepositories({ limit: 5 }), failure("ARTIFACT_TOO_LARGE"));
  });
}

test("sqlite: candidate and verification pages order by instant even when stored timestamps trim zeros", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-page-time-")); const path = join(directory, "ledger.db");
  const f = await LedgerFixture.createWithStore(SQLStore.sqlite(path), async () => { rmSync(directory, { recursive: true, force: true }); });
  try {
    const a = await f.submitCandidate("one"); const b = await f.submitCandidate("two");
    const va = await f.verify(a); const vb = await f.verify(b);
    const raw = new DatabaseSync(path);
    // ".5Z" (500 ms) is earlier than ".51Z" (510 ms) although it sorts after it as text.
    raw.prepare("UPDATE candidates SET created_at = ? WHERE id = ?").run("2030-01-01T00:00:00.5Z", b.candidate.candidate_id);
    raw.prepare("UPDATE candidates SET created_at = ? WHERE id = ?").run("2030-01-01T00:00:00.51Z", a.candidate.candidate_id);
    raw.prepare("UPDATE verifications SET created_at = ? WHERE id = ?").run("2030-01-01T00:00:00.5Z", vb.verification_id);
    raw.prepare("UPDATE verifications SET created_at = ? WHERE id = ?").run("2030-01-01T00:00:00.51Z", va.verification_id);
    raw.close();
    const expectedCandidates = [b.candidate.candidate_id, a.candidate.candidate_id]; const expectedVerifications = [vb.verification_id, va.verification_id];
    assert.deepEqual((await f.module.listCandidates()).resources.map(item => item.resource_id), expectedCandidates);
    assert.deepEqual(ids(await readAll(p => f.module.listCandidates("", {}, p), 1)), expectedCandidates);
    assert.deepEqual((await f.module.listVerifications()).resources.map(item => item.resource_id), expectedVerifications);
    assert.deepEqual(ids(await readAll(p => f.module.listVerifications("", {}, p), 1)), expectedVerifications);
    // Equal instants fall back to ascending ID.
    const tied = new DatabaseSync(path);
    tied.prepare("UPDATE candidates SET created_at = ?").run("2030-01-01T00:00:00.5Z"); tied.close();
    assert.deepEqual(ids(await readAll(p => f.module.listCandidates("", {}, p), 1)), [...expectedCandidates].sort());
  } finally { await f.close(); }
});

test("sqlite: more than 10,000 rows and more than 8 MiB are readable page by page while the unpaged call names the paged form", { timeout: 120000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-page-scale-")); const path = join(directory, "ledger.db");
  const f = await LedgerFixture.createWithStore(SQLStore.sqlite(path), async () => { rmSync(directory, { recursive: true, force: true }); });
  try {
    const raw = new DatabaseSync(path);
    const insertRepository = raw.prepare("INSERT INTO repositories (id, canonical_remote, version, created_at, attribution_json) VALUES (?, ?, 1, ?, ?)");
    const insertRemote = raw.prepare("INSERT INTO repository_remotes (repository_id, remote, state) VALUES (?, ?, 'active')");
    const attribution = JSON.stringify(testAgent); const pad = "x".repeat(900);
    const inserted: string[] = [];
    raw.exec("BEGIN");
    for (let i = 0; i < 10050; i += 1) {
      const id = newUUIDv7(); const remote = `ssh://git@example.test/scale/${pad}/repo-${i}`;
      insertRepository.run(id, remote, "2030-01-01T00:00:00Z", attribution); insertRemote.run(id, remote); inserted.push(id);
    }
    raw.exec("COMMIT"); raw.close();
    // Beyond the published 10,000-item bound the complete list fails, but says how to continue.
    await assert.rejects(f.module.listRepositories(), (error: unknown) => {
      failure("ARTIFACT_TOO_LARGE")(error); const reason = (error as DomainError).details.reason as string;
      assert.match(reason, /--limit/); assert.match(reason, /next_cursor/); return true;
    });
    const started = Date.now();
    const pages = await readAll(p => f.module.listRepositories(p), 1000);
    const all = ids(pages);
    assert.equal(all.length, 10051, "the fixture's own Repository plus 10,050 inserted rows");
    assert.equal(new Set(all).size, all.length, "no repeated item");
    assert.deepEqual(all, [...all].sort(), "ascending ID order across every page");
    const present = new Set(all); for (const id of inserted) assert.ok(present.has(id), "every inserted row is returned");
    assert.ok(pages.length >= 11);
    const total = pages.reduce((bytes, page) => bytes + Buffer.byteLength(JSON.stringify(page)), 0);
    assert.ok(total > 8 * 1024 * 1024, `all pages together are ${total} bytes`);
    for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8 * 1024 * 1024);
    assert.ok(Date.now() - started < 90000);
  } finally { await f.close(); }
});

test("sqlite: CLI exposes --limit/--cursor on every list, binds the cursor and rejects misuse", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-page-cli-"));
  const config = join(directory, "config.yaml"); const path = join(directory, "ledger.db");
  await execute(["init", "--driver", "sqlite", "--non-interactive", "--config", config, "--path", path]);
  const f = await LedgerFixture.createWithStore(SQLStore.sqlite(path));
  try {
    const s = await seed(f);
    const call = async (...args: string[]) => {
      const out: string[] = []; const status = await runCLI([...args, "--config", config, "--json"], { stdout: line => out.push(line), stderr: () => undefined });
      return { status, envelope: JSON.parse(out[0]) as { ok: boolean; data?: ResourceListResult; error?: { code: string; retryable: boolean; details?: { field?: string; reason?: string } } } };
    };
    for (const [group, total] of [["repository", s.repositories.length], ["requirement", s.requirements.length], ["issue", s.issues.length], ["devrun", s.candidates.length], ["candidate", s.candidates.length], ["verification", s.verifications.length]] as const) {
      const collected: string[] = []; let cursor: string | undefined;
      do {
        const result = await call(group, "list", "--limit", "2", ...(cursor ? ["--cursor", cursor] : []));
        assert.equal(result.status, 0, group); assertContract("cli-envelope.schema.json", result.envelope);
        collected.push(...result.envelope.data!.resources.map(item => item.resource_id)); cursor = result.envelope.data!.next_cursor;
      } while (cursor);
      assert.equal(collected.length, total, group);
      const plain = await call(group, "list"); assert.equal(plain.envelope.data?.page, undefined); assert.equal(plain.envelope.data?.resources.length, total);
    }
    // --cursor alone continues with the default page size.
    const first = await call("issue", "list", "--limit", "1");
    const next = await call("issue", "list", "--cursor", first.envelope.data!.next_cursor!);
    assert.equal(next.status, 0); assert.equal(next.envelope.data?.page?.limit, 100);
    const wrongFilter = await call("issue", "list", "--requirement", s.requirements[0].requirement_id, "--cursor", first.envelope.data!.next_cursor!);
    assert.equal(wrongFilter.status, 2); assert.equal(wrongFilter.envelope.error?.details?.field, "cursor");
    assert.equal((await call("issue", "list", "--limit", "0")).envelope.error?.details?.field, "limit");
    assert.equal((await call("issue", "list", "--limit", "1001")).envelope.error?.details?.field, "limit");
    // Existing cursors keep their own commands: the Candidate directory and the ledger.
    assert.equal((await call("verification", "list", "--candidate", s.candidates[0].candidate.candidate_id, "--paged", "--limit", "5")).envelope.error?.details?.field, "limit");
    assert.equal((await call("verification", "list", "--candidate", s.candidates[0].candidate.candidate_id, "--paged")).status, 0);
    assert.equal((await call("repository", "show", s.repositories[0].repository_id, "--cursor", "x")).envelope.error?.details?.field, "--cursor");
    assert.equal((await call("ledger", "list", "--limit", "2")).status, 0);
    // Changing the ledger between pages is a retryable, distinguishable failure with exit code 4.
    const page = await call("requirement", "list", "--limit", "1");
    await f.module.createRequirement({ operation_id: newUUIDv7(), attribution: testAgent, input: { format: 1, summary: "Late", outcomes: ["Observable"] } });
    const stale = await call("requirement", "list", "--cursor", page.envelope.data!.next_cursor!);
    assert.equal(stale.status, 4); assert.equal(stale.envelope.error?.code, "LIST_CHANGED"); assert.equal(stale.envelope.error?.retryable, true);
    const help = await runCLI(["issue", "list", "--help", "--json"], { stdout: line => { assert.ok(line.includes("--limit")); assert.ok(line.includes("--cursor")); }, stderr: () => undefined });
    assert.equal(help, 0);
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
});
