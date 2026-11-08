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
  const env = {...process.env, GROUNDS_DATA_HOME: root, GROUNDS_TEST_MANAGED_AGENT: image};
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[key];
  const test = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-name-pattern", "managed worker runs|managed evaluator runs|test grading runs|experiment runs", "test/work-cli.test.ts"], {
    stdio: "inherit", env,
  });
  process.exitCode = test.status ?? 1;
} finally {
  try {
    rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  } catch (error) {
    if (!built || error.code !== "EACCES" && error.code !== "EPERM") throw error;
    // A root container can create Git object directories owned by root on a
    // Linux bind mount. Limit cleanup to this fixture's private directory.
    execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only",
      "--mount", "type=bind,source=" + root + ",target=/fixture", "--entrypoint", "sh", image,
      "-ec", "find /fixture -xdev -type d -exec chmod u+rwx '{}' '+' && find /fixture -xdev -depth -mindepth 1 -delete"], {stdio:"inherit"});
    rmSync(root, {recursive:true,force:true});
  } finally {
    if (built) execFileSync("docker", ["image", "rm", image], {stdio: "inherit"});
  }
}
