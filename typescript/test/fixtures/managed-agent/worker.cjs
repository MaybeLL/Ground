#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const task = JSON.parse(readFileSync(0,"utf8"));
if (task.role==="independent-verifier") {
  const fs=require("node:fs"),assert=require("node:assert/strict");
  const dir="/grounds-delivery",material="/grounds-grader/author";
  const dirs=fs.readdirSync(dir);
  if (task.task.kind==="coding") {
    assert.deepEqual(dirs,["candidate-1"]);
    assert.equal(fs.existsSync(dir+"/candidate-1/.git"),false);
    assert.equal(readFileSync(dir+"/candidate-1/report","utf8"),"pinned code");
  } else {
    assert.equal(readFileSync("/grounds-materials/input/app.txt","utf8"),"v0\n");
    assert.equal(dirs.length,2);
    assert.deepEqual(task.task.delivery.map(d=>d.slot).sort(),["a","b"]);
    for (const {path,slot} of task.task.delivery) assert.equal(readFileSync(path+"/report","utf8"),"public result "+slot);
  }
  const findings=task.task.criteria.map(c=>({criterionId:c.id,independent:"satisfied",rationale:"inspected frozen files",evidence:["report"]}));
  let result;
  if (task.phase==="blind") {
    writeFileSync(".blind-invoked","once",{flag:"wx"});
    assert.equal(fs.existsSync(material),false);
    assert.equal(JSON.stringify(task).includes("private-author-marker"),false);
    result={findings};
  } else {
    writeFileSync(".reconcile-invoked","once",{flag:"wx"});
    assert.deepEqual(task.findings,findings);
    const author=JSON.parse(readFileSync(material+"/index.json","utf8"));
    assert.deepEqual(author.manifest.items.map(i=>i.path).sort(),dirs);
    const [reference]=author.materials;
    assert.equal(readFileSync(material+"/"+reference.file,"utf8"),"private-author-marker");
    const items=findings.map(f=>({...f,independent:task.task.summary==="alter findings" ? "unsatisfied" : f.independent,
      reconciliation:"corroborated",final:"satisfied"}));
    result={grade:{form:"criteria",items}};
  }
  const message=JSON.stringify(result);
  if (process.argv[1].endsWith("claude")) {
    assert.ok(process.argv.includes("--safe-mode") && process.argv.includes("--strict-mcp-config"));
    for (const e of [{type:"system",subtype:"init",session_id:task.phase},{type:"result",subtype:"success",is_error:false,result:message}]) console.log(JSON.stringify(e));
    return;
  }
  for (const e of [{type:"thread.started",thread_id:task.phase},{type:"item.completed",item:{id:"msg",type:"agent_message",text:message}},{type:"turn.completed"}]) console.log(JSON.stringify(e));
  return;
}
if (task.role==="evaluator") {
  if(task.rubric==="wait to cancel") {
    process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"partial-cancelled-evaluation"})+"\n");
    writeFileSync("/tmp/grounds-judge-ready","ready",{flag:"wx"});
    const deadline=Date.now()+90000;
    while(!require("node:fs").existsSync("/tmp/grounds-judge-release")) {
      if(Date.now()>deadline) process.exit(3);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
    }
  }
  const report=task.rubric==="exact report";
  if (!report && !require("node:fs").existsSync("/grounds-delivery/.claude/settings.json")) process.exit(7);
  if (process.argv[1].endsWith("claude") && (!process.argv.includes("--safe-mode") || !process.argv.includes("--strict-mcp-config"))) process.exit(8);
  if (require("node:fs").existsSync("answer.txt") || require("node:fs").existsSync("report.txt") || require("node:fs").existsSync(".claude/settings.json")) process.exit(9);
  try {writeFileSync("/grounds-delivery/should-be-readonly","invalid");process.exit(10);} catch(error){if(error.code!=="EROFS") throw error;}
  const answer=readFileSync(report ? "/grounds-delivery/report.txt" : "/grounds-delivery/answer.txt","utf8"),expected=readFileSync(report ? "/grounds-grader/report.txt" : "/grounds-grader/reference.txt","utf8");
  const grade=task.rubric==="invalid grade" ? {form:"numeric",value:999} : {form:"numeric",value:answer===expected ? 5 : 0};
  const message=JSON.stringify({grade});
  const emit=event=>process.stdout.write(JSON.stringify(event)+"\n");
  if(process.argv[1].endsWith("claude")) {
    emit({type:"system",subtype:"init",session_id:"independent-evaluator"});
    emit({type:"assistant",message:{content:[{type:"text",text:JSON.stringify({grade:{form:"numeric",value:3}})}]}});
    emit({type:"result",subtype:"success",is_error:false,result:message});
  } else {
    emit({type:"thread.started",thread_id:"independent-evaluator"});
    emit({type:"item.completed",item:{id:"evaluation",type:"agent_message",text:message}});
    emit({type:"turn.completed"});
  }
  return;
}
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
  if (task.task==="artifact experiment") {
    writeFileSync("appendix.txt","independent appendix bytes");
    result.artifacts[0].files.push({path:"appendix.txt"});
  }
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
