import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '../../src/client.js';
import { executionFixture, actor } from '../../../typescript/test/code-route-execution-fixture.js';
import { archiveCLITransport } from '../../../typescript/test/archive-cli-fixture.js';
import { CodeRouteGit } from '../../../typescript/src/code-route-git.js';
import { git } from '../../../typescript/src/env-git.js';
import { isolatedMySQL } from '../../../typescript/test/isolated-mysql.js';

// Protocol compatibility, not an independent Agent's assessment. All verdicts
// below belong only to a disposable synthetic Candidate and test ledger.
const mysqlEnabled = ['HOST', 'DATABASE', 'USERNAME', 'PASSWORD'].every(key => process.env[`GROUNDS_TEST_MYSQL_${key}`]);
for (const driver of ['sqlite', 'mysql']) test(`${driver}: Workspace Candidate survives cache removal, blind handoff and real TUI review`, {
  timeout: 300000, skip: driver === 'mysql' && !mysqlEnabled,
}, async t => {
  const network = driver === 'mysql' ? await isolatedMySQL() : undefined;
  let x: Awaited<ReturnType<typeof executionFixture>>;
  try { x = await executionFixture(t, undefined, false, false, undefined, network?.store); }
  catch (error) { await network?.store.close(); await network?.cleanup(); throw error; }
  if (network) {
    t.after(() => network.cleanup());
    const previous = process.env.GROUNDS_MYSQL_PASSWORD;
    process.env.GROUNDS_MYSQL_PASSWORD = process.env.GROUNDS_TEST_MYSQL_PASSWORD;
    t.after(() => { if (previous === undefined) delete process.env.GROUNDS_MYSQL_PASSWORD; else process.env.GROUNDS_MYSQL_PASSWORD = previous; });
  }
  const cli = process.env.GROUNDS_RELEASE_CLI ?? resolve('../typescript/dist/src/bin.js');
  const config = join(x.root, 'config.json');
  writeFileSync(config, JSON.stringify({ version: 2, database: { ...(network?.configuration ?? { driver: 'sqlite', path: x.ledgerPath }),
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const invoke = (cwd: string, ...args: string[]) => {
    try {
      const offline = args[0] === 'verification' && ['independent-digest', 'handoff'].includes(args[1]);
      const text = execFileSync(cli, [...args, ...(offline ? [] : ['--config', config]), '--json'],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      return JSON.parse(text).data;
    } catch (error: any) {
      error.message += `\n${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}`;
      throw error;
    }
  };
  const transport = archiveCLITransport(t, x.root, x.remote, x.ledger.repository.repository_id);
  git(['config', '--unset-all', `url.file://${x.remote}.insteadOf`], { cwd: x.route.path });
  const managed = new CodeRouteGit(x.ledger.store, x.route.route_id);
  writeFileSync(join(x.route.path, 'service.txt'), 'reviewable result\n');
  await managed.apply({ ...actor(), action: 'stage', snapshot: await managed.snapshot(['service.txt']) });
  const commit = await managed.apply({ ...actor(), action: 'commit', snapshot: await managed.snapshot([]),
    message: 'Synthetic protocol result', author: { name: 'Fixture', email: 'fixture@example.invalid' } });
  const form = invoke(x.route.path, 'candidate', 'template', '--dev-run', x.route.dev_run_id!).submission;
  const marker = 'AUTHOR_ONLY_PROTOCOL_MARKER';
  form.explanation = marker;
  for (const claim of form.claims) {
    claim.explanation = marker;
    for (const criterion of claim.criteria) criterion.explanation = marker;
  }
  for (const rationale of form.change_rationales) {
    rationale.target_refs = [{ type: 'criterion', id: form.claims[0].criteria[0].criterion_id }];
    rationale.rationale = marker;
  }
  const submission = join(x.root, 'submission.json'); writeFileSync(submission, JSON.stringify(form));
  const candidate = invoke(x.route.path, 'candidate', 'submit', '--dev-run', x.route.dev_run_id!, '--expected-version', '1',
    '--file', submission, '--archive-policy', transport.policy(), '--agent-id', 'author', '--agent-name', 'Author');
  assert.equal(candidate.source.commit, `sha1:${commit.head}`);

  // Remove the entire active instance and cache from reach; review must recover
  // the archived Candidate in an independent matching clone, not follow .git.
  const clone = join(x.root, 'review-clone');
  git(['clone', '--no-local', '--no-tags', '--single-branch', '--branch', 'main', x.remote, clone]);
  git(['remote', 'set-url', 'origin', 'ssh://git@example.test/team/repo'], { cwd: clone });
  renameSync(x.dataRoot, join(x.root, 'offline-data'));
  assert.throws(() => invoke(clone, 'verification', 'run', 'start', candidate.candidate_id,
    '--agent-id', 'coordinator', '--agent-name', 'Coordinator'), /local_objects_incomplete/);
  invoke(clone, 'candidate', 'fetch', candidate.candidate_id);
  const run = invoke(clone, 'verification', 'run', 'start', candidate.candidate_id,
    '--agent-id', 'coordinator', '--agent-name', 'Coordinator');
  assert.equal(readFileSync(join(run.paths.review_worktree, 'service.txt'), 'utf8'), 'reviewable result\n');
  const blind = readFileSync(run.paths.blind_context, 'utf8');
  assert.ok(!blind.includes(marker));
  const contextArgs = ['verification', 'context', candidate.candidate_id, '--phase', 'reconcile', '--review-session', run.review_session_id];
  const refused = () => {
    try { invoke(clone, ...contextArgs); assert.fail('reconcile opened before freeze'); }
    catch (error: any) {
      if (!error.stdout) throw error;
      return JSON.parse(String(error.stdout)).error;
    }
  };
  assert.equal(refused().details.reason, 'blind_not_closed');
  invoke(clone, 'verification', 'run', 'stage', run.run_id, '--stage', 'blind', '--state', 'running');
  const report = JSON.parse(readFileSync(run.paths.report_skeleton, 'utf8'));
  for (const assessment of report.assessments) for (const criterion of assessment.criteria) {
    criterion.independent = { verdict: 'qualified', explanation: 'Synthetic protocol fixture checked fixed bytes', evidence: [] };
    criterion.reconciliation = { claim_relation: 'corroborated', explanation: 'Synthetic protocol fixture compared claim' };
    criterion.final = { verdict: 'qualified', explanation: 'Protocol fixture only' };
  }
  const reportFile = join(x.root, 'report.json'); writeFileSync(reportFile, JSON.stringify(report));
  const digest = invoke(clone, 'verification', 'independent-digest', '--file', reportFile).independent_digest;
  invoke(clone, 'verification', 'run', 'stage', run.run_id, '--stage', 'blind', '--state', 'succeeded');
  assert.equal(refused().details.reason, 'blind_not_frozen');
  invoke(clone, 'verification', 'run', 'freeze', run.run_id, '--independent-digest', digest);
  assert.ok(JSON.stringify(invoke(clone, ...contextArgs)).includes(marker));
  invoke(clone, 'verification', 'run', 'stage', run.run_id, '--stage', 'reconcile', '--state', 'succeeded');
  const handoff = invoke(clone, 'verification', 'handoff', '--file', reportFile, '--independent-digest', digest,
    '--agent-id', 'protocol-verifier', '--agent-name', 'Protocol Verifier').handoff;
  const handoffFile = join(x.root, 'handoff.json'); writeFileSync(handoffFile, JSON.stringify(handoff));
  invoke(clone, 'verification', 'run', 'handoff', run.run_id, '--report-digest', handoff.report_digest, '--state', 'signed');
  const verified = invoke(clone, 'verification', 'submit', candidate.candidate_id, '--handoff', handoffFile);
  const recorded = invoke(clone, 'verification', 'run', 'show', run.run_id);
  assert.equal(recorded.submit.verification_id, verified.verification_id);

  const client = await Client.open({ cli, cwd: clone, config, timeout: 60000, review: true });
  try {
    const before = invoke(clone, 'ledger', 'list');
    const detail: any = await client.query('candidate', [candidate.candidate_id]);
    assert.equal(detail.candidate.candidate_id, candidate.candidate_id);
    const review: any = await client.query('review', [candidate.candidate_id, '--summary']);
    assert.equal(review.trace.artifact.result_tree_oid, candidate.result_tree_oid);
    assert.equal(review.trace.verification_set.count, 1);
    const reports: any = await client.query('verifications', ['--candidate', candidate.candidate_id, '--paged']);
    assert.equal(reports.verifications[0].verification_id, verified.verification_id);
    const full: any = await client.query('verification', [verified.verification_id]);
    assert.equal(full.attribution.agent_id, 'protocol-verifier');
    assert.deepEqual(invoke(clone, 'ledger', 'list'), before, 'TUI reads must not write business records');
  } finally { await client.close(); }
});
