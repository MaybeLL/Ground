// Acceptance against the installed executable, a new data directory and a local bare remote.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function acceptFirstWork(cli, directory, env) {
  const command = (program, args, cwd = directory) => execFileSync(program, args, { cwd, env, encoding: 'utf8' }).trim();
  const grounds = (...args) => JSON.parse(command(cli, [...args, '--json'])).data;
  const git = (cwd, ...args) => command('git', args, cwd);
  const source = join(directory, 'source'), remote = join(directory, 'remote.git');
  git(directory, 'init', '--bare', remote);
  git(directory, 'init', '-b', 'main', source);
  writeFileSync(join(source, 'example.txt'), 'before\n');
  git(source, 'add', 'example.txt');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base');

  grounds('init');
  const task = grounds('task', 'create', '--title', 'Update example', '--criterion', 'Contains after', '--repo-remote', remote, '--baseline', git(source, 'rev-parse', 'HEAD'));
  const run = grounds('work', 'start', '--task', task.taskId, '--mode', 'none');
  const workspace = grounds('work', 'workspace', '--run', run.runId, '--repo', source);
  writeFileSync(join(workspace.path, 'example.txt'), 'after\n');
  git(workspace.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'update');
  const delivered = grounds('work', 'deliver', '--run', run.runId, '--repo', workspace.path);
  assert.equal(delivered.submitted.status, 'delivered');
  assert.equal(git(remote, 'show', `refs/tags/grounds/deliveries/${delivered.delivery.id}:example.txt`), 'after');
  const gate = grounds('grade', 'request', '--run', run.runId);
  const registered = grounds('grade', 'register', '--grading', gate.gradingId, '--agent', 'package-smoke');
  const session = ['--grading', gate.gradingId, '--session', registered.sessionId];
  const grade = JSON.stringify({ criteria: [{ criterion_id: task.criteria[0].id, independent: 'satisfied', reconciliation: 'not_determined', final: 'satisfied', rationale: 'Read the frozen file from the bare remote' }] });
  const file = join(directory, 'score.json');
  writeFileSync(file, grade);
  grounds('grade', 'stage', ...session, '--stage', 'blind');
  grounds('grade', 'stage', ...session, '--stage', 'freeze', '--blind-digest', 'sha256:' + createHash('sha256').update(grade).digest('hex'));
  for (const stage of ['reconcile', 'handoff', 'submit']) grounds('grade', 'stage', ...session, '--stage', stage);
  assert.equal(grounds('grade', 'submit', ...session, '--grade-file', file).status, 'completed');
  assert.equal(grounds('work', 'close', '--work', run.workId).conclusion, 'accepted');
}
