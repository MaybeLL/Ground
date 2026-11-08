// Run in a disposable collector process. The production Engine adapter has
// verified Docker's exit and synchronized the streams when the hook fires.
import assert from "node:assert/strict";
import {EngineProcess} from "../../src/work/adapters/devcontainer/engine-process.js";
import {collectProvider} from "../../src/work/adapters/devcontainer/provider-runner.js";

const start=EngineProcess.prototype.start;
EngineProcess.prototype.start=async function(...args) {
  const result=await start.apply(this,args);
  assert.equal(result.running,false);
  assert.equal(result.exitCode,Number(process.argv[3] ?? 17));
  process.kill(process.pid,"SIGKILL");
  return result;
};
await collectProvider(process.argv[2]!);
