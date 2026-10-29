import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const outcome of ['exited', 'timed_out', 'setup_failed']) {
  test(`output truncation and ${outcome} diagnostics survive unknown termination`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'grounds-eval-diagnostics-')));
    // A separate process keeps the unavailable native observer local to this
    // fault injection; ordinary runtime and other tests retain the real binding.
    const script = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { mkdirSync } from 'node:fs';
      import { join } from 'node:path';
      const root = process.argv[1];
      const outcome = process.argv[2];
      const require = createRequire(import.meta.url);
      const bindingPath = require.resolve('./build/Release/peercred.node');
      const original = require(bindingPath);
      const observer = Object.create(original);
      Object.defineProperty(observer, 'hostProcesses', { value: () => ({ complete: false, processes: [] }), writable: true });
      require.cache[bindingPath].exports = observer;
      const { withRuntimeDirectories } = await import('./src/runtime-files.ts');
      const { runGraderProcess } = await import('./src/eval-process.ts');
      const { listEnvironments, readEnvironment, environmentDown } = await import('./src/env-environment.ts');
      const { reconcileRun } = await import('./src/env-run.ts');
      const { runFilesOf, readRecord } = await import('./src/env-store.ts');
      mkdirSync(join(root, 'workspace'));
      await withRuntimeDirectories({ runtimeHome: join(root, 'runtime'), directoryRegistryHome: join(root, 'registry') }, async () => {
        let result;
        try {
          result = await runGraderProcess({ executable: process.execPath,
            args: ['-e', "process.stdout.write('x'.repeat(65536));" +
              (outcome === 'timed_out' ? 'setInterval(() => {}, 1000)' : outcome === 'setup_failed' ? 'process.exitCode = 125' : '')],
            cwd: join(root, 'workspace'), timeout_ms: outcome === 'timed_out' ? 500 : 3000, max_output_bytes: 1000 });
        } finally {
          observer.hostProcesses = original.hostProcesses;
          require.cache[bindingPath].exports = original;
        }
        const environment = listEnvironments()[0];
        const run = readRecord(runFilesOf(environment.directory)[0]);
        try {
          assert.equal(run.termination, 'unknown');
          assert.equal(run.log_truncated, false); // The adapter's smaller limit truncates.
          assert.equal(Buffer.byteLength(result.stdout), 1000);
          assert.match(result.error, /output exceeded 1000 bytes; captured output is incomplete/);
          assert.match(result.error, /termination is unknown; environment retained/);
          if (outcome === 'timed_out') assert.match(result.error, /test process exceeded timeout/);
          if (outcome === 'setup_failed') assert.match(result.error, /test setup or process launch failed/);
        } finally {
          let recovered = reconcileRun(run.id);
          for (let attempt = 0; recovered.termination !== 'confirmed' && attempt < 20; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 25));
            recovered = reconcileRun(run.id);
          }
          if (recovered.termination === 'confirmed') {
            environmentDown(environment.id);
          } else {
            // Unrelated inaccessible processes can keep real host observation
            // incomplete after injection ends. That must protect this fixture.
            assert.throws(() => environmentDown(environment.id), { code: 'STATE_CONFLICT' });
            const retained = readEnvironment(environment.id);
            assert.notEqual(retained.state, 'released');
            assert.equal(retained.cleanup.state, 'blocked');
          }
          console.log('GROUNDS_DIAGNOSTIC_CLEANUP ' + readEnvironment(environment.id).state);
        }
      });
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root, outcome], {
      encoding: 'utf8', timeout: 30000,
    });
    if (result.status === 0 && result.stdout.includes('GROUNDS_DIAGNOSTIC_CLEANUP released')) {
      rmSync(root, { recursive: true, force: true });
    } else if (result.status === 0) {
      process.stderr.write(`Protected unknown-termination diagnostic fixture: ${root}\n`);
    }
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nDiagnostic fixture retained on failure: ${root}`);
  });
}
