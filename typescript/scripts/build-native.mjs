// Source build only. Installed tarballs already contain the platform binaries.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const gyp = process.env.npm_config_node_gyp || join(dirname(process.env.npm_execpath), '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
execFileSync(process.execPath, [gyp, 'rebuild'], { cwd: root, stdio: 'inherit' });
const platform = join(root, 'prebuilds', `${process.platform}-${process.arch}`);
mkdirSync(platform, { recursive: true });
// Existing hosts may still map the signed binary. Publish a new inode so
// Darwin never validates replacement pages against the old mapping.
const staged = join(platform, '.peercred-' + randomUUID());
try {
  copyFileSync(join(root, 'build', 'Release', 'peercred.node'), staged);
  renameSync(staged, join(platform, 'peercred.node'));
} finally {
  rmSync(staged, { force: true });
}
