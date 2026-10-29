import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { deriveLocalGitArtifact } from "../src/git-artifact-local.js";
import { runGraderProcess } from "../src/eval-process.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { runCLI } from '../src/cli.js';
import { SCHEMA_VERSION } from '../src/sql-store.js';
import { SQLStore } from '../src/sql-store.js';
import { LedgerFixture, testAgent } from './fixture.js';
import { newUUIDv7 } from '../src/identity.js';
import { assertContract } from './schema-fixture.js';
import { archiveCLITransport } from "./archive-cli-fixture.js";
import { addFixtureSubmodule } from './submodule-fixture.js';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();

const graderImage = process.env.GROUNDS_TEST_GO_IMAGE ?? 'golang:1.24.7-bookworm';
let dockerUnavailable: string | false = false;
try { execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 5000 }); execFileSync('docker', ['image', 'inspect', graderImage], { stdio: 'pipe', timeout: 5000 }); }
catch { dockerUnavailable = 'requires an available Docker engine and preloaded Go image (GROUNDS_TEST_GO_IMAGE)'; }
for (const nested of [false, true]) test(`CLI Candidate to Grader and reports (nested vendor module=${nested})`, { skip: dockerUnavailable }, async t => {
  const root = realpathSync(mkdtempSync(join(process.env.GROUNDS_ENV_TEST_ROOT ?? tmpdir(), 'grounds-eval-cli-'))); const repo = join(root, 'repo'); const config = join(root, 'config.yaml'); const db = join(root, 'ledger.db');
  let f: LedgerFixture | undefined;
  let passed = false;
  const invoke = async (args: string[], attributed = false): Promise<any> => {
    const output: string[] = [];
    const code = await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, () => runCLI([...args, '--json', '--config', config, ...(attributed ? ['--agent-id', 'eval-test', '--agent-name', 'Evaluation test'] : [])], { cwd: repo, stdout: s => output.push(s), stderr: () => {} }));
    const envelope = JSON.parse(output.join('\n')); assert.equal(code, 0, JSON.stringify(envelope)); assertContract('cli-envelope.schema.json', envelope); return envelope.data;
  };
  const file = (name: string, data: unknown) => { const path = join(root, name); writeFileSync(path, JSON.stringify(data)); return path; };
  try {
    execFileSync('git', ['init', '-q', repo]); git(repo, 'config', 'user.name', 'T'); git(repo, 'config', 'user.email', 't@example.test'); git(repo, 'remote', 'add', 'origin', 'ssh://git@example.test/team/repo');
    addFixtureSubmodule(root, repo);
    mkdirSync(join(repo, '.grounds/environments'), { recursive: true });
    mkdirSync(join(repo, 'docker'));
    writeFileSync(join(repo, '.grounds/environments/grader.yaml'), 'format: grounds.environment-definition/v1\nname: grader\nbackend: docker\nbase:\n  image:\n    dockerfile: docker/Dockerfile\n    context: docker\n');
    writeFileSync(join(repo, 'docker/Dockerfile'), `FROM ${graderImage}\nENV GOCACHE=/tmp/go-cache GOPATH=/tmp/go\nRUN command -v git && go version\n`);
    const moduleRoot = nested ? join(repo, 'src') : repo;
    mkdirSync(moduleRoot, { recursive: true });
    writeFileSync(join(moduleRoot, 'go.mod'), 'module calc\n\ngo 1.19\n' + (nested ? '\nrequire example.test/math v1.0.0\n' : ''));
    if (nested) {
      mkdirSync(join(moduleRoot, 'vendor/example.test/math'), { recursive: true });
      writeFileSync(join(moduleRoot, 'vendor/modules.txt'), '# example.test/math v1.0.0\n## explicit; go 1.19\nexample.test/math\n');
      writeFileSync(join(moduleRoot, 'vendor/example.test/math/math.go'), 'package math\nfunc Add(a,b int) int { return a+b }\n');
    }
    writeFileSync(join(moduleRoot, 'calc.go'), 'package calc\nfunc Add(a,b int) int { return 0 }\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
    await invoke(['init', '--driver', 'sqlite', '--path', db, '--non-interactive']);
    f = await LedgerFixture.createWithStore(SQLStore.sqlite(db));
    const remote = join(root, "remote.git"); git(root, "init", "--bare", "-q", remote); git(repo, "push", remote, "HEAD:refs/heads/main");
    const transport = archiveCLITransport(t, root, remote, f.repository.repository_id);
    const issue = (await f.module.createIssue({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: f.requirement.requirement_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, repository_id: f.repository.repository_id, baseline: { git_oid: 'sha1:' + git(repo,'rev-parse','HEAD'), reachability: 'unconfirmed', warning: 'local fixture', override_reason: 'fixture' }, input: { format: 1, summary: 'Implement integer addition', goals: [{ statement: 'Return integer addition', criteria: ['Add sums its arguments'], traces_to: [{ type: 'outcome', ordinal: 1 }] }] } })).result;
    const template = (await invoke(['eval','grader','template','--issue',issue.issue_id,'--issue-version','1','--type','unit_test'])).payload;
    template.name = 'Addition'; template.scope = { kind: 'criterion', criterion_ids: [(await f.module.loadIssue(issue.issue_id)).issue_revision.goals[0].criteria[0].id] }; template.definition = { type: 'unit_test', adapter: 'go', package: nested ? 'src' : '.', test_name: 'TestAdd', timeout_seconds: 300, files: [{ path: 'private_add_test.go', content: 'package calc\nimport "testing"\nfunc TestAdd(t *testing.T) {\n cases := []struct{a,b,want int}{{1,2,3},{-1,1,0},{0,0,0}}\n for _, c := range cases { if got := Add(c.a,c.b); got != c.want { t.Errorf("got %d want %d",got,c.want) } }\n}\n' }] };
    const grader = (await invoke(['eval','grader','publish','--file',file('grader.json',template)],true)).payload;
    const scoreDraft = { ...template, name: 'Readability', scope: { kind: 'diagnostic', name: 'Readability' }, result_spec: { kind: 'score', min: 0, max: 5, higher_is_better: true, rubric: '0 opaque; 5 direct and idiomatic' }, definition: { type: 'agent', instructions: 'Prefer unit tests; inspect clarity of names and responsibilities where unit tests cannot decide readability' } };
    const score = (await invoke(['eval','grader','publish','--file',file('score.json',scoreDraft)],true)).payload;
    let suite = (await invoke(['eval','suite','create','--name','Addition'],true)).payload;
    suite = (await invoke(['eval','suite','task','add',suite.id,'--expected-version','1','--file',file('task.json',{name:'Add',issue:template.issue,graders:[{id:grader.id,version:1},{id:score.id,version:1}]})],true)).payload;
    const subject = file('subject.json',{name:'No KB',description:'Deterministic development fixture, no real model'});
    const experiment = (await invoke(['eval','experiment','create','--suite',suite.id,'--file',subject],true)).payload;
    const op = newUUIDv7();
    const startArgs = ['eval','run','start','--experiment',experiment.id,'--task',suite.data.tasks[0].id,'--operation-id',op];
    const started = (await invoke(startArgs,true)).payload; const run = started.run; const worktree = started.local_worktree.path;
    assert.equal((await invoke(startArgs,true)).payload.run.id,run.id);
    assert.equal((await invoke(['eval','run','show',run.id])).payload.progress.phase, 'developing');
    assert.ok(!JSON.stringify((await invoke(['eval','run','context',run.id])).payload).includes('private_add_test.go'));
    assert.ok(!existsSync(join(worktree,'private_add_test.go')));
    assert.match(git(worktree, 'submodule', 'status'), /^-/);
    writeFileSync(join(worktree, nested ? 'src/calc.go' : 'calc.go'), nested ? 'package calc\nimport m "example.test/math"\nfunc Add(a,b int) int { return m.Add(a,b) }\n' : 'package calc\nfunc Add(a,b int) int { return a+b }\n');
    const context = started.development_context.context; const goal = context.issue.goals[0]; const criterion = goal.criteria[0];
    const submission = { format: 'patchledger.candidate-submission/v1', explanation: 'Return the sum', claims: [{ target_type: 'goal', target_id: goal.id, explanation: 'Implemented addition', criteria: [{ criterion_id: criterion.id, explanation: 'Adds both inputs', evidence: [] }] }] };
    git(worktree, "add", "-A"); git(worktree, "commit", "-qm", "fixed candidate");
    const candidate = await invoke(['candidate','submit',run.data.dev_run_id,'--archive-policy',transport.policy(),'--expected-version','1','--file',file('candidate.json',submission)],true);
    assert.equal((await invoke(['eval','run','show',run.id])).payload.progress.phase, 'ready_to_grade');
    const executed = (await invoke(['eval','grader','execute','--eval-run',run.id,'--grader',grader.id],true)).payload;
    assert.equal(executed.data.submission.outcome?.verdict,'pass',JSON.stringify(executed.data.submission));
    assert.equal((await invoke(['eval','grader','execute','--eval-run',run.id,'--grader',grader.id],true)).payload.id, executed.id);
    assert.ok(!existsSync(join(worktree,'private_add_test.go')));
    const packet = (await invoke(['eval','grader','context','--eval-run',run.id,'--grader',score.id,'--out',join(root,'private')],true)).payload;
    const resultFile = file('assessment.json',{...packet.submission_template,outcome:{kind:'score',value:4},explanation:'Addition is direct and names expose inputs; evidence fixture.',evidence:[{kind:'observation',content:'calc.go:2 returns a+b without unnecessary branches'}]});
    await invoke(['eval','grader','submit','--file',resultFile],true);
    assert.equal((await invoke(['eval','run','show',run.id])).payload.progress.phase, 'ready_to_finish');
    const result = (await invoke(['eval','run','finish',run.id],true)).payload;
    assert.equal(result.data.candidate_id,candidate.candidate_id); assert.equal(result.data.development_duration.kind,'measured');
    await invoke(['eval','experiment','report',experiment.id,'--out',join(root,'report')]);
    assert.match(readFileSync(join(root,'report','report.md'),'utf8'),/Score: 4/);
    const peer = (await invoke(['eval','experiment','create','--snapshot',experiment.data.snapshot_id,'--file',file('peer.json',{name:'Graph KB',description:'Configuration fixture, task not started'})],true)).payload;
    await invoke(['eval','compare',experiment.id,peer.id,'--out',join(root,'comparison')]);
    assert.match(readFileSync(join(root,'comparison','comparison.md'),'utf8'),/Not started/);
    f.store.setGitArtifactResolver(ref => deriveLocalGitArtifact(repo, ref.git_artifact!.binding));
    const integrity = (await f.store.inspectIntegrity()).report; assert.equal(integrity.valid,true,JSON.stringify(integrity.issues));
    passed = true;
  } finally { await f?.close(); if (passed || !process.env.GROUNDS_ENV_TEST_ROOT) rmSync(root,{recursive:true,force:true}); else process.stderr.write(`Retained Git/Docker evaluation fixture: ${root}\n`); }
});

