// Run from typescript/. The data root must be bind-mountable by the local Docker daemon.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(process.env.GROUNDS_TEST_SHARED_ROOT ?? tmpdir(), "grounds-managed-")));
const image = "grounds-managed-test:" + randomUUID();
let built = false;
try {
  execFileSync("docker", ["build", "--pull=false", "-t", image, "test/fixtures/managed-agent"], {stdio: "inherit"});
  built = true;
  const test = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-name-pattern", "managed worker runs", "test/work-cli.test.ts"], {
    stdio: "inherit", env: {...process.env, GROUNDS_DATA_HOME: root, GROUNDS_TEST_MANAGED_AGENT: image},
  });
  process.exitCode = test.status ?? 1;
} finally {
  if (built) execFileSync("docker", ["image", "rm", image], {stdio: "inherit"});
  rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}
