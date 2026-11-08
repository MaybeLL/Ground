// Source build only. Installed tarballs already contain the platform binaries.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const gyp = process.env.npm_config_node_gyp || join(dirname(process.env.npm_execpath), '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
execFileSync(process.execPath, [gyp, 'rebuild'], { cwd: root, stdio: 'inherit' });
const platform = join(root, 'prebuilds', `${process.platform}-${process.arch}`);
mkdirSync(platform, { recursive: true });
copyFileSync(join(root, 'build', 'Release', 'peercred.node'), join(platform, 'peercred.node'));
