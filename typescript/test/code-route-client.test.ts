import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newUUIDv7 } from "../src/identity.js";

test("client reopens a receipt replaced after open without replacing its saved request", t => {
  const root = mkdtempSync(join(tmpdir(), "grounds-client-replace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "inbox")); mkdirSync(join(root, "outbox"));
  const execution = newUUIDv7(), request = { execution_id: execution, request_id: newUUIDv7() };
  const receipt = { ...request, state: "completed", result: { message: "完整回执" } };
  const input = join(root, "inbox", "request.json"), response = join(root, "outbox", "response.json");
  writeFileSync(input, JSON.stringify(request));
  const bytes = readFileSync(input, "utf8");
  writeFileSync(response, JSON.stringify({ ...receipt, request_id: newUUIDv7() }));
  writeFileSync(`${response}.next`, JSON.stringify(receipt));
  const client = fileURLToPath(new URL("../assets/code-route-client.py", import.meta.url));
  const result = spawnSync("python3", ["-c", `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("client", sys.argv[1])
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
response = sys.argv[2]
original = os.open
opens = 0
def replace_after_open(path, *args, **kwargs):
    global opens
    fd = original(path, *args, **kwargs)
    if path == response:
        opens += 1
        if opens == 1:
            os.replace(response + ".next", response)
            assert os.fstat(fd).st_nlink == 0
    return fd
os.open = replace_after_open
sys.argv = ["grounds-git", "--timeout", "1", "retry"]
status = client.main()
assert opens == 2, opens
sys.exit(status)
`, client, response], {
    env: { ...process.env, GROUNDS_CODE_CHANNEL: root, GROUNDS_CODE_EXECUTION_ID: execution }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), receipt);
  assert.equal(readFileSync(input, "utf8"), bytes);
});

test("receipt retries remain bounded and reject unsafe or corrupt files", t => {
  const root = mkdtempSync(join(tmpdir(), "grounds-client-safety-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = fileURLToPath(new URL("../assets/code-route-client.py", import.meta.url));
  const result = spawnSync("python3", ["-c", `
import importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("client", sys.argv[1])
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
root = Path(sys.argv[2])
path = root / "receipt.json"
def rejected():
    try:
        client.read_json(str(path), 64)
    except (ValueError, OSError) as error:
        assert not isinstance(error, client.ProtocolChanged), error
    else:
        raise AssertionError("unsafe receipt accepted")
path.write_text('{}')
os.link(path, root / "hardlink")
rejected()
path.unlink()
path.symlink_to(root / "hardlink")
rejected()
path.unlink()
path.mkdir()
rejected()
path.rmdir()
path.write_text('x' * 65)
rejected()
path.write_text('{invalid')
rejected()
path.write_text('{}')
original = os.open
opens = 0
def replace_every_open(name, *args, **kwargs):
    global opens
    fd = original(name, *args, **kwargs)
    if name == str(path):
        opens += 1
        replacement = root / "next"
        replacement.write_text('{}')
        os.replace(replacement, path)
    return fd
os.open = replace_every_open
try:
    client.read_json(str(path))
except client.ProtocolChanged:
    assert opens == 5, opens
else:
    raise AssertionError("continuous replacement must remain unresolved")
finally:
    os.open = original
assert client.read_json(str(path)) == {}
`, client, root], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});

test("the container command preserves timed-out input and retry consumes only its matching receipt", t => {
  const root = mkdtempSync(join(tmpdir(), "grounds-client-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "inbox")); mkdirSync(join(root, "outbox"));
  const execution = newUUIDv7(), client = fileURLToPath(new URL("../assets/code-route-client.py", import.meta.url));
  const invoke = (...args: string[]) => spawnSync("python3", [client, "--timeout", "0.1", ...args], {
    env: { ...process.env, GROUNDS_CODE_CHANNEL: root, GROUNDS_CODE_EXECUTION_ID: execution }, encoding: "utf8", timeout: 5000,
  });
  const first = invoke("stage", "中文 space;$(literal).txt");
  assert.equal(first.status, 3, first.stderr);
  const bytes = readFileSync(join(root, "inbox", "request.json"), "utf8"), request = JSON.parse(bytes);
  assert.deepEqual(request.paths, ["中文 space;$(literal).txt"]);
  assert.equal(request.execution_id, execution);
  assert.equal(JSON.parse(first.stderr).request_id, request.request_id);
  writeFileSync(join(root, "outbox", "response.json"), JSON.stringify({ request_id: newUUIDv7(), execution_id: execution, state: "completed" }));
  assert.equal(invoke("retry").status, 3, "an unrelated response cannot acknowledge this request");
  assert.equal(invoke("unstage", "service.txt").status, 2, "a fresh command cannot overwrite an unresolved request");
  assert.equal(readFileSync(join(root, "inbox", "request.json"), "utf8"), bytes);
  const receipt = { request_id: request.request_id, execution_id: execution, state: "completed", result: { head: "fixed-head" } };
  writeFileSync(join(root, "outbox", "response.json"), JSON.stringify(receipt));
  const retry = invoke("retry");
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(JSON.parse(retry.stdout), receipt);
  assert.equal(readFileSync(join(root, "inbox", "request.json"), "utf8"), bytes);
});

test("client validation matches the host's Unicode limits before publishing a request", t => {
  const root = mkdtempSync(join(tmpdir(), "grounds-client-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "inbox")); mkdirSync(join(root, "outbox"));
  const client = fileURLToPath(new URL("../assets/code-route-client.py", import.meta.url));
  for (const args of [["stage", "../escape"], ["stage", "😀".repeat(513)],
    ["commit", "-m", "message", "--author-name", "😀".repeat(129), "--author-email", "agent@example.invalid"]]) {
    const result = spawnSync("python3", [client, "--timeout", "0.1", ...args], {
      env: { ...process.env, GROUNDS_CODE_CHANNEL: root, GROUNDS_CODE_EXECUTION_ID: newUUIDv7() }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(existsSync(join(root, "inbox", "request.json")), false);
  }
});

test("concurrent clients cannot replace a waiting request and interruption preserves it", { timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "grounds-client-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "inbox")); mkdirSync(join(root, "outbox"));
  const client = fileURLToPath(new URL("../assets/code-route-client.py", import.meta.url));
  const env = { ...process.env, GROUNDS_CODE_CHANNEL: root, GROUNDS_CODE_EXECUTION_ID: newUUIDv7() };
  const first = spawn("python3", [client, "--timeout", "30", "stage", "service.txt"], { env, stdio: "ignore" });
  const closed = once(first, "close");
  t.after(() => first.kill("SIGKILL"));
  const input = join(root, "inbox", "request.json");
  for (let i = 0; i < 100 && !existsSync(input); i++) await setTimeout(20);
  const bytes = readFileSync(input, "utf8"), request = JSON.parse(bytes);
  const second = spawnSync("python3", [client, "unstage", "service.txt"], { env, encoding: "utf8", timeout: 3000 });
  assert.equal(second.status, 2, second.stderr);
  assert.match(second.stderr, /Another grounds-git command/);
  assert.equal(readFileSync(input, "utf8"), bytes);
  first.kill("SIGINT");
  assert.equal((await closed)[0], 130);
  assert.equal(readFileSync(input, "utf8"), bytes);
  const rejected = { request_id: request.request_id, execution_id: request.execution_id, state: "rejected",
    error: { code: "VALIDATION_ERROR", message: "Unsupported Git attributes" } };
  writeFileSync(join(root, "outbox", "response.json"), JSON.stringify(rejected));
  const retry = spawnSync("python3", [client, "retry"], { env, encoding: "utf8", timeout: 3000 });
  assert.equal(retry.status, 2);
  assert.deepEqual(JSON.parse(retry.stdout), rejected);
});
