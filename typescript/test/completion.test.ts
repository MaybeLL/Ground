import { reviseTargetIssueSeeded, ledgerOnlyPreflightCoordinator } from "./preflight-fixture.js";
import { Module } from "../src/module.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backends, backendSkip, openLedger } from './backends.js';
import { LedgerFixture, testAgent, testBaseline } from './fixture.js';
import { newUUIDv7 } from '../src/identity.js';
import { type CompletionInput, validateCompletionInput } from '../src/completion.js';
import { SQLStore, SCHEMA_VERSION } from '../src/sql-store.js';
import { execute, runCLI, commandNeedsOperationID, parseArgs } from '../src/cli.js';
import { assertContract } from './schema-fixture.js';
import { indexCandidateChanges } from '../src/change-index.js';

const facts = (f: LedgerFixture): CompletionInput => ({ format: 'grounds.issue-completion-input/v1', origin: 'historical', repository_id: f.repository.repository_id, target_branch: 'refs/heads/dev-v1', landed_commit: `sha1:${'a'.repeat(40)}`, adoption_evidence: { reference: 'https://example.test/merge/29', description: 'User confirms merge of capture directory' }, release: { status: 'released', version: '0.20.18', channel: 'latest', evidence: { reference: 'https://example.test/npm/0.20.18', description: 'User confirms release' } }, completed_at: '2026-01-01T00:00:00.000Z' });
const request = (f: LedgerFixture, version = 0) => ({ issue_id: f.issue.issue_id, issue_version: 1, expected_version: version, operation_id: newUUIDv7(), attribution: testAgent });
const issueInput = { format: 1, summary: 'Next scope', goals: [{ statement: 'new', criteria: ['works'], traces_to: [{ type: 'outcome' as const, ordinal: 1 }] }] };
const newIssue = (f: LedgerFixture) => f.module.createIssue({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: f.requirement.requirement_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, repository_id: f.repository.repository_id, baseline: testBaseline, input: issueInput });

