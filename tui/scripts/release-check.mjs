import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
if (!tags.includes(`tui-v${version}`)) throw new Error(`Release requires tui-v${version} at HEAD`);
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Release requires a clean worktree');
// First release must verify against an actual registry artifact, not the source CLI.
if (!process.env.GROUNDS_RELEASE_CLI) throw new Error('Set GROUNDS_RELEASE_CLI to the verified registry-installed CLI executable');
