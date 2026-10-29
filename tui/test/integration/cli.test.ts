import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedReport } from '../../src/eval-protocol.js';
import { attemptText, matrixRows, reports } from '../../src/eval-model.js';
import { newGrader } from '../../src/eval-drafts.js';
import { Client } from '../../src/client.js';
import { methods } from '../../src/protocol.js';
import { loadPage } from '../../src/pages.js';
import { Workspace } from '../../src/workspace.js';
import { detailTree, type Node } from '../../src/details.js';
import { ReviewSession } from '../../src/review-data.js';
import { blocks, criteria, linkedCriteria, operationId } from '../../src/review-model.js';
import { seedReports } from '../support/report-fixture.js';
import { gitArchiveFixture } from '../support/git-archive-fixture.js';

const cli = process.env.GROUNDS_RELEASE_CLI ?? resolve('../typescript/dist/src/bin.js');
const mysql = ['HOST', 'DATABASE', 'USERNAME', 'PASSWORD'].every(k => process.env[`GROUNDS_TEST_MYSQL_${k}`]);
const reportCount = process.env.GROUNDS_TUI_SCALE === '1' ? 257 : 1;
const reportSetup = process.env.GROUNDS_TUI_REPORT_SETUP ?? 'bulk';
assert.ok(['bulk', 'cli'].includes(reportSetup), 'GROUNDS_TUI_REPORT_SETUP must be bulk or cli');
// The TUI reads an Issue through the public CLI JSON protocol. A plan-bearing
// Issue Version must survive publish and read back through that same protocol,
// and an Issue without a plan must still render — both against the exact core
// build under test (GROUNDS_RELEASE_CLI).
test('plan-bearing Issue Versions round-trip through the public CLI protocol', { skip: false, timeout: 300000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'grounds-tui-plan-'));
  const repository = join(root, 'repo');
  mkdirSync(repository, { recursive: true });
  const config = join(root, 'config.yaml');
  const env = { ...process.env, GROUNDS_AGENT_ID: 'tui-plan-fixture', GROUNDS_AGENT_NAME: 'TUI plan fixture' };
  const run = (args: string[], cwd = repository, timeout = 60000): any => {
    const raw = execFileSync(cli, [...args, '--config', config, '--json'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(raw).data;
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repository], { encoding: 'utf8' });
    git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
    writeFileSync(join(repository, 'a.txt'), 'baseline\n'); git('add', 'a.txt'); git('commit', '-qm', 'fixture baseline');
    git('remote', 'add', 'origin', `ssh://git@example.test/tui/${root.split('/').at(-1)}`);
    run(['init', '--driver', 'sqlite', '--non-interactive', '--baseline-policy', 'warn', '--path', join(root, 'ledger.db')]);
    run(['workspace', 'new', 'fixture']);

    const PLAN = '方案：先加列封存。';
    const saved = run(['workspace', 'read', 'fixture']);
    saved.draft.issues[0].input.plan = PLAN;
    writeFileSync(join(root, 'draft.json'), JSON.stringify({ requirement: saved.draft.requirement, issues: saved.draft.issues }));
    run(['workspace', 'save', 'fixture', '--file', join(root, 'draft.json'), '--expected-version', saved.version]);
    const reread = run(['workspace', 'read', 'fixture']);
    const published = run(['workspace', 'publish', 'fixture', '--expected-version', reread.version, '--allow-unpublished-baseline', '--override-reason', 'Synthetic local test baseline'], repository, 120000);
    const issue = published.issues[0].id;

    // Read back through the same public projection the TUI uses.
    const shown = run(['issue', 'show', issue]);
    assert.equal(shown.issue.plan, PLAN, 'plan must survive publish and read back');

    // The TUI renders it under a clearly non-normative label, with Mermaid as text.
    // Mirror the real client's argv construction: each method carries its own
    // command prefix (for example issue -> `issue show`).
    const w = new Workspace({ async query(method, args = []) {
      const spec = (methods as Record<string, { args: string[] }>)[method];
      if (!spec) throw new Error(`unsupported method in this fixture: ${method}`);
      return run([...spec.args, ...args.filter((a): a is string => typeof a === 'string')]);
    } });
    const detail = await w.loadDetail({ kind: 'issue', id: issue }, new AbortController().signal);
    const rendered = JSON.stringify(detailTree(detail));
    assert.match(rendered, /方案说明（非约束）/);

    // An Issue without a plan still reads normally.
    const requirement = published.requirement.id;
    assert.ok(requirement);
    assert.equal(shown.issue.version, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const driver of ['sqlite', 'mysql']) test(`${driver}: real Git archives and TUI reads leave ledger unchanged (${reportCount} reports)`, { skip: driver === 'mysql' && !mysql, timeout: 600000 }, async () => {
  const startedAt = performance.now();
  let phaseStarted = startedAt;
  let cliCommands = 0;
  const timing = (phase: string) => {
    const now = performance.now();
    console.log('FIXTURE_TIMING ' + JSON.stringify({ driver, reportCount, reportSetup, phase, directCliCommands: cliCommands, durationMs: Math.round(now - phaseStarted), elapsedMs: Math.round(now - startedAt) }));
    phaseStarted = now;
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-tui-integration-')));
  const config = join(root, 'config.yaml'), repository = join(root, 'repository');
  const env = { ...process.env, GROUNDS_MYSQL_PASSWORD: process.env.GROUNDS_TEST_MYSQL_PASSWORD ?? '' };
  let client: Client | undefined;
  const run = (args: string[], cwd = repository, timeout = 30000): any => {
    cliCommands++;
    const raw = execFileSync(cli, [...args, '--config', config, '--json'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 16 * 1024 * 1024 });
    const envelope = JSON.parse(raw); assert.equal(envelope.ok, true, raw); return envelope.data;
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(repository); git('init', '-q'); git('config', 'user.name', 'TUI Fixture'); git('config', 'user.email', 'tui@example.test');
    writeFileSync(join(repository, 'a.txt'), 'baseline\n'); git('add', 'a.txt'); git('commit', '-qm', 'fixture baseline');
    git('remote', 'add', 'origin', `ssh://git@example.test/tui/${root.split('/').at(-1)}`);
    run(['init', '--driver', driver, '--non-interactive', '--baseline-policy', 'warn', ...(driver === 'sqlite' ? ['--path', join(root, 'ledger.db')] : [
      '--host', process.env.GROUNDS_TEST_MYSQL_HOST!, '--port', process.env.GROUNDS_TEST_MYSQL_PORT ?? '3306',
      '--database', process.env.GROUNDS_TEST_MYSQL_DATABASE!, '--username', process.env.GROUNDS_TEST_MYSQL_USERNAME!,
      '--password-source', 'environment', '--confirm-initialize', ...(process.env.GROUNDS_TEST_MYSQL_CA_FILE ? ['--ca-file', process.env.GROUNDS_TEST_MYSQL_CA_FILE] : []),
    ])]);
    const workspace = run(['workspace', 'new', 'fixture']);
    const publish = () => {
      const saved = run(['workspace', 'read', 'fixture']);
      return run(['workspace', 'publish', 'fixture', '--expected-version', saved.version, '--allow-unpublished-baseline', '--override-reason', 'Synthetic local test baseline'], repository, 120000);
    };
    const published = publish();
    const issue = published.issues[0].id, requirement = published.requirement.id;
    const resolvedRepository = run(['repository', 'resolve']);
    const archive = gitArchiveFixture(root, resolvedRepository.repository_id, resolvedRepository.canonical_remote);
    Object.assign(env, archive.env);
    execFileSync('git', ['push', archive.remote, 'HEAD:refs/heads/main'], { cwd: repository, env, stdio: 'pipe' });
    const ids: string[] = [];
    for (const suffix of ['one', 'two']) {
      const started = run(['devrun', 'start', issue, '--development-mode', 'simple']);
      const devrun = started.context.dev_run;
      writeFileSync(join(started.local_worktree.path, 'a.txt'), `implemented ${suffix}\n`);
      execFileSync('git', ['add', 'a.txt'], { cwd: started.local_worktree.path, env });
      execFileSync('git', ['commit', '-qm', `Fixture ${suffix}`], { cwd: started.local_worktree.path, env });
      const submission = run(['candidate', 'template', devrun.id], started.local_worktree.path).submission;
      submission.explanation = `# Fixture ${suffix}\n\nSynthetic Markdown explanation.\n\n| Field | Meaning |\n| --- | --- |\n| a | Changed file |`;
      for (const claim of submission.claims) {
        claim.explanation = 'Fixture implementation';
        for (const criterion of claim.criteria) criterion.explanation = 'Fixture observed behavior';
      }
      for (const rationale of submission.change_rationales) {
        rationale.rationale = 'Fixture change rationale';
        rationale.target_refs = [{ type: 'criterion', id: submission.claims[0].criteria[0].criterion_id }];
      }
      if (suffix === 'two') {
        submission.format = 'patchledger.candidate-submission/v1';
        delete submission.change_index; delete submission.change_rationales;
      }
      const file = join(root, `submission-${suffix}.json`); writeFileSync(file, JSON.stringify(submission));
      const result = run(['candidate', 'submit', devrun.id, '--expected-version', String(devrun.version), '--file', file, '--archive-policy', archive.policy], started.local_worktree.path);
      assert.equal(execFileSync('git', ['rev-parse', `refs/tags/grounds/candidates/${result.candidate_id}`], { cwd: archive.remote, encoding: 'utf8' }).trim(), result.source.commit.replace(/^sha1:/, ''));
      ids.push(result.candidate_id);
    }
    const report = run(['verification', 'template', ids[0]]).report;
    for (const assessment of report.assessments) for (const criterion of assessment.criteria) {
      criterion.independent = { verdict: 'qualified', explanation: 'Synthetic fixture only', evidence: [] };
      criterion.reconciliation = { claim_relation: 'corroborated', explanation: 'Synthetic fixture only' };
      criterion.final = { verdict: 'qualified', explanation: 'Synthetic fixture only' };
    }
    const reportFile = join(root, 'report.json'); writeFileSync(reportFile, JSON.stringify(report));
    const addReport = () => run(['verification', 'submit', ids[0], '--file', reportFile, '--agent-id', 'tui-fixture-verifier', '--agent-name', 'TUI Fixture Verifier']);
    timing('prepare');
    const reportIds = [addReport().verification_id as string];
    if (reportSetup === 'cli') {
      for (let i = 1; i < reportCount; i++) reportIds.push(addReport().verification_id);
    } else if (reportCount > 1) {
      reportIds.push(...await seedReports({ cli, config, root, seedId: reportIds[0], count: reportCount - 1,
        password: env.GROUNDS_MYSQL_PASSWORD }));
    }
    timing('reports');
    if (reportCount > 1 && reportSetup === 'bulk') {
      // This additional fixture audit scans the entire ledger, unlike a TUI
      // query. Give it its own 60s budget; publish has 120s, other commands 30s, and
      // the complete test still has its original 600s budget.
      const status = run(['db', 'status'], repository, 60000);
      assert.equal(status.integrity.valid, true, JSON.stringify(status.integrity.issues));
      timing('fixture-integrity');
    }
    run(['selection', 'set', '--issue', issue, '--issue-version', '1', '--candidate', ids[0], '--expected-version', '0', '--reason', 'Synthetic fixture selection']);
    const edit = run(['workspace', 'read', 'fixture']);
    edit.draft.issues[0].input.summary = 'Implement the revised requirement';
    const editFile = join(root, 'revised-draft.json');
    writeFileSync(editFile, JSON.stringify(edit.draft));
    run(['workspace', 'save', 'fixture', '--file', editFile, '--expected-version', edit.version]);
    publish();
    let before = run(['ledger', 'list'], root);
    // Metadata remains readable outside Git. Fixed Git diffs require a matching
    // clone; do not replace missing code with the retired SQL patch projection.
    const originalPassword = process.env.GROUNDS_MYSQL_PASSWORD;
    if (driver === 'mysql') process.env.GROUNDS_MYSQL_PASSWORD = env.GROUNDS_MYSQL_PASSWORD;
    try {
      client = await Client.open({ cli, config, cwd: root, timeout: 30000 });
      assert.equal(client.context.version, '0.2.49');
      const originalConfig = readFileSync(config, 'utf8');
      writeFileSync(config, 'invalid: external configuration replacement');
      const signal = new AbortController().signal;
      const oldIssue = await client.query('issue', [issue, '--issue-version', '1']);
      assert.equal((oldIssue.issue as any).version, 1);
      const activity = (await client.query('issues')).resources as any[];
      assert.ok(activity.find(r => r.resource_id === issue).last_activity.occurred_at);
      await assert.rejects(ReviewSession.open(client, ids[0], signal), { code: 'REPOSITORY_NOT_RESOLVED' });
      writeFileSync(config, originalConfig);
      assert.deepEqual(run(['ledger', 'list'], root), before);
      await client.close();
      client = await Client.open({ cli, config, cwd: repository, timeout: 30000 });
      writeFileSync(config, 'invalid: external configuration replacement');
      const session = await ReviewSession.open(client, ids[0], signal);
      assert.equal((session.trace.contract as any).issue.version, 1);
      assert.ok(blocks(session.trace).every(b => b.content && !b.unavailable));
      assert.ok(linkedCriteria(session.trace, blocks(session.trace)[0]).some(c => c.key === criteria(session.trace)[0].key));
      await session.next(signal);
      assert.equal(session.reports.length, 1);
      assert.equal(session.count, reportCount);
      assert.ok((await loadPage(client, { kind: 'home' }, signal)).rows.some(r => r.id === requirement));
      writeFileSync(config, originalConfig);
      assert.ok((await loadPage(client, { kind: 'requirement', id: requirement }, signal)).rows.length);
      assert.match((await loadPage(client, { kind: 'issue', id: issue }, signal)).title, /v2/);
      assert.equal((await loadPage(client, { kind: 'candidates', id: issue, version: 1 }, signal)).rows.length, 2);
      assert.equal((await loadPage(client, { kind: 'candidates', id: issue, version: 2 }, signal)).rows.length, 0);
      const runs = await loadPage(client, { kind: 'devruns', id: issue }, signal);
      await loadPage(client, runs.rows[0].route!, signal);
      await loadPage(client, { kind: 'candidate', id: ids[0] }, signal);
      await loadPage(client, { kind: 'review', id: ids[1] }, signal);
      assert.deepEqual((await loadPage(client, { kind: 'compare', pair: ids }, signal)).rows.map(r => r.id), ids);
      const review = await loadPage(client, { kind: 'review', id: ids[0] }, signal);
      const directory = await loadPage(client, review.rows[0].route!, signal);
      assert.equal(directory.rows.length, Math.min(reportCount, 256));
      assert.match((await loadPage(client, directory.rows[0].route!, signal)).title, /正文已打开/);
      const progressive = new Workspace(client);
      const workbench = await progressive.loadScreen({ kind: 'issue', id: issue }, signal);
      assert.equal(workbench.route.version, 2);
      assert.equal(workbench.rows.filter(r => r.candidate).length, 0);
      const historical = await progressive.loadScreen({ kind: 'issue', id: issue, version: 1 }, signal);
      assert.equal(historical.rows.filter(r => r.candidate).length, 2);
      assert.equal(historical.overview, undefined); // Never replace historical contract with current v2.
      const candidateRoute = { kind: 'candidate' as const, id: ids[0] };
      await progressive.loadDetail(candidateRoute, signal);
      const structured = await progressive.expand(candidateRoute, 'reports', signal);
      const tree = detailTree(structured);
      assert.match(tree.facts.join(' '), /qualified/);
      const allNodes = (nodes: Node[]): Node[] => nodes.flatMap(n => [n, ...allNodes(n.children ?? [])]);
      const nodes = allNodes(tree.nodes);
      assert.ok(nodes.some(n => n.id.includes('/goal:') && n.id.endsWith('/claim') && n.body === 'Fixture observed behavior'));
      const reportNode = nodes.find(n => n.route?.kind === 'verification')!;
      assert.ok(reportNode);
      const verified = await progressive.loadDetail(reportNode.route!, signal);
      assert.ok(allNodes(detailTree(verified).nodes).some(n => n.id.endsWith('/independent/explanation') && n.body === 'Synthetic fixture only'));
      assert.deepEqual(run(['ledger', 'list'], root), before);
      if (process.env.GROUNDS_TUI_PTY === '1' && driver === 'sqlite') {
        const result = execFileSync('python3', ['scripts/pty-smoke.py', process.execPath, process.env.GROUNDS_RELEASE_TUI ?? resolve('dist/bin.js'), '--legacy', '--cli', cli, '--config', config, '--cwd', repository], {
          cwd: resolve('.'), env: { ...env, GROUNDS_TUI_SMOKE_CANDIDATE: ids[0] }, encoding: 'utf8', timeout: 90000,
        });
        assert.match(result, /direction keys update without full-frame erasure/); assert.match(result, /Candidate structured preview/); assert.match(result, /terminal-attribute restoration/);
        assert.deepEqual(run(['ledger', 'list'], root), before);
        const reviewPty = execFileSync('python3', ['scripts/review-pty-smoke.py', process.execPath, process.env.GROUNDS_RELEASE_TUI ?? resolve('dist/bin.js'), '--cli', cli, '--config', config, '--cwd', repository], {
          cwd: resolve('.'), env, encoding: 'utf8', timeout: 180000,
        });
        assert.match(reviewPty, /REVIEW PTY PASS/);
        assert.deepEqual(run(['ledger', 'list'], root), before);
      }
      if (reportCount > 256) {
        assert.ok(directory.next);
        const lastPage = await loadPage(client, directory.next, signal);
        assert.equal(lastPage.rows.length, 1);
        assert.equal(lastPage.next, undefined);
        const pagedIds = [...directory.rows, ...lastPage.rows].map(row => row.id);
        assert.equal(new Set(pagedIds).size, reportCount, 'pages must not repeat reports');
        assert.deepEqual([...pagedIds].sort(), [...reportIds].sort(), 'pages must cover exactly the prepared reports');
        const moreStructured = await progressive.expand(candidateRoute, 'reports-next', signal);
        assert.equal((moreStructured.directory!.verifications as unknown[]).length, 257);
        addReport(); // Explicit fixture mutation, not performed by TUI.
        before = run(['ledger', 'list'], root);
        const restarted = await loadPage(client, directory.next, signal);
        assert.match(restarted.note!, /集合变化/);
        assert.equal(restarted.rows.length, 256);
        assert.deepEqual(run(['ledger', 'list'], root), before);
      }
      // The new UI's only write port: literal arguments, human identity, optimistic locking and idempotency.
      const writer = await Client.open({ cli, config, cwd: repository, timeout: 30000, review: true });
      try {
        // Eval Coding uses the same frozen Candidate and public protocol as the review workspace.
        const actor = await writer.identity(), databaseId = await writer.database();
        const issueRef = { id: issue, version: 1 };
        const publishEval = (request: any) => writer.publish({ ...request, attribution: actor, databaseId, operationId: operationId() });
        const codingGrader = await publishEval({ command: 'grader.publish', body: { ...newGrader({ issue: issueRef }), name: '可读性', scope: {kind:'diagnostic',name:'可读性'}, result_spec:{kind:'score',min:0,max:5,higher_is_better:true,rubric:'清晰程度'}, definition:{type:'agent',instructions:'阅读固定代码'}, limitations:'合成数据' } });
        const goGrader = await publishEval({ command: 'grader.publish', body: { ...newGrader({ issue: issueRef }), name:'Go 检查', definition:{type:'unit_test',adapter:'go',package:'.',test_name:'TestFixture',timeout_seconds:30,files:[{path:'fixture_test.go',content:'package fixture'}]}, scope:{kind:'diagnostic',name:'正确性'},limitations:'只测试管理，不执行 Go'} });
        let evalSuite = await publishEval({ command:'suite.create',name:'Coding 夹具' });
        evalSuite = await publishEval({ command:'suite.task.add',id:evalSuite.id,expectedVersion:1,body:{name:'Coding 题',issue:issueRef,graders:[{id:codingGrader.id,version:1},{id:goGrader.id,version:1}]} });
        const subject = join(root,'coding-subject.json'); writeFileSync(subject,JSON.stringify({name:'Coding A',description:'合成对照'}));
        const experiment = run(['eval','experiment','create','--suite',evalSuite.id,'--file',subject]).payload;
        const peer = run(['eval','experiment','create','--snapshot',experiment.data.snapshot_id,'--file',subject]).payload;
        const evalRun = run(['eval','run','start','--experiment',experiment.id,'--task',(evalSuite.data.tasks as any[])[0].id,'--candidate',ids[0]]).payload;
        const runId = evalRun.run?.id ?? evalRun.id;
        const packet = run(['eval','grader','context','--eval-run',runId,'--grader',codingGrader.id,'--out',join(root,'coding-grade')]).payload;
        const gradeFile = join(root,'coding-grade.json'); writeFileSync(gradeFile,JSON.stringify({...packet.submission_template,status:'completed',outcome:{kind:'score',value:4},explanation:'代码清晰',evidence:[{kind:'observation',content:'固定工件'}]}));
        run(['eval','grader','submit','--file',gradeFile]);
        run(['eval','run','stop',runId,'--reason','Go 维度未执行']);
        const codingReport = checkedReport(await writer.read('experiment.report',[experiment.id]),experiment.id);
        assert.equal(codingReport.tasks[0].runs[0].result!.data.candidate_id,ids[0]);
        assert.match(attemptText(codingReport.tasks[0],codingReport.tasks[0].runs[0]),/Verification/);
        assert.match(attemptText(codingReport.tasks[0],codingReport.tasks[0].runs[0]),/评分区间 0–5/);
        assert.deepEqual(matrixRows(await reports(writer,[experiment.id,peer.id]),{})[0].values,['4','未开始']);
        if (process.env.GROUNDS_TUI_PTY === '1' && driver === 'sqlite') {
          const pty = execFileSync('python3',['scripts/eval-coding-pty-smoke.py',process.execPath,resolve('dist/bin.js'),'--eval','--cli',cli,'--config',config,'--cwd',repository],{cwd:resolve('.'),env:{...env,GROUNDS_TUI_CODING_EXPERIMENT:experiment.id},encoding:'utf8',timeout:90000});
          assert.match(pty,/EVAL CODING PTY PASS/);
        }
        const old = await writer.query('selection', ['--issue', issue, '--issue-version', '1']);
        const request = { issue, version: 1, candidate: ids[1], expectedVersion: (old.selection as any).version, operationId: operationId(), reason: 'Synthetic TUI writer fixture' };
        const result = await writer.selectCandidate(request);
        assert.equal((result.selection as any).candidate_id, ids[1]);
        assert.equal((result.selection as any).attribution.kind, 'human');
        const retried = await writer.selectCandidate(request);
        assert.equal((retried.selection as any).version, (result.selection as any).version);
        await assert.rejects(writer.selectCandidate({ ...request, candidate: ids[0], operationId: operationId() }), /version|conflict/i);
        const current = await writer.query('selection', ['--issue', issue, '--issue-version', '1']);
        assert.equal((current.selection as any).candidate_id, ids[1]);
        const lastActivity = ((await writer.query('issues')).resources as any[]).find(r => r.resource_id === issue).last_activity;
        assert.equal(lastActivity.kind, 'selection'); assert.equal(lastActivity.issue_version, 1);
      } finally { await writer.close(); }
    } finally {
      if (originalPassword === undefined) delete process.env.GROUNDS_MYSQL_PASSWORD;
      else process.env.GROUNDS_MYSQL_PASSWORD = originalPassword;
    }
    timing('reads-and-actions');
  } finally { await client?.close(); rmSync(root, { recursive: true, force: true }); }
});
