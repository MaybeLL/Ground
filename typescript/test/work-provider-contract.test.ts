import assert from "node:assert/strict";
import { test } from "node:test";
import { codexProvider, claudeCodeProvider } from "../src/work/adapters/providers/command-line.js";

test("Codex JSONL maps stable call identities, output and actual termination", () => {
  const events = [
    {type:"thread.started",thread_id:"session"},
    {type:"item.started",item:{id:"call",type:"command_execution",command:"cat fixture.txt"}},
    {type:"item.completed",item:{id:"call",type:"command_execution",aggregated_output:"42",exit_code:0,status:"completed"}},
    {type:"item.completed",item:{id:"m",type:"agent_message",text:"42"}},
    {type:"turn.completed",usage:{input_tokens:8}},
  ].flatMap(row => codexProvider.events(JSON.parse(JSON.stringify(row))));
  assert.deepEqual(events,[
    {kind:"session",sessionId:"session"},{kind:"tool-call",callId:"call",tool:"shell",input:"cat fixture.txt"},
    {kind:"tool-result",callId:"call",output:"42",failed:false},{kind:"message",role:"assistant",text:"42"},{kind:"provider-ended",outcome:"succeeded"},
  ]);
  assert.deepEqual(codexProvider.events({type:"turn.failed",error:{message:"unavailable"}}),[{kind:"error",message:"unavailable"},{kind:"provider-ended",outcome:"failed"}]);
  assert.deepEqual(codexProvider.events({type:"future-event"}),[]);
});

test("Claude Code stream-json preserves multi-block order and distinguishes tool failures from run termination", () => {
  assert.deepEqual(claudeCodeProvider.events({type:"assistant",message:{content:[
    {type:"text",text:"reading"},{type:"tool_use",id:"read-1",name:"Read",input:{file_path:"fixture.txt"}},
  ]}}),[{kind:"message",role:"assistant",text:"reading"},{kind:"tool-call",callId:"read-1",tool:"Read",input:{file_path:"fixture.txt"}}]);
  assert.deepEqual(claudeCodeProvider.events({type:"user",message:{content:[{type:"tool_result",tool_use_id:"read-1",content:"missing",is_error:true}]}}),
    [{kind:"tool-result",callId:"read-1",output:"missing",failed:true}]);
  assert.deepEqual(claudeCodeProvider.events({type:"system",subtype:"init",session_id:"s"}),[{kind:"session",sessionId:"s"}]);
  assert.deepEqual(claudeCodeProvider.events({type:"result",subtype:"success",is_error:false}),[{kind:"provider-ended",outcome:"succeeded"}]);
  assert.deepEqual(claudeCodeProvider.events({type:"result",subtype:"error_during_execution",result:"broken",is_error:true}),[{kind:"error",message:"broken"},{kind:"provider-ended",outcome:"failed"}]);
  assert.deepEqual(claudeCodeProvider.events({type:"system",subtype:"hook_response"}),[]);
});