for (const backend of backends) {
 const check = (name: string, run: (f: LedgerFixture) => Promise<void>) => test(`${backend}: completion ${name}`, { skip: backendSkip(backend) }, async () => { const f = await openLedger(backend); try { await run(f); } finally { await f.close(); } });
 check('historical lifecycle, replay, filters and audit without fabricated work', async f => {
  const input = { ...request(f), completion: facts(f) }, recorded = await f.module.recordCompletion(input);
  assertContract('completion.schema.json', recorded); assertContract('command-results.schema.json', recorded);
  assert.deepEqual(await f.module.recordCompletion(input), recorded);
  assert.equal(recorded.completion.record?.evidence_status, 'asserted_not_checked');
  const detail = await f.module.showIssue(f.issue.issue_id); assertContract('query-results.schema.json', detail);
  assert.equal(detail.board.status, 'completed'); assert.equal(detail.board.next_action, null);
  assert.equal(detail.board.candidate_count, 0); assert.equal(detail.board.open_dev_run_count, 0);
  assert.equal((await f.module.listDevRuns(f.issue.issue_id)).resources.length, 0);
  assert.equal((await f.module.listCandidates(f.issue.issue_revision_id)).resources.length, 0);
  for (const options of [{ status: 'completed' }, { status: 'completed', sort: 'activity' }]) {
    const result = await f.module.listIssues('', options, { limit: 1 }); assertContract('command-results.schema.json', result); assert.equal(result.resources.length, 1); assert.equal(result.resources[0].last_activity?.kind, 'completion');
  }
  for (const status of ['incomplete', 'ready', 'exploring', 'candidate_selected', 'candidates_available']) assert.equal((await f.module.listIssues('', { status })).resources.length, 0);
  const req = await f.module.showRequirement(f.requirement.requirement_id); assertContract('query-results.schema.json', req); assert.equal(req.aggregates.completion_status, 'completed');
  const list = await f.module.listRequirements(); assertContract('command-results.schema.json', list); assert.equal(list.resources[0].progress?.completion_status, 'completed'); assert.equal(list.resources[0].progress?.ready_issue_count, 0);
  await assert.rejects(f.module.recordCompletion({ ...input, operation_id: newUUIDv7() }), { code: 'VERSION_CONFLICT' });
  await assert.rejects(f.module.recordCompletion({ ...input, completion: { ...input.completion, origin: 'workflow' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  const reopen = { ...request(f, 1), reason: 'Wrong release; investigate' }, reopened = await f.module.reopenCompletion(reopen); assertContract('completion.schema.json', reopened);
  assert.deepEqual(await f.module.reopenCompletion(reopen), reopened); assert.deepEqual(await f.module.recordCompletion(input), recorded);
  assert.equal((await f.module.showIssue(f.issue.issue_id)).board.status, 'ready');
  assert.equal((await f.module.showRequirement(f.requirement.requirement_id)).aggregates.completion_status, 'incomplete');
  const history = await f.module.showCompletion(f.issue.issue_id, 1); assert.equal(history.history?.length, 2); assert.deepEqual(history.history?.[0], recorded.completion.record);
  const audit = await f.module.listLedger('', '', 'issue_completion', f.issue.issue_id);
  assertContract('query-results.schema.json', audit); assert.equal(audit.events.length, 2);
  assert.ok(audit.events.every(event => event.subject_id === f.issue.issue_id));
  await f.module.recordCompletion({ ...request(f, 2), completion: { ...facts(f), adoption_evidence: { reference: 'x'.repeat(4096), description: 'y'.repeat(4096) }, release: { status: 'not_applicable', reason: 'Documentation only' } } });
  const integrity = (await f.store.inspectIntegrity()).report; assert.equal(integrity.valid, true, JSON.stringify(integrity));
 });
 check('invalid facts and wrong scope leave no partial state', async f => {
  const good = facts(f);
  for (const key of Object.keys(good)) { const missing = { ...good } as Record<string, unknown>; delete missing[key]; assert.throws(() => validateCompletionInput(missing), { code: 'VALIDATION_ERROR' }); }
  for (const replacement of [{ release: { status: 'pending' } }, { release: { status: 'not_applicable', reason: '' } }, { target_branch: 'main' }, { target_branch: 'refs/heads/bad..ref' }, { landed_commit: '7bd04e9' }, { completed_at: '2026-02-30T00:00:00.000Z' }, { completed_at: '2999-01-01T00:00:00.000Z' }, { repository_id: newUUIDv7() }, { evidence_status: 'verified' }]) await assert.rejects(f.module.recordCompletion({ ...request(f), completion: { ...good, ...replacement } as CompletionInput }), { code: 'VALIDATION_ERROR' });
  const other = await newIssue(f), candidate = await f.submitCandidate('other', undefined, [], false, undefined, other.result);
  await assert.rejects(f.module.recordCompletion({ ...request(f), completion: { ...good, candidate_id: candidate.candidate.candidate_id } }), { code: 'VALIDATION_ERROR' });
  assert.equal((await f.module.showCompletion(f.issue.issue_id, 1)).history?.length, 0);
  assert.equal((await f.module.listLedger('', '', 'issue_completion', f.issue.issue_id)).events.length, 0);
  await assert.rejects(f.module.reopenCompletion({ ...request(f), reason: '' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(f.module.reopenCompletion({ ...request(f), reason: 'not completed' }), { code: 'STATE_CONFLICT' });
 });
 check('latest Issue versions, Requirement versions and mixed aggregate', async f => {
  await f.module.recordCompletion({ ...request(f), completion: facts(f) });
  const second = await newIssue(f);
  assert.equal((await f.module.showRequirement(f.requirement.requirement_id)).aggregates.completion_status, 'incomplete');
  await f.module.recordCompletion({ ...request(f), issue_id: second.result.issue_id, completion: facts(f) });
  assert.equal((await f.module.showRequirement(f.requirement.requirement_id)).aggregates.completion_status, 'completed');
  await reviseTargetIssueSeeded(new Module(f.store, newUUIDv7, undefined, undefined, ledgerOnlyPreflightCoordinator(f.store)), f.store, { operation_id: newUUIDv7(), attribution: testAgent, issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: testBaseline, input: { ...issueInput, target_branch: { remote: 'origin', ref: 'refs/heads/main' } } });
  assert.equal((await f.module.showIssue(f.issue.issue_id)).board.status, 'ready');
  assert.equal((await f.module.showIssueVersion(f.issue.issue_id, 1)).board.status, 'completed');
  assert.equal((await f.module.showRequirement(f.requirement.requirement_id)).aggregates.completion_status, 'incomplete');
  await assert.rejects(f.module.recordCompletion({ ...request(f), issue_version: 2, completion: facts(f) }), { code: 'VALIDATION_ERROR' });
  await f.module.reviseRequirement({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: f.requirement.requirement_id, expected_predecessor_id: f.requirement.requirement_revision_id, input: { format: 1, summary: 'New requirement scope', outcomes: ['new outcome'] } });
  assert.equal((await f.module.showRequirement(f.requirement.requirement_id)).aggregates.completion_status, 'no_issues');
  assert.equal((await f.module.listRequirements()).resources[0].progress?.completion_status, 'no_issues');
  assert.equal((await f.module.showRequirement(f.requirement.requirement_id, f.requirement.requirement_revision_id)).aggregates.completion_status, 'incomplete');
 });
 check('competing writes serialize', async f => {
  const results = await Promise.allSettled([1, 2].map(() => f.module.recordCompletion({ ...request(f), completion: facts(f) })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'VERSION_CONFLICT');
  const reopened = await Promise.allSettled([1, 2].map(() => f.module.reopenCompletion({ ...request(f, 1), reason: 'Correct facts' })));
  assert.equal(reopened.filter(r => r.status === 'fulfilled').length, 1); assert.equal((await f.module.showCompletion(f.issue.issue_id, 1)).history?.length, 2);
 });
 check('GraphKB 0.20.18 preserves Selection, Delivery Link and Verification', async f => {
  const patch = Buffer.from('diff --git a/rule.ts b/rule.ts\n--- a/rule.ts\n+++ b/rule.ts\n@@ -1 +1 @@\n-old();\n+newRule();\n');
  const c = await f.submitCandidate('rule', [{ path_bytes: Buffer.from('rule.ts').toString('base64'), display_path: 'rule.ts', change: 'modified', old_mode: '100644', new_mode: '100644' }], [], true, patch), id = c.candidate.candidate_id;
  await f.module.setSelection({ ...request(f), candidate_id: id, reason: 'Already shipped; verification missing' });
  const unit = indexCandidateChanges(c.artifact).change_units[0];
  const link = await f.module.recordDeliveryLink({ operation_id: newUUIDv7(), attribution: testAgent, expected_version: 0, proof: { candidate_id: id, repository_id: f.repository.repository_id, commit_oid: 'a'.repeat(40), parent_oid: 'b'.repeat(40), patch_digest: c.artifact.patch_digest, method: 'raw-double-sided/v1', content: 'exact_scope', units: [{ change_unit_id: unit.change_unit_id, path: 'rule.ts', candidate_start: 1, commit_start: 4, lines: 1 }] } });
  const before = await f.module.verificationContext(id, 'blind');
  const done = await f.module.recordCompletion({ ...request(f), completion: { ...facts(f), candidate_id: id } });
  assert.equal(done.current_verification?.standing, 'unverified'); assert.equal(done.warnings.length, 2);
  const detail = await f.module.showIssue(f.issue.issue_id); assert.equal(detail.board.next_action, null); assert.equal(detail.board.selection.candidate_id, id);
  assert.deepEqual((await f.module.showDeliveryLink(link.link.id)).link, link.link); assert.deepEqual(await f.module.verificationContext(id, 'blind'), before);
  for (const verdict of ['inconclusive', 'rejected'] as const) { await f.verify(c, verdict); assert.equal((await f.module.showCompletion(f.issue.issue_id, 1)).current_verification?.standing, verdict); }
  assert.equal((await f.module.showIssue(f.issue.issue_id)).board.selection.current_verification?.standing, 'rejected');
 });
}

test('schema 22 migration is explicit/additive; audit failure rolls back', async () => {
 const root = mkdtempSync(join(tmpdir(), 'grounds-completion-migrate-')), path = join(root, 'db'), store = SQLStore.sqlite(path);
 const f = await LedgerFixture.createWithStore(store);
 try {
  const c = await f.submitCandidate(), before = await f.module.verificationContext(c.candidate.candidate_id, 'blind');
  const db = new DatabaseSync(path); db.exec('DROP TABLE issue_completion_versions; UPDATE schema_metadata SET schema_version=22');
  await assert.rejects(store.open(), { code: 'SCHEMA_INCOMPATIBLE' }); assert.equal((await store.migrate()).schema_version, SCHEMA_VERSION);
  assert.deepEqual(await f.module.verificationContext(c.candidate.candidate_id, 'blind'), before);
  assert.equal((await f.module.showIssue(f.issue.issue_id)).board.status, 'candidates_available');
  db.exec("CREATE TRIGGER reject_completion_audit BEFORE INSERT ON ledger_events WHEN NEW.subject_type = 'issue_completion' BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END");
  await assert.rejects(f.module.recordCompletion({ ...request(f), completion: facts(f) })); assert.equal((await f.module.showCompletion(f.issue.issue_id, 1)).history?.length, 0);
  db.exec('DROP TRIGGER reject_completion_audit'); db.close(); assert.equal((await f.store.inspectIntegrity()).report.valid, true);
 } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test('public CLI help, identity, JSON and read-only show', async () => {
 const root = mkdtempSync(join(tmpdir(), 'grounds-completion-cli-')), config = join(root, 'config.yaml'), path = join(root, 'db'); let f: LedgerFixture | undefined;
 try {
  await execute(['init', '--driver', 'sqlite', '--path', path, '--config', config, '--non-interactive', '--json'], { cwd: root }); f = await LedgerFixture.createWithStore(SQLStore.sqlite(path));
  const file = join(root, 'completion.json'); writeFileSync(file, JSON.stringify(facts(f)));
  const invoke = async (args: string[]) => { const output: string[] = []; const code = await runCLI([...args, '--config', config, '--json'], { cwd: root, stdout: s => output.push(s), stderr: () => {} }); const response = JSON.parse(output[0]); assertContract('cli-envelope.schema.json', response); if (code === 0) assertContract('command-results.schema.json', response.data); return { code, response }; };
  const help = await execute(['completion', 'record', '--help', '--json'], { cwd: root }); assert.match(JSON.stringify(help), /asserted/);
  const base = ['--issue', f.issue.issue_id, '--issue-version', '1'];
  const args = ['completion', 'record', ...base, '--file', file, '--expected-version', '0', '--operation-id', newUUIDv7(), '--agent-id', 'completion-test', '--agent-name', 'Completion test'];
  assert.equal(commandNeedsOperationID(parseArgs(args)), true); const result = await invoke(args); assert.equal(result.code, 0, JSON.stringify(result)); assert.equal((await invoke(args)).code, 0);
  const shown = await invoke(['completion', 'show', ...base]); assert.equal(shown.code, 0); assert.equal(shown.response.operation_id, undefined);
  assert.equal((await invoke(['completion', 'reopen', ...base, '--expected-version', '1', '--reason', 'Correct entry', '--agent-id', 'completion-test', '--agent-name', 'Completion test'])).code, 0);
 } finally { await f?.close(); rmSync(root, { recursive: true, force: true }); }
});