test('schema 12 migration adds Eval storage without changing existing Candidate context', async () => {
  const root=mkdtempSync(join(tmpdir(),'grounds-eval-migrate-'));const path=join(root,'db');const store=SQLStore.sqlite(path);
  try {
    const f=await LedgerFixture.createWithStore(store);const c=await f.submitCandidate();const before=await f.module.verificationContext(c.candidate.candidate_id,'blind');
    const raw=new DatabaseSync(path);raw.exec(`DROP TABLE eval_records; UPDATE schema_metadata SET schema_version=12; DELETE FROM schema_migrations WHERE schema_version=${SCHEMA_VERSION}`);raw.close();
    await assert.rejects(store.open(),{code:'SCHEMA_INCOMPATIBLE'}); assert.equal((await store.migrate()).schema_version,SCHEMA_VERSION);
    assert.equal((await store.migrate()).schema_version,SCHEMA_VERSION);assert.deepEqual(await f.module.verificationContext(c.candidate.candidate_id,'blind'),before);
  } finally {await store.close();rmSync(root,{recursive:true,force:true});}
});


test('private grading on implicit host refuses before executing the grader', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-eval-host-refusal-')));
  try {
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'input'), 'fixed\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixed');
    const marker = join(root, 'should-not-run');
    const result = await withRuntimeDirectories({ runtimeHome: join(root, 'runtime'), directoryRegistryHome: join(root, 'registry') }, () => runGraderProcess({ executable: '/usr/bin/touch', args: [marker], cwd: root, workspace_root: root, input_commit: 'sha1:' + git(root, 'rev-parse', 'HEAD'), timeout_ms: 1000, require_isolation: true }));
    assert.match(result.error!, /requires a Docker environment/); assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
