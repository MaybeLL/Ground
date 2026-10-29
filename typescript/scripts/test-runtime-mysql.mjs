import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
const exec = promisify(execFile),
  name = "grounds-mysql-test-" + randomUUID(),
  password = randomBytes(24).toString("hex");
const temporary = mkdtempSync("/private/tmp/grounds-mysql-ca-");
const env = {
  ...process.env,
  MYSQL_ROOT_PASSWORD: password,
  MYSQL_DATABASE: "grounds_test",
};
const prefix = process.env.GROUNDS_TEST_DOCKER_SOCKET
  ? ["--host", "unix://" + process.env.GROUNDS_TEST_DOCKER_SOCKET]
  : [];
const docker = (args) =>
  exec("docker", [...prefix, ...args], {
    env,
    timeout: 30000,
    maxBuffer: 128 * 1024,
  });
try {
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--label",
    "grounds.test=true",
    "--publish",
    "127.0.0.1::3306",
    "--env",
    "MYSQL_ROOT_PASSWORD",
    "--env",
    "MYSQL_DATABASE",
    "--tmpfs",
    "/var/lib/mysql",
    "mysql:8.0",
  ]);
  const port = Number(
    (await docker(["port", name, "3306/tcp"])).stdout.trim().split(":").at(-1),
  );
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      const c = await mysql.createConnection({
        host: "127.0.0.1",
        port,
        user: "root",
        password,
        database: "grounds_test",
        connectTimeout: 1000,
      });
      await c.end();
      ready = true;
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw Error("isolated MySQL did not become ready");
  const ca = join(temporary, "ca.pem");
  writeFileSync(
    ca,
    (await docker(["exec", name, "cat", "/var/lib/mysql/ca.pem"])).stdout,
    { mode: 0o600 },
  );
  const code = await new Promise((yes, no) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "test/runtime-store.test.ts",
        "test/mysql-conformance.test.ts",
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          GROUNDS_TEST_MYSQL_HOST: "127.0.0.1",
          GROUNDS_TEST_MYSQL_PORT: String(port),
          GROUNDS_TEST_MYSQL_USERNAME: "root",
          GROUNDS_TEST_MYSQL_PASSWORD: password,
          GROUNDS_TEST_MYSQL_DATABASE: "grounds_test",
          GROUNDS_TEST_MYSQL_CA_FILE: ca,
        },
      },
    );
    child.once("error", no);
    child.once("exit", yes);
  });
  process.exitCode = code ?? 1;
} finally {
  await docker(["rm", "--force", name]).catch(() => {});
  rmSync(temporary, { recursive: true, force: true });
}
