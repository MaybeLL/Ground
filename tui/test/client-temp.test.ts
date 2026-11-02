import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, mkdir, writeFile, rm, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClientTemporaryFiles } from '../src/client-temp.js';

test('SIGKILL orphan configuration is removed by the next related session while live sessions and foreign files remain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grounds-tui-crash-test-')), owned = join(root, 'owned');
  let child: ReturnType<typeof spawn> | undefined; const active = new ClientTemporaryFiles(owned), next = new ClientTemporaryFiles(owned);
  try {
    const live = await active.open();
    await writeFile(join(live, 'config.yaml'), 'live session configuration');
    const script = join(root, 'crash.mjs'), ready = join(root, 'ready.json');
    await writeFile(script, `import { ClientTemporaryFiles } from ${JSON.stringify(new URL('../src/client-temp.ts', import.meta.url).href)};
import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
const temp=new ClientTemporaryFiles(process.argv[2]);const directory=await temp.open();
await writeFile(join(directory,'config.yaml'),'private session configuration');
await writeFile(process.argv[3],JSON.stringify({directory}));setInterval(()=>{},1000);`);
    child = spawn(process.execPath, ['--import', 'tsx', script, owned, ready], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
    let orphan: { directory: string } | undefined;
    for (let i = 0; i < 100; i++) { try { orphan = JSON.parse(await readFile(ready, 'utf8')); } catch { } if (orphan) break; await new Promise(r => setTimeout(r, 20)); }
    assert.ok(orphan, 'child must create an actual private configuration before crash');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await mkdir(join(owned, 'foreign-files')); await writeFile(join(owned, 'foreign-files', 'input.json'), 'not owned by the TUI');
    await next.open();
    await assert.rejects(access(orphan.directory), { code: 'ENOENT' });
    assert.equal(await readFile(join(live, 'config.yaml'), 'utf8'), 'live session configuration');
    assert.equal(await readFile(join(owned, 'foreign-files', 'input.json'), 'utf8'), 'not owned by the TUI');
    assert.ok((await readdir(live)).includes('owner.json'));
  } finally { child?.kill('SIGKILL'); await active.close(); await next.close(); await rm(root, { recursive: true, force: true }); }
});