test("trace capture retains malformed and deeply nested raw blocks and preserves the source part index", async () => {
  const {ProviderTraceCapture} = await import("../src/work/adapters/providers/trace-capture.js");
  const {mkdtemp,writeFile,rm} = await import("node:fs/promises");
  const {join} = await import("node:path");
  const {tmpdir} = await import("node:os");
  const dir=await mkdtemp(join(tmpdir(),"grounds-provider-conversion-"));
  try {
    const path=join(dir,"stream.jsonl");
    const deep='{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Read","input":'+"[".repeat(12000)+"0"+"]".repeat(12000)+"}]}}";
    const mixed=JSON.stringify({type:"assistant",message:{content:[{type:"thinking"},{type:"text",text:"ok"}]}});
    const raw=Buffer.concat([Buffer.from(deep+"\n"+mixed+"\n"),Buffer.from([255,10]),Buffer.alloc(8*1024*1024+1,65)]);
    await writeFile(path,raw);
    const capture=await new ProviderTraceCapture().capture("claude-code",path);
    const read=async (s: typeof capture.raw) => {const chunks=[];for await (const chunk of s.open()) chunks.push(chunk);return Buffer.concat(chunks);};
    try {
      assert.deepEqual(await read(capture.raw),raw);
      assert.equal(JSON.parse((await read(capture.events)).toString()).part,1);
      assert.deepEqual(capture.descriptor.omissions,{invalidUtf8:1,invalidJson:0,oversized:1,unknownRecords:0,unknownParts:1,unserializableParts:1});
    } finally {await capture.dispose();}
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("evaluator grades require a verified final provider answer",async()=>{
  const {mkdtemp,rm,writeFile}=await import("node:fs/promises");
  const {join}=await import("node:path"),{tmpdir}=await import("node:os");
  const {ProviderTraceCapture}=await import("../src/work/adapters/providers/trace-capture.js");
  const dir=await mkdtemp(join(tmpdir(),"grounds-final-evaluator-"));
  const final=async(provider:"claude-code"|"codex",rows:string[])=>{
    const path=join(dir,"transcript");
    await writeFile(path,rows.join("\n")+"\n");
    const trace=await new ProviderTraceCapture().capture(provider,path);
    try {return trace.finalMessage;} finally {await trace.dispose();}
  };
  try {
    const intermediate=JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"5"}]}});
    assert.equal(await final("claude-code",[intermediate,JSON.stringify({type:"result",subtype:"success",result:"0"})]),"0");
    assert.equal(await final("claude-code",[intermediate,JSON.stringify({type:"result",subtype:"error",result:"0"})]),undefined);
    const sample=JSON.stringify({type:"item.completed",item:{id:"answer",type:"agent_message",text:"5"}});
    const end=JSON.stringify({type:"turn.completed"});
    assert.equal(await final("codex",[sample,end]),"5");
    assert.equal(await final("codex",[sample,"{invalid",end]),undefined);
    assert.equal(await final("codex",[sample,"x".repeat(8*1024*1024+1),end]),undefined);
    assert.equal(await final("codex",[sample]),undefined);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("evaluator recovery independently captures bridge files created before interruption",async()=>{
  const {mkdir,rm,writeFile}=await import("node:fs/promises");
  const {join}=await import("node:path");
  const {randomUUID}=await import("node:crypto");
  const {dataLayout}=await import("../src/data-layout.js");
  const {ContainerAgentProcess}=await import("../src/work/adapters/devcontainer/managed-process.js");
  const {DevcontainerRuntime}=await import("../src/work/adapters/devcontainer/runtime.js");
  const {ManagedWorkspaces}=await import("../src/work/adapters/devcontainer/workspace.js");
  const {GitTagArchive}=await import("../src/work/adapters/git/tag-archive.js");
  const owner={ledgerId:randomUUID(),sandboxId:randomUUID()},executionId=randomUUID();
  const executionDir=join(dataLayout().runtime,"executions",owner.ledgerId,executionId);
  const plan={role:"evaluator" as const,agent:{provider:"codex" as const},job:{executionId},prompt:"judge",
    target:{owner,containerId:"unused",location:{daemonId:"unused",hostId:"unused"}}};
  const process=new ContainerAgentProcess(new DevcontainerRuntime(),new ManagedWorkspaces(),new GitTagArchive());
  await mkdir(executionDir,{recursive:true});
  try {
    assert.equal(await process.availableOutput(plan),undefined);
    const path=join(executionDir,"stdout.jsonl");
    await writeFile(path,'{"type":"thread.started","thread_id":"partial"}\n');
    const stdout=await process.availableOutput(plan);
    assert.ok(stdout?.trace);
    try {assert.equal(stdout.stderr,undefined);assert.equal(stdout.trace.descriptor.records,1);}
    finally {await stdout.trace.dispose();}
    await rm(path);
    await writeFile(join(executionDir,"stderr"),"a diagnostic");
    const stderr=await process.availableOutput(plan);
    assert.equal(stderr?.stderr?.byteLength,12);assert.equal(stderr?.trace,undefined);
  } finally {await rm(join(dataLayout().runtime,"executions",owner.ledgerId),{recursive:true,force:true});}
});
