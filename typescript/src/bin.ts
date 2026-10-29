#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("./main.js", import.meta.url));
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main, ...process.argv.slice(2)], {
  stdio: "inherit",
});
// Keep the public launcher alive until the controller has drained an accepted
// request. Signals sent to this PID must reach the actual CLI process too.
const interrupt = () => { child.kill("SIGINT"); };
const terminate = () => { child.kill("SIGTERM"); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.once("error", error => {
  process.stderr.write(`grounds: unable to start CLI: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
});
