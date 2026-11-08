#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const task = JSON.parse(readFileSync(0,"utf8"));
if (!task.criteria?.length) process.exit(2);
const { existsSync } = require("node:fs");
if (task.task.startsWith("concurrent fixture ")) {
  // The test releases these processes only after seeing all three alive.
  writeFileSync("/tmp/grounds-fixture-ready", task.task);
  const deadline = Date.now() + 90000;
  while (!existsSync("/tmp/grounds-fixture-release")) {
    if (Date.now() > deadline) process.exit(3);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
writeFileSync("result.txt",task.task + "\n");
const git = (...args) => execFileSync("git",args,{encoding:"utf8"}).trim();
git("add","result.txt"); git("commit","-qm","Deliver fixture");
const message=JSON.stringify({candidate:{commit:git("rev-parse","HEAD")}});
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
