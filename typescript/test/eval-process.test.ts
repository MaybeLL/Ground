import assert from 'node:assert/strict';
import { test } from 'node:test';
import { temporary } from './env-test-helpers.js';
import { runGraderProcess, type ProcessResult } from '../src/eval-process.js';

const isolated = async (action: (workspace: string) => Promise<ProcessResult>): Promise<ProcessResult> => {
 let result: ProcessResult | undefined;
 await temporary(async (_root, workspace) => { result = await action(workspace); });
 return result!;
};
const run = (code: string, options: { timeout_ms?: number; max_output_bytes?: number } = {}) => isolated(workspace => runGraderProcess({ executable: process.execPath, args: ['-e', code], cwd: workspace, timeout_ms: 3000, ...options }));

test('process adapter preserves split UTF-8 output bytes and exit status', async () => {
  const result = await run("const b=Buffer.from('你好');process.stdout.write(b.subarray(0,1));setTimeout(()=>{process.stdout.write(b.subarray(1));process.stderr.write('reason');process.exitCode=7},20)");
  assert.equal(result.stdout, '你好'); assert.equal(result.stderr, 'reason'); assert.equal(result.exit_code, 7); assert.equal(result.error, undefined);
});

test('process adapter terminates hanging processes and reports timeout as an execution error', async () => {
  const result = await run('setInterval(()=>{},1000)', { timeout_ms: 150 });
  assert.match(result.error!, /timeout/); assert.equal(result.exit_code, null);
});

test('process adapter bounds stored output and never reports truncated output as success', async () => {
  const result = await run("process.stdout.write('x'.repeat(1000000))", { max_output_bytes: 1000 });
  assert.match(result.error!, /incomplete/);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1000);
});

test('process launch errors resolve with an execution error', async () => {
  const result = await isolated(workspace => runGraderProcess({ executable: '/nonexistent/grounds-test-program', args: [], cwd: workspace, timeout_ms: 1000 }));
  assert.match(result.error!, /launch failed/);
});

test('private grading cannot silently fall back to trusted host', async () => {
 const result = await isolated(workspace => runGraderProcess({executable:process.execPath,args:['-e','process.exit(0)'],cwd:workspace,timeout_ms:1000,require_isolation:true}));
 assert.match(result.error!, /requires a Docker environment/); assert.equal(result.exit_code,null);
});
