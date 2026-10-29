import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { invoke } from '../src/client.js';
import { boundedArray, decode, methods } from '../src/protocol.js';
import { z } from 'zod';

test('JSON protocol preserves warnings and rejects wrong commands or exit codes', () => {
  const e = { format: 'patchledger.cli/v1', ok: true, data: { result_type: 'patchledger.result.resource-list/v1', command: 'requirement.list', resources: [], extra: true }, warnings: [{ code: 'NOTICE', message: 'test' }] };
  assert.equal(decode(JSON.stringify(e), 0, 'requirements').extra, true);
  assert.throws(() => decode(JSON.stringify(e), 1, 'requirements'));
  assert.throws(() => decode(JSON.stringify(e), 0, 'candidates'));
  assert.throws(() => decode('not JSON', 0, 'requirements'));
  assert.throws(() => decode(JSON.stringify({ ...e, data: { ...e.data, resources: [{}] } }), 0, 'requirements'));
  assert.throws(() => decode(JSON.stringify({ format: e.format, ok: false, error: { code: 'NOT_FOUND', message: 'missing', retryable: false } }), 3, 'requirements'), { code: 'NOT_FOUND' });
});

test('cancellation terminates the launcher, worker and inherited process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tui-process-tree-'));
  const pids: number[] = [];
  try {
    const file = join(root, 'chain.mjs'), pidFile = join(root, 'pids');
    await writeFile(file, `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[3], process.pid + '\\n');
process.on('SIGTERM', () => {});
if (Number(process.argv[2]) > 0) spawn(process.execPath, [process.argv[1], String(Number(process.argv[2])-1), process.argv[3]], {stdio:'inherit'});
setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const result = invoke(process.execPath, [file, '2', pidFile], root, 10000, controller.signal);
    const rejected = assert.rejects(result, { code: 'CANCELLED' });
    for (let i = 0; i < 100; i++) {
      try { pids.splice(0, pids.length, ...(await readFile(pidFile, 'utf8')).trim().split('\n').map(Number)); } catch { /* starting */ }
      if (pids.length === 3) break;
      await new Promise(r => setTimeout(r, 20));
    }
    controller.abort(); await rejected;
    assert.equal(pids.length, 3);
    for (let i = 0; i < 50 && pids.some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }); i++) await new Promise(r => setTimeout(r, 20));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
    await rm(root, { recursive: true, force: true });
  }
});

test('subprocess argv is literal; stderr does not contaminate stdout; timeout and output bound work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tui-client-'));
  try {
    const file = join(root, 'fake cli.mjs');
    await writeFile(file, 'process.stderr.write("diagnostic"); console.log(JSON.stringify(process.argv.slice(2)));');
    const input = 'hello; $(touch nope) `echo nope` "世界"';
    const result = await invoke(process.execPath, [file, input], root, 5000);
    assert.deepEqual(JSON.parse(result.stdout), [input]);
    await writeFile(file, 'setInterval(()=>{}, 1000);');
    await assert.rejects(invoke(process.execPath, [file], root, 50), { code: 'TIMEOUT' });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(invoke(process.execPath, [file], root, 5000, abort.signal), { code: 'CANCELLED' });
    await writeFile(file, 'process.stdout.write("x".repeat(17*1024*1024));');
    await assert.rejects(invoke(process.execPath, [file], root, 5000), { code: 'OUTPUT_LIMIT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// An oversized malformed collection must produce one size issue rather than
// allocating a validation issue for every element (CVE-2023-54404).
test('oversized protocol arrays reject before visiting malformed elements', () => {
  const malformed = new Proxy({}, { get() { throw new Error('element traversal'); } });
  const result = methods.requirements.schema.safeParse({ resources: Array(100_001).fill(malformed) });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues.length, 1);
    assert.equal(result.error.issues[0]?.code, 'too_big');
  }
  const response = { format: 'patchledger.cli/v1', ok: true, warnings: [], data: {
    result_type: 'patchledger.result.resource-list/v1', command: 'requirement.list', resources: Array(100_001).fill(null)
  } };
  assert.throws(() => decode(JSON.stringify(response), 0, 'requirements'), { code: 'PROTOCOL_ERROR' });
});

test('bounded arrays still validate elements and minimum sizes within the limit', () => {
  const schema = boundedArray(z.string(), 2);
  assert.deepEqual(schema.parse(['a', 'b']), ['a', 'b']);
  assert.equal(schema.safeParse(['a']).success, false);
  assert.equal(schema.safeParse(['a', 3]).success, false);
  assert.equal(schema.safeParse({ length: 2 }).success, false);
  assert.equal(schema.parse(Array(100_000).fill('a')).length, 100_000);
});
