#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const task = JSON.parse(readFileSync(0,"utf8"));
if (!task.criteria?.length) process.exit(2);
const { existsSync } = require("node:fs");
if (task.task === "interrupt fixture") {
  writeFileSync("/tmp/grounds-fixture-ready", task.task, {flag: "wx"});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 90_000);
  process.exit(5);
}
if (task.task.startsWith("concurrent fixture ")) {
  const expected = {
    "concurrent fixture 0": ["synthetic-first", undefined],
    "concurrent fixture 1": [undefined, "synthetic-second"],
    "concurrent fixture 2": [undefined, undefined],
  }[task.task];
  if (!expected || process.env.OPENAI_API_KEY !== expected[0] ||
      process.env.ANTHROPIC_API_KEY !== expected[1]) process.exit(4);
  // The test releases these processes only after seeing all three alive.
  writeFileSync("/tmp/grounds-fixture-ready", task.task, {flag: "wx"});
  if (task.task === "concurrent fixture 0") {
    const child = require("node:child_process").spawn("sleep", ["180"], {detached: true, stdio: "ignore"});
    child.unref();
  }
  const deadline = Date.now() + 90000;
  while (!existsSync("/tmp/grounds-fixture-release")) {
    if (Date.now() > deadline) process.exit(3);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
if (task.task === "controlled batch fixture") {
  writeFileSync("/tmp/worker-ready", "ready", {flag:"wx"});
  const deadline = Date.now() + 120000;
  while (!existsSync("/tmp/worker-release")) {
    if (Date.now() > deadline) process.exit(5);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
const handoff = task.task === "handoff fixture";
const content = task.task === "comparison fixture" ? (process.argv[1].endsWith("claude") ? "claude result" : "codex result") : handoff && existsSync("scratch-note") ? readFileSync("scratch-note", "utf8") : task.task;
writeFileSync("result.txt", content + "\n");
if (handoff) writeFileSync("scratch-note", "inherited uncommitted note");
const git = (...args) => execFileSync("git",args,{encoding:"utf8"}).trim();
if (handoff && task.refinement && git("rev-parse", "HEAD") !== task.refinement.baseCommit) process.exit(6);
const working=task.outputContract.type==="working";
const result={};
if (working) {
  if (existsSync(".git")) process.exit(7);
  try {writeFileSync("/grounds-materials/input/app.txt","corrupt");process.exit(8);} catch(error) {if (error.code!=="EROFS") throw error;}
} else {
  git("add","result.txt"); git("commit","-qm","Deliver fixture");
  result.candidate={commit:git("rev-parse","HEAD")};
}
if (task.outputContract.slots?.some(slot=>slot.key==="report")) {
  if (task.task==="invalid output path") require("node:fs").symlinkSync("/etc/passwd","worker-report.txt");
  else writeFileSync("worker-report.txt",working ? readFileSync("/grounds-materials/input/app.txt") : "uncommitted report\n");
  result.artifacts=[{slot:"report",files:[{path:"report.txt",source:"worker-report.txt"}]}];
}
const message=JSON.stringify(result);
const emit = event => process.stdout.write(JSON.stringify(event)+"\n");
if (process.argv[1].endsWith("claude")) {
  emit({type:"system",subtype:"init",session_id:"fixture-session"});
  emit({type:"assistant",message:{content:[{type:"text",text:message}]}});
  emit({type:"result",subtype:"success",is_error:false});
} else {
  emit({type:"thread.started",thread_id:"fixture-thread"});
  emit({type:"item.completed",item:{id:"message-1",type:"agent_message",text:message}});
  emit({type:"turn.completed"});
}

if (["read pinned input","concurrent fixture 1"].includes(task.task)) process.exitCode=12;
