import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fixtureGit = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Local-only submodule; no credentials, network, or global Git configuration. */
export const addFixtureSubmodule = (root: string, source: string, path = 'support/orm'): string => {
  const upstream = join(root, 'orm-upstream');
  execFileSync('git', ['init', '-q', upstream]);
  fixtureGit(upstream, 'config', 'user.name', 'Test');
  fixtureGit(upstream, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(upstream, 'schema.txt'), 'baseline schema\n');
  fixtureGit(upstream, 'add', '.'); fixtureGit(upstream, 'commit', '-qm', 'schema');
  fixtureGit(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--name', 'fixture-orm', upstream, path);
  return join(source, path);
};
