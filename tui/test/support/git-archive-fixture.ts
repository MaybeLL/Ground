import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** An isolated Git server for public-CLI integration fixtures. It enforces
 * create-only archive tags and never contacts the fixture's example hostname. */
export function gitArchiveFixture(root: string, repositoryId: string, canonicalRemote: string) {
  const remote = join(root, 'archive.git');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  writeFileSync(join(remote, 'hooks', 'update'), `#!/bin/sh
case "$1" in
  refs/tags/grounds/candidates/*)
    case "$2" in *[!0]*) echo "archive tags are immutable" >&2; exit 1;; esac;;
esac
`, { mode: 0o700 });
  const bin = join(root, 'archive-bin');
  mkdirSync(bin);
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'ssh'), `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('-G')) process.exit(1);
const command = args.at(-1) || '';
const mode = command.startsWith('git-upload-pack ') ? 'upload-pack' : command.startsWith('git-receive-pack ') ? 'receive-pack' : undefined;
if (!mode || !args.includes('git@example.test')) process.exit(255);
const result = spawnSync(${JSON.stringify(git)}, [mode, ${JSON.stringify(remote)}], {stdio:'inherit'});
process.exit(result.status ?? 255);
`, { mode: 0o700 });
  const source = join(root, 'archive-deployment.json');
  const deployment = JSON.stringify({ canonical_remote: canonicalRemote, create_only_archive_namespace: true, isolated_fixture: true });
  writeFileSync(source, deployment);
  const policy = join(root, 'archive-policy.json');
  writeFileSync(policy, JSON.stringify({
    format: 'grounds.archive-protection/v1', repository_id: repositoryId,
    canonical_remote: canonicalRemote, ref_namespace: 'refs/tags/grounds/candidates/',
    source: { kind: 'verified-deployment-config', locator: pathToFileURL(source).href,
      revision: `sha256:${createHash('sha256').update(deployment).digest('hex')}`,
      verified_by: 'tui-isolated-fixture' },
    observed_at: new Date(Date.now() - 1000).toISOString(),
    valid_until: new Date(Date.now() + 3600_000).toISOString(), currently_applicable: true,
    archive_identity_can_create: true, ordinary_identity_cannot_update: true,
    ordinary_identity_cannot_delete: true, team_can_read_by_ref: true,
    repository_backup: 'unknown', database_backup: 'unknown',
  }));
  return { policy, remote, env: { PATH: `${bin}:${process.env.PATH}` } };
}
