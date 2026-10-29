import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { docker } from "../src/env-docker.js";

// Characterization of the external engine boundary, not a production deletion implementation.
test("a read-only archive helper pins deletion but does not freeze other writers or close the final deletion gap", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 60_000,
}, t => {
  const id = randomUUID(), volume = `grounds-fence-test-${id}`;
  const label = `grounds.volume-fence-test=${id}`, image = process.env.GROUNDS_CODE_POSTGRES_IMAGE!;
  t.after(() => {
    const remaining = docker(["ps", "-aq", "--no-trunc", "--filter", `label=${label}`]).split("\n").filter(Boolean);
    for (const container of remaining) docker(["rm", "-f", "-v", container]);
    if (docker(["volume", "ls", "-q", "--filter", `label=${label}`]).split("\n").includes(volume)) docker(["volume", "rm", volume]);
  });
  docker(["volume", "create", "--driver", "local", "--label", label, volume]);
  const write = (value: string) => {
    const writer = docker(["create", "--pull", "never", "--network", "none", "--read-only", "--label", label,
      "--mount", `type=volume,src=${volume},dst=/var/lib/postgresql/data,volume-nocopy`, "--entrypoint", "sh", image,
      "-c", 'printf "%s" "$1" > /var/lib/postgresql/data/value; cat /var/lib/postgresql/data/value', "fixture", value]);
    assert.equal(docker(["start", "-a", writer]), value);
    assert.equal(JSON.parse(docker(["inspect", writer]))[0].State.ExitCode, 0);
    docker(["rm", "-v", writer]);
  };
  write("before-capture");
  const helper = docker(["create", "--pull", "never", "--network", "none", "--read-only", "--label", label,
    "--mount", `type=volume,src=${volume},dst=/var/lib/postgresql/data,readonly,volume-nocopy`, "--entrypoint", "true", image]);
  const inspect = JSON.parse(docker(["inspect", helper]))[0];
  assert.equal(inspect.State.Status, "created");
  assert.equal(inspect.Mounts.length, 1);
  assert.equal(inspect.Mounts[0].Name, volume);
  assert.equal(inspect.Mounts[0].RW, false);
  const consumers = () => docker(["ps", "-aq", "--no-trunc", "--filter", `volume=${volume}`]).split("\n").filter(Boolean);
  const capture = () => {
    const result = spawnSync("docker", ["cp", "-a", `${helper}:/var/lib/postgresql/data/.`, "-"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.equal(result.error, undefined);
    return result.stdout;
  };
  assert.deepEqual(consumers(), [helper]);
  const first = capture();
  assert.ok(first.includes(Buffer.from("before-capture")));
  // A whole write-and-disappear cycle can happen between two consumer observations.
  write("changed-under-readonly-helper");
  assert.deepEqual(consumers(), [helper]);
  const second = capture();
  assert.ok(second.includes(Buffer.from("changed-under-readonly-helper")));
  assert.equal(first.includes(Buffer.from("changed-under-readonly-helper")), false);
  const pinned = spawnSync("docker", ["volume", "rm", volume], { encoding: "utf8", timeout: 10_000 });
  assert.notEqual(pinned.status, 0);
  assert.match(pinned.stderr, /in use/i);
  assert.equal(docker(["volume", "ls", "-q", "--filter", `label=${label}`]), volume);
  docker(["rm", "-v", helper]);
  assert.deepEqual(consumers(), []);
  // Even a successful non-force rm cannot prove that nothing was written after the last capture.
  // All contents here are synthetic and this volume was created exclusively by this test.
  write("written-after-final-capture");
  assert.deepEqual(consumers(), []);
  assert.equal(second.includes(Buffer.from("written-after-final-capture")), false);
  assert.equal(docker(["volume", "rm", volume]), volume);
  assert.equal(docker(["volume", "ls", "-q", "--filter", `label=${label}`]), "");
});
