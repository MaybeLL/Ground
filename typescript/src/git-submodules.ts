import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError, worktreeMismatch } from './errors.js';

type ReadGit = (cwd: string, args: string[]) => Buffer;

/** Read gitlinks without parsing Git's human-oriented, quoted submodule status. */
const gitlinks = (root: string, git: ReadGit, tree?: string): Map<string, string> => {
  const output = git(root, tree ? ['ls-tree', '-r', '-z', tree] : ['ls-files', '--stage', '-z']);
  const links = new Map<string, string>();
  for (const record of output.toString('latin1').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, second, third] = record.slice(0, tab).split(' ');
    if (mode !== '160000') continue;
    const bytes = Buffer.from(record.slice(tab + 1), 'latin1');
    const path = bytes.toString('utf8');
    if (!Buffer.from(path).equals(bytes)) throw worktreeMismatch('', 'submodule paths must be valid UTF-8');
    if (!tree && third !== '0') throw worktreeMismatch('', `submodule ${JSON.stringify(path)} has index conflicts`);
    links.set(path, tree ? third : second);
  }
  return links;
};

/**
 * An empty checkout retains only its pinned gitlink, which Git can capture offline.
 * A populated checkout must be a clean repository: its file changes are not part
 * of the superproject patch and must never disappear from a Candidate silently.
 */
export const assertCapturableSubmodules = (root: string, baseline: string, git: ReadGit): void => {
  const links = gitlinks(root, git);
  if (links.size === 0) return;
  const baselineLinks = gitlinks(root, git, baseline);
  for (const [path, oid] of links) {
    const fail = (reason: string): never => { throw worktreeMismatch('', `submodule ${JSON.stringify(path)}: ${reason}`); };
    try {
      let directory = root;
      for (const component of path.split('/')) {
        directory = join(directory, component);
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('checkout must be a real directory');
      }
      const entries = readdirSync(directory);
      if (entries.length === 0) {
        if (baselineLinks.get(path) !== oid) fail('an uninitialized checkout must retain the Baseline gitlink');
        continue;
      }
      if (!entries.includes('.git')) fail('uninitialized checkout contains files that cannot be captured');
      const metadata = lstatSync(join(directory, '.git'));
      if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) fail('invalid checkout metadata');
      const top = git(directory, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
      if (realpathSync(top) !== realpathSync(directory)) fail('checkout resolves to a different repository');
      const head = git(directory, ['rev-parse', 'HEAD']).toString('utf8').trim();
      if (head !== oid) fail('checkout HEAD differs from its index gitlink');
      if (git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).length) {
        fail('checkout has tracked, untracked, or nested submodule changes that cannot be captured');
      }
      assertCapturableSubmodules(directory, head, git);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      fail(`could not inspect checkout: ${String(error)}`);
    }
  }
};
